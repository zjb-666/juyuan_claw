/**
 * Hybrid HR intent: rules first, LLM assist for soft/oral utterances.
 * Uses Gateway /v1/chat/completions; fails soft when Gateway is down.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { HR_INTENTS, matchKnownNames, extractInterviewDetails } from "./hr-intent.js";

const GATEWAY_URL = (process.env.OPENCLAW_GATEWAY_URL || "http://127.0.0.1:18789").replace(
  /\/$/,
  "",
);

const VALID_INTENTS = new Set(Object.values(HR_INTENTS));

function loadGatewayToken() {
  if (process.env.OPENCLAW_GATEWAY_TOKEN) return process.env.OPENCLAW_GATEWAY_TOKEN.trim();
  const cfgPath =
    process.env.OPENCLAW_CONFIG_PATH ||
    join(process.env.HOME || process.env.USERPROFILE || "", ".openclaw/openclaw.json");
  if (!existsSync(cfgPath)) throw new Error("gateway_token_missing");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  const token = cfg?.gateway?.auth?.token;
  if (!token) throw new Error("gateway_token_missing");
  return String(token);
}

function extractJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence?.[1]) {
      try {
        return JSON.parse(fence[1].trim());
      } catch {
        /* continue */
      }
    }
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * When Gateway is down, still parse common multi-person ask patterns.
 * 「我想问张同学有没有作品，我想问李同学期望薪资」
 * 「问张同学有没有作品，问李同学期望薪资」
 */
export function softParsePerTargetQuestions(text, knownNames = []) {
  const raw = String(text || "").trim();
  if (!raw || !/问/.test(raw) || !knownNames.length) return [];
  const sorted = [...knownNames].filter(Boolean).sort((a, b) => b.length - a.length);
  const nameAlt = sorted.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  if (!nameAlt) return [];

  const out = [];
  const re = new RegExp(
    `(?:我想|再|另外|同时|以及)?问\\s*(${nameAlt})\\s*[：:，,]?\\s*([\\s\\S]+?)(?=(?:我想|再|另外|同时|以及)?问\\s*(?:${nameAlt})|$)`,
    "g",
  );
  for (const m of raw.matchAll(re)) {
    const name = String(m[1] || "").trim();
    let q = String(m[2] || "")
      .replace(/^问/, "")
      .replace(/^[和与、，,\s]+/, "")
      .replace(/[，,。；;！？\s]+$/u, "")
      .trim();
    if (!name || q.length < 2) continue;
    out.push({ name, question: q });
  }

  const map = new Map();
  for (const row of out) map.set(row.name, row);
  return [...map.values()];
}

/**
 * @param {string} message
 * @param {{
 *   knownNames?: string[],
 *   jobTitle?: string|null,
 *   stage?: string|null,
 *   hasPendingInvite?: boolean,
 *   hasInvitePlan?: boolean,
 *   ruleIntent?: string,
 *   ruleConfidence?: number,
 *   userId?: string|number,
 * }} ctx
 */
export async function classifyHrIntentWithLlm(message, ctx = {}) {
  const enabled = process.env.HR_INTENT_LLM !== "0";
  if (!enabled) return null;

  const known = Array.isArray(ctx.knownNames) ? ctx.knownNames : [];
  const intentList = [...VALID_INTENTS].join(", ");
  const system = [
    "你是人事招聘数字员工的意图分类器。",
    "只输出一个 JSON 对象，不要 Markdown，不要解释。",
    `intent 必须是以下之一：${intentList}`,
    "规则：",
    "- 用户在问候选人问题 / 追问某人 → ask_candidates",
    "- 问谁回复了、某人回信了吗 → check_replies",
    "- 只约某人面试、安排面试 → prepare_invite 或 fill_invite_details",
    "- 招 N 个岗位 / 今天筛投递 → run_funnel",
    "- 根据回复二次筛选 → screen_answers",
    "- 不同人问不同题时，填 perTargetQuestions",
    "字段：intent, targetNames(string[]), customQuestion(string|null),",
    "perTargetQuestions([{name,question}]|null),",
    "interview({mode:online|offline|null,time,place}|null),",
    "jobTitle(string|null), headcount(number|null), confidence(0-1)",
  ].join("\n");

  const user = [
    `当前岗位：${ctx.jobTitle || "无"}`,
    `漏斗阶段：${ctx.stage || "无"}`,
    `候选人名单：${known.join("、") || "无"}`,
    `有待确认邀约：${ctx.hasPendingInvite ? "是" : "否"}`,
    `待补约面时间/地点：${ctx.hasInvitePlan ? "是" : "否"}`,
    `规则引擎初判：${ctx.ruleIntent || "无"} (置信度 ${ctx.ruleConfidence ?? "-"})`,
    "",
    `用户原话：${message}`,
  ].join("\n");

  let token;
  try {
    token = loadGatewayToken();
  } catch {
    return null;
  }

  const sessionKey = `hr-intent-classify:${ctx.userId || "anon"}`;
  let upstream;
  try {
    upstream = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "x-openclaw-session-key": sessionKey,
      },
      body: JSON.stringify({
        model: process.env.OPENCLAW_CHAT_MODEL || "openclaw",
        stream: false,
        temperature: 0,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(Number(process.env.HR_INTENT_LLM_TIMEOUT_MS || 12_000)),
    });
  } catch {
    return null;
  }

  if (!upstream.ok) return null;
  let data;
  try {
    data = await upstream.json();
  } catch {
    return null;
  }
  const content =
    data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? "";
  const parsed = extractJsonObject(content);
  if (!parsed || typeof parsed !== "object") return null;

  const intent = String(parsed.intent || "").trim();
  if (!VALID_INTENTS.has(intent)) return null;

  const targetNames = Array.isArray(parsed.targetNames)
    ? parsed.targetNames.map((x) => String(x || "").trim()).filter(Boolean)
    : [];
  const resolvedTargets = known.length
    ? matchKnownNames(`${message} ${targetNames.join(" ")}`, known)
    : targetNames;

  let perTargetQuestions = Array.isArray(parsed.perTargetQuestions)
    ? parsed.perTargetQuestions
        .map((row) => ({
          name: String(row?.name || "").trim(),
          question: String(row?.question || "").trim(),
        }))
        .filter((row) => row.name && row.question.length >= 2)
    : [];
  if (!perTargetQuestions.length) {
    perTargetQuestions = softParsePerTargetQuestions(message, known);
  }

  const interviewRaw = parsed.interview && typeof parsed.interview === "object" ? parsed.interview : {};
  const interviewFallback = extractInterviewDetails(message);
  const interview = {
    mode: interviewRaw.mode || interviewFallback.mode || null,
    time: interviewRaw.time || interviewFallback.time || null,
    place: interviewRaw.place || interviewFallback.place || null,
  };

  return {
    intent,
    confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0.8)),
    source: "llm",
    hints: {
      jobTitle: parsed.jobTitle ? String(parsed.jobTitle).slice(0, 80) : null,
      headcount:
        Number.isFinite(Number(parsed.headcount)) && Number(parsed.headcount) > 0
          ? Number(parsed.headcount)
          : null,
      targetNames: resolvedTargets,
      customQuestion: parsed.customQuestion ? String(parsed.customQuestion).trim() : null,
      perTargetQuestions,
      interview,
    },
  };
}

/**
 * Rules high-confidence → keep. Soft / dialogue phase → ask LLM and merge.
 */
export function needsLlmAssist(ruleResult, ctx = {}) {
  if (process.env.HR_INTENT_LLM === "0") return false;
  const conf = Number(ruleResult?.confidence) || 0;
  const intent = ruleResult?.intent;
  if (conf >= 0.92 && intent !== HR_INTENTS.SMALLTALK && intent !== HR_INTENTS.CONTINUE) {
    // Still assist when asking candidates in free form with multiple people / mixed questions
    const raw = String(ctx.message || "");
    if (
      intent === HR_INTENTS.ASK_CANDIDATES &&
      (/我想问.+(?:我想问|，问|；问)/.test(raw) ||
        (ruleResult?.hints?.targetNames?.length > 1 && /期望|薪资|作品|到岗/.test(raw)))
    ) {
      return true;
    }
    return false;
  }
  if (intent === HR_INTENTS.SMALLTALK || intent === HR_INTENTS.CONTINUE) return true;
  if (conf < 0.85) return true;
  // Active funnel dialogue: prefer LLM assist for oral asks / reply checks / invite phrasing
  if (ctx.hasCandidates && conf < 0.93) return true;
  return false;
}

/**
 * Merge rule + LLM classification. Prefer LLM intent when rules were soft;
 * always enrich targets / questions / interview from LLM when present.
 */
export function mergeHrClassification(ruleResult, llmResult) {
  if (!llmResult) {
    return { ...ruleResult, source: "rules" };
  }
  const ruleConf = Number(ruleResult?.confidence) || 0;
  const llmConf = Number(llmResult?.confidence) || 0;
  const softRule =
    ruleResult?.intent === HR_INTENTS.SMALLTALK ||
    ruleResult?.intent === HR_INTENTS.CONTINUE ||
    ruleConf < 0.85;

  const ruleHints = ruleResult?.hints || {};
  const llmHints = llmResult.hints || {};
  let intent = softRule || llmConf >= ruleConf ? llmResult.intent : ruleResult.intent;
  // Named「求简历+提问」must stay ask_candidates; LLM often collapses it to request_resume.
  if (ruleHints.alsoRequestResume && ruleResult?.intent === HR_INTENTS.ASK_CANDIDATES) {
    intent = HR_INTENTS.ASK_CANDIDATES;
  }

  return {
    intent,
    confidence: Math.max(ruleConf, llmConf),
    source: softRule || llmConf >= ruleConf ? "rules+llm" : "rules",
    hints: {
      ...ruleHints,
      jobTitle: llmHints.jobTitle || ruleHints.jobTitle || "",
      headcount: llmHints.headcount ?? ruleHints.headcount ?? null,
      city: llmHints.city || ruleHints.city || null,
      requirements: llmHints.requirements || ruleHints.requirements || null,
      targetNames:
        llmHints.targetNames?.length > 0 ? llmHints.targetNames : ruleHints.targetNames || [],
      customQuestion: llmHints.customQuestion || ruleHints.customQuestion || null,
      perTargetQuestions:
        llmHints.perTargetQuestions?.length > 0
          ? llmHints.perTargetQuestions
          : ruleHints.perTargetQuestions || [],
      interview: {
        mode: llmHints.interview?.mode || ruleHints.interview?.mode || null,
        time: llmHints.interview?.time || ruleHints.interview?.time || null,
        place: llmHints.interview?.place || ruleHints.interview?.place || null,
      },
      rechatMessage: ruleHints.rechatMessage || null,
      alsoRequestResume: Boolean(ruleHints.alsoRequestResume || llmHints.alsoRequestResume),
    },
  };
}
