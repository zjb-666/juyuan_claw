# 数字员工分配架构（平台下单 → OpenClaw 客户端）

日期：2026-07-25（SaaS 拆分补充：2026-08-03）  
状态：实施中（P0 客户端/BFF 已落地；平台对接见 `platform-api-contract.md`）  
前提：登录已对齐平台（见 `login-platform-alignment.md`）  
SaaS 云端脑控 + 本地手脚（平台 / 执行端分工）：见 `saas-platform-digital-employee.md`、`saas-openclaw-executor.md`

## 已拍板决策

| 项 | 决定 |
|---|---|
| Boss 直聘 | **全自动** |
| 实例 | **每用户 × 每 SKU 独立 agent**（独立 workspace + 会话记忆，可调教） |
| 平台开发 | 不在本机；OpenClaw 侧提供接口文档由平台对接 |

## 老板目标（一句话）

平台用户**下单购买某类 AI 员工**后，下载/打开 OpenClaw 附属客户端；网关按 entitlement **分配对应数字员工人格与技能包**。通用能力人人有；主攻能力按 SKU 不同。

招聘员工只是第一例：

- 按 JD/需求在 Boss 直聘等渠道筛人  
- 汇总投递者能力并排名  
- 提示今日可约面试人选  
- 用户选定时间后一键发起面试邀约  

后续还会有财务、客服、运营等其它数字员工，同一套「SKU → 员工模板 → 网关分配」模型。

---

## 现状差距

| 层 | 现状 | 缺口 |
|---|---|---|
| 平台 `ai-project` | 卖的是会员包 + 算力（`recharge_packages` / `user_package_entitlements`）；`agent_benefits` 只是文案 | 没有「数字员工 SKU」、没有购买后能力 entitlement |
| OpenClaw 核心 | 已有多 agent（`agents.entries`）、按 agent 的 skills 白名单、workspace/SOUL 人格 | 没有「用户购买 → 绑定 agentId」的产品编排 |
| 产品 BFF | 登录 + 共用 `main` agent；`user_skills` 只是提示词开关 | 会话未路由到员工 agent；无 SKU 目录 |

结论：**客户端安装包不是重点**；重点是 **entitlement → agent 模板 → 会话路由 → 域技能插件**。

---

## 推荐模型（最小可扩展）

```
平台下单「人事招聘AI员工」
    ↓ 支付成功
写入 entitlement（user_uuid + employee_sku=hr-recruitment）
    ↓ 客户端登录
BFF 拉 entitlements → 解析可用数字员工列表
    ↓ 用户进入某员工（或默认唯一员工）
会话绑定 agentId = hr-recruitment（或 per-user 实例）
    ↓ Gateway
agents.entries.hr-recruitment
  - SOUL/工作区：招聘顾问人格
  - skills[]：通用基线 ∪ 招聘域技能包
  - tools：browser / message / calendar 等按需
```

### 三层对象

1. **Employee SKU（商品）**  
   例：`hr-recruitment`、`finance-assistant`。平台目录与支付用。

2. **Employee Template（网关模板）**  
   OpenClaw `agents.entries.<templateId>`：人格、技能白名单、模型、工具策略。  
   运维预置；**不要**每个用户复制一整份核心配置（先共享模板 + 用户会话隔离）。

3. **User Entitlement（权益）**  
   `user_uuid + sku + status + valid_until + source_order_id`。  
   客户端只展示/进入已购员工；未购不可路由到该 agent。

### 会话键（关键）

每用户独立实例：

```text
agent:de-{uuid8}-{sku}:main
例：agent:de-a1b2c3d4-hr-recruitment:main
```

### 已落地（本仓库）

- 目录 `product/digital-employees/hr-recruitment`（SOUL/技能包）
- BFF：权益镜像表、平台 upsert webhook、客户端 `/api/employees*`、聊天按当前员工路由
- 文档：`product/docs/platform-api-contract.md`（给平台后端）
- 开发授权：`DIGITAL_EMPLOYEE_DEV_GRANT=hr-recruitment`

## 招聘数字员工（第一例）能力切分

招聘助手主界面：**登录门禁后完全靠对话识别**（不再强迫第二步点选模式）：

主路径（优先）：

```text
一句话招聘（例：招 3 个 AI 开发，长沙，熟练 LangChain）
  → 编排复述意图 + 确认门禁
  → 用户确认后本机 Boss 技能执行（拉沟通 / 初筛…）
  → 回传结果；后续追问 / 约面仍走对话
```

| 步骤/模式 | 含义 |
|---|---|
| **先登录 Boss（桌面端）** | 本机内嵌浏览器；读取已登录账号，只检验登录态 |
| **一句话招聘 → 确认** | 解析岗位/人数/城市/要求；确认前不自动点 Boss |
| **漏斗第1步·JD初筛** | 确认后拉沟通/投递 → 匹配 `<50%` 不合适，`≥80%` 进打招呼 |
| **漏斗第2步·打招呼提问** | 对合适人发岗位基础问题（本机代聊） |
| **漏斗分支·24h复聊** | 合适但 24h 未回复 → 趣味性复聊 |
| **漏斗第3步·二次筛选** | 按回答正确率再筛：`<50%` 淘汰，`≥80%` 请求并下载简历 |
| **约面试** | 草稿 + **人工确认** 后本机代聊发送 |
| **入职/人才库** | 通过入职；通过未入职 → 人才库 |

（第二张需求图的「对话识别→筛今日投递→提问→综合评优（需下简历）→告知可约→一键约面」已并入上表。）

### 登录策略（已拍板方向）

- 全自动 ≠ 跳过登录；**无登录态禁止搜人/筛投递**。
- **量产交付形态：带内嵌 Boss 浏览器的桌面客户端**（类型 **B**：只操控 Boss 网页，**不**操控整台电脑）。
  - 现有 `product/desktop` Electron（如 `聚元灵创-*-Windows.exe`）加载产品 UI，并另开本机 Boss 窗口（独立 `persist:boss-zhipin` 会话）。
  - Boss **登录与操作在用户电脑**（独立 Cookie / 出口 IP）；用户只需安装桌面客户端。
  - 云端 BFF **只编排**：对话意图、评优、邀约确认门禁；登录验态优先走桌面端 IPC。
  - **禁止**多用户共用一台服务器浏览器当量产方案；也**不做**全局键鼠远控（类型 C）。
- 用户侧步骤（量产）：
  1. 打开「聚元灵创」桌面客户端
  2. 登录平台账号 → 「打开 Boss 窗口」自行登录
  3. 「检验登录态」通过后，对话驱动筛投递 / 搜人 / 约面
- 内测过渡：纯网页仍可走 Node / DEMO；不对终端用户暴露 CLI。
- 配置：
  - `BOSS_BROWSER_MODE=user_node`（桌面端/本机浏览器运行时）
  - `BOSS_LOGIN_MODE=self`（不代填短信；只验态）
  - `BOSS_BROWSER_MODE=server` 仅服务器内测（易 IP 风控）
- **邀约硬门禁**：批量代聊/约面必须雇主确认后才发送。
- 旧版代填短信流程仅在 `BOSS_LOGIN_MODE=assisted` 保留。

### A. 通用基线（所有员工共享）

聊天、记忆摘要、文件、基础浏览器、通知等（现有 Gateway skills，经产品目录过滤）。

### B. 招聘域技能包（SKU 专属）

| 能力 | 技能 | 说明 |
|---|---|---|
| 登录门禁 | `hr-boss-login` + 桌面内嵌浏览器 | 自助登录 + 检验登录态 |
| 主动搜人 | `hr-boss-search` + `browser` | 按岗位去搜 |
| 筛选投递 / 漏斗初筛 | `hr-boss-inbox` | 今日投递 + JD 50/80 阈值 |
| 打招呼提问 / 二次筛 | `hr-candidate-rank` + 本机复聊 | 答对率再筛 |
| 24h 趣味复聊 | `hr-auto-rechat` | 未回复跟进 |
| 请求/下载简历 | `hr-resume-request` / `hr-resume-download` | 答对≥80% 后 |
| 今日可约 / 一键约面 | `hr-interview-invite` | 确认后门禁发送 |
| 人才库 | 漏斗尾声 | 通过未入职入库 |

**不要**把 Boss 自动化写死进核心；做成 **plugin skill pack**，随 `hr-recruitment` 模板的 `skills[]` 启用。

---

## 平台侧需要补的（ai-project）

现有会员包可**复用支付/订单骨架**，但语义要新增一类商品，例如：

- `recharge_packages` 扩展 `package_kind=digital_employee` + `employee_sku=hr-recruitment`  
  或独立表 `digital_employee_skus` + `user_digital_employee_entitlements`

支付成功回调除算力外，**写入员工 entitlement**。  
对 OpenClaw BFF 暴露只读接口，例如：

```http
GET /api/openclaw/entitlements
→ [{ sku, name, agentId, status, valid_until }]
```

（具体路径可与平台约定；BFF 用已登录的 platform token 调用。）

---

## OpenClaw / 产品侧需要补的

1. **预置模板** `agents.entries.hr-recruitment`（人格 + skills 白名单）  
2. **招聘 skill pack**（plugin 或 `skills.load.extraDirs`）  
3. **BFF**：登录后拉 entitlements；聊天 `sessionKey`/`agentId` 按当前员工路由  
4. **客户端**：员工切换器（多员工时）；安装包可仍通用，**能力由账号权益决定**（瘦客户端模型不变）  
5. **健康检查/医生**：无 entitlement 时明确提示「请先在平台购买数字员工」

---

## 分步落地（建议）

| 阶段 | 内容 | 价值 |
|---|---|---|
| **P0** | 平台 entitlement API + BFF 绑定 + 会话路由到固定模板 `hr-recruitment`（技能可先用提示词+通用 browser） | 打通「买了才能用对应员工」 |
| **P1** | 招聘 skill pack：简历结构化、排名、面试名单 | 主攻能力可感知 |
| **P2** | **Windows 桌面客户端（内嵌 Chromium）** + Boss 实网筛投递/代聊 | 量产可用，无 CLI |
| **P3** | 第二、第三个数字员工复用同一套 SKU→模板机制 | 证明可扩展 |

量产安装包：P2 交付桌面端；Web 控制台可保留给运维/演示。
OpenClaw Node CLI 仅作桌面端落地前的开发过渡，不对雇主暴露。

---

## 风险与决策点（需老板拍板）

1. ~~Boss 直聘自动化模式~~ → **已定：全自动**  
2. ~~多租户隔离~~ → **已定：每用户独立实例**  
3. **邀约通道**：短信/邮件/企微/平台站内，谁提供？  
4. **SKU 与会员包关系**：数字员工是否叠加在现有会员之上，还是独立商品？

---

## 和现有附属客户端路线的关系

```
已完成：平台登录一致
下一步：权益驱动的数字员工分配（本文）
再下一步：招聘域技能与业务流程
安装包分发：并行、可后置
```

## 现成可复用（避免重复造轮子）

- OpenClaw 多 agent + per-agent skills（核心已有）  
- 产品层平台登录与卫星库（已有）  
- 平台订单/支付/entitlement 骨架（会员包可演化）  
- Browser skill / 消息通道（域自动化载体）  

**需要新建的**主要是：数字员工商品与权益、BFF 路由、招聘（及后续）skill pack——而不是再写一套网关。

---

## 十八、多智能体路由优化（招聘助手强化）

日期：2026-07-30  
状态：**代码已落地**（本仓库 product 层）

### 核心原则

| 原则 | 实现 |
|---|---|
| 客户端 IP ≠ 服务器 IP | Boss 只在桌面 Electron `persist:boss-zhipin` 窗口操作；`BOSS_BROWSER_MODE=user_node`；生产禁止共用服务器浏览器（`security-isolation.js`） |
| 读取本机已登录 Boss | 用户在本机窗口自助登录；产品检验登录态，不代填短信 |
| 自动请求/下载简历、自动复聊 | BFF 下发 `clientActions` → 桌面 IPC `boss:request-resumes` / `download-resumes` / `auto-rechat` |
| 用户数据隔离 | `de-{uuid8}-{sku}` 独立 workspace + memory；HR 表按 `user_id`；技能开关 per-user |
| 网关安全 | BFF 不暴露 raw Gateway；鉴权后限流；安全头；Webhook HMAC |

### 话术 → 能力

- 「招 5 个 Java」/「跑招聘漏斗」→ JD初筛（50/80）
- 「打招呼提问」→ 本机发基础问题
- 「根据回复二次筛选」→ 答对率再筛；≥80% 自动请求+下载简历
- 「趣味复聊」/「24小时未回复」→ 趣味性复聊
- 「约面试」→ 草稿；「确认发送」才发
- 「存入人才库」→ 通过未入职入库

### 数据流

```
雇主桌面客户端（本机 IP + Boss Cookie）
    ↕ IPC 自动化（仅 zhipin.com）
产品 UI / BFF（编排、评优、权益、限流）
    ↕ 内网
OpenClaw Gateway（per-user agent，无 Boss 会话）
```

### 实操就绪度（Boss 直聘）

| 能力 | 状态 | 说明 |
|---|---|---|
| 本机打开/检验 Boss 登录 | ✅ | Electron `persist:boss-zhipin`，本机 IP |
| 打招呼/追问/复聊代发 | ✅ | `clientActions.auto_rechat` → DOM 输入+发送 |
| 请求/下载简历 | ✅ | 本机点选「求简历/下载简历」（依赖页面文案） |
| 确认邀约后代发 | ✅ | 「确认发送」→ 同通道 `auto_rechat` 发邀约文案 |
| 本机检查会话回复 | ✅ | `check_inbox_replies` 打开沟通会话读摘要 |
| 今日投递真实拉人 | ⚠️ | 现多用演示种子；量产需关 `DEMO_HR_PIPELINE` + 补投递列表抓取 |
| DOM 选择器长期稳定 | ⚠️ | 现按可见文案点选；Boss 改版需跟进回归 |

**量产条件**：桌面客户端（非纯浏览器 UI）+ 本机已登录 Boss + `DEMO_HR_PIPELINE` 关闭。演示文字漏斗不等于已在 Boss 实发。

实网验收步骤见：`product/docs/boss-realnet-acceptance.md`  
实网启动 BFF：`product/scripts/start-bff-realnet.sh`  
桌面包产物：
- Windows：`product/desktop/dist/聚元灵创-0.1.7-Windows.zip`（解压后运行 `聚元灵创.exe`）
- Linux：`product/desktop/dist/聚元灵创-0.1.7.AppImage`

### 用户告知（同意书）

桌面端首次执行自动化前弹出 `desktopApp.consent`：说明会读取并模拟操作本机 Boss 窗口；登录态不上传服务器。
