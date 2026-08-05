/**
 * HR recruitment funnel — aligned to HR flowchart thresholds.
 *
 * Flow:
 *  JD/画像筛选
 *   ├─ match < 50%  → 不合适
 *   └─ match ≥ 80%  → 打招呼 + 岗位基础提问
 *        ├─ 24h 未回复 → 趣味性复聊
 *        ├─ 回答正确率 < 50% → 不合适
 *        └─ 回答正确率 ≥ 80% → 请求并下载附件简历
 *             → 作品集/成绩复核（可选）→ 约面试（需雇主确认）
 *             → 面试通过入职 | 通过未入职 → 人才库
 *
 * Scores are 0–100 integers (percent-compatible).
 */

export const FUNNEL = Object.freeze({
  REJECT_BELOW: 50,
  ADVANCE_AT: 80,
  FOLLOWUP_HOURS: 24,
});

/** Candidate funnel stages (stored in meta.funnelStage). */
export const FUNNEL_STAGE = Object.freeze({
  JD_SCREENED: "jd_screened",
  GREET_SENT: "greet_sent",
  ANSWER_SCORED: "answer_scored",
  RESUME_REQUESTED: "resume_requested",
  RESUME_READY: "resume_ready",
  PORTFOLIO_REVIEW: "portfolio_review",
  INVITE_READY: "invite_ready",
  INVITE_SENT: "invite_sent",
  REJECTED: "rejected",
  FOLLOWUP_SENT: "followup_sent",
  TALENT_POOL: "talent_pool",
  HIRED: "hired",
});

export const VERDICT = Object.freeze({
  REJECT: "reject",
  MAYBE: "maybe",
  GREET: "greet", // ≥80% JD match — 打招呼+提问
  RESUME: "resume", // ≥80% answers — 可请求/下载简历
  INVITE: "invite", // 可约面
  TALENT: "talent_pool",
  HIRED: "hired",
});

/**
 * JD / 画像初筛 verdict from match score (0–100).
 * <50 reject；50–79 maybe；≥80 greet（打招呼提问，不是直接约面）.
 */
export function verdictFromMatchScore(score) {
  const s = Number(score) || 0;
  if (s < FUNNEL.REJECT_BELOW) return VERDICT.REJECT;
  if (s >= FUNNEL.ADVANCE_AT) return VERDICT.GREET;
  return VERDICT.MAYBE;
}

/**
 * 二次筛选：聊天回答正确率 → reject / resume / maybe.
 * 含图片/视频/网站时：即使分高也先标待观察，强制人事目视确认。
 */
export function verdictFromAnswerScore(score, { needsHrReview = false } = {}) {
  const s = Number(score) || 0;
  if (s < FUNNEL.REJECT_BELOW) return VERDICT.REJECT;
  if (needsHrReview) return VERDICT.MAYBE;
  if (s >= FUNNEL.ADVANCE_AT) return VERDICT.RESUME;
  return VERDICT.MAYBE;
}

export function reasonForMatchVerdict(verdict, score, extra = "") {
  const suffix = extra ? `；${extra}` : "";
  if (verdict === VERDICT.REJECT) {
    return `JD匹配度 ${score}% < ${FUNNEL.REJECT_BELOW}%，标记不合适${suffix}`;
  }
  if (verdict === VERDICT.GREET) {
    return `JD匹配度 ${score}% ≥ ${FUNNEL.ADVANCE_AT}%，建议打招呼并做岗位基础提问${suffix}`;
  }
  return `JD匹配度 ${score}% 介于 ${FUNNEL.REJECT_BELOW}–${FUNNEL.ADVANCE_AT - 1}%，暂存待观察${suffix}`;
}

export function reasonForAnswerVerdict(verdict, score, { needsHrReview, summary } = {}) {
  if (needsHrReview) {
    return `回复含${summary || "图片/视频/网站"}：机器分 ${score}%（仅供参考），请人事打开材料目视确认后再推进`;
  }
  if (verdict === VERDICT.REJECT) {
    return `回答正确率 ${score}% < ${FUNNEL.REJECT_BELOW}%，标记不合适`;
  }
  if (verdict === VERDICT.RESUME) {
    return `回答正确率 ${score}% ≥ ${FUNNEL.ADVANCE_AT}%，可请求并下载附件简历`;
  }
  return `回答正确率 ${score}% 未达 ${FUNNEL.ADVANCE_AT}%，继续观察或补问`;
}

/** Default basic screening questions for a job title. */
export function defaultScreenQuestions(jobTitle, employerNotes) {
  const title = jobTitle || "该岗位";
  const custom = String(employerNotes || "")
    .split(/\n|；|;|。/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4 && /[？?]|是否|多久|期望|到岗|薪|加班|出差/.test(s))
    .slice(0, 3);
  if (custom.length) return custom;
  return [
    `您好，看到您对「${title}」感兴趣。请问目前是否在职？最早到岗时间大概是？`,
    `您做过与「${title}」最相关的一段经历是什么？主要成果能否用一句话说清？`,
    `期望薪资区间，以及对加班/出差的接受度如何？`,
  ];
}

/** Fun / light follow-up when ≥80% match greeted but no reply in 24h. */
export function funFollowupMessage(jobTitle) {
  const title = jobTitle || "目标岗位";
  return [
    `嗨～昨天给您发了「${title}」的简单沟通，怕消息被刷掉了😊`,
    `方便的话回我一句就行：这周有空聊聊吗？不耽误您太久～`,
  ].join("\n");
}

/**
 * @param {object} job
 * @param {{ mode?: 'online'|'offline'|null, time?: string|null, place?: string|null }} [details]
 */
export function interviewInviteDraft(job, details = {}) {
  const title = job?.job_title || "目标岗位";
  const mode =
    details.mode === "offline" ? "线下" : details.mode === "online" ? "线上" : null;
  const time = details.time || null;
  const place =
    details.mode === "offline"
      ? details.place || null
      : details.place || (details.mode === "online" ? "会议链接将在确认后发送" : null);

  if (mode && time && (details.mode !== "offline" || place)) {
    const where =
      details.mode === "offline"
        ? `地点：${place}`
        : `形式：线上面试（${place || "确认后发会议链接"}）`;
    return [
      `您好，我是招聘方HR。结合沟通，觉得您很适合「${title}」。`,
      `想邀请您参加${mode}面试：时间 ${time}；${where}。`,
      `请回复是否方便；若需改期直接告诉我即可。`,
    ].join("\n");
  }

  return [
    `您好，我是招聘方HR。结合您的简历与沟通回复，觉得您很适合「${title}」。`,
    `想跟您约一次面试（形式/时间待人事最终确认）。确认后我发具体安排。`,
    `期待您的回复。`,
  ].join("\n");
}

/** True when chat excerpt looks like the candidate actually replied (not only我们的提问). */
export function detectCandidateReply(excerpt) {
  const text = String(excerpt || "");
  if (text.length < 6) return { replied: false, preview: "" };
  const modality = detectReplyModalities(text);
  // Strip our outbound tags for preview
  const preview = text
    .replace(/\[打招呼提问\][^\n]*/g, "")
    .replace(/\[趣味复聊\][^\n]*/g, "")
    .replace(/\[追问\][^\n]*/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  const hasSubstance =
    modality.needsHrReview ||
    /到岗|面试|可以|接受|作品|薪资|期望|方便|http|做过|成片|离职/.test(text);
  const onlyOutbound =
    /\[打招呼提问\]|\[趣味复聊\]|\[追问\]/.test(text) &&
    !hasSubstance &&
    preview.length < 8;
  return {
    replied: Boolean(hasSubstance && !onlyOutbound),
    preview: preview || text.slice(0, 80),
    ...modality,
  };
}

/** Tokenize job/title for relevance (Chinese-friendly light split). */
export function tokenizeRole(text) {
  const raw = String(text || "")
    .toLowerCase()
    .replace(/[·•|/／\\,_，。]/g, " ")
    .replace(/\d+\s*年/g, " ")
    .trim();
  const parts = raw.split(/\s+/).filter(Boolean);
  const tokens = new Set();
  for (const p of parts) {
    if (p.length >= 2) tokens.add(p);
    // bigrams for dense Chinese without spaces
    if (/^[\u4e00-\u9fff]+$/.test(p) && p.length >= 2) {
      for (let i = 0; i < p.length - 1; i++) tokens.add(p.slice(i, i + 2));
    }
  }
  return [...tokens];
}

/**
 * Title relevance 0–1. Unrelated roles (行政文员 vs ai剪辑师) → near 0.
 * Exact / core-role containment (智能体开发工程师 vs 智能体开发工程师（AISaaS）) → 1.
 */
export function titleRelevance(jobTitle, candidateTitle) {
  const job = String(jobTitle || "").trim();
  const cand = String(candidateTitle || "").trim();
  if (!job) return 0.5;
  if (!cand) return 0.25;
  const jt = job.toLowerCase();
  const ct = cand.toLowerCase();
  const stripParen = (s) =>
    s
      .replace(/[（(][^）)]*[）)]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const jCore = stripParen(jt);
  const cCore = stripParen(ct);
  if (ct.includes(jt) || jt.includes(cCore) || cCore.includes(jCore) || jCore.includes(cCore)) {
    return 1;
  }
  // Shared distinctive head noun (智能体 / Agent) + eng/dev family → strong match.
  if (/智能体|agent/.test(jCore) && /智能体|agent/.test(cCore)) return 0.95;
  if (
    /开发工程师|软件工程师|全栈/.test(jCore) &&
    /开发工程师|软件工程师|全栈/.test(cCore) &&
    !/剪辑|创作|内容|运营|销售|行政|文员/.test(cCore)
  ) {
    return 0.72;
  }

  const jobToks = tokenizeRole(job);
  const candToks = tokenizeRole(cand);
  if (!jobToks.length) return 0.5;
  let hit = 0;
  for (const t of jobToks) {
    if (candToks.includes(t) || ct.includes(t)) hit += 1;
  }
  const ratio = hit / jobToks.length;

  // Hard negatives: common unrelated admin/ops titles when job is creative/tech.
  const adminOnly = /行政|文员|前台|后勤|仓管|保安|司机|保洁/.test(ct);
  const creativeOrTech = /剪辑|视频|设计|前端|后端|算法|java|python|ai|运营|产品|销售|工程师|开发|智能体/.test(
    jt,
  );
  if (adminOnly && creativeOrTech && ratio < 0.35) return 0.05;
  // Soft negatives: content/edit roles vs eng roles.
  if (/工程师|开发|算法|后端|前端|智能体/.test(jCore) && /剪辑|创作师|内容创作|文案/.test(cCore) && ratio < 0.5) {
    return Math.min(ratio, 0.15);
  }

  return Math.max(0, Math.min(1, ratio));
}

/**
 * Detect reply modalities from chat excerpt / notes.
 * @returns {{ modalities: string[], needsHrReview: boolean, summary: string }}
 */
export function detectReplyModalities(excerpt) {
  const text = String(excerpt || "");
  const modalities = new Set();
  if (/https?:\/\/|www\.|\.com\b|\.cn\b|夸克|网盘|蓝奏|github|bilibili|抖音|小红书|作品集链接/i.test(text)) {
    modalities.add("website");
  }
  if (/\[图片\]|\[image\]|\.png|\.jpe?g|\.gif|\.webp|发了张图|截图|作品图/i.test(text)) {
    modalities.add("image");
  }
  if (/\[视频\]|\[video\]|\.mp4|\.mov|视频作品|演示视频|录屏/i.test(text)) {
    modalities.add("video");
  }
  // Plain text if there is substantive Chinese/English beyond tags
  const plain = text
    .replace(/\[打招呼提问\][\s\S]*$/m, "")
    .replace(/\[趣味复聊\][\s\S]*$/m, "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\[[^\]]{0,20}\]/g, "")
    .trim();
  if (plain.length >= 4) modalities.add("text");
  if (!modalities.size && text.trim()) modalities.add("text");

  const list = [...modalities];
  const needsHrReview = list.some((m) => m === "image" || m === "video" || m === "website");
  const label = {
    text: "文字",
    image: "图片",
    video: "视频",
    website: "网站/链接",
  };
  const summary = list.map((m) => label[m] || m).join("+") || "文字";
  return { modalities: list, needsHrReview, summary };
}

/**
 * Heuristic answer score from a free-text reply excerpt (0–100).
 * Media-only replies get a mid score + needsHrReview (人事必须目视确认).
 */
export function scoreAnswerExcerpt(excerpt, jobTitle, notes) {
  const text = String(excerpt || "").trim();
  if (!text || text.length < 4) return { score: 0, ...detectReplyModalities(text) };

  const modality = detectReplyModalities(text);
  let score = 40;

  if (modality.modalities.includes("text")) {
    score = 52;
    if (text.length >= 20) score += 10;
    if (text.length >= 40) score += 8;
    const positives = (
      text.match(/到岗|入职|可以|方便|接受|有经验|做过|负责|线上面试|本周|期望薪资|同类项目|熟悉|作品集|剪辑|成片/g) || []
    ).length;
    score += Math.min(28, positives * 7);
    if (/不方便|不考虑|拒|太远|不接受|已入职别家|没有作品/.test(text)) score -= 30;
    const jt = String(jobTitle || "").toLowerCase();
    if (jt && text.toLowerCase().includes(jt)) score += 10;
    for (const kw of String(notes || "")
      .split(/[\s,，、;；]+/)
      .filter((x) => x.length >= 2)
      .slice(0, 6)) {
      if (text.toLowerCase().includes(kw.toLowerCase())) score += 4;
    }
  }

  // Media present: machine cannot fully judge — cap auto score, force HR review.
  if (modality.needsHrReview) {
    if (!modality.modalities.includes("text") || text.length < 20) {
      score = Math.max(score, 72); // enough to surface, not auto-pass invite alone
    }
    score = Math.min(score, 79); // never auto ≥80 on media-only judgment
  }

  if (/\[打招呼提问\]|\[趣味复聊\]|\[待发送/.test(text) && !/到岗|面试|可以|接受|作品|http/i.test(text)) {
    score = Math.min(score, 35);
  }

  return {
    score: Math.max(0, Math.min(99, score)),
    ...modality,
  };
}

/**
 * @deprecated use scoreAnswerExcerpt(...).score — kept for callers expecting number.
 */
export function scoreAnswerExcerptScore(excerpt, jobTitle, notes) {
  const r = scoreAnswerExcerpt(excerpt, jobTitle, notes);
  return typeof r === "number" ? r : r.score;
}

export function parseMeta(value) {
  if (value == null) return {};
  if (typeof value === "object") return { ...value };
  try {
    return JSON.parse(value) || {};
  } catch {
    return {};
  }
}

export function buildCandidateMeta(base, patch) {
  return { ...parseMeta(base), ...patch, funnelVersion: 1 };
}

/** Label for UI / chat lines. */
export function funnelTag(verdict, funnelStage) {
  const map = {
    [VERDICT.REJECT]: "不合适",
    [VERDICT.MAYBE]: "待观察",
    [VERDICT.GREET]: "≥80%·待打招呼提问",
    [VERDICT.RESUME]: "≥80%答对·可下简历",
    [VERDICT.INVITE]: "建议约面",
    [VERDICT.TALENT]: "人才库",
    [VERDICT.HIRED]: "已入职",
  };
  if (funnelStage === FUNNEL_STAGE.FOLLOWUP_SENT) return "已趣味复聊";
  if (funnelStage === FUNNEL_STAGE.GREET_SENT) return "已打招呼·等回复";
  if (funnelStage === FUNNEL_STAGE.PORTFOLIO_REVIEW) return "⚠多媒体·待人事目视";
  if (funnelStage === FUNNEL_STAGE.RESUME_READY) return "简历已备·可约面";
  return map[verdict] || verdict || "待定";
}

/**
 * Candidates due for 24h fun follow-up:
 * greeted, no reply recorded, not rejected, greetedAt older than FOLLOWUP_HOURS.
 */
export function pickFollowupDue(candidates, now = Date.now()) {
  const ms = FUNNEL.FOLLOWUP_HOURS * 3600_000;
  return (candidates || []).filter((c) => {
    if (c.verdict === VERDICT.REJECT) return false;
    const meta = parseMeta(c.meta);
    if (meta.funnelStage === FUNNEL_STAGE.FOLLOWUP_SENT) return false;
    if (meta.funnelStage !== FUNNEL_STAGE.GREET_SENT && c.ask_status !== "sent") return false;
    if (meta.repliedAt || c.last_reply_at) return false;
    const greetedAt = meta.greetedAt ? Date.parse(meta.greetedAt) : null;
    if (!greetedAt || Number.isNaN(greetedAt)) return false;
    return now - greetedAt >= ms;
  });
}

export function summarizeFunnelBuckets(candidates) {
  const list = candidates || [];
  const bucket = {
    reject: list.filter((c) => c.verdict === VERDICT.REJECT).length,
    maybe: list.filter((c) => c.verdict === VERDICT.MAYBE).length,
    greet: list.filter((c) => c.verdict === VERDICT.GREET || c.verdict === "invite").length,
    resume: list.filter((c) => c.verdict === VERDICT.RESUME).length,
    invite: list.filter((c) => c.verdict === VERDICT.INVITE).length,
    total: list.length,
  };
  // Legacy "invite" from old scoring maps to greet at JD stage.
  return bucket;
}
