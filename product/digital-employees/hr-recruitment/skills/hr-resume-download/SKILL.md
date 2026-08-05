---
name: hr-resume-download
description: 在本机 Boss 会话中自动下载已同意/附件简历到雇主本机下载目录。
user-invocable: true
---

# 自动下载简历

## 前置

1. 候选人已同意投递或已有附件简历；否则先走 `hr-resume-request`。
2. 仅在桌面客户端本机窗口执行；文件落在用户本机，不上传服务器。

## 步骤

1. 确认登录态。
2. 打开沟通会话。
3. 点选「下载简历 / 查看简历 / 附件简历」。
4. 记录下载结果到 memory；结构化摘录可再交 `hr-candidate-rank`。

## 话术触发

- 「自动下载简历」
- 「帮我下载简历」
