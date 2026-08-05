const { BrowserWindow, session, app } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const BOSS_LOGIN_URL = "https://www.zhipin.com/web/user/";
const BOSS_CHAT_URL = "https://www.zhipin.com/web/chat/index";
const PARTITION = "persist:boss-zhipin";

let bossWindow = null;
let downloadsConfigured = false;
let pendingResumeLabel = null;
/** @type {null | ((info: { ok: boolean, path?: string, error?: string, filename?: string }) => void)} */
let downloadWaiter = null;

function desktopResumeDir() {
  // Keep resumes out of the Desktop root — always a dedicated folder.
  let desktop = "";
  try {
    desktop = app.getPath("desktop");
  } catch {
    desktop = path.join(process.env.USERPROFILE || process.env.HOME || ".", "Desktop");
  }
  const dir = path.join(desktop, "聚元灵创-简历");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // ignore
  }
  return dir;
}

function setPendingResumeDownloadLabel(name) {
  pendingResumeLabel = String(name || "").trim() || null;
}

function waitForResumeDownload(timeoutMs = 20000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (info) => {
      if (settled) return;
      settled = true;
      if (downloadWaiter === finish) downloadWaiter = null;
      clearTimeout(timer);
      resolve(info);
    };
    const timer = setTimeout(() => {
      finish({ ok: false, error: "download_timeout" });
    }, timeoutMs);
    downloadWaiter = finish;
  });
}

function cancelResumeDownloadWait(error = "download_cancelled") {
  const waiter = downloadWaiter;
  downloadWaiter = null;
  pendingResumeLabel = null;
  if (waiter) waiter({ ok: false, error });
}

function configureBossDownloads() {
  if (downloadsConfigured) return;
  downloadsConfigured = true;
  const ses = session.fromPartition(PARTITION);
  ses.on("will-download", (_event, item) => {
    try {
      const logPath = path.join(app.getPath("desktop"), "聚元灵创-简历", "_download-log.txt");
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(
        logPath,
        `${new Date().toISOString()} will-download url=${item.getURL()} name=${item.getFilename()} mime=${item.getMimeType()}\n`,
        "utf8",
      );
    } catch {
      // ignore
    }
    const destDir = desktopResumeDir();
    try {
      fs.mkdirSync(destDir, { recursive: true });
    } catch {
      // ignore
    }
    const rawName = item.getFilename() || "resume.pdf";
    const ext = path.extname(rawName) || ".pdf";
    const safeLabel = String(pendingResumeLabel || "候选人")
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, "")
      .slice(0, 40);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const filename = `${safeLabel}-简历-${stamp}${ext}`;
    const savePath = path.join(destDir, filename);
    item.setSavePath(savePath);
    item.once("done", (_e, state) => {
      const waiter = downloadWaiter;
      // Do not clear the waiter on non-resume false positives (JSON/HTML) — a later
      // real PDF download must still be able to resolve waitForResumeDownload.
      if (state === "completed") {
        // Only keep real resume binaries (PDF / Office). Reject HTML/JSON false positives.
        try {
          const fd = fs.openSync(savePath, "r");
          const buf = Buffer.alloc(16);
          fs.readSync(fd, buf, 0, 16, 0);
          fs.closeSync(fd);
          const head = buf.toString("utf8");
          const looksHtml = /^\s*</.test(head) || /<!doctype html/i.test(head);
          const looksJson = /^\s*[{[]/.test(head);
          const looksPdf = head.startsWith("%PDF");
          const looksZip = buf[0] === 0x50 && buf[1] === 0x4b; // docx/doc container
          if (looksHtml || looksJson || (!looksPdf && !looksZip)) {
            try {
              fs.unlinkSync(savePath);
            } catch {
              // ignore
            }
            try {
              fs.appendFileSync(
                path.join(destDir, "_download-log.txt"),
                `${new Date().toISOString()} rejected_non_resume name=${filename}\n`,
                "utf8",
              );
            } catch {
              // ignore
            }
            // Keep waiter armed for a subsequent real attachment download.
            return;
          }
          // Normalize extension to match sniffed type.
          downloadWaiter = null;
          pendingResumeLabel = null;
          if (looksPdf && !/\.pdf$/i.test(filename)) {
            const fixed = savePath.replace(/\.[^.]+$/, ".pdf");
            try {
              fs.renameSync(savePath, fixed);
              if (waiter) waiter({ ok: true, path: fixed, filename: path.basename(fixed) });
              return;
            } catch {
              // keep original path
            }
          }
          if (waiter) waiter({ ok: true, path: savePath, filename });
        } catch {
          // If we cannot sniff, reject rather than keep garbage — but keep waiter.
          try {
            fs.unlinkSync(savePath);
          } catch {
            // ignore
          }
        }
      } else {
        downloadWaiter = null;
        pendingResumeLabel = null;
        if (waiter) waiter({ ok: false, error: `download_${state}`, path: savePath, filename });
      }
    });
  });
}

/**
 * Use partition cookies to fetch a resume binary from known Boss APIs / URLs.
 */
async function fetchResumeBinaryToDesktop(urls, label) {
  configureBossDownloads();
  const ses = session.fromPartition(PARTITION);
  const destDir = desktopResumeDir();
  fs.mkdirSync(destDir, { recursive: true });
  const safeLabel = String(label || pendingResumeLabel || "候选人")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "")
    .slice(0, 40);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const tried = [];
  const queue = [...(urls || [])];
  for (let i = 0; i < queue.length; i++) {
    const href = String(queue[i] || "").trim();
    if (!href || !/^https?:/i.test(href)) continue;
    for (const method of ["GET", "POST"]) {
      try {
        const res = await ses.fetch(href, {
          method,
          headers: {
            Accept: "*/*",
            Referer: "https://www.zhipin.com/web/chat/index",
            ...(method === "POST"
              ? { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" }
              : {}),
          },
          ...(method === "POST" ? { body: "" } : {}),
        });
        const ct = String(res.headers.get("content-type") || "");
        const buf = Buffer.from(await res.arrayBuffer());
        const head = buf.slice(0, 8).toString("utf8");
        tried.push({
          href: href.slice(0, 180),
          method,
          status: res.status,
          ct,
          bytes: buf.length,
          head: head.slice(0, 12),
          jsonSnippet:
            /json/i.test(ct) || /^\s*[{[]/.test(head) ? buf.toString("utf8").slice(0, 400) : undefined,
        });
        if (head.startsWith("%PDF") || (buf[0] === 0x50 && buf[1] === 0x4b)) {
          const ext = head.startsWith("%PDF") ? ".pdf" : ".docx";
          const filename = `${safeLabel}-简历-${stamp}${ext}`;
          const savePath = path.join(destDir, filename);
          fs.writeFileSync(savePath, buf);
          if (downloadWaiter) {
            const w = downloadWaiter;
            downloadWaiter = null;
            pendingResumeLabel = null;
            w({ ok: true, path: savePath, filename });
          }
          return { ok: true, path: savePath, filename, url: href, bytes: buf.length, method };
        }
        if (/json/i.test(ct) || /^\s*[{[]/.test(head)) {
          const text = buf.toString("utf8");
          let data = null;
          try {
            data = JSON.parse(text);
          } catch {
            data = null;
          }
          const nested = [];
          const walk = (o, d) => {
            if (!o || d > 5) return;
            if (typeof o === "string" && /^https?:/i.test(o)) nested.push(o);
            else if (Array.isArray(o)) o.slice(0, 30).forEach((x) => walk(x, d + 1));
            else if (typeof o === "object") {
              for (const [k, v] of Object.entries(o).slice(0, 40)) {
                if (/url|link|src|file|download|pdf|oss/i.test(k) || typeof v === "object") walk(v, d + 1);
                else if (typeof v === "string" && /^https?:/i.test(v)) nested.push(v);
              }
            }
          };
          walk(data, 0);
          for (const n of nested) {
            if (queue.includes(n) || tried.some((t) => t.href === n.slice(0, 180))) continue;
            queue.push(n);
          }
        }
      } catch (err) {
        tried.push({
          href: href.slice(0, 180),
          method,
          error: String(err?.message || err).slice(0, 120),
        });
      }
    }
  }
  return { ok: false, error: "fetch_resume_binary_miss", tried: tried.slice(0, 30) };
}

function buildResumeCandidateUrls(zp) {
  const geekId = zp?.encryptGeekId || zp?.geekId || "";
  const resumeId = zp?.encryptResumeId || "";
  const authId = zp?.encryptAuthorityId || "";
  const urls = [];
  const add = (u) => {
    if (u && !urls.includes(u)) urls.push(u);
  };
  if (resumeId) {
    add(`https://www.zhipin.com/wapi/zpgeek/resume/boss/preview/download.json?encryptResumeId=${encodeURIComponent(resumeId)}`);
    add(`https://www.zhipin.com/wapi/zpgeek/resume/boss/download.json?encryptResumeId=${encodeURIComponent(resumeId)}`);
    add(`https://www.zhipin.com/wapi/zpgeek/resume/download.json?encryptResumeId=${encodeURIComponent(resumeId)}`);
    add(`https://www.zhipin.com/wapi/zpgeek/resume/boss/preview/pdf.json?encryptResumeId=${encodeURIComponent(resumeId)}`);
    add(`https://www.zhipin.com/wflow/zpgeek/resume/download?encryptResumeId=${encodeURIComponent(resumeId)}`);
    add(`https://www.zhipin.com/wapi/zpgeek/resume/preview/download?encryptResumeId=${encodeURIComponent(resumeId)}`);
    add(`https://www.zhipin.com/wapi/zpgeek/resume/boss/preview/getSecureUrl.json?encryptResumeId=${encodeURIComponent(resumeId)}`);
    add(`https://www.zhipin.com/wapi/zpgeek/resume/boss/preview/secureUrl.json?encryptResumeId=${encodeURIComponent(resumeId)}`);
  }
  if (authId) {
    add(`https://www.zhipin.com/wapi/zpgeek/resume/attachment/download.json?encryptAuthorityId=${encodeURIComponent(authId)}`);
    add(`https://www.zhipin.com/wapi/zpgeek/resume/boss/preview/attachment/download.json?encryptAuthorityId=${encodeURIComponent(authId)}`);
    add(`https://www.zhipin.com/wapi/zpgeek/resume/boss/preview/getAttachment.json?encryptAuthorityId=${encodeURIComponent(authId)}`);
    add(`https://www.zhipin.com/wapi/zpgeek/resume/boss/preview/attachment.json?encryptAuthorityId=${encodeURIComponent(authId)}`);
    add(`https://www.zhipin.com/wapi/zpgeek/resume/boss/downloadAttachment.json?encryptAuthorityId=${encodeURIComponent(authId)}&authType=0`);
    add(`https://www.zhipin.com/wapi/zpgeek/resume/boss/preview/url.json?encryptAuthorityId=${encodeURIComponent(authId)}`);
    add(`https://www.zhipin.com/wapi/zpchat/exchange/downloadResume.json?encryptAuthorityId=${encodeURIComponent(authId)}`);
    add(`https://www.zhipin.com/wapi/zpchat/exchange/downloadResume.json?encryptId=${encodeURIComponent(authId)}`);
    add(`https://www.zhipin.com/wapi/zpchat/exchange/getResumeAttachment.json?encryptAuthorityId=${encodeURIComponent(authId)}`);
    add(`https://www.zhipin.com/wapi/zpchat/exchange/previewAttachment.json?encryptAuthorityId=${encodeURIComponent(authId)}`);
    add(`https://www.zhipin.com/wapi/zpchat/exchange/resumeAttachment.json?encryptAuthorityId=${encodeURIComponent(authId)}&authType=0`);
  }
  if (resumeId && authId) {
    add(
      `https://www.zhipin.com/wapi/zpgeek/resume/boss/preview/pdf.json?encryptResumeId=${encodeURIComponent(resumeId)}&encryptAuthorityId=${encodeURIComponent(authId)}`,
    );
    add(
      `https://www.zhipin.com/wapi/zpgeek/resume/boss/preview/content.json?encryptResumeId=${encodeURIComponent(resumeId)}&encryptAuthorityId=${encodeURIComponent(authId)}`,
    );
  }
  if (geekId && resumeId) {
    add(
      `https://www.zhipin.com/wapi/zpgeek/resume/boss/preview/download.json?encryptGeekId=${encodeURIComponent(geekId)}&encryptResumeId=${encodeURIComponent(resumeId)}`,
    );
  }
  if (geekId && authId) {
    // Boss's attachment preview resolves to this host-specific binary endpoint.
    // Keep it alongside the check ticket so a direct session fetch can persist the real file.
    add(
      `https://docdownload.zhipin.com/wflow/zpgeek/download/download4boss/${encodeURIComponent(geekId)}?id=${encodeURIComponent(authId)}&authType=0`,
    );
    add(
      `https://www.zhipin.com/wapi/zpgeek/resume/boss/preview/check.json?geekId=${encodeURIComponent(geekId)}&id=${encodeURIComponent(authId)}&authType=0`,
    );
  }
  return urls;
}

/**
 * Trigger a session download into Desktop via will-download rename rules.
 * Prefers this over in-page blob hacks so cookies/partition stay correct.
 */
function downloadUrlToDesktop(url, label) {
  const href = String(url || "").trim();
  if (!href) return Promise.resolve({ ok: false, error: "empty_url" });
  configureBossDownloads();
  if (label) setPendingResumeDownloadLabel(label);
  const wait = waitForResumeDownload(25000);
  try {
    session.fromPartition(PARTITION).downloadURL(href);
  } catch (err) {
    cancelResumeDownloadWait(`download_url_failed:${err?.message || err}`);
  }
  return wait;
}

function classifyPage(href, text) {
  const blob = `${href || ""}\n${text || ""}`;
  const blocked =
    /访问受限|暂时无法访问|暂时被禁止访问|请勿频繁提交刷新|将于\s*\d{4}-\d{2}-\d{2}/i.test(blob) ||
    /\/passport\/zp\/403\.html/i.test(href || "");
  const captcha =
    !blocked &&
    (/安全验证|点击按钮进行验证|异常访问|请选中下图|请选择所有|geetest|请完成验证/i.test(blob) ||
      /\/passport\/zp\/verify\.html/i.test(href || ""));
  const loginForm =
    !blocked &&
    !captcha &&
    ((/手机号/.test(blob) && /短信验证码|发送验证码/.test(blob)) ||
      (/\/web\/user\//i.test(href || "") && /登录\/注册|发送验证码/.test(blob)));
  const loggedIn =
    !blocked &&
    !captcha &&
    !/短信验证码|发送验证码|APP扫码登录|安全验证/.test(blob) &&
    (/\/web\/chat\//i.test(href || "") ||
      /\/web\/geek\//i.test(href || "") ||
      /消息|职位管理|牛人|沟通|推荐牛人|搜索牛人|简历|工作台/.test(blob));
  return { blocked, captcha, loginForm, loggedIn };
}

function ensureBossWindow({ show = true } = {}) {
  configureBossDownloads();
  if (bossWindow && !bossWindow.isDestroyed()) {
    if (show) {
      bossWindow.show();
      bossWindow.focus();
    }
    return bossWindow;
  }

  bossWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 800,
    minHeight: 560,
    title: "Boss 直聘（本机）",
    autoHideMenuBar: true,
    show,
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Attachment preview sometimes opens a guest window; wire capture there too.
  bossWindow.webContents.setWindowOpenHandler(({ url }) => {
    const href = String(url || "");
    if (/\.pdf($|\?)/i.test(href)) {
      downloadUrlToDesktop(href, pendingResumeLabel);
      return { action: "deny" };
    }
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        webPreferences: {
          partition: PARTITION,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      },
    };
  });
  bossWindow.webContents.on("did-create-window", (child) => {
    try {
      child.webContents.on("will-navigate", (e, navUrl) => {
        const u = String(navUrl || "");
        if (/\.pdf($|\?)/i.test(u)) {
          e.preventDefault();
          downloadUrlToDesktop(u, pendingResumeLabel);
        }
      });
      child.webContents.on("did-finish-load", async () => {
        try {
          const href = child.webContents.getURL();
          if (/\.pdf($|\?)/i.test(href)) {
            downloadUrlToDesktop(href, pendingResumeLabel);
            return;
          }
          if (/preview|resume|attach|pdf/i.test(href || "")) {
            // Guest preview shell: try session download of any pdf-like resource, else print.
            const urls = await child.webContents.executeJavaScript(
              `(() => performance.getEntriesByType("resource").map(e=>e.name).filter(u=>/\\.pdf($|\\?)|oss|zpcdn|resume|attach/i.test(u)).slice(-20))()`,
              true,
            );
            for (const u of urls || []) {
              if (/^https?:/i.test(u)) {
                try {
                  session.fromPartition(PARTITION).downloadURL(u);
                } catch {
                  // ignore
                }
              }
            }
          }
        } catch {
          // ignore
        }
      });
    } catch {
      // ignore
    }
  });

  bossWindow.on("closed", () => {
    bossWindow = null;
  });

  return bossWindow;
}

async function readPageState(win) {
  const href = win.webContents.getURL();
  let text = "";
  try {
    text = await win.webContents.executeJavaScript(
      `(() => (document.body && (document.body.innerText || document.body.textContent) || "").slice(0, 4000))()`,
      true,
    );
  } catch {
    text = "";
  }
  const kind = classifyPage(href, String(text || ""));
  return { href, text: String(text || "").slice(0, 500), ...kind };
}

async function capturePreview(win) {
  try {
    const image = await win.webContents.capturePage();
    const png = image.resize({ width: 720 }).toPNG();
    return `data:image/png;base64,${png.toString("base64")}`;
  } catch {
    return null;
  }
}

function toPayload(state, extra = {}) {
  const stage = state.loggedIn
    ? "logged_in"
    : state.blocked
      ? "blocked"
      : state.captcha
        ? "captcha"
        : state.loginForm
          ? "awaiting_self_login"
          : "unknown";
  let message = extra.message;
  if (!message) {
    if (state.loggedIn) message = "Boss 登录态：有效（本机内嵌浏览器）。";
    else if (state.blocked) message = "Boss 访问受限（本机出口 IP 被风控）。请换网络后重试，勿频繁刷新。";
    else if (state.captcha) message = "仍在安全验证页。请在 Boss 窗口内自行完成验证，再点「检验登录态」。";
    else if (state.loginForm) message = "请在弹出的 Boss 窗口内自行登录，完成后点「检验登录态」。";
    else message = "尚未确认登录成功。请在 Boss 窗口完成登录后再检验。";
  }
  return {
    mode: "desktop_embedded",
    loggedIn: Boolean(state.loggedIn),
    blocked: Boolean(state.blocked),
    captcha: Boolean(state.captcha),
    stage,
    url: state.href,
    pageTextPreview: state.text,
    imageDataUrl: extra.imageDataUrl || null,
    message,
    instruction: message,
  };
}

async function openBossLogin({ restart = false } = {}) {
  const win = ensureBossWindow({ show: true });
  if (restart || !win.webContents.getURL() || win.webContents.getURL() === "about:blank") {
    await win.loadURL(BOSS_LOGIN_URL);
  } else {
    // Soft refresh login entry when already open.
    const cur = win.webContents.getURL();
    if (!/zhipin\.com/i.test(cur)) {
      await win.loadURL(BOSS_LOGIN_URL);
    }
  }
  await new Promise((r) => setTimeout(r, 1200));
  const state = await readPageState(win);
  if (state.loggedIn) {
    return toPayload(state, {
      message: "检测到本机 Boss 已登录，可直接开始招聘对话。",
      imageDataUrl: await capturePreview(win),
    });
  }
  return toPayload(state, {
    message: "已打开本机 Boss 登录窗口。请在该窗口自行登录，完成后点「检验登录态」。",
    imageDataUrl: await capturePreview(win),
  });
}

async function checkBossLogin({ navigateChat = true } = {}) {
  const win = ensureBossWindow({ show: true });
  let state = await readPageState(win);

  if (!state.loggedIn && navigateChat) {
    try {
      await win.loadURL(BOSS_CHAT_URL);
      await new Promise((r) => setTimeout(r, 2000));
      state = await readPageState(win);
    } catch {
      // keep previous state
    }
  }

  if (!state.loggedIn && !/zhipin\.com/i.test(state.href || "")) {
    await win.loadURL(BOSS_LOGIN_URL);
    await new Promise((r) => setTimeout(r, 1200));
    state = await readPageState(win);
  }

  return toPayload(state, { imageDataUrl: await capturePreview(win) });
}

async function refreshBossPreview() {
  const win = ensureBossWindow({ show: true });
  const state = await readPageState(win);
  return toPayload(state, { imageDataUrl: await capturePreview(win) });
}

function showBossWindow() {
  ensureBossWindow({ show: true });
  return { ok: true };
}

function clearBossSession() {
  return session.fromPartition(PARTITION).clearStorageData();
}

module.exports = {
  openBossLogin,
  checkBossLogin,
  refreshBossPreview,
  showBossWindow,
  clearBossSession,
  ensureBossWindow,
  readPageState,
  configureBossDownloads,
  setPendingResumeDownloadLabel,
  waitForResumeDownload,
  cancelResumeDownloadWait,
  downloadUrlToDesktop,
  fetchResumeBinaryToDesktop,
  buildResumeCandidateUrls,
  desktopResumeDir,
  PARTITION,
  BOSS_LOGIN_URL,
  BOSS_CHAT_URL,
};
