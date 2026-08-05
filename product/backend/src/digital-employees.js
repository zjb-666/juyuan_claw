import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, cpSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { gatewayRpc } from "./gateway-rpc.js";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const PRODUCT_ROOT = existsSync(join(moduleDir, "../config/digital-employees.json"))
  ? join(moduleDir, "..")
  : join(moduleDir, "../..");

export function loadEmployeeCatalog() {
  const path =
    process.env.DIGITAL_EMPLOYEES_CATALOG_PATH ||
    join(PRODUCT_ROOT, "config/digital-employees.json");
  return JSON.parse(readFileSync(path, "utf8"));
}

export function getEmployeeDef(sku) {
  const catalog = loadEmployeeCatalog();
  return catalog.employees?.[sku] || null;
}

export function listEmployeeSkus() {
  return Object.keys(loadEmployeeCatalog().employees || {});
}

/** de-{uuid8}-{sku} — must stay <= 64 chars for OpenClaw agent ids. */
export function buildAgentId(platformUuid, sku) {
  const hex = String(platformUuid || "")
    .replace(/-/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 8);
  const safeSku = String(sku || "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const id = `de-${hex || "unknown"}-${safeSku || "emp"}`.slice(0, 64);
  return id;
}

export function buildSessionKey(agentId) {
  return `agent:${agentId}:main`;
}

export function resolveWorkspaceDir(agentId) {
  const root =
    process.env.DIGITAL_EMPLOYEE_WORKSPACE_ROOT ||
    join(homedir(), ".openclaw", "workspace-digital");
  return join(root, agentId);
}

function templateDirForSku(sku) {
  const def = getEmployeeDef(sku);
  if (!def?.templateDir) return null;
  return join(PRODUCT_ROOT, "digital-employees", def.templateDir);
}

/**
 * Seed workspace from template. Never overwrite USER.md / memory once present
 * so user调教与记忆沉淀得以保留。
 */
export function seedWorkspaceFromTemplate(sku, workspaceDir) {
  const template = templateDirForSku(sku);
  if (!template || !existsSync(template)) {
    throw new Error(`employee_template_missing:${sku}`);
  }
  mkdirSync(workspaceDir, { recursive: true });

  const seedFiles = ["SOUL.md", "AGENTS.md"];
  for (const name of seedFiles) {
    const src = join(template, name);
    const dest = join(workspaceDir, name);
    // Refresh persona/workflow from template; USER.md / memory stay user-owned.
    if (existsSync(src)) {
      cpSync(src, dest);
    }
  }

  const userMd = join(workspaceDir, "USER.md");
  if (!existsSync(userMd) && existsSync(join(template, "USER.md"))) {
    cpSync(join(template, "USER.md"), userMd);
  }

  const skillsSrc = join(template, "skills");
  const skillsDest = join(workspaceDir, "skills");
  if (existsSync(skillsSrc)) {
    // Always refresh skill pack definitions; USER/memory stay untouched.
    mkdirSync(skillsDest, { recursive: true });
    cpSync(skillsSrc, skillsDest, { recursive: true });
  }

  mkdirSync(join(workspaceDir, "memory"), { recursive: true });
}

function loadGatewayToken() {
  if (process.env.OPENCLAW_GATEWAY_TOKEN) return process.env.OPENCLAW_GATEWAY_TOKEN.trim();
  const cfgPath =
    process.env.OPENCLAW_CONFIG_PATH || join(homedir(), ".openclaw", "openclaw.json");
  if (!existsSync(cfgPath)) throw new Error("gateway_token_missing");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  const token = cfg?.gateway?.auth?.token;
  if (!token) throw new Error("gateway_token_missing");
  return String(token);
}

function gatewayUrl() {
  return (process.env.OPENCLAW_GATEWAY_URL || "http://127.0.0.1:18789").replace(/\/$/, "");
}

/** Set agents.entries[agentId].skills via Gateway config.patch (coordinated reload). */
export async function patchAgentSkills(agentId, skills, { url, token } = {}) {
  if (!Array.isArray(skills)) return false;
  const gwUrl = url || gatewayUrl();
  const gwToken = token || loadGatewayToken();
  const snapshot = await gatewayRpc({
    url: gwUrl,
    token: gwToken,
    method: "config.get",
    params: {},
    timeoutMs: 20_000,
  });
  const hash = snapshot?.hash;
  if (!hash) throw new Error("config_hash_missing");

  const entries = snapshot?.config?.agents?.entries || snapshot?.parsed?.agents?.entries || {};
  const key =
    Object.keys(entries).find((k) => k.toLowerCase() === String(agentId).toLowerCase()) || agentId;
  const prev = entries[key]?.skills;
  if (
    Array.isArray(prev) &&
    prev.length === skills.length &&
    prev.every((s, i) => s === skills[i])
  ) {
    return false;
  }

  await gatewayRpc({
    url: gwUrl,
    token: gwToken,
    method: "config.patch",
    params: {
      baseHash: hash,
      raw: JSON.stringify({
        agents: {
          entries: {
            [key]: { skills },
          },
        },
      }),
    },
    timeoutMs: 30_000,
  });
  return true;
}

/**
 * Ensure a per-user employee agent exists on the Gateway.
 * Idempotent: already-exists is success.
 */
export async function ensureEmployeeAgentInstance(params) {
  const { platformUuid, sku, displayName } = params;
  const def = getEmployeeDef(sku);
  if (!def) throw Object.assign(new Error("unknown_sku"), { code: "unknown_sku" });

  const agentId = buildAgentId(platformUuid, sku);
  const workspace = resolveWorkspaceDir(agentId);
  seedWorkspaceFromTemplate(sku, workspace);

  const token = loadGatewayToken();
  const url = gatewayUrl();
  let created = false;
  try {
    await gatewayRpc({
      url,
      token,
      method: "agents.create",
      params: {
        name: agentId,
        workspace,
        emoji: def.emoji || "🤖",
      },
      timeoutMs: 30_000,
    });
    created = true;
  } catch (err) {
    const msg = String(err.message || err);
    // Idempotent path when agent already exists.
    if (!/already|exists|duplicate/i.test(msg)) {
      throw err;
    }
  }

  try {
    await gatewayRpc({
      url,
      token,
      method: "agents.update",
      params: {
        agentId,
        name: displayName || def.name,
        workspace,
        emoji: def.emoji || "🤖",
      },
      timeoutMs: 20_000,
    });
  } catch {
    // update optional if create just happened
  }

  // Prefer Gateway-coordinated patch so prepared model runtimes stay committed.
  // Raw file writes caused gateway_error: "prepared model runtime owner was not committed".
  try {
    await patchAgentSkills(agentId, def.skills || [], { url, token });
  } catch (err) {
    // Skills are best-effort; agent can still chat with workspace skills.
    console.warn(`[digital-employees] skills patch failed for ${agentId}:`, err.message);
  }

  return {
    agentId,
    workspace,
    sku,
    name: displayName || def.name,
    created,
    sessionKey: buildSessionKey(agentId),
    capabilities: def.capabilities || [],
  };
}

export function verifyPlatformWebhookSignature(fields, signatureHeader, timestampHeader) {
  const secret = String(process.env.OPENCLAW_PLATFORM_WEBHOOK_SECRET || "").trim();
  if (!secret) {
    return { ok: false, error: "webhook_secret_not_configured" };
  }
  const ts = Number(timestampHeader || 0);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) {
    return { ok: false, error: "timestamp_invalid" };
  }
  const canonical = [
    String(ts),
    String(fields.user_uuid || ""),
    String(fields.sku || ""),
    String(fields.status || ""),
    String(fields.source_order_id || ""),
    String(fields.valid_until || ""),
  ].join("\n");
  const expected = createHmac("sha256", secret).update(canonical, "utf8").digest("hex");
  const provided = String(signatureHeader || "")
    .replace(/^sha256=/i, "")
    .trim();
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (!provided || a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, error: "signature_invalid" };
  }
  return { ok: true };
}

export function shortHash(input) {
  return createHash("sha256").update(String(input)).digest("hex").slice(0, 12);
}
