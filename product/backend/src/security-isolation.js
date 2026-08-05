/**
 * Product-layer security: tenant isolation + gateway hardening.
 *
 * Contracts:
 * - Boss automation never shares a server browser across tenants (client IP ≠ server IP).
 * - Per-user agent workspace / memory / HR rows stay scoped by user_id / platform_uuid.
 * - BFF never exposes raw Gateway control plane to browsers.
 * - Rate-limit auth-sensitive and Boss action endpoints per user/IP.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { resolve, sep } from "node:path";
import { resolveWorkspaceDir } from "./digital-employees.js";

const buckets = new Map();

function nowMs() {
  return Date.now();
}

function pruneBucket(key, windowMs) {
  const bucket = buckets.get(key);
  if (!bucket) return;
  const cutoff = nowMs() - windowMs;
  while (bucket.length && bucket[0] < cutoff) bucket.shift();
  if (!bucket.length) buckets.delete(key);
}

/**
 * Sliding-window rate limit. Returns { ok, retryAfterMs }.
 */
export function checkRateLimit(key, { limit = 60, windowMs = 60_000 } = {}) {
  const k = String(key || "anon");
  pruneBucket(k, windowMs);
  let bucket = buckets.get(k);
  if (!bucket) {
    bucket = [];
    buckets.set(k, bucket);
  }
  if (bucket.length >= limit) {
    const retryAfterMs = Math.max(0, windowMs - (nowMs() - bucket[0]));
    return { ok: false, retryAfterMs, remaining: 0 };
  }
  bucket.push(nowMs());
  return { ok: true, retryAfterMs: 0, remaining: Math.max(0, limit - bucket.length) };
}

export function clientIp(req) {
  const xf = String(req.headers["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
  return xf || req.ip || req.socket?.remoteAddress || "unknown";
}

/**
 * Fail closed if BOSS_BROWSER_MODE=server outside explicit allow.
 * Production default must keep Boss on the employer's machine.
 */
export function assertBossBrowserIsolation() {
  const mode = String(process.env.BOSS_BROWSER_MODE || "user_node").trim().toLowerCase();
  const allowServer =
    process.env.BOSS_ALLOW_SERVER_BROWSER === "1" || process.env.NODE_ENV === "development";
  if (mode === "server" && !allowServer) {
    const err = new Error(
      "server_browser_forbidden: Boss 必须在用户本机运行（客户端出口 IP），禁止共用服务器浏览器。",
    );
    err.code = "server_browser_forbidden";
    throw err;
  }
  return mode === "server" ? "server" : "user_node";
}

/** Workspace path must stay under the digital-employee root for this agentId. */
export function assertWorkspaceOwnedByAgent(agentId, candidatePath) {
  const root = resolve(resolveWorkspaceDir(agentId));
  const target = resolve(String(candidatePath || ""));
  const ok = target === root || target.startsWith(root + sep);
  if (!ok) {
    const err = new Error("workspace_path_escape");
    err.code = "workspace_path_escape";
    throw err;
  }
  return target;
}

/** HR / entitlement rows must belong to the authenticated user. */
export function assertSameUser(rowUserId, authUserId, label = "resource") {
  if (Number(rowUserId) !== Number(authUserId)) {
    const err = new Error(`${label}_tenant_mismatch`);
    err.code = "tenant_isolation";
    throw err;
  }
}

/**
 * Constant-time compare for shared secrets (webhook / internal tokens).
 */
export function safeEqualString(a, b) {
  const left = Buffer.from(String(a || ""), "utf8");
  const right = Buffer.from(String(b || ""), "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function fingerprintUser(user) {
  const raw = `${user?.id || ""}:${user?.platform_uuid || user?.platformUuid || ""}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

/**
 * Fastify plugin: security headers + per-IP/user rate limits on mutating APIs.
 */
export async function registerSecurityGuards(app, { pool: _pool } = {}) {
  app.addHook("onRequest", async (req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-OpenClaw-Tenant-Isolation", "per-user");
    // Never advertise Gateway internals.
    reply.removeHeader("X-Powered-By");
  });

  app.addHook("preHandler", async (req, reply) => {
    const path = String(req.url || "").split("?")[0];
    if (!path.startsWith("/api/")) return;

    // Block accidental raw Gateway / admin proxies under product BFF.
    if (
      /^\/api\/(gateway|admin|internal|rpc|ws)\b/i.test(path) ||
      /\/v1\/(chat\/completions|models)\b/i.test(path)
    ) {
      // /api/chat is the only allowed chat entry; it never forwards control-plane RPCs.
      if (path !== "/api/chat") {
        return reply.code(404).send({ error: "not_found", hint: "control_plane_not_exposed" });
      }
    }

    const ip = clientIp(req);
    const userKey = req.user?.row?.id ? `u:${req.user.row.id}` : `ip:${ip}`;

    if (path.startsWith("/api/auth/") && req.method !== "GET") {
      const lim = checkRateLimit(`auth:${ip}`, { limit: 30, windowMs: 60_000 });
      if (!lim.ok) {
        reply.header("Retry-After", String(Math.ceil(lim.retryAfterMs / 1000) || 1));
        return reply.code(429).send({ error: "rate_limited", scope: "auth" });
      }
    }

    if (
      /\/boss-login\//.test(path) ||
      /\/browser-node\//.test(path) ||
      /\/pipeline\//.test(path) ||
      /\/boss-actions\//.test(path)
    ) {
      const lim = checkRateLimit(`boss:${userKey}`, { limit: 90, windowMs: 60_000 });
      if (!lim.ok) {
        reply.header("Retry-After", String(Math.ceil(lim.retryAfterMs / 1000) || 1));
        return reply.code(429).send({ error: "rate_limited", scope: "boss_actions" });
      }
    }

    if (path === "/api/chat" && req.method === "POST") {
      const lim = checkRateLimit(`chat:${userKey}`, { limit: 120, windowMs: 60_000 });
      if (!lim.ok) {
        reply.header("Retry-After", String(Math.ceil(lim.retryAfterMs / 1000) || 1));
        return reply.code(429).send({ error: "rate_limited", scope: "chat" });
      }
    }
  });
}

/**
 * Consent copy shown once in desktop client (Boss browser control disclosure).
 */
export const BOSS_CLIENT_CONSENT = Object.freeze({
  version: 1,
  title: "本机浏览器权限说明",
  body: [
    "招聘助手桌面客户端会在你的电脑上打开独立的 Boss 直聘窗口。",
    "为完成自动请求简历、下载简历、复聊等操作，客户端需要读取并模拟操作该窗口内的页面（仅限 Boss 直聘站点）。",
    "登录态、Cookie 与出口 IP 均留在你本机，不会把 Boss 会话搬到我们的服务器。",
    "服务端只做对话编排、评优与权益校验；用户之间的记忆与候选人数据相互隔离。",
  ].join("\n"),
});
