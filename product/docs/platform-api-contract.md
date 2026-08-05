# 平台 ↔ OpenClaw 产品层 后端接口文档

版本：`2026.7.25-v1`  
适用：平台后端（另机开发）对接 OpenClaw 附属客户端 / BFF  
OpenClaw BFF 默认基址：`http://<openclaw-host>:8787`（可配置）

Windows 客户端用户 Gateway 分配接口见：`product/docs/platform-desktop-gateway-api.md`（一用户一台 Gateway）。

---

## 1. 业务约定（已拍板）

| 项 | 约定 |
|---|---|
| Boss 直聘 | **全自动**（由用户独立数字员工实例 + browser/招聘技能执行） |
| 实例模型 | **每用户 × 每 SKU 一个独立 OpenClaw agent**（独立 workspace、会话库、可调教人格） |
| 记忆 | 落在该 agent 的 workspace + `agents/<agentId>/agent/openclaw-agent.sqlite` |
| 安装包 | 通用瘦客户端；能力由账号权益决定 |
| 本仓库职责 | OpenClaw 客户端 + BFF；平台负责商品/支付/权益源数据 |

SKU 示例：

| sku | 名称 | OpenClaw template |
|---|---|---|
| `hr-recruitment` | 人事招聘数字员工 | `product/digital-employees/hr-recruitment` |

---

## 2. 对接总览

```
平台支付成功
  → 平台持久化 entitlement
  → POST OpenClaw BFF /api/platform/entitlements/upsert   （推荐，实时）
       或 OpenClaw 登录后 GET 平台 /openclaw/entitlements （备选拉取）

用户打开客户端登录（已对齐平台 /auth）
  → BFF 确保 entitlement 对应实例已创建（agents.create）
  → 客户端选择数字员工 → 聊天 sessionKey = agent:<agentId>:main
```

共享密钥：

```bash
# 两边一致
OPENCLAW_PLATFORM_WEBHOOK_SECRET=<随机长串>
```

鉴权方式：请求头  

- `X-OpenClaw-Timestamp: <unix秒>`（|now-ts| ≤ 300）  
- `X-OpenClaw-Signature: sha256=<hex>`  

签名原文（UTF-8，换行拼接，**不要** JSON 原文）：

```text
{timestamp}\n{user_uuid}\n{sku}\n{status}\n{source_order_id}\n{valid_until}
```

空字段用空字符串。示例（伪代码）：

```python
import hmac, hashlib
canonical = "\n".join([
  str(ts),
  user_uuid,
  sku,
  status,
  source_order_id or "",
  valid_until or "",
])
sig = hmac.new(secret.encode(), canonical.encode(), hashlib.sha256).hexdigest()
# Header: X-OpenClaw-Signature: sha256=<sig>
```

---

## 3. 平台 → OpenClaw BFF（平台实现调用方）

### 3.1 权益写入 / 更新（支付成功、续费、退款必调）

```http
POST /api/platform/entitlements/upsert
Content-Type: application/json
X-OpenClaw-Timestamp: 1721900000
X-OpenClaw-Signature: sha256=...
```

Body：

```json
{
  "user_uuid": "平台 users.uuid",
  "sku": "hr-recruitment",
  "status": "active",
  "source_order_id": "订单号或唯一业务单号",
  "valid_from": "2026-07-25T00:00:00+08:00",
  "valid_until": "2027-07-25T00:00:00+08:00",
  "display_name": "人事招聘数字员工",
  "meta": {
    "package_id": 123,
    "note": "可选透传"
  }
}
```

`status` 枚举：`active` | `expired` | `revoked` | `suspended`

成功：

```json
{
  "state": 200,
  "message": "ok",
  "data": {
    "user_uuid": "...",
    "sku": "hr-recruitment",
    "status": "active",
    "agent_id": "de-a1b2c3d4-hr-recruitment",
    "provisioned": true
  }
}
```

说明：

- 首次 `active` 时 BFF 会创建独立 agent 实例（幂等：已存在则复用）
- `revoked` / `expired` / `suspended` **不删除** workspace（保留记忆）；仅禁止新会话进入
- 同一 `user_uuid + sku` upsert 幂等

### 3.2 批量同步（可选，对账用）

```http
POST /api/platform/entitlements/sync
```

Body：

```json
{
  "user_uuid": "可选；省略则要求管理员密钥场景",
  "entitlements": [
    {
      "user_uuid": "...",
      "sku": "hr-recruitment",
      "status": "active",
      "source_order_id": "...",
      "valid_from": "...",
      "valid_until": "..."
    }
  ]
}
```

### 3.3 健康检查

```http
GET /api/platform/health
```

无需签名。返回 OpenClaw BFF / Gateway 是否可用。

---

## 4. OpenClaw BFF → 平台（平台实现被调方，备选）

若平台暂不能推送，可提供拉取接口，BFF 在用户登录后用 **平台 access_token** 调用：

### 4.1 查询用户数字员工权益

```http
GET /openclaw/entitlements
Authorization: Bearer <platform_access_token>
```

或网关前缀：`GET /api/openclaw/entitlements`

响应：

```json
{
  "state": 200,
  "message": "ok",
  "data": {
    "items": [
      {
        "sku": "hr-recruitment",
        "status": "active",
        "source_order_id": "ORD-xxx",
        "valid_from": "2026-07-25T00:00:00+08:00",
        "valid_until": "2027-07-25T00:00:00+08:00",
        "display_name": "人事招聘数字员工"
      }
    ]
  }
}
```

配置（OpenClaw `.env`）：

```bash
PLATFORM_ENTITLEMENTS_URL=https://juyuancloud.com/api/openclaw/entitlements
```

**推荐仍以 3.1 推送为主**；拉取作补偿。

---

## 5. 客户端使用的 OpenClaw API（平台无需实现）

供联调参考：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/employees` | 当前登录用户可用数字员工列表 |
| POST | `/api/employees/:sku/ensure` | 确保实例已创建 |
| POST | `/api/employees/:sku/select` | 设为当前工作员工 |
| GET | `/api/employees/current` | 当前选中员工 |
| POST | `/api/chat` | 对话（自动绑到当前员工 `agent:<id>:main`） |

`GET /api/employees` 示例：

```json
{
  "state": 200,
  "data": {
    "items": [
      {
        "sku": "hr-recruitment",
        "name": "人事招聘数字员工",
        "status": "active",
        "agentId": "de-a1b2c3d4-hr-recruitment",
        "provisioned": true,
        "selected": true,
        "capabilities": ["boss_auto_screen", "candidate_rank", "interview_invite"]
      }
    ]
  }
}
```

无权益时 `items: []`，客户端提示去平台购买。

---

## 6. agentId 规则

```text
de-{platformUuid前8位去横线小写}-{sku}
例：uuid=a1b2c3d4-xxxx-... sku=hr-recruitment
→ de-a1b2c3d4-hr-recruitment
```

须满足 OpenClaw：`^[a-z0-9][a-z0-9_-]{0,63}$`（总长 ≤ 64）。

会话键：

```text
agent:<agentId>:main
```

---

## 7. 错误码约定

| HTTP | state | 含义 |
|---|---|---|
| 400 | 400 | 参数错误 |
| 401 | 401 | 签名失败 / 未登录 |
| 403 | 403 | 权益无效（revoked/expired） |
| 404 | 404 | 未知 sku |
| 409 | 409 | 冲突（少见） |
| 503 | 503 | Gateway 不可用，实例创建失败 |

---

## 8. 平台侧最小落地清单

1. 数字员工商品 SKU（至少一个 `hr-recruitment`）  
2. 支付成功写 entitlement 表  
3. 调 OpenClaw `POST /api/platform/entitlements/upsert`  
4. （可选）实现 `GET /openclaw/entitlements`  
5. 退款/到期时 upsert `status=revoked|expired`  

---

## 9. 联调环境变量（OpenClaw 产品 `.env`）

```bash
PLATFORM_API_BASE_URL=http://192.168.120.245:5000
OPENCLAW_PLATFORM_WEBHOOK_SECRET=replace-me
PLATFORM_ENTITLEMENTS_URL=   # 可选拉取
# 开发无平台时本地授权（勿用于生产）
DIGITAL_EMPLOYEE_DEV_GRANT=hr-recruitment
```

---

## 10. 变更记录

| 版本 | 说明 |
|---|---|
| 2026.7.25-v1 | 首版：独立实例、推送 upsert、备选拉取、hr-recruitment |
