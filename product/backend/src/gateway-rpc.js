import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

/**
 * One-shot Gateway WebSocket RPC (token auth, no device pairing).
 * Uses client mode "cli" so shared-secret token restores operator scopes.
 */
export async function gatewayRpc(opts) {
  const {
    url,
    token,
    method,
    params = {},
    timeoutMs = 15_000,
  } = opts;

  if (!url) throw new Error("gateway url required");
  if (!token) throw new Error("gateway token required");
  if (!method) throw new Error("gateway method required");

  const wsUrl = toWsUrl(url);
  const ws = new WebSocket(wsUrl);

  try {
    await waitOpen(ws, timeoutMs);
    await onceMessage(
      ws,
      (obj) => obj?.type === "event" && obj?.event === "connect.challenge",
      timeoutMs,
    );

    const connectId = randomUUID();
    const connectPromise = onceMessage(
      ws,
      (obj) => obj?.type === "res" && obj?.id === connectId,
      timeoutMs,
    );
    ws.send(
      JSON.stringify({
        type: "req",
        id: connectId,
        method: "connect",
        params: {
          minProtocol: 4,
          maxProtocol: 4,
          client: {
            id: "cli",
            version: "0.1.0",
            platform: process.platform || "linux",
            mode: "cli",
          },
          role: "operator",
          scopes: ["operator.admin", "operator.read", "operator.write"],
          auth: { token },
        },
      }),
    );
    const hello = await connectPromise;
    if (!hello.ok) {
      throw new Error(hello.error?.message || "gateway connect failed");
    }

    const reqId = randomUUID();
    const responsePromise = onceMessage(
      ws,
      (obj) => obj?.type === "res" && obj?.id === reqId,
      timeoutMs,
    );
    ws.send(JSON.stringify({ type: "req", id: reqId, method, params }));
    const res = await responsePromise;
    if (!res.ok) {
      const err = new Error(res.error?.message || `gateway ${method} failed`);
      err.code = res.error?.code;
      err.details = res.error?.details;
      throw err;
    }
    return res.payload;
  } finally {
    try {
      ws.close();
    } catch {
      // ignore
    }
  }
}

function toWsUrl(httpOrWs) {
  const raw = String(httpOrWs).replace(/\/$/, "");
  if (raw.startsWith("ws://") || raw.startsWith("wss://")) return raw;
  if (raw.startsWith("https://")) return `wss://${raw.slice("https://".length)}`;
  if (raw.startsWith("http://")) return `ws://${raw.slice("http://".length)}`;
  return `ws://${raw}`;
}

function waitOpen(ws, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("gateway websocket open timeout"));
    }, timeoutMs);
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (err) => {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("open", onOpen);
      ws.off("error", onError);
    };
    ws.once("open", onOpen);
    ws.once("error", onError);
  });
}

function onceMessage(ws, filter, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("gateway rpc timeout"));
    }, timeoutMs);
    const onMessage = (data) => {
      try {
        const obj = JSON.parse(String(data));
        if (filter(obj)) {
          cleanup();
          resolve(obj);
        }
      } catch {
        // ignore non-json frames
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error("gateway websocket closed"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("close", onClose);
    };
    ws.on("message", onMessage);
    ws.once("close", onClose);
  });
}
