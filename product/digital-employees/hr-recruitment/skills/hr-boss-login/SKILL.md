---
name: hr-boss-login
description: Boss 登录门禁：桌面客户端读取本机已登录账号；产品只检验登录态。
user-invocable: true
---

# Boss 登录门禁（桌面客户端）

## 前置

- **量产**：雇主安装带内嵌 Chromium 的桌面客户端；Boss 在本机完成。
- **禁止**要求终端用户安装 Chrome 扩展或手敲 OpenClaw CLI。
- **默认不代填**手机号 / 短信 / 验证码（`BOSS_LOGIN_MODE=self`）。
- `BOSS_BROWSER_MODE=user_node`（本机浏览器；桌面端内嵌即该运行时）。
- **IP 隔离**：出口是雇主电脑；封禁不影响我们的服务器 IP。

## 步骤（量产）

1. 打开桌面客户端并登录平台账号。
2. 「打开 Boss 窗口」——若本机已登录 Boss，可直接检验通过。
3. 「检验登录态」通过后，才允许筛投递 / 搜人 / 请求简历 / 下载简历 / 复聊 / 约面。
4. 访问受限 / IP 封禁：停止并说明（封的是雇主本机出口）。

## 开发过渡

可用 Web 控制台 + `openclaw node` 模拟桌面内嵌浏览器；不对雇主暴露命令行。
