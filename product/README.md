# OpenClaw Product Layer（二次开发产品层）

```
独立登录页 (client)
    ↓ JWT
产品后端 BFF + MySQL (.env 配置)
    ↓ 仅本机/内网
OpenClaw Gateway
```

## Windows 正式包

Windows 安装包是桌面客户端：

- **产品 UI**：打开 `public-config.json` 的 `serverUrl`（瘦 UI，不含密钥）
- **Boss 浏览器（类型 B）**：本机另开窗口，独立会话/出口 IP；只自动化 Boss 网页，不操控整台电脑
- 密钥只存在服务器 BFF

```bash
cd product/desktop
npm install
npm run dist:win   # 产出 聚元灵创-<version>-Windows.exe
```

因此：别人反编译 exe 也拿不到数据库和 Gateway 密钥。

- **独立登录页**：未登录只显示登录，不进主壳；账号密码与**平台 `users` 表**一致（只读校验，不改平台库）
- **MySQL 持久化**：本地库仅存设置/通知等卫星数据；平台库只用于登录认证
- **设置接口**：个人资料 / 外观 / 通知（读写本地库）
- **技能接口**：列表 + 开关写 **Gateway**（`skills.status` / `skills.update`）；默认只展示已就绪或仅需环境变量的非调试技能
- **配置**：`product/.env`、`product/config/skills.json`、`product/config/digital-employees.json`
- **数字员工**：`product/docs/digital-employee-architecture.md`、平台对接 `product/docs/platform-api-contract.md`

## 启动

```bash
# MySQL（本机 Docker 示例）
docker start openclaw-product-mysql || docker run -d --name openclaw-product-mysql \
  -e MYSQL_ROOT_PASSWORD=openclaw_dev \
  -e MYSQL_DATABASE=openclaw_product \
  -e MYSQL_USER=openclaw \
  -e MYSQL_PASSWORD=openclaw_dev \
  -p 3310:3306 mysql:8.0

cp product/.env.example product/.env   # 按需改
cd product/backend && npm install && PRODUCT_ENV_PATH=../.env npm start
```

打开：http://127.0.0.1:8787/  
登录：与平台一致（旋转验证码 + 平台账号/密码）。需配置 `PLATFORM_API_BASE_URL`。  
未配置平台 API、也未配置 `PLATFORM_MYSQL_*` 时才回退本地演示账号 `demo` / `demo123`。

登录对齐说明见：`product/docs/login-platform-alignment.md`。

## API 摘要

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/login` | 登录，返回 access_token |
| GET | `/api/me` | 当前用户 + 设置 |
| GET/POST | `/api/user/profile` | 个人资料 |
| GET | `/api/user/settings` | 外观/通知偏好 |
| POST | `/api/user/settings/appearance` | 保存外观 |
| POST | `/api/user/settings/notifications` | 保存通知偏好 |
| GET | `/api/skills` | 从 Gateway 拉取并过滤后的技能列表 |
| POST | `/api/skills/:id/toggle` | 开关技能（可带 `apiKey`），写入 Gateway |
| GET | `/api/notifications` | 通知列表 |
| POST | `/api/chat` | 对话（需 Gateway） |
