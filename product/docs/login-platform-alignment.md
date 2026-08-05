# OpenClaw 附属客户端：登录对齐平台（第一步）

日期：2026-07-25  
范围：`product/` 产品层  
对照源码：`/data/ai-project`（只读参考，未改平台仓库）

## 目标

OpenClaw 最终作为平台附属客户端产品。第一步先让**登录方式与平台一致**：走平台正式认证 API，而不是旁路直连 MySQL 校验密码。

## 平台现网登录（对照结论）

平台 PC/Web 主登录在 `ai-project`：

1. `POST /auth/captcha/rotate/create`（scene=`login`）拿旋转验证码  
2. `POST /auth/captcha/rotate/verify`（传相对 `initial_angle` 的角度增量）  
3. `GET /auth/public-key` + RSA-OAEP 加密密码（可回退明文）  
4. `POST /auth/login`（`login_type=account_password`，字段 `account` + `encryptedPassword`/`password`）  
5. 成功返回 `{ state, message, data: { access_token, refresh_token, user } }`  
6. 密码落库为 **SHA-256 hex**；会话校验含封禁、`token_version` 等平台规则  

关键源码：

- `app/routes/auth.py`（`/auth/login`、验证码、公钥）  
- `app/password_utils.py`（SHA-256 / RSA 解密）  
- `frontend/passwordEncryptor.ts`（前端 RSA-OAEP）  

可达 API（本机探测）：

- LAN：`http://192.168.120.245:5000`  
- 公网：`https://juyuancloud.com/api`  

## 改造前（OpenClaw）

- 登录页：账号 + 密码，无验证码  
- BFF：`PLATFORM_MYSQL_*` 直连平台 `users` 表只读比对 SHA-256  
- 自己签发产品层 JWT  
- 与平台网站路径不一致，也无法复用平台封禁/会话/验证码策略  

## 改造后（第一步完成内容）

### 1. 正式登录路径改为平台 HTTP API

新增：`product/backend/src/platform-api-auth.js`

- `PLATFORM_API_BASE_URL` 配置后启用  
- 代理：`/auth/public-key`、`/auth/captcha/rotate/create|verify`、`/auth/login`  
- 使用平台兼容的 `X-Session-ID` / `captcha_session_id` 会话  

### 2. 产品 BFF 暴露同形接口

`product/backend/src/server.js` 新增/调整：

| 产品接口 | 行为 |
|---|---|
| `GET /api/auth/public-key` | 转发平台公钥 |
| `POST /api/auth/captcha/rotate/create` | 转发旋转验证码，并种 `oc_captcha_session_id` Cookie |
| `POST /api/auth/captcha/rotate/verify` | 转发角度校验 |
| `POST /api/auth/login` | **优先**走平台 `/auth/login`；成功后本地卫星用户 upsert，再发产品 `access_token` |

登录成功响应仍给前端产品会话，同时附带：

- `platform_access_token`  
- `platform_refresh_token`  

供后续附属能力调平台 API 使用（本步壳层仍主要用产品 token）。

`GET /api/health` 增加：

- `platformApi`  
- `authMode`: `platform_api` | `platform_mysql_readonly` | `local_demo`  

### 3. 登录页对齐平台交互

`product/client/public/`：

- 文案改为「使用平台账号登录」  
- 字段改为 `account`（账号或手机号）  
- 增加旋转验证码 UI（背景图 + 可旋转块 + 滑条）  
- 登录前先 `verify` 验证码  
- 优先 RSA 加密密码，失败时回退 `encryption=plain`  
- `fetch` 带 `credentials: "include"`，保证验证码 Cookie 生效  

### 4. 配置

`product/.env` / `.env.example` 增加：

```bash
PLATFORM_API_BASE_URL=http://192.168.120.245:5000
```

说明：

- **有** `PLATFORM_API_BASE_URL` → 正式附属登录（平台 API）  
- **无** API、**有** `PLATFORM_MYSQL_*` → 旧直连只读回退（过渡）  
- 都没有 → 本地 demo 账号  

本地卫星库 `openclaw_product` 仍只存设置/通知等；**不写平台库**。

## 验证码弹窗与双登录（同日补充）

- 登录页默认不展示旋转验证码；**点击登录**或 **获取验证码** 时再弹窗
- 支持平台两种登录：
  - 密码：`account_password`（captcha scene=`login`）
  - 短信：`phone_sms`（captcha scene=`login-sms` → `/auth/send-sms-code` → `/auth/login`）
- BFF 代理：`POST /api/auth/send-sms-code`
- 圆片按平台几何参数定位（`320×180` + `center_*` / `circle_diameter`）

## 未做（后续步骤）

- 直接用平台 JWT 鉴权产品接口（当前仍是产品会话 + 可选缓存平台 token）  
- OAuth（微信/QQ/飞书等）  
- Windows 瘦客户端安装包同步新登录页资源后重新打包  

## 个人资料对齐平台（同日补充）

附属客户端「设置 → 个人资料」与平台登录用户一致：

- 登录时把平台 `nickname` / `avatar` 写入本地卫星镜像（仍不写平台库）  
- `GET /api/me`、`GET /api/user/profile` 优先用缓存的平台 token 调 `GET /user/profile`，失败再回退平台 MySQL 只读 / 本地镜像  
- `POST /api/user/profile` 对平台用户转发 `POST /user/update`（改显示名称），本地只做镜像  
- 平台无「简介」字段：平台账号隐藏简介，只读展示账号/手机号  

## 验证建议

```bash
curl -sS http://127.0.0.1:8787/api/health
# 期望 authMode=platform_api

# 浏览器打开 http://192.168.120.12:8787/
# 1) 切换「密码登录 / 验证码登录」
# 2) 点登录或获取验证码时弹出旋转验证码
# 3) 用平台真实账号完成登录
```

## 涉及文件

- `product/backend/src/platform-api-auth.js`（新建）  
- `product/backend/src/server.js`  
- `product/backend/src/platform-auth.js`（保留作回退）  
- `product/client/public/index.html`  
- `product/client/public/app.js`  
- `product/client/public/styles.css`  
- `product/.env` / `product/.env.example`  
- 本文档：`product/docs/login-platform-alignment.md`  
