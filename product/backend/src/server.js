import dotenv from "dotenv";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import mysql from "mysql2/promise";
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { gatewayRpc } from "./gateway-rpc.js";
import { selectProductSkills } from "./skills-gateway.js";
import {
  authenticatePlatformUser,
  findPlatformUserByUuid,
  platformAuthConfigured,
} from "./platform-auth.js";
import {
  mapPlatformUser,
  platformApiConfigured,
  platformCreateRotateCaptcha,
  platformGetProfile,
  platformGetPublicKey,
  platformLogin,
  platformResolveDesktopGateway,
  platformFetchComputeBalance,
  platformSendSmsCode,
  platformUpdateUser,
  platformVerifyRotateCaptcha,
} from "./platform-api-auth.js";
import { ensureEntitlementSchema, getPlatformAccessToken } from "./entitlements.js";
import { afterPlatformLogin, registerEmployeeRoutes } from "./employees-routes.js";
import { ensureHrPipelineTables, handleHrDialogue } from "./hr-pipeline.js";
import { registerSecurityGuards, BOSS_CLIENT_CONSENT } from "./security-isolation.js";

const CAPTCHA_SESSION_COOKIE = "captcha_session_id";
const PRODUCT_CAPTCHA_COOKIE = "oc_captcha_session_id";

const moduleDir = typeof __dirname !== "undefined"
  ? __dirname
  : dirname(fileURLToPath(import.meta.url));

const ROOT = existsSync(join(moduleDir, "../config/features.json"))
  ? join(moduleDir, "..")
  : join(moduleDir, "../..");

for (const p of [
  process.env.PRODUCT_ENV_PATH,
  join(ROOT, ".env"),
  join(moduleDir, "../../.env"),
  join(process.cwd(), "../.env"),
  join(process.cwd(), ".env"),
].filter(Boolean)) {
  if (existsSync(p)) {
    dotenv.config({ path: p });
    break;
  }
}

const FEATURES_PATH = process.env.PRODUCT_FEATURES_PATH || join(ROOT, "config/features.json");
const SKILLS_PATH = process.env.PRODUCT_SKILLS_PATH || join(ROOT, "config/skills.json");
const CLIENT_DIR = process.env.PRODUCT_CLIENT_DIR || join(ROOT, "client/public");

const PORT = Number(process.env.PRODUCT_PORT || 8787);
const HOST = process.env.PRODUCT_HOST || "127.0.0.1";
const GATEWAY_URL = (process.env.OPENCLAW_GATEWAY_URL || "http://127.0.0.1:18789").replace(/\/$/, "");
const SESSION_SECRET = process.env.SESSION_SECRET || process.env.PRODUCT_SESSION_SECRET || "dev-only-change-me";
const JWT_EXPIRES_HOURS = Number(process.env.JWT_EXPIRES_HOURS || 168);
const DEMO_USER = process.env.DEMO_USER || process.env.PRODUCT_DEMO_USER || "demo";
const DEMO_PASS = process.env.DEMO_PASS || process.env.PRODUCT_DEMO_PASS || "demo123";
const DEMO_NICKNAME = process.env.DEMO_NICKNAME || "演示用户";

let pool;

function loadGatewayToken() {
  if (process.env.OPENCLAW_GATEWAY_TOKEN) return process.env.OPENCLAW_GATEWAY_TOKEN.trim();
  const cfgPath =
    process.env.OPENCLAW_CONFIG_PATH ||
    join(process.env.HOME || process.env.USERPROFILE || "", ".openclaw/openclaw.json");
  if (!existsSync(cfgPath)) {
    throw new Error(`Gateway token missing. Set OPENCLAW_GATEWAY_TOKEN or create ${cfgPath}`);
  }
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  const token = cfg?.gateway?.auth?.token;
  if (!token) throw new Error(`gateway.auth.token not found in ${cfgPath}`);
  return String(token);
}

function isPrivateOrLocalHostname(hostname) {
  const host = String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (!host) return false;
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return false;
}

/** Public installs require HTTPS/WSS; LAN/loopback may use HTTP/WS for Dev 联调. */
function assertAssignableGatewayUrl(uri, label) {
  const secure = uri.protocol === "https:" || uri.protocol === "wss:";
  const insecure = uri.protocol === "http:" || uri.protocol === "ws:";
  if (!secure && !insecure) {
    throw new Error(`${label} uses an unsupported protocol`);
  }
  if (secure) return;
  if (!isPrivateOrLocalHostname(uri.hostname)) {
    throw new Error(`${label} must use HTTPS or WSS unless the host is localhost/LAN`);
  }
}

function loadFeatures() {
  return JSON.parse(readFileSync(FEATURES_PATH, "utf8"));
}

function loadSkillsCatalog() {
  if (!existsSync(SKILLS_PATH)) {
    return { mode: "gateway", policy: {}, labels: {} };
  }
  return JSON.parse(readFileSync(SKILLS_PATH, "utf8"));
}

async function callGatewaySkills(method, params = {}) {
  const token = loadGatewayToken();
  const agentId = loadSkillsCatalog().agentId || "main";
  // skills.status accepts agentId; skills.update schema rejects unknown props.
  const withAgent =
    method === "skills.status" || method === "skills.securityVerdicts" || method === "skills.skillCard"
      ? { agentId, ...params }
      : params;
  return gatewayRpc({
    url: GATEWAY_URL,
    token,
    method,
    params: withAgent,
  });
}

async function listProductGatewaySkills() {
  const catalog = loadSkillsCatalog();
  const report = await callGatewaySkills("skills.status", {});
  return {
    skills: selectProductSkills(report, catalog),
    workspaceDir: report?.workspaceDir,
    agentId: report?.agentId || catalog.agentId || "main",
  };
}

function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function signSession(payload) {
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifySession(token) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expected = createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload?.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function requireFeature(features, key) {
  return Boolean(features?.features?.[key]);
}

async function initDb() {
  pool = mysql.createPool({
    host: process.env.MYSQL_HOST || "127.0.0.1",
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || "openclaw",
    password: process.env.MYSQL_PASSWORD || "openclaw_dev",
    database: process.env.MYSQL_DATABASE || "openclaw_product",
    waitForConnections: true,
    connectionLimit: 10,
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      username VARCHAR(64) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      nickname VARCHAR(64) NOT NULL DEFAULT '',
      bio VARCHAR(255) NOT NULL DEFAULT '',
      avatar VARCHAR(255) NOT NULL DEFAULT '',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id BIGINT PRIMARY KEY,
      theme VARCHAR(16) NOT NULL DEFAULT 'light',
      font_size VARCHAR(8) NOT NULL DEFAULT 'md',
      compact TINYINT(1) NOT NULL DEFAULT 0,
      notify_desktop TINYINT(1) NOT NULL DEFAULT 1,
      notify_sound TINYINT(1) NOT NULL DEFAULT 0,
      notify_important_only TINYINT(1) NOT NULL DEFAULT 0,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_settings_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_skills (
      user_id BIGINT NOT NULL,
      skill_id VARCHAR(64) NOT NULL,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, skill_id),
      CONSTRAINT fk_skills_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      user_id BIGINT NOT NULL,
      title VARCHAR(128) NOT NULL,
      body VARCHAR(512) NOT NULL DEFAULT '',
      category VARCHAR(32) NOT NULL DEFAULT 'system',
      is_read TINYINT(1) NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_notifications_user (user_id, is_read, id),
      CONSTRAINT fk_notifications_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await ensureHrPipelineTables(pool);

  // Local satellite only — links product settings to platform users.uuid
  try {
    await pool.query(
      "ALTER TABLE users ADD COLUMN platform_uuid VARCHAR(36) NULL UNIQUE AFTER username",
    );
  } catch (err) {
    if (!/Duplicate column name/i.test(err.message)) throw err;
  }

  // Demo seed only when platform auth is off (local/dev fallback).
  if (!platformAuthConfigured()) {
    const [rows] = await pool.query("SELECT id FROM users WHERE username = ? LIMIT 1", [DEMO_USER]);
    if (!rows.length) {
      const hash = await bcrypt.hash(DEMO_PASS, 10);
      const [result] = await pool.query(
        "INSERT INTO users (username, password_hash, nickname, bio) VALUES (?, ?, ?, ?)",
        [DEMO_USER, hash, DEMO_NICKNAME, "产品演示账号"],
      );
      const userId = result.insertId;
      await pool.query(`INSERT INTO user_settings (user_id) VALUES (?)`, [userId]);
      await pool.query(
        "INSERT INTO notifications (user_id, title, body, category) VALUES (?, ?, ?, ?)",
        [
          userId,
          "欢迎使用聚元灵创",
          "登录成功后可在设置中维护个人资料；技能页已对接 Gateway（就绪/易配置技能）。",
          "system",
        ],
      );
    }
  }

  await ensureEntitlementSchema(pool);
}

function publicUser(row, extras = {}) {
  return {
    id: row.id,
    uuid: row.platform_uuid || extras.uuid || null,
    username: row.username,
    account: extras.account || row.username,
    phone: extras.phone || "",
    email: extras.email || "",
    nickname: extras.nickname ?? row.nickname,
    bio: row.platform_uuid ? "" : row.bio,
    avatar: extras.avatar ?? row.avatar,
    platformUuid: row.platform_uuid || null,
    profileSource: extras.profileSource || (row.platform_uuid ? "platform_mirror" : "local"),
  };
}

function readCaptchaSessionId(req) {
  const fromHeader = String(req.headers["x-session-id"] || "").trim();
  if (fromHeader) return fromHeader;
  const raw = String(req.headers.cookie || "");
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === PRODUCT_CAPTCHA_COOKIE || k === CAPTCHA_SESSION_COOKIE) {
      return decodeURIComponent(rest.join("=") || "").trim();
    }
  }
  return "";
}

function setCaptchaSessionCookie(reply, sessionId) {
  if (!sessionId) return;
  reply.header(
    "Set-Cookie",
    `${PRODUCT_CAPTCHA_COOKIE}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
  );
}

function newCaptchaSessionId() {
  return randomBytes(16).toString("hex");
}

/**
 * Mirror platform nickname/avatar into the local satellite row.
 * Local DB never becomes the profile source of truth for platform users.
 */
async function syncLocalMirrorFromPlatform(userId, platformUser) {
  const nickname = String(platformUser.nickname || platformUser.account || "").slice(0, 64);
  const avatar = String(platformUser.avatar || "").slice(0, 255);
  const username = String(platformUser.account || platformUser.phone || "").trim().slice(0, 64);
  await pool.query(
    `UPDATE users
     SET nickname = ?,
         avatar = ?,
         username = CASE
           WHEN ? <> '' AND (username = '' OR username = platform_uuid) THEN ?
           ELSE username
         END
     WHERE id = ?`,
    [nickname || username, avatar, username, username, userId],
  );
  return getUserById(userId);
}

/**
 * Ensure a local product row for settings/notifications.
 * Writes only the local openclaw_product DB — never the platform DB.
 * Always refreshes nickname/avatar from the platform login payload.
 */
async function ensureLocalUserFromPlatform(platformUser) {
  const username = String(platformUser.account || platformUser.phone || "").trim();
  if (!username) throw new Error("platform_user_missing_account");

  const [byUuid] = await pool.query(
    "SELECT * FROM users WHERE platform_uuid = ? LIMIT 1",
    [platformUser.uuid],
  );
  if (byUuid[0]) {
    return syncLocalMirrorFromPlatform(byUuid[0].id, platformUser);
  }

  const [byName] = await pool.query(
    "SELECT * FROM users WHERE username = ? LIMIT 1",
    [username],
  );
  if (byName[0]) {
    await pool.query(
      "UPDATE users SET platform_uuid = COALESCE(platform_uuid, ?) WHERE id = ?",
      [platformUser.uuid, byName[0].id],
    );
    return syncLocalMirrorFromPlatform(byName[0].id, platformUser);
  }

  const nickname = String(platformUser.nickname || username).slice(0, 64);
  const avatar = String(platformUser.avatar || "").slice(0, 255);
  const [result] = await pool.query(
    `INSERT INTO users (username, platform_uuid, password_hash, nickname, bio, avatar)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [username, platformUser.uuid, "platform-auth", nickname, "", avatar],
  );
  const userId = result.insertId;
  await pool.query("INSERT IGNORE INTO user_settings (user_id) VALUES (?)", [userId]);
  return getUserById(userId);
}

/**
 * Load personal profile from platform (API preferred, MySQL readonly fallback).
 * Affiliate clients must show the same nickname/avatar/account as the platform site.
 */
async function loadPublicProfile(localRow) {
  if (!localRow?.platform_uuid) {
    return publicUser(localRow, { profileSource: "local" });
  }

  if (platformApiConfigured()) {
    const token = await getPlatformAccessToken(pool, localRow.id);
    if (token) {
      try {
        const result = await platformGetProfile(token);
        if (result.state === 200 && result.data) {
          const mapped = mapPlatformUser(result.data);
          const synced = await syncLocalMirrorFromPlatform(localRow.id, mapped);
          return publicUser(synced, {
            ...mapped,
            profileSource: "platform",
          });
        }
      } catch {
        // Fall through to mirror / MySQL.
      }
    }
  }

  if (platformAuthConfigured()) {
    try {
      const row = await findPlatformUserByUuid(localRow.platform_uuid);
      if (row) {
        const mapped = mapPlatformUser(row);
        const synced = await syncLocalMirrorFromPlatform(localRow.id, mapped);
        return publicUser(synced, {
          ...mapped,
          profileSource: "platform_mysql",
        });
      }
    } catch {
      // Fall through to local mirror.
    }
  }

  return publicUser(localRow, { profileSource: "platform_mirror" });
}

async function getUserById(id) {
  const [rows] = await pool.query("SELECT * FROM users WHERE id = ? LIMIT 1", [id]);
  return rows[0] || null;
}

async function getSettings(userId) {
  const [rows] = await pool.query("SELECT * FROM user_settings WHERE user_id = ? LIMIT 1", [userId]);
  if (!rows[0]) {
    await pool.query("INSERT INTO user_settings (user_id) VALUES (?)", [userId]);
    return getSettings(userId);
  }
  const s = rows[0];
  return {
    appearance: {
      theme: s.theme,
      fontSize: s.font_size,
      compact: Boolean(s.compact),
    },
    notifications: {
      desktop: Boolean(s.notify_desktop),
      sound: Boolean(s.notify_sound),
      importantOnly: Boolean(s.notify_important_only),
    },
  };
}

async function main() {
  await initDb();
  const features = loadFeatures();

  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true, credentials: true });
  await app.register(fastifyStatic, { root: CLIENT_DIR, prefix: "/" });

  app.decorateRequest("user", null);

  app.addHook("preHandler", async (req) => {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    const session = verifySession(token);
    if (!session?.uid) {
      req.user = null;
      return;
    }
    const row = await getUserById(session.uid);
    req.user = row ? { ...session, row } : null;
  });

  await registerSecurityGuards(app, { pool });

  app.get("/api/health", async () => ({
    ok: true,
    gateway: GATEWAY_URL,
    mysql: true,
    platformAuth: platformAuthConfigured(),
    platformApi: platformApiConfigured(),
    authMode: platformApiConfigured()
      ? "platform_api"
      : platformAuthConfigured()
        ? "platform_mysql_readonly"
        : "local_demo",
    digitalEmployees: true,
    controlUiExposed: false,
    bossConsent: BOSS_CLIENT_CONSENT,
    tenantIsolation: "per-user",
  }));

  await registerEmployeeRoutes(app, { pool, requireFeature, features });

  // --- Platform-aligned auth (affiliate client step 1) ---

  app.get("/api/auth/public-key", async (_req, reply) => {
    if (!platformApiConfigured()) {
      return reply.code(503).send({
        state: 503,
        message: "未配置 PLATFORM_API_BASE_URL，无法获取平台公钥",
        data: null,
      });
    }
    try {
      const result = await platformGetPublicKey();
      return reply.code(result.state >= 400 ? result.state : 200).send({
        state: result.state,
        message: result.message || "获取公钥成功",
        data: result.data,
      });
    } catch (err) {
      return reply.code(503).send({
        state: 503,
        message: `平台公钥不可用: ${err.message}`,
        data: null,
      });
    }
  });

  app.post("/api/auth/captcha/rotate/create", async (req, reply) => {
    if (!platformApiConfigured()) {
      return reply.code(503).send({
        state: 503,
        message: "未配置 PLATFORM_API_BASE_URL",
        data: null,
      });
    }
    const scene = String(req.body?.scene || "login").trim() || "login";
    let sessionId = readCaptchaSessionId(req) || newCaptchaSessionId();
    try {
      const result = await platformCreateRotateCaptcha(sessionId, scene);
      if (result.sessionId) sessionId = result.sessionId;
      setCaptchaSessionCookie(reply, sessionId);
      return reply.code(result.state >= 400 ? result.state : 200).send({
        state: result.state,
        message: result.message || "获取旋转验证码成功",
        data: result.data,
      });
    } catch (err) {
      return reply.code(503).send({
        state: 503,
        message: `获取验证码失败: ${err.message}`,
        data: null,
      });
    }
  });

  app.post("/api/auth/captcha/rotate/verify", async (req, reply) => {
    if (!platformApiConfigured()) {
      return reply.code(503).send({
        state: 503,
        message: "未配置 PLATFORM_API_BASE_URL",
        data: null,
      });
    }
    const sessionId = readCaptchaSessionId(req);
    if (!sessionId) {
      return reply.code(400).send({
        state: 400,
        message: "会话已失效，请重新获取验证码",
        data: null,
      });
    }
    const captchaId = String(req.body?.captcha_id || "").trim();
    const scene = String(req.body?.scene || "login").trim() || "login";
    const angle = req.body?.angle;
    try {
      const result = await platformVerifyRotateCaptcha(sessionId, captchaId, angle, scene);
      setCaptchaSessionCookie(reply, sessionId);
      return reply.code(result.state >= 400 ? result.state : 200).send({
        state: result.state,
        message: result.message || (result.state === 200 ? "验证成功" : "验证失败"),
        data: result.data,
      });
    } catch (err) {
      return reply.code(503).send({
        state: 503,
        message: `校验验证码失败: ${err.message}`,
        data: null,
      });
    }
  });

  app.post("/api/auth/send-sms-code", async (req, reply) => {
    if (!platformApiConfigured()) {
      return reply.code(503).send({
        state: 503,
        message: "未配置 PLATFORM_API_BASE_URL",
        data: null,
      });
    }
    const sessionId = readCaptchaSessionId(req);
    if (!sessionId) {
      return reply.code(400).send({
        state: 400,
        message: "需先通过验证码校验",
        data: null,
      });
    }
    const phone = String(req.body?.phone || "").trim();
    const scene = String(req.body?.scene || "login").trim() || "login";
    if (!phone) {
      return reply.code(400).send({ state: 400, message: "手机号不能为空", data: null });
    }
    try {
      const result = await platformSendSmsCode(sessionId, phone, scene);
      setCaptchaSessionCookie(reply, sessionId);
      return reply.code(result.state >= 400 ? result.state : 200).send({
        state: result.state,
        message: result.message || "短信验证码发送成功",
        data: result.data,
      });
    } catch (err) {
      return reply.code(503).send({
        state: 503,
        message: `发送短信失败: ${err.message}`,
        data: null,
      });
    }
  });

  app.post("/api/auth/login", async (req, reply) => {
    if (!requireFeature(features, "auth.login")) {
      return reply.code(403).send({ error: "feature_disabled", feature: "auth.login" });
    }

    // Preferred: same path as platform website — captcha + POST /auth/login
    if (platformApiConfigured()) {
      const sessionId = readCaptchaSessionId(req);
      if (!sessionId) {
        return reply.code(400).send({
          state: 400,
          message: "需先通过验证码校验",
          data: null,
        });
      }

      const loginType = String(req.body?.login_type || "account_password").trim();
      const account = String(
        req.body?.account || req.body?.username || req.body?.phone || "",
      ).trim();
      const body = {
        login_type: loginType,
        account,
        phone: req.body?.phone || account,
        password: req.body?.password,
        encryptedPassword: req.body?.encryptedPassword,
        encryption: req.body?.encryption,
        encryptionType: req.body?.encryptionType,
        sms_code: req.body?.sms_code,
      };

      try {
        const result = await platformLogin(sessionId, body);
        setCaptchaSessionCookie(reply, sessionId);

        if (result.state !== 200 || !result.data?.access_token || !result.data?.user) {
          const http = result.state >= 400 ? result.state : result.httpStatus || 401;
          return reply.code(http).send({
            state: result.state || http,
            message: result.message || "账号或密码错误",
            data: result.data,
            error:
              result.state === 403
                ? "account_disabled"
                : result.state === 400
                  ? "captcha_required"
                  : "invalid_credentials",
          });
        }

        const mapped = mapPlatformUser(result.data.user);
        const user = await ensureLocalUserFromPlatform(mapped);
        await afterPlatformLogin(pool, user, {
          access_token: result.data.access_token,
          refresh_token: result.data.refresh_token || null,
        });
        const token = signSession({
          uid: user.id,
          sub: user.username,
          platformUuid: user.platform_uuid || mapped.uuid || null,
          role: "user",
          exp: Date.now() + JWT_EXPIRES_HOURS * 60 * 60 * 1000,
        });

        return {
          state: 200,
          message: "登录成功",
          data: {
            access_token: token,
            // Keep platform tokens for later affiliate API calls (not used by shell yet).
            platform_access_token: result.data.access_token,
            platform_refresh_token: result.data.refresh_token || null,
            user: publicUser(user, {
              ...mapped,
              profileSource: "platform",
            }),
            features: Object.fromEntries(
              (features.publicFeatures || []).map((k) => [k, Boolean(features.features?.[k])]),
            ),
          },
        };
      } catch (err) {
        req.log.error(err);
        return reply.code(503).send({
          state: 503,
          message: `平台登录不可用: ${err.message}`,
          error: "auth_unavailable",
          data: null,
        });
      }
    }

    // Legacy fallbacks: direct platform MySQL read, or local demo user.
    const username = String(req.body?.username || req.body?.account || "").trim();
    const password = String(req.body?.password || "").trim();
    if (!username || !password) {
      return reply.code(400).send({
        state: 400,
        message: "账号和密码不能为空",
        error: "username_password_required",
      });
    }

    let user;
    try {
      if (platformAuthConfigured()) {
        const auth = await authenticatePlatformUser(username, password);
        if (!auth.ok) {
          const code = auth.error === "account_disabled" ? 403 : 401;
          return reply.code(code).send({
            state: code,
            message: auth.error === "account_disabled" ? "账号已被封禁，请联系管理员" : "账号或密码错误",
            error: auth.error,
          });
        }
        user = await ensureLocalUserFromPlatform(auth.user);
      } else {
        const [rows] = await pool.query("SELECT * FROM users WHERE username = ? LIMIT 1", [
          username,
        ]);
        user = rows[0];
        if (!user || !(await bcrypt.compare(password, user.password_hash))) {
          return reply.code(401).send({
            state: 401,
            message: "账号或密码错误",
            error: "invalid_credentials",
          });
        }
      }
    } catch (err) {
      req.log.error(err);
      return reply.code(503).send({
        state: 503,
        message: err.message,
        error: "auth_unavailable",
      });
    }

    const token = signSession({
      uid: user.id,
      sub: user.username,
      platformUuid: user.platform_uuid || null,
      role: "user",
      exp: Date.now() + JWT_EXPIRES_HOURS * 60 * 60 * 1000,
    });
    return {
      state: 200,
      message: "登录成功",
      data: {
        access_token: token,
        user: await loadPublicProfile(user),
        features: Object.fromEntries(
          (features.publicFeatures || []).map((k) => [k, Boolean(features.features?.[k])]),
        ),
      },
    };
  });

  app.get("/api/me", async (req, reply) => {
    if (!req.user?.row) return reply.code(401).send({ error: "unauthorized" });
    const settings = await getSettings(req.user.row.id);
    const user = await loadPublicProfile(req.user.row);
    // Keep auth middleware row in sync with the latest platform mirror.
    req.user.row = (await getUserById(req.user.row.id)) || req.user.row;
    return {
      user,
      settings,
      features: Object.fromEntries(
        (features.publicFeatures || []).map((k) => [k, Boolean(features.features?.[k])]),
      ),
    };
  });

  app.post("/api/desktop/bootstrap", async (req, reply) => {
    if (!req.user?.row) return reply.code(401).send({ error: "unauthorized" });

    const platformAccessToken = await getPlatformAccessToken(pool, req.user.row.id);
    if (!platformAccessToken) {
      return reply.code(401).send({ error: "platform_session_required" });
    }

    const pairedGatewayUrls = Array.isArray(req.body?.pairedGatewayUrls)
      ? req.body.pairedGatewayUrls
          .filter((value) => typeof value === "string")
          .map((value) => value.trim())
          .filter(Boolean)
          .slice(0, 32)
      : [];
    try {
      const assignment = await platformResolveDesktopGateway(platformAccessToken);
      const assignedGatewayUrl = String(assignment?.gatewayUrl || "").trim();
      const gatewayRpcUrl = String(assignment?.gatewayRpcUrl || assignedGatewayUrl).trim();
      const gatewayToken = String(assignment?.gatewayToken || "").trim();
      if (!assignedGatewayUrl || !gatewayRpcUrl || !gatewayToken) {
        return reply.code(403).send({
          state: 403,
          error: "user_gateway_not_assigned",
          message: "当前账号尚未分配专属 Gateway",
        });
      }

      const assigned = new URL(assignedGatewayUrl);
      const rpcEndpoint = new URL(gatewayRpcUrl);
      if (
        !["http:", "https:", "ws:", "wss:"].includes(assigned.protocol) ||
        !["http:", "https:", "ws:", "wss:"].includes(rpcEndpoint.protocol)
      ) {
        throw new Error("platform returned an unsupported Gateway URL");
      }
      assertAssignableGatewayUrl(assigned, "user Gateway public URL");
      assertAssignableGatewayUrl(rpcEndpoint, "user Gateway RPC URL");
      for (const pairedGatewayUrl of pairedGatewayUrls) {
        let current;
        try {
          current = new URL(pairedGatewayUrl);
        } catch {
          continue;
        }
        const sameTransport =
          current.protocol === assigned.protocol ||
          (["http:", "ws:"].includes(current.protocol) &&
            ["http:", "ws:"].includes(assigned.protocol)) ||
          (["https:", "wss:"].includes(current.protocol) &&
            ["https:", "wss:"].includes(assigned.protocol));
        if (
          sameTransport &&
          current.host === assigned.host &&
          current.pathname.replace(/\/$/, "") === assigned.pathname.replace(/\/$/, "")
        ) {
          return {
            state: 200,
            data: {
              gatewayUrl: assignedGatewayUrl,
              ...(Array.isArray(assignment.models) ? { models: assignment.models } : {}),
              ...(assignment.defaultModel ? { defaultModel: assignment.defaultModel } : {}),
              ...(assignment.llmBaseUrl ? { llmBaseUrl: assignment.llmBaseUrl } : {}),
            },
          };
        }
      }

      const setup = await gatewayRpc({
        url: gatewayRpcUrl,
        token: gatewayToken,
        method: "device.pair.setupCode",
        params: {
          includeQr: false,
          publicUrl: assignedGatewayUrl,
        },
      });
      return {
        state: 200,
        data: {
          gatewayUrl: setup.gatewayUrl,
          setupCode: setup.setupCode,
          // Display-only; never include LLM apiKey / gatewayToken.
          ...(Array.isArray(assignment.models) ? { models: assignment.models } : {}),
          ...(assignment.defaultModel ? { defaultModel: assignment.defaultModel } : {}),
          ...(assignment.llmBaseUrl ? { llmBaseUrl: assignment.llmBaseUrl } : {}),
        },
      };
    } catch (err) {
      req.log.error(err);
      return reply.code(503).send({
        state: 503,
        error: "desktop_bootstrap_unavailable",
        message: "暂时无法为此账号分配专属 Gateway",
      });
    }
  });

  app.get("/api/desktop/compute-balance", async (req, reply) => {
    if (!req.user?.row) return reply.code(401).send({ error: "unauthorized" });

    const platformAccessToken = await getPlatformAccessToken(pool, req.user.row.id);
    if (!platformAccessToken) {
      return reply.code(401).send({ error: "platform_session_required" });
    }

    try {
      const balance = await platformFetchComputeBalance(platformAccessToken);
      return {
        state: 200,
        data: {
          object: balance.object,
          userUuid: balance.user_uuid,
          balance: balance.balance,
          ledgerSum: balance.ledger_sum,
          unit: balance.unit,
          currency: balance.currency,
        },
      };
    } catch (err) {
      req.log.error(err);
      const message = String(err?.message || "compute_balance_unavailable");
      if (message === "compute_balance_unavailable") {
        return reply.code(503).send({
          state: 503,
          error: "compute_balance_unavailable",
          message: "暂时无法查询算力余额，请确认平台已配置计费出口或在 desktop-gateway 返回余额",
        });
      }
      if (message === "INSUFFICIENT_POINTS" || message === "unauthorized") {
        return reply.code(message === "unauthorized" ? 401 : 402).send({
          state: message === "unauthorized" ? 401 : 402,
          error: message,
          message:
            message === "unauthorized"
              ? "平台模型鉴权失败"
              : "算力余额不足，请充值后再试",
        });
      }
      return reply.code(503).send({
        state: 503,
        error: "compute_balance_unavailable",
        message: "暂时无法查询算力余额",
      });
    }
  });

  app.get("/api/user/profile", async (req, reply) => {
    if (!req.user?.row) return reply.code(401).send({ error: "unauthorized" });
    return { state: 200, data: await loadPublicProfile(req.user.row) };
  });

  app.post("/api/user/profile", async (req, reply) => {
    if (!req.user?.row) return reply.code(401).send({ error: "unauthorized" });
    if (!requireFeature(features, "settings.profile")) {
      return reply.code(403).send({ error: "feature_disabled", feature: "settings.profile" });
    }

    const nickname = String(req.body?.nickname ?? req.user.row.nickname).trim().slice(0, 64);
    const avatar = String(req.body?.avatar ?? req.user.row.avatar).trim().slice(0, 255);

    // Platform-linked accounts: profile source of truth is the platform user record.
    if (req.user.row.platform_uuid && platformApiConfigured()) {
      const platformToken = await getPlatformAccessToken(pool, req.user.row.id);
      if (!platformToken) {
        return reply.code(401).send({
          state: 401,
          message: "平台登录已失效，请重新登录后再修改个人资料",
          error: "platform_token_missing",
        });
      }
      try {
        const result = await platformUpdateUser(platformToken, {
          nickname: nickname || req.user.row.username,
          avatar,
        });
        if (result.state !== 200 || !result.data) {
          const http = result.state >= 400 ? result.state : result.httpStatus || 400;
          return reply.code(http).send({
            state: result.state || http,
            message: result.message || "平台资料保存失败",
            error: "platform_profile_update_failed",
            data: result.data,
          });
        }
        const mapped = mapPlatformUser(result.data);
        await syncLocalMirrorFromPlatform(req.user.row.id, mapped);
        const fresh = await getUserById(req.user.row.id);
        req.user.row = fresh;
        // Re-read via GET /user/profile so account/phone match platform display (not update-payload quirks).
        return {
          state: 200,
          message: "保存成功",
          data: await loadPublicProfile(fresh),
        };
      } catch (err) {
        req.log.error(err);
        return reply.code(503).send({
          state: 503,
          message: `平台资料不可用: ${err.message}`,
          error: "platform_profile_unavailable",
        });
      }
    }

    // Local demo / MySQL-only fallback: keep satellite-only profile edits.
    const bio = String(req.body?.bio ?? req.user.row.bio).trim().slice(0, 255);
    await pool.query("UPDATE users SET nickname = ?, bio = ?, avatar = ? WHERE id = ?", [
      nickname || req.user.row.username,
      bio,
      avatar,
      req.user.row.id,
    ]);
    const updated = await getUserById(req.user.row.id);
    return { state: 200, message: "保存成功", data: publicUser(updated) };
  });

  app.get("/api/user/settings", async (req, reply) => {
    if (!req.user?.row) return reply.code(401).send({ error: "unauthorized" });
    return { state: 200, data: await getSettings(req.user.row.id) };
  });

  app.post("/api/user/settings/appearance", async (req, reply) => {
    if (!req.user?.row) return reply.code(401).send({ error: "unauthorized" });
    if (!requireFeature(features, "settings.appearance")) {
      return reply.code(403).send({ error: "feature_disabled", feature: "settings.appearance" });
    }
    const theme = ["light", "dark", "system"].includes(req.body?.theme) ? req.body.theme : "light";
    const fontSize = ["sm", "md", "lg"].includes(req.body?.fontSize) ? req.body.fontSize : "md";
    const compact = req.body?.compact ? 1 : 0;
    await pool.query(
      `INSERT INTO user_settings (user_id, theme, font_size, compact)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE theme = VALUES(theme), font_size = VALUES(font_size), compact = VALUES(compact)`,
      [req.user.row.id, theme, fontSize, compact],
    );
    return { state: 200, message: "保存成功", data: await getSettings(req.user.row.id) };
  });

  app.post("/api/user/settings/notifications", async (req, reply) => {
    if (!req.user?.row) return reply.code(401).send({ error: "unauthorized" });
    if (!requireFeature(features, "settings.notifications")) {
      return reply.code(403).send({ error: "feature_disabled", feature: "settings.notifications" });
    }
    const desktop = req.body?.desktop ? 1 : 0;
    const sound = req.body?.sound ? 1 : 0;
    const importantOnly = req.body?.importantOnly ? 1 : 0;
    await pool.query(
      `INSERT INTO user_settings (user_id, notify_desktop, notify_sound, notify_important_only)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         notify_desktop = VALUES(notify_desktop),
         notify_sound = VALUES(notify_sound),
         notify_important_only = VALUES(notify_important_only)`,
      [req.user.row.id, desktop, sound, importantOnly],
    );
    return { state: 200, message: "保存成功", data: await getSettings(req.user.row.id) };
  });

  app.get("/api/skills", async (req, reply) => {
    if (!req.user?.row) return reply.code(401).send({ error: "unauthorized" });
    if (!requireFeature(features, "skills")) {
      return reply.code(403).send({ error: "feature_disabled", feature: "skills" });
    }
    try {
      const listed = await listProductGatewaySkills();
      const [rows] = await pool.query(
        "SELECT skill_id, enabled FROM user_skills WHERE user_id = ?",
        [req.user.row.id],
      );
      const enabledMap = Object.fromEntries(rows.map((r) => [r.skill_id, Boolean(r.enabled)]));

      const skills = [];
      for (const skill of listed.skills) {
        // Default: ready skills on, needs-setup off — per user, not shared Gateway toggle.
        const defaultOn = Boolean(skill.ready) && !skill.needsSetup;
        if (!(skill.id in enabledMap)) {
          await pool.query(
            "INSERT IGNORE INTO user_skills (user_id, skill_id, enabled) VALUES (?, ?, ?)",
            [req.user.row.id, skill.id, defaultOn ? 1 : 0],
          );
          enabledMap[skill.id] = defaultOn;
        }
        skills.push({
          ...skill,
          enabled: enabledMap[skill.id],
        });
      }

      return {
        state: 200,
        data: {
          source: "gateway+user",
          isolation: "per-user",
          agentId: listed.agentId,
          skills,
        },
      };
    } catch (err) {
      return reply.code(503).send({
        error: "gateway_skills_unavailable",
        detail: { message: err.message },
      });
    }
  });

  app.post("/api/skills/:skillId/toggle", async (req, reply) => {
    if (!req.user?.row) return reply.code(401).send({ error: "unauthorized" });
    if (!requireFeature(features, "skills")) {
      return reply.code(403).send({ error: "feature_disabled", feature: "skills" });
    }
    const skillId = String(req.params.skillId || "").trim();
    if (!skillId) return reply.code(400).send({ error: "skill_id_required" });

    try {
      const listed = await listProductGatewaySkills();
      const catalogSkill = listed.skills.find((s) => s.id === skillId);
      if (!catalogSkill) {
        return reply.code(404).send({
          error: "skill_not_found",
          hint: "仅展示 Gateway 中已就绪或仅需环境变量配置的非调试技能",
        });
      }

      const enabled = Boolean(req.body?.enabled);
      const apiKey =
        typeof req.body?.apiKey === "string" && req.body.apiKey.trim()
          ? req.body.apiKey.trim()
          : undefined;

      // Optional shared Gateway env setup only (keys live on gateway host).
      // Enable/disable itself is per-user in local DB — never skills.update enabled.
      if (apiKey) {
        await callGatewaySkills("skills.update", { skillKey: skillId, apiKey });
      }

      await pool.query(
        `INSERT INTO user_skills (user_id, skill_id, enabled) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE enabled = VALUES(enabled)`,
        [req.user.row.id, skillId, enabled ? 1 : 0],
      );

      return {
        state: 200,
        message: "已按当前用户保存",
        data: {
          skillId,
          enabled,
          skill: { ...catalogSkill, enabled },
        },
      };
    } catch (err) {
      return reply.code(503).send({
        error: "skills_update_failed",
        detail: { message: err.message },
      });
    }
  });

  app.get("/api/notifications", async (req, reply) => {
    if (!req.user?.row) return reply.code(401).send({ error: "unauthorized" });
    const [rows] = await pool.query(
      `SELECT id, title, body, category, is_read, created_at
       FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50`,
      [req.user.row.id],
    );
    return {
      state: 200,
      data: {
        items: rows.map((r) => ({
          id: r.id,
          title: r.title,
          body: r.body,
          category: r.category,
          isRead: Boolean(r.is_read),
          createdAt: r.created_at,
        })),
      },
    };
  });

  app.post("/api/notifications/:id/read", async (req, reply) => {
    if (!req.user?.row) return reply.code(401).send({ error: "unauthorized" });
    await pool.query("UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?", [
      Number(req.params.id),
      req.user.row.id,
    ]);
    return { state: 200, message: "已读" };
  });

  app.all("/api/gateway/*", async (_req, reply) => {
    return reply.code(404).send({ error: "not_found", hint: "raw gateway is not exposed" });
  });

  app.post("/api/chat", async (req, reply) => {
    if (!req.user?.row) return reply.code(401).send({ error: "unauthorized" });
    if (!requireFeature(features, "chat.send")) {
      return reply.code(403).send({ error: "feature_disabled", feature: "chat.send" });
    }

    const message = String(req.body?.message || "").trim();
    if (!message) return reply.code(400).send({ error: "message_required" });

    let employee;
    try {
      employee = await app.resolveChatEmployee(req.user.row);
    } catch (err) {
      req.log.error(err);
      return reply.code(503).send({
        error: "employee_provision_failed",
        detail: { message: err.message },
      });
    }
    if (!employee?.agentId) {
      return reply.code(403).send({
        state: 403,
        error: "entitlement_required",
        message: "请先在平台购买数字员工后再对话",
      });
    }

    // HR recruitment: dialogue-driven pipeline (intent → screen/rank/invite with confirm gate).
    // Runs without live Gateway when DEMO_HR_PIPELINE=1 or pipeline handles the turn.
    if (employee.sku === "hr-recruitment") {
      try {
        const clientContext = req.body?.clientContext || {};
        const pipeline = await handleHrDialogue(pool, req.user.row, message, clientContext);
        if (pipeline?.handled) {
          return {
            sessionKey: String(req.body?.sessionKey || employee.sessionKey),
            employee: {
              sku: employee.sku,
              agentId: employee.agentId,
              name: employee.name,
            },
            reply: pipeline.reply || "",
            id: randomBytes(8).toString("hex"),
            pipeline: {
              intent: pipeline.intent,
              intentSource: pipeline.intentSource || "rules",
              confidence: pipeline.confidence,
              loggedIn: pipeline.loggedIn,
              blocked: pipeline.blocked,
              openLoginWizard: Boolean(pipeline.openLoginWizard),
              requireConfirm: Boolean(pipeline.requireConfirm),
              job: pipeline.job,
              pendingInvite: pipeline.pendingInvite,
              pendingPlan: pipeline.pendingPlan || null,
              candidates: (pipeline.candidates || []).slice(0, 20).map((c) => ({
                id: c.id,
                name: c.name,
                title: c.title,
                score: c.score,
                verdict: c.verdict,
                reason: c.reason,
                inviteStatus: c.invite_status || c.inviteStatus,
              })),
              actions: pipeline.actions || [],
              clientActions: pipeline.clientActions || [],
            },
          };
        }
      } catch (err) {
        req.log.error(err);
        // Fall through to generic agent chat on pipeline errors.
      }
    }

    let gatewayToken;
    try {
      gatewayToken = loadGatewayToken();
    } catch (err) {
      return reply.code(503).send({
        error: "gateway_not_configured",
        detail: { message: err.message },
      });
    }

    const sessionKey = String(req.body?.sessionKey || employee.sessionKey);
    let upstream;
    try {
      upstream = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${gatewayToken}`,
          "Content-Type": "application/json",
          "x-openclaw-session-key": sessionKey,
        },
        body: JSON.stringify({
          model: process.env.OPENCLAW_CHAT_MODEL || "openclaw",
          stream: false,
          messages: [
            {
              role: "user",
              content: `【当前数字员工：${employee.name} / ${employee.sku}】\n${message}`,
            },
          ],
        }),
      });
    } catch (err) {
      const msg = String(err.message || err);
      if (/ECONNREFUSED|fetch failed/i.test(msg)) {
        return reply.code(503).send({
          error: "gateway_unreachable",
          message:
            "OpenClaw Gateway 未启动（默认 127.0.0.1:18789）。人事漏斗演示可说「招 5 个 Java 后端」走产品编排；通用闲聊需先启动 Gateway。",
          detail: { message: msg },
        });
      }
      throw err;
    }

    const text = await upstream.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    if (!upstream.ok) {
      const detailMessage =
        data?.error?.message ||
        data?.message ||
        data?.detail?.message ||
        (typeof data?.raw === "string" ? data.raw.slice(0, 300) : null) ||
        `gateway_http_${upstream.status}`;
      return reply.code(upstream.status >= 400 ? upstream.status : 502).send({
        error: "gateway_error",
        message: detailMessage,
        status: upstream.status,
        detail: data,
      });
    }

    let content =
      data?.choices?.[0]?.message?.content ??
      data?.choices?.[0]?.text ??
      "";

    // Some models echo the same answer twice in one message; collapse exact duplicates.
    const raw = String(content || "").trim();
    if (raw.length >= 24) {
      const mid = Math.floor(raw.length / 2);
      for (let i = Math.max(12, mid - 40); i <= Math.min(raw.length - 12, mid + 40); i++) {
        const a = raw.slice(0, i).trim();
        const b = raw.slice(i).trim();
        if (a && a === b) {
          content = a;
          break;
        }
      }
    }

    return {
      sessionKey,
      employee: {
        sku: employee.sku,
        agentId: employee.agentId,
        name: employee.name,
      },
      reply: content,
      id: data?.id || randomBytes(8).toString("hex"),
    };
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/")) {
      return reply.code(404).send({ error: "not_found" });
    }
    return reply.sendFile("index.html");
  });

  await app.listen({ port: PORT, host: HOST });
  app.log.info(`Product BFF listening on http://${HOST}:${PORT}`);
  app.log.info(`MySQL ${process.env.MYSQL_HOST}:${process.env.MYSQL_PORT}/${process.env.MYSQL_DATABASE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
