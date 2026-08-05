# 用户 Gateway → 平台 LLM 计费出口对接说明

版本：`2026.8.5-v2`  
读者：用户 OpenClaw Gateway / 运维 / 产品 BFF / Windows Hub  
平台侧：juyuancloud（本机联调 `192.168.120.213:5000`）

---

## 1. 这是什么

用户专属 Gateway **不得**自备 OpenAI / 阿里云等厂商 Key。  
所有对话请求必须打到**平台计费出口**，与网页端同一套算力余额。

```text
Windows Hub
  → 用户自己的 OpenClaw Gateway
      → 平台  POST /api/gateway/chat/completions
         Authorization: Bearer <平台签发的用户 LLM apiKey>
      ← OpenAI 兼容响应（平台已扣算力）
```

---

## 2. 联调地址与测试账号（内网）

| 项 | 值 |
|---|---|
| 平台 LLM baseUrl | `http://192.168.120.213:5000/api/gateway` |
| chat 接口 | `POST http://192.168.120.213:5000/api/gateway/chat/completions` |
| models 接口 | `GET http://192.168.120.213:5000/api/gateway/models` |
| 余额接口 | `GET http://192.168.120.213:5000/api/gateway/balance` |
| 健康检查 | `GET http://192.168.120.213:5000/api/gateway/health` |
| 测试用户 | 手机号 `17363663742` |
| 该用户 LLM apiKey | 联调时向平台索取（形如 `sk-jyc-…`）；**禁止**写入 git / 安装包 / 工单明文 |
| 默认模型 | `qwen3_6_plus` |
| 白名单模型 | `qwen3_6_plus`、`deepseek_v4_pro`、`glm_5` |

> **正式环境**把 host 换成公网平台 API（例如 `https://juyuancloud.com/api/gateway`），apiKey 由平台按用户重新签发，勿复用联调 key。
>
> 若本文曾贴过完整联调 key，视为已泄露：请平台吊销并重签后再联调。

---

## 3. Gateway 必须怎么配

把平台当成唯一 provider，锁死出口（名称可按你们配置键调整，语义必须一致）：

```text
models.providers.juyuancloud.baseUrl  = http://192.168.120.213:5000/api/gateway
models.providers.juyuancloud.apiKey   = sk-jyc-<向平台索取的联调密钥>
models.providers.juyuancloud.api      = openai-completions   # 或等价：OpenAI Chat Completions 兼容
models.providers.juyuancloud.models   = qwen3_6_plus,deepseek_v4_pro,glm_5

agents.defaults.model.primary         = qwen3_6_plus
# 各 agent 的 model 也只能落在白名单内
```

说明：

- `baseUrl` **不要**再拼一层 `/v1`；请求路径就是 `{baseUrl}/chat/completions`
- `apiKey` 放在 Gateway **服务端配置**里，通过 `Authorization: Bearer <apiKey>` 发出
- 禁止再配置 openai / anthropic / dashscope 等用户可改的直连 provider
- 禁止空 baseUrl 回落到官方 Key

### 请求示例

```http
POST /api/gateway/chat/completions HTTP/1.1
Host: 192.168.120.213:5000
Authorization: Bearer sk-jyc-<联调密钥>
Content-Type: application/json

{
  "model": "qwen3_6_plus",
  "messages": [
    {"role": "user", "content": "你好"}
  ],
  "stream": false
}
```

流式：`"stream": true`，响应为 SSE（`text/event-stream`），末尾 `data: [DONE]`。

### 算力余额（客户端展示用）

计费口：

```http
GET /api/gateway/balance HTTP/1.1
Host: 192.168.120.213:5000
Authorization: Bearer sk-jyc-<联调密钥>
```

成功示例：

```json
{
  "object": "juyuancloud.compute_balance",
  "user_uuid": "4728a9bb-2537-412c-b146-eeb94d59f3b9",
  "balance": 1234.5,
  "ledger_sum": 1234.5,
  "unit": "RH",
  "currency": "compute"
}
```

- `balance`：可消费算力（与网页钱包/算力展示同源，非负）
- **Windows 客户端不得持有 `sk-jyc-…`**，不能直连本接口

产品侧展示路径（已落地）：

```text
Hub 标题栏「算力 xxx RH」
  → GET {ProductBFF}/api/desktop/compute-balance   (Bearer = BFF 登录 JWT)
      → 优先：平台 desktop-gateway 返回的 compute_balance
      → 否则：BFF 用该用户 llm_api_key（仅服务端）调 GET {llmBase}/balance
```

建议刷新时机：进入 Hub、窗口激活、每 2 分钟；`balance == 0` / `INSUFFICIENT_POINTS` 时提示充值。

平台 `GET /openclaw/desktop-gateway` 推荐直接带上只读余额（免 BFF 再持 key）：

```json
{
  "gateway_url": "...",
  "gateway_token": "...",
  "compute_balance": { "balance": 1234.5, "ledger_sum": 1234.5, "unit": "RH", "currency": "compute" }
}
```

若暂不方便嵌余额，可仅给 BFF（勿下发客户端）返回 `llm_api_key` + `llm_base_url`，由 BFF 代查 `/balance`。

对话成功时，非流式响应也会带上扩展字段（便于扣完立刻刷新 UI）：

```json
{
  "choices": [...],
  "juyuancloud": {
    "compute_balance": { "balance": 1200, "ledger_sum": 1200, "unit": "RH", "currency": "compute" }
  }
}
```

算力不足时 HTTP `400`/`402`，`error.code = INSUFFICIENT_POINTS`，同样带 `juyuancloud.compute_balance`，客户端应提示「请充值算力」。

### 成功响应（非流式，形态 OpenAI 兼容）

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1710000000,
  "model": "qwen3_6_plus",
  "choices": [
    {
      "index": 0,
      "message": {"role": "assistant", "content": "..."},
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 0,
    "completion_tokens": 0,
    "total_tokens": 0
  }
}
```

### 常见错误

| HTTP | code（error.code） | 含义 |
|---|---|---|
| 401 | `unauthorized` | apiKey 错误 / 已吊销 |
| 400 | `model_not_allowed` | 模型不在白名单 |
| 400 / 402 | `INSUFFICIENT_POINTS` | 用户算力不足；响应含 `juyuancloud.compute_balance`，提示充值 |
| 502 | `VENDOR_HTTP_ERROR` 等 | 上游厂商失败（平台侧问题，Gateway 原样提示即可） |

错误体：

```json
{
  "error": {
    "message": "...",
    "type": "invalid_request_error",
    "code": "unauthorized",
    "param": null
  }
}
```

---

## 4. 两把钥匙别搞混

| 凭据 | 谁用 | 用途 |
|---|---|---|
| `gateway_token`（user_gateways） | **产品 BFF** | 调用户 Gateway 做 `device.pair.setupCode` 配对 |
| `sk-jyc-...`（user_llm_api_keys） | **用户 Gateway 服务端**；可选由平台经 desktop-gateway **仅下发给 BFF** 用于代查 `/balance` | 调平台 `/api/gateway/chat/completions` 扣算力；BFF 代查余额 |

- BFF **默认不需要**长期保存 LLM `sk-jyc-...`；优先消费 desktop-gateway 里的 `compute_balance`
- 若平台只给 `llm_api_key`：BFF 可服务端代查 `/balance`，**禁止**写入 Hub / 安装包 / 日志全文
- Gateway **不需要**、也**不能**用 `PLATFORM_DESKTOP_GATEWAY_SERVICE_TOKEN`
- Windows 客户端两把都**不能**有

---

## 5. 禁止事项（防泄露 / 防绕过）— 必须遵守

1. **禁止**把 `sk-jyc-...` 写进 Windows 安装包、客户端本地文件、前端页面、剪贴板提示、日志明文  
2. **禁止**在聊天 UI / 设置页展示或允许用户编辑 apiKey / baseUrl / 任意模型  
3. **禁止**把厂商官方 Key（OpenAI / DashScope / 火山等）配进该用户 Gateway  
4. **禁止**配置第二个可直连厂商的 provider 作为回落  
5. **禁止**把平台 LLM apiKey 提交到 git、发到群聊截图、贴到工单明文（需要交接用线下或密钥系统）  
6. **禁止**多个用户共用一把 `sk-jyc-...`（一用户一把，泄漏即吊销重签）  
7. **禁止**用用户登录 JWT 代替 LLM apiKey 打本计费口（本口只认 `sk-jyc-...`）  
8. Gateway 访问日志若必须记鉴权头：只记前缀（如 `sk-jyc-****`），**禁止**记完整 Bearer  

配置文件权限建议：仅 Gateway 进程用户可读；不要挂到可被 Windows 客户端拉取的目录。

---

## 6. 联调检查清单（网关侧）

- [ ] `GET /api/gateway/balance` 能返回该用户 `balance`  
- [ ] 算力不足时客户端能展示「请充值算力」且带上剩余余额  
- [ ] `baseUrl` 指向 `http://192.168.120.213:5000/api/gateway`（注意是 **213**，不是数据库 245）  
- [ ] 仅配置平台 provider + 白名单模型  
- [ ] 用错误 apiKey 调用应 401  
- [ ] 用正确 apiKey + `qwen3_6_plus` 发一句，能返回 assistant 内容（若 502 且厂商欠费，属平台上游账号问题，接口链路仍算通）  
- [ ] 客户端设置页无「自定义 API Key / 任意模型」入口  
- [ ] 配置文件与进程环境中看不到第二套厂商 Key  

---

## 7. 联系平台侧时请提供

若联调失败，请带上（**不要**带完整 apiKey）：

- 请求 URL、HTTP 状态码、`error.code` / `error.message`  
- 使用的 `model`  
- apiKey **前缀**（例如 `sk-jyc-CvWf...` 前 12 位）  
- 时间点（便于查平台日志）
