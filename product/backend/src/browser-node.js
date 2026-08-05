import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { gatewayRpc } from "./gateway-rpc.js";

/**
 * Per-user browser node binding.
 * Boss login/automation must run on the employer's machine (node host),
 * not on the shared Gateway server browser.
 */

const browserCtx = new AsyncLocalStorage();

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

export function bossBrowserMode() {
  const mode = String(process.env.BOSS_BROWSER_MODE || "user_node").trim().toLowerCase();
  return mode === "server" ? "server" : "user_node";
}

export function withBrowserNode(nodeId, fn) {
  return browserCtx.run({ nodeId: nodeId || null }, fn);
}

export function currentBrowserNodeId() {
  return browserCtx.getStore()?.nodeId || null;
}

export async function ensureBrowserNodeTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hr_browser_nodes (
      user_id BIGINT PRIMARY KEY,
      node_id VARCHAR(128) NOT NULL,
      display_name VARCHAR(160) NULL,
      platform VARCHAR(64) NULL,
      meta JSON NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_hr_browser_node_id (node_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

export async function getBoundBrowserNode(pool, userId) {
  await ensureBrowserNodeTables(pool);
  const [rows] = await pool.query(`SELECT * FROM hr_browser_nodes WHERE user_id = ? LIMIT 1`, [
    userId,
  ]);
  return rows[0] || null;
}

export async function bindBrowserNode(pool, userId, { nodeId, displayName, platform }) {
  await ensureBrowserNodeTables(pool);
  const id = String(nodeId || "").trim();
  if (!id) throw new Error("node_id_required");
  await pool.query(
    `INSERT INTO hr_browser_nodes (user_id, node_id, display_name, platform, meta)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       node_id = VALUES(node_id),
       display_name = VALUES(display_name),
       platform = VALUES(platform),
       updated_at = CURRENT_TIMESTAMP`,
    [userId, id, displayName || null, platform || null, JSON.stringify({ source: "product" })],
  );
  return getBoundBrowserNode(pool, userId);
}

export async function unbindBrowserNode(pool, userId) {
  await ensureBrowserNodeTables(pool);
  await pool.query(`DELETE FROM hr_browser_nodes WHERE user_id = ?`, [userId]);
  return { ok: true };
}

function isBrowserCapableNode(node) {
  const caps = Array.isArray(node?.caps) ? node.caps : [];
  const commands = Array.isArray(node?.commands) ? node.commands : [];
  return caps.includes("browser") || commands.includes("browser.proxy");
}

export async function listGatewayBrowserNodes() {
  const payload = await gatewayRpc({
    url: gatewayUrl(),
    token: loadGatewayToken(),
    method: "node.list",
    timeoutMs: 20_000,
    params: {},
  });
  const nodes = Array.isArray(payload?.nodes) ? payload.nodes : [];
  return nodes
    .filter((n) => isBrowserCapableNode(n))
    .map((n) => ({
      nodeId: n.nodeId,
      displayName: n.displayName || n.nodeId,
      platform: n.platform || null,
      connected: Boolean(n.connected),
      pending: Boolean(n.pending),
      caps: n.caps || [],
      commands: n.commands || [],
    }));
}

export async function getBrowserNodeStatus(pool, userId) {
  const mode = bossBrowserMode();
  const bound = await getBoundBrowserNode(pool, userId);
  let available = [];
  try {
    available = await listGatewayBrowserNodes();
  } catch (err) {
    return {
      mode,
      bound: bound
        ? { nodeId: bound.node_id, displayName: bound.display_name, platform: bound.platform }
        : null,
      online: false,
      available: [],
      error: err.message,
      ready: mode === "server",
      message:
        mode === "user_node"
          ? `无法列出本机浏览器节点：${err.message}。请确认 Gateway 可达，并在你的电脑运行 openclaw node。`
          : `Gateway 节点列表不可用：${err.message}`,
    };
  }

  const live = bound
    ? available.find((n) => n.nodeId === bound.node_id && n.connected)
    : null;
  const ready =
    mode === "server" ? true : Boolean(live);
  return {
    mode,
    bound: bound
      ? { nodeId: bound.node_id, displayName: bound.display_name, platform: bound.platform }
      : null,
    online: Boolean(live),
    available,
    ready,
    message: ready
      ? mode === "server"
        ? "当前为服务器浏览器模式（仅内测）。"
        : `本机浏览器运行时已连接：${live.displayName}`
      : bound
        ? `已绑定 ${bound.display_name || bound.node_id}，但当前未在线。请打开桌面客户端（或开发过渡的本机运行时）。`
        : "尚未连接本机浏览器运行时。请安装并打开「招聘助手」桌面客户端；开发内测可用本机 Node 过渡。",
    installHint: [
      "【量产】安装「聚元灵创招聘助手」桌面客户端（内嵌浏览器，一键完成）。",
      "【开发过渡】本机临时运行时：",
      "1. 安装与 Gateway 同版本的 OpenClaw CLI",
      "2. 设置 OPENCLAW_GATEWAY_TOKEN",
      `3. openclaw node run --host ${process.env.OPENCLAW_NODE_HINT_HOST || "<网关局域网IP>"} --port 18789`,
      "4. 批准配对后，在本页绑定节点并检验登录态",
    ].join("\n"),
  };
}

function parseNodeInvokeBrowserResult(res) {
  const raw = res?.payloadJSON ?? res?.payload ?? res;
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  // Node browser.proxy returns { result, files? } or a JSON string of that.
  if (parsed && typeof parsed === "object" && "result" in parsed) {
    return parsed.result;
  }
  if (typeof parsed === "string") {
    try {
      const again = JSON.parse(parsed);
      if (again && typeof again === "object" && "result" in again) return again.result;
      return again;
    } catch {
      return parsed;
    }
  }
  return parsed;
}

/**
 * Dispatch a browser control call.
 * user_node mode: requires AsyncLocalStorage nodeId (or explicit opts.nodeId).
 * server mode: Gateway local browser.request (legacy / demo only).
 */
export async function dispatchBrowserRequest(method, path, body, query = {}, opts = {}) {
  const mode = bossBrowserMode();
  const nodeId = opts.nodeId || currentBrowserNodeId();

  if (mode === "user_node") {
    if (!nodeId) {
      const err = new Error("browser_node_required");
      err.code = "browser_node_required";
      throw err;
    }
    const res = await gatewayRpc({
      url: gatewayUrl(),
      token: loadGatewayToken(),
      method: "node.invoke",
      timeoutMs: opts.timeoutMs || 90_000,
      params: {
        nodeId,
        command: "browser.proxy",
        idempotencyKey: randomUUID(),
        timeoutMs: opts.timeoutMs || 90_000,
        params: {
          method,
          path,
          query: { profile: "openclaw", ...query },
          body,
          profile: "openclaw",
        },
      },
    });
    return parseNodeInvokeBrowserResult(res);
  }

  return gatewayRpc({
    url: gatewayUrl(),
    token: loadGatewayToken(),
    method: "browser.request",
    timeoutMs: opts.timeoutMs || 90_000,
    params: {
      method,
      path,
      body,
      query: { profile: "openclaw", ...query },
    },
  });
}
