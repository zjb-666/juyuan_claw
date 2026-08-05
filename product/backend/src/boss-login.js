import { readFileSync } from "node:fs";
import { dispatchBrowserRequest } from "./browser-node.js";

const BOSS_LOGIN_URL = "https://www.zhipin.com/web/user/";
const BOSS_CHAT_URL = "https://www.zhipin.com/web/chat/index";

async function browserRequest(method, path, body, query = {}) {
  return dispatchBrowserRequest(method, path, body, query);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizePhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!/^1\d{10}$/.test(digits)) throw new Error("invalid_phone");
  return digits;
}

function normalizeSmsCode(code) {
  const digits = String(code || "").replace(/\D/g, "");
  if (digits.length < 4 || digits.length > 8) throw new Error("invalid_sms_code");
  return digits;
}

function classifyPage(href, text) {
  const blob = `${href}\n${text}`;
  const blocked =
    /访问受限|暂时无法访问|暂时被禁止访问|请勿频繁提交刷新|将于\s*\d{4}-\d{2}-\d{2}/i.test(blob) ||
    /\/passport\/zp\/403\.html/i.test(href);
  const captcha =
    !blocked &&
    (/安全验证|点击按钮进行验证|异常访问|请选中下图|请选择所有|geetest|请完成验证/i.test(blob) ||
      /\/passport\/zp\/verify\.html/i.test(href));
  const smsForm =
    !blocked &&
    ((/手机号/.test(blob) && /短信验证码|发送验证码/.test(blob)) ||
      (/\/web\/user\//i.test(href) && /登录\/注册|发送验证码/.test(blob)));
  const smsSent = !blocked && /重新发送|\d+\s*s|秒后|已发送/.test(blob);
  const loggedIn =
    !blocked &&
    !captcha &&
    !/短信验证码|发送验证码|APP扫码登录|安全验证/.test(blob) &&
    (/\/web\/chat\//i.test(href) ||
      /\/web\/geek\//i.test(href) ||
      /消息|职位管理|牛人|沟通|推荐牛人|搜索牛人|简历|工作台/.test(blob));
  return { captcha, smsForm, smsSent, loggedIn, blocked };
}

async function listTabs() {
  const tabs = await browserRequest("GET", "/tabs");
  return Array.isArray(tabs?.tabs) ? tabs.tabs : [];
}

function tabRef(t) {
  return t?.suggestedTargetId || t?.tabId || t?.targetId || null;
}

/** Only return preferred if it still exists — never invent/keep a dead id. */
async function resolveExactTabId(preferred) {
  if (!preferred) return null;
  const list = await listTabs();
  const hit = list.find(
    (t) =>
      t.suggestedTargetId === preferred ||
      t.tabId === preferred ||
      t.targetId === preferred ||
      String(t.targetId || "") === String(preferred),
  );
  return hit ? tabRef(hit) : null;
}

async function findBossTabByUrl(pattern) {
  const list = await listTabs();
  const hit = list.find((t) => pattern.test(String(t.url || "")));
  return hit ? tabRef(hit) : null;
}

async function findActiveBossTab(preferred = null) {
  // Prefer real Boss pages over a preferred tab that went blank after redirect.
  const verify = await findBossTabByUrl(/passport\/zp\/verify/i);
  if (verify) return verify;
  const user = await findBossTabByUrl(/zhipin\.com\/web\/user/i);
  if (user) return user;
  const any = await findBossTabByUrl(/zhipin\.com/i);
  if (any) return any;
  const exact = await resolveExactTabId(preferred);
  if (exact && (await pingTab(exact))) {
    try {
      const page = await readPage(exact);
      if (/zhipin\.com/i.test(page.href)) return exact;
    } catch {
      // ignore
    }
  }
  return null;
}

async function pingTab(targetId) {
  if (!targetId) return false;
  try {
    await browserRequest("POST", "/act", {
      kind: "evaluate",
      targetId,
      fn: "() => true",
    });
    return true;
  } catch (err) {
    const msg = String(err?.message || err || "");
    if (/tab not found/i.test(msg)) return false;
    // Other errors still mean the tab exists.
    return true;
  }
}

function isTabNotFoundError(err) {
  const msg = String(err?.message || err || "");
  return /tab not found|page closed|target closed|session closed/i.test(msg);
}

async function openFreshLoginTab() {
  await browserRequest("POST", "/start", {});
  const list = await listTabs();

  // Prefer navigating a reusable tab (keep one browser session alive).
  // Opening many tabs is flaky under headless Chromium ("Page closed").
  const reusable =
    list.find((t) => /zhipin\.com\/web\/user/i.test(String(t.url || ""))) ||
    list.find((t) => /about:blank/i.test(String(t.url || ""))) ||
    list.find((t) => /passport\/zp\/verify/i.test(String(t.url || ""))) ||
    list[0] ||
    null;

  let targetId = reusable ? tabRef(reusable) : null;
  if (targetId) {
    try {
      await browserRequest("POST", "/navigate", { url: BOSS_LOGIN_URL, targetId });
      for (let i = 0; i < 10; i++) {
        await sleep(800);
        if (!(await pingTab(targetId))) break;
        await ensureViewport(targetId);
        const page = await readPage(targetId);
        const kind = classifyPage(page.href, page.text);
        if (kind.captcha) return targetId;
        if (kind.smsForm || /手机号/.test(page.text) && /发送验证码/.test(page.text)) {
          await ensureSmsLoginForm(targetId);
          return targetId;
        }
        // Still loading / bounced — keep waiting on same tab.
        if (/zhipin\.com/i.test(page.href)) {
          await ensureSmsLoginForm(targetId);
        }
      }
      // Last chance: if tab still alive on zhipin, use it.
      if (await pingTab(targetId)) {
        const page = await readPage(targetId);
        if (/zhipin\.com/i.test(page.href)) {
          await ensureSmsLoginForm(targetId);
          return targetId;
        }
      }
    } catch (err) {
      if (!isTabNotFoundError(err)) {
        // continue to open fallback
      }
      targetId = null;
    }
  }

  const beforeIds = new Set((await listTabs()).map((t) => tabRef(t)).filter(Boolean));
  const opened = await browserRequest("POST", "/tabs/open", { url: BOSS_LOGIN_URL });
  const openedRef =
    opened?.suggestedTargetId || opened?.tabId || opened?.targetId || null;

  for (let i = 0; i < 15; i++) {
    await sleep(i === 0 ? 1200 : 400);
    if (openedRef) {
      const exact = await resolveExactTabId(openedRef);
      if (exact && (await pingTab(exact))) {
        targetId = exact;
        break;
      }
      if (await pingTab(openedRef)) {
        targetId = openedRef;
        break;
      }
    }
    const fresh = (await listTabs()).find((t) => {
      const id = tabRef(t);
      return id && !beforeIds.has(id) && /zhipin\.com/i.test(String(t.url || ""));
    });
    if (fresh) {
      targetId = tabRef(fresh);
      break;
    }
  }

  if (!targetId) {
    throw new Error(
      `boss_tab_open_failed${openedRef ? ` (opened=${openedRef})` : ""}`,
    );
  }

  await ensureViewport(targetId);
  const page0 = await readPage(targetId);
  if (classifyPage(page0.href, page0.text).captcha) return targetId;
  await ensureSmsLoginForm(targetId);
  return targetId;
}

/**
 * Get a live tab for phone login.
 * - Prefer exact preferred id if still alive
 * - Else reuse an open /web/user login tab (not old verify pages)
 * - Else open a fresh one
 */
async function tabLooksLikeBossPage(targetId) {
  try {
    const page = await readPage(targetId);
    return /zhipin\.com/i.test(page.href) && !/^about:/i.test(page.href);
  } catch {
    return false;
  }
}

async function acquireLoginTab(preferred = null, { forceFresh = false } = {}) {
  await browserRequest("POST", "/start", {});
  if (forceFresh) return openFreshLoginTab();

  // Captcha/verify tab wins over a stale preferred id (often about:blank after redirect).
  const verify = await findBossTabByUrl(/passport\/zp\/verify/i);
  if (verify && (await pingTab(verify))) return verify;

  const exact = await resolveExactTabId(preferred);
  if (exact && (await pingTab(exact)) && (await tabLooksLikeBossPage(exact))) {
    return exact;
  }

  const loginTab = await findBossTabByUrl(/zhipin\.com\/web\/user\/?/i);
  if (loginTab && (await pingTab(loginTab))) {
    return loginTab;
  }

  const anyBoss = await findActiveBossTab(preferred);
  if (anyBoss && (await pingTab(anyBoss))) return anyBoss;

  return openFreshLoginTab();
}

/** Run an action; on stale/closed tab, reopen once and retry. */
async function withLiveLoginTab(preferred, fn) {
  let targetId = await acquireLoginTab(preferred);
  try {
    return await fn(targetId);
  } catch (err) {
    if (!isTabNotFoundError(err)) throw err;
    targetId = await acquireLoginTab(null, { forceFresh: true });
    return await fn(targetId);
  }
}

async function resolveBossTabId(preferred) {
  // Back-compat name used by captcha helpers: exact first, then any boss page.
  const exact = await resolveExactTabId(preferred);
  if (exact) return exact;
  return (
    (await findBossTabByUrl(/zhipin\.com\/web\/(chat|geek|boss)/i)) ||
    (await findBossTabByUrl(/passport\/zp\/verify/i)) ||
    (await findBossTabByUrl(/zhipin\.com/i))
  );
}

async function readPage(targetId) {
  const probe = await browserRequest("POST", "/act", {
    kind: "evaluate",
    targetId,
    fn: `() => ({
      href: location.href,
      text: document.body.innerText.slice(0, 1600),
      viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 }
    })`,
  });
  return {
    href: String(probe?.result?.href || ""),
    text: String(probe?.result?.text || ""),
    viewport: probe?.result?.viewport || { w: 1280, h: 720, dpr: 1 },
  };
}

async function takeShot(targetId, opts = {}) {
  const body = { targetId };
  if (opts.element) body.element = opts.element;
  const shot = await browserRequest("POST", "/screenshot", body);
  if (!shot?.path || !existsSync(shot.path)) throw new Error("boss_screenshot_failed");
  const buf = readFileSync(shot.path);
  return {
    imageDataUrl: `data:image/png;base64,${buf.toString("base64")}`,
    url: shot.url || "",
    path: shot.path,
  };
}

/** Tight crop of the GeeTest puzzle — full-page shots often clip tiles off-screen. */
async function takeCaptchaPuzzleShot(targetId) {
  const selectors = [
    ".geetest_holder.geetest_silver",
    ".geetest_holder.geetest_wind",
    ".geetest_panel_box",
  ];
  for (const element of selectors) {
    try {
      const shot = await takeShot(targetId, { element });
      // Reject tiny placeholders (radar bar ~44px tall).
      if (shot.imageDataUrl && shot.imageDataUrl.length > 20_000) return shot;
    } catch {
      // try next selector
    }
  }
  return takeShot(targetId);
}

async function ensureViewport(targetId) {
  try {
    // Tall enough that the 9-tile panel is not clipped by the window chrome.
    await browserRequest("POST", "/act", {
      kind: "resize",
      targetId,
      width: 1280,
      height: 1100,
    });
  } catch {
    // ignore
  }
}

async function inspectCaptcha(targetId) {
  const probe = await browserRequest("POST", "/act", {
    kind: "evaluate",
    targetId,
    fn: `() => {
      document.getElementById("oc-captcha-fix")?.remove();
      const tiles = [...document.querySelectorAll(".geetest_item")].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 40 && r.height > 40;
      });
      const radar = document.querySelector(".geetest_radar_btn, .geetest_btn");
      const puzzleHolder = [...document.querySelectorAll(".geetest_holder")].find((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 200 && r.height > 180;
      }) || [...document.querySelectorAll(".geetest_panel_box, .geetest_window")].find((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 200 && r.height > 180;
      });
      const tipEl = document.querySelector(
        ".geetest_tip_content, .geetest_panel_title, .geetest_ques_tips, .geetest_tip"
      );
      let tip = (tipEl?.innerText || "").trim();
      if (!tip) {
        const m = (document.body.innerText || "").match(/请选中下图中所有的[：:]?\\s*[^\\n]{0,12}/);
        tip = m ? m[0].trim() : "";
      }
      const tipImg = document.querySelector(".geetest_tip_img");
      if (tipImg && /：|:/.test(tip) && tip.length < 20) {
        tip = tip.replace(/[：:]\s*$/, "") + "：（提示栏右侧小图标）";
      }
      const box = puzzleHolder || radar;
      const br = box?.getBoundingClientRect();
      const boxW = Math.max(1, br?.width || 1);
      const boxH = Math.max(1, br?.height || 1);
      const commit = document.querySelector("a.geetest_commit");
      return {
        tileCount: tiles.length,
        hasRadar: Boolean(radar),
        radarText: (radar?.innerText || "").trim().slice(0, 40),
        puzzleVisible: Boolean(puzzleHolder) || tiles.length >= 4,
        tip: tip.slice(0, 80),
        canConfirm: Boolean(commit && !commit.classList.contains("geetest_disable")),
        selectedCount: tiles.filter((el) => /selected|active/i.test(el.className)).length,
        region: br
          ? {
              x: Math.max(0, Math.floor(br.x)),
              y: Math.max(0, Math.floor(br.y)),
              w: Math.ceil(br.width),
              h: Math.ceil(br.height),
            }
          : null,
        tiles: tiles.map((el, i) => {
          const r = el.getBoundingClientRect();
          const cx = r.x + r.width / 2;
          const cy = r.y + r.height / 2;
          return {
            i,
            // Overlay ratios relative to puzzle crop (matches element screenshot).
            xRatio: br ? (cx - br.x) / boxW : 0,
            yRatio: br ? (cy - br.y) / boxH : 0,
            // Absolute CSS pixels for clickCoords.
            cx: Math.round(cx),
            cy: Math.round(cy),
            selected: /selected|active/i.test(el.className),
          };
        }),
      };
    }`,
  });
  return (
    probe?.result || {
      tileCount: 0,
      hasRadar: false,
      puzzleVisible: false,
      tip: "",
      region: null,
      tiles: [],
      canConfirm: false,
      selectedCount: 0,
    }
  );
}

async function scrollPuzzleIntoView(targetId) {
  await browserRequest("POST", "/act", {
    kind: "evaluate",
    targetId,
    fn: `() => {
      document.getElementById("oc-captcha-fix")?.remove();
      const holder = [...document.querySelectorAll(".geetest_holder")].find((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 200 && r.height > 180;
      });
      if (!holder) return false;
      // Keep puzzle in the upper half so viewport screenshots / clicks stay reliable.
      holder.scrollIntoView({ block: "center", inline: "center" });
      const r = holder.getBoundingClientRect();
      if (r.bottom > window.innerHeight - 20 || r.top < 10) {
        window.scrollBy(0, r.top - 40);
      }
      return true;
    }`,
  });
}

async function expandCaptchaPuzzle(targetId) {
  await ensureViewport(targetId);
  const before = await inspectCaptcha(targetId);
  if (before.puzzleVisible && before.tileCount >= 4) {
    await scrollPuzzleIntoView(targetId);
    return { expanded: true, already: true, ...(await inspectCaptcha(targetId)) };
  }

  await browserRequest("POST", "/act", {
    kind: "evaluate",
    targetId,
    fn: `() => {
      const radar = document.querySelector(".geetest_radar_btn, .geetest_btn");
      if (!radar) return "no_radar";
      radar.scrollIntoView({ block: "center", inline: "center" });
      radar.click();
      return "clicked";
    }`,
  });

  for (let i = 0; i < 10; i++) {
    await sleep(600);
    const cur = await inspectCaptcha(targetId);
    if (cur.puzzleVisible && cur.tileCount >= 4) {
      await scrollPuzzleIntoView(targetId);
      return { expanded: true, already: false, ...(await inspectCaptcha(targetId)) };
    }
  }
  return { expanded: false, already: false, ...(await inspectCaptcha(targetId)) };
}

async function prepareCaptchaView(targetId) {
  await ensureViewport(targetId);
  return expandCaptchaPuzzle(targetId);
}

async function ensureSmsLoginForm(targetId) {
  try {
    await browserRequest("POST", "/act", {
      kind: "evaluate",
      targetId,
      fn: `() => {
        const phone = document.querySelector('input[type="tel"], input[placeholder*="手机"]');
        if (phone && phone.getBoundingClientRect().width > 0) return "phone_ready";
        const smsTab = [...document.querySelectorAll("a, li, span, div, button")].find((el) => {
          const t = (el.innerText || "").trim();
          return t === "验证码登录/注册" || t === "验证码登录" || t === "短信登录";
        });
        if (smsTab) {
          smsTab.click();
          return "clicked_sms_tab";
        }
        return "no_phone";
      }`,
    });
    await sleep(800);
  } catch (err) {
    if (isTabNotFoundError(err)) throw err;
    // Non-fatal: page may be mid-navigation.
  }
}

async function captureState(targetId) {
  const page = await readPage(targetId);
  const kind = classifyPage(page.href, page.text);
  let captchaPhase = "none";
  let captchaTip = "";
  let captchaRegion = null;
  let tileCount = 0;
  let tiles = [];
  let canConfirm = false;
  let selectedCount = 0;
  if (kind.captcha) {
    const info = await inspectCaptcha(targetId);
    captchaTip = info.tip || "";
    captchaRegion = info.region;
    tileCount = info.tileCount || 0;
    tiles = info.tiles || [];
    canConfirm = Boolean(info.canConfirm);
    selectedCount = info.selectedCount || 0;
    captchaPhase = info.puzzleVisible && info.tileCount >= 4 ? "puzzle" : "gate";
  }
  const shot =
    kind.captcha && captchaPhase === "puzzle"
      ? await takeCaptchaPuzzleShot(targetId)
      : kind.blocked || kind.captcha
        ? await takeShot(targetId)
        : await takeShot(targetId);
  const stage = kind.loggedIn
    ? "logged_in"
    : kind.blocked
      ? "blocked"
      : kind.captcha
        ? "captcha"
        : kind.smsSent
          ? "await_sms"
          : kind.smsForm
            ? "phone"
            : "unknown";
  return {
    targetId,
    ...page,
    ...shot,
    ...kind,
    stage,
    captchaPhase,
    captchaTip,
    captchaRegion,
    tileCount,
    tiles,
    canConfirm,
    selectedCount,
    pageTextPreview: page.text.slice(0, 200),
  };
}

function buildInstruction(state) {
  if (state.loggedIn || state.stage === "logged_in") {
    return "Boss 已登录，可进入下一步选择工作方式。";
  }
  if (state.blocked || state.stage === "blocked") {
    const until = String(state.text || state.pageTextPreview || "").match(
      /将于\s*(\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2})/,
    );
    const when = until?.[1] ? `约到 ${until[1]}` : "到页面提示的恢复时间";
    return `Boss 已临时限制当前网络访问（访问受限）。请勿再点刷新/发送验证码。可换网络或等待${when}后再试。`;
  }
  if (state.captcha || state.stage === "captcha") {
    if (state.captchaPhase === "puzzle") {
      const tip = state.captchaTip || "请选中下图中所有对应图块";
      const sel = state.selectedCount ? `（已选 ${state.selectedCount}）` : "";
      return `${tip}${sel}。在上方验证图上点选图块，选完后点「确认验证」。`;
    }
    return "需要安全验证。请点「展开验证码」。";
  }
  if (state.stage === "await_sms" || state.smsSent) {
    return "验证码已发送。请填写短信验证码，再点「登录」。";
  }
  return "请输入手机号，点「发送验证码」。";
}

function toLoginPayload(state, extra = {}) {
  const captcha = Boolean(state.captcha);
  const blocked = Boolean(state.blocked || state.stage === "blocked");
  const forceImage = Boolean(extra.forceImage || captcha || blocked);
  const { forceImage: _drop, ...restExtra } = extra;
  return {
    loggedIn: Boolean(state.loggedIn || state.stage === "logged_in"),
    stage: state.stage || "unknown",
    captcha,
    blocked,
    smsForm: Boolean(state.smsForm),
    smsSent: Boolean(state.smsSent),
    captchaPhase: state.captchaPhase || (captcha ? "gate" : "none"),
    captchaTip: state.captchaTip || "",
    captchaRegion: state.captchaRegion || null,
    tileCount: state.tileCount || 0,
    tiles: state.tiles || [],
    canConfirm: Boolean(state.canConfirm),
    selectedCount: state.selectedCount || 0,
    interactive: captcha,
    targetId: state.targetId,
    url: state.url || state.href,
    imageDataUrl: forceImage ? state.imageDataUrl : null,
    instruction: buildInstruction(state),
    message: buildInstruction(state),
    ...restExtra,
  };
}

async function openLoginTab(preferredTargetId = null, { fresh = false } = {}) {
  return acquireLoginTab(preferredTargetId, { forceFresh: fresh });
}

/**
 * Open Boss phone/SMS login page (no QR).
 */
export async function startBossPhoneLogin(preferredTargetId = null, { restart = false } = {}) {
  const targetId = await acquireLoginTab(preferredTargetId, { forceFresh: restart });
  const page = await readPage(targetId);
  const kind = classifyPage(page.href, page.text);
  if (kind.blocked) {
    const state = await captureState(targetId);
    return toLoginPayload(state, { forceImage: true });
  }
  if (kind.captcha) await prepareCaptchaView(targetId);
  const state = await captureState(targetId);
  return toLoginPayload(state, {
    forceImage: Boolean(state.captcha || state.blocked),
  });
}

/** @deprecated use startBossPhoneLogin */
export async function startBossLoginQr(preferredTargetId = null) {
  return startBossPhoneLogin(preferredTargetId, { restart: true });
}

/**
 * Fill phone + click「发送验证码」. May return captcha stage.
 * Self-healing: stale tab ids are discarded and a fresh login tab is opened.
 */
async function fillPhoneAndClickSend(targetId, phoneNum) {
  return browserRequest("POST", "/act", {
    kind: "evaluate",
    targetId,
    fn: `() => {
      const phone = document.querySelector('input[type="tel"], input[placeholder*="手机"]');
      const agree = document.querySelector('input.agree-policy, input[type="checkbox"]');
      const btn = document.querySelector(".btn-sms");
      if (!phone || !btn) {
        return {
          ok: false,
          reason: "form_missing",
          href: location.href,
          text: (document.body.innerText || "").slice(0, 120),
        };
      }
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      phone.focus();
      setter.call(phone, ${JSON.stringify(phoneNum)});
      phone.dispatchEvent(new Event("input", { bubbles: true }));
      phone.dispatchEvent(new Event("change", { bubbles: true }));
      phone.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
      if (agree && !agree.checked) agree.click();
      btn.click();
      return { ok: true, phone: phone.value, agreed: Boolean(agree?.checked), href: location.href };
    }`,
  });
}

/**
 * Fill phone + click「发送验证码」. May return captcha stage.
 * Self-healing: stale tab ids are discarded; always land on a live login/captcha page.
 */
export async function sendBossLoginSms({ targetId: preferred, phone }) {
  const phoneNum = normalizePhone(phone);

  // If preferred tab is mid-captcha, keep solving it first.
  const exact = await resolveExactTabId(preferred);
  if (exact && (await pingTab(exact))) {
    try {
      const page = await readPage(exact);
      const kind = classifyPage(page.href, page.text);
      if (kind.captcha && !kind.smsForm) {
        await prepareCaptchaView(exact);
        const state = await captureState(exact);
        return toLoginPayload(state, {
          phone: phoneNum,
          forceImage: true,
          sendOk: false,
          message: "发送验证码前需要先完成安全验证，请先点选下方图块。",
        });
      }
    } catch (err) {
      if (!isTabNotFoundError(err)) throw err;
    }
  }

  // Always prefer an existing usable Boss tab; forceFresh only when nothing usable.
  let targetId = null;
  const exactAlive = exact && (await pingTab(exact)) ? exact : null;
  if (exactAlive) {
    const page = await readPage(exactAlive).catch(() => null);
    if (page) {
      const kind = classifyPage(page.href, page.text);
      if (kind.blocked) {
        const state = await captureState(exactAlive);
        return toLoginPayload(state, {
          phone: phoneNum,
          forceImage: true,
          sendOk: false,
          message: buildInstruction(state),
        });
      }
      if (kind.smsForm || kind.captcha) targetId = exactAlive;
    }
  }
  if (!targetId) {
    const active = await findActiveBossTab(null);
    if (active && (await pingTab(active))) {
      const page = await readPage(active).catch(() => null);
      const kind = page ? classifyPage(page.href, page.text) : {};
      if (kind.blocked) {
        const state = await captureState(active);
        return toLoginPayload(state, {
          phone: phoneNum,
          forceImage: true,
          sendOk: false,
          message: buildInstruction(state),
        });
      }
      if (kind.smsForm || kind.captcha || /zhipin\.com\/web\/user/i.test(page?.href || "")) {
        targetId = active;
      }
    }
  }
  if (!targetId) {
    targetId = await acquireLoginTab(null, { forceFresh: true });
  }

  // Bail out before filling if we landed on the ban page.
  {
    const page = await readPage(targetId);
    const kind = classifyPage(page.href, page.text);
    if (kind.blocked) {
      const state = await captureState(targetId);
      return toLoginPayload(state, {
        phone: phoneNum,
        forceImage: true,
        sendOk: false,
        message: buildInstruction(state),
      });
    }
    if (kind.captcha && !kind.smsForm) {
      await prepareCaptchaView(targetId);
      const state = await captureState(targetId);
      return toLoginPayload(state, {
        phone: phoneNum,
        forceImage: true,
        sendOk: false,
        message: "发送验证码前需要先完成安全验证，请先点选下方图块。",
      });
    }
  }

  let fill = await fillPhoneAndClickSend(targetId, phoneNum);
  if (!fill?.result?.ok) {
    targetId = await acquireLoginTab(null, { forceFresh: true });
    const page = await readPage(targetId);
    if (classifyPage(page.href, page.text).blocked) {
      const state = await captureState(targetId);
      return toLoginPayload(state, {
        phone: phoneNum,
        forceImage: true,
        sendOk: false,
        message: buildInstruction(state),
      });
    }
    fill = await fillPhoneAndClickSend(targetId, phoneNum);
  }
  if (!fill?.result?.ok) {
    throw new Error(fill?.result?.reason || "send_sms_failed");
  }

  for (let i = 0; i < 8; i++) {
    await sleep(1000);
    // After send-sms, Boss often redirects into another tab (verify.html).
    // Never stick to a preferred tab that became about:blank.
    const live = await findActiveBossTab(targetId);
    if (live) targetId = live;
    if (!(await pingTab(targetId))) continue;

    let page;
    try {
      page = await readPage(targetId);
    } catch (err) {
      if (isTabNotFoundError(err)) continue;
      throw err;
    }
    if (/about:blank/i.test(page.href)) continue;

    const kind = classifyPage(page.href, page.text);
    if (kind.captcha) {
      await prepareCaptchaView(targetId);
      const state = await captureState(targetId);
      return toLoginPayload(state, { phone: phoneNum, forceImage: true, sendOk: false });
    }
    if (kind.smsSent) {
      const state = await captureState(targetId);
      return toLoginPayload(state, { phone: phoneNum, sendOk: true });
    }
    if (kind.loggedIn) {
      const state = await captureState(targetId);
      return toLoginPayload(state, { phone: phoneNum, sendOk: true });
    }
  }

  const live = (await findActiveBossTab(targetId)) || targetId;
  if (!(await pingTab(live))) throw new Error("send_sms_page_lost");
  const state = await captureState(live);
  if (/about:blank/i.test(state.href || state.url || "")) {
    throw new Error("send_sms_page_lost");
  }
  if (!state.captcha && !state.smsForm && !state.smsSent && !state.loggedIn) {
    // Still return captcha screenshot attempt if verify text present.
    if (/安全验证|异常访问/i.test(state.pageTextPreview || state.text || "")) {
      await prepareCaptchaView(live);
      const again = await captureState(live);
      return toLoginPayload(again, { phone: phoneNum, forceImage: true, sendOk: false });
    }
    throw new Error("send_sms_page_lost");
  }
  return toLoginPayload(state, {
    phone: phoneNum,
    sendOk: Boolean(state.smsSent || state.stage === "await_sms"),
    forceImage: Boolean(state.captcha),
  });
}

/**
 * Fill SMS code and click 登录/注册.
 */
export async function submitBossLoginSms({ targetId: preferred, code, phone = null }) {
  const smsCode = normalizeSmsCode(code);

  return withLiveLoginTab(preferred, async (initialId) => {
    let targetId = initialId;
    await ensureViewport(targetId);

    const page0 = await readPage(targetId);
    if (classifyPage(page0.href, page0.text).captcha) {
      await prepareCaptchaView(targetId);
      const state = await captureState(targetId);
      return toLoginPayload(state, {
        forceImage: true,
        submitOk: false,
        message: "仍在安全验证页，请先完成点选验证再提交短信码。",
      });
    }

    // Need SMS form; if not present, reopen login.
    await ensureSmsLoginForm(targetId);
    let page = await readPage(targetId);
    if (!classifyPage(page.href, page.text).smsForm && !/短信验证码|发送验证码/.test(page.text)) {
      targetId = await acquireLoginTab(null, { forceFresh: true });
    }

    if (phone) {
      try {
        const phoneNum = normalizePhone(phone);
        await browserRequest("POST", "/act", {
          kind: "evaluate",
          targetId,
          fn: `() => {
            const phone = document.querySelector('input[type="tel"], input[placeholder*="手机"]');
            if (!phone) return false;
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
            setter.call(phone, ${JSON.stringify(phoneNum)});
            phone.dispatchEvent(new Event("input", { bubbles: true }));
            return true;
          }`,
        });
      } catch {
        // optional
      }
    }

    const submit = await browserRequest("POST", "/act", {
      kind: "evaluate",
      targetId,
      fn: `() => {
        const codeInput = document.querySelector('input[placeholder*="验证码"], .sms-input-wrapper input, input[type="text"]');
        const agree = document.querySelector('input.agree-policy, input[type="checkbox"]');
        const btn = document.querySelector("button.sure-btn, .sms-form-btn button, button[type=submit]");
        if (!codeInput || !btn) return { ok: false, reason: "form_missing" };
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        codeInput.focus();
        setter.call(codeInput, ${JSON.stringify(smsCode)});
        codeInput.dispatchEvent(new Event("input", { bubbles: true }));
        codeInput.dispatchEvent(new Event("change", { bubbles: true }));
        if (agree && !agree.checked) agree.click();
        btn.click();
        return { ok: true };
      }`,
    });
    if (!submit?.result?.ok) throw new Error(submit?.result?.reason || "submit_sms_failed");

    for (let i = 0; i < 8; i++) {
      await sleep(1500);
      const live = (await resolveExactTabId(targetId)) || (await resolveBossTabId(null));
      if (live) targetId = live;
      page = await readPage(targetId);
      const kind = classifyPage(page.href, page.text);
      if (kind.loggedIn) {
        const state = await captureState(targetId);
        return toLoginPayload(state, { submitOk: true });
      }
      if (kind.captcha) {
        await prepareCaptchaView(targetId);
        const state = await captureState(targetId);
        return toLoginPayload(state, { forceImage: true, submitOk: false });
      }
    }

    const state = await captureState(targetId);
    return toLoginPayload(state, {
      submitOk: Boolean(state.loggedIn),
      forceImage: Boolean(state.captcha),
      message: state.loggedIn
        ? "Boss 登录成功。"
        : "已提交验证码，但尚未进入工作台。请核对验证码，或点「复查登录态」。",
    });
  });
}

export async function expandBossLoginCaptcha(preferredTargetId = null) {
  return withLiveLoginTab(preferredTargetId, async (targetId) => {
    const prep = await prepareCaptchaView(targetId);
    const live = (await resolveExactTabId(targetId)) || targetId;
    const state = await captureState(live);
    return toLoginPayload(state, {
      expanded: Boolean(prep.expanded),
      tileCount: prep.tileCount || state.tileCount || 0,
      forceImage: true,
    });
  });
}

/**
 * Click a captcha tile. Prefer tileIndex; otherwise snap xRatio/yRatio to nearest tile.
 */
export async function clickBossLoginImage(params) {
  const { targetId: preferred, xRatio, yRatio, tileIndex } = params;

  return withLiveLoginTab(preferred, async (targetId) => {
    const info = await inspectCaptcha(targetId);
    if (!info.puzzleVisible || !info.tiles?.length) {
      await expandCaptchaPuzzle(targetId);
    }
    const latest = await inspectCaptcha(targetId);
    const tiles = latest.tiles || [];
    if (!tiles.length) {
      const state = await captureState(targetId);
      return toLoginPayload(state, {
        forceImage: true,
        message: "还没展开图块，请先点「展开验证码」。",
      });
    }

    let tile = null;
    if (Number.isInteger(tileIndex) && tileIndex >= 0 && tileIndex < tiles.length) {
      tile = tiles[tileIndex];
    } else if (typeof xRatio === "number" && typeof yRatio === "number") {
      const xr = Math.min(1, Math.max(0, xRatio));
      const yr = Math.min(1, Math.max(0, yRatio));
      tile = tiles.reduce((best, t) => {
        const d = (t.xRatio - xr) ** 2 + (t.yRatio - yr) ** 2;
        if (!best || d < best.d) return { ...t, d };
        return best;
      }, null);
    } else {
      throw new Error("click_target_required");
    }

    const x = Number.isFinite(tile.cx)
      ? tile.cx
      : Math.max(0, Math.round((await readPage(targetId)).viewport.w * tile.xRatio));
    const y = Number.isFinite(tile.cy)
      ? tile.cy
      : Math.max(0, Math.round((await readPage(targetId)).viewport.h * tile.yRatio));

    // Single precise click on tile center — double-firing toggles selection off.
    await browserRequest("POST", "/act", {
      kind: "clickCoords",
      targetId,
      x,
      y,
    });
    await sleep(500);

    const live = (await resolveExactTabId(targetId)) || (await findActiveBossTab(targetId)) || targetId;
    const state = await captureState(live);
    return toLoginPayload(state, {
      clicked: { tileIndex: tile.i, x, y, xRatio: tile.xRatio, yRatio: tile.yRatio },
      forceImage: Boolean(state.captcha),
    });
  });
}

/** Click GeeTest 「确认」 after tiles are selected. */
export async function confirmBossCaptcha(preferredTargetId = null) {
  return withLiveLoginTab(preferredTargetId, async (targetId) => {
    const clicked = await browserRequest("POST", "/act", {
      kind: "evaluate",
      targetId,
      fn: `() => {
        const btn = document.querySelector("a.geetest_commit");
        if (!btn) return "missing";
        if (btn.classList.contains("geetest_disable")) return "disabled";
        btn.click();
        return "ok";
      }`,
    });
    await sleep(2000);
    const live = (await resolveExactTabId(targetId)) || (await findActiveBossTab(targetId)) || targetId;
    const state = await captureState(live);
    const result = clicked?.result;
    return toLoginPayload(state, {
      forceImage: Boolean(state.captcha),
      confirmResult: result,
      message:
        result === "disabled"
          ? "请先点选图块，再点「确认验证」。"
          : result === "ok" && !state.captcha
            ? "安全验证已通过，请填写短信验证码后登录。"
            : buildInstruction(state),
    });
  });
}

function visionConfig() {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const baseUrl = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const model = process.env.MODEL_ID || process.env.OPENAI_VISION_MODEL || "gpt-4o";
  if (!apiKey) return null;
  return { apiKey, baseUrl, model };
}

async function pickTilesWithVision(imageDataUrl, tipText) {
  const cfg = visionConfig();
  if (!cfg) throw new Error("vision_api_not_configured");

  // Avoid “验证码/破解” wording — some models refuse those prompts even for benign tile picking.
  const prompts = [
    `看这张图：顶部文字旁有一个小图标（提示：${tipText || "同类物品"}），下面是 3x3 共 9 张照片。
编号 0-8（从左到右、从上到下）：
0 1 2
3 4 5
6 7 8
请指出哪几张照片与顶部小图标是同一类物品。
只输出 JSON：{"indices":[数字,...],"target":"物品名"}`,
    `Image grid quiz. The small icon near the top text is the category (${tipText || "same object class"}).
Which of the 9 photos match? Indices 0-8 left-to-right, top-to-bottom.
Reply JSON only: {"indices":[...],"target":"..."}`,
  ];

  let lastErr = "vision_no_tiles";
  for (const prompt of prompts) {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: imageDataUrl } },
            ],
          },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      lastErr = `vision_http_${res.status}:${body.slice(0, 120)}`;
      continue;
    }
    const json = await res.json();
    const text = String(json?.choices?.[0]?.message?.content || "");
    if (/不能帮助|无法协助|不能识别|won't help|cannot help|拒绝/i.test(text) && !/\{/.test(text)) {
      lastErr = "vision_refused";
      continue;
    }
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      lastErr = "vision_parse_failed";
      continue;
    }
    try {
      const parsed = JSON.parse(match[0]);
      const indices = (Array.isArray(parsed.indices) ? parsed.indices : [])
        .map((n) => Number(n))
        .filter((n) => Number.isInteger(n) && n >= 0 && n <= 8);
      if (!indices.length) {
        lastErr = "vision_no_tiles";
        continue;
      }
      return { indices: [...new Set(indices)], target: String(parsed.target || "") };
    } catch {
      lastErr = "vision_parse_failed";
    }
  }
  throw new Error(lastErr);
}

/**
 * Auto-solve GeeTest icon captcha with vision model, then confirm.
 */
export async function autoSolveBossCaptcha(preferredTargetId = null) {
  let targetId = await acquireLoginTab(preferredTargetId);
  await prepareCaptchaView(targetId);
  targetId = (await resolveExactTabId(targetId)) || (await findActiveBossTab(targetId)) || targetId;

  let state = await captureState(targetId);
  if (state.blocked) {
    return toLoginPayload(state, {
      forceImage: true,
      autoSolved: false,
      message: buildInstruction(state),
    });
  }
  if (!state.captcha || state.captchaPhase !== "puzzle" || !state.imageDataUrl) {
    return toLoginPayload(state, {
      forceImage: Boolean(state.captcha || state.blocked),
      autoSolved: false,
      message: state.blocked
        ? buildInstruction(state)
        : "当前没有可点选的图块。请先点「发送验证码」；若已弹出验证，点「刷新画面」。",
    });
  }

  let picked;
  try {
    picked = await pickTilesWithVision(state.imageDataUrl, state.captchaTip);
  } catch (err) {
    // Keep puzzle screenshot so user can click manually — do not refresh (triggers IP bans).
    return toLoginPayload(state, {
      forceImage: true,
      autoSolved: false,
      message: `自动识别未成功（${err.message}）。请直接点上方蓝框图块，再点「确认验证」。`,
    });
  }

  const tiles = (await inspectCaptcha(targetId)).tiles || [];
  let clicked = 0;
  for (const idx of picked.indices) {
    const tile = tiles.find((t) => t.i === idx) || tiles[idx];
    if (!tile || !Number.isFinite(tile.cx) || !Number.isFinite(tile.cy)) continue;
    await browserRequest("POST", "/act", {
      kind: "clickCoords",
      targetId,
      x: tile.cx,
      y: tile.cy,
    });
    clicked += 1;
    await sleep(450);
  }
  await sleep(400);

  if (!clicked) {
    return toLoginPayload(await captureState(targetId), {
      forceImage: true,
      autoSolved: false,
      pickedIndices: picked.indices,
      pickedTarget: picked.target,
      message: `已识别目标「${picked.target || "?"}」为图块 [${picked.indices.join(",")}]，但点击未生效。请手动点选蓝框后确认。`,
    });
  }

  const confirm = await browserRequest("POST", "/act", {
    kind: "evaluate",
    targetId,
    fn: `() => {
      const btn = document.querySelector("a.geetest_commit");
      if (!btn) return "missing";
      if (btn.classList.contains("geetest_disable")) return "disabled";
      btn.click();
      return "ok";
    }`,
  });
  await sleep(2800);

  targetId = (await findActiveBossTab(targetId)) || targetId;
  state = await captureState(targetId);
  if (state.blocked) {
    return toLoginPayload(state, {
      forceImage: true,
      autoSolved: false,
      pickedIndices: picked.indices,
      pickedTarget: picked.target,
      message: buildInstruction(state),
    });
  }
  const ok = !state.captcha || /验证成功/.test(state.text || state.pageTextPreview || "");
  return toLoginPayload(state, {
    forceImage: Boolean(state.captcha),
    autoSolved: ok,
    pickedIndices: picked.indices,
    pickedTarget: picked.target,
    confirmResult: confirm?.result,
    message: ok
      ? `已自动选中「${picked.target || "目标图块"}」并确认。请继续填写短信验证码（若未收到可再点发送验证码）。`
      : `已点击图块 [${picked.indices.join(",")}]（${picked.target || "目标"}），但尚未通过。请改手动点选后确认，勿连续刷新。`,
  });
}

export async function refreshBossLoginView(preferredTargetId = null) {
  return withLiveLoginTab(preferredTargetId, async (targetId) => {
    await ensureViewport(targetId);
    const page = await readPage(targetId);
    const kind = classifyPage(page.href, page.text);
    if (kind.captcha) await prepareCaptchaView(targetId);
    else if (kind.smsForm) await ensureSmsLoginForm(targetId);
    const state = await captureState(targetId);
    return toLoginPayload(state, { forceImage: Boolean(state.captcha) });
  });
}

export async function checkBossLoginStatus(targetId) {
  await browserRequest("POST", "/start", {});
  let tid = await resolveBossTabId(targetId || null);

  for (let i = 0; i < 8; i++) {
    if (!tid) break;
    try {
      const page = await readPage(tid);
      const kind = classifyPage(page.href, page.text);
      if (kind.loggedIn) {
        return {
          loggedIn: true,
          stage: "logged_in",
          targetId: tid,
          url: page.href,
          pageTextPreview: page.text.slice(0, 200),
          message: "Boss 登录态：有效，可以进入下一步。",
        };
      }
      if (kind.blocked) {
        const state = await captureState(tid);
        return {
          ...toLoginPayload(state, { forceImage: true }),
          loggedIn: false,
          message: buildInstruction(state),
        };
      }
      if (kind.captcha) {
        await prepareCaptchaView(tid);
        const state = await captureState(tid);
        return {
          ...toLoginPayload(state, { forceImage: true }),
          message:
            "托管浏览器仍停在安全验证页。请你在可见浏览器里自己完成验证后，再点「检验登录态」。",
        };
      }
      if (kind.smsForm || kind.smsSent) {
        const state = await captureState(tid);
        return {
          ...toLoginPayload(state, { forceImage: true }),
          loggedIn: false,
          message:
            "尚未登录成功。请你在托管浏览器里自行完成手机号/验证码登录，再点「检验登录态」。我们不会代填。",
        };
      }
      if (i < 3) {
        await sleep(1500);
        tid = (await resolveBossTabId(tid)) || tid;
        continue;
      }
      break;
    } catch {
      tid = await resolveBossTabId(null);
      await sleep(800);
    }
  }

  try {
    if (tid) {
      await browserRequest("POST", "/navigate", { url: BOSS_CHAT_URL, targetId: tid });
    } else {
      const opened = await browserRequest("POST", "/tabs/open", { url: BOSS_CHAT_URL });
      tid = await resolveBossTabId(opened.suggestedTargetId || opened.tabId || opened.targetId);
    }
    await sleep(3000);
  } catch {
    const opened = await browserRequest("POST", "/tabs/open", { url: BOSS_CHAT_URL });
    tid = await resolveBossTabId(opened.suggestedTargetId || opened.tabId || opened.targetId);
    await sleep(3000);
  }

  tid = (await resolveBossTabId(tid)) || tid;
  if (!tid) {
    return {
      loggedIn: false,
      stage: "unknown",
      message: "未找到 Boss 页面。请先点「打开登录页」，在浏览器完成登录后再检验。",
    };
  }

  const page = await readPage(tid);
  const kind = classifyPage(page.href, page.text);
  if (kind.loggedIn) {
    return {
      loggedIn: true,
      stage: "logged_in",
      targetId: tid,
      url: page.href,
      pageTextPreview: page.text.slice(0, 200),
      message: "Boss 登录态：有效，可以进入下一步。",
    };
  }

  if (kind.blocked) {
    const state = await captureState(tid);
    return {
      ...toLoginPayload(state, { forceImage: true }),
      loggedIn: false,
      message: buildInstruction(state),
    };
  }

  if (kind.captcha) {
    await prepareCaptchaView(tid);
    const state = await captureState(tid);
    return {
      ...toLoginPayload(state, { forceImage: true }),
      message: "仍在安全验证页。请自行完成验证后再检验登录态。",
    };
  }

  const state = await captureState(tid);
  return {
    ...toLoginPayload(state, { forceImage: true }),
    loggedIn: false,
    stage: kind.smsForm ? "awaiting_self_login" : "unknown",
    targetId: tid,
    url: page.href,
    pageTextPreview: page.text.slice(0, 200),
    message:
      "Boss 登录态：仍无效。请你在托管浏览器自行登录完成后，再点「检验登录态」。",
  };
}

/**
 * Self-login prepare: only open Boss login page + screenshot.
 * Product does not fill phone/SMS/captcha — user logs in, then checkBossLoginStatus.
 */
export async function prepareBossSelfLogin(preferredTargetId = null, { restart = false } = {}) {
  const targetId = await acquireLoginTab(preferredTargetId, { forceFresh: restart });
  const page = await readPage(targetId);
  const kind = classifyPage(page.href, page.text);
  if (kind.loggedIn) {
    return {
      loggedIn: true,
      stage: "logged_in",
      targetId,
      url: page.href,
      mode: "self",
      message: "检测到托管浏览器已登录 Boss，可直接开始招聘对话。",
    };
  }
  if (kind.blocked) {
    const state = await captureState(targetId);
    return {
      ...toLoginPayload(state, { forceImage: true }),
      mode: "self",
      message: buildInstruction(state),
    };
  }
  const state = await captureState(targetId);
  return {
    ...toLoginPayload(state, { forceImage: true }),
    mode: "self",
    loggedIn: false,
    stage: "awaiting_self_login",
    message:
      "已在你的本机浏览器节点打开 Boss 登录页（不会代填）。请在本机可见窗口自行登录，完成后点「检验登录态」。",
  };
}

export function bossLoginMode() {
  const mode = String(process.env.BOSS_LOGIN_MODE || "self").trim().toLowerCase();
  return mode === "assisted" ? "assisted" : "self";
}
