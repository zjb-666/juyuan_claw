# 数字员工 SaaS：平台侧开发文档（ai-project）

日期：2026-08-03  
状态：方案定稿（待平台排期实现）  
对照代码：`/data/ai-project`（本仓库只读参考，不在此改平台）  
配套文档：`saas-openclaw-executor.md`（执行端 / ai_claw）  
已有对接：`platform-api-contract.md`、`login-platform-alignment.md`

---

## 1. 平台要解决什么

平台是**唯一商业与计费真相源**：

| 职责 | 说明 |
|---|---|
| 账号登录 | 现有 `/auth/*`（已与 OpenClaw 登录对齐） |
| 卖数字员工 | SKU 商品 + 支付 + entitlement |
| 算力扣费 | 复用现有 RH / `user_points` / AI 计费链路，**不新建第二套余额** |
| 模型网关 | 执行端 LLM 请求必须打到平台，鉴权后转发厂商并扣算力 |
| 技能仓（可选 Phase 2） | 签名技能包上传、版本、灰度、下载 URL |
| 网页入口 | 购买、我的员工、对话页（或跳转执行端壳内 Web） |
| 设备在线态 | 记录用户绑定的执行端在线/离线（由执行端心跳上报） |

**不做**：本机浏览器自动化、本机记忆库、OpenClaw agent loop。这些在客户电脑上的统一执行端完成。

---

## 2. 和飞书 aily 的类比（产品形态）

飞书 aily 的路径接近：

```text
网页/IM 里对话 → 云端编排与模型 → 需要时调用本机浏览器做检索/内网系统操作
```

我们要做的是同一类「云端脑控 + 本地手脚」：

```text
平台网页对话 → 平台鉴权/算力/权益 → 本机 OpenClaw 执行端跑工具与记忆
```

差异：aily 嵌在飞书生态；我们是自有 SaaS + 自有安装包；本机能力以 **OpenClaw 技能包** 交付，而不是为每个员工 fork 一套客户端。

---

## 3. 目标架构（平台视角）

```text
┌─────────────────── ai-project（平台）───────────────────┐
│  Web：购买员工 / 对话 / 余额 / 设备状态                    │
│  商品与支付 → user_digital_employee_entitlements         │
│  模型网关 → 鉴权 + 扣 RH + 转发厂商                       │
│  （可选）技能仓 OSS + 签名元数据                          │
│  已有：openclaw_mcp（生图/生视频等媒体算力）               │
└─────────────────────┬───────────────────────────────────┘
                      │ HTTPS / WSS
                      │ 1) 对话中继或会话路由
                      │ 2) LLM：执行端 → /api/.../chat/completions
                      │ 3) 权益 webhook → OpenClaw BFF
┌─────────────────────▼───────────────────────────────────┐
│  客户本机：OpenClaw 执行端（ai_claw / product）            │
│  agent loop、技能、browser、本地记忆                      │
└─────────────────────────────────────────────────────────┘
```

纠正上一版「另建独立 SaaS 计费后台」的说法：**计费与模型网关挂在现有 ai-project 上**，不新建钱包。

---

## 4. 平台必做模块

### 4.1 数字员工商品与权益（P0）

现有 `recharge_packages` / `user_package_entitlements` 卖的是会员 + 算力；`agent_benefits` 多为文案。需要新增「可执行员工」权益。

推荐（二选一，优先独立表，语义清晰）：

```sql
-- 商品目录
digital_employee_skus (
  id, sku, display_name, description,
  status,  -- active/deprecated
  meta_json,  -- 模板 id、默认技能列表等
  created_at, updated_at
)

-- 用户权益
user_digital_employee_entitlements (
  id, user_uuid, sku,
  status,  -- active/expired/revoked/suspended
  source_order_id,
  valid_from, valid_until,
  meta_json,
  created_at, updated_at,
  UNIQUE(user_uuid, sku, source_order_id)  -- 或业务幂等键
)
```

或扩展现有套餐：`package_kind=digital_employee` + `employee_sku=hr-recruitment`。

支付成功履约时：

1. 照常发放算力（若套餐含算力）  
2. **额外**写入 / 续期 entitlement  
3. 调用 OpenClaw BFF upsert（见 §6）

只读查询（给网页与执行端 BFF）：

```http
GET /api/openclaw/entitlements
Authorization: Bearer <platform_access_token>
```

响应契约见 `platform-api-contract.md` §4.1。

SKU 首批：

| sku | 展示名 | 含义 |
|---|---|---|
| `hr-recruitment` | 人事招聘数字员工 | 第一个可售技能包权益 |

后续财务、客服只加 sku + 技能包，不改安装包。

### 4.2 模型网关 + 算力扣费（P0，核心）

执行端禁止客户自备 API Key；所有 LLM 走平台。

现状：

- 生图/生视频等已走 `ai_generation` + RH 扣费；OpenClaw 媒体有 `openclaw_mcp/`  
- FastAPI 有 `/api/gateway/chat/completions` **stub**，尚未绑定真实扣费  

要做：把「OpenClaw 对话 LLM」接到**现有计费体系**，而不是另建 balance。

建议路径（与现有 AI 架构一致）：

```text
执行端 POST 平台 OpenAI 兼容 chat/completions
  → 校验租户/用户 token + device_id（可选）
  → 查 RH 余额，不足则 402 / 业务码
  → 按 ai_platform_billing_rule（llm_text / TOKEN 模式）估算或实扣
  → 转发真实厂商（或内部 registry）
  → 按 usage 结算 user_points / compute_ledger
  → 返回 chat.completion
```

实现要点：

| 项 | 要求 |
|---|---|
| 扣费账本 | 复用 `user_points` / 现有 compute ledger；展示进「算力明细」 |
| 计费规则 | `billing_scene=llm_text`，`calculation_mode=token`（input/output price） |
| 鉴权 | 平台用户 token 或设备绑定后的长期 client token（推荐设备激活后发） |
| 幂等 | `Idempotency-Key` 或 `task_id` 防重复扣 |
| 密钥 | 厂商 Key 只在平台；永不下发执行端 |
| 与 MCP | 媒体继续走 `openclaw_mcp`；对话 LLM 走本网关。两边都扣同一用户算力 |

参考实现面（平台内）：

- `app/ai_generation.py`（`_calculate_billing_points` TOKEN 模式）  
- `app/user_services.py`（`grant_points` / 余额口径）  
- `docs/ai_platform_architecture.md`  
- stub：`app/fastapi_app.py` → `/gateway/chat/completions`  

建议正式路由（名称可调，需与执行端配置一致）：

```http
POST /api/openclaw/v1/chat/completions
Authorization: Bearer <platform_or_device_token>
X-OpenClaw-Device-Id: <device_id>
X-OpenClaw-Session-Key: <可选，审计用>
```

请求/响应：OpenAI Chat Completions 兼容。  
余额不足：与现网 AI 任务一致的业务错误码（执行端展示「请充值算力」）。

### 4.3 设备激活与在线状态（P0）

```text
用户登录平台 → 生成激活码或扫码
执行端提交 device_id + 激活凭证
平台绑定 user_uuid ↔ device_id，下发 device_token
执行端心跳 → clients 表 online/offline
网页显示「执行端已上线 / 离线」
```

最小表字段：`device_id`、`user_uuid`、`status`、`last_heartbeat`、`client_version`、`os_info`。

离线时：网页对话应明确提示「请打开本机执行端」，不要静默失败。

### 4.4 对话入口（P0/P1）

两种产品形态，平台至少支持一种：

| 形态 | 说明 | 平台工作量 |
|---|---|---|
| A. 平台网页聊天 | 消息经平台中继到本机 Gateway 会话 | 需会话中继 / WSS |
| B. 执行端内嵌 Web | 壳加载平台同源对话页，本机直连本地 Gateway | 平台只做页面；连通更简单 |

推荐 Phase 1 用 **B 或「网页下指令 + 本机弹会话」**；完整「纯网页远控本机」用 WSS/隧道放 Phase 1.5。

无论哪种：权益校验、余额展示、购买页都在平台。

### 4.5 私有技能仓（P1）

| 能力 | 说明 |
|---|---|
| 上传签名 zip | Employee Pack：`manifest` + skills + 可选 SOUL |
| 版本 / 灰度 / 强制版本 | 按租户或比例 |
| 启用 API | 购买或「启用」后返回 `download_url` + `signature` |

Phase 0 可先把 `hr-recruitment` 打进执行端安装包；技能仓远程下发可后置。

### 4.6 OTA 元数据（P2）

提供版本检查接口（最新 version、强制更新、下载 URL、签名）。安装包构建与签名在执行端仓库；平台只存元数据与分发。

---

## 5. 明确不做 / 后置（平台）

- 不在平台服务器跑 Boss 直聘浏览器（IP/Cookie 必须在客户本机）  
- 不存客户对话记忆正文为默认（仅用量、任务摘要、审计可选）  
- 不另建「OpenClaw 专用余额」；统一 RH  
- 不先做完整 K8s 多区域 / 发票（沿用现网部署）  

---

## 6. 与执行端（ai_claw）对接清单

### 6.1 已存在或已约定

| 方向 | 接口 | 文档 |
|---|---|---|
| 登录 | `/auth/*` | `login-platform-alignment.md` |
| 权益推送 | `POST {BFF}/api/platform/entitlements/upsert` | `platform-api-contract.md` |
| 权益拉取 | `GET /api/openclaw/entitlements` | 同上 §4 |
| 媒体算力 | OpenClaw MCP `/api/mcp/media/*` | `openclaw_mcp/README.md` |

共享密钥：`OPENCLAW_PLATFORM_WEBHOOK_SECRET`（HMAC 签名字段见契约）。

### 6.2 本次新增（平台必须排期）

| # | 接口 / 能力 | 调用方 | 优先级 |
|---|---|---|---|
| 1 | 数字员工 SKU + entitlement 表与支付履约 | 平台内部 | P0 |
| 2 | `GET /api/openclaw/entitlements` | OpenClaw BFF / 网页 | P0 |
| 3 | 支付成功 → BFF `entitlements/upsert` | 平台 → ai_claw | P0 |
| 4 | `POST /api/openclaw/v1/chat/completions` + RH 扣费 | 本机执行端 | P0 |
| 5 | 设备激活 / 心跳 / 在线查询 | 执行端 ↔ 网页 | P0 |
| 6 | 技能包下载元数据 API | 执行端 | P1 |
| 7 | OTA 版本检查 | 执行端 | P2 |

### 6.3 对接时序（购买 → 可用）

```text
1. 用户在平台购买 hr-recruitment
2. 支付成功：写 entitlement +（可选）发算力
3. 平台 POST OpenClaw BFF /api/platform/entitlements/upsert
4. 用户安装/打开执行端，用平台账号登录或激活码绑定设备
5. 执行端/BFF 拉取 entitlements → 确保本机 agent/技能就绪
6. 用户在网页或壳内对话
7. 本机 LLM 请求打平台 chat/completions → 扣 RH
8. 本机执行技能（浏览器等）；记忆写本地 SQLite
```

### 6.4 环境变量约定（平台侧）

```bash
# 回调 OpenClaw BFF
OPENCLAW_BFF_BASE_URL=https://<openclaw-bff-host>
OPENCLAW_PLATFORM_WEBHOOK_SECRET=<与 BFF 一致>

# LLM 网关（厂商 Key 仅平台）
OPENCLAW_LLM_PROVIDER_BASE_URL=...
OPENCLAW_LLM_PROVIDER_API_KEY=...
OPENCLAW_LLM_DEFAULT_MODEL=...
```

---

## 7. 验收标准（平台）

- [ ] 购买人事员工后，库中有 `active` entitlement  
- [ ] upsert 能打到 OpenClaw BFF，失败可重试/可对账  
- [ ] 执行端带用户/设备 token 调 chat/completions 能通，并扣减同一套算力余额  
- [ ] 余额不足时返回明确错误，网页与执行端可提示充值  
- [ ] 无 entitlement 时网页不可进入该员工（或只读引导购买）  
- [ ] 设备离线时网页有明确状态  

---

## 8. 平台任务拆分建议

| 周次 | 内容 |
|---|---|
| W1 | entitlement 模型 + 支付履约写入 + 只读 API + upsert 回调 |
| W2 | chat/completions 真网关 + TOKEN 计费接入 user_points |
| W3 | 设备激活/心跳 + 网页「我的员工/设备状态」 |
| W4 | 与执行端联调购买→对话→扣费闭环；技能仓可并行启动 |

---

## 9. 相关代码索引（只读）

| 主题 | 路径 |
|---|---|
| 算力入账 | `app/user_services.py` → `grant_points` |
| AI 扣费计算 | `app/ai_generation.py` → `_calculate_billing_points` |
| 计费架构说明 | `docs/ai_platform_architecture.md` |
| 钱包/充值 | `app/routes/wallet_recharge.py` |
| OpenClaw 媒体 MCP | `openclaw_mcp/` |
| Chat 网关 stub | `app/fastapi_app.py` `/gateway/chat/completions` |
| OpenClaw 任务路由草案 | `scripts/routes/openclaw_platform_routes.py` |

---

**文档结束。** 执行端改造与本机职责见 `saas-openclaw-executor.md`。
