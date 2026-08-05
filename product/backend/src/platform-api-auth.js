/**
 * Platform HTTP auth client (affiliate login path).
 * Talks to ai-project `/auth/*` the same way the platform website does.
 * Never writes the platform database.
 */

const CAPTCHA_COOKIE = "captcha_session_id";

export function platformApiConfigured() {
  return Boolean(String(process.env.PLATFORM_API_BASE_URL || "").trim());
}

export function platformApiBaseUrl() {
  return String(process.env.PLATFORM_API_BASE_URL || "")
    .trim()
    .replace(/\/$/, "");
}

function extractSetCookieSessionId(res) {
  const raw =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : res.headers.get("set-cookie")
        ? [res.headers.get("set-cookie")]
        : [];
  for (const line of raw) {
    const match = String(line || "").match(
      new RegExp(`${CAPTCHA_COOKIE}=([^;]+)`),
    );
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return null;
}

/**
 * @param {string} path e.g. "/auth/login"
 * @param {{ method?: string, body?: object, sessionId?: string }} opts
 */
export async function platformAuthRequest(path, opts = {}) {
  const base = platformApiBaseUrl();
  if (!base) throw new Error("platform_api_not_configured");

  const method = opts.method || "GET";
  const headers = {
    Accept: "application/json",
  };
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const sessionId = String(opts.sessionId || "").trim();
  if (sessionId) {
    headers["X-Session-ID"] = sessionId;
    headers.Cookie = `${CAPTCHA_COOKIE}=${sessionId}`;
  }

  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  let data = null;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { state: res.status, message: text || "invalid_json", data: null };
  }

  const fromSetCookie = extractSetCookieSessionId(res);
  return {
    httpStatus: res.status,
    state: Number(data?.state ?? res.status),
    message: String(data?.message || ""),
    data: data?.data ?? null,
    sessionId: fromSetCookie || sessionId || null,
    raw: data,
  };
}

export async function platformGetPublicKey() {
  return platformAuthRequest("/auth/public-key", { method: "GET" });
}

export async function platformCreateRotateCaptcha(sessionId, scene = "login") {
  return platformAuthRequest("/auth/captcha/rotate/create", {
    method: "POST",
    body: { scene },
    sessionId,
  });
}

export async function platformVerifyRotateCaptcha(sessionId, captchaId, angle, scene = "login") {
  return platformAuthRequest("/auth/captcha/rotate/verify", {
    method: "POST",
    body: {
      captcha_id: captchaId,
      angle,
      scene,
    },
    sessionId,
  });
}

/**
 * Account/password or phone_sms login — same contract as platform POST /auth/login.
 */
export async function platformLogin(sessionId, body) {
  return platformAuthRequest("/auth/login", {
    method: "POST",
    body,
    sessionId,
  });
}

/** Platform POST /auth/send-sms-code (login scene consumes captcha scene login-sms). */
export async function platformSendSmsCode(sessionId, phone, scene = "login") {
  return platformAuthRequest("/auth/send-sms-code", {
    method: "POST",
    body: { phone, scene },
    sessionId,
  });
}

/**
 * Authenticated platform API call (Bearer = platform access_token).
 * Used for affiliate profile sync — never writes the platform DB directly.
 */
export async function platformAuthedRequest(path, opts = {}) {
  const base = platformApiBaseUrl();
  if (!base) throw new Error("platform_api_not_configured");
  const accessToken = String(opts.accessToken || "").trim();
  if (!accessToken) throw new Error("platform_token_missing");

  const method = opts.method || "GET";
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${accessToken}`,
  };
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  let data = null;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { state: res.status, message: text || "invalid_json", data: null };
  }

  return {
    httpStatus: res.status,
    state: Number(data?.state ?? res.status),
    message: String(data?.message || ""),
    data: data?.data ?? null,
    raw: data,
  };
}

/** Platform GET /user/profile — source of truth for affiliate personal profile. */
export async function platformGetProfile(accessToken) {
  return platformAuthedRequest("/user/profile", {
    method: "GET",
    accessToken,
  });
}

/** Resolve the authenticated user's dedicated Gateway without exposing its service credential. */
export async function platformResolveDesktopGateway(accessToken) {
  const configuredUrl = String(process.env.PLATFORM_DESKTOP_GATEWAY_URL || "").trim();
  const serviceToken = String(process.env.PLATFORM_DESKTOP_GATEWAY_SERVICE_TOKEN || "").trim();
  if (!configuredUrl) throw new Error("platform_desktop_gateway_api_not_configured");
  if (!serviceToken) throw new Error("platform_desktop_gateway_service_token_not_configured");

  const base = platformApiBaseUrl();
  const isAbsoluteUrl = /^[a-z][a-z\d+.-]*:/i.test(configuredUrl);
  const url = new URL(configuredUrl, base ? `${base}/` : undefined);
  if (isAbsoluteUrl && url.protocol !== "https:") {
    throw new Error("platform_desktop_gateway_api_must_use_https");
  }

  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${serviceToken}`,
      "X-Platform-User-Authorization": `Bearer ${accessToken}`,
    },
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(payload?.message || `platform_desktop_gateway_http_${res.status}`);
  }

  const data = payload?.data ?? payload;
  const gatewayUrl = data?.gateway_url ?? data?.gatewayUrl;
  const gatewayRpcUrl = data?.gateway_rpc_url ?? data?.gatewayRpcUrl ?? gatewayUrl;
  const gatewayToken = data?.gateway_token ?? data?.gatewayToken;
  // Optional read-only model projection for client display (never includes LLM apiKey).
  const models = Array.isArray(data?.models) ? data.models : undefined;
  const defaultModel = data?.default_model ?? data?.defaultModel ?? undefined;
  const llmBaseUrl = data?.llm_base_url ?? data?.llmBaseUrl ?? undefined;
  const llmApiKey = data?.llm_api_key ?? data?.llmApiKey ?? undefined;
  const computeBalance = normalizeComputeBalance(
    data?.compute_balance ?? data?.computeBalance ?? data?.balance,
  );
  return {
    gatewayUrl,
    gatewayRpcUrl,
    gatewayToken,
    models,
    defaultModel,
    llmBaseUrl,
    // BFF-only: never forward llmApiKey to Windows Hub / browsers.
    llmApiKey: typeof llmApiKey === "string" && llmApiKey.trim() ? llmApiKey.trim() : undefined,
    computeBalance,
  };
}

function normalizeComputeBalance(raw) {
  if (raw == null) return undefined;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return {
      object: "juyuancloud.compute_balance",
      balance: Math.max(0, raw),
      ledger_sum: Math.max(0, raw),
      unit: "RH",
      currency: "compute",
    };
  }
  if (typeof raw !== "object") return undefined;
  const balance = Number(raw.balance);
  if (!Number.isFinite(balance)) return undefined;
  const ledger = Number(raw.ledger_sum ?? raw.ledgerSum ?? balance);
  return {
    object: String(raw.object || "juyuancloud.compute_balance"),
    user_uuid: raw.user_uuid ?? raw.userUuid ?? undefined,
    balance: Math.max(0, balance),
    ledger_sum: Number.isFinite(ledger) ? Math.max(0, ledger) : Math.max(0, balance),
    unit: String(raw.unit || "RH"),
    currency: String(raw.currency || "compute"),
  };
}

/**
 * Resolve the signed-in user's compute (RH) balance for Windows Hub display.
 * Prefer platform desktop-gateway snapshot; else call GET {llmBase}/balance with
 * the per-user LLM apiKey (BFF-only). Never returns llmApiKey to callers' HTTP clients.
 */
export async function platformFetchComputeBalance(accessToken) {
  const assignment = await platformResolveDesktopGateway(accessToken);
  if (assignment.computeBalance) {
    return assignment.computeBalance;
  }

  const baseFromEnv = String(process.env.PLATFORM_GATEWAY_LLM_BASE_URL || "").trim();
  const llmBaseUrl = String(
    assignment.llmBaseUrl ||
      baseFromEnv ||
      (platformApiBaseUrl() ? `${platformApiBaseUrl()}/api/gateway` : ""),
  )
    .trim()
    .replace(/\/$/, "");
  const llmApiKey =
    assignment.llmApiKey ||
    String(process.env.PLATFORM_GATEWAY_LLM_API_KEY || "").trim() ||
    undefined;

  if (!llmBaseUrl || !llmApiKey) {
    throw new Error("compute_balance_unavailable");
  }

  const res = await fetch(`${llmBaseUrl}/balance`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${llmApiKey}`,
    },
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const code = payload?.error?.code || payload?.code;
    throw new Error(code || `compute_balance_http_${res.status}`);
  }
  const normalized = normalizeComputeBalance(payload);
  if (!normalized) {
    throw new Error("compute_balance_invalid");
  }
  return normalized;
}

/** Platform POST /user/update — nickname/avatar updates for the logged-in user. */
export async function platformUpdateUser(accessToken, body) {
  return platformAuthedRequest("/user/update", {
    method: "POST",
    accessToken,
    body,
  });
}

export function mapPlatformUser(platformUser) {
  const u = platformUser || {};
  return {
    uuid: u.uuid,
    account: u.account || u.phone || "",
    phone: u.phone || "",
    nickname: u.nickname || u.account || u.phone || "",
    avatar: typeof u.avatar === "string" ? u.avatar : "",
    email: u.email || "",
    userType: u.user_type,
    roleType: u.role_type,
    accountStatus: u.account_status,
  };
}
