# 数字员工 SaaS：执行端开发文档（ai_claw / product）

日期：2026-08-03  
状态：方案定稿（待本仓库排期实现）  
范围：`product/` + OpenClaw 运行时封装（桌面安装包）  
配套文档：`saas-platform-digital-employee.md`（平台 ai-project）  
已有：`digital-employee-architecture.md`、`platform-api-contract.md`、`login-platform-alignment.md`

---

## 1. 执行端要解决什么

客户电脑上只装**一个统一 OpenClaw 执行端**。能力由平台权益决定，不按员工 fork 多套客户端。

| 职责 | 说明 |
|---|---|
| 本机 Gateway | 跑 agent 循环、选技能、调工具 |
| 本地记忆 | workspace + SQLite，默认不上云 |
| 本地手脚 | 浏览器 / 文件 / 脚本（按技能白名单） |
| 模型出口 | **强制**走平台 chat/completions（扣 RH） |
| 技能加载 | 仅已购 +（P1）签名校验通过的包 |
| 设备身份 | 激活绑定、心跳、版本上报 |
| 品牌壳 | Electron / 安装包（现有「聚元灵创」路线可演化） |

**不做**：支付、算力账本、SKU 商品主数据、厂商 API Key 托管。这些全在平台。

---

## 2. 和飞书 aily 的关系

飞书 aily：**IM/网页对话 + 可调本机浏览器**。  
我们：**平台网页/壳内对话 + 本机 OpenClaw 执行端**。

同类产品形态。实现上优先复用 OpenClaw Gateway + 技能包，而不是自研「云端想完、客户端只跑脚本」的第二套引擎。

---

## 3. 目标架构（执行端视角）

```text
平台 ai-project
  ├─ 登录 / 权益 / 算力扣费 /（可选）技能仓
  └─ POST /api/openclaw/v1/chat/completions
           ▲
           │ 仅 HTTPS 出网调模型
客户本机执行端
  ├─ 产品壳（Electron）← 可嵌平台 Web 或本机 UI
  ├─ OpenClaw Gateway（本机）
  │    ├─ agents：de-{uuid8}-{sku}
  │    ├─ skills：基线 ∪ 已购 Employee Pack
  │    └─ memory：本地
  └─ 心跳 → 平台 devices API
```

原则：

1. **Agent 循环在本机**（记忆与 Cookie 才真正留客户侧）  
2. **计费在平台**（baseUrl 锁死平台网关）  
3. **员工 = 技能包权益**，不是多套安装包  

---

## 4. 与现有 product 代码的关系

| 已有 | 去留 |
|---|---|
| 平台登录对齐 | **保留** |
| entitlement → agent 实例 / session 路由 | **保留并强化** |
| `digital-employees/hr-recruitment` 技能与 SOUL | **收敛为可售 Employee Pack** |
| 桌面 Boss IPC（本机浏览器） | **保留为本地手脚实现** |
| BFF 内 DEMO/规则招聘流水线 | **后置**；主路径改为 Gateway + 技能，不把 BFF 规则引擎当核心架构 |
| BFF 直连本机 `127.0.0.1:18789` | Phase 1 可继续；量产需「壳内本机 Gateway」或设备隧道 |

HR 招聘是第一个 **sku=`hr-recruitment` 技能包** 样例，不是永久独立产品线。

---

## 5. 本仓库必做模块

### 5.1 模型出口锁死（P0）

- 删除/禁用客户填写第三方 API Key、自定义 provider  
- `models.providers.*.baseUrl`（或产品层等价配置）**写死**平台：

```text
{PLATFORM_API}/api/openclaw/v1/chat/completions
```

- 请求头带平台/设备 token；禁止回落官方 Key  
- 关闭 ClawHub 公共技能/模型市场入口（产品壳内）  

平台未就绪前：可用环境变量指向联调网关，但**不得**在正式安装包暴露自定义入口。

### 5.2 设备激活与心跳（P0）

```text
首次启动 → 登录平台账号或输入激活码
→ 上报 device_id / os / client_version
→ 安全存储 device_token（加密）
→ 定时心跳
→ 授权失效则拒绝模型调用并提示重新登录
```

与平台 `devices` API 对齐（见平台文档 §4.3）。

### 5.3 权益驱动的技能与会话（P0）

沿用并固化：

```text
entitlement(sku=hr-recruitment)
  → agentId = de-{uuid8}-hr-recruitment
  → sessionKey = agent:{agentId}:main
  → skills = 基线 ∪ 该 sku 技能包
```

无 active entitlement：禁止进入该员工会话，文案引导「请先在平台购买」。

BFF：

- 接收平台 `entitlements/upsert`（已有契约）  
- 登录后拉取/对账 entitlement  
- 幂等 `ensureEmployeeAgentInstance`  

### 5.4 Employee Pack 格式（P0 本地，P1 远程）

```text
hr-recruitment-pack/
  manifest.json     # sku, version, skills[], tools policy
  SOUL.md / AGENTS.md
  skills/**/SKILL.md
```

Phase 0：打进安装包或 `skills.load.extraDirs`。  
Phase 1：平台下发 zip + 签名 → 本机验公钥 → 热加载；未签名拒绝。

### 5.5 对话与「网页下指令」（P0）

推荐落地顺序：

| 阶段 | 形态 | 本仓库工作 |
|---|---|---|
| P0 | 执行端壳打开对话页，Gateway 本机 | 壳 + 本机 Gateway 启动/保活 |
| P0.5 | 平台网页检测设备在线，深链打开本机会话 | 自定义协议 / 本地端口白名单 |
| P1 | 纯网页经隧道/中继打到本机 Gateway | 设备侧接入隧道或 node 配对 |

不要默认做成「云端 Gateway + 本机只当剧本执行器」——与「记忆留客户侧」冲突。

### 5.6 Daemon / 开机自启（P1）

Gateway + 心跳后台常驻；壳可关，服务可仍在线（产品需确认 UX）。Windows/macOS 服务化可后置，先保证「打开客户端即在线」。

### 5.7 OTA（P2）

屏蔽官方 `openclaw update`；改查平台版本接口；升级包签名校验；支持强制更新。

### 5.8 品牌与打包

延续 `product/desktop` electron-builder 路线；正式包：无密钥、仅 `public-config`（平台 API 基址）。

---

## 6. 明确不做 / 后置（本仓库）

- **不为每个员工 fork 一套 OpenClaw**（统一执行端 + 技能包）  
- 不把招聘 BFF 规则引擎当核心架构（可作某 pack 辅助，后置）  
- 不做「云端想完、客户端纯脚本」为主路径  
- 不实现算力充值/扣费账本（只消费平台网关结果与错误码）  
- 不在服务器浏览器上跑 Boss 量产路径  

---

## 7. 与平台对接清单

### 7.1 本仓库调用平台

| # | 能力 | 方法 | 优先级 |
|---|---|---|---|
| 1 | 登录 | 现有 `/auth/*` | 已有 |
| 2 | 拉权益 | `GET /api/openclaw/entitlements` | P0 |
| 3 | LLM | `POST /api/openclaw/v1/chat/completions` | P0 |
| 4 | 设备激活/心跳 | 平台 devices API（待平台定路径） | P0 |
| 5 | 媒体生成 | 现有 MCP（若技能需要） | 已有能力 |
| 6 | 技能包下载 | 平台技能仓 URL + 签名 | P1 |
| 7 | OTA 检查 | 平台版本 API | P2 |

### 7.2 平台调用本仓库 BFF

| # | 能力 | 方法 | 优先级 |
|---|---|---|---|
| 1 | 权益写入 | `POST /api/platform/entitlements/upsert` | P0（契约已有） |
| 2 | 对账同步 | `POST /api/platform/entitlements/sync` | 可选 |
| 3 | 健康检查 | `GET /api/platform/health` | 已有 |

签名与字段：严格按 `platform-api-contract.md`。

### 7.3 配置（执行端 / BFF `.env`）

```bash
# 平台
PLATFORM_API_BASE_URL=https://juyuancloud.com/api
OPENCLAW_PLATFORM_WEBHOOK_SECRET=<与平台一致>

# 模型：只指向平台网关（无客户 Key）
OPENCLAW_MODEL_GATEWAY_URL=https://juyuancloud.com/api/openclaw/v1
# 或产品层写死等价配置

# 本机 Gateway
OPENCLAW_GATEWAY_URL=http://127.0.0.1:18789

# 开发授权（勿进生产包）
DIGITAL_EMPLOYEE_DEV_GRANT=hr-recruitment
```

### 7.4 联调顺序（两端一起）

```text
1. 平台先提供：entitlements 读写 + chat/completions 扣费（可先固定价/测试模型）
2. 执行端锁 baseUrl → 用测试账号打通一轮对话并看到算力减少
3. 购买 sku → upsert → 本机出现对应员工/技能
4. 跑一个本机技能（读文件或打开浏览器）证明手脚在本地
5. 再接设备心跳与网页在线态
```

---

## 8. 验收标准（执行端）

- [ ] 正式包无法配置第三方模型 Key  
- [ ] 对话消耗平台算力（同一用户余额减少）  
- [ ] 未购买 sku 无法进入对应员工  
- [ ] 购买后技能/人格可用；记忆文件在本机 state/workspace  
- [ ] 设备离线/未激活时有明确提示  
- [ ] HR 仅作为技能包样例，安装包名称与「统一执行端」一致  

---

## 9. 本仓库任务拆分建议

| 周次 | 内容 |
|---|---|
| W1 | 模型出口锁死 + 对接平台 chat 网关；关掉公共源入口 |
| W2 | 设备激活存储 + 心跳；权益拉取与会话路由回归 |
| W3 | Employee Pack 目录规范化；HR 包与基线分离 |
| W4 | 壳内对话闭环 + 与平台购买/扣费联调；技能签名可并行 |

---

## 10. 相关路径索引

| 主题 | 路径 |
|---|---|
| 数字员工架构（旧） | `product/docs/digital-employee-architecture.md` |
| 平台契约 | `product/docs/platform-api-contract.md` |
| 登录对齐 | `product/docs/login-platform-alignment.md` |
| HR 模板/技能 | `product/digital-employees/hr-recruitment/` |
| BFF | `product/backend/` |
| 桌面壳 | `product/desktop/` |
| 平台侧文档 | `product/docs/saas-platform-digital-employee.md` |

---

## 11. 给老板的一句话

我们卖的是平台上的**权益 + 算力通道 + 签名技能包**；客户装的是**同一个 OpenClaw 执行端**；网页负责下指令与计费，本机负责干活和记记忆。人事只是第一个技能包。

---

**文档结束。** 平台职责与接口见 `saas-platform-digital-employee.md`。
