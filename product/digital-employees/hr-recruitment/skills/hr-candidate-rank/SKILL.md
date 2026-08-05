---
name: hr-candidate-rank
description: 按人事漏斗阈值做 JD 初筛与回答二次筛选（50%/80%），并输出约面前名单。
user-invocable: true
---

# 候选人筛选与排名（漏斗版）

## 两轮筛选

1. **JD / 画像初筛（匹配分 0–100）**  
   - `<50` → 不合适  
   - `50–79` → 待观察  
   - `≥80` → 打招呼 + 岗位基础提问（不是直接约面）

2. **聊天回答二次筛选（正确率 0–100）**  
   - `<50` → 不合适  
   - `≥80` → 请求并下载附件简历，再进入约面候选

## 输入

- JD / 硬性条件（USER.md 或当前对话）
- 候选人材料（Boss 摘录、已下载简历、聊天回复）

## 输出

| 字段 | 说明 |
|---|---|
| matchScore | JD 匹配 % |
| answerScore | 回答正确率 %（二次筛后） |
| funnelStage | jd_screened / greet_sent / answer_scored / resume_ready / invite_ready / rejected / … |
| verdict | reject / maybe / greet / resume / invite / talent_pool |
| ask | 建议基础提问 |

最后给出：待打招呼、可下简历、可约面、不合适 四个桶。
