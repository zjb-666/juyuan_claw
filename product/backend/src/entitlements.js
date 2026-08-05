/**
 * Entitlement store in the product satellite MySQL DB.
 * Platform is the source of truth; this table is a local mirror for routing.
 */

export async function ensureEntitlementSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS digital_employee_entitlements (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      user_id BIGINT NOT NULL,
      platform_uuid VARCHAR(36) NOT NULL,
      sku VARCHAR(64) NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'active',
      source_order_id VARCHAR(128) NULL,
      display_name VARCHAR(128) NOT NULL DEFAULT '',
      valid_from DATETIME NULL,
      valid_until DATETIME NULL,
      agent_id VARCHAR(64) NULL,
      workspace_path VARCHAR(512) NULL,
      meta_json JSON NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_platform_sku (platform_uuid, sku),
      INDEX idx_user_status (user_id, status),
      CONSTRAINT fk_dee_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_active_employee (
      user_id BIGINT PRIMARY KEY,
      sku VARCHAR(64) NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_uae_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_platform_tokens (
      user_id BIGINT PRIMARY KEY,
      access_token TEXT NOT NULL,
      refresh_token TEXT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_upt_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function toMysqlDateTime(d) {
  if (!d) return null;
  return d.toISOString().slice(0, 19).replace("T", " ");
}

export function isEntitlementActive(row, now = new Date()) {
  if (!row) return false;
  const status = String(row.status || "").toLowerCase();
  if (status !== "active") return false;
  if (row.valid_until) {
    const until = new Date(row.valid_until);
    if (!Number.isNaN(until.getTime()) && until.getTime() < now.getTime()) return false;
  }
  return true;
}

export async function upsertEntitlement(pool, params) {
  const {
    userId,
    platformUuid,
    sku,
    status = "active",
    sourceOrderId = null,
    displayName = "",
    validFrom = null,
    validUntil = null,
    agentId = null,
    workspacePath = null,
    meta = null,
  } = params;

  await pool.query(
    `INSERT INTO digital_employee_entitlements
      (user_id, platform_uuid, sku, status, source_order_id, display_name,
       valid_from, valid_until, agent_id, workspace_path, meta_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       user_id = VALUES(user_id),
       status = VALUES(status),
       source_order_id = COALESCE(VALUES(source_order_id), source_order_id),
       display_name = VALUES(display_name),
       valid_from = VALUES(valid_from),
       valid_until = VALUES(valid_until),
       agent_id = COALESCE(VALUES(agent_id), agent_id),
       workspace_path = COALESCE(VALUES(workspace_path), workspace_path),
       meta_json = COALESCE(VALUES(meta_json), meta_json)`,
    [
      userId,
      platformUuid,
      sku,
      status,
      sourceOrderId,
      displayName,
      toMysqlDateTime(parseDate(validFrom)),
      toMysqlDateTime(parseDate(validUntil)),
      agentId,
      workspacePath,
      meta ? JSON.stringify(meta) : null,
    ],
  );

  const [rows] = await pool.query(
    `SELECT * FROM digital_employee_entitlements
     WHERE platform_uuid = ? AND sku = ? LIMIT 1`,
    [platformUuid, sku],
  );
  return rows[0] || null;
}

export async function listEntitlementsForUser(pool, userId) {
  const [rows] = await pool.query(
    `SELECT * FROM digital_employee_entitlements WHERE user_id = ? ORDER BY id ASC`,
    [userId],
  );
  return rows;
}

export async function getEntitlement(pool, userId, sku) {
  const [rows] = await pool.query(
    `SELECT * FROM digital_employee_entitlements WHERE user_id = ? AND sku = ? LIMIT 1`,
    [userId, sku],
  );
  return rows[0] || null;
}

export async function setActiveEmployee(pool, userId, sku) {
  await pool.query(
    `INSERT INTO user_active_employee (user_id, sku) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE sku = VALUES(sku)`,
    [userId, sku],
  );
}

export async function getActiveEmployeeSku(pool, userId) {
  const [rows] = await pool.query(
    `SELECT sku FROM user_active_employee WHERE user_id = ? LIMIT 1`,
    [userId],
  );
  return rows[0]?.sku || null;
}

export async function savePlatformTokens(pool, userId, accessToken, refreshToken = null) {
  if (!accessToken) return;
  await pool.query(
    `INSERT INTO user_platform_tokens (user_id, access_token, refresh_token)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE
       access_token = VALUES(access_token),
       refresh_token = COALESCE(VALUES(refresh_token), refresh_token)`,
    [userId, accessToken, refreshToken],
  );
}

export async function getPlatformAccessToken(pool, userId) {
  const [rows] = await pool.query(
    `SELECT access_token FROM user_platform_tokens WHERE user_id = ? LIMIT 1`,
    [userId],
  );
  return rows[0]?.access_token || null;
}

/** Pull entitlements from platform if PLATFORM_ENTITLEMENTS_URL is set. */
export async function pullEntitlementsFromPlatform(accessToken) {
  const url = String(process.env.PLATFORM_ENTITLEMENTS_URL || "").trim();
  if (!url || !accessToken) return null;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || `platform_entitlements_http_${res.status}`);
    err.payload = data;
    throw err;
  }
  return data?.data?.items || data?.items || [];
}

export function parseDevGrantSkus() {
  const raw = String(process.env.DIGITAL_EMPLOYEE_DEV_GRANT || "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
