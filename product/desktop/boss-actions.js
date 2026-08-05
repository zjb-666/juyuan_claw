/**
 * Local Boss Zhipin automation (type B).
 * Runs only inside the user's Electron partition — employer PC IP + cookies.
 * Server never executes these DOM actions against Boss.
 */

const bossBrowser = require("./boss-browser");
const { BrowserWindow, clipboard } = require("electron");

const BOSS_CHAT_URL = bossBrowser.BOSS_CHAT_URL || "https://www.zhipin.com/web/chat/index";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Harvest resume file URLs while an action runs (preview click / download).
 * Boss attachment preview often navigates the BrowserWindow away without will-download.
 */
async function harvestResumeUrlsDuring(win, actionFn, timeoutMs = 12000) {
  const { session } = require("electron");
  const ses = session.fromPartition(bossBrowser.PARTITION);
  const urls = [];
  let active = true;
  const push = (url) => {
    if (!active) return;
    const u = String(url || "");
    if (!u || urls.includes(u)) return;
    // Never treat the chat SPA itself as a resume file.
    if (/\/web\/chat(\/|$|\?)/i.test(u) && !/\.pdf($|\?)/i.test(u)) return;
    if (/\.(html?|js|css|png|jpe?g|gif|webp|svg|woff2?)($|\?)/i.test(u)) return;
    if (
      /\.pdf($|\?)/i.test(u) ||
      /\/resume\/|attachment|preview.*file|download.*resume|geek.*resume/i.test(u)
    ) {
      urls.push(u);
    }
  };

  const onCompleted = (details) => {
    const headers = details.responseHeaders || {};
    let ct = "";
    for (const [k, v] of Object.entries(headers)) {
      if (String(k).toLowerCase() === "content-type") {
        ct = Array.isArray(v) ? v.join(";") : String(v || "");
        break;
      }
    }
    if (/pdf|octet-stream|msword|officedocument/i.test(ct) || /\.pdf($|\?)/i.test(details.url)) {
      push(details.url);
    }
    // Keep a short breadcrumb of wapi traffic for resume debugging.
    if (/\/wapi\//i.test(details.url) && /resume|preview|attach|file|download|geek|encrypt/i.test(details.url)) {
      push(details.url);
    }
  };
  const onHeaders = (details) => {
    const headers = details.responseHeaders || {};
    let ct = "";
    let cd = "";
    for (const [k, v] of Object.entries(headers)) {
      const key = String(k).toLowerCase();
      const val = Array.isArray(v) ? v.join(";") : String(v || "");
      if (key === "content-type") ct = val;
      if (key === "content-disposition") cd = val;
    }
    if (
      /pdf|octet-stream|msword|officedocument/i.test(ct) ||
      /filename=.*\.pdf/i.test(cd) ||
      /\.pdf($|\?)/i.test(details.url)
    ) {
      push(details.url);
    }
  };
  const onNav = (_e, url) => push(url);
  const onFrameNav = (_e, url) => push(url);

  try {
    ses.webRequest.onCompleted({ urls: ["*://*/*"] }, onCompleted);
    ses.webRequest.onHeadersReceived({ urls: ["*://*/*"] }, (details, callback) => {
      onHeaders(details);
      const headers = { ...(details.responseHeaders || {}) };
      let ct = "";
      for (const [k, v] of Object.entries(headers)) {
        if (String(k).toLowerCase() === "content-type") {
          ct = Array.isArray(v) ? v.join(";") : String(v || "");
          break;
        }
      }
      // Force attachment so Electron emits will-download instead of inline PDF viewer.
      if (
        !/text\/html/i.test(ct) &&
        (/application\/pdf/i.test(ct) ||
          (/octet-stream/i.test(ct) && /\.pdf($|\?)/i.test(details.url || "")) ||
          /\.pdf($|\?)/i.test(details.url || ""))
      ) {
        headers["Content-Disposition"] = ['attachment; filename="resume.pdf"'];
        push(details.url);
        callback({ cancel: false, responseHeaders: headers });
        return;
      }
      callback({ cancel: false, responseHeaders: details.responseHeaders });
    });
  } catch {
    // ignore listener install failures
  }

  win.webContents.on("will-navigate", onNav);
  win.webContents.on("did-navigate", onNav);
  win.webContents.on("did-navigate-in-page", onNav);
  win.webContents.on("did-frame-navigate", onFrameNav);

  try {
    await actionFn();
    const started = Date.now();
    while (Date.now() - started < timeoutMs && urls.length === 0) {
      await sleep(250);
      try {
        push(win.webContents.getURL());
      } catch {
        // ignore
      }
    }
  } finally {
    active = false;
    try {
      win.webContents.removeListener("will-navigate", onNav);
      win.webContents.removeListener("did-navigate", onNav);
      win.webContents.removeListener("did-navigate-in-page", onNav);
      win.webContents.removeListener("did-frame-navigate", onFrameNav);
    } catch {
      // ignore
    }
    // Keep webRequest filters installed but gated by `active=false`.
    // Do not clear with null — that can wipe other session handlers.
  }

  return urls;
}

/**
 * Attach CDP debugger briefly to capture pdf/octet-stream while preview opens.
 * Prefer writing the response body to Desktop when will-download never fires.
 */
async function captureAndSavePdfViaDebugger(win, label, clickFn, timeoutMs = 14000) {
  const wc = win.webContents;
  const fs = require("node:fs");
  const path = require("node:path");
  let attachedHere = false;
  const hits = [];
  const saveBuf = (buf, url) => {
    if (!buf || buf.length < 200) return null;
    const head = buf.slice(0, 8).toString("utf8");
    const looksPdf = head.startsWith("%PDF");
    const looksZip = buf[0] === 0x50 && buf[1] === 0x4b;
    const looksHtml = /^\s*</.test(head) || /<!doctype html/i.test(head);
    if (looksHtml || (!looksPdf && !looksZip)) return null;
    const destDir = bossBrowser.desktopResumeDir();
    fs.mkdirSync(destDir, { recursive: true });
    const safeLabel = String(label || "候选人")
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, "")
      .slice(0, 40);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const ext = looksZip ? ".docx" : ".pdf";
    const filename = `${safeLabel}-简历-${stamp}${ext}`;
    const savePath = path.join(destDir, filename);
    fs.writeFileSync(savePath, buf);
    return { ok: true, path: savePath, filename, url: url || null, bytes: buf.length };
  };
  const onMessage = (_event, method, params) => {
    if (method !== "Network.responseReceived") return;
    const resp = params?.response || {};
    const mime = String(resp.mimeType || "");
    const url = String(resp.url || "");
    if (/pdf|octet-stream|msword|officedocument/i.test(mime) || /\.pdf($|\?)/i.test(url)) {
      hits.push({ url, mime, requestId: params.requestId, kind: "file" });
      return;
    }
    // Boss attachment preview often returns a JSON ticket/URL first.
    if (
      /json/i.test(mime) &&
      (/wapi\//i.test(url) || /resume|preview|attach|download|file|geek|zpencrypt|oss/i.test(url)) &&
      !/\/web\/chat\//i.test(url)
    ) {
      hits.push({ url, mime, requestId: params.requestId, kind: "json" });
    }
  };
  // Only intercept direct PDF binary navigations — never block Boss HTML preview shells
  // (their URLs often contain "resume"/"preview" and must be allowed to load).
  const onWillNav = (e, url) => {
    const u = String(url || "");
    if (/\.pdf($|\?)/i.test(u)) {
      e.preventDefault();
      hits.push({ url: u, mime: "nav", requestId: null, kind: "file" });
      try {
        require("electron").session.fromPartition(bossBrowser.PARTITION).downloadURL(u);
      } catch {
        // ignore
      }
    }
  };
  try {
    if (!wc.debugger.isAttached()) {
      wc.debugger.attach("1.3");
      attachedHere = true;
    }
    wc.debugger.on("message", onMessage);
    await wc.debugger.sendCommand("Network.enable");
    wc.on("will-navigate", onWillNav);
    await clickFn();
    const started = Date.now();
    while (Date.now() - started < timeoutMs && hits.length === 0) {
      await sleep(250);
    }
    // Prefer binary file responses; else mine JSON preview APIs for a file URL.
    const fileHit = hits.find((h) => h.kind === "file" && h.requestId);
    if (fileHit) {
      try {
        await sleep(600);
        const body = await wc.debugger.sendCommand("Network.getResponseBody", {
          requestId: fileHit.requestId,
        });
        const buf = body.base64Encoded
          ? Buffer.from(body.body || "", "base64")
          : Buffer.from(body.body || "", "utf8");
        const saved = saveBuf(buf, fileHit.url);
        if (saved) return saved;
      } catch {
        // fall through
      }
      return { ok: false, url: fileHit.url, error: "pdf_body_unavailable" };
    }

    const extractUrls = (text) => {
      const found = [];
      const s = String(text || "");
      const re = /https?:\/\/[^"\s]+/g;
      let m;
      while ((m = re.exec(s))) {
        const u = m[0].replace(/[),;]+$/, "");
        if (
          /\.pdf($|\?)/i.test(u) ||
          /\/(oss|bosscdn|zpcdn|resumecdn)\//i.test(u) ||
          /resume|attachment|encryptUrl|fileUrl|previewUrl|downloadUrl/i.test(u)
        ) {
          if (!found.includes(u)) found.push(u);
        }
      }
      // Also common JSON fields without full scheme in rare cases.
      const fieldRe =
        /"(?:url|fileUrl|previewUrl|downloadUrl|encryptUrl|resumeUrl|link|src)"\s*:\s*"([^"]+)"/gi;
      while ((m = fieldRe.exec(s))) {
        const u = String(m[1] || "").trim();
        if (/^https?:/i.test(u) && !found.includes(u)) found.push(u);
      }
      return found;
    };

    for (const j of hits
      .filter((h) => h.kind === "json" && h.requestId)
      .sort((a, b) => {
        const score = (u) => (/preview\/check/i.test(u) ? 0 : /resume/i.test(u) ? 1 : 2);
        return score(a.url) - score(b.url);
      })) {
      try {
        await sleep(200);
        const body = await wc.debugger.sendCommand("Network.getResponseBody", {
          requestId: j.requestId,
        });
        const text = body.base64Encoded
          ? Buffer.from(body.body || "", "base64").toString("utf8")
          : String(body.body || "");
        let zp = null;
        try {
          const parsed = JSON.parse(text);
          zp = parsed?.zpData || parsed?.data || null;
        } catch {
          zp = null;
        }
        if (zp && (zp.encryptResumeId || zp.encryptAuthorityId || zp.encryptGeekId)) {
          const candidateUrls = bossBrowser.buildResumeCandidateUrls(zp);
          const fetched = await bossBrowser.fetchResumeBinaryToDesktop(candidateUrls, label);
          if (fetched?.ok && fetched.path) return fetched;
          hits.push({
            url: j.url,
            mime: "check-payload",
            requestId: null,
            kind: "json",
            zp,
            tried: fetched?.tried || candidateUrls.slice(0, 8),
          });
        }
        const urls = extractUrls(text);
        for (const href of urls) {
          hits.push({ url: href, mime: "extracted", requestId: null, kind: "file" });
          try {
            require("electron").session.fromPartition(bossBrowser.PARTITION).downloadURL(href);
          } catch {
            // ignore
          }
          try {
            const b64 = await win.webContents.executeJavaScript(
              `(async () => {
                const r = await fetch(${JSON.stringify(href)}, { credentials: "include" });
                const ct = r.headers.get("content-type") || "";
                const ab = await r.arrayBuffer();
                const u8 = new Uint8Array(ab);
                let bin = "";
                const chunk = 0x8000;
                for (let i = 0; i < u8.length; i += chunk) {
                  bin += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
                }
                return { ct, b64: btoa(bin), bytes: u8.length };
              })()`,
              true,
            );
            if (b64?.b64) {
              const buf = Buffer.from(b64.b64, "base64");
              const saved = saveBuf(buf, href);
              if (saved) return saved;
            }
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore
      }
    }

    const hit = hits.find((h) => /^https?:/i.test(h.url));
    const zpHit = hits.find((h) => h.zp)?.zp || null;
    let discovered = [];
    try {
      discovered = await discoverResumeApisFromScripts(win);
      if (discovered.length && zpHit) {
        const extra = [];
        for (const row of discovered) {
          for (const path of row.urls || []) {
            if (!path.startsWith("/wapi/")) continue;
            let u = `https://www.zhipin.com${path}`;
            u = u
              .replace(/\$\{[^}]+\}/g, "")
              .replace(/encryptResumeId=/gi, `encryptResumeId=${encodeURIComponent(zpHit.encryptResumeId || "")}`)
              .replace(/encryptGeekId=/gi, `encryptGeekId=${encodeURIComponent(zpHit.encryptGeekId || "")}`)
              .replace(/encryptAuthorityId=/gi, `encryptAuthorityId=${encodeURIComponent(zpHit.encryptAuthorityId || "")}`);
            // Skip template leftovers
            if (/[\{\}]/.test(u)) continue;
            extra.push(u);
          }
        }
        if (extra.length) {
          const fetched = await bossBrowser.fetchResumeBinaryToDesktop(
            [...new Set(extra)].slice(0, 25),
            label,
          );
          if (fetched?.ok && fetched.path) return fetched;
          hits.push({ url: "discovered-apis", mime: "probe", kind: "json", tried: fetched?.tried || extra.slice(0, 12) });
        }
      }
    } catch {
      discovered = [];
    }
    if (!hit) return { ok: false, error: "pdf_network_not_seen", probed: hits.slice(0, 12), zp: zpHit, discovered };
    // Debug aid: dump probed APIs next to Desktop resumes when binary save failed.
    try {
      const fs = require("node:fs");
      const path = require("node:path");
      const destDir = bossBrowser.desktopResumeDir();
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      fs.writeFileSync(
        path.join(destDir, `resume-net-debug-${stamp}.json`),
        JSON.stringify({ label, hits: hits.slice(0, 30), discovered }, null, 2),
        "utf8",
      );
    } catch {
      // ignore
    }
    return {
      ok: false,
      url: hit.url,
      error: "pdf_body_unavailable",
      probed: hits.slice(0, 12),
      zp: zpHit,
      discovered,
    };
  } catch (err) {
    return { ok: false, error: `debugger_${err?.message || err}` };
  } finally {
    try {
      wc.removeListener("will-navigate", onWillNav);
    } catch {
      // ignore
    }
    try {
      wc.debugger.removeListener("message", onMessage);
    } catch {
      // ignore
    }
    if (attachedHere) {
      try {
        wc.debugger.detach();
      } catch {
        // ignore
      }
    }
  }
}

async function discoverResumeApisFromScripts(win) {
  const ses = require("electron").session.fromPartition(bossBrowser.PARTITION);
  let scripts = [];
  try {
    scripts = await win.webContents.executeJavaScript(
      `([...document.querySelectorAll("script[src]")].map((s) => s.src).filter(Boolean).slice(0, 40))`,
      true,
    );
  } catch {
    scripts = [];
  }
  const found = [];
  for (const src of scripts || []) {
    if (!/zhipin|zpcdn|static/i.test(src)) continue;
    try {
      const res = await ses.fetch(src);
      const text = await res.text();
      if (!/preview\/check|encryptResumeId|附件简历|downloadResume/i.test(text)) continue;
      const urls = new Set();
      const re = /["'`](\/wapi\/[^"'`]+(?:resume|preview|attach|download|file)[^"'`]*)["'`]/gi;
      let m;
      while ((m = re.exec(text))) {
        urls.add(m[1]);
        if (urls.size >= 40) break;
      }
      found.push({ src: String(src).slice(0, 180), urls: [...urls].slice(0, 40) });
      if (found.length >= 6) break;
    } catch {
      // ignore
    }
  }
  return found;
}

async function saveVisibleResumeViaPrintToPdf(win, label) {
  const fs = require("node:fs");
  const path = require("node:path");
  try {
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      landscape: false,
      pageSize: "A4",
      marginsType: 1,
    });
    if (!pdf || pdf.length < 800) return { ok: false, error: "print_pdf_too_small" };
    // Electron printToPDF always starts with %PDF
    const head = pdf.slice(0, 4).toString("utf8");
    if (head !== "%PDF") return { ok: false, error: "print_pdf_bad_magic" };
    const destDir = bossBrowser.desktopResumeDir();
    fs.mkdirSync(destDir, { recursive: true });
    const safeLabel = String(label || "候选人")
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, "")
      .slice(0, 40);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const filename = `${safeLabel}-简历-${stamp}.pdf`;
    const savePath = path.join(destDir, filename);
    fs.writeFileSync(savePath, pdf);
    return { ok: true, path: savePath, filename, bytes: pdf.length, via: "printToPDF" };
  } catch (err) {
    return { ok: false, error: `print_pdf_${err?.message || err}` };
  }
}

async function tryOpenOnlineResumeShell(win, zp) {
  const resumeId = zp?.encryptResumeId || "";
  const geekId = zp?.encryptGeekId || zp?.geekId || "";
  const authId = zp?.encryptAuthorityId || "";
  const candidates = [
    resumeId
      ? `https://www.zhipin.com/web/frame/c/preview?encryptResumeId=${encodeURIComponent(resumeId)}`
      : null,
    resumeId
      ? `https://www.zhipin.com/web/frame/recommend/resume?encryptResumeId=${encodeURIComponent(resumeId)}`
      : null,
    geekId && resumeId
      ? `https://www.zhipin.com/web/frame/recommend/resume?encryptGeekId=${encodeURIComponent(geekId)}&encryptResumeId=${encodeURIComponent(resumeId)}`
      : null,
    authId
      ? `https://www.zhipin.com/web/frame/c/attachment?encryptAuthorityId=${encodeURIComponent(authId)}`
      : null,
  ].filter(Boolean);
  for (const url of candidates) {
    try {
      await win.loadURL(url);
      await sleep(2800);
      const href = win.webContents.getURL();
      if (/passport|login|verify|403/i.test(href)) continue;
      return { ok: true, url: href };
    } catch {
      // try next
    }
  }
  return { ok: false };
}

function findBossWindow() {
  return BrowserWindow.getAllWindows().find((x) => {
    try {
      const url = x.webContents.getURL();
      return /zhipin\.com/i.test(url || "");
    } catch {
      return false;
    }
  });
}

async function getBossWindow() {
  let win = findBossWindow();
  if (!win) {
    win = bossBrowser.ensureBossWindow({ show: true });
    await win.loadURL(BOSS_CHAT_URL);
    await sleep(1800);
  }
  return win;
}

async function readPageVia(win) {
  const href = win.webContents.getURL();
  let text = "";
  try {
    text = await win.webContents.executeJavaScript(
      `(() => (document.body && (document.body.innerText || document.body.textContent) || "").slice(0, 6000))()`,
      true,
    );
  } catch {
    text = "";
  }
  const blob = `${href}\n${text}`;
  const blocked =
    /访问受限|暂时无法访问|暂时被禁止访问|请勿频繁提交刷新/i.test(blob) ||
    /\/passport\/zp\/403\.html/i.test(href || "");
  const loggedIn =
    !blocked &&
    (/\/web\/chat\//i.test(href || "") || /消息|沟通|牛人|简历|工作台/.test(String(text || "")));
  return { href, text: String(text || "").slice(0, 800), blocked, loggedIn };
}

async function ensureChatPage(win) {
  const href = win.webContents.getURL();
  if (!/zhipin\.com\/web\/chat/i.test(href || "")) {
    await win.loadURL(BOSS_CHAT_URL);
    await sleep(1800);
  }
  return readPageVia(win);
}

/**
 * Conservative DOM helpers — click visible controls by text; stay on zhipin.com.
 */
const DOM_HELPER = `
(() => {
  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = window.getComputedStyle(el);
    return r.width > 2 && r.height > 2 && s.visibility !== "hidden" && s.display !== "none";
  }
  function clickByText(patterns, root) {
    const scope = root || document;
    const nodes = Array.from(scope.querySelectorAll("button, a, span, div, li"));
    for (const re of patterns) {
      for (const el of nodes) {
        const t = (el.innerText || el.textContent || "").trim();
        if (t && re.test(t) && visible(el) && t.length < 40) {
          el.click();
          return { ok: true, matched: t.slice(0, 40) };
        }
      }
    }
    return { ok: false };
  }
  function isDateHeader(s) {
    return /^\\d{1,2}月\\d{1,2}日$/.test(s) || /^(今天|昨天|前天|星期[一二三四五六日天]|周一|周二|周三|周四|周五|周六|周日)$/.test(s);
  }
  function isUiLabel(s) {
    return /^(消息|沟通|搜索|筛选|推荐|职位|牛人|新招呼|全部|未读|已读|在线|工作台|简历|管理|收藏|工具|常见问题|我的|设置|退出|加载更多|暂无)$/.test(s);
  }
  function looksLikePersonName(s) {
    if (!s || s.length < 2 || s.length > 12) return false;
    if (isDateHeader(s) || isUiLabel(s)) return false;
    if (/^\\d+$/.test(s) || /\\d{1,2}:\\d{2}/.test(s)) return false;
    if (/刚刚|分钟前|小时前|天前|周前|月前/.test(s)) return false;
    // Person names are mostly CJK / short latin, not long role strings.
    if (/工程师|开发|设计|创作|产品|运营|销售|剪辑|算法|前端|后端|专员|经理|总监/.test(s)) return false;
    return /[\\u4e00-\\u9fa5A-Za-z]/.test(s);
  }
  function looksLikeJobTitle(s) {
    if (!s || s.length < 2 || s.length > 48) return false;
    if (isDateHeader(s) || isUiLabel(s)) return false;
    if (/^(管理|全部|未读|新招呼)$/.test(s)) return false;
    return /工程师|开发|设计|创作|产品|运营|销售|剪辑|算法|前端|后端|测试|运维|数据|AI|智能体|全栈|Java|Python|专员|经理|顾问|老师|主播|剪辑师|设计师|BD|商务/.test(s);
  }
  function findChatListRoot() {
    const cands = Array.from(
      document.querySelectorAll(
        "[class*='friend-list'], [class*='chat-list'], [class*='user-list'], [class*='geek-list'], [class*='conversation-list'], [class*='scroll-list']",
      ),
    ).filter(visible);
    if (cands.length) {
      cands.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
      return cands[0];
    }
    return document.body;
  }
  function cleanScrapedTitle(s) {
    return String(s || "")
      .replace(/[（(][^）)]*(地铁|包\\s*\\d*餐|包餐|福利|双休|五险|加班|餐补)[^）)]*[）)]/g, "")
      .replace(/[（(]近地铁[^）)]*[）)]/g, "")
      .replace(/\\s+/g, " ")
      .trim()
      .slice(0, 40);
  }
  function isPastDayLabel(label) {
    if (!label) return false;
    if (/^(昨天|前天)$/.test(label)) return true;
    if (/^星期/.test(label) || /^周[一二三四五六日天]$/.test(label)) return true;
    return /^\\d{1,2}月\\d{1,2}日$/.test(label);
  }
  function isTodayDayLabel(label) {
    return label === "今天" || label === "今日";
  }
  function guessRowDayLabel(lines, sectionDay) {
    for (const line of lines || []) {
      const s = String(line || "").trim();
      if (!s || s.length > 16) continue;
      if (/^(刚刚|刚才)$/.test(s) || /分钟前|小时前/.test(s)) return "今天";
      if (/^今天$|^今日$/.test(s)) return "今天";
      if (/^昨天$|^前天$/.test(s)) return s;
      if (/^星期[一二三四五六日天]$|^周[一二三四五六日天]$/.test(s)) return s;
      if (/^\\d{1,2}月\\d{1,2}日$/.test(s)) return s;
      if (/^\\d{1,2}:\\d{2}$/.test(s)) return "今天";
    }
    return sectionDay || "今天";
  }
  function collectOrderedChatRows(limit, todayOnly) {
    const root = findChatListRoot();
    const preferSel =
      "[class*='geek-item'], [class*='friend-item'], [class*='chat-item'], [class*='conversation-item'], [class*='user-item'], [class*='geek-info']";
    let rawNodes = Array.from(root.querySelectorAll(preferSel));
    if (rawNodes.length < 3) {
      rawNodes = Array.from(root.querySelectorAll("li, [role='listitem'], div")).filter((el) => {
        if (!visible(el)) return false;
        const r = el.getBoundingClientRect();
        return r.left < 520 && r.width > 140 && r.width < 520 && r.height > 48 && r.height < 140;
      });
    }
    // Keep outermost rows only — nested name/title divs must not become fake people.
    const nodes = rawNodes.filter((el) => {
      if (!visible(el)) return false;
      const r = el.getBoundingClientRect();
      if (r.left > 520 || r.height < 48 || r.height > 150 || r.width < 120) return false;
      return !rawNodes.some((other) => other !== el && other.contains(el));
    });
    let sectionDay = null;
    let leftToday = false;
    const items = [];
    const seen = new Set();
    for (const el of nodes) {
      const raw = (el.innerText || el.textContent || "").trim();
      if (!raw) continue;
      const t = raw.split("\\n").map((s) => s.trim()).filter(Boolean);
      const firstLine = t[0] || "";
      if (isDateHeader(firstLine) && t.length <= 2 && raw.length < 24) {
        sectionDay = firstLine;
        if (isPastDayLabel(sectionDay)) leftToday = true;
        continue;
      }
      const nameEl =
        el.querySelector(
          "[class*='geek-name'], [class*='friend-name'], [class*='name']:not([class*='job']):not([class*='company']):not([class*='source'])",
        ) || null;
      const titleEl =
        el.querySelector(
          "[class*='source-job'], [class*='job-name'], [class*='position'], [class*='join-text'], [class*='geek-job'], [class*='expect']",
        ) || null;
      let name = nameEl ? (nameEl.innerText || "").trim().split("\\n")[0].trim() : "";
      let title = titleEl ? cleanScrapedTitle((titleEl.innerText || "").trim().split("\\n")[0]) : "";
      if (!name) name = (t.find((x) => looksLikePersonName(x)) || "").slice(0, 20);
      if (!looksLikePersonName(name) || seen.has(name)) continue;
      if (!title || !looksLikeJobTitle(title)) {
        title = cleanScrapedTitle(
          t.find((x) => looksLikeJobTitle(x) && x !== name && !/^\\d{1,2}:\\d{2}$/.test(x)) || "",
        );
      }
      // Keep benefit tags out of matching, but preserve core role like 智能体开发工程师（AISaaS）.
      if (title) title = cleanScrapedTitle(title);
      const rowDay = guessRowDayLabel(t, sectionDay || "今天");
      if (isPastDayLabel(rowDay)) leftToday = true;
      if (todayOnly && isPastDayLabel(rowDay)) continue;
      seen.add(name);
      items.push({
        name,
        title: title || "",
        dayLabel: rowDay,
        preview: t.slice(0, 6).join(" | ").slice(0, 180),
        lines: t.slice(0, 8),
      });
      if (items.length >= (limit || 8)) break;
    }
    return { items, leftToday, dayLabel: sectionDay || "今天", rowProbe: nodes.length };
  }
  function findChatItems(limit, todayOnly) {
    const packed = collectOrderedChatRows(limit, Boolean(todayOnly));
    return packed.items || [];
  }
  function findChatItemsPacked(limit, todayOnly) {
    return collectOrderedChatRows(limit, Boolean(todayOnly));
  }
  function scrollChatList(times) {
    const root = findChatListRoot();
    // Prefer the left-rail scroller that actually owns the chat rows.
    let scroller = root;
    const kids = Array.from(root.querySelectorAll("div")).filter((el) => {
      if (!visible(el)) return false;
      const r = el.getBoundingClientRect();
      return r.left < 520 && el.scrollHeight > el.clientHeight + 80 && el.clientHeight > 160;
    });
    if (kids.length) {
      kids.sort((a, b) => b.scrollHeight - a.scrollHeight);
      scroller = kids[0];
    }
    let scrolled = 0;
    for (let i = 0; i < (times || 6); i++) {
      const before = scroller.scrollTop || 0;
      scroller.scrollTop = before + Math.max(280, Math.floor((scroller.clientHeight || 400) * 0.85));
      if (scroller.scrollTop === before) {
        root.scrollTop = (root.scrollTop || 0) + 280;
        window.scrollBy(0, 280);
      }
      scrolled += 1;
    }
    return { ok: true, scrolled };
  }
  function activeChatPanel() {
    const panels = Array.from(
      document.querySelectorAll(
        "[class*='chat-conversation'], [class*='conversation-bd'], [class*='chat-box'], [class*='chat-content'], [class*='message-list']",
      ),
    ).filter(visible);
    if (panels.length) {
      panels.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width);
      return panels[0];
    }
    // Fallback: right half of the window, never the left job-filter rail.
    return document.body;
  }
  function readOpenCandidateProfile() {
    const panel = activeChatPanel();
    const header =
      document.querySelector(
        "[class*='chat-title'], [class*='conversation-title'], [class*='base-info'], [class*='geek-info'], [class*='chat-header']",
      ) || panel;
    const scope = header || panel;
    const blob = (scope.innerText || scope.textContent || "").slice(0, 2500);
    const lines = blob.split("\\n").map((s) => s.trim()).filter(Boolean).slice(0, 40);
    const joined = lines.join("\\n");
    const pick = (re) => {
      const m = joined.match(re);
      return m ? String(m[1] || m[0]).trim().slice(0, 80) : "";
    };
    // Prefer explicit role labels; NEVER treat employer job-filter「管理」as candidate title.
    let title =
      pick(/(?:沟通职位|应聘职位|期望职位|职位名称)[:：]?\\s*([^\\n]{2,40})/) ||
      (lines.find((l) => looksLikeJobTitle(l)) || "");
    if (/^(管理|全部|职位)$/.test(title)) title = "";
    let city = pick(/(北京|上海|广州|深圳|杭州|成都|武汉|南京|苏州|西安|长沙|重庆|天津|佛山|东莞|珠海|厦门|青岛|大连|合肥|郑州|福州)/);
    let experience = pick(/(\\d+(?:\\.\\d+)?\\s*年(?:以上|以内|经验)?|应届|在校)/);
    let education = pick(/(博士|硕士|本科|大专|高中|中专)/);
    let salary = pick(/(\\d+\\s*[-~～]\\s*\\d+\\s*[Kk千]|面议|\\d+\\s*[Kk])/);
    const chatLines = readActiveChatReplies(12);
    return {
      title: title || "",
      city: city || "",
      experience: experience || "",
      education: education || "",
      salary: salary || "",
      chatExcerpt: chatLines.join(" / ").slice(0, 500),
      pageSnippet: lines.slice(0, 12).join(" | ").slice(0, 240),
    };
  }
  function forEachVisibleChatRow(fn) {
    const root = findChatListRoot();
    const preferSel =
      "[class*='geek-item'], [class*='friend-item'], [class*='chat-item'], [class*='conversation-item'], [class*='user-item'], [class*='geek-info']";
    let rawNodes = Array.from(root.querySelectorAll(preferSel));
    if (rawNodes.length < 3) {
      rawNodes = Array.from(root.querySelectorAll("li, [role='listitem'], div")).filter((el) => {
        if (!visible(el)) return false;
        const r = el.getBoundingClientRect();
        return r.left < 520 && r.width > 140 && r.width < 520 && r.height > 48 && r.height < 140;
      });
    }
    const nodes = rawNodes.filter((el) => {
      if (!visible(el)) return false;
      const r = el.getBoundingClientRect();
      if (r.left > 520 || r.height < 48 || r.height > 150 || r.width < 120) return false;
      return !rawNodes.some((other) => other !== el && other.contains(el));
    });
    let sectionDay = null;
    for (const el of nodes) {
      const raw = (el.innerText || el.textContent || "").trim();
      if (!raw) continue;
      const t = raw.split("\\n").map((s) => s.trim()).filter(Boolean);
      const firstLine = t[0] || "";
      if (isDateHeader(firstLine) && t.length <= 2 && raw.length < 24) {
        sectionDay = firstLine;
        continue;
      }
      const nameEl =
        el.querySelector(
          "[class*='geek-name'], [class*='friend-name'], [class*='name']:not([class*='job']):not([class*='company']):not([class*='source'])",
        ) || null;
      let name = nameEl ? (nameEl.innerText || "").trim().split("\\n")[0].trim() : "";
      if (!name) name = (t.find((x) => looksLikePersonName(x)) || "").slice(0, 20);
      if (!looksLikePersonName(name)) continue;
      const rowDay = guessRowDayLabel(t, sectionDay || "今天");
      if (fn({ name, el, dayLabel: rowDay, lines: t }) === false) return;
    }
  }
  function openByName(name) {
    const want = String(name || "").trim();
    if (!want) return false;
    // Prefer exact geek-name span (stable on「已获取简历」rail).
    const nameEls = Array.from(document.querySelectorAll("span.geek-name")).filter(visible);
    for (const el of nameEls) {
      const n = (el.textContent || "").trim();
      if (n !== want) continue;
      const row = el.closest("li, [class*='geek-item'], [class*='friend-item'], [class*='chat-item']") || el.parentElement;
      if (row) row.click();
      else el.click();
      return true;
    }
    let found = false;
    forEachVisibleChatRow(({ name: n, el }) => {
      if (n === want || n.includes(want) || want.includes(n)) {
        el.click();
        found = true;
        return false;
      }
    });
    return found;
  }
  function clickGotResumeTab() {
    return clickByText([/^已获取简历$/], document);
  }
  function resetChatListTop() {
    const root = findChatListRoot();
    root.scrollTop = 0;
    const kids = Array.from(root.querySelectorAll("div")).filter((el) => {
      if (!visible(el)) return false;
      const r = el.getBoundingClientRect();
      return r.left < 520 && el.scrollHeight > el.clientHeight + 80 && el.clientHeight > 160;
    });
    if (kids.length) {
      kids.sort((a, b) => b.scrollHeight - a.scrollHeight);
      kids[0].scrollTop = 0;
    }
    return { ok: true };
  }
  function findChatInputBox() {
    const panel = activeChatPanel();
    const scopes = [panel, document];
    for (const scope of scopes) {
      if (!scope) continue;
      const bossEditor = scope.querySelector?.(".boss-chat-editor-input");
      if (bossEditor && visible(bossEditor)) return bossEditor;
      const boxes = Array.from(
        scope.querySelectorAll(
          "textarea, [contenteditable='true'], [contenteditable='plaintext-only'], div[role='textbox'], [class*='input-area'] textarea, [class*='chat-input'] textarea, [class*='chat-input'] [contenteditable], .boss-chat-editor-input",
        ),
      );
      // Prefer bottom-right chat composer, never the left search box.
      const ranked = boxes
        .filter((el) => visible(el))
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { el, r, score: r.top + r.left * 0.2 };
        })
        .filter((x) => x.r.width > 80 && x.r.height > 18 && x.r.left > 280)
        .sort((a, b) => b.score - a.score);
      if (ranked.length) return ranked[0].el;
    }
    return null;
  }
  function setNativeValue(el, value) {
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      const proto = Object.getPrototypeOf(el);
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(el, value);
      else el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    el.focus();
    try {
      document.execCommand("selectAll", false, null);
      const ok = document.execCommand("insertText", false, value);
      if (ok) return true;
    } catch (_) {}
    el.textContent = value;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
    return true;
  }
  function clickSendNear(box) {
    // Boss composer: send control is often a sibling of the editor (e.g. .submit.active),
    // not inside the contenteditable node. Prefer explicit submit selectors, then page-wide「发送」.
    const prefer = Array.from(
      document.querySelectorAll(".submit.active, .submit-content, [class*='submit'].active, button.submit"),
    ).filter(visible);
    for (const el of prefer) {
      const t = (el.innerText || el.textContent || "").trim();
      if (t && t !== "发送" && !/^发送$/.test(t)) continue;
      el.click();
      return { ok: true, matched: t || el.className?.toString?.().slice(0, 40) || "submit" };
    }
    const panel = activeChatPanel() || document;
    const exact = clickByText([/^发送$/], panel);
    if (exact.ok) return exact;
    const exactDoc = clickByText([/^发送$/], document);
    if (exactDoc.ok) return exactDoc;
    const nodes = Array.from(document.querySelectorAll("button, a, span, div")).filter(visible);
    const boxRect = box ? box.getBoundingClientRect() : null;
    for (const el of nodes) {
      const t = (el.innerText || el.textContent || "").trim();
      if (t !== "发送") continue;
      if (boxRect) {
        const r = el.getBoundingClientRect();
        if (Math.abs(r.top - boxRect.bottom) > 160 && Math.abs(r.top - boxRect.top) > 160) continue;
        if (r.left < boxRect.left - 40) continue;
      }
      el.click();
      return { ok: true, matched: t };
    }
    return { ok: false };
  }
  function installPdfHarvestHooks() {
    if (window.__ocPdfHarvestInstalled) return { ok: true, already: true };
    window.__ocPdfHarvestInstalled = true;
    window.__ocPdfHarvest = [];
    window.__ocResumeJson = [];
    window.__ocResumeUrls = [];
    const pushUrl = (url) => {
      const u = String(url || "");
      if (!u || !/^https?:|^blob:/i.test(u)) return;
      if (window.__ocResumeUrls.includes(u)) return;
      if (/resume|preview|attach|download|pdf|oss|cdn|file|authority|encrypt/i.test(u)) {
        window.__ocResumeUrls.push(u);
      }
    };
    const push = (url, buf) => {
      try {
        if (!buf || buf.byteLength < 200) return;
        const bytes = new Uint8Array(buf);
        const head = String.fromCharCode.apply(null, bytes.subarray(0, 8));
        const looksPdf = head.startsWith("%PDF");
        const looksZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
        if (!looksPdf && !looksZip) return;
        let bin = "";
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        window.__ocPdfHarvest.push({
          url: String(url || ""),
          b64: btoa(bin),
          bytes: bytes.length,
          kind: looksPdf ? "pdf" : "zip",
        });
      } catch (_) {}
    };
    const looksBinary = (url, ct) =>
      /pdf|octet-stream|msword|officedocument|zip/i.test(String(ct || "")) ||
      /\\.pdf($|\\?)/i.test(String(url || ""));
    const looksResumeJson = (url) =>
      /\\/wapi\\//i.test(String(url || "")) &&
      /resume|preview|attach|download|file|geek/i.test(String(url || "")) &&
      !/actionLog|dapCommon|apm|common\\.json/i.test(String(url || ""));
    const origFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const res = await origFetch(...args);
      try {
        const url = typeof args[0] === "string" ? args[0] : args[0] && args[0].url;
        pushUrl(url);
        const ct = res.headers && res.headers.get("content-type");
        if (looksBinary(url, ct)) {
          const clone = res.clone();
          push(url, await clone.arrayBuffer());
        } else if (looksResumeJson(url)) {
          const clone = res.clone();
          const text = await clone.text();
          window.__ocResumeJson.push({ url: String(url || ""), text: text.slice(0, 8000) });
          // Nested file URLs inside ticket JSON.
          const re = /https?:\\/\\/[^"\\s]+/g;
          let m;
          while ((m = re.exec(text))) pushUrl(m[0].replace(/[),;]+$/, ""));
        } else if (/oss|zpcdn|resumecdn|bosscdn|\\.pdf($|\\?)/i.test(String(url || "")) || /octet-stream|application\\/pdf/i.test(String(ct || ""))) {
          // CDN/file URLs sometimes lie about content-type; sniff magic only for those.
          const clone = res.clone();
          const ab = await clone.arrayBuffer();
          if (ab && ab.byteLength > 200) push(url, ab);
        }
      } catch (_) {}
      return res;
    };
    const OrigXHR = window.XMLHttpRequest;
    function HookedXHR() {
      const xhr = new OrigXHR();
      let reqUrl = "";
      const open = xhr.open;
      xhr.open = function (method, url, ...rest) {
        reqUrl = String(url || "");
        pushUrl(reqUrl);
        return open.call(this, method, url, ...rest);
      };
      xhr.addEventListener("load", function () {
        try {
          const ct = xhr.getResponseHeader("content-type") || "";
          if (looksBinary(reqUrl, ct)) {
            if (xhr.response instanceof ArrayBuffer) push(reqUrl, xhr.response);
            else if (typeof xhr.response === "string") {
              const enc = new TextEncoder().encode(xhr.response);
              push(reqUrl, enc.buffer);
            }
          } else if (looksResumeJson(reqUrl) && typeof xhr.responseText === "string") {
            window.__ocResumeJson.push({ url: reqUrl, text: xhr.responseText.slice(0, 8000) });
          }
        } catch (_) {}
      });
      try {
        xhr.responseType = "arraybuffer";
      } catch (_) {}
      return xhr;
    }
    HookedXHR.prototype = OrigXHR.prototype;
    window.XMLHttpRequest = HookedXHR;
    // Blob preview path (pdf.js / in-page viewer).
    try {
      const origCreate = URL.createObjectURL.bind(URL);
      URL.createObjectURL = function (obj) {
        const u = origCreate(obj);
        try {
          pushUrl(u);
          if (obj instanceof Blob && ( /pdf|octet|msword|zip/i.test(obj.type || "") || obj.size > 1000 )) {
            obj.arrayBuffer().then((ab) => push(u, ab)).catch(() => {});
          }
        } catch (_) {}
        return u;
      };
    } catch (_) {}
    return { ok: true };
  }
  function takePdfHarvest() {
    const rows = Array.isArray(window.__ocPdfHarvest) ? window.__ocPdfHarvest.slice() : [];
    window.__ocPdfHarvest = [];
    return rows;
  }
  function takeResumeJsonHarvest() {
    const rows = Array.isArray(window.__ocResumeJson) ? window.__ocResumeJson.slice() : [];
    const urls = Array.isArray(window.__ocResumeUrls) ? window.__ocResumeUrls.slice() : [];
    window.__ocResumeJson = [];
    window.__ocResumeUrls = [];
    return { json: rows, urls };
  }
  function previewModalOpen() {
    const hasViewer = !!document.querySelector(
      "iframe[src*='pdf'], iframe[src*='preview'], embed[type*='pdf'], canvas, .pdf-viewer, [class*='resume-preview'], [class*='attachment-preview'], [class*='PreviewDialog'], [class*='preview-dialog']",
    );
    const hasDlg = Array.from(document.querySelectorAll("[class*='dialog'],[class*='modal'],[role='dialog']"))
      .some((el) => /简历|预览|PDF|下载/.test((el.innerText || "").slice(0, 200)) && el.offsetParent !== null);
    return { ok: hasViewer || hasDlg, hasViewer, hasDlg };
  }
  function clickAttachmentPreview() {
    // Scroll conversation toward bottom — attachment cards are usually latest.
    try {
      const panel =
        document.querySelector(
          "[class*='chat-conversation'], [class*='conversation-bd'], [class*='message-list'], [class*='chat-box']",
        ) || document.body;
      panel.scrollTop = panel.scrollHeight;
    } catch (_) {}
    // Stable Boss selectors (resume-only chats still use these).
    const cardBtn = Array.from(document.querySelectorAll("span.card-btn, .card-btn"))
      .filter(visible)
      .find((el) => /点击预览附件简历|预览附件简历/.test((el.innerText || el.textContent || "").trim()));
    if (cardBtn) {
      cardBtn.scrollIntoView({ block: "center", inline: "nearest" });
      cardBtn.click();
      return { ok: true, matched: ((cardBtn.innerText || cardBtn.textContent || "").trim() || "card-btn").slice(0, 60) };
    }
    const pdfTitle = Array.from(
      document.querySelectorAll("h3.message-card-top-title, .message-card-top-title, .message-card-top-text"),
    )
      .filter(visible)
      .find((el) => /\\.pdf/i.test((el.innerText || el.textContent || "").trim()));
    if (pdfTitle) {
      const card =
        pdfTitle.closest("[class*='message-card']") || pdfTitle.parentElement || pdfTitle;
      const btn = card.querySelector?.(".card-btn") || pdfTitle;
      btn.scrollIntoView({ block: "center", inline: "nearest" });
      btn.click();
      return { ok: true, matched: ((pdfTitle.innerText || "").trim() || "pdf-title").slice(0, 60) };
    }
    // Boss attachment card: "xxx.pdf" + "点击预览附件简历"
    const prefer = Array.from(
      document.querySelectorAll(
        ".message-card-buttons, .hyperLink, [class*='message-card'], [class*='resume-card'], a, div, span",
      ),
    ).filter(visible);
    for (const el of prefer) {
      const t = (el.innerText || el.textContent || "").trim().replace(/\\s+/g, " ");
      if (!t || t.length > 80) continue;
      if (/点击预览附件简历/.test(t) || (/\\.pdf/i.test(t) && /预览|附件简历/.test(t))) {
        el.scrollIntoView({ block: "center", inline: "nearest" });
        el.click();
        return { ok: true, matched: t.slice(0, 60) };
      }
    }
    return clickByText([/点击预览附件简历/, /预览附件简历/], document);
  }
  function previewRoots() {
    // Boss preview dialogs are often position:fixed → offsetParent is null; do not require it.
    const named = [
      ...document.querySelectorAll(
        "[role='dialog'], .dialog-wrap, .dialog-container, [class*='dialog'], [class*='modal'], [class*='preview'], [class*='Drawer'], [class*='drawer'], [class*='layer'], [class*='popup'], [class*='overlay']",
      ),
    ].filter((el) => {
      try {
        if (!visible(el)) return false;
        const r = el.getBoundingClientRect();
        return r.width > 360 && r.height > 320;
      } catch (_) {
        return false;
      }
    });
    if (named.length) return named;
    // Class-agnostic fallback: large fixed/absolute overlay panels.
    return Array.from(document.querySelectorAll("div"))
      .filter((el) => {
        if (!visible(el)) return false;
        const r = el.getBoundingClientRect();
        const st = window.getComputedStyle(el);
        if (r.width < 420 || r.height < 360) return false;
        if (st.position !== "fixed" && st.position !== "absolute") return false;
        return r.top < window.innerHeight * 0.35;
      })
      .sort((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        return rb.width * rb.height - ra.width * ra.height;
      })
      .slice(0, 5);
  }
  function toolbarIconsInRoot(root) {
    const box = root.getBoundingClientRect();
    return Array.from(root.querySelectorAll("button, a, span, i, div, svg"))
      .map((el) => {
        if (el.tagName === "SVG" || el.tagName === "I" || el.tagName === "USE") {
          return el.closest("button, a, span, div") || el;
        }
        return el;
      })
      .filter((el, idx, arr) => arr.indexOf(el) === idx)
      .filter(visible)
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return (
          r.width > 0 &&
          r.width <= 56 &&
          r.height <= 56 &&
          r.top >= box.top - 8 &&
          r.top < box.top + 120 &&
          r.left > box.left + box.width * 0.45
        );
      })
      .sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left);
  }
  function findGlobalToolbarDownload() {
    // Screenshot: modal toolbar is on the white resume card (center), NOT the page VIP/header strip.
    // Prefer a tight cluster of 3–4 small icons whose rightmost is inset from the viewport edge.
    const raw = Array.from(document.querySelectorAll("button, a, span, i, div"))
      .filter(visible)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { el, r, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
      })
      .filter(({ r }) => {
        return (
          r.width > 8 &&
          r.width <= 56 &&
          r.height <= 56 &&
          r.top > 56 &&
          r.top < 220 &&
          r.left > window.innerWidth * 0.35 &&
          // Page header controls sit flush to the right; modal close is inset on the card.
          r.right < window.innerWidth - 36
        );
      })
      .sort((a, b) => b.cx - a.cx);
    const uniq = [];
    for (const it of raw) {
      if (uniq.some((u) => Math.hypot(u.cx - it.cx, u.cy - it.cy) < 8)) continue;
      uniq.push(it);
    }
    // Group by similar Y (modal toolbar row).
    const groups = [];
    for (const it of uniq) {
      let g = groups.find((x) => Math.abs(x.y - it.cy) < 18);
      if (!g) {
        g = { y: it.cy, items: [] };
        groups.push(g);
      }
      g.items.push(it);
    }
    groups.sort((a, b) => b.items.length - a.items.length);
    for (const g of groups) {
      const items = g.items.sort((a, b) => b.cx - a.cx);
      if (items.length < 3) continue;
      // Width of cluster should look like a toolbar (~3–5 icon slots), not scattered headers.
      const span = items[0].cx - items[Math.min(3, items.length - 1)].cx;
      if (span > 220) continue;
      // icons[0]=close, icons[1]=download
      return items[1];
    }
    // Fallback: 2nd from right among inset icons only.
    if (uniq.length >= 2) return uniq[1];
    return null;
  }
  function clickDownloadInPreview() {
    const roots = previewRoots();
    for (const root of roots) {
      const icons = toolbarIconsInRoot(root);
      if (icons.length >= 2) {
        const el = icons[1];
        el.scrollIntoView({ block: "center", inline: "nearest" });
        el.click();
        return { ok: true, matched: "toolbar-download-2nd-from-right", iconCount: icons.length };
      }
    }
    const hit = findGlobalToolbarDownload();
    if (hit) {
      hit.el.click();
      return { ok: true, matched: "global-toolbar-2nd-from-right" };
    }
    const scopes = roots.length ? roots : [document];
    for (const root of scopes) {
      const nodes = Array.from(
        root.querySelectorAll("button, a, span, i, [class*='download'], [title], [aria-label]"),
      ).filter(visible);
      for (const el of nodes) {
        const label = String(el.getAttribute("aria-label") || el.title || "");
        const cls = String(el.getAttribute("class") || "");
        const t = (el.innerText || "").trim();
        if (/^关闭$|close/i.test(label + t)) continue;
        if (/下载|download/i.test(label + t) || /icon[-_]?download|download/i.test(cls)) {
          const target = el.closest("button, a, span, div") || el;
          target.click();
          return { ok: true, matched: (label || t || cls).slice(0, 60) };
        }
      }
    }
    return { ok: false, roots: roots.length };
  }
  function findDownloadInPreviewBox() {
    const roots = previewRoots();
    for (const root of roots) {
      const icons = toolbarIconsInRoot(root);
      if (icons.length >= 2) {
        const r = icons[1].getBoundingClientRect();
        return {
          x: r.left + r.width / 2,
          y: r.top + r.height / 2,
          via: "toolbar-2nd-from-right",
          iconCount: icons.length,
        };
      }
    }
    const hit = findGlobalToolbarDownload();
    if (hit) {
      return { x: hit.cx, y: hit.cy, via: "global-toolbar-2nd-from-right" };
    }
    for (const root of roots.length ? roots : [document]) {
      for (const el of root.querySelectorAll("button, a, span, i, [class*='download'], [title], [aria-label]")) {
        if (!visible(el)) continue;
        const cls = String(el.getAttribute("class") || "");
        const label = String(el.getAttribute("aria-label") || el.title || "");
        const t = (el.innerText || "").trim();
        if (/关闭|close|取消/i.test(label + t)) continue;
        if (/下载|download/i.test(label + t) || /icon[-_]?download|download/i.test(cls)) {
          const r = el.getBoundingClientRect();
          return {
            x: r.left + r.width / 2,
            y: r.top + r.height / 2,
            via: (label || t || cls || "icon").slice(0, 60),
          };
        }
      }
    }
    return null;
  }
  function listModalToolbarIcons() {
    const hit = findGlobalToolbarDownload();
    // Rebuild the chosen cluster and return up to 4 icon centers from the right.
    const raw = Array.from(document.querySelectorAll("button, a, span, i, div"))
      .filter(visible)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { el, r, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
      })
      .filter(({ r }) => {
        return (
          r.width > 8 &&
          r.width <= 56 &&
          r.height <= 56 &&
          r.top > 56 &&
          r.top < 220 &&
          r.left > window.innerWidth * 0.35 &&
          r.right < window.innerWidth - 36
        );
      });
    const uniq = [];
    for (const it of raw) {
      if (uniq.some((u) => Math.hypot(u.cx - it.cx, u.cy - it.cy) < 8)) continue;
      uniq.push(it);
    }
    const groups = [];
    for (const it of uniq) {
      let g = groups.find((x) => Math.abs(x.y - it.cy) < 18);
      if (!g) {
        g = { y: it.cy, items: [] };
        groups.push(g);
      }
      g.items.push(it);
    }
    groups.sort((a, b) => b.items.length - a.items.length);
    let items = [];
    for (const g of groups) {
      const sorted = g.items.sort((a, b) => b.cx - a.cx);
      if (sorted.length >= 3) {
        const span = sorted[0].cx - sorted[Math.min(3, sorted.length - 1)].cx;
        if (span <= 220) {
          items = sorted;
          break;
        }
      }
    }
    if (!items.length) items = uniq.sort((a, b) => b.cx - a.cx);
    return items.slice(0, 4).map((it, idx) => ({
      idx,
      x: it.cx,
      y: it.cy,
      cls: String(it.el.getAttribute("class") || "").slice(0, 60),
      aria: it.el.getAttribute("aria-label") || "",
      title: it.el.title || "",
    }));
  }
  function dumpPreviewDownloadDebug() {
    const roots = previewRoots().map((el) => {
      const r = el.getBoundingClientRect();
      return {
        cls: String(el.getAttribute("class") || "").slice(0, 80),
        w: Math.round(r.width),
        h: Math.round(r.height),
        top: Math.round(r.top),
        pos: window.getComputedStyle(el).position,
      };
    });
    const box = findDownloadInPreviewBox();
    return { roots, box, vw: window.innerWidth, vh: window.innerHeight };
  }
  function clickAgreeResumeIfNeeded() {
    return clickByText(
      [/^同意$/, /^同意查看$/, /^同意并预览$/, /^确认$/, /^我知道了$/, /^知道了$/],
      document,
    );
  }
  function findPdfLikeUrls() {
    const urls = [];
    for (const a of Array.from(document.querySelectorAll("a[href], iframe[src], embed[src]"))) {
      const href = a.href || a.src || "";
      if (/\\.pdf($|\\?)|resume|attachment|preview|file/i.test(href)) urls.push(href);
    }
    return urls.slice(0, 8);
  }
  function clickBossInterviewEntry() {
    // Toolbar item near bottom composer — avoid left-rail noise.
    const nodes = Array.from(
      document.querySelectorAll(".operate-icon-item, .operate-btn, div, span, button, a"),
    ).filter(visible);
    for (const el of nodes) {
      const t = (el.innerText || el.textContent || "").trim();
      const r = el.getBoundingClientRect();
      if (t !== "约面试") continue;
      if (r.top < 360 || r.width > 160) continue;
      el.click();
      return { ok: true, matched: t };
    }
    return clickByText([/^约面试$/], document);
  }
  function fillBossInterviewForm(details) {
    const mode = String(details?.mode || "online");
    const time = String(details?.time || "").trim();
    const place = String(details?.place || "").trim();
    const clicked = [];
    const clickOne = (patterns) => {
      const r = clickByText(patterns, document);
      if (r.ok) clicked.push(r.matched);
      return r.ok;
    };
    if (mode === "offline") {
      clickOne([/^线下面试$/, /线下/, /到面/]);
      if (place) {
        const inputs = Array.from(document.querySelectorAll("input, textarea")).filter(visible);
        const addr = inputs.find((el) =>
          /地址|地点|面试地点|公司地址/.test(
            String(el.placeholder || "") + String(el.name || "") + String(el.getAttribute("aria-label") || ""),
          ),
        ) || inputs.find((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 120 && /text|search|/.test(el.type || "text");
        });
        if (addr) {
          addr.focus();
          setNativeValue(addr, place);
          clicked.push("place");
        }
      }
    } else {
      clickOne([/^线上面试$/, /视频面试/, /线上/, /远程/]);
    }
    if (time) {
      const inputs = Array.from(document.querySelectorAll("input, textarea")).filter(visible);
      const timeInput = inputs.find((el) =>
        /时间|日期|面试时间/.test(
          String(el.placeholder || "") + String(el.name || "") + String(el.getAttribute("aria-label") || ""),
        ),
      );
      if (timeInput) {
        timeInput.focus();
        setNativeValue(timeInput, time);
        clicked.push("time");
      } else {
        // Prefer common chips containing the time phrase.
        const chip = Array.from(document.querySelectorAll("button, span, div, li"))
          .filter(visible)
          .find((el) => {
            const t = (el.innerText || "").trim();
            return t && t.length < 30 && t.includes(time.slice(0, Math.min(6, time.length)));
          });
        if (chip) {
          chip.click();
          clicked.push(chip.innerText.trim().slice(0, 20));
        }
      }
    }
    const confirm = clickByText(
      [/^确定$/, /^确认$/, /^发送$/, /^发出邀约$/, /^确认邀约$/, /^约面试$/],
      document,
    );
    return {
      ok: Boolean(confirm.ok),
      submitted: Boolean(confirm.ok),
      clicked,
      confirm: confirm.matched || null,
    };
  }
  function typeAndSend(message) {
    const text = String(message || "");
    if (!text.trim()) return { ok: false, error: "empty_message" };
    const box = findChatInputBox();
    if (!box) return { ok: false, error: "input_not_found" };
    box.focus();
    setNativeValue(box, text);
    box.dispatchEvent(new Event("input", { bubbles: true }));
    box.dispatchEvent(new Event("change", { bubbles: true }));
    // Let Boss enable .submit.active after the composer value settles.
    const start = Date.now();
    while (Date.now() - start < 400) {
      /* busy-wait briefly in page context */
    }
    let enterOk = false;
    try {
      enterOk = box.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        }),
      );
      box.dispatchEvent(
        new KeyboardEvent("keyup", {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        }),
      );
    } catch (_) {}
    const send = clickSendNear(box);
    const ok = Boolean(send.ok);
    return {
      ok,
      typed: true,
      sendClicked: ok,
      enterDispatched: Boolean(enterOk),
      matched: send.matched || null,
      error: ok ? null : "send_button_not_clicked",
    };
  }
  function lastOutgoingLooksLike(snippet) {
    const needle = String(snippet || "").replace(/\\s+/g, "").slice(0, 24);
    if (!needle) return false;
    const box = findChatInputBox();
    const draft = ((box && (box.innerText || box.textContent || box.value || "")) || "").replace(/\\s+/g, "");
    const lines = readActiveChatReplies(24);
    return (lines || []).some((l) => {
      const s = String(l || "").replace(/\\s+/g, "");
      // Composer draft must never count as "already sent".
      if (!s || s === draft) return false;
      return s.includes(needle);
    });
  }
  function composerText() {
    const box = findChatInputBox();
    return ((box && (box.innerText || box.textContent || box.value || "")) || "").trim();
  }
  function getSubmitPoint() {
    const el =
      document.querySelector(".submit.active") ||
      document.querySelector(".submit-content") ||
      document.querySelector(".submit");
    if (!el || !visible(el)) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return null;
    return {
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
      cls: String(el.className || "").slice(0, 80),
    };
  }
  function readActiveChatReplies(limit) {
    // Prefer message bubbles inside the right-hand conversation panel only.
    const panel =
      document.querySelector(
        "[class*='chat-conversation'], [class*='conversation-bd'], [class*='chat-box'], [class*='message-list']",
      ) || null;
    const scope = panel || document;
    const prefer = Array.from(
      scope.querySelectorAll(
        "[class*='message-item'], [class*='msg-item'], [class*='chat-message'], [class*='bubble']",
      ),
    );
    const bubbles = prefer.length
      ? prefer
      : Array.from(scope.querySelectorAll("[class*='message'], [class*='msg']"));
    const lines = [];
    for (const el of bubbles) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      // Ignore left conversation rail.
      if (r.left < 360) continue;
      const t = (el.innerText || el.textContent || "").trim().replace(/\\s+/g, " ");
      if (t.length < 2 || t.length > 280) continue;
      if (/发送|输入|沟通|消息|搜索|筛选|新招呼|牛人/.test(t) && t.length < 12) continue;
      if (t.split(" ").length > 40) continue;
      if (lines[lines.length - 1] === t) continue;
      lines.push(t);
      if (lines.length >= (limit || 20)) break;
    }
    return lines.slice(-Math.max(6, limit || 12));
  }
  window.__openclawBoss = {
    clickByText,
    findChatItems,
    findChatItemsPacked,
    openByName,
    resetChatListTop,
    typeAndSend,
    findChatInputBox,
    setNativeValue,
    clickAttachmentPreview,
    clickDownloadInPreview,
    findDownloadInPreviewBox,
    dumpPreviewDownloadDebug,
    listModalToolbarIcons,
    clickAgreeResumeIfNeeded,
    clickGotResumeTab,
    findPdfLikeUrls,
    installPdfHarvestHooks,
    takePdfHarvest,
    takeResumeJsonHarvest,
    previewModalOpen,
    clickBossInterviewEntry,
    fillBossInterviewForm,
    readActiveChatReplies,
    readOpenCandidateProfile,
    lastOutgoingLooksLike,
    composerText,
    getSubmitPoint,
    scrollChatList,
    looksLikeJobTitle,
    looksLikePersonName,
    visible,
  };
  return true;
})()
`;

async function injectHelper(win) {
  await win.webContents.executeJavaScript(DOM_HELPER, true);
}

async function runInPage(win, expr) {
  return win.webContents.executeJavaScript(expr, true);
}

function sendMouseClick(win, x, y) {
  const px = Math.round(x);
  const py = Math.round(y);
  // Hover first — Boss icon buttons often bind handlers on mouseenter.
  win.webContents.sendInputEvent({ type: "mouseMove", x: px, y: py });
  win.webContents.sendInputEvent({
    type: "mouseDown",
    x: px,
    y: py,
    button: "left",
    clickCount: 1,
  });
  win.webContents.sendInputEvent({
    type: "mouseUp",
    x: px,
    y: py,
    button: "left",
    clickCount: 1,
  });
}

function sendEnterKey(win) {
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
  win.webContents.sendInputEvent({ type: "char", keyCode: "Return" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
}

/**
 * Boss chat send must be proven: either the draft left the composer, or the
 * exact text appears in message bubbles (never count the input box itself).
 * DOM .click() alone is insufficient — Boss often ignores synthetic clicks.
 */
async function composeAndSendVerified(win, text) {
  const want = String(text || "").trim();
  if (!want) return { ok: false, error: "empty_message" };
  await injectHelper(win);

  // Focus Boss BrowserWindow first: insertText / Ctrl+V only land in the focused webContents.
  try {
    win.show();
    win.focus();
    if (typeof win.webContents.focus === "function") win.webContents.focus();
  } catch {
    // ignore
  }
  await sleep(80);

  const focused = await runInPage(
    win,
    `(() => {
      const box = window.__openclawBoss.findChatInputBox
        ? window.__openclawBoss.findChatInputBox()
        : document.querySelector(".boss-chat-editor-input");
      if (!box) return { ok: false, error: "input_not_found" };
      box.scrollIntoView({ block: "nearest", inline: "nearest" });
      box.focus();
      box.click();
      try { document.execCommand("selectAll", false, null); } catch (_) {}
      return { ok: true, tag: box.tagName, cls: String(box.className || "").slice(0, 80) };
    })()`,
  );
  if (!focused?.ok) {
    return { ok: false, typed: false, error: focused?.error || "input_not_found" };
  }
  await sleep(120);

  const needle = want.slice(0, Math.min(6, want.length));
  const draftHasNeedle = async () => {
    const d = String((await runInPage(win, `window.__openclawBoss.composerText()`)) || "");
    return { ok: Boolean(needle && d.includes(needle)), draft: d };
  };

  // Prefer Chromium insertText; only skip fallbacks when the composer actually shows text.
  let typed = false;
  try {
    if (typeof win.webContents.insertText === "function") {
      win.webContents.insertText(want);
      await sleep(250);
      typed = (await draftHasNeedle()).ok;
    }
  } catch {
    typed = false;
  }
  if (!typed) {
    const previousClip = clipboard.readText();
    try {
      clipboard.writeText(want);
      // Ctrl+V is more reliable than execCommand('paste') on Boss contenteditable.
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "V", modifiers: ["control"] });
      win.webContents.sendInputEvent({ type: "char", keyCode: "v", modifiers: ["control"] });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: "V", modifiers: ["control"] });
      await sleep(280);
      typed = (await draftHasNeedle()).ok;
      if (!typed) {
        typed = Boolean(
          await runInPage(
            win,
            `(() => {
              const box = window.__openclawBoss.findChatInputBox()
                || document.querySelector(".boss-chat-editor-input")
                || document.querySelector("[contenteditable='true']")
                || document.querySelector("textarea");
              if (!box) return false;
              return window.__openclawBoss.setNativeValue
                ? window.__openclawBoss.setNativeValue(box, ${JSON.stringify(want)})
                : (() => {
                    box.focus();
                    document.execCommand("selectAll", false, null);
                    if (document.execCommand("paste", false, null)) return true;
                    try { return document.execCommand("insertText", false, ${JSON.stringify(want)}); } catch (_) {}
                    box.textContent = ${JSON.stringify(want)};
                    box.dispatchEvent(new InputEvent("input", { bubbles: true, data: ${JSON.stringify(want)}, inputType: "insertText" }));
                    return true;
                  })();
            })()`,
          ),
        );
      }
    } finally {
      try {
        clipboard.writeText(previousClip);
      } catch {
        // ignore
      }
    }
  }
  await sleep(400);

  let draft = String((await runInPage(win, `window.__openclawBoss.composerText()`)) || "");
  if (!draft.includes(needle)) {
    // Last resort: set text via page script again
    await runInPage(
      win,
      `(() => {
        const box = window.__openclawBoss.findChatInputBox()
          || document.querySelector(".boss-chat-editor-input");
        if (!box) return false;
        box.focus();
        if (window.__openclawBoss.setNativeValue) {
          return window.__openclawBoss.setNativeValue(box, ${JSON.stringify(want)});
        }
        box.innerHTML = "";
        try { document.execCommand("insertText", false, ${JSON.stringify(want)}); } catch (_) {}
        if (!(box.innerText || "").includes(${JSON.stringify(want.slice(0, 4))})) {
          box.textContent = ${JSON.stringify(want)};
          box.dispatchEvent(new InputEvent("input", { bubbles: true, data: ${JSON.stringify(want)}, inputType: "insertText" }));
        }
        return true;
      })()`,
    );
    await sleep(300);
    draft = String((await runInPage(win, `window.__openclawBoss.composerText()`)) || "");
  }
  if (!draft.includes(want.slice(0, Math.min(6, want.length)))) {
    return { ok: false, typed: Boolean(typed), error: "composer_not_filled", draft };
  }

  let sendClicked = false;
  let matched = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const point = await runInPage(win, `window.__openclawBoss.getSubmitPoint()`);
    if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
      sendMouseClick(win, point.x, point.y);
      sendClicked = true;
      matched = point.cls || "submit";
      await sleep(700);
    } else {
      await runInPage(win, `window.__openclawBoss.typeAndSend(${JSON.stringify(want)})`);
      sendEnterKey(win);
      await sleep(700);
    }

    const verified = Boolean(
      await runInPage(
        win,
        `window.__openclawBoss.lastOutgoingLooksLike(${JSON.stringify(want.slice(0, 40))})`,
      ),
    );
    const left = String((await runInPage(win, `window.__openclawBoss.composerText()`)) || "");
    const inputCleared = !left || left !== want;
    if (verified || (sendClicked && inputCleared && left.length === 0)) {
      return {
        ok: true,
        typed: true,
        sendClicked,
        verified: verified || left.length === 0,
        matched,
        inputCleared: left.length === 0,
        error: null,
      };
    }
    if (left === want || left.includes(want.slice(0, 6))) {
      await runInPage(
        win,
        `(() => { const b=document.querySelector(".boss-chat-editor-input"); if(b) b.focus(); return true; })()`,
      );
      sendEnterKey(win);
      await sleep(700);
    }
  }

  const verified = Boolean(
    await runInPage(
      win,
      `window.__openclawBoss.lastOutgoingLooksLike(${JSON.stringify(want.slice(0, 40))})`,
    ),
  );
  const left = String((await runInPage(win, `window.__openclawBoss.composerText()`)) || "");
  const ok = verified || left.length === 0;
  return {
    ok,
    typed: true,
    sendClicked,
    verified,
    matched,
    inputCleared: left.length === 0,
    draft: left,
    error: ok ? null : "not_verified_in_chat",
  };
}

async function gateOrFail(win) {
  const page = await ensureChatPage(win);
  if (page.blocked) {
    return {
      ok: false,
      blocked: true,
      loggedIn: false,
      message: "Boss 访问受限（本机出口 IP 被风控）。请换网络后重试。",
      page,
    };
  }
  if (!page.loggedIn) {
    return {
      ok: false,
      blocked: false,
      loggedIn: false,
      message: "Boss 未登录。请先在本机 Boss 窗口登录并检验登录态。",
      page,
    };
  }
  await injectHelper(win);
  return { ok: true, page };
}

async function ensureChatAllTab(browserWin) {
  await runInPage(browserWin, `window.__openclawBoss.clickByText([/^沟通$/], document)`);
  await sleep(500);
  await runInPage(browserWin, `window.__openclawBoss.clickByText([/^全部$/], document)`);
  await sleep(500);
  await runInPage(browserWin, `window.__openclawBoss.resetChatListTop()`);
  await sleep(250);
}

/**
 * Virtualized left rail: named people may sit below the fold.
 * Scroll from top until openByName hits, or give up.
 */
async function openChatByName(browserWin, name) {
  const want = String(name || "").trim();
  if (!want) return false;
  await runInPage(browserWin, `window.__openclawBoss.resetChatListTop()`);
  await sleep(200);
  for (let round = 0; round < 60; round++) {
    const opened = await runInPage(
      browserWin,
      `window.__openclawBoss.openByName(${JSON.stringify(want)})`,
    );
    if (opened) {
      await sleep(450);
      const confirmed = await runInPage(
        browserWin,
        `(() => {
          const sels = [
            "[class*='chat-title']",
            "[class*='conversation-title']",
            "[class*='base-info']",
            "[class*='geek-info']",
            "[class*='chat-header']",
          ];
          for (const s of sels) {
            const el = document.querySelector(s);
            const t = (el && (el.innerText || el.textContent) || "").trim();
            if (t && t.includes(${JSON.stringify(want)})) return true;
          }
          // Fallback: active panel top area
          const panel = document.querySelector("[class*='conversation-bd'], [class*='chat-conversation']");
          const head = ((panel && panel.innerText) || "").split("\\n").slice(0, 6).join(" ");
          return head.includes(${JSON.stringify(want)});
        })()`,
      );
      if (confirmed) return true;
    }
    await runInPage(browserWin, `window.__openclawBoss.scrollChatList(1)`);
    await sleep(260);
  }
  return false;
}

async function resolveChatTargets({ limit = 5, names = [] } = {}) {
  const browserWin = await getBossWindow();
  const cap = Number(limit) || 5;
  let items = await runInPage(browserWin, `window.__openclawBoss.findChatItems(${Math.max(cap, 40)})`);
  if (Array.isArray(names) && names.length) {
    const set = new Set(names.map((n) => String(n).trim()).filter(Boolean));
    items = (items || []).filter((x) => set.has(String(x.name || "").trim()));
    const found = new Set((items || []).map((x) => x.name));
    // Keep requested names even if not in the current viewport snapshot;
    // openChatByName will scroll to locate them.
    for (const name of set) {
      if (!found.has(name)) items.push({ name, title: "", preview: "" });
    }
  }
  return (items || []).slice(0, Math.max(1, cap));
}

async function autoRequestResumes({ limit = 5, names = [] } = {}) {
  const browserWin = await getBossWindow();
  browserWin.show();
  browserWin.focus();
  const gate = await gateOrFail(browserWin);
  if (!gate.ok) return gate;

  await ensureChatAllTab(browserWin);
  const items = await resolveChatTargets({ limit, names });
  const results = [];
  for (const item of items || []) {
    const opened = await openChatByName(browserWin, item.name);
    await sleep(700);
    if (!opened) {
      results.push({
        name: item.name,
        preview: item.preview,
        requested: false,
        matched: null,
        error: "open_chat_failed",
      });
      continue;
    }
    const req = await runInPage(
      browserWin,
      `window.__openclawBoss.clickByText([/求简历|请求简历|获取简历|要简历/], document)`,
    );
    results.push({
      name: item.name,
      preview: item.preview,
      requested: Boolean(req?.ok),
      matched: req?.matched || null,
      error: req?.ok ? null : "request_control_not_found",
    });
    await sleep(600);
  }

  return {
    ok: true,
    loggedIn: true,
    action: "request_resume",
    count: results.filter((r) => r.requested).length,
    results,
    message:
      results.length === 0
        ? "沟通列表里暂未识别到可操作的会话。请先在 Boss 窗口打开「沟通」。"
        : `已对本机 ${results.length} 个会话尝试「请求简历」，成功点选 ${results.filter((r) => r.requested).length} 个。`,
  };
}

async function autoDownloadResumes({ limit = 5, names = [] } = {}) {
  const browserWin = await getBossWindow();
  browserWin.show();
  browserWin.focus();
  const gate = await gateOrFail(browserWin);
  if (!gate.ok) return gate;

  await ensureChatAllTab(browserWin);
  // Named downloads after a resume was already collected often live under「已获取简历」.
  if (Array.isArray(names) && names.length) {
    await runInPage(browserWin, `window.__openclawBoss.clickGotResumeTab()`);
    await sleep(600);
  }
  const items = await resolveChatTargets({ limit, names });
  const destDir = bossBrowser.desktopResumeDir();
  const { session } = require("electron");
  const results = [];
  for (const item of items || []) {
    const chatUrlBefore = browserWin.webContents.getURL();
    const opened = await openChatByName(browserWin, item.name);
    await sleep(900);
    if (!opened) {
      // One more try from the resume tab (new HR accounts may only list them there).
      await runInPage(browserWin, `window.__openclawBoss.clickGotResumeTab()`);
      await sleep(500);
      const opened2 = await openChatByName(browserWin, item.name);
      await sleep(700);
      if (!opened2) {
        results.push({
          name: item.name,
          downloadedClick: false,
          savedPath: null,
          error: "open_chat_failed",
        });
        continue;
      }
    }

    await runInPage(browserWin, `window.__openclawBoss.clickByText([/^知道了$/], document)`);
    await sleep(200);
    await runInPage(browserWin, `window.__openclawBoss.clickAgreeResumeIfNeeded()`);
    await sleep(500);
    await runInPage(browserWin, `window.__openclawBoss.installPdfHarvestHooks()`);

    bossBrowser.setPendingResumeDownloadLabel(item.name);
    let saved = null;
    const downloadWait = bossBrowser.waitForResumeDownload(28000).then((r) => {
      if (!(saved && saved.ok)) saved = r;
      return r;
    });

    let dl = await runInPage(
      browserWin,
      `window.__openclawBoss.clickByText([/^下载简历$/, /下载附件简历/, /导出简历/, /下载附件/, /^下载$/], document)`,
    );
    let matched = dl?.matched || null;
    let usedUrl = null;
    let capturedMeta = null;

    // Prefer page hooks + native mouse click first (CDP debugger often freezes Boss).
    // Debugger capture is a short fallback only.
    if (!dl?.ok) {
      const harvested = await harvestResumeUrlsDuring(browserWin, async () => {
        // Prefer native mouse click on .card-btn — Boss preview is gesture-sensitive.
        const box = await runInPage(
          browserWin,
          `(() => {
            const b = Array.from(document.querySelectorAll("span.card-btn, .card-btn"))
              .find((el) => /点击预览附件简历|预览附件简历/.test((el.innerText || "").trim()));
            if (!b) return null;
            const r = b.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2, t: (b.innerText || "").trim() };
          })()`,
        );
        if (box && Number.isFinite(box.x) && Number.isFinite(box.y)) {
          sendMouseClick(browserWin, box.x, box.y);
          dl = { ok: true, matched: box.t || "card-btn" };
          matched = dl.matched;
        } else {
          dl = await runInPage(browserWin, `window.__openclawBoss.clickAttachmentPreview()`);
          matched = dl?.matched || matched;
        }
        await sleep(1200);
        await runInPage(browserWin, `window.__openclawBoss.clickAgreeResumeIfNeeded()`);
        await sleep(1500);
        for (let k = 0; k < 10; k++) {
          await sleep(700);
          await runInPage(browserWin, `window.__openclawBoss.clickAgreeResumeIfNeeded()`);
          if (!capturedMeta || !capturedMeta.previewDlDebug) {
            try {
              capturedMeta = {
                ...(capturedMeta || {}),
                previewDlDebug: await runInPage(
                  browserWin,
                  `window.__openclawBoss.dumpPreviewDownloadDebug()`,
                ),
              };
            } catch {
              // ignore
            }
          }
          // Modal toolbar from the right: close / download / copy / fullscreen.
          // Prefer native mouse (with hover) on icon[1]=download; also try icon[2] if needed.
          const toolbar = await runInPage(browserWin, `window.__openclawBoss.listModalToolbarIcons()`);
          if (!capturedMeta) capturedMeta = {};
          capturedMeta.toolbarIcons = toolbar;
          const iconList = Array.isArray(toolbar) ? toolbar : [];
          for (const idx of [1, 2]) {
            const icon = iconList[idx];
            if (!icon || !Number.isFinite(icon.x) || !Number.isFinite(icon.y)) continue;
            sendMouseClick(browserWin, icon.x, icon.y);
            matched = `modal-toolbar-from-right-${idx}`;
            await sleep(800);
            await runInPage(
              browserWin,
              `window.__openclawBoss.clickByText([/^确认$/, /^下载$/, /^确定$/, /^我知道了$/], document)`,
            );
            await sleep(1500);
            if (saved?.ok) break;
          }
          if (!saved?.ok) {
            const dlBox = await runInPage(browserWin, `window.__openclawBoss.findDownloadInPreviewBox()`);
            if (dlBox && Number.isFinite(dlBox.x) && Number.isFinite(dlBox.y)) {
              sendMouseClick(browserWin, dlBox.x, dlBox.y);
              matched = dlBox.via || matched || "preview-download-icon";
              await sleep(1500);
            }
          }
          const blobs = await runInPage(browserWin, `window.__openclawBoss.takePdfHarvest()`);
          const hit = Array.isArray(blobs)
            ? blobs.sort((a, b) => (b.bytes || 0) - (a.bytes || 0))[0]
            : null;
          if (hit?.b64) {
            try {
              const fs = require("node:fs");
              const path = require("node:path");
              const destDir = bossBrowser.desktopResumeDir();
              fs.mkdirSync(destDir, { recursive: true });
              const raw = Buffer.from(hit.b64, "base64");
              const head = raw.slice(0, 8).toString("utf8");
              if (head.startsWith("%PDF") || (raw[0] === 0x50 && raw[1] === 0x4b)) {
                const safeLabel = String(item.name || "候选人")
                  .replace(/[\\/:*?"<>|]/g, "_")
                  .replace(/\s+/g, "")
                  .slice(0, 40);
                const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
                const filename = `${safeLabel}-简历-${stamp}${head.startsWith("%PDF") ? ".pdf" : ".docx"}`;
                const savePath = path.join(destDir, filename);
                fs.writeFileSync(savePath, raw);
                saved = {
                  ok: true,
                  path: savePath,
                  filename,
                  url: hit.url || null,
                  bytes: raw.length,
                };
                usedUrl = hit.url || usedUrl;
                bossBrowser.cancelResumeDownloadWait("saved_via_page_harvest");
                break;
              }
            } catch {
              // ignore
            }
          }
          const meta = await runInPage(browserWin, `window.__openclawBoss.takeResumeJsonHarvest()`);
          if (meta?.json?.length) {
            for (const row of meta.json) {
              try {
                const parsed = JSON.parse(row.text || "");
                const zp = parsed?.zpData || parsed?.data || null;
                if (zp && (zp.encryptResumeId || zp.encryptAuthorityId || zp.encryptGeekId)) {
                  const candidateUrls = bossBrowser.buildResumeCandidateUrls(zp);
                  const fetched = await bossBrowser.fetchResumeBinaryToDesktop(candidateUrls, item.name);
                  if (fetched?.ok && fetched.path) {
                    saved = fetched;
                    usedUrl = fetched.url || usedUrl;
                    bossBrowser.cancelResumeDownloadWait("saved_via_check_ticket");
                    break;
                  }
                  capturedMeta = { zp, tried: fetched?.tried || candidateUrls.slice(0, 8) };
                }
              } catch {
                // ignore
              }
            }
            if (saved?.ok) break;
          }
          for (const href of meta?.urls || []) {
            if (!/^https?:/i.test(href)) continue;
            usedUrl = usedUrl || href;
            try {
              session.fromPartition(bossBrowser.PARTITION).downloadURL(href);
            } catch {
              // ignore
            }
            const fetched = await bossBrowser.fetchResumeBinaryToDesktop([href], item.name);
            if (fetched?.ok && fetched.path) {
              saved = fetched;
              usedUrl = fetched.url || href;
              bossBrowser.cancelResumeDownloadWait("saved_via_harvest_url");
              break;
            }
          }
          if (saved?.ok) break;
          // Do not printToPDF here — that captures chat chrome. Prefer toolbar download + will-download.
        }
        // Short debugger fallback only if hooks missed the binary.
        if (!saved?.ok) {
          const captured = await captureAndSavePdfViaDebugger(
            browserWin,
            item.name,
            async () => {},
            8000,
          );
          capturedMeta = captured || capturedMeta;
          if (captured?.ok && captured.path) {
            saved = captured;
            usedUrl = captured.url || usedUrl;
            bossBrowser.cancelResumeDownloadWait("saved_via_debugger_body");
          } else if (captured?.url) {
            usedUrl = usedUrl || captured.url;
          }
        }
      });
      for (const href of harvested || []) {
        if (!usedUrl) usedUrl = href;
        if (saved?.ok) break;
        if (!/^https?:/i.test(href)) continue;
        try {
          session.fromPartition(bossBrowser.PARTITION).downloadURL(href);
        } catch {
          // ignore
        }
        if (!saved?.ok) {
          const fetched = await bossBrowser.fetchResumeBinaryToDesktop([href], item.name);
          if (fetched?.ok && fetched.path) {
            saved = fetched;
            usedUrl = fetched.url || href;
            bossBrowser.cancelResumeDownloadWait("saved_via_webrequest_url");
          }
        }
      }
    } else {
      const captured = await captureAndSavePdfViaDebugger(browserWin, item.name, async () => {}, 4000);
      if (captured?.ok && captured.path) {
        saved = captured;
        usedUrl = captured.url || null;
        bossBrowser.cancelResumeDownloadWait("saved_via_debugger_body");
      } else if (captured?.url) {
        usedUrl = captured.url;
        try {
          session.fromPartition(bossBrowser.PARTITION).downloadURL(captured.url);
        } catch {
          // ignore
        }
      }
    }

    for (let i = 0; i < 20 && !saved; i++) {
      await sleep(500);
      if (saved) break;
      const inPreviewDl = await runInPage(
        browserWin,
        `window.__openclawBoss.clickDownloadInPreview()`,
      );
      if (inPreviewDl?.ok) matched = inPreviewDl.matched || matched;
      const dlBox = await runInPage(browserWin, `window.__openclawBoss.findDownloadInPreviewBox()`);
      if (dlBox && Number.isFinite(dlBox.x) && Number.isFinite(dlBox.y)) {
        sendMouseClick(browserWin, dlBox.x, dlBox.y);
        matched = dlBox.via || matched || "preview-download-icon";
      }

      // Attachment preview sometimes opens a guest BrowserWindow with a PDF URL.
      try {
        for (const w of BrowserWindow.getAllWindows()) {
          if (!w || w === browserWin || w.isDestroyed()) continue;
          let href = "";
          try {
            href = w.webContents.getURL() || "";
          } catch {
            continue;
          }
          if (!href || /8787|localhost/i.test(href)) continue;
          if (/\.pdf($|\?)/i.test(href)) {
            usedUrl = href;
            try {
              session.fromPartition(bossBrowser.PARTITION).downloadURL(href);
            } catch {
              // ignore
            }
          }
        }
      } catch {
        // ignore
      }
      if (saved?.ok) break;

      const urls = await runInPage(browserWin, `window.__openclawBoss.findPdfLikeUrls()`);
      const href = Array.isArray(urls)
        ? urls.find((u) => /^https?:/i.test(String(u || "")))
        : null;
      if (href && href !== usedUrl) {
        usedUrl = href;
        try {
          session.fromPartition(bossBrowser.PARTITION).downloadURL(href);
        } catch {
          // ignore
        }
        const fetched = await bossBrowser.fetchResumeBinaryToDesktop([href], item.name);
        if (fetched?.ok && fetched.path) {
          saved = fetched;
          usedUrl = fetched.url || href;
          bossBrowser.cancelResumeDownloadWait("saved_via_preview_url");
        }
      }

      const cur = browserWin.webContents.getURL();
      if (
        cur &&
        cur !== chatUrlBefore &&
        (/\.pdf($|\?)/i.test(cur) || /resume|attachment|preview|file/i.test(cur))
      ) {
        if (cur !== usedUrl) {
          usedUrl = cur;
          try {
            session.fromPartition(bossBrowser.PARTITION).downloadURL(cur);
          } catch {
            // ignore
          }
          const fetched = await bossBrowser.fetchResumeBinaryToDesktop([cur], item.name);
          if (fetched?.ok && fetched.path) {
            saved = fetched;
            usedUrl = fetched.url || cur;
            bossBrowser.cancelResumeDownloadWait("saved_via_preview_navigation");
          }
        }
      }
    }

    if (!saved?.ok && usedUrl && /\/preview\/check\.json/i.test(usedUrl)) {
      try {
        const ticket = new URL(usedUrl);
        const geekId = ticket.searchParams.get("geekId");
        const authorityId = ticket.searchParams.get("id");
        if (geekId && authorityId) {
          const urls = bossBrowser.buildResumeCandidateUrls({
            encryptGeekId: geekId,
            encryptAuthorityId: authorityId,
          });
          const binaryUrl = urls.find((url) => /docdownload\.zhipin\.com/i.test(url));
          if (binaryUrl) {
            bossBrowser.cancelResumeDownloadWait("switch_to_direct_binary");
            const direct = await bossBrowser.downloadUrlToDesktop(binaryUrl, item.name);
            usedUrl = binaryUrl;
            if (direct?.ok && direct.path) saved = direct;
          }
          if (!saved?.ok) {
            const fetched = await bossBrowser.fetchResumeBinaryToDesktop(urls, item.name);
            if (fetched?.ok && fetched.path) {
              saved = fetched;
              usedUrl = fetched.url || usedUrl;
              bossBrowser.cancelResumeDownloadWait("saved_via_preview_ticket");
            }
          }
        }
      } catch {
        // Keep the regular download waiter and report a real failure below.
      }
    }

    if (!saved) saved = await downloadWait;
    // Do not navigate to guessed /web/frame preview URLs — they 500 and leave chat.
    // Prefer staying on chat attachment viewer and capturing the real PDF network body.
    try {
      const cur = browserWin.webContents.getURL();
      if (cur && !/\/web\/chat\//i.test(cur)) {
        await browserWin.loadURL(bossBrowser.BOSS_CHAT_URL);
        await sleep(1200);
        await injectHelper(browserWin);
        await ensureChatAllTab(browserWin);
      }
    } catch {
      // ignore
    }

    const profile = await runInPage(browserWin, `window.__openclawBoss.readOpenCandidateProfile()`);
    let savedOk = Boolean(saved?.ok && saved?.path);
    // Do not printToPDF the chat/online panel as a "resume" — that captures UI chrome
    // (~500KB+) and is not the attachment bytes. Prefer toolbar download → will-download.
    // Last-resort: always leave a Desktop text snapshot so HR is not empty-handed
    // when Boss only exposes online preview without a downloadable binary.
    let textSnapshotPath = null;
    if (!savedOk && profile) {
      try {
        const fs = require("node:fs");
        const path = require("node:path");
        const dest = bossBrowser.desktopResumeDir();
        fs.mkdirSync(dest, { recursive: true });
        const safeLabel = String(item.name || "候选人")
          .replace(/[\\/:*?"<>|]/g, "_")
          .replace(/\s+/g, "")
          .slice(0, 40);
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
        const filename = `${safeLabel}-简历摘要-${stamp}.txt`;
        textSnapshotPath = path.join(dest, filename);
        const body = [
          `候选人：${item.name}`,
          `岗位：${profile.title || ""}`,
          `城市：${profile.city || ""}`,
          `经验：${profile.experience || ""}`,
          `学历：${profile.education || ""}`,
          `薪资：${profile.salary || ""}`,
          "",
          "—— 在线资料/沟通摘录 ——",
          profile.pageSnippet || "",
          "",
          profile.chatExcerpt || "",
        ].join("\n");
        fs.writeFileSync(textSnapshotPath, body, "utf8");
      } catch {
        textSnapshotPath = null;
      }
    }
    results.push({
      name: item.name,
      downloadedClick: Boolean(dl?.ok || matched),
      matched: matched || null,
      savedPath: savedOk ? saved.path : textSnapshotPath,
      savedFilename: savedOk
        ? saved.filename
        : textSnapshotPath
          ? require("node:path").basename(textSnapshotPath)
          : null,
      destDir,
      usedUrl,
      previewDlDebug: capturedMeta?.previewDlDebug || null,
      toolbarIcons: capturedMeta?.toolbarIcons || null,
      profile: profile || null,
      resumeText: profile
        ? [
            profile.title,
            profile.city,
            profile.experience,
            profile.education,
            profile.salary,
            profile.pageSnippet,
            profile.chatExcerpt,
          ]
            .filter(Boolean)
            .join("\n")
            .slice(0, 4000)
        : "",
      error: savedOk
        ? null
        : textSnapshotPath
          ? "pdf_unavailable_saved_text_snapshot"
          : saved?.error ||
            (dl?.ok || matched ? "download_not_completed" : "download_control_not_found"),
    });
    await sleep(700);
  }

  const downloadedCount = results.filter((r) => !r.error && r.savedPath).length;
  const snapshotCount = results.filter((r) => r.error === "pdf_unavailable_saved_text_snapshot").length;
  return {
    ok: downloadedCount > 0,
    loggedIn: true,
    action: "download_resume",
    count: downloadedCount,
    snapshotCount,
    destDir,
    results,
    message:
      results.length === 0
        ? "未找到可下载会话。请确认沟通列表里已有同意投递/附件简历的候选人。"
        : downloadedCount > 0
          ? `已下载 ${downloadedCount}/${results.length} 份真实简历到：${destDir}`
          : snapshotCount > 0
            ? `检测到 ${snapshotCount} 位候选人的简历，但真实附件尚未下载成功；仅保存了资料摘要，不能视为简历下载成功：${destDir}`
            : `已尝试下载 ${results.length} 人，但真实简历文件未落到目录（对方可能尚未发来附件简历）：${destDir}`,
  };
}

/**
 * After a candidate replies: request resume, wait briefly, then download to Desktop.
 */
async function requestAndDownloadResumes({ limit = 5, names = [] } = {}) {
  const req = await autoRequestResumes({ limit, names });
  await sleep(2800);
  const dl = await autoDownloadResumes({ limit, names });
  const requested = Number(req?.count) || 0;
  const saved = Number(dl?.count) || 0;
  const destDir = dl?.destDir || bossBrowser.desktopResumeDir();
  const savedLines = (dl?.results || [])
    .filter((r) => r.savedPath)
    .map((r) => `- ${r.name} → ${r.savedFilename || r.savedPath}`);
  const pending = (dl?.results || [])
    .filter((r) => !r.savedPath)
    .map((r) => r.name);
  return {
    ok: requested > 0 || saved > 0,
    loggedIn: true,
    action: "request_and_download_resumes",
    request: req,
    download: dl,
    count: saved,
    results: dl?.results || req?.results || [],
    message: [
      `已对 ${requested} 人请求简历；成功下载 ${saved} 份。`,
      `保存目录：${destDir}`,
      savedLines.length ? `文件：\n${savedLines.join("\n")}` : null,
      pending.length
        ? `尚未落到目录（可能对方还没发附件）：${pending.join("、")}。对方发来后可再说「下载${pending[0]}简历」。`
        : null,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

/** Open named chats and pull profile/resume text for shortlisted people only. */
async function enrichCandidateProfiles({ names = [], limit = 8 } = {}) {
  const browserWin = await getBossWindow();
  browserWin.show();
  browserWin.focus();
  const gate = await gateOrFail(browserWin);
  if (!gate.ok) return gate;

  await ensureChatAllTab(browserWin);
  const items = await resolveChatTargets({
    limit: Math.min(20, Math.max(Number(limit) || 8, names.length || 0)),
    names,
  });
  const candidates = [];
  for (const item of items || []) {
    const opened = await openChatByName(browserWin, item.name);
    await sleep(700);
    if (!opened) continue;
    await runInPage(
      browserWin,
      `window.__openclawBoss.clickByText([/在线简历|查看简历|简历|附件简历|预览简历/], document)`,
    );
    await sleep(600);
    const profile = await runInPage(browserWin, `window.__openclawBoss.readOpenCandidateProfile()`);
    const resumeText = [
      profile?.title,
      profile?.city,
      profile?.experience,
      profile?.education,
      profile?.salary,
      profile?.pageSnippet,
      profile?.chatExcerpt,
    ]
      .filter(Boolean)
      .join("\n")
      .slice(0, 4000);
    candidates.push({
      name: item.name,
      title: profile?.title || item.title || "",
      city: profile?.city || "",
      experience: profile?.experience || "",
      education: profile?.education || "",
      salary: profile?.salary || "",
      chatExcerpt: profile?.chatExcerpt || item.preview || "",
      pageSnippet: profile?.pageSnippet || "",
      resumeText,
    });
  }
  return {
    ok: true,
    loggedIn: true,
    action: "enrich_profiles",
    count: candidates.length,
    candidates,
    message:
      candidates.length === 0
        ? "未能打开择优候选人会话读取简历摘要。"
        : `已为 ${candidates.length} 位择优候选人拉取在线资料/简历摘要。`,
  };
}

async function autoRechat({ message, limit = 5, names = [] } = {}) {
  const text = String(message || "").trim();
  if (!text) {
    return { ok: false, message: "请提供复聊文案，例如：「自动复聊：请问方便本周面试吗？」" };
  }
  const browserWin = await getBossWindow();
  browserWin.show();
  browserWin.focus();
  const gate = await gateOrFail(browserWin);
  if (!gate.ok) return gate;

  await ensureChatAllTab(browserWin);
  const items = await resolveChatTargets({ limit, names });
  const results = [];
  for (const item of items || []) {
    const opened = await openChatByName(browserWin, item.name);
    await sleep(900);
    if (!opened) {
      results.push({
        name: item.name,
        sent: false,
        verified: false,
        error: "open_chat_failed",
      });
      continue;
    }
    const sent = await composeAndSendVerified(browserWin, text);
    await sleep(400);
    const verified = Boolean(
      sent?.verified ||
        (await runInPage(
          browserWin,
          `window.__openclawBoss.lastOutgoingLooksLike(${JSON.stringify(text.slice(0, 40))})`,
        )),
    );
    // Trust only composeAndSendVerified + bubble check; never click-alone.
    const reallySent = Boolean(sent?.ok && verified);
    results.push({
      name: item.name,
      sent: reallySent,
      verified,
      sendClicked: Boolean(sent?.sendClicked),
      inputCleared: Boolean(sent?.inputCleared),
      detail: sent || null,
      error: reallySent ? null : sent?.error || "not_verified_in_chat",
    });
    await sleep(500);
  }

  const okCount = results.filter((r) => r.sent).length;
  const failNames = results.filter((r) => !r.sent).map((r) => r.name);
  return {
    ok: okCount > 0,
    loggedIn: true,
    action: "rechat",
    count: okCount,
    results,
    draft: text,
    message:
      results.length === 0
        ? "沟通列表里找不到要发的人（姓名未匹配到会话）。请先在 Boss「沟通→全部」里确认该人存在。"
        : okCount === results.length
          ? `本机已确认发送 ${okCount}/${results.length} 条（会话里已出现文案，或输入框已清空）。`
          : `本机仅确认发送 ${okCount}/${results.length} 条。失败：${failNames.join("、") || "未知"}（文案可能仍停在输入框，并未进入会话）。请打开 Boss 窗口人工核对。`,
  };
}

async function checkInboxReplies({ limit = 8, names = [] } = {}) {
  const browserWin = await getBossWindow();
  browserWin.show();
  browserWin.focus();
  const gate = await gateOrFail(browserWin);
  if (!gate.ok) return gate;

  await ensureChatAllTab(browserWin);
  let items = await runInPage(browserWin, `window.__openclawBoss.findChatItems(${Number(limit) || 8})`);
  if (Array.isArray(names) && names.length) {
    const set = new Set(names.map((n) => String(n).trim()).filter(Boolean));
    items = (items || []).filter((i) => set.has(i.name) || [...set].some((n) => i.name.includes(n)));
    // Named checks: open via scroll search even if not in first viewport snapshot.
    for (const name of set) {
      if (!(items || []).some((i) => i.name === name)) items.push({ name, preview: "" });
    }
  }
  const results = [];
  for (const item of items || []) {
    const opened = await openChatByName(browserWin, item.name);
    await sleep(900);
    if (!opened) {
      results.push({
        name: item.name,
        preview: "",
        lines: [],
        hasMedia: false,
        replied: false,
        error: "open_chat_failed",
      });
      continue;
    }
    const lines = await runInPage(
      browserWin,
      `window.__openclawBoss.readActiveChatReplies(16)`,
    );
    const preview = Array.isArray(lines) ? lines.slice(-4).join(" / ") : "";
    const hasMedia = /\[图片\]|\[视频\]|http|www\.|\.png|\.jpe?g|\.mp4|作品集|网盘/i.test(
      `${item.preview || ""}\n${preview}`,
    );
    // Do not treat our own outbound asks as "candidate replied".
    const outboundHint =
      /期望薪资|请问方便|本周面试|沟通下这个职位|期待您的回复|我想和您沟通/i;
    const candidateish = (Array.isArray(lines) ? lines : [])
      .map((l) => String(l || "").trim())
      .filter((l) => l.length >= 2 && !outboundHint.test(l) && !/^沟通的职位/.test(l));
    const listPreviewLooksReplied = /\[已读\]|好的|好呀|可以|方便|谢谢|简历|薪资|期望/i.test(
      String(item.preview || ""),
    );
    results.push({
      name: item.name,
      preview: preview || item.preview || "",
      lines: Array.isArray(lines) ? lines.slice(-8) : [],
      hasMedia,
      replied: candidateish.length > 0 || listPreviewLooksReplied,
    });
    await sleep(500);
  }

  const replied = results.filter((r) => r.replied);
  return {
    ok: true,
    loggedIn: true,
    action: "check_inbox_replies",
    count: replied.length,
    results,
    message:
      results.length === 0
        ? "沟通列表为空，无法检查回复。请先在 Boss「沟通」里打开会话。"
        : `本机已检查 ${results.length} 个会话，检测到疑似回复 ${replied.length} 个。${
            replied.length
              ? "\n" +
                replied
                  .map((r) => `- ${r.name}${r.hasMedia ? "（含链接/媒体）" : ""}：${r.preview.slice(0, 80)}`)
                  .join("\n")
              : ""
          }`,
  };
}

/**
 * Pull real candidates from local Boss「沟通」list (not demo seeds).
 * Always drain the virtualized list first (do not drop「今天」people early).
 * Tag each row with dayLabel; prefer today's title matches for shortlist filling.
 */
async function scrapeInboxCandidates({
  limit = 300,
  todayOnly = true,
  jobTitle = "",
  headcount = 5,
} = {}) {
  const browserWin = await getBossWindow();
  browserWin.show();
  browserWin.focus();
  const gate = await gateOrFail(browserWin);
  if (!gate.ok) return gate;

  await runInPage(
    browserWin,
    `window.__openclawBoss.clickByText([/^沟通$/], document)`,
  );
  await sleep(700);
  // Boss chat tabs: 全部 / 新招呼 / 沟通中 … — census must use 全部, not a narrow filter.
  await runInPage(
    browserWin,
    `window.__openclawBoss.clickByText([/^全部$/], document)`,
  );
  await sleep(700);
  await runInPage(
    browserWin,
    `window.__openclawBoss.clickByText([/^全部职位$/, /全部职位/], document)`,
  );
  await sleep(400);

  // Keep a conversational turn bounded. The Boss rail is virtualized and can expose
  // hundreds of historical chats; a full 300-row DOM census can take several minutes.
  const cap = Math.min(150, Math.max(60, Number(limit) || 150));
  const need = Math.max(1, Math.min(20, Number(headcount) || 5));
  const jt = String(jobTitle || "").trim();
  const preferToday = todayOnly !== false;

  await runInPage(
    browserWin,
    `(() => {
      const root = window.__openclawBoss && document.querySelector("[class*='friend-list'], [class*='chat-list'], [class*='geek-list'], [class*='conversation-list']");
      const base = root || document.body;
      base.scrollTop = 0;
      const kids = Array.from(base.querySelectorAll("div")).filter((el) => {
        const r = el.getBoundingClientRect();
        return r.left < 520 && el.scrollHeight > el.clientHeight + 80 && el.clientHeight > 160;
      });
      if (kids.length) {
        kids.sort((a, b) => b.scrollHeight - a.scrollHeight);
        kids[0].scrollTop = 0;
      }
    })()`,
  );
  await sleep(600);

  const byName = new Map();
  let stableRounds = 0;
  let maxProbe = 0;
  const censusDeadline = Date.now() + 45_000;
  for (
    let round = 0;
    round < 55 && byName.size < cap && Date.now() < censusDeadline;
    round++
  ) {
    // Collect everyone visible with dayLabels — never skip past days during scrape.
    const packed = await runInPage(
      browserWin,
      `window.__openclawBoss.findChatItemsPacked(${cap}, false)`,
    );
    const batch = Array.isArray(packed) ? packed : packed?.items || [];
    if (packed && packed.rowProbe) maxProbe = Math.max(maxProbe, packed.rowProbe);
    let added = 0;
    for (const row of batch || []) {
      if (!row?.name || byName.has(row.name)) continue;
      byName.set(row.name, row);
      added += 1;
      if (byName.size >= cap) break;
    }
    if (added === 0) {
      stableRounds += 1;
      if (stableRounds >= 4) break;
    } else {
      stableRounds = 0;
    }
    await runInPage(browserWin, `window.__openclawBoss.scrollChatList(1)`);
    await sleep(300);
  }

  const isPastDay = (day) => {
    const d = String(day || "");
    return (
      /^(昨天|前天)$/.test(d) ||
      /^\d{1,2}月\d{1,2}日$/.test(d) ||
      /^星期/.test(d) ||
      /^周[一二三四五六日天]$/.test(d)
    );
  };
  const isTodayDay = (day) => {
    const d = String(day || "");
    return !d || /今天|今日/.test(d) || !isPastDay(d);
  };

  const titleHit = (row) => {
    const t = String(row?.title || "");
    if (!jt) return Boolean(t);
    if (t.includes(jt) || jt.includes(t.replace(/[（(].*$/, "").trim())) return true;
    if (/智能体/.test(jt) && /智能体/.test(t)) return true;
    if (/开发|工程师/.test(jt) && /开发|工程师/.test(t) && !/剪辑|创作|内容|行政|文员/.test(t)) return true;
    return false;
  };

  let items = [...byName.values()];
  const todayItems = items.filter((x) => isTodayDay(x.dayLabel));
  const pastItems = items.filter((x) => isPastDay(x.dayLabel));
  const todayTitleHits = todayItems.filter(titleHit);
  // If preferToday and today already has enough title hits, keep full today census
  // but still pass past people through for transparency (backend will shortlist).
  // Order: today first, then past — so ranking prefers fresher sessions.
  items = [...todayItems, ...pastItems];
  if (jt) {
    items.sort((a, b) => {
      const dayScore = (x) => (isTodayDay(x.dayLabel) ? 10 : 0);
      const score = (x) => dayScore(x) + (titleHit(x) ? 3 : 0);
      return score(b) - score(a);
    });
  }

  const candidates = [];
  const profileProbeLimit = Math.max(12, need * 2);
  const profileDeadline = Date.now() + 20_000;
  let profileProbeCount = 0;
  for (const item of items) {
    let title = String(item.title || "").trim();
    if (/^(管理|全部|职位)$/.test(title)) title = "";

    // Parse the virtualized row before opening chats. Opening every unknown row can
    // turn a 300-row census into minutes and block the orchestration result.
    if (!title && Array.isArray(item.lines)) {
      title =
        item.lines.find(
          (x) =>
            x &&
            x !== item.name &&
            /工程师|开发|设计|创作|产品|运营|AI|智能体|全栈|Java|剪辑/.test(x) &&
            !/^(管理|全部)$/.test(x),
        ) || "";
    }

    let profile = null;
    if (!title && profileProbeCount < profileProbeLimit && Date.now() < profileDeadline) {
      profileProbeCount += 1;
      await runInPage(browserWin, `window.__openclawBoss.openByName(${JSON.stringify(item.name)})`);
      await sleep(350);
      profile = await runInPage(browserWin, `window.__openclawBoss.readOpenCandidateProfile()`);
      const profileTitle = String((profile && profile.title) || "").trim();
      if (profileTitle && !/^(管理|全部|职位)$/.test(profileTitle)) title = profileTitle;
    }

    candidates.push({
      externalKey: `boss-chat-${Buffer.from(item.name).toString("base64url").slice(0, 24)}`,
      name: item.name,
      title: String(title || "").slice(0, 80),
      city: (profile && profile.city) || "",
      experience: (profile && profile.experience) || "",
      education: (profile && profile.education) || "",
      salary: (profile && profile.salary) || "",
      chatExcerpt: String((profile && profile.chatExcerpt) || "").slice(0, 500),
      pageSnippet: item.preview || "",
      source: "boss_chat",
      jobTitleHint: jobTitle || "",
      dayLabel: item.dayLabel || "",
    });
  }

  const withTitle = candidates.filter((c) => c.title).length;
  const roleHits = candidates.filter(titleHit).length;
  const todayCandidates = candidates.filter((c) => isTodayDay(c.dayLabel));
  const todayRoleHits = todayCandidates.filter(titleHit);
  const expandedBeyondToday = preferToday && todayRoleHits.length < need && pastItems.length > 0;

  const todayCensusLines = todayCandidates
    .slice(0, 40)
    .map((c, i) => `${i + 1}. ${c.name}｜${c.title || "岗位未识别"}｜${c.dayLabel || "今天"}`);
  const todayCensusText =
    todayCandidates.length === 0
      ? "今日沟通识别到 0 人（可能日期头识别失败或今日暂无会话）。"
      : [
          `【今日沟通完整名单 · 未删减】共 ${todayCandidates.length} 人（对口标题 ${todayRoleHits.length}）：`,
          ...todayCensusLines,
          todayCandidates.length > 40 ? `…另有 ${todayCandidates.length - 40} 人未展开` : null,
        ]
          .filter(Boolean)
          .join("\n");

  let scopeNote = `全量滚动拉取 ${candidates.length} 人（今日 ${todayCandidates.length}，更早 ${pastItems.length}；DOM行探针峰值 ${maxProbe}）`;
  if (preferToday) {
    scopeNote +=
      todayRoleHits.length >= need
        ? `；今日对口已够 ${need} 人`
        : `；今日对口仅 ${todayRoleHits.length}/${need}，择优时会用更早沟通补足`;
  }

  return {
    ok: true,
    loggedIn: true,
    action: "scrape_inbox",
    demo: false,
    todayOnly: preferToday,
    expandedBeyondToday,
    count: candidates.length,
    todayCount: todayCandidates.length,
    todayTitleHits: todayRoleHits.length,
    todayCensus: todayCandidates.map((c) => ({
      name: c.name,
      title: c.title,
      dayLabel: c.dayLabel,
    })),
    candidates,
    message: [
      candidates.length === 0
        ? "本机 Boss「沟通」列表未识别到会话。请先打开沟通页并确认有候选人会话后重试。"
        : `已从本机 Boss「沟通」拉取 ${candidates.length} 人（${scopeNote}；识别岗位 ${withTitle}；标题相近 ${roleHits}），正在按目标 ${need} 人择优…`,
      todayCensusText,
    ].join("\n"),
  };
}

/**
 * Use Boss toolbar「约面试」native invite flow (not chat-only draft text).
 * Falls back to verified chat send only if the native form cannot be completed.
 */
async function sendBossInterviewInvite({
  names = [],
  mode = "online",
  time = "",
  place = "",
  draft = "",
  limit = 5,
} = {}) {
  const browserWin = await getBossWindow();
  browserWin.show();
  browserWin.focus();
  const gate = await gateOrFail(browserWin);
  if (!gate.ok) return gate;

  await ensureChatAllTab(browserWin);
  const items = await resolveChatTargets({ limit, names });
  const details = { mode, time, place };
  const results = [];

  for (const item of items || []) {
    const opened = await openChatByName(browserWin, item.name);
    await sleep(800);
    if (!opened) {
      results.push({ name: item.name, ok: false, error: "open_chat_failed" });
      continue;
    }

    await runInPage(browserWin, `window.__openclawBoss.clickByText([/^知道了$/], document)`);
    await sleep(200);

    const entry = await runInPage(browserWin, `window.__openclawBoss.clickBossInterviewEntry()`);
    await sleep(1200);
    let form = null;
    if (entry?.ok) {
      form = await runInPage(
        browserWin,
        `window.__openclawBoss.fillBossInterviewForm(${JSON.stringify(details)})`,
      );
      await sleep(1000);
    }

    const nativeOk = Boolean(entry?.ok && form?.ok && form?.submitted);
    let chatFallback = null;
    if (!nativeOk && draft) {
      chatFallback = await composeAndSendVerified(browserWin, draft);
    }

    results.push({
      name: item.name,
      ok: nativeOk || Boolean(chatFallback?.ok),
      native: nativeOk,
      submitted: Boolean(nativeOk && form?.submitted),
      entry: entry?.matched || null,
      form,
      chatFallback,
      error: nativeOk
        ? null
        : chatFallback?.ok
          ? "native_invite_failed_used_chat_fallback"
          : entry?.ok
            ? "invite_form_incomplete"
            : "invite_entry_not_found",
    });
    await sleep(700);
  }

  const okCount = results.filter((r) => r.ok).length;
  const nativeCount = results.filter((r) => r.native).length;
  return {
    ok: okCount > 0,
    loggedIn: true,
    action: "boss_interview_invite",
    count: okCount,
    nativeCount,
    results,
    message:
      results.length === 0
        ? "未找到可约面试的会话。"
        : nativeCount > 0
          ? `已对本机 ${nativeCount}/${results.length} 人点击 Boss「约面试」并提交邀约表单。`
          : okCount > 0
            ? `Boss「约面试」入口未完成，已用聊天文案兜底发送 ${okCount}/${results.length} 人（请在 Boss 核对是否为正式邀约卡片）。`
            : `约面试失败 ${results.length} 人：请打开 Boss 沟通页确认工具栏有「约面试」。`,
  };
}

module.exports = {
  autoRequestResumes,
  autoDownloadResumes,
  requestAndDownloadResumes,
  autoRechat,
  sendBossInterviewInvite,
  checkInboxReplies,
  scrapeInboxCandidates,
  enrichCandidateProfiles,
};
