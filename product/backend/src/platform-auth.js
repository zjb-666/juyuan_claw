import { createHash, timingSafeEqual } from "node:crypto";
import mysql from "mysql2/promise";

/**
 * Read-only auth against the platform `users` table.
 * Never INSERT/UPDATE/DELETE on the platform database.
 */

let platformPool = null;

export function platformAuthConfigured() {
  return Boolean(process.env.PLATFORM_MYSQL_HOST || process.env.PLATFORM_DB_HOST);
}

export function getPlatformPool() {
  if (!platformAuthConfigured()) return null;
  if (platformPool) return platformPool;
  platformPool = mysql.createPool({
    host: process.env.PLATFORM_MYSQL_HOST || process.env.PLATFORM_DB_HOST,
    port: Number(process.env.PLATFORM_MYSQL_PORT || process.env.PLATFORM_DB_PORT || 3306),
    user: process.env.PLATFORM_MYSQL_USER || process.env.PLATFORM_DB_USER || "root",
    password: process.env.PLATFORM_MYSQL_PASSWORD || process.env.PLATFORM_DB_PASSWORD || "",
    database:
      process.env.PLATFORM_MYSQL_DATABASE ||
      process.env.PLATFORM_DB_DATABASE ||
      "textToImageAndVideo",
    waitForConnections: true,
    connectionLimit: Number(process.env.PLATFORM_MYSQL_POOL_SIZE || 5),
    // Defensive: reject accidental multi-statements.
    multipleStatements: false,
  });
  return platformPool;
}

export function sha256Hex(password) {
  return createHash("sha256").update(String(password), "utf8").digest("hex");
}

export function verifyPlatformPassword(password, passwordHash) {
  const expected = String(passwordHash || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) return false;
  const actual = sha256Hex(password);
  const a = Buffer.from(actual, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Lookup by account or phone. Read-only SELECT.
 */
export async function findPlatformUserByLogin(login) {
  const pool = getPlatformPool();
  if (!pool) throw new Error("platform_auth_not_configured");
  const account = String(login || "").trim();
  if (!account) return null;

  const [rows] = await pool.query(
    `SELECT uuid, phone, account, password_hash, email, avatar, user_type, role_type,
            nickname, account_status, is_deleted, id
     FROM users
     WHERE is_deleted = 0
       AND (account = ? OR phone = ?)
     LIMIT 1`,
    [account, account],
  );
  return rows[0] || null;
}

/** Read-only profile refresh by platform uuid (MySQL fallback when API token missing). */
export async function findPlatformUserByUuid(uuid) {
  const pool = getPlatformPool();
  if (!pool) throw new Error("platform_auth_not_configured");
  const id = String(uuid || "").trim();
  if (!id) return null;

  const [rows] = await pool.query(
    `SELECT uuid, phone, account, password_hash, email, avatar, user_type, role_type,
            nickname, account_status, is_deleted, id
     FROM users
     WHERE is_deleted = 0 AND uuid = ?
     LIMIT 1`,
    [id],
  );
  return rows[0] || null;
}

export function assertPlatformUserLoginable(user) {
  if (!user) return { ok: false, error: "invalid_credentials" };
  if (Number(user.is_deleted) === 1) return { ok: false, error: "invalid_credentials" };
  const status = String(user.account_status || "NORMAL").toUpperCase();
  if (status && status !== "NORMAL") {
    return { ok: false, error: "account_disabled", status };
  }
  return { ok: true };
}

export async function authenticatePlatformUser(login, password) {
  const user = await findPlatformUserByLogin(login);
  const gate = assertPlatformUserLoginable(user);
  if (!gate.ok) return gate;
  if (!verifyPlatformPassword(password, user.password_hash)) {
    return { ok: false, error: "invalid_credentials" };
  }
  return {
    ok: true,
    user: {
      uuid: user.uuid,
      id: user.id,
      account: user.account || user.phone,
      phone: user.phone,
      nickname: user.nickname || user.account || user.phone || "",
      avatar: typeof user.avatar === "string" ? user.avatar : "",
      email: user.email || "",
      userType: user.user_type,
      roleType: user.role_type,
    },
  };
}

export async function closePlatformPool() {
  if (platformPool) {
    await platformPool.end();
    platformPool = null;
  }
}
