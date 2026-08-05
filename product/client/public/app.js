const loginView = document.getElementById("login-view");
const shellView = document.getElementById("shell-view");
const loginError = document.getElementById("login-error");
const chatError = document.getElementById("chat-error");
const skillsError = document.getElementById("skills-error");
const messagesEl = document.getElementById("messages");
const skillsList = document.getElementById("skills-list");
const notificationsList = document.getElementById("notifications-list");

const TOKEN_KEY = "product_access_token";
const PLATFORM_TOKEN_KEY = "platform_access_token";

let currentUser = null;
let currentSettings = null;
let currentEmployees = [];
let currentEmployee = null;
let lastBossLoginTargetId = null;
let lastBossLoginPhone = "";
let lastBossLoginSnapshot = null;
let hrWizardAutoPrompted = false;
let hrWizardDismissed = false; // user dismissed boss login wizard (suppress until next real login need)
let hrWizard = {
  step: 1,
  loggedIn: false,
  modeId: null,
  jobTitle: "",
  notes: "",
  open: false,
};
let loginMode = "password"; // password | sms
let captchaState = {
  captchaId: null,
  scene: "login",
  initialAngle: 0,
  width: 320,
  height: 180,
  diameter: 96,
  centerX: 160,
  centerY: 90,
};
let captchaWaiter = null; // { resolve, reject, scene }
let cachedPublicKey = null;
let smsCooldownTimer = null;
let smsCooldownLeft = 0;

function getToken() {
  // Session-only: closing the app clears login. Do not restore durable localStorage tokens.
  return sessionStorage.getItem(TOKEN_KEY);
}

function setToken(token) {
  sessionStorage.setItem(TOKEN_KEY, token);
  localStorage.removeItem(TOKEN_KEY);
}

function clearToken() {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(PLATFORM_TOKEN_KEY);
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(PLATFORM_TOKEN_KEY);
}

function desktopClientContext() {
  if (!isDesktopBoss()) return null;
  return {
    desktop: true,
    bossLoggedIn: Boolean(hrWizard.loggedIn),
  };
}

async function api(path, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const headers = { ...(options.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  // Fastify rejects empty bodies when Content-Type is application/json.
  // Only set JSON content-type when we actually send a body; bare POSTs get "{}".
  let body = options.body;
  const hasBody = body !== undefined && body !== null && body !== "";
  if (hasBody) {
    if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
    // Desktop Electron owns Boss session locally — tell BFF so funnel is not blocked as "no browser node".
    if (typeof body === "string" && (path === "/api/chat" || path.includes("/pipeline/"))) {
      try {
        const parsed = JSON.parse(body);
        if (parsed && typeof parsed === "object" && !parsed.clientContext) {
          const ctx = desktopClientContext();
          if (ctx) {
            parsed.clientContext = ctx;
            body = JSON.stringify(parsed);
          }
        }
      } catch {
        // leave body as-is
      }
    }
  } else if (method !== "GET" && method !== "HEAD") {
    headers["Content-Type"] = "application/json";
    body = "{}";
  }

  const res = await fetch(path, { ...options, method, headers, body, credentials: "include" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || (typeof data.state === "number" && data.state >= 400)) {
    const err = new Error(data.error || data.message || `http_${res.status}`);
    err.payload = data;
    throw err;
  }
  return data;
}

function base64ToArrayBuffer(base64) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
  return bytes.buffer;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function parsePublicKeyPem(pemKey) {
  let keyStr = String(pemKey || "");
  if (!keyStr.includes("-----BEGIN PUBLIC KEY-----")) {
    try {
      const decodedPem = atob(keyStr);
      if (decodedPem.includes("-----BEGIN PUBLIC KEY-----")) keyStr = decodedPem;
    } catch {
      // keep original
    }
  }
  return keyStr
    .replace("-----BEGIN PUBLIC KEY-----", "")
    .replace("-----END PUBLIC KEY-----", "")
    .replace(/\s/g, "");
}

async function rsaEncryptPassword(password, publicKeyB64OrPem) {
  const parsedKey = parsePublicKeyPem(publicKeyB64OrPem);
  const publicKey = await crypto.subtle.importKey(
    "spki",
    base64ToArrayBuffer(parsedKey),
    { name: "RSA-OAEP", hash: { name: "SHA-256" } },
    false,
    ["encrypt"],
  );
  const encrypted = await crypto.subtle.encrypt(
    { name: "RSA-OAEP", hash: { name: "SHA-256" } },
    publicKey,
    new TextEncoder().encode(password),
  );
  return arrayBufferToBase64(encrypted);
}

async function loadPublicKey() {
  if (cachedPublicKey) return cachedPublicKey;
  const data = await api("/api/auth/public-key");
  cachedPublicKey = data?.data?.publicKey || null;
  return cachedPublicKey;
}

function setLoginMode(mode) {
  loginMode = mode === "sms" ? "sms" : "password";
  document.querySelectorAll(".login-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.loginMode === loginMode);
  });
  document.getElementById("login-panel-password").hidden = loginMode !== "password";
  document.getElementById("login-panel-sms").hidden = loginMode !== "sms";
  showError(loginError, "");
}

function layoutCaptchaPiece() {
  const stage = document.getElementById("captcha-stage");
  const piece = document.getElementById("captcha-rotate");
  if (!stage || !piece) return;
  const rect = stage.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const sx = rect.width / (captchaState.width || 320);
  const sy = rect.height / (captchaState.height || 180);
  const diameter = (captchaState.diameter || 96) * sx;
  const left = (captchaState.centerX || 160) * sx - diameter / 2;
  const top = (captchaState.centerY || 90) * sy - diameter / 2;
  piece.style.width = `${diameter}px`;
  piece.style.height = `${diameter}px`;
  piece.style.left = `${left}px`;
  piece.style.top = `${top}px`;
}

function applyCaptchaAngle() {
  const delta = Number(document.getElementById("captcha-angle").value || 0);
  const img = document.getElementById("captcha-rotate");
  // Platform: show piece at initial_angle + user delta; verify payload is the delta only.
  const shown = (Number(captchaState.initialAngle || 0) + delta) % 360;
  img.style.transform = `rotate(${shown}deg)`;
}

async function refreshCaptcha(scene = captchaState.scene || "login") {
  captchaState = {
    captchaId: null,
    scene,
    initialAngle: 0,
    width: 320,
    height: 180,
    diameter: 96,
    centerX: 160,
    centerY: 90,
  };
  const data = await api("/api/auth/captcha/rotate/create", {
    method: "POST",
    body: JSON.stringify({ scene }),
  });
  const challenge = data.data || {};
  captchaState.captchaId = challenge.captcha_id;
  captchaState.scene = scene;
  captchaState.initialAngle = Number(challenge.initial_angle || 0);
  captchaState.width = Number(challenge.width || 320);
  captchaState.height = Number(challenge.height || 180);
  captchaState.diameter = Number(challenge.circle_diameter || 96);
  captchaState.centerX = Number(challenge.center_x || captchaState.width / 2);
  captchaState.centerY = Number(challenge.center_y || captchaState.height / 2);
  document.getElementById("captcha-bg").src = challenge.background_image || "";
  const rotate = document.getElementById("captcha-rotate");
  rotate.onload = () => {
    layoutCaptchaPiece();
    applyCaptchaAngle();
  };
  rotate.src = challenge.rotate_image || "";
  document.getElementById("captcha-angle").value = "0";
  requestAnimationFrame(() => {
    layoutCaptchaPiece();
    applyCaptchaAngle();
  });
}

function closeCaptchaModal(reason = "cancel") {
  const modal = document.getElementById("captcha-modal");
  modal.hidden = true;
  const waiter = captchaWaiter;
  captchaWaiter = null;
  if (waiter) {
    if (reason === "ok") waiter.resolve(true);
    else waiter.reject(new Error(reason === "cancel" ? "已取消验证" : reason));
  }
}

/**
 * Open rotate-captcha modal for a platform scene (`login` or `login-sms`).
 * Resolves after verify succeeds; rejects on cancel.
 */
async function requestCaptcha(scene) {
  showError(document.getElementById("captcha-error"), "");
  const modal = document.getElementById("captcha-modal");
  modal.hidden = false;
  await refreshCaptcha(scene);
  requestAnimationFrame(() => {
    layoutCaptchaPiece();
    applyCaptchaAngle();
  });
  return new Promise((resolve, reject) => {
    captchaWaiter = { resolve, reject, scene };
  });
}

async function confirmCaptchaModal() {
  const errEl = document.getElementById("captcha-error");
  showError(errEl, "");
  const btn = document.getElementById("captcha-confirm");
  btn.disabled = true;
  try {
    if (!captchaWaiter) return;
    const { resolve, scene } = captchaWaiter;
    const angle = Number(document.getElementById("captcha-angle").value || 0);
    await api("/api/auth/captcha/rotate/verify", {
      method: "POST",
      body: JSON.stringify({
        captcha_id: captchaState.captchaId,
        angle,
        scene: captchaState.scene || scene,
      }),
    });
    captchaWaiter = null;
    document.getElementById("captcha-modal").hidden = true;
    resolve(true);
  } catch (err) {
    showError(errEl, err.payload?.message || err.message || "验证失败");
    try {
      await refreshCaptcha(captchaState.scene || "login");
    } catch {
      // ignore
    }
  } finally {
    btn.disabled = false;
  }
}

function startSmsCooldown(seconds = 60) {
  const btn = document.getElementById("sms-send-btn");
  smsCooldownLeft = seconds;
  if (smsCooldownTimer) clearInterval(smsCooldownTimer);
  const tick = () => {
    if (smsCooldownLeft <= 0) {
      clearInterval(smsCooldownTimer);
      smsCooldownTimer = null;
      btn.disabled = false;
      btn.textContent = "获取验证码";
      return;
    }
    btn.disabled = true;
    btn.textContent = `${smsCooldownLeft}s`;
    smsCooldownLeft -= 1;
  };
  tick();
  smsCooldownTimer = setInterval(tick, 1000);
}

async function sendSmsCode() {
  showError(loginError, "");
  const phone = document.getElementById("phone").value.trim();
  if (!/^1\d{10}$/.test(phone)) {
    throw new Error("请输入正确的手机号");
  }
  // Platform: captcha scene=login-sms, then send-sms scene=login
  await requestCaptcha("login-sms");
  await api("/api/auth/send-sms-code", {
    method: "POST",
    body: JSON.stringify({ phone, scene: "login" }),
  });
  startSmsCooldown(60);
}

function showError(el, message) {
  if (!el) return;
  el.hidden = !message;
  el.textContent = message || "";
}

function showOk(el, message) {
  if (!el) return;
  el.hidden = !message;
  el.textContent = message || "";
}

function addBubble(role, text, options = {}) {
  const div = document.createElement("div");
  div.className = `bubble ${role}`;
  if (options.imageDataUrl) {
    const p = document.createElement("p");
    p.textContent = text || "";
    div.appendChild(p);
    const img = document.createElement("img");
    img.src = options.imageDataUrl;
    img.alt = options.imageAlt || "登录二维码";
    img.className = options.interactive ? "bubble-image bubble-image-interactive" : "bubble-image";
    img.draggable = false;
    if (options.interactive && typeof options.onImageClick === "function") {
      img.title = "点击图块转发到服务器浏览器";
      img.addEventListener("click", (event) => {
        const rect = img.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const xRatio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
        const yRatio = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
        options.onImageClick({ xRatio, yRatio, img });
      });
    }
    div.appendChild(img);
    if (options.actions?.length) {
      const actions = document.createElement("div");
      actions.className = "bubble-actions";
      for (const action of options.actions) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "employee-mode-btn";
        btn.textContent = action.label;
        btn.addEventListener("click", () => action.onClick?.());
        actions.appendChild(btn);
      }
      div.appendChild(actions);
    }
  } else {
    div.textContent = text;
  }
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

/** Collapse exact duplicated replies (model sometimes echoes twice). */
function collapseRepeatedReply(text) {
  const s = String(text || "").trim();
  if (s.length < 24) return s;
  const mid = Math.floor(s.length / 2);
  for (let i = Math.max(12, mid - 40); i <= Math.min(s.length - 12, mid + 40); i++) {
    const a = s.slice(0, i).trim();
    const b = s.slice(i).trim();
    if (a && a === b) return a;
  }
  return s;
}

function addThinkingBubble() {
  const div = document.createElement("div");
  div.className = "bubble assistant thinking";
  div.setAttribute("aria-live", "polite");
  div.innerHTML =
    '<span class="thinking-label">正在思考</span>' +
    '<span class="thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span>' +
    '<span class="thinking-timer">0s</span>';
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  const timerEl = div.querySelector(".thinking-timer");
  const started = Date.now();
  const tick = setInterval(() => {
    const sec = Math.floor((Date.now() - started) / 1000);
    if (timerEl) timerEl.textContent = `${sec}s`;
  }, 250);
  return {
    el: div,
    stop() {
      clearInterval(tick);
    },
    remove() {
      clearInterval(tick);
      div.remove();
    },
  };
}

function setComposerBusy(busy) {
  const input = document.getElementById("prompt");
  const btn = document.querySelector("#chat-form button[type='submit']");
  if (input) {
    input.disabled = busy;
    input.placeholder = busy ? "聚元灵创正在回复…" : "向聚元灵创发送消息…";
  }
  if (btn) {
    btn.disabled = busy;
    btn.textContent = busy ? "回复中" : "发送";
  }
}

function applyAppearance(settings) {
  const appearance = settings?.appearance || { theme: "light", fontSize: "md", compact: false };
  let theme = appearance.theme || "light";
  if (theme === "system") {
    theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.font = appearance.fontSize || "md";
  document.documentElement.dataset.compact = String(Boolean(appearance.compact));
}

function applyProfile(user) {
  const name = user?.nickname || user?.username || "用户";
  document.getElementById("sidebar-name").textContent = name;
  const avatarEl = document.getElementById("sidebar-avatar");
  const avatarUrl = String(user?.avatar || "").trim();
  if (avatarUrl && /^https?:\/\//i.test(avatarUrl)) {
    avatarEl.textContent = "";
    avatarEl.style.backgroundImage = `url("${avatarUrl}")`;
    avatarEl.classList.add("has-image");
  } else {
    avatarEl.style.backgroundImage = "";
    avatarEl.classList.remove("has-image");
    avatarEl.textContent = name.slice(0, 1).toUpperCase();
  }
}

function renderBossLoginResult(data, { mirrorChat = false } = {}) {
  lastBossLoginTargetId = data.targetId || lastBossLoginTargetId;
  lastBossLoginSnapshot = data || null;
  if (data.loggedIn || data.stage === "logged_in") {
    hrWizard.loggedIn = true;
    const msg = data.instruction || data.message || "Boss 已登录。";
    if (hrWizard.step < 2) {
      advanceHrWizard(2, `${msg} 可直接对话开展招聘。`);
    } else {
      addBubble("assistant", msg);
      renderEmployeeWizard(currentEmployee);
    }
    return;
  }

  hrWizard.open = true;
  renderEmployeeWizard(currentEmployee);
  applyBossLoginSnapshot(data);

  if (mirrorChat && (data.instruction || data.message)) {
    addBubble("assistant", data.instruction || data.message);
  }
}

function applyBossLoginSnapshot(data) {
  if (!data) return;
  const statusEl = document.getElementById("boss-login-status");
  if (statusEl) {
    statusEl.textContent = data.instruction || data.message || "";
  }
  const previewBox = document.getElementById("boss-self-preview");
  const previewImg = document.getElementById("boss-self-preview-img");
  if (previewBox && previewImg && data.imageDataUrl) {
    previewBox.hidden = false;
    previewImg.src = data.imageDataUrl;
  }
  if (data.blocked) {
    const tip = document.getElementById("boss-self-preview-tip");
    if (tip) tip.textContent = "访问受限（请勿频繁刷新）";
  }
}

function isDesktopBoss() {
  return Boolean(window.desktopApp?.isDesktop && window.desktopApp?.boss);
}

/** One-time consent for local Boss window read/control (desktop only). */
function ensureBossClientConsent() {
  if (!isDesktopBoss() || !window.desktopApp?.consent) return true;
  const key = `oc_boss_consent_v${window.desktopApp.consent.version || 1}`;
  if (localStorage.getItem(key) === "1") return true;
  const c = window.desktopApp.consent;
  const ok = window.confirm(`${c.title}\n\n${c.body}\n\n同意后继续使用本机自动化。`);
  if (ok) localStorage.setItem(key, "1");
  return ok;
}

/**
 * Execute BFF-issued clientActions on the local Boss window (employer IP).
 * Server never runs these DOM actions.
 */
async function executeClientActions(actions) {
  if (!Array.isArray(actions) || !actions.length) return;
  if (!isDesktopBoss()) {
    addBubble(
      "assistant",
      "这条指令需要桌面客户端在本机执行（自动请求/下载简历、复聊）。请用「聚元灵创」桌面端打开后再试。",
    );
    return;
  }
  if (!ensureBossClientConsent()) {
    addBubble("assistant", "未同意本机 Boss 窗口权限，已取消自动操作。");
    return;
  }
  for (const action of actions) {
    if (action?.executor && action.executor !== "desktop_boss") continue;
    const type = action.type;
    const params = action.params || {};
    const thinking = addThinkingBubble();
    try {
      let result = null;
      if (type === "open_boss_login") {
        result = await window.desktopApp.boss.openLogin({});
      } else if (type === "request_resumes") {
        result = await window.desktopApp.boss.requestResumes({
          limit: params.limit || 5,
          names: params.names || [],
        });
      } else if (type === "download_resumes") {
        result = await window.desktopApp.boss.downloadResumes({
          limit: params.limit || 5,
          names: params.names || [],
        });
      } else if (type === "request_and_download_resumes") {
        if (typeof window.desktopApp.boss.requestAndDownloadResumes !== "function") {
          // Older desktop: fall back to sequential request → download.
          result = await window.desktopApp.boss.requestResumes({
            limit: params.limit || 5,
            names: params.names || [],
          });
          thinking.remove();
          if (result?.message) addBubble("assistant", result.message);
          const thinking2 = addThinkingBubble();
          try {
            result = await window.desktopApp.boss.downloadResumes({
              limit: params.limit || 5,
              names: params.names || [],
            });
            thinking2.remove();
            if (result?.message) addBubble("assistant", result.message);
          } catch (err) {
            thinking2.remove();
            addBubble("assistant", `下载简历失败：${err.message || err}`);
          }
          continue;
        }
        result = await window.desktopApp.boss.requestAndDownloadResumes({
          limit: params.limit || 5,
          names: params.names || [],
        });
      } else if (type === "enrich_profiles") {
        if (typeof window.desktopApp.boss.enrichProfiles !== "function") {
          thinking.remove();
          addBubble(
            "assistant",
            "当前桌面端版本过旧，无法拉取择优候选人简历摘要。请更新到 0.1.8+ 后重试。",
          );
          continue;
        }
        result = await window.desktopApp.boss.enrichProfiles({
          limit: params.limit || 8,
          names: params.names || [],
        });
        thinking.remove();
        if (result?.message) addBubble("assistant", result.message);
        const enriched = Array.isArray(result?.candidates) ? result.candidates : [];
        if (enriched.length) {
          const enrichThinking = addThinkingBubble();
          try {
            const patch = await api(
              `/api/employees/${encodeURIComponent(currentEmployee.sku)}/pipeline/enrich`,
              {
                method: "POST",
                body: JSON.stringify({
                  jobId: params.jobId,
                  candidates: enriched,
                }),
              },
            );
            enrichThinking.remove();
            const data = patch.data || patch;
            if (data.reply) addBubble("assistant", collapseRepeatedReply(data.reply));
            if (data) renderPipelineFollowups(data);
          } catch (err) {
            enrichThinking.remove();
            addBubble("assistant", `简历摘要回写失败：${err.message || err}`);
          }
        }
        continue;
      } else if (type === "auto_rechat") {
        result = await window.desktopApp.boss.autoRechat({
          message: params.message || "",
          limit: params.limit || 5,
          names: params.names || [],
        });
      } else if (type === "boss_interview_invite") {
        if (typeof window.desktopApp.boss.interviewInvite !== "function") {
          thinking.remove();
          addBubble(
            "assistant",
            "当前桌面端还不支持 Boss 原生「约面试」。请更新客户端后重试，或先在 Boss 沟通页手动点「约面试」。",
          );
          continue;
        }
        result = await window.desktopApp.boss.interviewInvite({
          names: params.names || [],
          mode: params.mode || "online",
          time: params.time || "",
          place: params.place || "",
          draft: params.draft || params.message || "",
          limit: params.limit || 5,
        });
      } else if (type === "check_inbox_replies") {
        result = await window.desktopApp.boss.checkInboxReplies({
          limit: params.limit || 8,
          names: params.names || [],
        });
        thinking.remove();
        if (result?.message) addBubble("assistant", result.message);
        if (result?.loggedIn) hrWizard.loggedIn = true;
        const repliedNames = (Array.isArray(result?.results) ? result.results : [])
          .filter((r) => r?.replied && r?.name)
          .map((r) => r.name);
        // A reply is evidence for second screening, not permission to request a resume.
        // Persist it first; only the backend's >=80 answer gate may emit resume actions.
        if (repliedNames.length || params.runId) {
          const syncThinking = addThinkingBubble();
          try {
            const synced = await api(
              `/api/employees/${encodeURIComponent(currentEmployee.sku)}/pipeline/replies`,
              {
                method: "POST",
                body: JSON.stringify({
                  jobId: params.jobId,
                  results: Array.isArray(result?.results) ? result.results : [],
                  runId: params.runId || null,
                }),
              },
            );
            syncThinking.remove();
            const data = synced.data || synced;
            if (data?.reply) addBubble("assistant", collapseRepeatedReply(data.reply));
            if (data) renderPipelineFollowups(data);
          } catch (err) {
            syncThinking.remove();
            addBubble("assistant", `候选人回复回写失败：${err.message || err}`);
          }
        }
        continue;
      } else if (type === "screen_candidate_answers") {
        thinking.remove();
        const screened = await api(
          `/api/employees/${encodeURIComponent(currentEmployee.sku)}/pipeline/act`,
          { method: "POST", body: JSON.stringify({ action: "screen_answers" }) },
        );
        const data = screened.data || screened;
        if (data?.reply) addBubble("assistant", collapseRepeatedReply(data.reply));
        if (data) renderPipelineFollowups({ ...data, clientActions: [] });
        if (params.runId) {
          await api(`/api/employees/${encodeURIComponent(currentEmployee.sku)}/pipeline/action-result`, {
            method: "POST",
            body: JSON.stringify({
              type,
              results: [{ name: "二次筛选", ok: true }],
              runId: params.runId,
            }),
          });
        }
        continue;
      } else if (type === "scrape_inbox") {
        if (typeof window.desktopApp.boss.scrapeInbox !== "function") {
          thinking.remove();
          addBubble(
            "assistant",
            "当前桌面端版本过旧，无法从本机 Boss 拉真实候选人。请更新到 0.1.8+ 后重试。",
          );
          continue;
        }
        result = await window.desktopApp.boss.scrapeInbox({
          limit: params.limit || 300,
          todayOnly: params.todayOnly !== false,
          jobTitle: params.jobTitle || "",
          headcount: params.headcount || 5,
        });
        thinking.remove();
        if (result?.loggedIn) hrWizard.loggedIn = true;
        if (!result?.ok) {
          addBubble("assistant", result?.message || "本机拉取候选人失败。");
          continue;
        }
        if (result.message) addBubble("assistant", result.message);
        const candidates = Array.isArray(result.candidates) ? result.candidates : [];
        if (!candidates.length) {
          addBubble(
            "assistant",
            "沟通列表为空，没有可初筛的真实候选人。请在 Boss「沟通」确认有会话后再说招聘需求。",
          );
          continue;
        }
        const ingestThinking = addThinkingBubble();
        try {
          const ingest = await api(
            `/api/employees/${encodeURIComponent(currentEmployee.sku)}/pipeline/ingest`,
            {
              method: "POST",
              body: JSON.stringify({
                jobId: params.jobId,
                candidates,
              }),
            },
          );
          ingestThinking.remove();
          const data = ingest.data || ingest;
          if (data.reply) addBubble("assistant", collapseRepeatedReply(data.reply));
          if (data) renderPipelineFollowups(data);
        } catch (err) {
          ingestThinking.remove();
          addBubble(
            "assistant",
            `候选人已拉取，但初筛入库失败：${err.payload?.message || err.message}`,
          );
        }
        continue;
      } else {
        thinking.remove();
        continue;
      }
      thinking.remove();
      if (result?.message) addBubble("assistant", result.message);
      if (type === "auto_rechat" && Array.isArray(result?.results) && result.results.length) {
        const lines = result.results.map((r) => {
          if (r.sent) return `✓ ${r.name}：已确认发出${r.verified ? "（会话中核验到文案）" : ""}`;
          return `✗ ${r.name}：未发出${r.error ? `（${r.error}）` : ""}`;
        });
        addBubble("assistant", ["本机发送明细：", ...lines].join("\n"));
        try {
          await api(`/api/employees/${encodeURIComponent(currentEmployee.sku)}/pipeline/action-result`, {
            method: "POST",
            body: JSON.stringify({ type, results: result.results, runId: params.runId || null }),
          });
        } catch (err) {
          addBubble("assistant", `发送状态回写失败：${err.message || err}`);
        }
      }
      if (
        ["request_resumes", "download_resumes", "request_and_download_resumes", "boss_interview_invite"].includes(
          type,
        ) &&
        Array.isArray(result?.results)
      ) {
        try {
          await api(`/api/employees/${encodeURIComponent(currentEmployee.sku)}/pipeline/action-result`, {
            method: "POST",
            body: JSON.stringify({ type, results: result.results, runId: params.runId || null }),
          });
        } catch (err) {
          addBubble("assistant", `本机执行状态回写失败：${err.message || err}`);
        }
      }
      if (result?.loggedIn) hrWizard.loggedIn = true;
        } catch (err) {
          thinking.remove();
          if (params.runId) {
            try {
              await api(`/api/employees/${encodeURIComponent(currentEmployee.sku)}/pipeline/action-result`, {
                method: "POST",
                body: JSON.stringify({
                  type,
                  results: [],
                  runId: params.runId,
                  error: err.message || String(err),
                }),
              });
            } catch {
              // The original local-operation error is the useful failure to show here.
            }
          }
          addBubble("assistant", `本机 Boss 操作失败：${err.message || err}`);
        }
  }
}

function matchBossChatAction(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  if (/检验\s*(?:boss\s*)?登录(?:态)?|检查\s*(?:boss\s*)?登录|验证\s*(?:boss\s*)?登录|boss\s*登录态/i.test(raw)) {
    return "check";
  }
  if (/刷新\s*(?:boss\s*)?预览|刷新预览/i.test(raw)) return "refresh";
  if (
    /打开\s*(?:boss|直聘|zhipin)?\s*(?:窗口|浏览器|页面)?|(?:boss|直聘)\s*窗口|显示\s*boss|切换\s*(?:到\s*)?boss|打开boss/i.test(
      raw,
    )
  ) {
    return "open";
  }
  return null;
}

async function handleBossChatAction(action, { skipUserBubble = false } = {}) {
  if (!currentEmployee?.sku && !isDesktopBoss()) return false;
  openHrWizard();
  if (action === "open") {
    await runBossLoginStart({ skipUserBubble });
    return true;
  }
  if (action === "check") {
    await runBossLoginCheck({ skipUserBubble });
    return true;
  }
  if (action === "refresh") {
    await runBossLoginRefresh();
    return true;
  }
  return false;
}

function updateHrBossLoginButton(employee) {
  const btn = document.getElementById("hr-boss-login-btn");
  if (!btn) return;
  const show = employee?.sku === "hr-recruitment" && employee?.active;
  btn.hidden = !show;
}

function maybeAutoOpenHrWizard(employee) {
  if (hrWizardDismissed) return;
  if (hrWizardAutoPrompted || hrWizard.open || hrWizard.loggedIn) return;
  if (employee?.sku !== "hr-recruitment" || !employee?.active) return;
  if (!isDesktopBoss()) return;
  hrWizardAutoPrompted = true;
  openHrWizard("使用人事招聘前，请先在下方完成 Boss 自助登录（本机内嵌浏览器，走你电脑的网络）。");
}

function matchBossLoginExitAction(text) {
  const raw = String(text || "").trim();
  if (!raw) return false;
  return (
    /(退出|关闭)\s*(?:boss|直聘|zhipin)\s*(?:登录|登录引导)?/i.test(raw) ||
    /暂不.*(?:boss|直聘|zhipin)/i.test(raw) ||
    /先别管.*(?:boss|直聘|zhipin)/i.test(raw)
  );
}

async function runBossLoginStart({ restart = false, skipUserBubble = false } = {}) {
  if (!currentEmployee?.sku && !isDesktopBoss()) {
    alert("请先选择数字员工");
    return;
  }
  if (!skipUserBubble) {
    addBubble("user", restart ? "打开 / 重置 Boss 登录页" : "打开 Boss 登录页");
  }
  const thinking = addThinkingBubble();
  try {
    if (isDesktopBoss()) {
      const data = await window.desktopApp.boss.openLogin({ restart });
      thinking.remove();
      renderBossLoginResult(data || {});
      return;
    }
    const res = await api(`/api/employees/${encodeURIComponent(currentEmployee.sku)}/boss-login/start`, {
      method: "POST",
      body: JSON.stringify({
        targetId: restart ? null : lastBossLoginTargetId,
        restart,
      }),
    });
    thinking.remove();
    renderBossLoginResult(res.data || {});
  } catch (err) {
    thinking.remove();
    addBubble(
      "assistant",
      `打开登录页失败：${err.payload?.message || err.message}`,
    );
  }
}

async function runBossSendSms() {
  if (!currentEmployee?.sku) return;
  const phoneInput = document.getElementById("boss-phone");
  const phone = (phoneInput?.value || lastBossLoginPhone || "").trim();
  if (!/^1\d{10}$/.test(phone.replace(/\D/g, ""))) {
    alert("请输入正确的11位手机号");
    return;
  }
  lastBossLoginPhone = phone.replace(/\D/g, "");
  addBubble("user", `发送验证码到 ${lastBossLoginPhone}`);
  const thinking = addThinkingBubble();
  const btn = document.getElementById("boss-send-sms-btn");
  if (btn) btn.disabled = true;
  try {
    const doSend = async (targetId) =>
      api(`/api/employees/${encodeURIComponent(currentEmployee.sku)}/boss-login/send-sms`, {
        method: "POST",
        body: JSON.stringify({ targetId, phone: lastBossLoginPhone }),
      });

    let res;
    try {
      res = await doSend(lastBossLoginTargetId);
    } catch (err) {
      const msg = String(err.payload?.message || err.message || "");
      // Stale browser tab — clear and retry once with fresh session.
      if (/tab not found|boss_tab/i.test(msg)) {
        lastBossLoginTargetId = null;
        res = await doSend(null);
      } else {
        throw err;
      }
    }
    thinking.remove();
    lastBossLoginTargetId = res.data?.targetId || lastBossLoginTargetId;
    renderBossLoginResult(res.data || {}, { mirrorChat: true });
  } catch (err) {
    thinking.remove();
    lastBossLoginTargetId = null;
    addBubble("assistant", `发送验证码失败：${err.payload?.message || err.message}。请再点一次「发送验证码」。`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function runBossSubmitSms() {
  if (!currentEmployee?.sku) return;
  const code = (document.getElementById("boss-sms-code")?.value || "").trim();
  if (!code) {
    alert("请输入短信验证码");
    return;
  }
  addBubble("user", "提交短信验证码登录");
  const thinking = addThinkingBubble();
  try {
    const res = await api(`/api/employees/${encodeURIComponent(currentEmployee.sku)}/boss-login/submit-sms`, {
      method: "POST",
      body: JSON.stringify({
        targetId: lastBossLoginTargetId,
        code,
        phone: lastBossLoginPhone || document.getElementById("boss-phone")?.value || null,
      }),
    });
    thinking.remove();
    renderBossLoginResult(res.data || {});
  } catch (err) {
    thinking.remove();
    addBubble("assistant", `登录失败：${err.payload?.message || err.message}`);
  }
}

async function runBossLoginRefresh() {
  if (!currentEmployee?.sku && !isDesktopBoss()) return;
  const thinking = addThinkingBubble();
  try {
    if (isDesktopBoss()) {
      const data = await window.desktopApp.boss.refreshPreview();
      thinking.remove();
      renderBossLoginResult(data || {}, { mirrorChat: false });
      return;
    }
    const res = await api(`/api/employees/${encodeURIComponent(currentEmployee.sku)}/boss-login/refresh`, {
      method: "POST",
      body: JSON.stringify({ targetId: lastBossLoginTargetId }),
    });
    thinking.remove();
    renderBossLoginResult(res.data || {}, { mirrorChat: false });
  } catch (err) {
    thinking.remove();
    addBubble("assistant", `刷新失败：${err.payload?.message || err.message}`);
  }
}

async function runBossLoginExpand() {
  if (!currentEmployee?.sku) return;
  const thinking = addThinkingBubble();
  try {
    const res = await api(`/api/employees/${encodeURIComponent(currentEmployee.sku)}/boss-login/expand`, {
      method: "POST",
      body: JSON.stringify({ targetId: lastBossLoginTargetId }),
    });
    thinking.remove();
    renderBossLoginResult(res.data || {}, { mirrorChat: false });
  } catch (err) {
    thinking.remove();
    addBubble("assistant", `展开失败：${err.payload?.message || err.message}`);
  }
}

async function runBossLoginClick(xRatio, yRatio, imgEl, tileIndex) {
  if (!currentEmployee?.sku) return;
  if (imgEl) imgEl.classList.add("bubble-image-busy");
  const wizardImg = document.getElementById("boss-captcha-img");
  if (wizardImg) wizardImg.classList.add("bubble-image-busy");
  try {
    const body = { targetId: lastBossLoginTargetId };
    if (Number.isInteger(tileIndex)) body.tileIndex = tileIndex;
    else {
      body.xRatio = xRatio;
      body.yRatio = yRatio;
    }
    const res = await api(`/api/employees/${encodeURIComponent(currentEmployee.sku)}/boss-login/click`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    const data = res.data || {};
    lastBossLoginTargetId = data.targetId || lastBossLoginTargetId;
    renderBossLoginResult(data, { mirrorChat: false });
  } catch (err) {
    addBubble("assistant", `点选失败：${err.payload?.message || err.message}`);
  } finally {
    if (imgEl) imgEl.classList.remove("bubble-image-busy");
    if (wizardImg) wizardImg.classList.remove("bubble-image-busy");
  }
}

async function runBossConfirmCaptcha() {
  if (!currentEmployee?.sku) return;
  const thinking = addThinkingBubble();
  try {
    const res = await api(
      `/api/employees/${encodeURIComponent(currentEmployee.sku)}/boss-login/confirm-captcha`,
      {
        method: "POST",
        body: JSON.stringify({ targetId: lastBossLoginTargetId }),
      },
    );
    thinking.remove();
    lastBossLoginTargetId = res.data?.targetId || lastBossLoginTargetId;
    renderBossLoginResult(res.data || {}, { mirrorChat: true });
  } catch (err) {
    thinking.remove();
    addBubble("assistant", `确认验证失败：${err.payload?.message || err.message}`);
  }
}

async function runBossAutoCaptcha() {
  if (!currentEmployee?.sku) return;
  addBubble("user", "请自动识别并完成安全验证");
  const thinking = addThinkingBubble();
  const btn = document.getElementById("boss-auto-captcha-btn");
  if (btn) btn.disabled = true;
  try {
    const res = await api(
      `/api/employees/${encodeURIComponent(currentEmployee.sku)}/boss-login/auto-captcha`,
      {
        method: "POST",
        body: JSON.stringify({ targetId: lastBossLoginTargetId }),
      },
    );
    thinking.remove();
    lastBossLoginTargetId = res.data?.targetId || lastBossLoginTargetId;
    renderBossLoginResult(res.data || {}, { mirrorChat: true });
  } catch (err) {
    thinking.remove();
    // Still try to re-show current captcha so manual click remains possible.
    try {
      const res = await api(
        `/api/employees/${encodeURIComponent(currentEmployee.sku)}/boss-login/refresh`,
        {
          method: "POST",
          body: JSON.stringify({ targetId: lastBossLoginTargetId }),
        },
      );
      lastBossLoginTargetId = res.data?.targetId || lastBossLoginTargetId;
      renderBossLoginResult(res.data || {}, { mirrorChat: false });
    } catch {
      // ignore
    }
    addBubble(
      "assistant",
      `自动识别失败：${err.payload?.message || err.message}。请直接点上方验证图蓝框，再点「确认验证」。不要连续刷新。`,
    );
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function runBossLoginCheck({ skipUserBubble = false } = {}) {
  if (!currentEmployee?.sku && !isDesktopBoss()) return;
  if (!skipUserBubble) addBubble("user", "检验 Boss 登录态");
  const thinking = addThinkingBubble();
  try {
    let data;
    if (isDesktopBoss()) {
      data = (await window.desktopApp.boss.checkLogin()) || {};
    } else {
      const res = await api(`/api/employees/${encodeURIComponent(currentEmployee.sku)}/boss-login/check`, {
        method: "POST",
        body: JSON.stringify({ targetId: lastBossLoginTargetId }),
      });
      data = res.data || {};
    }
    thinking.remove();
    if (data.loggedIn) {
      hrWizard.loggedIn = true;
      advanceHrWizard(2, data.message || "Boss 登录态：有效。可直接对话开展招聘。");
      return;
    }
    renderBossLoginResult(data, { mirrorChat: true });
  } catch (err) {
    thinking.remove();
    addBubble("assistant", `检验失败：${err.payload?.message || err.message}`);
  }
}

function resetHrWizard() {
  hrWizardAutoPrompted = false;
  hrWizardDismissed = false;
  hrWizard = {
    step: 1,
    loggedIn: false,
    modeId: null,
    jobTitle: "",
    notes: "",
    open: false,
  };
  hideHrWizardCard();
}

function getWorkModes(employee) {
  return (employee?.modes || []).filter((m) => m.id === "search" || m.id === "inbox");
}

function hideHrWizardCard() {
  const bubble = document.getElementById("hr-wizard-bubble");
  const box = document.getElementById("employee-wizard");
  if (box) {
    box.hidden = true;
    box.innerHTML = "";
  }
  if (bubble) bubble.remove();
  hrWizard.open = false;
}

/** Mount the HR wizard as an inline chat card (not a full-screen modal). */
function ensureHrWizardMount() {
  let bubble = document.getElementById("hr-wizard-bubble");
  if (!bubble) {
    bubble = document.createElement("div");
    bubble.id = "hr-wizard-bubble";
    bubble.className = "bubble assistant wizard-bubble";
    messagesEl.appendChild(bubble);
  }
  let box = document.getElementById("employee-wizard");
  if (!box) {
    box = document.createElement("div");
    box.id = "employee-wizard";
    box.className = "employee-wizard";
    bubble.appendChild(box);
  } else if (box.parentElement !== bubble) {
    bubble.appendChild(box);
  }
  bubble.hidden = false;
  box.hidden = false;
  hrWizard.open = true;
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return box;
}

function renderEmployeeWizard(employee) {
  const modesBox = document.getElementById("employee-modes");
  if (modesBox) {
    modesBox.hidden = true;
    modesBox.innerHTML = "";
  }

  const isHr = employee?.sku === "hr-recruitment" && employee?.active;
  if (!isHr) {
    hideHrWizardCard();
    return;
  }
  if (!hrWizard.open) {
    // Only show when explicitly opened (recruitment intent / user action).
    return;
  }

  const box = ensureHrWizardMount();
  const steps = [{ id: "login", title: "登录 Boss", desc: "自助登录后检验" }];
  const step = hrWizard.loggedIn ? 2 : 1;
  const current = steps[0];
  const doneCount = hrWizard.loggedIn ? 1 : 0;

  const stepsHtml = `
    <div class="wizard-card-head">
      <div class="wizard-progress" aria-label="当前进度">
        <span class="wizard-progress-chip">${hrWizard.loggedIn ? "登录完成" : "自助登录 Boss"}</span>
        ${doneCount > 0 ? `<span class="wizard-progress-done">可直接对话开展招聘</span>` : `<span class="wizard-progress-done">你登录，我只检验登录态</span>`}
      </div>
      <button type="button" class="wizard-dismiss" id="wizard-dismiss-btn">关闭</button>
    </div>`;

  let body = "";
  if (step === 1) {
    const desktop = isDesktopBoss();
    body = `
      <div class="wizard-turn">
        <p class="wizard-turn-label">数字员工</p>
        <h3>${desktop ? "本机 Boss 登录" : "请使用桌面客户端"}</h3>
        <p>${
          desktop
            ? "将打开<strong>本机内嵌 Boss 窗口</strong>（类型 B：只操控 Boss 网页，不操控整台电脑）。请在该窗口自行登录，再点「检验登录态」。"
            : "量产请使用<strong>聚元灵创桌面客户端</strong>（内嵌 Boss 浏览器）。当前网页版无法在本机打开 Boss。"
        }</p>
        <p class="wizard-hint">${
          desktop
            ? "登录会话与出口 IP 都在你这台电脑上，不会走服务器共用浏览器。"
            : "请打开 聚元灵创 Windows 客户端完成登录与验态。"
        }</p>
      </div>
      <div class="wizard-form boss-login-form">
        ${
          desktop
            ? ""
            : `<div id="browser-node-panel" class="browser-node-panel">
          <p id="browser-node-status" class="boss-login-status">网页环境：无本机 Boss 窗口</p>
          <select id="browser-node-select" class="browser-node-select" hidden></select>
          <pre id="browser-node-hint" class="browser-node-hint" hidden></pre>
        </div>`
        }
        <p id="boss-login-status" class="boss-login-status"></p>
        <div id="boss-self-preview" class="boss-self-preview" hidden>
          <p id="boss-self-preview-tip" class="boss-captcha-tip">Boss 窗口预览</p>
          <img id="boss-self-preview-img" class="bubble-image" alt="Boss 预览" draggable="false" />
        </div>
      </div>
      <div class="wizard-actions">
        ${desktop ? "" : `<button type="button" class="employee-mode-btn" id="browser-node-refresh-btn">刷新节点</button>
        <button type="button" class="employee-mode-btn" id="browser-node-bind-btn">绑定选中节点</button>`}
        <button type="button" class="employee-mode-btn" id="wizard-login-btn">${desktop ? "打开 Boss 窗口" : "打开登录页"}</button>
        <button type="button" class="primary" id="wizard-check-login-btn">检验登录态</button>
        <button type="button" class="employee-mode-btn" id="wizard-refresh-preview-btn">刷新预览</button>
        <button type="button" class="employee-mode-btn" id="wizard-skip-login-btn">稍后，先关闭</button>
      </div>`;
  } else {
    body = `
      <div class="wizard-turn">
        <p class="wizard-turn-label">数字员工</p>
        <h3>登录完成</h3>
        <p>接下来直接对话即可。约面试会先给你确认再发。</p>
      </div>
      <div class="wizard-actions">
        <button type="button" class="primary" id="wizard-close-after-login">开始对话</button>
      </div>`;
  }

  box.innerHTML = `<div class="wizard-steps">${stepsHtml}</div><div class="wizard-body">${body}</div>`;

  document.getElementById("wizard-dismiss-btn")?.addEventListener("click", () => {
    hideHrWizardCard();
    hrWizardDismissed = true;
    addBubble("assistant", "已关闭登录引导。你还可以继续聊天；再说招聘相关内容时，我会再次弹出。");
  });
  document.getElementById("wizard-close-after-login")?.addEventListener("click", () => {
    hideHrWizardCard();
    hrWizardDismissed = false;
    addBubble("assistant", "好，直接说你的招聘需求吧。");
  });
  document.getElementById("wizard-login-btn")?.addEventListener("click", () =>
    runBossLoginStart({ restart: true }),
  );
  document.getElementById("wizard-check-login-btn")?.addEventListener("click", () => runBossLoginCheck());
  document.getElementById("wizard-refresh-preview-btn")?.addEventListener("click", () => runBossLoginRefresh());
  document.getElementById("browser-node-refresh-btn")?.addEventListener("click", () => refreshBrowserNodePanel());
  document.getElementById("browser-node-bind-btn")?.addEventListener("click", () => bindSelectedBrowserNode());
  document.getElementById("wizard-skip-login-btn")?.addEventListener("click", () => {
    hideHrWizardCard();
    hrWizardDismissed = true;
    addBubble(
      "assistant",
      "好的。请先在本机跑 Node 并绑定，登录 Boss 后再继续招聘任务。",
    );
  });
  applyBossLoginSnapshot(lastBossLoginSnapshot);
  if (step === 1 && !isDesktopBoss()) refreshBrowserNodePanel();
}

async function refreshBrowserNodePanel() {
  if (!currentEmployee?.sku) return;
  const statusEl = document.getElementById("browser-node-status");
  const selectEl = document.getElementById("browser-node-select");
  const hintEl = document.getElementById("browser-node-hint");
  if (statusEl) statusEl.textContent = "正在检查本机浏览器节点…";
  try {
    const res = await api(`/api/employees/${encodeURIComponent(currentEmployee.sku)}/browser-node`);
    const data = res.data || {};
    if (statusEl) {
      statusEl.textContent = data.message || (data.ready ? "节点就绪" : "节点未就绪");
    }
    if (hintEl) {
      hintEl.hidden = Boolean(data.ready);
      hintEl.textContent = data.installHint || "";
    }
    if (selectEl) {
      const nodes = Array.isArray(data.available) ? data.available.filter((n) => n.connected) : [];
      selectEl.innerHTML = nodes
        .map(
          (n) =>
            `<option value="${escapeHtml(n.nodeId)}" ${
              data.bound?.nodeId === n.nodeId ? "selected" : ""
            }>${escapeHtml(n.displayName || n.nodeId)} (${escapeHtml(n.platform || "pc")})</option>`,
        )
        .join("");
      selectEl.hidden = nodes.length === 0;
    }
  } catch (err) {
    if (statusEl) statusEl.textContent = `节点检查失败：${err.payload?.message || err.message}`;
  }
}

async function bindSelectedBrowserNode() {
  if (!currentEmployee?.sku) return;
  const selectEl = document.getElementById("browser-node-select");
  const nodeId = selectEl?.value;
  if (!nodeId) {
    alert("没有可绑定的在线节点。请先在本机启动 openclaw node。");
    return;
  }
  const opt = selectEl.selectedOptions?.[0];
  addBubble("user", `绑定本机浏览器节点 ${opt?.textContent || nodeId}`);
  const thinking = addThinkingBubble();
  try {
    const res = await api(`/api/employees/${encodeURIComponent(currentEmployee.sku)}/browser-node/bind`, {
      method: "POST",
      body: JSON.stringify({
        nodeId,
        displayName: opt?.textContent || nodeId,
      }),
    });
    thinking.remove();
    addBubble("assistant", res.message || "已绑定本机浏览器节点。接下来打开登录页并自行登录，再检验登录态。");
    await refreshBrowserNodePanel();
  } catch (err) {
    thinking.remove();
    addBubble("assistant", `绑定失败：${err.payload?.message || err.message}`);
  }
}

function advanceHrWizard(nextStep, assistantLine) {
  hrWizard.open = true;
  hrWizard.step = nextStep;
  if (nextStep >= 2) {
    hrWizard.loggedIn = true;
    hideHrWizardCard();
    if (assistantLine) addBubble("assistant", assistantLine);
    return;
  }
  renderEmployeeWizard(currentEmployee);
  if (assistantLine) addBubble("assistant", assistantLine);
}

function openHrWizard(assistantLine) {
  hrWizardDismissed = false;
  hrWizard.open = true;
  hrWizard.step = 1;
  renderEmployeeWizard(currentEmployee);
  if (assistantLine) addBubble("assistant", assistantLine);
}

async function startHrWizardRun() {
  const title = String(document.getElementById("wizard-job-title")?.value || "").trim();
  const notes = String(document.getElementById("wizard-job-notes")?.value || "").trim();
  if (!title) {
    alert("请先填写岗位名称");
    return;
  }
  hrWizard.jobTitle = title;
  hrWizard.notes = notes;
  const mode = getWorkModes(currentEmployee).find((m) => m.id === hrWizard.modeId);
  if (!mode) {
    alert("请先选择工作方式");
    hrWizard.step = 2;
    hrWizard.open = true;
    renderEmployeeWizard(currentEmployee);
    return;
  }

  const prompt = [
    mode.prompt || `请使用【${mode.label}】模式。`,
    `目标岗位：${title}`,
    notes ? `补充要求：${notes}` : "",
    "请直接开始执行，过程中如需确认再简短追问。",
  ]
    .filter(Boolean)
    .join("\n");

  hrWizard.step = 4;
  hideHrWizardCard();
  addBubble("assistant", "引导已完成，开始执行任务。");

  const input = document.getElementById("prompt");
  if (input) input.value = prompt;
  document.getElementById("chat-form")?.requestSubmit();
}

function renderEmployeeModes(employee) {
  // Do not auto-open HR wizard on employee select — wait for recruitment intent.
  const modesBox = document.getElementById("employee-modes");
  if (modesBox) {
    modesBox.hidden = true;
    modesBox.innerHTML = "";
  }
  if (!(employee?.sku === "hr-recruitment" && hrWizard.open)) {
    hideHrWizardCard();
  }
}

function renderEmployees(items) {
  const list = document.getElementById("employee-list");
  const empty = document.getElementById("employee-empty");
  const label = document.getElementById("home-employee-label");
  const composer = document.getElementById("chat-form");
  currentEmployees = items || [];
  currentEmployee = currentEmployees.find((e) => e.selected && e.active) || null;

  if (!currentEmployees.length) {
    list.innerHTML = `<div class="muted" style="padding:8px 10px;font-size:0.82rem">暂无已购员工</div>`;
    if (empty) empty.hidden = false;
    if (composer) composer.hidden = true;
    if (label) label.textContent = "请先在平台购买数字员工";
    renderEmployeeModes(null);
    return;
  }

  if (empty) empty.hidden = true;
  if (composer) composer.hidden = false;
  if (label) {
    label.textContent = currentEmployee
      ? `与「${currentEmployee.name}」对话（独立实例 · 可调教记忆）`
      : "选择一个数字员工开始对话";
  }
  renderEmployeeModes(currentEmployee);
  updateHrBossLoginButton(currentEmployee);
  maybeAutoOpenHrWizard(currentEmployee);

  list.innerHTML = "";
  for (const emp of currentEmployees) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `employee-item${emp.selected ? " active" : ""}`;
    btn.disabled = !emp.active;
    btn.innerHTML = `<span class="emoji">${escapeHtml(emp.emoji || "🤖")}</span>
      <span class="meta"><strong>${escapeHtml(emp.name)}</strong>
      <span>${emp.active ? (emp.selected ? "当前使用" : "可切换") : emp.status}</span></span>`;
    btn.addEventListener("click", async () => {
      try {
        await api(`/api/employees/${encodeURIComponent(emp.sku)}/ensure`, { method: "POST" });
        const selected = await api(`/api/employees/${encodeURIComponent(emp.sku)}/select`, {
          method: "POST",
        });
        currentEmployee = selected.data?.employee || emp;
        resetHrWizard();
        await loadEmployees();
        messagesEl.innerHTML = "";
        if (emp.sku === "hr-recruitment") {
          addBubble(
            "assistant",
            isDesktopBoss()
              ? "已切换到「人事招聘数字员工」。Boss 登录引导在聊天区下方；也可点右上角「Boss 登录」。"
              : "已切换到「人事招聘数字员工」。请使用桌面客户端完成 Boss 登录；聊天里说「打开 Boss 窗口」也会弹出引导。",
          );
          maybeAutoOpenHrWizard(currentEmployee);
        } else {
          addBubble("assistant", `已切换到「${currentEmployee.name}」。`);
        }
      } catch (err) {
        alert(err.payload?.message || err.message);
      }
    });
    list.appendChild(btn);
  }
}

async function loadEmployees() {
  const data = await api("/api/employees");
  renderEmployees(data.data?.items || []);
}

function setPresence(state) {
  const el = document.getElementById("sidebar-status");
  if (!el) return;
  const labels = { online: "在线", offline: "离线", checking: "检测中" };
  el.dataset.state = state;
  const text = el.querySelector(".status-text");
  if (text) text.textContent = labels[state] || labels.checking;
}

let presenceTimer = null;

async function refreshPresence() {
  if (shellView.hidden) return;
  if (!navigator.onLine) {
    setPresence("offline");
    return;
  }
  try {
    const res = await fetch("/api/health", { cache: "no-store" });
    setPresence(res.ok ? "online" : "offline");
  } catch {
    setPresence("offline");
  }
}

function startPresenceWatch() {
  stopPresenceWatch();
  refreshPresence();
  presenceTimer = setInterval(refreshPresence, 15000);
}

function stopPresenceWatch() {
  if (presenceTimer) {
    clearInterval(presenceTimer);
    presenceTimer = null;
  }
}

window.addEventListener("online", () => {
  setPresence("checking");
  refreshPresence();
});
window.addEventListener("offline", () => setPresence("offline"));

function showLogin() {
  shellView.hidden = true;
  loginView.hidden = false;
  stopPresenceWatch();
  document.getElementById("captcha-modal").hidden = true;
  setLoginMode(loginMode || "password");
}

function showShell() {
  loginView.hidden = true;
  shellView.hidden = false;
  applyAppearance(currentSettings);
  applyProfile(currentUser);
  fillSettingsForms();
  showPage("home");
  loadEmployees().catch((err) => {
    const list = document.getElementById("employee-list");
    if (list) list.textContent = `加载失败：${err.message}`;
  });
  loadSkills();
  startPresenceWatch();
}

function showPage(page) {
  document.querySelectorAll(".page").forEach((el) => {
    el.hidden = el.id !== `page-${page}`;
  });
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.page === page);
  });
  if (page === "settings") {
    showSettings("profile");
    refreshMe()
      .then(() => {
        applyProfile(currentUser);
        fillSettingsForms();
      })
      .catch(() => fillSettingsForms());
    loadNotifications();
  }
  if (page === "skills") loadSkills();
}

function showSettings(section) {
  document.querySelectorAll(".settings-panel").forEach((el) => {
    el.hidden = el.id !== `settings-${section}`;
  });
  document.querySelectorAll(".settings-item[data-settings]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.settings === section);
  });
}

function fillSettingsForms() {
  const isPlatform = Boolean(currentUser?.platformUuid || currentUser?.uuid);
  document.getElementById("profile-display-name").value = currentUser?.nickname || "";
  document.getElementById("profile-bio").value = currentUser?.bio || "";

  const accountRow = document.getElementById("profile-account-row");
  const phoneRow = document.getElementById("profile-phone-row");
  const bioRow = document.getElementById("profile-bio-row");
  const hint = document.getElementById("profile-source-hint");
  const account = currentUser?.account || currentUser?.username || "";
  const phone = currentUser?.phone || "";

  if (accountRow) {
    accountRow.hidden = !isPlatform;
    document.getElementById("profile-account").value = account;
  }
  if (phoneRow) {
    phoneRow.hidden = !isPlatform || !phone;
    document.getElementById("profile-phone").value = phone;
  }
  if (bioRow) {
    // Platform users have no bio field; keep bio only for local demo accounts.
    bioRow.hidden = isPlatform;
  }
  if (hint) {
    hint.hidden = !isPlatform;
    hint.textContent = isPlatform
      ? "与平台账号资料同步：修改显示名称将保存到平台个人资料。"
      : "";
  }

  document.getElementById("appearance-theme").value = currentSettings?.appearance?.theme || "light";
  document.getElementById("appearance-font-size").value = currentSettings?.appearance?.fontSize || "md";
  document.getElementById("appearance-compact").checked = Boolean(currentSettings?.appearance?.compact);
  document.getElementById("notify-desktop").checked = Boolean(currentSettings?.notifications?.desktop);
  document.getElementById("notify-sound").checked = Boolean(currentSettings?.notifications?.sound);
  document.getElementById("notify-important-only").checked = Boolean(
    currentSettings?.notifications?.importantOnly,
  );
}

async function refreshMe() {
  const data = await api("/api/me");
  currentUser = data.user;
  currentSettings = data.settings;
}

async function loadSkills() {
  showError(skillsError, "");
  skillsList.innerHTML = "加载中…";
  try {
    const data = await api("/api/skills");
    const skills = data.data?.skills || data.skills || [];
    skillsList.innerHTML = "";
    if (!skills.length) {
      skillsList.innerHTML = `<p class="muted">暂无可用技能（已过滤调试项与缺二进制依赖项）</p>`;
      return;
    }
    for (const skill of skills) {
      const card = document.createElement("div");
      card.className = "skill-card";
      const status = skill.needsSetup
        ? `<span class="skill-status warn">需配置</span>`
        : `<span class="skill-status ok">就绪</span>`;
      const setupRow = skill.needsSetup
        ? `<div class="skill-setup">
             <input type="password" data-skill-key="${skill.id}" placeholder="${skill.setupHint || "填写 API Key"}" autocomplete="off" />
           </div>`
        : "";
      card.innerHTML = `
        <div class="skill-badge">${escapeHtml(skill.emoji || "技能")}</div>
        <div class="skill-body">
          <div class="skill-title-row">
            <h3>${escapeHtml(skill.name)}</h3>
            ${status}
          </div>
          <p>${escapeHtml(skill.description || "")}</p>
          ${setupRow}
        </div>
        <label class="switch" title="启用/关闭（写入 Gateway）">
          <input type="checkbox" data-skill-id="${escapeHtml(skill.id)}" ${skill.enabled ? "checked" : ""} />
          <span></span>
        </label>
      `;
      skillsList.appendChild(card);
    }
    skillsList.querySelectorAll("input[data-skill-id]").forEach((input) => {
      input.addEventListener("change", async () => {
        const skillId = input.dataset.skillId;
        const keyInput = skillsList.querySelector(`input[data-skill-key="${CSS.escape(skillId)}"]`);
        const apiKey = keyInput?.value?.trim() || undefined;
        try {
          await api(`/api/skills/${encodeURIComponent(skillId)}/toggle`, {
            method: "POST",
            body: JSON.stringify({
              enabled: input.checked,
              ...(apiKey ? { apiKey } : {}),
            }),
          });
          if (input.checked && keyInput) keyInput.value = "";
          await loadSkills();
        } catch (err) {
          input.checked = !input.checked;
          showError(skillsError, err.message);
        }
      });
    });
  } catch (err) {
    skillsList.innerHTML = "";
    showError(skillsError, `加载技能失败：${err.message}`);
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isRecruitmentIntent(text) {
  const raw = String(text || "");
  if (!raw.trim()) return false;
  // If it's clearly weather/temperature small talk, don't gate the HR login wizard.
  if (
    /天气|温度|降雨|气象|风力|湿度|日出日落/i.test(raw) ||
    /\b(weather|temperature|rain|forecast|humidity|wind)\b/i.test(raw)
  ) {
    return false;
  }
  return /招聘|招人|投递|筛投递|简历|岗位|jd|面试|候选人|猎头|搜索人|搜索简历|人事招聘|招聘信息|Boss直聘|Boss直聘|boss直聘|boss|zhipin/i.test(
    raw,
  );
}

async function loadNotifications() {
  notificationsList.innerHTML = "加载中…";
  try {
    const data = await api("/api/notifications");
    const items = data.data?.items || [];
    notificationsList.innerHTML = "";
    if (!items.length) {
      notificationsList.textContent = "暂无通知";
      return;
    }
    for (const item of items) {
      const el = document.createElement("div");
      el.className = `note-item${item.isRead ? "" : " unread"}`;
      el.innerHTML = `<strong>${item.title}</strong><p>${item.body}</p>`;
      el.addEventListener("click", async () => {
        if (!item.isRead) {
          await api(`/api/notifications/${item.id}/read`, { method: "POST" });
          el.classList.remove("unread");
          item.isRead = true;
        }
      });
      notificationsList.appendChild(el);
    }
  } catch (err) {
    notificationsList.textContent = `加载失败：${err.message}`;
  }
}

async function finishLogin(data) {
  if (!data?.data?.access_token) {
    throw new Error("登录响应无效");
  }
  setToken(data.data.access_token);
  if (data.data.platform_access_token) {
    sessionStorage.setItem(PLATFORM_TOKEN_KEY, data.data.platform_access_token);
    localStorage.removeItem(PLATFORM_TOKEN_KEY);
  }
  currentUser = data.data.user;
  if (new URLSearchParams(window.location.search).get("desktopLogin") === "1") {
    if (!window.chrome?.webview) {
      throw new Error("桌面客户端登录通道不可用");
    }
    window.chrome.webview.postMessage({
      type: "juyuan.login.completed",
      accessToken: data.data.access_token,
    });
    return;
  }
  await refreshMe();
  showShell();
}

async function doPasswordLogin() {
  const account = document.getElementById("account").value.trim();
  const password = document.getElementById("password").value;
  if (!account || !password) {
    throw new Error("请输入账号和密码");
  }
  await requestCaptcha("login");

  let body = {
    login_type: "account_password",
    account,
    password,
    encryption: "plain",
  };
  try {
    const publicKey = await loadPublicKey();
    if (publicKey) {
      const encryptedPassword = await rsaEncryptPassword(password, publicKey);
      body = {
        login_type: "account_password",
        account,
        encryptedPassword,
        encryptionType: "rsa",
      };
    }
  } catch {
    // Fall back to plain password if WebCrypto/RSA unavailable.
  }

  const data = await api("/api/auth/login", {
    method: "POST",
    body: JSON.stringify(body),
  });
  await finishLogin(data);
}

async function doSmsLogin() {
  const phone = document.getElementById("phone").value.trim();
  const smsCode = document.getElementById("sms-code").value.trim();
  if (!/^1\d{10}$/.test(phone)) {
    throw new Error("请输入正确的手机号");
  }
  if (!smsCode) {
    throw new Error("请输入短信验证码");
  }
  // After send-sms, platform already marked captcha scene=login passed.
  // If that pass expired, ask captcha again with scene=login.
  let data;
  try {
    data = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        login_type: "phone_sms",
        phone,
        sms_code: smsCode,
      }),
    });
  } catch (err) {
    const needCaptcha =
      err.payload?.message?.includes("验证码") || err.payload?.error === "captcha_required";
    if (!needCaptcha) throw err;
    await requestCaptcha("login");
    data = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        login_type: "phone_sms",
        phone,
        sms_code: smsCode,
      }),
    });
  }
  await finishLogin(data);
}

async function doLogin() {
  const btn = document.getElementById("login-btn");
  showError(loginError, "");
  btn.disabled = true;
  const oldText = btn.textContent;
  btn.textContent = "登录中…";
  try {
    if (loginMode === "sms") {
      await doSmsLogin();
    } else {
      await doPasswordLogin();
    }
  } catch (err) {
    if (err.message === "已取消验证") {
      showError(loginError, "");
      return;
    }
    const msg =
      err.payload?.message ||
      (err.payload?.error === "invalid_credentials"
        ? "账号或密码错误"
        : err.message || "登录失败");
    showError(loginError, msg);
  } finally {
    btn.disabled = false;
    btn.textContent = oldText;
  }
}

document.getElementById("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await doLogin();
});

document.querySelectorAll(".login-tab").forEach((btn) => {
  btn.addEventListener("click", () => setLoginMode(btn.dataset.loginMode));
});

document.getElementById("sms-send-btn")?.addEventListener("click", async () => {
  const btn = document.getElementById("sms-send-btn");
  showError(loginError, "");
  btn.disabled = true;
  try {
    await sendSmsCode();
  } catch (err) {
    if (err.message !== "已取消验证") {
      showError(loginError, err.payload?.message || err.message || "发送失败");
    }
    if (smsCooldownLeft <= 0) {
      btn.disabled = false;
      btn.textContent = "获取验证码";
    }
  }
});

document.getElementById("captcha-angle")?.addEventListener("input", applyCaptchaAngle);
window.addEventListener("resize", () => {
  layoutCaptchaPiece();
  applyCaptchaAngle();
});
document.getElementById("captcha-refresh")?.addEventListener("click", async () => {
  showError(document.getElementById("captcha-error"), "");
  try {
    await refreshCaptcha(captchaState.scene || "login");
  } catch (err) {
    showError(document.getElementById("captcha-error"), err.message || "验证码刷新失败");
  }
});
document.getElementById("captcha-cancel")?.addEventListener("click", () => {
  closeCaptchaModal("cancel");
});
document.getElementById("captcha-confirm")?.addEventListener("click", () => {
  confirmCaptchaModal();
});
document.getElementById("captcha-modal")?.addEventListener("click", (event) => {
  if (event.target?.id === "captcha-modal") closeCaptchaModal("cancel");
});

document.getElementById("logout-btn").addEventListener("click", () => {
  clearToken();
  currentUser = null;
  currentSettings = null;
  messagesEl.innerHTML = "";
  showLogin();
});

document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => showPage(btn.dataset.page));
});

document.querySelectorAll(".settings-item[data-settings]").forEach((btn) => {
  btn.addEventListener("click", () => showSettings(btn.dataset.settings));
});

document.getElementById("restart-client-btn")?.addEventListener("click", async () => {
  const ok = window.confirm("确定要重启客户端吗？");
  if (!ok) return;
  try {
    if (window.desktopApp?.restart) {
      await window.desktopApp.restart();
      return;
    }
  } catch (err) {
    console.error(err);
  }
  // 浏览器或旧版客户端：退化为整页刷新
  window.location.reload();
});

document.getElementById("save-profile").addEventListener("click", async () => {
  const msg = document.getElementById("profile-msg");
  try {
    const isPlatform = Boolean(currentUser?.platformUuid || currentUser?.uuid);
    const body = {
      nickname: document.getElementById("profile-display-name").value.trim(),
    };
    if (!isPlatform) {
      body.bio = document.getElementById("profile-bio").value.trim();
    }
    const data = await api("/api/user/profile", {
      method: "POST",
      body: JSON.stringify(body),
    });
    currentUser = data.data;
    applyProfile(currentUser);
    fillSettingsForms();
    showOk(msg, "已保存");
  } catch (err) {
    showOk(msg, "");
    alert(err.message);
  }
});

document.getElementById("save-appearance").addEventListener("click", async () => {
  const msg = document.getElementById("appearance-msg");
  try {
    const data = await api("/api/user/settings/appearance", {
      method: "POST",
      body: JSON.stringify({
        theme: document.getElementById("appearance-theme").value,
        fontSize: document.getElementById("appearance-font-size").value,
        compact: document.getElementById("appearance-compact").checked,
      }),
    });
    currentSettings = data.data;
    applyAppearance(currentSettings);
    showOk(msg, "已保存");
  } catch (err) {
    showOk(msg, "");
    alert(err.message);
  }
});

document.getElementById("save-notifications").addEventListener("click", async () => {
  const msg = document.getElementById("notifications-msg");
  try {
    const data = await api("/api/user/settings/notifications", {
      method: "POST",
      body: JSON.stringify({
        desktop: document.getElementById("notify-desktop").checked,
        sound: document.getElementById("notify-sound").checked,
        importantOnly: document.getElementById("notify-important-only").checked,
      }),
    });
    currentSettings = data.data;
    if (currentSettings.notifications.desktop && "Notification" in window && Notification.permission === "default") {
      await Notification.requestPermission();
    }
    showOk(msg, "已保存");
    loadNotifications();
  } catch (err) {
    showOk(msg, "");
    alert(err.message);
  }
});

function renderPipelineFollowups(pipeline) {
  if (!pipeline) return;
  // 后端确认已登录：不再强制展示 Boss 登录引导卡片。
  if (pipeline.loggedIn) {
    hrWizard.loggedIn = true;
    if (hrWizard.open) hideHrWizardCard();
  }

  // 后端要求开引导：仅在未登录时打开；若用户已手动关闭，则抑制。
  if (pipeline.openLoginWizard) {
    const backendLoggedIn = Boolean(pipeline.loggedIn);
    hrWizard.loggedIn = backendLoggedIn;
    if (!backendLoggedIn) {
      if (!hrWizardDismissed) openHrWizard(null);
    } else {
      hideHrWizardCard();
    }
  }

  if (Array.isArray(pipeline.clientActions) && pipeline.clientActions.length) {
    void executeClientActions(pipeline.clientActions);
  }

  const planPending =
    pipeline.requireConfirm && pipeline.pendingPlan?.status === "awaiting_confirm";
  const invitePending =
    pipeline.requireConfirm || pipeline.pendingInvite?.status === "pending_confirm";

  if (planPending) {
    const wrap = document.createElement("div");
    wrap.className = "bubble assistant pipeline-actions";
    const summary = pipeline.pendingPlan?.summary || {};
    const bits = [
      summary.jobTitle ? `岗位 ${summary.jobTitle}` : null,
      summary.headcount ? `${summary.headcount} 人` : null,
      summary.city || null,
      summary.requirements || null,
    ].filter(Boolean);
    wrap.innerHTML = `
      <div class="pipeline-action-card">
        <p>招聘计划待确认${bits.length ? `：${bits.join(" · ")}` : ""}（确认后才在本机 Boss 执行）</p>
        <div class="wizard-actions">
          <button type="button" class="primary" data-pipe-act="confirm_plan">确认执行</button>
          <button type="button" class="employee-mode-btn" data-pipe-act="cancel_plan">先别执行</button>
        </div>
      </div>`;
    messagesEl.appendChild(wrap);
    wrap.querySelectorAll("[data-pipe-act]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const action = btn.getAttribute("data-pipe-act");
        const label = action === "confirm_plan" ? "确认执行" : "先别执行";
        addBubble("user", label);
        const thinking = addThinkingBubble();
        try {
          const res = await api(
            `/api/employees/${encodeURIComponent(currentEmployee.sku)}/pipeline/act`,
            { method: "POST", body: JSON.stringify({ action }) },
          );
          thinking.remove();
          const data = res.data || {};
          addBubble("assistant", data.reply || "已处理");
          renderPipelineFollowups(data);
        } catch (err) {
          thinking.remove();
          addBubble("assistant", `操作失败：${err.payload?.message || err.message}`);
        }
      });
    });
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return;
  }

  if (invitePending) {
    const wrap = document.createElement("div");
    wrap.className = "bubble assistant pipeline-actions";
    wrap.innerHTML = `
      <div class="pipeline-action-card">
        <p>邀约草稿待确认（确认后才会代聊发送）</p>
        <div class="wizard-actions">
          <button type="button" class="primary" data-pipe-act="confirm_invite">确认发送</button>
          <button type="button" class="employee-mode-btn" data-pipe-act="cancel_invite">取消邀约</button>
        </div>
      </div>`;
    messagesEl.appendChild(wrap);
    wrap.querySelectorAll("[data-pipe-act]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const action = btn.getAttribute("data-pipe-act");
        const label = action === "confirm_invite" ? "确认发送" : "取消邀约";
        addBubble("user", label);
        const thinking = addThinkingBubble();
        try {
          const res = await api(
            `/api/employees/${encodeURIComponent(currentEmployee.sku)}/pipeline/act`,
            { method: "POST", body: JSON.stringify({ action }) },
          );
          thinking.remove();
          const data = res.data || {};
          addBubble("assistant", data.reply || "已处理");
          // Only re-show confirm UI when a pending draft still exists.
          if (
            data.requireConfirm ||
            data.pendingInvite?.status === "pending_confirm" ||
            data.pendingPlan?.status === "awaiting_confirm"
          ) {
            renderPipelineFollowups(data);
          } else if (Array.isArray(data.clientActions) && data.clientActions.length) {
            void executeClientActions(data.clientActions);
          }
        } catch (err) {
          thinking.remove();
          addBubble("assistant", `操作失败：${err.payload?.message || err.message}`);
        }
      });
    });
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return;
  }

  if (Array.isArray(pipeline.actions) && pipeline.actions.length) {
    const wrap = document.createElement("div");
    wrap.className = "bubble assistant pipeline-actions";
    const allowed = new Set(["auto_advance", "status"]);
    const actions = pipeline.actions.filter((item) => allowed.has(item?.id));
    if (!actions.length) return;
    wrap.innerHTML = `
      <div class="pipeline-action-card">
        <p>下一步</p>
        <div class="wizard-actions">
          ${actions
            .map(
              (item, index) =>
                `<button type="button" class="${index === 0 ? "primary" : "employee-mode-btn"}" data-pipe-next="${item.id}">${item.label}</button>`,
            )
            .join("")}
        </div>
      </div>`;
    messagesEl.appendChild(wrap);
    wrap.querySelectorAll("[data-pipe-next]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const action = btn.getAttribute("data-pipe-next");
        addBubble("user", btn.textContent || "继续");
        const thinking = addThinkingBubble();
        try {
          const res = await api(
            `/api/employees/${encodeURIComponent(currentEmployee.sku)}/pipeline/act`,
            { method: "POST", body: JSON.stringify({ action }) },
          );
          thinking.remove();
          const data = res.data || {};
          addBubble("assistant", data.reply || "已处理");
          renderPipelineFollowups(data);
        } catch (err) {
          thinking.remove();
          addBubble("assistant", `操作失败：${err.payload?.message || err.message}`);
        }
      });
    });
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

document.getElementById("chat-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  showError(chatError, "");
  const input = document.getElementById("prompt");
  const message = input.value.trim();
  if (!message || input.disabled) return;
  if (!currentEmployee?.active) {
    showError(chatError, "请先选择已购数字员工后再对话");
    return;
  }

  input.value = "";
  addBubble("user", message);

  // 显式退出 Boss 登录引导：立刻关闭并抑制下一轮自动/后端强制弹出。
  if (currentEmployee?.sku === "hr-recruitment" && matchBossLoginExitAction(message)) {
    hrWizardDismissed = true;
    hideHrWizardCard();
    addBubble(
      "assistant",
      "好的。我先不再展示 Boss 登录引导。你继续招聘时再点「Boss 登录」或说「打开 Boss 窗口」。",
    );
    return;
  }

  const bossAction =
    currentEmployee?.sku === "hr-recruitment" ? matchBossChatAction(message) : null;
  if (bossAction) {
    setComposerBusy(true);
    try {
      const handled = await handleBossChatAction(bossAction, { skipUserBubble: true });
      if (!handled && !isDesktopBoss()) {
        const thinking = addThinkingBubble();
        try {
          const data = await api("/api/chat", {
            method: "POST",
            body: JSON.stringify({ message }),
          });
          thinking.remove();
          addBubble("assistant", collapseRepeatedReply(data.reply || "(空回复)"));
          if (data.pipeline) renderPipelineFollowups(data.pipeline);
        } catch (err) {
          thinking.remove();
          const detail =
            err.payload?.message ||
            err.payload?.detail?.error?.message ||
            err.payload?.detail?.message ||
            err.payload?.error ||
            err.message;
          showError(chatError, `发送失败：${detail}`);
          addBubble("assistant", `（失败）${detail}`);
        }
      }
    } finally {
      setComposerBusy(false);
      input.focus();
    }
    return;
  }

  if (currentEmployee?.sku === "hr-recruitment" && isRecruitmentIntent(message)) {
    // 登录完成后不要再重复展示“登录完成/开始对话”卡片。
    if (!hrWizard.loggedIn) {
      hrWizardDismissed = false;
      openHrWizard("开始招聘任务前，请先完成下方 Boss 登录引导。");
    }
  }

  const thinking = addThinkingBubble();
  setComposerBusy(true);
  try {
    const data = await api("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message }),
    });
    thinking.remove();
    const reply = collapseRepeatedReply(data.reply || "(空回复)");
    addBubble("assistant", reply);
    if (data.pipeline) renderPipelineFollowups(data.pipeline);
  } catch (err) {
    thinking.remove();
    const detail =
      err.payload?.message ||
      err.payload?.detail?.error?.message ||
      err.payload?.detail?.message ||
      err.payload?.error ||
      err.message;
    showError(chatError, `发送失败：${detail}`);
    addBubble("assistant", `（失败）${detail}`);
  } finally {
    setComposerBusy(false);
    input.focus();
  }
});

async function boot() {
  // Force login on each app open: drop durable tokens left by older builds.
  // In-session tokens live in sessionStorage only (survives refresh, not relaunch).
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(PLATFORM_TOKEN_KEY);

  const token = getToken();
  if (!token) {
    showLogin();
    return;
  }
  try {
    await refreshMe();
    showShell();
  } catch {
    clearToken();
    showLogin();
  }
}

boot();

document.getElementById("hr-boss-login-btn")?.addEventListener("click", () => {
  if (currentEmployee?.sku !== "hr-recruitment") return;
  openHrWizard("在下方引导完成 Boss 自助登录。");
  messagesEl.scrollTop = messagesEl.scrollHeight;
});
