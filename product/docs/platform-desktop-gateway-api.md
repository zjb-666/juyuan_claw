# 平台接口：Windows 客户端用户 Gateway 分配

版本：`2026.8.5-v6`  
适用：juyuancloud 平台后端实现；聚元灵创产品 BFF（`product/backend`）调用  
读者：平台后端同事

## 产品决策（已拍板）

**一个平台用户对应一台（或一套）专属 OpenClaw Gateway。**

不是“一家企业共用一台 Gateway”。  
企业/组织若仍存在，只用于账号归属、计费、权限等业务，**不作为 Gateway 共享边界**。

对照：

| 层级 | 归属 |
|---|---|
| Gateway | **每用户一台**；**由平台负责开通、启停、配置与写入绑定** |
| Agent / 数字员工 | 跑在该用户自己的 Gateway 内（每用户 × 每 SKU 仍可有独立 agent） |
| 共享 BFF | **产品侧**统一登录 / bootstrap；不按用户复制 BFF |
| Windows 客户端 | 只连产品 BFF 登录，再连自己的 `gateway_url` |

## 正式目标架构（平台负责网关）

```text
正式（目标）

  共享 BFF（产品侧）
       ▲
       │ 登录 / bootstrap / 一次性 setupCode
       │
  Windows 客户端 ──只连 BFF 登录──► 再连自己的 gateway_url
                                       │
  平台负责：                           │
    用户开通                           ▼
      → 自动起该用户 Gateway 实例
      → 写入 user_gateways（url / rpc / token / status）
      →（建议同时）锁死模型白名单与平台算力出口
```

### 职责边界

| 角色 | 负责 | 不负责 |
|---|---|---|
| **平台** | 用户开通权益后**自动**创建/启动专属 Gateway；写入并维护 `user_gateways`；网关生命周期（provisioning / active / suspended / revoked）；模型白名单与算力出口配置；厂商密钥只留平台 | 不实现 Windows 安装包；不把 `gateway_token` 给浏览器或客户端 |
| **产品 BFF（共享）** | 平台登录对齐；`POST /api/desktop/bootstrap` 向平台**查询**当前用户 Gateway；必要时用仅 BFF 可见的 token 申请一次性 setupCode | **不创建、不分配、不启停**用户 Gateway；不往平台库 INSERT Gateway |
| **Windows Hub** | 打开打包进安装包的 BFF 地址登录；用 bootstrap 返回的 `gatewayUrl` / setupCode 配对并常连自己的 Gateway | 不内置长期 Gateway Token；不让用户自填 Gateway / 模型 Key |

### 设备配对（正式体验）

联调阶段可能需要人工 `devices approve`。  
正式环境建议做成：

1. **开通时自动信任**：平台拉起用户 Gateway 后，对来自产品 BFF 签发的 pairing / setupCode 路径自动批准；或  
2. **平台侧代批**：BFF 持服务端凭据调用该用户 Gateway 完成 device approve，用户无感  

目标：用户登录客户端后即可聊天，不必再找运维批设备。

## 背景

聚元灵创 Windows Hub 安装包**不内置**长期 Gateway Token。  
用户在客户端登录平台账号后，产品 BFF 向平台查询：

- 该用户自己的 Gateway 公网地址是什么
- BFF 可用什么服务端凭据向该 Gateway 申请一次性配对码

平台返回后，BFF 只把一次性 setup code 给 Windows 客户端；`gatewayToken` 永不下发客户端。

## 和 Windows 打包地址的关系（先分清）

| 项 | 谁配置 | 说明 |
|---|---|---|
| Windows `-ProductApiBaseUrl` | 产品打包 | 客户端打开的**产品登录页 / BFF** 地址 |
| 本文件的平台接口 | 平台后端 | BFF 登录后去查**当前用户自己的 Gateway** |

当前产品约定：

- **Dev 包**：`-ProductApiBaseUrl` 允许局域网 HTTP，例如 `http://192.168.120.12:8787`
- **正式包**：必须公网 HTTPS
- **本平台接口**：按**用户**解析 Gateway；内网联调可用局域网平台基址

## 调用关系

```text
Windows Hub
  → 产品 BFF  POST /api/desktop/bootstrap   （用户产品会话）
      → 平台   GET  <PLATFORM_DESKTOP_GATEWAY_URL>
         Authorization: Bearer <服务端 Token>
         X-Platform-User-Authorization: Bearer <用户平台 access_token>
      ← 平台返回该用户自己的 Gateway 信息（含仅给 BFF 的 gatewayToken）
  ← BFF 返回 gatewayUrl，必要时附带一次性 setupCode
```

说明：

- **用户平台 Token**：用户登录 juyuancloud 后的 `access_token`，用来确定“查谁的 Gateway”
- **服务端 Token**：平台发给「聚元灵创产品 BFF」的 server-to-server 密钥，只放服务器 `.env`

## 数据模型建议（平台侧）

若此前按“企业 Gateway”建了表，需要改成用户级绑定。推荐形态：

```text
user_gateways
  - user_uuid          （唯一：一用户至多一台活跃 Gateway）
  - gateway_url
  - gateway_rpc_url
  - gateway_token      （仅服务端可读）
  - status             （provisioning | active | suspended | revoked）
  - created_at / updated_at
```

兼容过渡也可以：

- 保留 `enterprises` 做业务组织
- 但 `desktop-gateway` 接口必须按 `user_uuid` 查该用户自己的 Gateway
- **禁止**再通过 `enterprise_members → enterprise_gateways` 返回“企业共享 Gateway”

测试数据示例：

```sql
INSERT INTO user_gateways (user_uuid, gateway_url, gateway_rpc_url, gateway_token, status)
VALUES (
  '<测试用户uuid>',
  'wss://user-a.gateway.example.com',
  'https://user-a-internal.example.com',
  'gateway-secret-only-for-bff',
  'active'
);
```

## 建议路径

正式环境：

```text
GET https://juyuancloud.com/api/openclaw/desktop-gateway
```

内网联调：

```text
GET http://192.168.120.245:5000/openclaw/desktop-gateway
```

相对路径（相对 `PLATFORM_API_BASE_URL`）：

```text
/openclaw/desktop-gateway
```

产品侧配置：

```bash
# 内网联调
PLATFORM_API_BASE_URL=http://192.168.120.245:5000
PLATFORM_DESKTOP_GATEWAY_URL=/openclaw/desktop-gateway
PLATFORM_DESKTOP_GATEWAY_SERVICE_TOKEN=<平台签发的服务端密钥>

# 正式环境
# PLATFORM_API_BASE_URL=https://juyuancloud.com/api
# PLATFORM_DESKTOP_GATEWAY_URL=/openclaw/desktop-gateway
# PLATFORM_DESKTOP_GATEWAY_SERVICE_TOKEN=<平台签发的服务端密钥>
```

说明：若 `PLATFORM_DESKTOP_GATEWAY_URL` 写成绝对 URL，产品 BFF 要求使用 `https:`；相对路径可跟局域网 `PLATFORM_API_BASE_URL` 联调。

## 请求

```http
GET /openclaw/desktop-gateway
Accept: application/json
Authorization: Bearer <PLATFORM_DESKTOP_GATEWAY_SERVICE_TOKEN>
X-Platform-User-Authorization: Bearer <用户平台 access_token>
```

路径兼容：`/api/openclaw/desktop-gateway` 也可。

### 鉴权规则

1. `Authorization` = 平台为聚元灵创 BFF 签发的服务端 Token，否则 `401`
2. `X-Platform-User-Authorization` = 有效用户平台 `access_token`，否则 `401`
3. 仅服务端 Token、无用户 Token → `401`
4. 仅用户 Token、无服务端 Token → `401`  
   （禁止用户本人直接拉取自己 Gateway 的服务端凭据）
5. 用户有效，但尚未分配/开通个人 Gateway → `403`

### 平台侧实现要点

1. 校验服务端 Token
2. 解析用户 Token，得到 `user_uuid`
3. 按 **user_uuid** 查该用户自己的 Gateway 绑定
4. 返回该用户的 `gateway_url` / `gateway_rpc_url` / `gateway_token`
5. 用户 A 绝不能查到用户 B 的 Gateway
6. 不要把该接口暴露给浏览器前端或 Windows 安装包

## 成功响应

HTTP `200`：

```json
{
  "state": 200,
  "message": "ok",
  "data": {
    "gateway_url": "wss://user-a.gateway.example.com",
    "gateway_rpc_url": "https://user-a-internal.example.com",
    "gateway_token": "仅返回给受信任BFF的服务端凭据"
  }
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `gateway_url` | 是 | 该用户 Windows 客户端最终连接的 Gateway。公网必须 `https:`/`wss:`；内网联调允许 localhost/局域网的 `http:`/`ws:` |
| `gateway_rpc_url` | 否 | 产品 BFF 调用 `device.pair.setupCode` 的地址；默认可等于 `gateway_url`（协议换成 BFF 可访问的 http/https） |
| `gateway_token` | 是 | 该用户 Gateway 的服务端凭据，**仅给 BFF** |

兼容 camelCase：`gatewayUrl` / `gatewayRpcUrl` / `gatewayToken`。

## 谁负责开通用户 Gateway

**平台负责网关全生命周期，并写入 `user_gateways`。**  
产品 BFF / Windows 客户端**只查询、只连接**，不创建、不分配、不启停。

推荐时机（平台侧）：

1. **正式主路径**：用户购买/开通相关权益后，平台自动起 Gateway 实例并写入 `user_gateways`（status → `active`）  
2. 运营后台手动给用户绑定/重建一台 Gateway（运维兜底）  
3. 内网联调时人工 INSERT 测试行（仅联调）  

产品侧只调用：

`GET /openclaw/desktop-gateway`（按当前用户读取已绑定 Gateway）

不要让 Windows 安装包或产品 BFF 自己往平台库插 Gateway。

## 模型白名单 + 算力扣费（产品决策，已拍板）

与网页端 `juyuancloud.com` **同一套算力余额**。客户端与用户 Gateway **不得**自备厂商 API Key，也不得让用户自行添加模型。

**对接细则（平台已交付）：** [`gateway-llm-billing-integration.md`](./gateway-llm-billing-integration.md)（`2026.8.5-v1`）。

### 原则

| 项 | 决定 |
|---|---|
| 模型目录 | **平台配置**；分配用户 Gateway 时写入该用户实例，客户端只读展示 |
| 可用模型 | **白名单**：`qwen3_6_plus`、`deepseek_v4_pro`、`glm_5`（默认 `qwen3_6_plus`） |
| 厂商密钥 | **只在平台**；永不下发 Windows 安装包 / 用户 Gateway 配置为可编辑密钥 |
| 扣费 | 每次 LLM 调用走平台现网计费（RH / `user_points` / 算力明细），与网页对话同一用户余额 |
| Windows Hub | 隐藏 Config / 本地 Gateway 装机向导 / 自定义 API Key；下拉框只显示白名单；`INSUFFICIENT_POINTS` → 充值提示 |

### 分配用户 Gateway 时平台必须完成的配置

开通/绑定 `user_gateways` 行时，同步把该用户 Gateway 的模型出口锁死为平台计费网关：

```text
# 内网联调示例（正式环境换公网 host + 按用户重签 apiKey）
models.providers.juyuancloud.baseUrl  = http://192.168.120.213:5000/api/gateway
models.providers.juyuancloud.apiKey   = sk-jyc-…   # 仅 Gateway 服务端；禁止给客户端/BFF
models.providers.juyuancloud.api      = openai-completions
models.providers.juyuancloud.models   = qwen3_6_plus,deepseek_v4_pro,glm_5
agents.defaults.model.primary         = qwen3_6_plus
# 禁止：openai/anthropic/dashscope 等用户可改直连；禁止空 baseUrl 回落官方 Key
# 注意：baseUrl 不要再拼 /v1；路径就是 {baseUrl}/chat/completions
```

正式环境示例：`https://juyuancloud.com/api/gateway`。

说明：

- `apiKey` 是平台按用户签发的 LLM 调用凭据（`sk-jyc-…`），不是 OpenAI Key，也不是 `gateway_token`  
- Gateway 出网只打平台 `/api/gateway/chat/completions`；平台鉴权后转发厂商并扣算力  
- 白名单变更只在平台/运维侧改，再滚到用户 Gateway；用户侧无入口  

### 平台已交付的计费出口

| 项 | 值 |
|---|---|
| chat | `POST {baseUrl}/chat/completions`（OpenAI 兼容，支持 stream） |
| models | `GET {baseUrl}/models` |
| balance | `GET {baseUrl}/balance` → `{ balance, unit: "RH", … }` |
| health | `GET {baseUrl}/health` |
| 鉴权 | `Authorization: Bearer sk-jyc-…`（Gateway；BFF 代查余额时也可服务端使用） |
| 余额不足 | `error.code = INSUFFICIENT_POINTS`（HTTP 400/402，可带 `juyuancloud.compute_balance`） |
| 模型不在白名单 | `error.code = model_not_allowed` |

### 产品侧配合（已落地 / 联调）

1. **平台**：用户 Gateway 只配 `juyuancloud` provider + 白名单（见上）  
2. **Windows Hub**：模型白名单锁定；标题栏展示「算力 xxx RH」；映射 `INSUFFICIENT_POINTS`  
3. **BFF**：`GET /api/desktop/compute-balance` 代查余额（优先 `desktop-gateway.compute_balance`，否则服务端调 `/balance`）；bootstrap 可透传只读 `models`；**永不**把 `sk-jyc-…` / `gateway_token` 给 Hub  
4. 不在 `product/backend` 或 Windows 客户端实现第二套余额账本  

可选增强（便于客户端只读展示）：

```http
GET /openclaw/desktop-gateway
```

在现有 `data` 上增加只读字段（camelCase 兼容）：

```json
{
  "models": [
    { "id": "qwen3_6_plus", "display_name": "qwen3.6-plus" },
    { "id": "deepseek_v4_pro", "display_name": "deepseek-v4-pro" },
    { "id": "glm_5", "display_name": "glm_5" }
  ],
  "default_model": "qwen3_6_plus",
  "llm_base_url": "https://juyuancloud.com/api/gateway",
  "compute_balance": {
    "balance": 1234.5,
    "ledger_sum": 1234.5,
    "unit": "RH",
    "currency": "compute"
  }
}
```

这些字段**不替代** Gateway 内已写死的配置；仅供 BFF/客户端展示。密钥仍不得出现在该响应对客户端的投影里。若暂不嵌 `compute_balance`，可仅给 BFF 返回 `llm_api_key`（禁止进 Hub）。## 错误响应

### 401

```json
{ "state": 401, "message": "unauthorized", "data": null }
```

### 403 未分配用户 Gateway

```json
{ "state": 403, "message": "user gateway not assigned", "data": null }
```

### 503

```json
{ "state": 503, "message": "desktop gateway lookup unavailable", "data": null }
```

## 安全要求

1. `gateway_token` 只能出现在平台 → 产品 BFF 通道
2. 服务端 Token 不进前端、不进 Windows 安装包、不给用户
3. 服务端 Token 可轮换；轮换后同步产品 `.env`
4. 严格按用户隔离：A 用户查不到 B 用户 Gateway
5. 审计可记 user_uuid / 是否成功；禁止把 token 明文写入日志

## 产品 BFF 后续动作（平台无需实现）

1. 若客户端已配对同一 `gateway_url`：只返回 `gatewayUrl`
2. 否则用 `gateway_rpc_url + gateway_token` 调该用户 Gateway 的 `device.pair.setupCode`
3. 把一次性 `setupCode` 返回 Windows 客户端完成配对

## 联调清单（平台侧）

- [ ] 接口按 **user_uuid** 返回该用户自己的 Gateway（不再走企业共享）
- [ ] 内网可访问（例如 `http://192.168.120.245:5000/openclaw/desktop-gateway`）
- [ ] 已交付 `PLATFORM_DESKTOP_GATEWAY_SERVICE_TOKEN`
- [ ] 错误服务端 Token → 401
- [ ] 只有用户 Token → 401
- [ ] 已开通个人 Gateway 的测试账号 → 200
- [ ] 未开通账号 → 403
- [ ] 用户 A 的 token 查不到用户 B 的 Gateway
- [ ] `gateway_token` 不出现在前端/客户端日志
- [ ]（正式）用户开通权益后自动起 Gateway 并写 `user_gateways`，无需产品侧插库
- [ ]（正式）配对自动信任或平台代批，用户无需手工 `devices approve`

上线前：

- [ ] 公网 `https://juyuancloud.com/api/...` 可访问
- [ ] 正式 `gateway_url` 对客户端可达（`wss`/`https`）
- [ ] 用户 Gateway 模型出口已锁平台算力计费（见上文「模型白名单 + 算力扣费」）

## 交付给产品侧

1. 最终接口 URL  
2. 服务端 Token  
3. 至少一个**已绑定个人 Gateway** 的测试账号  

```bash
PLATFORM_API_BASE_URL=http://192.168.120.245:5000
PLATFORM_DESKTOP_GATEWAY_URL=/openclaw/desktop-gateway
PLATFORM_DESKTOP_GATEWAY_SERVICE_TOKEN=<平台交付值>
```
