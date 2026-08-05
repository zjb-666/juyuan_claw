import {
  buildAgentId,
  buildSessionKey,
  ensureEmployeeAgentInstance,
  getEmployeeDef,
  resolveWorkspaceDir,
  seedWorkspaceFromTemplate,
  verifyPlatformWebhookSignature,
} from "./digital-employees.js";
import {
  autoSolveBossCaptcha,
  bossLoginMode,
  checkBossLoginStatus,
  clickBossLoginImage,
  confirmBossCaptcha,
  expandBossLoginCaptcha,
  prepareBossSelfLogin,
  refreshBossLoginView,
  sendBossLoginSms,
  startBossPhoneLogin,
  submitBossLoginSms,
} from "./boss-login.js";
import {
  getHrPipelineSnapshot,
  handleHrDialogue,
  ingestDesktopCandidates,
  ingestDesktopReplies,
  ingestDesktopActionResult,
  enrichDesktopShortlist,
} from "./hr-pipeline.js";
import {
  bindBrowserNode,
  getBoundBrowserNode,
  getBrowserNodeStatus,
  unbindBrowserNode,
  withBrowserNode,
} from "./browser-node.js";
import {
  getActiveEmployeeSku,
  getEntitlement,
  getPlatformAccessToken,
  isEntitlementActive,
  listEntitlementsForUser,
  parseDevGrantSkus,
  pullEntitlementsFromPlatform,
  savePlatformTokens,
  setActiveEmployee,
  upsertEntitlement,
} from "./entitlements.js";

async function resolveLocalUserId(pool, platformUuid) {
  const [rows] = await pool.query(
    "SELECT id FROM users WHERE platform_uuid = ? LIMIT 1",
    [platformUuid],
  );
  return rows[0]?.id || null;
}

async function applyDevGrants(pool, user) {
  const skus = parseDevGrantSkus();
  if (!skus.length || !user?.platform_uuid) return;
  for (const sku of skus) {
    if (!getEmployeeDef(sku)) continue;
    await upsertEntitlement(pool, {
      userId: user.id,
      platformUuid: user.platform_uuid,
      sku,
      status: "active",
      sourceOrderId: "dev-grant",
      displayName: getEmployeeDef(sku).name,
      validFrom: new Date().toISOString(),
      validUntil: new Date(Date.now() + 365 * 86400_000).toISOString(),
    });
  }
}

async function syncPulledEntitlements(pool, user, accessToken) {
  try {
    const items = await pullEntitlementsFromPlatform(accessToken);
    if (!Array.isArray(items)) return;
    for (const item of items) {
      const sku = String(item.sku || "").trim();
      if (!sku || !getEmployeeDef(sku)) continue;
      await upsertEntitlement(pool, {
        userId: user.id,
        platformUuid: user.platform_uuid,
        sku,
        status: item.status || "active",
        sourceOrderId: item.source_order_id || item.sourceOrderId || null,
        displayName: item.display_name || item.displayName || getEmployeeDef(sku).name,
        validFrom: item.valid_from || item.validFrom || null,
        validUntil: item.valid_until || item.validUntil || null,
        meta: item.meta || null,
      });
    }
  } catch {
    // Pull is optional compensation; ignore failures at login.
  }
}

export async function afterPlatformLogin(pool, user, platformTokens = {}) {
  if (platformTokens.access_token) {
    await savePlatformTokens(
      pool,
      user.id,
      platformTokens.access_token,
      platformTokens.refresh_token || null,
    );
    await syncPulledEntitlements(pool, user, platformTokens.access_token);
  }
  await applyDevGrants(pool, user);
}

async function serializeEmployee(pool, user, row, selectedSku) {
  const def = getEmployeeDef(row.sku) || {};
  const active = isEntitlementActive(row);
  return {
    sku: row.sku,
    name: row.display_name || def.name || row.sku,
    description: def.description || "",
    emoji: def.emoji || "🤖",
    status: active ? "active" : row.status,
    active,
    agentId: row.agent_id || buildAgentId(user.platform_uuid, row.sku),
    provisioned: Boolean(row.agent_id),
    selected: selectedSku === row.sku,
    validUntil: row.valid_until,
    capabilities: def.capabilities || [],
    modes: Array.isArray(def.modes) ? def.modes : [],
    workflow: def.workflow || null,
    sessionKey: row.agent_id ? buildSessionKey(row.agent_id) : null,
  };
}

export async function registerEmployeeRoutes(app, { pool, requireFeature, features }) {
  app.get("/api/platform/health", async () => ({
    state: 200,
    message: "ok",
    data: {
      service: "openclaw-product-bff",
      digitalEmployees: true,
    },
  }));

  app.post("/api/platform/entitlements/upsert", async (req, reply) => {
    const body = req.body || {};
    const verified = verifyPlatformWebhookSignature(
      body,
      req.headers["x-openclaw-signature"],
      req.headers["x-openclaw-timestamp"],
    );
    if (!verified.ok) {
      return reply.code(401).send({ state: 401, message: verified.error, data: null });
    }

    const platformUuid = String(body.user_uuid || "").trim();
    const sku = String(body.sku || "").trim();
    const status = String(body.status || "active").trim().toLowerCase();
    if (!platformUuid || !sku) {
      return reply.code(400).send({ state: 400, message: "user_uuid_and_sku_required", data: null });
    }
    if (!getEmployeeDef(sku)) {
      return reply.code(404).send({ state: 404, message: "unknown_sku", data: { sku } });
    }

    let userId = await resolveLocalUserId(pool, platformUuid);
    if (!userId) {
      // Create a placeholder local user so entitlement can land before first login.
      const [result] = await pool.query(
        `INSERT INTO users (username, platform_uuid, password_hash, nickname, bio, avatar)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          platformUuid,
          platformUuid,
          "platform-auth",
          body.display_name || getEmployeeDef(sku).name,
          "",
          "",
        ],
      );
      userId = result.insertId;
      await pool.query("INSERT IGNORE INTO user_settings (user_id) VALUES (?)", [userId]);
    }

    let agentId = null;
    let workspacePath = null;
    let provisioned = false;
    if (status === "active") {
      try {
        const inst = await ensureEmployeeAgentInstance({
          platformUuid,
          sku,
          displayName: body.display_name || getEmployeeDef(sku).name,
        });
        agentId = inst.agentId;
        workspacePath = inst.workspace;
        provisioned = true;
      } catch (err) {
        req.log.error(err);
        return reply.code(503).send({
          state: 503,
          message: `provision_failed: ${err.message}`,
          data: null,
        });
      }
    }

    const row = await upsertEntitlement(pool, {
      userId,
      platformUuid,
      sku,
      status,
      sourceOrderId: body.source_order_id || null,
      displayName: body.display_name || getEmployeeDef(sku).name,
      validFrom: body.valid_from || null,
      validUntil: body.valid_until || null,
      agentId,
      workspacePath,
      meta: body.meta || null,
    });

    return {
      state: 200,
      message: "ok",
      data: {
        user_uuid: platformUuid,
        sku,
        status: row.status,
        agent_id: row.agent_id,
        provisioned,
      },
    };
  });

  app.post("/api/platform/entitlements/sync", async (req, reply) => {
    const body = req.body || {};
    const verified = verifyPlatformWebhookSignature(
      {
        user_uuid: body.user_uuid || "sync",
        sku: "sync",
        status: "sync",
        source_order_id: String((body.entitlements || []).length),
        valid_until: "",
      },
      req.headers["x-openclaw-signature"],
      req.headers["x-openclaw-timestamp"],
    );
    if (!verified.ok) {
      return reply.code(401).send({ state: 401, message: verified.error, data: null });
    }
    const items = Array.isArray(body.entitlements) ? body.entitlements : [];
    const results = [];
    for (const item of items) {
      const fakeReq = { body: item, headers: req.headers, log: req.log };
      // Reuse upsert logic by recursive call pattern — inline minimal path:
      const platformUuid = String(item.user_uuid || "").trim();
      const sku = String(item.sku || "").trim();
      if (!platformUuid || !sku || !getEmployeeDef(sku)) {
        results.push({ sku, ok: false, error: "invalid" });
        continue;
      }
      let userId = await resolveLocalUserId(pool, platformUuid);
      if (!userId) {
        const [result] = await pool.query(
          `INSERT INTO users (username, platform_uuid, password_hash, nickname, bio, avatar)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [platformUuid, platformUuid, "platform-auth", item.display_name || sku, "", ""],
        );
        userId = result.insertId;
        await pool.query("INSERT IGNORE INTO user_settings (user_id) VALUES (?)", [userId]);
      }
      const status = String(item.status || "active").toLowerCase();
      let agentId = null;
      let workspacePath = null;
      if (status === "active") {
        try {
          const inst = await ensureEmployeeAgentInstance({
            platformUuid,
            sku,
            displayName: item.display_name || getEmployeeDef(sku).name,
          });
          agentId = inst.agentId;
          workspacePath = inst.workspace;
        } catch (err) {
          results.push({ sku, ok: false, error: err.message });
          continue;
        }
      }
      await upsertEntitlement(pool, {
        userId,
        platformUuid,
        sku,
        status,
        sourceOrderId: item.source_order_id || null,
        displayName: item.display_name || getEmployeeDef(sku).name,
        validFrom: item.valid_from || null,
        validUntil: item.valid_until || null,
        agentId,
        workspacePath,
        meta: item.meta || null,
      });
      results.push({ sku, ok: true, agent_id: agentId });
    }
    return { state: 200, message: "ok", data: { results } };
  });

  app.get("/api/employees", async (req, reply) => {
    if (!req.user?.row) return reply.code(401).send({ error: "unauthorized" });
    await applyDevGrants(pool, req.user.row);
    const token = await getPlatformAccessToken(pool, req.user.row.id);
    if (token) await syncPulledEntitlements(pool, req.user.row, token);

    const rows = await listEntitlementsForUser(pool, req.user.row.id);
    let selectedSku = await getActiveEmployeeSku(pool, req.user.row.id);
    const items = [];
    for (const row of rows) {
      items.push(await serializeEmployee(pool, req.user.row, row, selectedSku));
    }
    const activeItems = items.filter((i) => i.active);
    if (!selectedSku && activeItems[0]) {
      selectedSku = activeItems[0].sku;
      await setActiveEmployee(pool, req.user.row.id, selectedSku);
      for (const item of items) item.selected = item.sku === selectedSku;
    }
    return { state: 200, data: { items, selectedSku } };
  });

  app.get("/api/employees/current", async (req, reply) => {
    if (!req.user?.row) return reply.code(401).send({ error: "unauthorized" });
    const selectedSku = await getActiveEmployeeSku(pool, req.user.row.id);
    if (!selectedSku) {
      return { state: 200, data: { employee: null } };
    }
    const row = await getEntitlement(pool, req.user.row.id, selectedSku);
    if (!row || !isEntitlementActive(row)) {
      return { state: 200, data: { employee: null } };
    }
    return {
      state: 200,
      data: { employee: await serializeEmployee(pool, req.user.row, row, selectedSku) },
    };
  });

  app.post("/api/employees/:sku/ensure", async (req, reply) => {
    if (!req.user?.row) return reply.code(401).send({ error: "unauthorized" });
    const sku = String(req.params.sku || "").trim();
    if (!getEmployeeDef(sku)) {
      return reply.code(404).send({ state: 404, message: "unknown_sku", data: null });
    }
    await applyDevGrants(pool, req.user.row);
    let row = await getEntitlement(pool, req.user.row.id, sku);
    if (!row || !isEntitlementActive(row)) {
      return reply.code(403).send({
        state: 403,
        message: "请先在平台购买该数字员工",
        error: "entitlement_required",
        data: { sku },
      });
    }
    if (!req.user.row.platform_uuid) {
      return reply.code(400).send({ state: 400, message: "platform_uuid_required", data: null });
    }
    try {
      const inst = await ensureEmployeeAgentInstance({
        platformUuid: req.user.row.platform_uuid,
        sku,
        displayName: row.display_name || getEmployeeDef(sku).name,
      });
      row = await upsertEntitlement(pool, {
        userId: req.user.row.id,
        platformUuid: req.user.row.platform_uuid,
        sku,
        status: row.status,
        sourceOrderId: row.source_order_id,
        displayName: row.display_name,
        validFrom: row.valid_from,
        validUntil: row.valid_until,
        agentId: inst.agentId,
        workspacePath: inst.workspace,
      });
      return {
        state: 200,
        message: "ok",
        data: await serializeEmployee(
          pool,
          req.user.row,
          row,
          await getActiveEmployeeSku(pool, req.user.row.id),
        ),
      };
    } catch (err) {
      req.log.error(err);
      return reply.code(503).send({
        state: 503,
        message: `provision_failed: ${err.message}`,
        data: null,
      });
    }
  });

  app.post("/api/employees/:sku/select", async (req, reply) => {
    if (!req.user?.row) return reply.code(401).send({ error: "unauthorized" });
    const sku = String(req.params.sku || "").trim();
    const row = await getEntitlement(pool, req.user.row.id, sku);
    if (!row || !isEntitlementActive(row)) {
      return reply.code(403).send({
        state: 403,
        message: "请先在平台购买该数字员工",
        error: "entitlement_required",
      });
    }
    if (!row.agent_id && req.user.row.platform_uuid) {
      const inst = await ensureEmployeeAgentInstance({
        platformUuid: req.user.row.platform_uuid,
        sku,
        displayName: row.display_name || getEmployeeDef(sku).name,
      });
      await upsertEntitlement(pool, {
        userId: req.user.row.id,
        platformUuid: req.user.row.platform_uuid,
        sku,
        status: row.status,
        sourceOrderId: row.source_order_id,
        displayName: row.display_name,
        validFrom: row.valid_from,
        validUntil: row.valid_until,
        agentId: inst.agentId,
        workspacePath: inst.workspace,
      });
    }
    await setActiveEmployee(pool, req.user.row.id, sku);
    const fresh = await getEntitlement(pool, req.user.row.id, sku);
    return {
      state: 200,
      message: "已切换数字员工",
      data: { employee: await serializeEmployee(pool, req.user.row, fresh, sku) },
    };
  });

  async function withUserBrowserNode(req, fn) {
    const bound = await getBoundBrowserNode(pool, req.user.row.id);
    return withBrowserNode(bound?.node_id || null, fn);
  }

  // Per-user browser node (Boss runs on employer's PC, not shared server browser).
  app.get("/api/employees/:sku/browser-node", async (req, reply) => {
    if (!req.user?.row) return reply.code(401).send({ error: "unauthorized" });
    const sku = String(req.params.sku || "").trim();
    if (sku !== "hr-recruitment") {
      return reply.code(400).send({ state: 400, message: "sku_not_supported", data: { sku } });
    }
    try {
      const data = await getBrowserNodeStatus(pool, req.user.row.id);
      return { state: 200, message: "ok", data };
    } catch (err) {
      req.log.error(err);
      return reply.code(503).send({
        state: 503,
        message: `browser_node_status_failed: ${err.message}`,
        data: null,
      });
    }
  });

  app.post("/api/employees/:sku/browser-node/bind", async (req, reply) => {
    if (!req.user?.row) return reply.code(401).send({ error: "unauthorized" });
    const sku = String(req.params.sku || "").trim();
    if (sku !== "hr-recruitment") {
      return reply.code(400).send({ state: 400, message: "sku_not_supported", data: { sku } });
    }
    try {
      const row = await bindBrowserNode(pool, req.user.row.id, {
        nodeId: req.body?.nodeId,
        displayName: req.body?.displayName,
        platform: req.body?.platform,
      });
      const data = await getBrowserNodeStatus(pool, req.user.row.id);
      return { state: 200, message: "已绑定本机浏览器节点", data: { ...data, row } };
    } catch (err) {
      req.log.error(err);
      return reply.code(400).send({
        state: 400,
        message: err.message === "node_id_required" ? "请选择要绑定的节点" : err.message,
        data: null,
      });
    }
  });

  app.post("/api/employees/:sku/browser-node/unbind", async (req, reply) => {
    if (!req.user?.row) return reply.code(401).send({ error: "unauthorized" });
    const sku = String(req.params.sku || "").trim();
    if (sku !== "hr-recruitment") {
      return reply.code(400).send({ state: 400, message: "sku_not_supported", data: { sku } });
    }
    await unbindBrowserNode(pool, req.user.row.id);
    const data = await getBrowserNodeStatus(pool, req.user.row.id);
    return { state: 200, message: "已解除绑定", data };
  });

  // Boss login gate: default self-login (user logs in, product only checks).
  // Set BOSS_LOGIN_MODE=assisted to restore phone/SMS/captcha proxy flow.
  app.post("/api/employees/:sku/boss-login/start", async (req, reply) => {
    if (!req.user?.row) return reply.code(401).send({ error: "unauthorized" });
    const sku = String(req.params.sku || "").trim();
    if (sku !== "hr-recruitment") {
      return reply.code(400).send({ state: 400, message: "sku_not_supported", data: { sku } });
    }
    const row = await getEntitlement(pool, req.user.row.id, sku);
    if (!row || !isEntitlementActive(row)) {
      return reply.code(403).send({
        state: 403,
        message: "请先在平台购买该数字员工",
        error: "entitlement_required",
      });
    }
    try {
      const mode = bossLoginMode();
      const data = await withUserBrowserNode(req, async () =>
        mode === "self"
          ? await prepareBossSelfLogin(req.body?.targetId || null, {
              restart: Boolean(req.body?.restart),
            })
          : await startBossPhoneLogin(req.body?.targetId || null, {
              restart: Boolean(req.body?.restart),
            }),
      );
      return { state: 200, message: "ok", data: { ...data, mode } };
    } catch (err) {
      req.log.error(err);
      const missing = err?.code === "browser_node_required" || /browser_node_required/.test(err.message);
      return reply.code(missing ? 400 : 503).send({
        state: missing ? 400 : 503,
        message: missing
          ? "请先绑定并连接本机浏览器节点，再打开登录页。"
          : `boss_login_failed: ${err.message}`,
        data: null,
        error: missing ? "browser_node_required" : undefined,
      });
    }
  });

  app.post("/api/employees/:sku/boss-login/send-sms", async (req, reply) => {
    if (!req.user?.row) return reply.code(401).send({ error: "unauthorized" });
    if (bossLoginMode() === "self") {
      return reply.code(400).send({
        state: 400,
        message: "当前为自助登录模式：请你在浏览器自行登录后点「检验登录态」，产品不会代发短信。",
        error: "self_login_mode",
      });
    }
    const sku = String(req.params.sku || "").trim();
    if (sku !== "hr-recruitment") {
      return reply.code(400).send({ state: 400, message: "sku_not_supported", data: { sku } });
    }
    try {
      const data = await sendBossLoginSms({
        targetId: req.body?.targetId || null,
        phone: req.body?.phone,
      });
      return { state: 200, message: data.message || "ok", data };
    } catch (err) {
      req.log.error(err);
      const bad = err.message === "invalid_phone";
      return reply.code(bad ? 400 : 503).send({
        state: bad ? 400 : 503,
        message: bad ? "请输入正确的11位手机号" : `boss_login_send_sms_failed: ${err.message}`,
        data: null,
      });
    }
  });

  app.post("/api/employees/:sku/boss-login/submit-sms", async (req, reply) => {
    if (!req.user?.row) return reply.code(401).send({ error: "unauthorized" });
    if (bossLoginMode() === "self") {
      return reply.code(400).send({
        state: 400,
        message: "当前为自助登录模式：请你在浏览器自行登录后点「检验登录态」。",
        error: "self_login_mode",
      });
    }
    const sku = String(req.params.sku || "").trim();
    if (sku !== "hr-recruitment") {
      return reply.code(400).send({ state: 400, message: "sku_not_supported", data: { sku } });
    }
    try {
      const data = await submitBossLoginSms({
        targetId: req.body?.targetId || null,
        code: req.body?.code,
        phone: req.body?.phone || null,
      });
      return { state: 200, message: data.message || "ok", data };
    } catch (err) {
      req.log.error(err);
      const bad = err.message === "invalid_sms_code";
      return reply.code(bad ? 400 : 503).send({
        state: bad ? 400 : 503,
        message: bad ? "请输入短信验证码" : `boss_login_submit_sms_failed: ${err.message}`,
        data: null,
      });
    }
  });

  app.post("/api/employees/:sku/boss-login/expand", async (req, reply) => {
    if (!req.user?.row) return reply.code(401).send({ error: "unauthorized" });
    const sku = String(req.params.sku || "").trim();
    if (sku !== "hr-recruitment") {
      return reply.code(400).send({ state: 400, message: "sku_not_supported", data: { sku } });
    }
    try {
      const data = await expandBossLoginCaptcha(req.body?.targetId || null);
      return { state: 200, message: "ok", data };
    } catch (err) {
      req.log.error(err);
      return reply.code(503).send({
        state: 503,
        message: `boss_login_expand_failed: ${err.message}`,
        data: null,
      });
    }
  });

  app.post("/api/employees/:sku/boss-login/click", async (req, reply) => {
    if (!req.user?.row) return reply.code(401).send({ error: "unauthorized" });
    const sku = String(req.params.sku || "").trim();
    if (sku !== "hr-recruitment") {
      return reply.code(400).send({ state: 400, message: "sku_not_supported", data: { sku } });
    }
    try {
      const data = await clickBossLoginImage({
        targetId: req.body?.targetId || null,
        xRatio: Number(req.body?.xRatio),
        yRatio: Number(req.body?.yRatio),
        tileIndex:
          req.body?.tileIndex === undefined || req.body?.tileIndex === null
            ? undefined
            : Number(req.body.tileIndex),
      });
      return { state: 200, message: "ok", data };
    } catch (err) {
      req.log.error(err);
      return reply.code(503).send({
        state: 503,
        message: `boss_login_click_failed: ${err.message}`,
        data: null,
      });
    }
  });

  app.post("/api/employees/:sku/boss-login/confirm-captcha", async (req, reply) => {
    if (!req.user?.row) return reply.code(401).send({ error: "unauthorized" });
    const sku = String(req.params.sku || "").trim();
    if (sku !== "hr-recruitment") {
      return reply.code(400).send({ state: 400, message: "sku_not_supported", data: { sku } });
    }
    try {
      const data = await confirmBossCaptcha(req.body?.targetId || null);
      return { state: 200, message: data.message || "ok", data };
    } catch (err) {
      req.log.error(err);
      return reply.code(503).send({
        state: 503,
        message: `boss_login_confirm_failed: ${err.message}`,
        data: null,
      });
    }
  });

  app.post("/api/employees/:sku/boss-login/auto-captcha", async (req, reply) => {
    if (!req.user?.row) return reply.code(401).send({ error: "unauthorized" });
    const sku = String(req.params.sku || "").trim();
    if (sku !== "hr-recruitment") {
      return reply.code(400).send({ state: 400, message: "sku_not_supported", data: { sku } });
    }
    try {
      const data = await autoSolveBossCaptcha(req.body?.targetId || null);
      return { state: 200, message: data.message || "ok", data };
    } catch (err) {
      req.log.error(err);
      return reply.code(503).send({
        state: 503,
        message: `boss_login_auto_captcha_failed: ${err.message}`,
        data: null,
      });
    }
  });

  app.post("/api/employees/:sku/boss-login/check", async (req, reply) => {
    if (!req.user?.row) return reply.code(401).send({ error: "unauthorized" });
    const sku = String(req.params.sku || "").trim();
    if (sku !== "hr-recruitment") {
      return reply.code(400).send({ state: 400, message: "sku_not_supported", data: { sku } });
    }
    try {
      const data = await withUserBrowserNode(req, () =>
        checkBossLoginStatus(req.body?.targetId || null),
      );
      return { state: 200, message: data.message, data };
    } catch (err) {
      req.log.error(err);
      const missing = err?.code === "browser_node_required" || /browser_node_required/.test(err.message);
      return reply.code(missing ? 400 : 503).send({
        state: missing ? 400 : 503,
        message: missing
          ? "请先绑定并连接本机浏览器节点，再检验登录态。"
          : `boss_login_check_failed: ${err.message}`,
        data: null,
        error: missing ? "browser_node_required" : undefined,
      });
    }
  });

  app.post("/api/employees/:sku/boss-login/refresh", async (req, reply) => {
    if (!req.user?.row) return reply.code(401).send({ error: "unauthorized" });
    const sku = String(req.params.sku || "").trim();
    if (sku !== "hr-recruitment") {
      return reply.code(400).send({ state: 400, message: "sku_not_supported", data: { sku } });
    }
    try {
      const data = await withUserBrowserNode(req, () =>
        refreshBossLoginView(req.body?.targetId || null),
      );
      return { state: 200, message: "ok", data };
    } catch (err) {
      req.log.error(err);
      return reply.code(503).send({
        state: 503,
        message: `boss_login_refresh_failed: ${err.message}`,
        data: null,
      });
    }
  });

  app.get("/api/employees/:sku/pipeline", async (req, reply) => {
    if (!req.user?.row) return reply.code(401).send({ error: "unauthorized" });
    const sku = String(req.params.sku || "").trim();
    if (sku !== "hr-recruitment") {
      return reply.code(400).send({ state: 400, message: "sku_not_supported", data: { sku } });
    }
    const snap = await getHrPipelineSnapshot(pool, req.user.row.id);
    return { state: 200, message: "ok", data: snap };
  });

  app.post("/api/employees/:sku/pipeline/act", async (req, reply) => {
    if (!req.user?.row) return reply.code(401).send({ error: "unauthorized" });
    const sku = String(req.params.sku || "").trim();
    if (sku !== "hr-recruitment") {
      return reply.code(400).send({ state: 400, message: "sku_not_supported", data: { sku } });
    }
    const action = String(req.body?.action || "").trim();
    const messageMap = {
      confirm_invite: "确认发送",
      cancel_invite: "取消邀约",
      confirm_plan: "确认执行",
      cancel_plan: "先别执行",
      prepare_invite: "约面试",
      ask_candidates: "打招呼提问",
      screen_answers: "根据回复二次筛选",
      followup_24h: "24小时未回复跟进",
      request_resume: "自动请求简历",
      download_resume: "自动下载简历",
      auto_advance: "继续自动推进",
      status: "当前进度",
    };
    const message = messageMap[action] || String(req.body?.message || "").trim();
    if (!message) {
      return reply.code(400).send({ state: 400, message: "action_or_message_required" });
    }
    try {
      const data = await handleHrDialogue(
        pool,
        req.user.row,
        message,
        req.body?.clientContext || {},
      );
      return { state: 200, message: "ok", data };
    } catch (err) {
      req.log.error(err);
      return reply.code(503).send({
        state: 503,
        message: `pipeline_failed: ${err.message}`,
        data: null,
      });
    }
  });

  /** Desktop scraped Boss「沟通」candidates → JD screen (no demo seeds). */
  app.post("/api/employees/:sku/pipeline/ingest", async (req, reply) => {
    if (!req.user?.row) return reply.code(401).send({ error: "unauthorized" });
    const sku = String(req.params.sku || "").trim();
    if (sku !== "hr-recruitment") {
      return reply.code(400).send({ state: 400, message: "sku_not_supported", data: { sku } });
    }
    try {
      const data = await ingestDesktopCandidates(pool, req.user.row, {
        jobId: req.body?.jobId,
        candidates: req.body?.candidates || [],
      });
      return { state: 200, message: "ok", data };
    } catch (err) {
      req.log.error(err);
      return reply.code(503).send({
        state: 503,
        message: `pipeline_ingest_failed: ${err.message}`,
        data: null,
      });
    }
  });

  /** Desktop side-effect result → authoritative per-user pipeline state. */
  app.post("/api/employees/:sku/pipeline/action-result", async (req, reply) => {
    if (!req.user?.row) return reply.code(401).send({ error: "unauthorized" });
    const sku = String(req.params.sku || "").trim();
    if (sku !== "hr-recruitment") {
      return reply.code(400).send({ state: 400, message: "sku_not_supported", data: { sku } });
    }
    try {
      const data = await ingestDesktopActionResult(pool, req.user.row, {
        type: req.body?.type,
        results: req.body?.results || [],
        runId: req.body?.runId || null,
        error: req.body?.error || null,
      });
      return { state: 200, message: "ok", data };
    } catch (err) {
      req.log.error(err);
      return reply.code(503).send({
        state: 503,
        message: `pipeline_action_result_failed: ${err.message}`,
        data: null,
      });
    }
  });

  /** Desktop reply inspection → authoritative candidate transcript for second screening. */
  app.post("/api/employees/:sku/pipeline/replies", async (req, reply) => {
    if (!req.user?.row) return reply.code(401).send({ error: "unauthorized" });
    const sku = String(req.params.sku || "").trim();
    if (sku !== "hr-recruitment") {
      return reply.code(400).send({ state: 400, message: "sku_not_supported", data: { sku } });
    }
    try {
      const data = await ingestDesktopReplies(pool, req.user.row, {
        jobId: req.body?.jobId,
        results: req.body?.results || [],
        runId: req.body?.runId || null,
      });
      return { state: 200, message: "ok", data };
    } catch (err) {
      req.log.error(err);
      return reply.code(503).send({
        state: 503,
        message: `pipeline_reply_ingest_failed: ${err.message}`,
        data: null,
      });
    }
  });

  /** After shortlist: patch resume/profile text from desktop Boss window. */
  app.post("/api/employees/:sku/pipeline/enrich", async (req, reply) => {
    if (!req.user?.row) return reply.code(401).send({ error: "unauthorized" });
    const sku = String(req.params.sku || "").trim();
    if (sku !== "hr-recruitment") {
      return reply.code(400).send({ state: 400, message: "sku_not_supported", data: { sku } });
    }
    try {
      const data = await enrichDesktopShortlist(pool, req.user.row, {
        jobId: req.body?.jobId,
        candidates: req.body?.candidates || [],
      });
      return { state: 200, message: "ok", data };
    } catch (err) {
      req.log.error(err);
      return reply.code(503).send({
        state: 503,
        message: `pipeline_enrich_failed: ${err.message}`,
        data: null,
      });
    }
  });

  // Expose helpers for chat route
  app.decorate("resolveChatEmployee", async (userRow) => {
    await applyDevGrants(pool, userRow);
    let sku = await getActiveEmployeeSku(pool, userRow.id);
    const rows = await listEntitlementsForUser(pool, userRow.id);
    const active = rows.filter((r) => isEntitlementActive(r));
    if (!sku || !active.some((r) => r.sku === sku)) {
      sku = active[0]?.sku || null;
      if (sku) await setActiveEmployee(pool, userRow.id, sku);
    }
    if (!sku) return null;
    let row = active.find((r) => r.sku === sku);
    if (!row) return null;
    if (!row.agent_id && userRow.platform_uuid) {
      try {
        const inst = await ensureEmployeeAgentInstance({
          platformUuid: userRow.platform_uuid,
          sku,
          displayName: row.display_name || getEmployeeDef(sku).name,
        });
        row = await upsertEntitlement(pool, {
          userId: userRow.id,
          platformUuid: userRow.platform_uuid,
          sku,
          status: row.status,
          sourceOrderId: row.source_order_id,
          displayName: row.display_name,
          validFrom: row.valid_from,
          validUntil: row.valid_until,
          agentId: inst.agentId,
          workspacePath: inst.workspace,
        });
      } catch (err) {
        // Demo / offline: still chat via product HR pipeline without live Gateway.
        const demoOk = process.env.DEMO_HR_PIPELINE === "1";
        const unreachable = /ECONNREFUSED|fetch failed|gateway/i.test(String(err.message || err));
        if (!(demoOk || unreachable)) throw err;
        const agentId = buildAgentId(userRow.platform_uuid, sku);
        const workspace = resolveWorkspaceDir(agentId);
        try {
          seedWorkspaceFromTemplate(sku, workspace);
        } catch {
          // template seed best-effort
        }
        row = await upsertEntitlement(pool, {
          userId: userRow.id,
          platformUuid: userRow.platform_uuid,
          sku,
          status: row.status,
          sourceOrderId: row.source_order_id,
          displayName: row.display_name,
          validFrom: row.valid_from,
          validUntil: row.valid_until,
          agentId,
          workspacePath: workspace,
        });
        return {
          sku,
          agentId,
          sessionKey: buildSessionKey(agentId),
          name: row.display_name || getEmployeeDef(sku)?.name || sku,
          offlineProvision: true,
        };
      }
    }
    // Already has agent_id but may have been provisioned offline.
    if (!row.agent_id && userRow.platform_uuid) {
      const agentId = buildAgentId(userRow.platform_uuid, sku);
      row = { ...row, agent_id: agentId };
    }
    return {
      sku,
      agentId: row.agent_id,
      sessionKey: buildSessionKey(row.agent_id),
      name: row.display_name || getEmployeeDef(sku)?.name || sku,
    };
  });
}
