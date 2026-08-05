import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { checkBossLoginStatus } from "./boss-login.js";
import {
  bossBrowserMode,
  getBoundBrowserNode,
  withBrowserNode,
} from "./browser-node.js";
import { classifyHrIntent, HR_INTENTS, extractJobHints, matchKnownNames } from "./hr-intent.js";
import {
  classifyHrIntentWithLlm,
  mergeHrClassification,
  needsLlmAssist,
  softParsePerTargetQuestions,
} from "./hr-intent-llm.js";
import { assertBossBrowserIsolation } from "./security-isolation.js";
import {
  FUNNEL,
  FUNNEL_STAGE,
  VERDICT,
  verdictFromMatchScore,
  verdictFromAnswerScore,
  reasonForMatchVerdict,
  reasonForAnswerVerdict,
  defaultScreenQuestions,
  funFollowupMessage,
  interviewInviteDraft,
  scoreAnswerExcerpt,
  titleRelevance,
  parseMeta,
  buildCandidateMeta,
  funnelTag,
  pickFollowupDue,
  summarizeFunnelBuckets,
  detectCandidateReply,
} from "./hr-funnel.js";

const SKU = "hr-recruitment";

/** Desktop client executes these against the local Boss window (employer IP). */
function clientAction(type, params = {}) {
  return {
    executor: "desktop_boss",
    type,
    params,
    ipIsolation: "client_only",
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function ensureHrPipelineTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hr_jobs (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      user_id BIGINT NOT NULL,
      sku VARCHAR(64) NOT NULL,
      mode VARCHAR(16) NOT NULL DEFAULT 'inbox',
      job_title VARCHAR(120) NOT NULL,
      headcount INT NULL,
      today_only TINYINT(1) NOT NULL DEFAULT 1,
      notes TEXT NULL,
      stage VARCHAR(32) NOT NULL DEFAULT 'collect',
      status VARCHAR(24) NOT NULL DEFAULT 'active',
      blocked TINYINT(1) NOT NULL DEFAULT 0,
      summary TEXT NULL,
      meta JSON NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_hr_jobs_user (user_id, status),
      INDEX idx_hr_jobs_user_active (user_id, sku, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hr_candidates (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      job_id BIGINT NOT NULL,
      user_id BIGINT NOT NULL,
      external_key VARCHAR(120) NULL,
      name VARCHAR(80) NOT NULL,
      title VARCHAR(120) NULL,
      company VARCHAR(120) NULL,
      city VARCHAR(80) NULL,
      experience VARCHAR(80) NULL,
      education VARCHAR(80) NULL,
      salary VARCHAR(80) NULL,
      score INT NOT NULL DEFAULT 0,
      verdict VARCHAR(24) NOT NULL DEFAULT 'pending',
      reason TEXT NULL,
      resume_path VARCHAR(512) NULL,
      chat_excerpt TEXT NULL,
      ask_status VARCHAR(24) NOT NULL DEFAULT 'none',
      invite_status VARCHAR(24) NOT NULL DEFAULT 'none',
      meta JSON NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_hr_cand_job (job_id),
      INDEX idx_hr_cand_user (user_id, job_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hr_invite_batches (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      job_id BIGINT NOT NULL,
      user_id BIGINT NOT NULL,
      candidate_ids JSON NOT NULL,
      draft_message TEXT NOT NULL,
      status VARCHAR(24) NOT NULL DEFAULT 'pending_confirm',
      sent_at TIMESTAMP NULL,
      meta JSON NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_hr_invite_user (user_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hr_user_preferences (
      user_id BIGINT PRIMARY KEY,
      profile JSON NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

async function getHrPreferences(pool, userId) {
  const [rows] = await pool.query(`SELECT profile FROM hr_user_preferences WHERE user_id = ?`, [
    userId,
  ]);
  return parseJson(rows[0]?.profile, { instructions: [] });
}

async function saveHrPreferences(pool, userId, profile) {
  await pool.query(
    `INSERT INTO hr_user_preferences (user_id, profile) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE profile = VALUES(profile), updated_at = CURRENT_TIMESTAMP`,
    [userId, JSON.stringify(profile)],
  );
  return profile;
}

function preferenceInstructions(profile) {
  return Array.isArray(profile?.instructions)
    ? profile.instructions.map((item) => String(item || "").trim()).filter(Boolean).slice(-20)
    : [];
}

function extractPreferenceCommand(message) {
  const raw = String(message || "").trim();
  if (/^(?:清空|删除|重置|忘掉|忘记)(?:我的)?(?:招聘)?(?:长期)?(?:偏好|记忆|规则)[。！!]?$/i.test(raw)) {
    return { action: "clear" };
  }
  const match = raw.match(
    /^(?:请)?(?:记住|以后(?:都|要)?|我的招聘偏好是|我的筛选偏好是|招聘时请|筛选时请)[：,:，\s]*(.+)$/i,
  );
  if (!match?.[1]) return null;
  const instruction = match[1].replace(/[。！!]+$/, "").trim().slice(0, 240);
  return instruction ? { action: "add", instruction } : null;
}

function preferencesText(profile) {
  return preferenceInstructions(profile).join("；");
}

async function getActiveJob(pool, userId) {
  const [rows] = await pool.query(
    `SELECT * FROM hr_jobs WHERE user_id = ? AND sku = ? AND status = 'active' ORDER BY id DESC LIMIT 1`,
    [userId, SKU],
  );
  return rows[0] || null;
}

async function listCandidates(pool, jobId) {
  const [rows] = await pool.query(
    `SELECT * FROM hr_candidates WHERE job_id = ? ORDER BY score DESC, id ASC`,
    [jobId],
  );
  return rows;
}

async function getPendingInvite(pool, userId) {
  const [rows] = await pool.query(
    `SELECT * FROM hr_invite_batches WHERE user_id = ? AND status IN ('pending_confirm', 'dispatching') ORDER BY id DESC LIMIT 1`,
    [userId],
  );
  return rows[0] || null;
}

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function scoreCandidate(c, jobTitle, notes) {
  const title = String(c.title || "").trim();
  const excerpt = c.chatExcerpt || c.chat_excerpt || c.pageSnippet || "";
  const resume = String(c.resumeText || "").trim();
  const relTitle = titleRelevance(jobTitle, title);
  const relExcerpt = title ? 0 : titleRelevance(jobTitle, String(excerpt).slice(0, 80));
  const relResume = resume ? titleRelevance(jobTitle, resume.slice(0, 200)) * 0.5 : 0;
  const rel = Math.max(relTitle, relExcerpt * 0.85, relResume);

  const preferenceEvidence = `${title} ${c.experience || ""} ${c.education || ""} ${excerpt} ${resume}`.toLowerCase();
  const preferenceBonus = String(notes || "")
    .split(/[\s,，、;；]+/)
    .filter((item) => item.length >= 2)
    .slice(0, 12)
    .reduce((score, item) => score + (preferenceEvidence.includes(item.toLowerCase()) ? 2 : 0), 0);

  const quality = (() => {
    let b = 0;
    const edu = String(c.education || "");
    if (/博士/.test(edu)) b += 6;
    else if (/硕士/.test(edu)) b += 5;
    else if (/本科/.test(edu)) b += 3;
    const exp = String(c.experience || "");
    const ym = exp.match(/(\d+(?:\.\d+)?)\s*年/);
    if (ym) {
      const y = Number(ym[1]);
      if (y >= 5) b += 5;
      else if (y >= 3) b += 3;
      else if (y >= 1) b += 1;
    } else if (/应届|在校/.test(exp)) b += 1;
    if (resume.length > 120) b += 3;
    else if (resume.length > 40) b += 1;
    if (String(excerpt).length > 80) b += 1;
    return b;
  })();

  // Exact / near-exact role → enter greet pool, then rank by resume/profile quality.
  if (title && relTitle >= 0.92) {
    return Math.min(99, 90 + Math.min(9, quality + preferenceBonus));
  }
  if (title && relTitle >= 0.85) {
    return Math.min(99, Math.max(85, Math.round(78 + relTitle * 12 + quality + preferenceBonus)));
  }

  // Unrelated title: hard-cap below reject threshold.
  if (title && relTitle < 0.25) {
    return Math.min(35, Math.round(20 + relTitle * 40));
  }

  let score = 40 + Math.round(rel * 40) + quality + preferenceBonus;
  if (!title && excerpt) score = Math.max(score, 48);
  const blob = `${c.name || ""} ${title} ${c.experience || ""} ${c.education || ""} ${excerpt} ${resume}`.toLowerCase();
  const jt = String(jobTitle || "").toLowerCase();
  if (jt && blob.includes(jt)) score += 8;
  for (const kw of String(jobTitle || "")
    .split(/[\s/｜|·]+/)
    .filter((x) => x.length >= 2)
    .slice(0, 6)) {
    if (blob.includes(kw.toLowerCase())) score += 4;
  }
  if (/本科|硕士|博士/.test(c.education || "")) score += 4;
  if (/年|经验/.test(c.experience || "")) score += 4;
  return Math.max(0, Math.min(99, score));
}

function draftInviteMessage(job, details = {}) {
  return interviewInviteDraft(job, details);
}

function jobMeta(job) {
  return parseMeta(job?.meta);
}

async function saveJobMeta(pool, jobId, patch) {
  const [rows] = await pool.query(`SELECT meta FROM hr_jobs WHERE id = ?`, [jobId]);
  const next = { ...parseMeta(rows[0]?.meta), ...patch };
  await pool.query(`UPDATE hr_jobs SET meta = ? WHERE id = ?`, [JSON.stringify(next), jobId]);
  return next;
}

async function recordAutoAdvanceProgress(pool, jobId, runId, { completed = 1, failures = 0 } = {}) {
  if (!runId) return null;
  const [rows] = await pool.query(`SELECT meta FROM hr_jobs WHERE id = ?`, [jobId]);
  const meta = parseMeta(rows[0]?.meta);
  const run = meta.autoAdvance;
  if (!run || run.runId !== runId) return null;
  const completedActions = Math.min(run.totalActions || 0, (run.completedActions || 0) + completed);
  const failureCount = (run.failureCount || 0) + failures;
  const status = completedActions >= (run.totalActions || 0) ? "completed" : "dispatching";
  const next = {
    ...meta,
    autoAdvance: {
      ...run,
      completedActions,
      failureCount,
      status,
      updatedAt: new Date().toISOString(),
      ...(status === "completed" ? { completedAt: new Date().toISOString() } : {}),
    },
  };
  await pool.query(`UPDATE hr_jobs SET meta = ? WHERE id = ?`, [JSON.stringify(next), jobId]);
  return next.autoAdvance;
}

function pendingPlanFromJob(job) {
  const plan = jobMeta(job).pendingPlan;
  if (!plan || plan.status !== "awaiting_confirm") return null;
  return plan;
}

/** Human-readable intent recap before desktop Boss skills run. */
function buildHirePlanReply(job, hints = {}, draftActions = []) {
  const title = job?.job_title || hints.jobTitle || "未命名岗位";
  const headcount = job?.headcount || hints.headcount || 5;
  const modeLabel = job?.mode === "search" ? "主动搜人" : "沟通/投递初筛";
  const lines = [
    "我理解的招聘意图如下，请确认后我再在本机 Boss 执行：",
    `· 岗位：${title}`,
    `· 人数：${headcount}`,
    hints.city ? `· 城市：${hints.city}` : null,
    hints.requirements ? `· 要求：${hints.requirements}` : null,
    `· 执行方式：${modeLabel}（本机内嵌 Boss，不走服务器浏览器）`,
    draftActions.length
      ? `· 确认后将执行：${draftActions.map((a) => a.type).join(" → ")}`
      : null,
    "",
    "回复「确认执行」或点下方按钮开始；「先别执行」可取消。",
  ];
  return lines.filter((x) => x != null).join("\n");
}

function draftScrapeInboxAction(job) {
  return clientAction("scrape_inbox", {
    jobId: job.id,
    jobTitle: job.job_title,
    headcount: job.headcount || 5,
    todayOnly: Boolean(job.today_only),
    // Pull as many chat rows as the virtualized list can yield (accumulate while scrolling).
    limit: 300,
  });
}

/** Resolve 「只约张同学」against current candidates. */
function resolveTargetCandidates(all, targetNames) {
  const tokens = (targetNames || []).filter(Boolean);
  if (!tokens.length) return null;
  const matched = all.filter((c) => {
    const name = String(c.name || "");
    return tokens.some((t) => {
      if (name.includes(t) || t.includes(name)) return true;
      const short = name.replace(/(同学|先生|女士)$/u, "");
      const tShort = String(t).replace(/(同学|先生|女士)$/u, "");
      return short && tShort && (short.includes(tShort) || tShort.includes(short));
    });
  });
  return matched;
}

function mergeInterviewDetails(prev = {}, next = {}) {
  return {
    mode: next.mode || prev.mode || null,
    time: next.time || prev.time || null,
    place: next.place || prev.place || null,
  };
}

function interviewMissing(details) {
  const missing = [];
  if (!details?.mode) missing.push("面试形式（线上/线下）");
  if (!details?.time) missing.push("面试时间");
  if (details?.mode === "offline" && !details?.place) missing.push("线下地点");
  return missing;
}

function buildAutoAdvancePlan(candidates, job) {
  const actions = [];
  const counts = {
    greet: 0,
    inspectReplies: 0,
    screenAnswers: 0,
    requestResume: 0,
    downloadResume: 0,
    waiting: 0,
    manualReview: 0,
    done: 0,
  };
  const pendingReplyNames = [];
  const resumeRequestNames = [];
  const resumeDownloadNames = [];
  const greetCandidates = [];
  let shouldScreenAnswers = false;

  for (const candidate of candidates || []) {
    if (candidate.verdict === VERDICT.REJECT) continue;
    const meta = parseMeta(candidate.meta);
    const stage = meta.funnelStage;
    if (meta.needsHrReview || stage === FUNNEL_STAGE.PORTFOLIO_REVIEW) {
      counts.manualReview += 1;
      continue;
    }
    if (candidate.invite_status === "sent" || stage === FUNNEL_STAGE.INVITE_SENT) {
      counts.done += 1;
      continue;
    }
    if (candidate.resume_path || stage === FUNNEL_STAGE.RESUME_READY) {
      counts.done += 1;
      continue;
    }
    if (stage === FUNNEL_STAGE.RESUME_REQUESTED) {
      resumeDownloadNames.push(candidate.name);
      counts.downloadResume += 1;
      continue;
    }
    if (candidate.verdict === VERDICT.RESUME && stage === FUNNEL_STAGE.ANSWER_SCORED) {
      resumeRequestNames.push(candidate.name);
      counts.requestResume += 1;
      continue;
    }
    const reply = detectCandidateReply(candidate.chat_excerpt);
    if ((reply.replied || meta.repliedAt) && (stage === FUNNEL_STAGE.GREET_SENT || stage === FUNNEL_STAGE.FOLLOWUP_SENT)) {
      shouldScreenAnswers = true;
      counts.screenAnswers += 1;
      continue;
    }
    if (candidate.ask_status === "failed" && candidate.verdict === VERDICT.GREET && meta.shortlisted) {
      greetCandidates.push(candidate);
      counts.greet += 1;
      continue;
    }
    if (
      stage === FUNNEL_STAGE.GREET_SENT ||
      stage === FUNNEL_STAGE.FOLLOWUP_SENT ||
      candidate.ask_status === "queued" ||
      candidate.ask_status === "sent" ||
      candidate.ask_status === "followup_queued"
    ) {
      pendingReplyNames.push(candidate.name);
      counts.inspectReplies += 1;
      continue;
    }
    if (candidate.verdict === VERDICT.GREET && meta.shortlisted) {
      greetCandidates.push(candidate);
      counts.greet += 1;
      continue;
    }
    counts.waiting += 1;
  }

  const runId = `advance-${job.id}-${Date.now()}`;
  if (pendingReplyNames.length) {
    actions.push(
      clientAction("check_inbox_replies", {
        limit: pendingReplyNames.length,
        names: pendingReplyNames,
        jobId: job.id,
        runId,
      }),
    );
  }
  if (shouldScreenAnswers) {
    actions.push(clientAction("screen_candidate_answers", { jobId: job.id, runId }));
  }
  if (greetCandidates.length) {
    const message = defaultScreenQuestions(job.job_title, job.notes).join("\n");
    actions.push(
      ...greetCandidates.map((candidate) =>
        clientAction("auto_rechat", {
          message,
          limit: 1,
          names: [candidate.name],
          runId,
          nextAction: "greet",
        }),
      ),
    );
  }
  if (resumeRequestNames.length) {
    actions.push(
      clientAction("request_resumes", {
        limit: resumeRequestNames.length,
        names: resumeRequestNames,
        runId,
      }),
    );
  }
  if (resumeDownloadNames.length) {
    actions.push(
      clientAction("download_resumes", {
        limit: resumeDownloadNames.length,
        names: resumeDownloadNames,
        runId,
      }),
    );
  }
  return { runId, actions, counts, shouldScreenAnswers };
}

function collectRepliedCandidates(candidates) {
  const replied = [];
  const waiting = [];
  for (const c of candidates || []) {
    if (c.verdict === VERDICT.REJECT) continue;
    const meta = parseMeta(c.meta);
    const stage = meta.funnelStage;
    const awaiting =
      stage === FUNNEL_STAGE.GREET_SENT ||
      stage === FUNNEL_STAGE.FOLLOWUP_SENT ||
      c.ask_status === "queued" ||
      c.ask_status === "sent" ||
      c.ask_status === "followup_queued";
    const det = detectCandidateReply(c.chat_excerpt);
    if (det.replied || meta.repliedAt) {
      replied.push({
        ...c,
        replyPreview: det.preview,
        replyModality: meta.replyModality || det.summary || "文字",
        needsHrReview: Boolean(meta.needsHrReview || det.needsHrReview),
      });
    } else if (awaiting) {
      waiting.push(c);
    }
  }
  return { replied, waiting };
}

function resumeDir(userId) {
  const dir = join(homedir(), ".openclaw", "product-hr", String(userId), "resumes");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Attempt to pull today's inbox candidates from Boss via hosted browser.
 * Returns blocked/login/candidates payload — never silently invents names unless
 * DEMO_HR_PIPELINE=1 for local UX demo when site is blocked.
 */
export async function pullBossInboxCandidates({ jobTitle, todayOnly = true }) {
  // Explicit demo mode: walk full rank/invite UX without live Boss pages.
  if (process.env.DEMO_HR_PIPELINE === "1") {
    const seed = [
      {
        externalKey: "demo-1",
        name: "张同学",
        title: `${jobTitle || "目标岗位"} · 3年`,
        city: "广州",
        experience: "3年",
        education: "本科",
        salary: "15-20K",
        chatExcerpt:
          "可以尽快到岗，熟悉剪辑流程。作品集链接：https://portfolio.example.com/zhang （演示）",
      },
      {
        externalKey: "demo-2",
        name: "李同学",
        title: `${jobTitle || "目标岗位"} · 5年`,
        city: "深圳",
        experience: "5年",
        education: "硕士",
        salary: "20-30K",
        chatExcerpt: "做过同类成片，[视频] 演示短片已发，可接受线上面试，本周方便沟通到岗时间。",
      },
      {
        externalKey: "demo-3",
        name: "王同学",
        title: `行政文员 · 1年`,
        city: "佛山",
        experience: "1年",
        education: "大专",
        salary: "8-12K",
        chatExcerpt: "不考虑该技术方向，暂不方便面试。",
      },
    ];
    return {
      ok: true,
      blocked: false,
      loggedIn: true,
      demo: true,
      todayOnly,
      candidates: seed,
      message: "（演示数据）用于在 Boss 实网不可用时跑通评优/确认邀约链路。",
    };
  }

  let login;
  try {
    login = await checkBossLoginStatus(null);
  } catch (err) {
    return {
      ok: false,
      blocked: /访问受限|403|blocked/i.test(String(err.message || "")),
      loggedIn: false,
      error: err.message,
      candidates: [],
    };
  }
  if (login?.blocked) {
    return {
      ok: false,
      blocked: true,
      loggedIn: false,
      message: login.message || login.instruction,
      candidates: [],
      login,
    };
  }
  if (!login?.loggedIn) {
    return {
      ok: false,
      blocked: false,
      loggedIn: false,
      message: "Boss 未登录，请先完成手机号登录。",
      candidates: [],
      login,
    };
  }

  return {
    ok: false,
    blocked: false,
    loggedIn: true,
    candidates: [],
    message:
      "Boss 已登录，但投递列表抓取脚本尚未在当前环境打通。可临时设置 DEMO_HR_PIPELINE=1 先走通评优/确认邀约演示。",
    login,
  };
}

async function upsertJob(pool, userId, { mode, jobTitle, headcount, todayOnly, notes }) {
  const active = await getActiveJob(pool, userId);
  if (active && active.job_title === jobTitle && active.mode === mode && active.status === "active") {
    await pool.query(
      `UPDATE hr_jobs SET headcount = COALESCE(?, headcount), today_only = ?, notes = COALESCE(?, notes), stage = 'screening', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [headcount, todayOnly ? 1 : 0, notes || null, active.id],
    );
    const [rows] = await pool.query(`SELECT * FROM hr_jobs WHERE id = ?`, [active.id]);
    return rows[0];
  }
  if (active) {
    await pool.query(`UPDATE hr_jobs SET status = 'archived' WHERE id = ?`, [active.id]);
  }
  const [result] = await pool.query(
    `INSERT INTO hr_jobs (user_id, sku, mode, job_title, headcount, today_only, notes, stage, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'screening', 'active')`,
    [userId, SKU, mode, jobTitle, headcount, todayOnly ? 1 : 0, notes || null],
  );
  const [rows] = await pool.query(`SELECT * FROM hr_jobs WHERE id = ?`, [result.insertId]);
  return rows[0];
}

async function replaceCandidates(pool, userId, job, pulled) {
  await pool.query(`DELETE FROM hr_candidates WHERE job_id = ?`, [job.id]);
  const out = [];
  for (const c of pulled.candidates || []) {
    const score = scoreCandidate(c, job.job_title, job.notes);
    const verdict = verdictFromMatchScore(score);
    const funnelStage =
      verdict === VERDICT.REJECT ? FUNNEL_STAGE.REJECTED : FUNNEL_STAGE.JD_SCREENED;
    let resumePath = null;
    if (c.resumeText) {
      const dir = resumeDir(userId);
      resumePath = join(dir, `${job.id}-${c.externalKey || out.length + 1}.txt`);
      writeFileSync(resumePath, c.resumeText, "utf8");
    }
    const meta = buildCandidateMeta(
      { source: pulled.demo ? "demo" : "boss", todayOnly: Boolean(job.today_only) },
      {
        funnelStage,
        matchScore: score,
        answerScore: null,
        dayLabel: c.dayLabel || null,
      },
    );
    const [result] = await pool.query(
      `INSERT INTO hr_candidates
        (job_id, user_id, external_key, name, title, company, city, experience, education, salary, score, verdict, reason, resume_path, chat_excerpt, ask_status, invite_status, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'none', 'none', ?)`,
      [
        job.id,
        userId,
        c.externalKey || null,
        c.name || "候选人",
        c.title || null,
        c.company || null,
        c.city || null,
        c.experience || null,
        c.education || null,
        c.salary || null,
        score,
        verdict,
        c.reason ||
          (() => {
            const rel = titleRelevance(job.job_title, c.title || "");
            const extra =
              rel < 0.25 ? `岗位相关度过低（当前「${c.title || "未知"}」≠「${job.job_title}」）` : "";
            return reasonForMatchVerdict(verdict, score, extra);
          })(),
        resumePath,
        c.chatExcerpt || null,
        JSON.stringify(meta),
      ],
    );
    out.push({ id: result.insertId, ...c, score, verdict, meta });
  }
  const buckets = summarizeFunnelBuckets(out);
  await pool.query(`UPDATE hr_jobs SET stage = 'jd_screened', blocked = 0, summary = ? WHERE id = ?`, [
    `JD初筛 ${buckets.total} 人｜≥${FUNNEL.ADVANCE_AT}%待打招呼 ${buckets.greet}｜待观察 ${buckets.maybe}｜不合适 ${buckets.reject}`,
    job.id,
  ]);
  return out;
}

function resumeSnippetOf(c) {
  const meta = parseMeta(c.meta);
  const fromFile = c.resume_path ? `本机简历文件：${c.resume_path}` : "";
  const rawText = String(c.resumeText || meta.resumeSnippet || "").replace(/\s+/g, " ").trim();
  const isChatNoise = (s) =>
    !s ||
    /^(今天|昨天|前天|今日|\d{1,2}月\d{1,2}日)/.test(s) ||
    /\[已读\]|\[未读\]|已读\]|未读\]/.test(s) ||
    (/^[^｜|]*｜[^｜|]*｜/.test(s) && /已读|未读|好的|嗯|收到/.test(s));
  const text = isChatNoise(rawText) ? "" : rawText;
  const bits = [
    c.experience || meta.experience,
    c.education || meta.education,
    c.salary || meta.salary,
    text.slice(0, 160),
  ].filter(Boolean);
  if (bits.length) return bits.join("｜");
  if (fromFile) return fromFile;
  const chat = String(c.chat_excerpt || c.chatExcerpt || "").replace(/\s+/g, " ").trim().slice(0, 120);
  if (chat && !isChatNoise(chat)) return chat;
  return "（简历摘要待拉取：将打开会话读取在线简历）";
}

function formatCandidateLines(candidates, limit = 8) {
  return candidates.slice(0, limit).flatMap((c, i) => {
    const meta = parseMeta(c.meta);
    const tag = funnelTag(c.verdict, meta.funnelStage);
    const ans = meta.answerScore != null ? `｜答对 ${meta.answerScore}%` : "";
    const mod = meta.replyModality ? `｜回复:${meta.replyModality}` : "";
    const hr = meta.needsHrReview ? "｜⚠需人事目视" : "";
    const head = `${i + 1}. ${c.name}｜${c.title || "-"}｜${c.city || "-"}｜匹配 ${c.score}%${ans}${mod}${hr}｜${tag}${c.reason ? `｜${c.reason}` : ""}`;
    return [head, `   简历：${resumeSnippetOf(c)}`];
  });
}

/** Reply list: top N by score among target-role / high-match — prefer today, do not dump rejects. */
function pickShowcaseCandidates(ranked, headcount = 5) {
  const n = Math.max(1, Math.min(20, Number(headcount) || 5));
  const isToday = (c) => {
    const day = String(parseMeta(c.meta).dayLabel || c.dayLabel || "");
    if (!day || /今天|今日/.test(day)) return true;
    return !(
      /^(昨天|前天)$/.test(day) ||
      /^\d{1,2}月\d{1,2}日$/.test(day) ||
      /^星期/.test(day) ||
      /^周[一二三四五六日天]$/.test(day)
    );
  };
  const byScore = (a, b) => (b.score || 0) - (a.score || 0);
  const greet = ranked.filter((c) => c.verdict === VERDICT.GREET).sort(byScore);
  const strongMaybe = ranked
    .filter((c) => c.verdict === VERDICT.MAYBE && (c.score || 0) >= 75)
    .sort(byScore);
  const pool = [...greet, ...strongMaybe];
  if (!pool.length) {
    return [...ranked].sort(byScore).slice(0, n);
  }
  const todayPool = pool.filter(isToday);
  const pastPool = pool.filter((c) => !isToday(c));
  // Fill from today first, then earlier days — never silently drop today's matches.
  return [...todayPool, ...pastPool].slice(0, n);
}

function buildJdScreenReply(job, ranked, { modeLabel = "筛选投递", demo = false } = {}) {
  const buckets = summarizeFunnelBuckets(ranked);
  const headcount = job.headcount || 5;
  const showcase = pickShowcaseCandidates(ranked, headcount);
  const questions = defaultScreenQuestions(job.job_title, job.notes);
  const titleHits = ranked.filter((c) => titleRelevance(job.job_title, c.title || "") >= 0.85);
  const isToday = (c) => {
    const day = String(parseMeta(c.meta).dayLabel || c.dayLabel || "");
    if (!day || /今天|今日/.test(day)) return true;
    return !(
      /^(昨天|前天)$/.test(day) ||
      /^\d{1,2}月\d{1,2}日$/.test(day) ||
      /^星期/.test(day) ||
      /^周[一二三四五六日天]$/.test(day)
    );
  };
  const todayAll = ranked.filter(isToday);
  const todayTitleHits = titleHits.filter(isToday);
  const todayHitLines = todayTitleHits
    .slice(0, 30)
    .map((c, i) => `  ${i + 1}. ${c.name}｜${c.title || "-"}｜匹配 ${c.score}%`);
  return [
    demo ? "【演示模式】以下为示例候选人，用于跑通人事漏斗。" : "【实网】候选人来自本机 Boss「沟通」列表。",
    `已启动【标准招聘漏斗】第1步：岗位画像/JD 简历初筛（${modeLabel}）`,
    `岗位：${job.job_title}｜目标人数：${headcount}${job.today_only ? "｜范围：优先今日，对口不足则补更早沟通" : ""}`,
    `本批拉取 ${buckets.total} 人｜今日识别 ${todayAll.length} 人｜今日对口标题 ${todayTitleHits.length} 人｜对口池合计 ${buckets.greet}｜已隐藏不相关 ${buckets.reject} 人`,
    todayTitleHits.length
      ? `—— 今日对口完整名单（未删减，共 ${todayTitleHits.length}）——`
      : "—— 今日对口完整名单：0（若 Boss「全部」里能看到多人，请更新桌面端后重试）——",
    ...todayHitLines,
    todayTitleHits.length > 30 ? `  …另有 ${todayTitleHits.length - 30} 人` : null,
    `展示规则：从对口池按简历/资料质量择优 Top ${headcount}（下面是给你操作的短名单，不是今天只有这些人）。`,
    showcase.length ? `—— 择优短名单（${showcase.length}/${headcount}）——` : null,
    ...formatCandidateLines(showcase, headcount),
    "",
    showcase.length
      ? showcase.length < headcount
        ? `当前择优仅 ${showcase.length}/${headcount} 人。今日对口 ${todayTitleHits.length} 人已列在上方；若仍不足可再说「再筛一次」或换职位筛选项。`
        : `下一步：可说「打招呼提问」批量问短名单；或「问某人：…」只问一个人。正在拉取各人简历摘要。`
      : "本批暂无≥80%对口人选。请确认沟通「全部」列表里该岗位会话是否已加载。",
    `默认基础提问（可选）：`,
    ...questions.map((q, i) => `  Q${i + 1}. ${q}`),
    "之后：等回复（可说「有谁回复了」）→ 可继续追问 →「根据回复二次筛选」→ 约面 →「确认发送」。",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Ingest candidates scraped by desktop Boss window, then run JD screening.
 * Cap showcase to job.headcount and queue resume enrich for shortlisted names only.
 */
export async function ingestDesktopCandidates(pool, user, { jobId, candidates }) {
  await ensureHrPipelineTables(pool);
  const userId = user.id;
  const list = Array.isArray(candidates) ? candidates : [];
  if (!list.length) {
    return {
      ok: false,
      handled: true,
      loggedIn: true,
      reply: "本机未拉到候选人。请在 Boss「沟通」确认有会话后，再说一次招聘需求。",
      candidates: [],
    };
  }
  let job = null;
  if (jobId) {
    const [rows] = await pool.query(`SELECT * FROM hr_jobs WHERE id = ? AND user_id = ?`, [
      jobId,
      userId,
    ]);
    job = rows[0] || null;
  }
  if (!job) {
    job = await getActiveJob(pool, userId);
  }
  if (!job) {
    return {
      ok: false,
      handled: true,
      loggedIn: true,
      reply: "没有进行中的招聘任务。请先说「招 N 个某某岗位」。",
      candidates: [],
    };
  }

  const normalized = list
    .slice(0, 500)
    .filter((c) => {
      const name = String(c.name || "").trim();
      // Drop date headers / UI chips mistaken as people.
      if (!name || /^\d{1,2}月\d{1,2}日$/.test(name)) return false;
      if (/^(今天|昨天|管理|全部|未读|新招呼|沟通)$/.test(name)) return false;
      return true;
    })
    .map((c, i) => {
      let title = String(c.title || "").trim().slice(0, 120);
      // Employer job-filter chip — never a candidate role.
      if (/^(管理|全部|职位)$/.test(title)) title = "";
      return {
        externalKey: c.externalKey || c.external_key || `desktop-${i + 1}`,
        name: String(c.name || "候选人").slice(0, 40),
        title,
        company: c.company || null,
        city: c.city || null,
        experience: c.experience || null,
        education: c.education || null,
        salary: c.salary || null,
        chatExcerpt: c.chatExcerpt || c.chat_excerpt || "",
        pageSnippet: c.pageSnippet || "",
        resumeText: c.resumeText || null,
        dayLabel: c.dayLabel || null,
      };
    });

  const ranked = await replaceCandidates(pool, userId, job, {
    demo: false,
    candidates: normalized,
  });
  const buckets = summarizeFunnelBuckets(ranked);
  const headcount = job.headcount || 5;
  const showcase = pickShowcaseCandidates(ranked, headcount);
  const shortlistNames = showcase.map((c) => c.name).filter(Boolean);

  for (let i = 0; i < showcase.length; i++) {
    const c = showcase[i];
    if (!c.id) continue;
    const meta = buildCandidateMeta(c.meta, {
      shortlisted: true,
      shortlistRank: i + 1,
      resumeSnippet: resumeSnippetOf(c),
    });
    await pool.query(`UPDATE hr_candidates SET meta = ? WHERE id = ?`, [JSON.stringify(meta), c.id]);
    c.meta = meta;
  }
  await saveJobMeta(pool, job.id, { shortlistNames, shortlistAt: new Date().toISOString() });

  return {
    ok: true,
    handled: true,
    loggedIn: true,
    openLoginWizard: false,
    sku: SKU,
    intent: HR_INTENTS.RUN_FUNNEL,
    requireConfirm: false,
    job: {
      id: job.id,
      mode: job.mode,
      jobTitle: job.job_title,
      headcount: job.headcount,
      stage: "jd_screened",
    },
    candidates: showcase,
    shortlistNames,
    actions: [
      { id: "ask_candidates", label: `向择优 ${showcase.length} 人打招呼提问` },
      { id: "screen_answers", label: "根据回复二次筛选" },
      { id: "followup_24h", label: "24h未回复趣味复聊" },
    ],
    clientActions: shortlistNames.length
      ? [
          clientAction("enrich_profiles", {
            names: shortlistNames,
            limit: shortlistNames.length,
            jobId: job.id,
          }),
        ]
      : [],
    reply: buildJdScreenReply(job, ranked, {
      modeLabel: job.mode === "search" ? "主动搜人" : "沟通列表",
      demo: false,
    }),
    summary: `JD初筛 ${buckets.total} 人｜对口池 ${buckets.greet}｜择优展示 ${showcase.length}/${headcount}`,
  };
}

export async function ingestDesktopActionResult(pool, user, { type, results, runId, error }) {
  await ensureHrPipelineTables(pool);
  const userId = user.id;
  const job = await getActiveJob(pool, userId);
  if (!job) return { ok: false, handled: true, reply: "没有进行中的招聘任务。" };
  const candidates = await listCandidates(pool, job.id);
  const rows = Array.isArray(results) ? results : [];
  let successCount = 0;
  for (const row of rows) {
    if (!row?.name) continue;
    const candidate = candidates.find(
      (item) => item.name === row.name || item.name.includes(row.name) || row.name.includes(item.name),
    );
    if (!candidate) continue;
    const meta = parseMeta(candidate.meta);
    if (type === "auto_rechat") {
      const sent = Boolean(row.sent && row.verified);
      await pool.query(
        `UPDATE hr_candidates SET ask_status = ?, meta = ? WHERE id = ? AND user_id = ?`,
        [sent ? "sent" : "failed", JSON.stringify({ ...meta, sendError: row.error || null }), candidate.id, userId],
      );
      if (sent) successCount += 1;
      continue;
    }
    if (type === "request_resumes") {
      const requested = Boolean(row.requested);
      const nextMeta = requested
        ? buildCandidateMeta(meta, { funnelStage: FUNNEL_STAGE.RESUME_REQUESTED, resumeRequestedAt: new Date().toISOString() })
        : { ...meta, resumeRequestError: row.error || "request_not_confirmed" };
      await pool.query(`UPDATE hr_candidates SET meta = ? WHERE id = ? AND user_id = ?`, [
        JSON.stringify(nextMeta),
        candidate.id,
        userId,
      ]);
      if (requested) successCount += 1;
      continue;
    }
    if (type === "download_resumes" || type === "request_and_download_resumes") {
      const realResume = Boolean(!row.error && row.savedPath && /\.(?:pdf|docx?|rtf)$/i.test(row.savedPath));
      const nextMeta = realResume
        ? buildCandidateMeta(meta, { funnelStage: FUNNEL_STAGE.RESUME_READY, resumeDownloadedAt: new Date().toISOString() })
        : { ...meta, resumeDownloadError: row.error || "real_resume_not_saved" };
      await pool.query(
        `UPDATE hr_candidates SET resume_path = ?, verdict = ?, meta = ? WHERE id = ? AND user_id = ?`,
        [
          realResume ? row.savedPath : candidate.resume_path,
          realResume ? VERDICT.RESUME : candidate.verdict,
          JSON.stringify(nextMeta),
          candidate.id,
          userId,
        ],
      );
      if (realResume) successCount += 1;
      continue;
    }
    if (type === "boss_interview_invite") {
      const sent = Boolean(row.ok && row.native && row.submitted);
      await pool.query(`UPDATE hr_candidates SET invite_status = ?, meta = ? WHERE id = ? AND user_id = ?`, [
        sent ? "sent" : "failed",
        JSON.stringify({ ...meta, inviteError: sent ? null : row.error || "native_invite_not_submitted" }),
        candidate.id,
        userId,
      ]);
      if (sent) successCount += 1;
    }
  }
  if (type === "screen_candidate_answers") {
    successCount = error ? 0 : 1;
  }
  if (type === "boss_interview_invite") {
    const pending = await getPendingInvite(pool, userId);
    if (pending) {
      const fullySent = successCount === rows.length && rows.length > 0;
      await pool.query(
        `UPDATE hr_invite_batches SET status = ?, sent_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE sent_at END WHERE id = ?`,
        [fullySent ? "sent" : "failed", fullySent ? 1 : 0, pending.id],
      );
      await pool.query(`UPDATE hr_jobs SET stage = ? WHERE id = ? AND user_id = ?`, [
        fullySent ? "invite_sent" : "invite_failed",
        job.id,
        userId,
      ]);
    }
  }
  if ((type === "download_resumes" || type === "request_and_download_resumes") && successCount > 0) {
    await pool.query(`UPDATE hr_jobs SET stage = 'resume_ready' WHERE id = ? AND user_id = ?`, [
      job.id,
      userId,
    ]);
  }
  const failures = error ? 1 : rows.length > 0 && successCount === 0 ? 1 : 0;
  const autoAdvance = await recordAutoAdvanceProgress(pool, job.id, runId, {
    completed: 1,
    failures,
  });
  return {
    ok: true,
    handled: true,
    type,
    count: successCount,
    total: rows.length,
    autoAdvance,
  };
}

export async function ingestDesktopReplies(pool, user, { jobId, results, runId }) {
  await ensureHrPipelineTables(pool);
  const userId = user.id;
  const [jobs] = await pool.query(`SELECT * FROM hr_jobs WHERE id = ? AND user_id = ?`, [
    jobId,
    userId,
  ]);
  const job = jobs[0] || (await getActiveJob(pool, userId));
  if (!job) return { ok: false, handled: true, reply: "没有进行中的招聘任务。", candidates: [] };

  const candidates = await listCandidates(pool, job.id);
  const nowIso = new Date().toISOString();
  const updated = [];
  for (const row of Array.isArray(results) ? results : []) {
    if (!row?.replied || !row?.name) continue;
    const candidate = candidates.find(
      (item) => item.name === row.name || item.name.includes(row.name) || row.name.includes(item.name),
    );
    if (!candidate) continue;
    const transcript = (Array.isArray(row.lines) ? row.lines : [row.preview])
      .map((line) => String(line || "").trim())
      .filter(Boolean)
      .join("\n")
      .slice(0, 8000);
    const reply = detectCandidateReply(transcript);
    const meta = buildCandidateMeta(candidate.meta, {
      repliedAt: nowIso,
      awaitingReply: false,
      replyModality: row.hasMedia ? "链接/媒体" : reply.summary || "文字",
      needsHrReview: Boolean(row.hasMedia || reply.needsHrReview),
      desktopReplySyncedAt: nowIso,
    });
    await pool.query(
      `UPDATE hr_candidates SET chat_excerpt = ?, ask_status = 'replied', meta = ? WHERE id = ? AND user_id = ?`,
      [transcript, JSON.stringify(meta), candidate.id, userId],
    );
    updated.push({ ...candidate, chat_excerpt: transcript, meta });
  }
  const autoAdvance = await recordAutoAdvanceProgress(pool, job.id, runId, {
    completed: 1,
    failures: 0,
  });
  return {
    ok: true,
    handled: true,
    job: { id: job.id, jobTitle: job.job_title, stage: job.stage },
    candidates: updated,
    autoAdvance,
    actions: updated.length ? [{ id: "screen_answers", label: "根据回复二次筛选" }] : [],
    clientActions: [],
    reply: updated.length
      ? `已把 ${updated.length} 位候选人的真实回复写入招聘记录。下一步请执行「根据回复二次筛选」。`
      : "本次没有确认到新的候选人回复，未改动招聘记录。",
  };
}

/**
 * Patch shortlisted candidates with desktop-fetched resume/profile text, then re-rank Top N.
 */
export async function enrichDesktopShortlist(pool, user, { jobId, candidates }) {
  await ensureHrPipelineTables(pool);
  const userId = user.id;
  let job = null;
  if (jobId) {
    const [rows] = await pool.query(`SELECT * FROM hr_jobs WHERE id = ? AND user_id = ?`, [
      jobId,
      userId,
    ]);
    job = rows[0] || null;
  }
  if (!job) job = await getActiveJob(pool, userId);
  if (!job) {
    return {
      ok: false,
      handled: true,
      reply: "没有进行中的招聘任务。",
      candidates: [],
    };
  }
  const all = await listCandidates(pool, job.id);
  const patches = Array.isArray(candidates) ? candidates : [];
  for (const p of patches) {
    const name = String(p.name || "").trim();
    if (!name) continue;
    const hit =
      all.find((c) => c.name === name) ||
      all.find((c) => c.name.includes(name) || name.includes(c.name));
    if (!hit) continue;
    let resumePath = hit.resume_path || null;
    const resumeText = String(p.resumeText || "").trim();
    if (resumeText) {
      const dir = resumeDir(userId);
      resumePath = join(dir, `${job.id}-${hit.external_key || hit.id}-resume.txt`);
      writeFileSync(resumePath, resumeText, "utf8");
    }
    const nextFields = {
      title: p.title || hit.title,
      city: p.city || hit.city,
      experience: p.experience || hit.experience,
      education: p.education || hit.education,
      salary: p.salary || hit.salary,
      chatExcerpt: p.chatExcerpt || hit.chat_excerpt,
      resumeText,
    };
    const score = scoreCandidate(
      {
        name: hit.name,
        title: nextFields.title,
        experience: nextFields.experience,
        education: nextFields.education,
        chatExcerpt: nextFields.chatExcerpt,
        resumeText,
      },
      job.job_title,
      job.notes,
    );
    const verdict = verdictFromMatchScore(score);
    const meta = buildCandidateMeta(hit.meta, {
      shortlisted: true,
      matchScore: score,
      resumeSnippet: resumeSnippetOf({ ...hit, ...nextFields, resume_path: resumePath }),
      enrichedAt: new Date().toISOString(),
    });
    await pool.query(
      `UPDATE hr_candidates
       SET title = COALESCE(?, title), city = COALESCE(?, city), experience = COALESCE(?, experience),
           education = COALESCE(?, education), salary = COALESCE(?, salary),
           chat_excerpt = COALESCE(?, chat_excerpt), resume_path = COALESCE(?, resume_path),
           score = ?, verdict = ?, meta = ?
       WHERE id = ?`,
      [
        nextFields.title || null,
        nextFields.city || null,
        nextFields.experience || null,
        nextFields.education || null,
        nextFields.salary || null,
        nextFields.chatExcerpt || null,
        resumePath,
        score,
        verdict,
        JSON.stringify(meta),
        hit.id,
      ],
    );
  }

  const refreshed = await listCandidates(pool, job.id);
  const headcount = job.headcount || 5;
  // Re-pick Top N after resume enrich; clear old shortlist flags first.
  for (const c of refreshed) {
    const meta = parseMeta(c.meta);
    if (!meta.shortlisted) continue;
    await pool.query(`UPDATE hr_candidates SET meta = ? WHERE id = ?`, [
      JSON.stringify(buildCandidateMeta(meta, { shortlisted: false, shortlistRank: null })),
      c.id,
    ]);
  }
  const again = await listCandidates(pool, job.id);
  const showcase = pickShowcaseCandidates(again, headcount);
  const shortlistNames = [];
  for (let i = 0; i < showcase.length; i++) {
    const c = showcase[i];
    shortlistNames.push(c.name);
    const meta = buildCandidateMeta(c.meta, {
      shortlisted: true,
      shortlistRank: i + 1,
      resumeSnippet: resumeSnippetOf(c),
    });
    await pool.query(`UPDATE hr_candidates SET meta = ? WHERE id = ?`, [JSON.stringify(meta), c.id]);
    c.meta = meta;
  }
  await saveJobMeta(pool, job.id, { shortlistNames, shortlistAt: new Date().toISOString() });

  return {
    ok: true,
    handled: true,
    loggedIn: true,
    job: {
      id: job.id,
      mode: job.mode,
      jobTitle: job.job_title,
      headcount: job.headcount,
      stage: "jd_screened",
    },
    candidates: showcase,
    shortlistNames,
    actions: [
      { id: "ask_candidates", label: `向择优 ${showcase.length} 人打招呼提问` },
      { id: "screen_answers", label: "根据回复二次筛选" },
    ],
    reply: [
      `已根据在线简历/资料重新择优 Top ${headcount}：`,
      ...formatCandidateLines(showcase, headcount),
      "",
      "可对以上名单「打招呼提问」（批量），或「问某人：…」（单独）。每人后方已附简历摘要。",
    ].join("\n"),
    summary: `择优 ${showcase.length}/${headcount}（已附简历摘要）`,
  };
}

async function prepareInviteBatch(pool, userId, job, candidateIds, draftOverride, interviewDetails = {}) {
  const all = await listCandidates(pool, job.id);
  const selected = candidateIds?.length
    ? all.filter((c) => candidateIds.includes(c.id))
    : all.filter((c) => {
        if (c.verdict === VERDICT.REJECT) return false;
        if (c.verdict === VERDICT.INVITE || c.verdict === VERDICT.RESUME) return true;
        const meta = parseMeta(c.meta);
        if (meta.funnelStage === FUNNEL_STAGE.RESUME_READY) return true;
        return (
          meta.needsHrReview &&
          meta.funnelStage === FUNNEL_STAGE.PORTFOLIO_REVIEW &&
          c.verdict === VERDICT.MAYBE
        );
      });
  if (!selected.length) {
    return {
      ok: false,
      message:
        "当前没有可约面候选人。可说「只约张同学」指定人，或先完成二次筛/人事目视。",
    };
  }
  const details = mergeInterviewDetails({}, interviewDetails);
  const missing = interviewMissing(details);
  if (missing.length) {
    await saveJobMeta(pool, job.id, {
      invitePlan: {
        status: "awaiting_details",
        candidateIds: selected.map((c) => c.id),
        targetNames: selected.map((c) => c.name),
        interview: details,
      },
    });
    return {
      ok: false,
      awaitingDetails: true,
      candidates: selected,
      message: [
        `约面对象已锁定 ${selected.length} 人：${selected.map((c) => c.name).join("、")}`,
        `还缺：${missing.join("、")}。`,
        "请直接回复，例如：",
        "· 「明天下午3点，线上面试」",
        "· 「周五上午10点，线下面试，地点：天河路88号」",
        "齐了我会生成邀约草稿，你再「确认发送」。",
      ].join("\n"),
    };
  }

  const hrReviewNames = selected
    .filter((c) => parseMeta(c.meta).needsHrReview)
    .map((c) => c.name);
  await pool.query(
    `UPDATE hr_invite_batches SET status = 'cancelled' WHERE user_id = ? AND status = 'pending_confirm'`,
    [userId],
  );
  const draft = draftOverride || draftInviteMessage(job, details);
  const ids = selected.map((c) => c.id);
  const [result] = await pool.query(
    `INSERT INTO hr_invite_batches (job_id, user_id, candidate_ids, draft_message, status, meta)
     VALUES (?, ?, ?, ?, 'pending_confirm', ?)`,
    [job.id, userId, JSON.stringify(ids), draft, JSON.stringify({ interview: details })],
  );
  await pool.query(
    `UPDATE hr_candidates SET invite_status = 'pending_confirm', verdict = ? WHERE id IN (${ids.map(() => "?").join(",")})`,
    [VERDICT.INVITE, ...ids],
  );
  await pool.query(`UPDATE hr_jobs SET stage = 'invite_pending' WHERE id = ?`, [job.id]);
  await saveJobMeta(pool, job.id, { invitePlan: null });
  return {
    ok: true,
    batchId: result.insertId,
    draft,
    candidates: selected,
    message: [
      `已生成邀约草稿（尚未发送）。对象 ${selected.length} 人：`,
      ...selected.map((c) => {
        const m = parseMeta(c.meta);
        return `- ${c.name}${m.needsHrReview ? `（回复含${m.replyModality || "多媒体"}·请确认已目视）` : ""}`;
      }),
      `形式：${details.mode === "offline" ? "线下" : "线上"}｜时间：${details.time}${
        details.mode === "offline" ? `｜地点：${details.place}` : ""
      }`,
      hrReviewNames.length
        ? `\n⚠ 其中 ${hrReviewNames.join("、")} 含图片/视频/网站回复：机器分只供参考，请确认已看过材料再点「确认发送」。`
        : null,
      "",
      "【邀约文案】",
      draft,
      "",
      "请回复「确认发送」我才会在本机 Boss 代聊发出；回复「取消邀约」则作废。",
    ]
      .filter((x) => x != null)
      .join("\n"),
  };
}

async function confirmInviteBatch(pool, userId) {
  const batch = await getPendingInvite(pool, userId);
  if (!batch || batch.status !== "pending_confirm") {
    return { ok: false, message: "没有待确认的邀约。先说「约面试」生成草稿。", clientActions: [] };
  }
  const ids = parseJson(batch.candidate_ids, []);
  const draft = String(batch.draft_message || "").trim();
  await pool.query(`UPDATE hr_invite_batches SET status = 'dispatching' WHERE id = ?`, [batch.id]);
  if (ids.length) {
    await pool.query(
      `UPDATE hr_candidates SET invite_status = 'dispatching', verdict = ? WHERE id IN (${ids.map(() => "?").join(",")})`,
      [VERDICT.INVITE, ...ids],
    );
  }
  await pool.query(`UPDATE hr_jobs SET stage = 'invite_dispatching' WHERE id = ?`, [batch.job_id]);
  const [cands] = await pool.query(
    `SELECT name FROM hr_candidates WHERE id IN (${ids.map(() => "?").join(",") || "NULL"})`,
    ids,
  );
  const names = (cands || []).map((c) => c.name).filter(Boolean);
  const demo = process.env.DEMO_HR_PIPELINE === "1";
  const meta = parseJson(batch.meta, {});
  const interview = meta.interview || {};
  const clientActions =
    draft && names.length && !demo
      ? [
          clientAction("boss_interview_invite", {
            names,
            limit: names.length,
            mode: interview.mode === "offline" ? "offline" : "online",
            time: interview.time || "",
            place: interview.place || "",
            draft,
          }),
        ]
      : [];
  return {
    ok: true,
    batchId: batch.id,
    names,
    draft,
    clientActions,
    message: [
      `已确认执行邀约（人工确认门禁已通过，等待本机 Boss 回执）。`,
      `对象：${names.join("、") || ids.join(",")}`,
      demo
        ? `当前是演示模式（DEMO_HR_PIPELINE=1）：产品侧已标记已发送；真实 Boss 代发需关闭演示并用桌面客户端。`
        : clientActions.length
          ? `已下发本机 Boss 原生「约面试」邀约；只有本机确认正式提交后才会标记为已发送。`
          : `暂无可用邀约文案或候选人姓名，请人工在 Boss 复用批次草稿。`,
    ].join("\n"),
  };
}

async function cancelInviteBatch(pool, userId) {
  const batch = await getPendingInvite(pool, userId);
  if (!batch) return { ok: false, message: "没有待取消的邀约草稿。" };
  const ids = parseJson(batch.candidate_ids, []);
  await pool.query(`UPDATE hr_invite_batches SET status = 'cancelled' WHERE id = ?`, [batch.id]);
  if (ids.length) {
    await pool.query(
      `UPDATE hr_candidates SET invite_status = 'none' WHERE id IN (${ids.map(() => "?").join(",")})`,
      ids,
    );
  }
  await pool.query(`UPDATE hr_jobs SET stage = 'ranked' WHERE id = ?`, [batch.job_id]);
  return { ok: true, message: "已取消邀约草稿，不会发送给候选人。" };
}

/**
 * Main conversational entry for HR SKU.
 * Returns a structured product reply; may also suggest opening login wizard.
 * @param {{ desktop?: boolean, bossLoggedIn?: boolean }} [clientContext]
 *   Desktop Electron reports local Boss session; BFF cannot see persist:boss-zhipin.
 */
export async function handleHrDialogue(pool, user, message, clientContext = {}) {
  await ensureHrPipelineTables(pool);
  const desktopClient = Boolean(clientContext?.desktop);
  const clientBossLoggedIn = Boolean(clientContext?.bossLoggedIn);
  try {
    assertBossBrowserIsolation();
  } catch (err) {
    return {
      sku: SKU,
      intent: "blocked_server_browser",
      confidence: 1,
      loggedIn: false,
      blocked: true,
      openLoginWizard: true,
      requireConfirm: false,
      job: null,
      pendingInvite: null,
      candidates: [],
      actions: [],
      clientActions: [],
      handled: true,
      reply: err.message,
    };
  }
  const userId = user.id;

  const bound = await getBoundBrowserNode(pool, userId);
  const nodeId = bound?.node_id || null;
  if (bossBrowserMode() === "user_node" && !nodeId && process.env.DEMO_HR_PIPELINE !== "1") {
    // Desktop already owns local Boss window — do not demand a Gateway browser node.
    if (desktopClient) {
      return withBrowserNode(null, () =>
        handleHrDialogueInner(pool, user, message, { desktopClient, clientBossLoggedIn }),
      );
    }
    const activeJobEarly = await getActiveJob(pool, userId);
    const pendingInviteEarly = await getPendingInvite(pool, userId);
    const classifiedEarly = classifyHrIntent(message, {
      loggedIn: false,
      hasPendingInvite: Boolean(pendingInviteEarly),
      hasPendingPlan: Boolean(pendingPlanFromJob(activeJobEarly)),
    });
    // Desktop Electron executes Boss DOM locally (client IP). These intents do not need
    // a Gateway browser node — only inbox/search proxy paths still require one (or demo).
    const desktopLocalIntents = new Set([
      HR_INTENTS.OPEN_BOSS,
      HR_INTENTS.CHECK_BOSS,
      HR_INTENTS.REQUEST_RESUME,
      HR_INTENTS.DOWNLOAD_RESUME,
      HR_INTENTS.AUTO_RECHAT,
      HR_INTENTS.ASK_CANDIDATES,
      HR_INTENTS.CHECK_REPLIES,
      HR_INTENTS.FOLLOWUP_24H,
      HR_INTENTS.SCREEN_ANSWERS,
      HR_INTENTS.TALENT_POOL,
      HR_INTENTS.PREPARE_INVITE,
      HR_INTENTS.FILL_INVITE_DETAILS,
      HR_INTENTS.NEED_LOGIN,
      HR_INTENTS.CONTINUE,
      HR_INTENTS.RUN_FUNNEL,
      HR_INTENTS.INBOX,
      HR_INTENTS.SEARCH,
      HR_INTENTS.RANK,
      HR_INTENTS.SHORTLIST,
      HR_INTENTS.STATUS,
      HR_INTENTS.CONFIRM_INVITE,
      HR_INTENTS.CANCEL_INVITE,
      HR_INTENTS.CONFIRM_PLAN,
      HR_INTENTS.CANCEL_PLAN,
    ]);
    if (desktopLocalIntents.has(classifiedEarly.intent)) {
      return withBrowserNode(null, () =>
        handleHrDialogueInner(pool, user, message, { desktopClient, clientBossLoggedIn }),
      );
    }
    if (classifiedEarly.intent !== HR_INTENTS.SMALLTALK) {
      return {
        sku: SKU,
        intent: classifiedEarly.intent,
        confidence: classifiedEarly.confidence,
        loggedIn: false,
        blocked: false,
        openLoginWizard: true,
        requireConfirm: false,
        job: null,
        pendingInvite: null,
        candidates: [],
        actions: [],
        clientActions: [clientAction("open_boss_login", {})],
        handled: true,
        reply:
          "招聘自动化需要「聚元灵创」桌面客户端（本机内嵌浏览器，独立登录态与出口 IP）。\n请安装并打开桌面客户端 → 登录已有 Boss 账号 → 检验登录态后再对话。\n服务端不会、也不能去检测你电脑上的普通 Chrome；封禁若发生，封的是你本机出口，不是我们的服务器 IP。\n也可先试：「自动请求简历」「自动下载简历」「自动复聊：……」。",
      };
    }
  }

  return withBrowserNode(nodeId, () =>
    handleHrDialogueInner(pool, user, message, { desktopClient, clientBossLoggedIn }),
  );
}

async function handleHrDialogueInner(pool, user, message, opts = {}) {
  const userId = user.id;
  const desktopClient = Boolean(opts.desktopClient);
  const clientBossLoggedIn = Boolean(opts.clientBossLoggedIn);
  let login = null;
  // Demo pipeline skips live Boss probe to keep chat snappy and avoid false blocked states.
  if (process.env.DEMO_HR_PIPELINE === "1") {
    login = { loggedIn: true, blocked: false, demo: true };
  } else if (desktopClient && clientBossLoggedIn) {
    // persist:boss-zhipin lives only in Electron — trust the desktop probe result.
    login = { loggedIn: true, blocked: false, desktopEmbedded: true };
  } else {
    try {
      login = await checkBossLoginStatus(null);
    } catch (err) {
      if (err?.code === "browser_node_required" || /browser_node_required/.test(String(err.message))) {
        // Desktop Electron path: BFF cannot probe Boss; clientActions run locally.
        // Treat as unknown login and let desktop-local intents through with clientActions.
        login = { loggedIn: false, blocked: false, desktopDeferred: true };
      } else {
        login = { loggedIn: false, blocked: false };
      }
    }
  }
  const pendingInvite = await getPendingInvite(pool, userId);
  const activeJob = await getActiveJob(pool, userId);
  const preferences = await getHrPreferences(pool, userId);
  const preferenceCommand = extractPreferenceCommand(message);
  if (preferenceCommand?.action === "clear") {
    await saveHrPreferences(pool, userId, { instructions: [] });
        return {
          sku: SKU,
      intent: "clear_preferences",
          confidence: 1,
      loggedIn: Boolean(login?.loggedIn),
      blocked: Boolean(login?.blocked),
      openLoginWizard: false,
          requireConfirm: false,
      job: activeJob
        ? {
            id: activeJob.id,
            mode: activeJob.mode,
            jobTitle: activeJob.job_title,
            headcount: activeJob.headcount,
            stage: activeJob.stage,
          }
        : null,
          pendingInvite: null,
      pendingPlan: null,
          candidates: [],
          actions: [],
      clientActions: [],
          handled: true,
      reply: "已清空你的长期招聘偏好。现有招聘任务和候选人记录不会删除。",
    };
  }
  if (preferenceCommand?.action === "add") {
    const instructions = preferenceInstructions(preferences).filter(
      (item) => item !== preferenceCommand.instruction,
    );
    instructions.push(preferenceCommand.instruction);
    await saveHrPreferences(pool, userId, { instructions: instructions.slice(-20) });
    return {
      sku: SKU,
      intent: "remember_preference",
      confidence: 1,
      loggedIn: Boolean(login?.loggedIn),
      blocked: Boolean(login?.blocked),
      openLoginWizard: false,
      requireConfirm: false,
      job: activeJob
        ? {
            id: activeJob.id,
            mode: activeJob.mode,
            jobTitle: activeJob.job_title,
            headcount: activeJob.headcount,
            stage: activeJob.stage,
          }
        : null,
      pendingInvite: null,
      pendingPlan: null,
      candidates: [],
      actions: [],
      clientActions: [],
      handled: true,
      reply: `已记住你的长期招聘偏好：${preferenceCommand.instruction}\n之后的新招聘任务会自动带入；你可以说「清空招聘偏好」。`,
    };
  }
  const pendingPlan = pendingPlanFromJob(activeJob);
  const roster = activeJob ? await listCandidates(pool, activeJob.id) : [];
  const knownNames = roster.map((c) => c.name).filter(Boolean);
  const invitePlan = jobMeta(activeJob).invitePlan;
  const ruleClassified = classifyHrIntent(message, {
    loggedIn: Boolean(login?.loggedIn) || Boolean(login?.desktopDeferred),
    hasPendingInvite: Boolean(pendingInvite),
    hasPendingPlan: Boolean(pendingPlan),
    hasCandidates: Boolean(activeJob) && roster.length > 0,
    knownNames,
    hasInvitePlan: Boolean(invitePlan?.status === "awaiting_details"),
  });

  let classified = { ...ruleClassified, source: "rules" };
  // Hybrid: rules + LLM when oral / low-confidence / active funnel dialogue.
  if (
    needsLlmAssist(ruleClassified, {
      hasCandidates: roster.length > 0,
      message,
    })
  ) {
    const llm = await classifyHrIntentWithLlm(message, {
      knownNames,
      jobTitle: activeJob?.job_title || null,
      stage: activeJob?.stage || null,
      hasPendingInvite: Boolean(pendingInvite),
      hasPendingPlan: Boolean(pendingPlan),
      hasInvitePlan: Boolean(invitePlan?.status === "awaiting_details"),
      ruleIntent: ruleClassified.intent,
      ruleConfidence: ruleClassified.confidence,
      userId,
    });
    classified = mergeHrClassification(ruleClassified, llm);
    // Offline soft parse for multi-person different questions when LLM unavailable.
    if (!classified.hints?.perTargetQuestions?.length) {
      const soft = softParsePerTargetQuestions(message, knownNames);
      if (soft.length) {
        classified = {
          ...classified,
          intent:
            classified.intent === HR_INTENTS.SMALLTALK
              ? HR_INTENTS.ASK_CANDIDATES
              : classified.intent,
          hints: {
            ...classified.hints,
            perTargetQuestions: soft,
            targetNames: soft.map((x) => x.name),
            customQuestion: classified.hints?.customQuestion || null,
          },
          source: `${classified.source || "rules"}+soft`,
        };
      }
    }
  }

  const hints = classified.hints || extractJobHints(message);
  const longTermPreferences = preferencesText(preferences);
  // Prefer DB-resolved names when knownNames available.
  if (knownNames.length && hints.targetNames?.length) {
    const resolved = matchKnownNames(
      `${message} ${hints.targetNames.join(" ")}`,
      knownNames,
    );
    if (resolved.length) hints.targetNames = resolved;
  }
  if (!hints.perTargetQuestions?.length) {
    const soft = softParsePerTargetQuestions(message, knownNames);
    if (soft.length) hints.perTargetQuestions = soft;
  }

  const base = {
    sku: SKU,
    intent: classified.intent,
    confidence: classified.confidence,
    intentSource: classified.source || "rules",
    loggedIn: Boolean(login?.loggedIn),
    blocked: Boolean(login?.blocked),
    openLoginWizard: false,
    requireConfirm: false,
    job: activeJob
      ? {
          id: activeJob.id,
          mode: activeJob.mode,
          jobTitle: activeJob.job_title,
          headcount: activeJob.headcount,
          stage: activeJob.stage,
        }
      : null,
    pendingInvite: pendingInvite
      ? { id: pendingInvite.id, status: pendingInvite.status }
      : null,
    pendingPlan: pendingPlan
      ? {
          status: pendingPlan.status,
          summary: pendingPlan.summary || null,
        }
      : null,
    candidates: [],
    actions: [],
    clientActions: [],
  };

  if (classified.intent === HR_INTENTS.OPEN_BOSS) {
    return {
      ...base,
      handled: true,
      openLoginWizard: true,
      reply:
        "请在下方引导卡片点「打开 Boss 窗口」。桌面客户端会在你本机打开 Boss（走本机出口 IP），不会用服务器浏览器。登录后点「检验登录态」。",
    };
  }

  if (classified.intent === HR_INTENTS.CHECK_BOSS) {
    if (process.env.DEMO_HR_PIPELINE === "1") {
      return {
        ...base,
        handled: true,
        openLoginWizard: true,
        reply:
          "演示模式不会代开 Boss。请用桌面客户端点「打开 Boss 窗口」自行登录，再点「检验登录态」。",
      };
    }
    try {
      const status = await checkBossLoginStatus(null);
      return {
        ...base,
        handled: true,
        openLoginWizard: !status.loggedIn,
        loggedIn: Boolean(status.loggedIn),
        blocked: Boolean(status.blocked),
        reply:
          status.message ||
          status.instruction ||
          (status.loggedIn ? "Boss 登录态有效，可直接开展招聘。" : "尚未检测到有效 Boss 登录态。"),
      };
    } catch (err) {
      if (err?.code === "browser_node_required" || /browser_node_required/.test(String(err.message))) {
        return {
          ...base,
          handled: true,
          openLoginWizard: true,
          reply: "尚未连接本机浏览器。请用桌面客户端，并在下方引导完成 Boss 登录。",
        };
      }
      return {
        ...base,
        handled: true,
        openLoginWizard: true,
        reply: `检验登录态失败：${err.message}`,
      };
    }
  }

  if (classified.intent === HR_INTENTS.SMALLTALK) {
    // Hire-like oral misses must not fall through to Gateway (often down on product hosts).
    if (
      process.env.DEMO_HR_PIPELINE !== "1" &&
      /招|招聘|招人|找\s*\d|找\s*[一二两三四五六七八九十]|智能体|工程师|开发|岗位/.test(
        String(message || ""),
      )
    ) {
    return {
      ...base,
        handled: true,
        reply:
          "这句我按招聘理解了，但人数/岗位没认全。请再说清楚一点，例如：「招 3 个智能体开发工程师」或「招三个 Java 后端」。",
      };
    }
    // Unrecognized: prefer Gateway employee chat when available.
    if (process.env.DEMO_HR_PIPELINE !== "1") {
      return { ...base, handled: false, reply: null };
    }
    if (activeJob) {
      return {
        ...base,
        handled: true,
        reply: [
          "这条口语规则没命中，且 Gateway 大模型未接通（演示可离线跑漏斗）。",
          "已启用「规则 + 大模型」混合识别：Gateway 起来后模糊说法会自动交给模型补全。",
          "你也可以再说：",
          "· 「有谁回复了」/「张同学回复了」",
          "· 「问张同学有没有作品，问李同学期望薪资」",
          "· 「根据回复二次筛选」",
          "· 「只约张同学，明天下午3点线上面试」",
        ].join("\n"),
      };
    }
    return {
      ...base,
      handled: true,
      reply:
        "可以说「招 5 个某某岗位」开始。口语意图会走「规则+大模型」；Gateway 未启动时仅规则可用。",
    };
  }

  if (login?.blocked && process.env.DEMO_HR_PIPELINE !== "1") {
    return {
      ...base,
      handled: true,
      openLoginWizard: true,
      reply:
        login.message ||
        login.instruction ||
        "Boss 当前访问受限（IP 风控）。请换网络或等待解封后再继续招聘自动化。",
    };
  }

  if (
    !login?.loggedIn &&
    !login?.desktopDeferred &&
    process.env.DEMO_HR_PIPELINE !== "1" &&
    [
      HR_INTENTS.NEED_LOGIN,
      HR_INTENTS.INBOX,
      HR_INTENTS.SEARCH,
      HR_INTENTS.RUN_FUNNEL,
      HR_INTENTS.ASK_CANDIDATES,
      HR_INTENTS.CHECK_REPLIES,
      HR_INTENTS.SCREEN_ANSWERS,
      HR_INTENTS.FOLLOWUP_24H,
      HR_INTENTS.REQUEST_RESUME,
      HR_INTENTS.DOWNLOAD_RESUME,
      HR_INTENTS.AUTO_RECHAT,
      HR_INTENTS.AUTO_ADVANCE,
      HR_INTENTS.PREPARE_INVITE,
      HR_INTENTS.FILL_INVITE_DETAILS,
      HR_INTENTS.RANK,
      HR_INTENTS.SHORTLIST,
      HR_INTENTS.TALENT_POOL,
    ].includes(classified.intent)
  ) {
    return {
      ...base,
      handled: true,
      openLoginWizard: true,
      clientActions: [clientAction("open_boss_login", {})],
      reply:
        "要做招聘自动化，需要先有有效的 Boss 登录态。请你在本机桌面客户端打开 Boss 窗口（读取你已登录的账号），然后点「检验登录态」。我们不会代填手机号或验证码，也不会用服务器浏览器。登录通过后直接对话，例如「自动请求简历」「自动下载简历」「自动复聊：请问本周方便面试吗」。",
    };
  }

  // Desktop-deferred (unknown login): resume/rechat may emit clientActions; funnel needs a real probe first.
  if (
    login?.desktopDeferred &&
    !login?.desktopEmbedded &&
    [HR_INTENTS.REQUEST_RESUME, HR_INTENTS.DOWNLOAD_RESUME, HR_INTENTS.AUTO_RECHAT, HR_INTENTS.AUTO_ADVANCE, HR_INTENTS.ASK_CANDIDATES, HR_INTENTS.CHECK_REPLIES, HR_INTENTS.FOLLOWUP_24H, HR_INTENTS.SCREEN_ANSWERS, HR_INTENTS.PREPARE_INVITE, HR_INTENTS.FILL_INVITE_DETAILS].includes(
      classified.intent,
    )
  ) {
    // Fall through to intent handlers below (they emit clientActions).
  } else if (
    login?.desktopDeferred &&
    !login?.desktopEmbedded &&
    [HR_INTENTS.INBOX, HR_INTENTS.SEARCH, HR_INTENTS.RUN_FUNNEL, HR_INTENTS.RANK, HR_INTENTS.SHORTLIST].includes(
      classified.intent,
    )
  ) {
    return {
      ...base,
      handled: true,
      openLoginWizard: true,
      clientActions: [clientAction("open_boss_login", {})],
      reply:
        "筛投递/搜人需要先在桌面客户端完成 Boss 登录检验（点「Boss 登录」→「检验登录态」）。通过后再说「招 N 个某某岗位」。",
    };
  }

  if (classified.intent === HR_INTENTS.CONFIRM_INVITE) {
    const result = await confirmInviteBatch(pool, userId);
    return {
      ...base,
      handled: true,
      requireConfirm: false,
      pendingInvite: null,
      clientActions: result.clientActions || [],
      reply: result.message,
    };
  }
  if (classified.intent === HR_INTENTS.CANCEL_INVITE) {
    const result = await cancelInviteBatch(pool, userId);
    return {
      ...base,
      handled: true,
      requireConfirm: false,
      pendingInvite: null,
      reply: result.message,
    };
  }

  if (classified.intent === HR_INTENTS.CONFIRM_PLAN) {
    const job = activeJob || (await getActiveJob(pool, userId));
    const plan = pendingPlanFromJob(job);
    if (!job || !plan) {
      return {
        ...base,
        handled: true,
        requireConfirm: false,
        pendingPlan: null,
        reply: "当前没有待确认的招聘计划。可以说「招 3 个 AI 开发，长沙，熟练 LangChain」。",
      };
    }
    const actions = Array.isArray(plan.clientActions) ? plan.clientActions : [];
    await saveJobMeta(pool, job.id, { pendingPlan: null });
    const summary = plan.summary || {};
    return {
      ...base,
      handled: true,
      requireConfirm: false,
      pendingPlan: null,
      loggedIn: true,
      openLoginWizard: false,
      job: {
        id: job.id,
        mode: job.mode,
        jobTitle: job.job_title,
        headcount: job.headcount,
        stage: job.stage,
      },
      clientActions: actions,
      reply: [
        `已确认。正在本机 Boss 执行：招 ${summary.headcount || job.headcount || 5} 个「${summary.jobTitle || job.job_title}」`,
        summary.city ? `城市：${summary.city}` : null,
        summary.requirements ? `要求：${summary.requirements}` : null,
        actions.length ? "开始拉取沟通候选人并做 JD 初筛…" : "计划内暂无本机动作。",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  if (classified.intent === HR_INTENTS.CANCEL_PLAN) {
    const job = activeJob || (await getActiveJob(pool, userId));
    if (!job || !pendingPlanFromJob(job)) {
      return {
        ...base,
        handled: true,
        requireConfirm: false,
        pendingPlan: null,
        reply: "没有待取消的招聘计划。",
      };
    }
    await saveJobMeta(pool, job.id, { pendingPlan: null });
    return {
      ...base,
      handled: true,
      requireConfirm: false,
      pendingPlan: null,
      reply: "已取消本次招聘执行。需要时再说一句招聘需求即可。",
    };
  }

  if (classified.intent === HR_INTENTS.STATUS) {
    const cands = activeJob ? roster : [];
    const buckets = summarizeFunnelBuckets(cands);
    const due = pickFollowupDue(cands);
    const { replied, waiting } = collectRepliedCandidates(cands);
    const plan = invitePlan;
    return {
      ...base,
      handled: true,
      candidates: cands,
      reply: activeJob
        ? [
            `当前漏斗：${activeJob.mode === "search" ? "主动搜人" : "筛选投递"}｜岗位 ${activeJob.job_title}｜目标 ${activeJob.headcount || "-"} 人`,
            `阶段：${activeJob.stage}｜池内 ${buckets.total}｜≥${FUNNEL.ADVANCE_AT}%待打招呼 ${buckets.greet}｜可下简历 ${buckets.resume}｜可约面 ${buckets.invite}｜不合适 ${buckets.reject}`,
            replied.length
              ? `🔔 已有回复 ${replied.length} 人：${replied.map((c) => c.name).join("、")}（可说「有谁回复了」看摘要，或继续追问/二次筛选）`
              : waiting.length
                ? `⏳ 等待回复 ${waiting.length} 人（说「有谁回复了」可刷新）`
                : "暂无待回复会话",
            due.length ? `24h未回复待趣味复聊：${due.length} 人` : null,
            plan?.status === "awaiting_details"
              ? `约面草稿待补全：${(plan.targetNames || []).join("、")}（请补时间/线上线下/地点）`
              : null,
            `待确认邀约：${pendingInvite ? "有" : "无"}`,
            pendingPlan
              ? `待确认招聘计划：招 ${pendingPlan.summary?.headcount || activeJob.headcount} 个「${pendingPlan.summary?.jobTitle || activeJob.job_title}」（回复「确认执行」）`
              : null,
            ...formatCandidateLines(cands, 8),
          ]
            .filter(Boolean)
            .join("\n")
        : "还没有进行中的招聘任务。可以说「招 3 个 AI 开发，长沙，熟练 LangChain」——我会先复述意图请你确认，再在本机 Boss 执行。",
    };
  }

  if (
    classified.intent === HR_INTENTS.RUN_FUNNEL ||
    classified.intent === HR_INTENTS.INBOX ||
    classified.intent === HR_INTENTS.SEARCH
  ) {
    const jobTitle = hints.jobTitle || activeJob?.job_title || "";
    if (!jobTitle || /^(?:问|请问)|有没有|同学|可以展示/.test(jobTitle) || jobTitle.length > 30) {
      return {
        ...base,
        handled: true,
        reply:
          classified.intent === HR_INTENTS.SEARCH
            ? "好的，走【主动搜人】。请告诉我岗位名称，例如「帮我搜 Java 后端，招 5 个人」。"
            : /^(?:问|请问)/.test(String(message || ""))
              ? "这句我理解成在问候选人，但当前还没有可问的名单。请先说「招 N 个某某岗位」初筛，再说「问张同学：…」。"
              : "好的。请用一句话说清招聘意图，例如「招 3 个 AI 开发，长沙，熟练 LangChain」。我会先复述确认，再在本机执行。",
      };
    }
    const job = await upsertJob(pool, userId, {
      mode: classified.intent === HR_INTENTS.SEARCH ? "search" : "inbox",
      jobTitle,
      headcount: hints.headcount || activeJob?.headcount || 5,
      todayOnly:
        typeof hints.todayOnly === "boolean" && /今天|今日|当日|全部|所有/.test(String(message || ""))
          ? hints.todayOnly
          : classified.intent !== HR_INTENTS.SEARCH,
      notes: [longTermPreferences, String(message || "").slice(0, 500)].filter(Boolean).join("；"),
    });

    // Desktop Electron: propose plan → user confirm → then scrape locally (never auto-fire skills).
    if ((login?.desktopEmbedded || desktopClient) && process.env.DEMO_HR_PIPELINE !== "1") {
      if (!login?.loggedIn && !clientBossLoggedIn) {
        return {
          ...base,
          handled: true,
          openLoginWizard: true,
          clientActions: [clientAction("open_boss_login", {})],
          reply: "请先在本机 Boss 窗口登录并点「检验登录态」，再发起招聘。",
        };
      }
      const draftActions = [draftScrapeInboxAction(job)];
      const summary = {
        jobTitle: job.job_title,
        headcount: job.headcount || 5,
        city: hints.city || null,
        requirements:
          [hints.requirements, longTermPreferences].filter(Boolean).join("；") || null,
        mode: job.mode,
            todayOnly: Boolean(job.today_only),
      };
      await saveJobMeta(pool, job.id, {
        pendingPlan: {
          status: "awaiting_confirm",
          createdAt: new Date().toISOString(),
          summary,
          clientActions: draftActions,
          originalMessage: String(message || "").slice(0, 500),
        },
      });
      return {
        ...base,
        handled: true,
        openLoginWizard: false,
        loggedIn: true,
        requireConfirm: true,
        job: {
          id: job.id,
          mode: job.mode,
          jobTitle: job.job_title,
          headcount: job.headcount,
          stage: job.stage,
        },
        pendingPlan: { status: "awaiting_confirm", summary },
        clientActions: [],
        reply: buildHirePlanReply(job, hints, draftActions),
      };
    }

    const pulled = await pullBossInboxCandidates({
            jobTitle,
      todayOnly: Boolean(job.today_only),
          });

    if (!pulled.ok && !pulled.candidates?.length) {
      if (pulled.blocked) {
        await pool.query(`UPDATE hr_jobs SET blocked = 1, stage = 'blocked' WHERE id = ?`, [job.id]);
        return {
          ...base,
          handled: true,
          openLoginWizard: true,
          blocked: true,
          reply: pulled.message || "Boss 访问受限，暂时无法拉投递列表。",
        };
      }
      if (!pulled.loggedIn) {
        return {
          ...base,
          handled: true,
          openLoginWizard: true,
          reply: pulled.message || "请先登录 Boss。",
        };
      }
      return {
        ...base,
        handled: true,
        job: { id: job.id, mode: job.mode, jobTitle: job.job_title, headcount: job.headcount, stage: job.stage },
        reply: pulled.message || "暂未拉到候选人，请稍后重试。",
      };
    }

    const ranked = await replaceCandidates(pool, userId, job, pulled);
    return {
      ...base,
      handled: true,
      job: {
        id: job.id,
        mode: job.mode,
        jobTitle: job.job_title,
        headcount: job.headcount,
        stage: "jd_screened",
      },
      candidates: ranked,
      actions: [
        { id: "ask_candidates", label: `向≥${FUNNEL.ADVANCE_AT}%候选人打招呼提问` },
        { id: "screen_answers", label: "根据回复二次筛选" },
        { id: "followup_24h", label: "24h未回复趣味复聊" },
      ],
      reply: buildJdScreenReply(job, ranked, {
        modeLabel:
          classified.intent === HR_INTENTS.SEARCH
            ? "主动搜人"
            : pulled.demo
              ? "演示池"
              : "筛选投递",
        demo: Boolean(pulled.demo),
      }),
    };
  }

  if (classified.intent === HR_INTENTS.RANK || classified.intent === HR_INTENTS.SHORTLIST) {
    if (!activeJob) {
      return {
        ...base,
        handled: true,
        reply: "还没有候选人数据。先说「招 5 个某某岗位」或「帮我筛今天投递」。",
      };
    }
    const cands = await listCandidates(pool, activeJob.id);
    const rescored = [];
    for (const c of cands) {
      const score = scoreCandidate(
        {
          name: c.name,
          title: c.title,
          experience: c.experience,
          education: c.education,
          chat_excerpt: c.chat_excerpt,
        },
        activeJob.job_title,
        `${activeJob.notes || ""}\n${message}`,
      );
      const verdict = verdictFromMatchScore(score);
      const meta = buildCandidateMeta(c.meta, {
        funnelStage: verdict === VERDICT.REJECT ? FUNNEL_STAGE.REJECTED : FUNNEL_STAGE.JD_SCREENED,
        matchScore: score,
      });
      await pool.query(
        `UPDATE hr_candidates SET score = ?, verdict = ?, reason = ?, meta = ? WHERE id = ?`,
        [score, verdict, reasonForMatchVerdict(verdict, score), JSON.stringify(meta), c.id],
      );
      rescored.push({ ...c, score, verdict, meta });
    }
    rescored.sort((a, b) => b.score - a.score);
    const buckets = summarizeFunnelBuckets(rescored);
    return {
      ...base,
      handled: true,
      candidates: rescored,
      reply: [
        `已按最新 JD/偏好重做初筛（阈值 ${FUNNEL.REJECT_BELOW}% / ${FUNNEL.ADVANCE_AT}%）：`,
        `待打招呼 ${buckets.greet}｜待观察 ${buckets.maybe}｜不合适 ${buckets.reject}`,
        ...formatCandidateLines(rescored, 10),
        "",
        "下一步：「打招呼提问」→「根据回复二次筛选」。",
      ].join("\n"),
    };
  }

  if (classified.intent === HR_INTENTS.AUTO_ADVANCE) {
    if (!activeJob) {
      return {
        ...base,
        handled: true,
        reply: "还没有进行中的招聘任务。先说「招 N 个某某岗位」。",
      };
    }
    const candidates = await listCandidates(pool, activeJob.id);
    if (!candidates.length) {
      return {
        ...base,
        handled: true,
        clientActions: [draftScrapeInboxAction(activeJob)],
        reply: "当前任务还没有候选人，先从本机 Boss 沟通列表拉取并初筛。",
      };
    }
    const plan = buildAutoAdvancePlan(candidates, activeJob);
    const actions = plan.actions;
    const nowIso = new Date().toISOString();
    for (const action of actions.filter((item) => item.type === "auto_rechat")) {
      const name = action.params?.names?.[0];
      const candidate = candidates.find((item) => item.name === name);
      if (!candidate || action.params?.nextAction !== "greet") continue;
      const meta = buildCandidateMeta(candidate.meta, {
        funnelStage: FUNNEL_STAGE.GREET_SENT,
        greetedAt: parseMeta(candidate.meta).greetedAt || nowIso,
        lastAskedAt: nowIso,
        screenQuestions: String(action.params.message || "").split("\n").filter(Boolean),
        awaitingReply: true,
      });
      await pool.query(`UPDATE hr_candidates SET ask_status = 'queued', meta = ? WHERE id = ? AND user_id = ?`, [
        JSON.stringify(meta),
        candidate.id,
        userId,
      ]);
    }
    await saveJobMeta(pool, activeJob.id, {
      autoAdvance: {
        runId: plan.runId,
        status: actions.length ? "dispatching" : "idle",
        counts: plan.counts,
        startedAt: nowIso,
        completedActions: 0,
        totalActions: actions.length,
      },
    });
    return {
      ...base,
      handled: true,
      intent: HR_INTENTS.AUTO_ADVANCE,
      job: {
        id: activeJob.id,
        mode: activeJob.mode,
        jobTitle: activeJob.job_title,
        headcount: activeJob.headcount,
        stage: activeJob.stage,
      },
      candidates,
      clientActions: actions,
      actions: [
        { id: "auto_advance", label: "继续自动推进" },
        { id: "status", label: "查看招聘进度" },
      ],
      reply: [
        "【自动推进招呼进度】已按候选人当前状态生成下一步：",
        `待初次招呼 ${plan.counts.greet} 人｜待检查回复 ${plan.counts.inspectReplies} 人｜待二筛 ${plan.counts.screenAnswers} 人`,
        `待请求简历 ${plan.counts.requestResume} 人｜待下载简历 ${plan.counts.downloadResume} 人｜需人工目视 ${plan.counts.manualReview} 人`,
        actions.length
          ? `\n本轮共 ${actions.length} 个本机动作；逐项执行并回写，失败后可再次说「继续自动推进」断点续跑。`
          : "\n当前没有可安全自动推进的动作。面试邀约仍需你确认后才能发送。",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  if (classified.intent === HR_INTENTS.ASK_CANDIDATES) {
    if (!activeJob) {
      return {
        ...base,
        handled: true,
        reply: "还没有候选人。先走漏斗初筛：「招 N 个岗位」或「筛今天投递」。",
      };
    }
    const cands = await listCandidates(pool, activeJob.id);
    const perTarget = Array.isArray(hints.perTargetQuestions) ? hints.perTargetQuestions : [];
    const named = resolveTargetCandidates(
      cands,
      perTarget.length ? perTarget.map((x) => x.name) : hints.targetNames,
    );
    let targets;
    if (named) {
      if (!named.length) {
        return {
          ...base,
          handled: true,
          reply: `没有匹配到你说的人（${(hints.targetNames || []).join("、") || "未识别姓名"}）。当前名单：${cands.map((c) => c.name).join("、") || "空"}。可以说「问张同学：期望薪资？」`,
        };
      }
      // Explicit employer pin: allow named people even if they were filtered out of shortlist / rejected by auto-rank.
      targets = named.slice();
      for (const c of targets) {
        if (c.verdict === VERDICT.REJECT) {
          const meta = buildCandidateMeta(c.meta, {
            shortlisted: true,
            funnelStage: FUNNEL_STAGE.GREET_SENT,
            pinnedByEmployer: true,
          });
          await pool.query(`UPDATE hr_candidates SET verdict = ?, meta = ?, reason = ? WHERE id = ?`, [
            VERDICT.GREET,
            JSON.stringify(meta),
            "雇主点名指定，恢复可提问",
            c.id,
          ]);
          c.verdict = VERDICT.GREET;
          c.meta = meta;
        } else {
          const meta = buildCandidateMeta(c.meta, {
            shortlisted: true,
            pinnedByEmployer: true,
          });
          await pool.query(`UPDATE hr_candidates SET meta = ? WHERE id = ?`, [JSON.stringify(meta), c.id]);
          c.meta = meta;
        }
      }
    } else {
      const shortlisted = cands
        .filter((c) => parseMeta(c.meta).shortlisted && c.verdict !== VERDICT.REJECT)
        .sort(
          (a, b) =>
            (parseMeta(a.meta).shortlistRank || 99) - (parseMeta(b.meta).shortlistRank || 99),
        );
      targets = shortlisted.length
        ? shortlisted.slice(0, Math.max(1, activeJob.headcount || 5))
        : cands
            .filter(
              (c) =>
                c.verdict === VERDICT.GREET ||
                c.verdict === VERDICT.MAYBE ||
                c.verdict === VERDICT.RESUME ||
                parseMeta(c.meta).funnelStage === FUNNEL_STAGE.GREET_SENT ||
                parseMeta(c.meta).funnelStage === FUNNEL_STAGE.PORTFOLIO_REVIEW ||
                parseMeta(c.meta).funnelStage === FUNNEL_STAGE.ANSWER_SCORED,
            )
            .slice(0, Math.max(1, activeJob.headcount || 5));
    }
    if (!targets.length) {
      return {
        ...base,
        handled: true,
        reply: "没有可提问的对象。先初筛出≥80%人选，或不合适的人不能再问。",
      };
    }

    const questionByName = new Map();
    for (const row of perTarget) {
      const hit = targets.find(
        (c) => c.name === row.name || c.name.includes(row.name) || row.name.includes(c.name),
      );
      if (hit) questionByName.set(hit.id, row.question);
    }

    const customFromHint = String(hints.customQuestion || "").trim();
    const customQ = customFromHint
      ? customFromHint
      : String(message || "")
          .replace(
            /^.*?(?:问(?:一下|他们|候选人)?|追问|聊聊|发消息问?|打招呼(?:提问)?|基础提问|岗位提问)[：:\s]*/i,
            "",
          )
          .replace(/^问\s*[^\s：:]{1,12}\s*[：:]/, "")
        .replace(/^他们[：:\s]*/, "")
          .trim();
    const defaultQs =
      customQ && customQ.length >= 4 && !/^(提问|一下|他们)$/.test(customQ)
        ? [customQ]
        : defaultScreenQuestions(activeJob.job_title, activeJob.notes);
    const defaultSend = defaultQs.join("\n");

    const isFollowup = targets.some((c) => {
      const st = parseMeta(c.meta).funnelStage;
      return (
        st === FUNNEL_STAGE.GREET_SENT ||
        st === FUNNEL_STAGE.ANSWER_SCORED ||
        st === FUNNEL_STAGE.PORTFOLIO_REVIEW ||
        detectCandidateReply(c.chat_excerpt).replied
      );
    });
    const nowIso = new Date().toISOString();
    const tag = isFollowup ? "追问" : "打招呼提问";
    const sentLines = [];
    const clientActions = [];

    for (const c of targets) {
      const sendText = questionByName.get(c.id) || defaultSend;
      const questions = sendText.split("\n").filter(Boolean);
      const prevQs = parseMeta(c.meta).screenQuestions || [];
      const meta = buildCandidateMeta(c.meta, {
        funnelStage: FUNNEL_STAGE.GREET_SENT,
        greetedAt: parseMeta(c.meta).greetedAt || nowIso,
        lastAskedAt: nowIso,
        screenQuestions: [...prevQs, ...questions].slice(-12),
        awaitingReply: true,
        replyNotifiedAt: null,
      });
      await pool.query(
        `UPDATE hr_candidates SET ask_status = 'queued', chat_excerpt = CONCAT(COALESCE(chat_excerpt,''), ?), meta = ? WHERE id = ?`,
        [`\n[${tag}] ${sendText}`, JSON.stringify(meta), c.id],
      );
      sentLines.push(`- ${c.name}：${sendText}`);
      clientActions.push(
        clientAction("auto_rechat", {
          message: sendText,
          limit: 1,
          names: [c.name],
        }),
      );
    }

    await pool.query(`UPDATE hr_jobs SET stage = ? WHERE id = ?`, [
      isFollowup ? "followup_ask" : "greet_ask",
      activeJob.id,
    ]);
    const mixed = questionByName.size > 0;
    if (hints.alsoRequestResume) {
      clientActions.unshift(
        clientAction("request_resumes", {
          limit: targets.length,
          names: targets.map((c) => c.name),
        }),
      );
    }
    return {
      ...base,
      handled: true,
      candidates: targets,
      clientActions,
      reply: [
        hints.alsoRequestResume
          ? `【定向】已编排：对 ${targets.map((c) => c.name).join("、")} 请求简历，并准备发送提问（本机执行后会回报是否真发出）：`
          : mixed
            ? `【${isFollowup ? "定向追问" : "定向提问"}·一人一题】已编排本机发送（识别来源：${classified.source || "rules"}）：`
            : named
              ? `【${isFollowup ? "定向追问" : "定向提问"}】已编排只发给 ${targets.map((c) => c.name).join("、")}（本机执行后会回报是否真发出）：`
              : `【漏斗第2步】已编排对 ${targets.length} 位候选人${isFollowup ? "追问" : "打招呼+基础提问"}（本机 Boss 执行）：`,
        ...sentLines,
        "",
        "不同人可问不同题：例如「向高佳伟请求简历，并询问期望薪资」。",
        "以上为编排指令：真正是否发出，以本机 Boss 窗口回执为准（会核对是否点到发送/会话是否出现文案）。",
        "🔔 也可说「有谁回复了」或「张同学回复了」。",
        "收到回复后：可继续追问，或说「根据回复二次筛选」。",
        `若 ${FUNNEL.FOLLOWUP_HOURS} 小时未回复，可说「趣味复聊」。`,
      ].join("\n"),
    };
  }

  if (classified.intent === HR_INTENTS.CHECK_REPLIES) {
    if (!activeJob) {
      return {
        ...base,
        handled: true,
        reply: "还没有招聘任务。先说「招 N 个某某岗位」。",
      };
    }
    const cands = await listCandidates(pool, activeJob.id);
    const { replied, waiting } = collectRepliedCandidates(cands);
    const named = resolveTargetCandidates(cands, hints.targetNames);
    const focusReplied = named?.length
      ? replied.filter((c) => named.some((n) => n.id === c.id))
      : replied;
    const focusWaiting = named?.length
      ? waiting.filter((c) => named.some((n) => n.id === c.id))
      : waiting;
    const focusMissing = named?.length
      ? named.filter(
          (c) =>
            !focusReplied.some((r) => r.id === c.id) && !focusWaiting.some((w) => w.id === c.id),
        )
      : [];
    const nowIso = new Date().toISOString();
    for (const c of focusReplied) {
      const meta = buildCandidateMeta(c.meta, {
        repliedAt: parseMeta(c.meta).repliedAt || nowIso,
        replyNotifiedAt: nowIso,
        awaitingReply: false,
      });
      await pool.query(`UPDATE hr_candidates SET meta = ? WHERE id = ?`, [
        JSON.stringify(meta),
        c.id,
      ]);
    }
    const who = named?.length ? named.map((c) => c.name).join("、") : null;
    return {
      ...base,
      handled: true,
      candidates: focusReplied.length ? focusReplied : named || replied,
      actions: focusReplied.length
        ? [
            { id: "screen_answers", label: "根据回复二次筛选" },
            { id: "ask_candidates", label: "继续追问" },
          ]
        : [],
      clientActions:
        process.env.DEMO_HR_PIPELINE === "1"
          ? []
          : [
              clientAction("check_inbox_replies", {
                limit: Math.max(8, cands.length || 5),
                names: (named?.length ? named : focusReplied.length ? focusReplied : cands)
                  .filter((c) => c.verdict !== VERDICT.REJECT)
                  .map((c) => c.name)
                  .slice(0, 10),
                jobId: activeJob.id,
              }),
            ],
      reply: focusReplied.length
        ? [
            who
              ? `🔔【回复通知】你问的 ${who}：已有回复${process.env.DEMO_HR_PIPELINE === "1" ? "（演示数据）" : ""}：`
              : `🔔【回复通知】共 ${focusReplied.length} 人有新回复${process.env.DEMO_HR_PIPELINE === "1" ? "（演示数据）" : ""}：`,
            ...focusReplied.map(
              (c) =>
                `- ${c.name}｜形态：${c.replyModality}${c.needsHrReview ? "｜⚠建议人事目视" : ""}｜摘要：${c.replyPreview || "（见 Boss 会话）"}`,
            ),
            focusWaiting.length ? `仍在等待：${focusWaiting.map((c) => c.name).join("、")}` : null,
            "",
            process.env.DEMO_HR_PIPELINE === "1"
              ? "演示模式：不会本机求简历/下载。"
              : "本机将核对会话并把真实回复回写。确认回复后请先执行「根据回复二次筛选」；只有答复评分达到 80% 才会进入请求简历。",
            "也可：「根据回复二次筛选」或继续追问。",
          ]
            .filter(Boolean)
            .join("\n")
        : named?.length
          ? [
              `你问的 ${who}：目前还没有检测到新回复。`,
              focusWaiting.length
                ? `仍在等待：${focusWaiting.map((c) => c.name).join("、")}`
                : focusMissing.length
                  ? `尚未进入「已提问等回复」状态：${focusMissing.map((c) => c.name).join("、")}（可先对他们提问）`
                  : null,
              `也可说「有谁回复了」看全员，或稍后再问「${named[0].name}回复了吗」。`,
            ]
              .filter(Boolean)
              .join("\n")
          : waiting.length
            ? [
                `暂无新回复。仍在等待 ${waiting.length} 人：${waiting.map((c) => c.name).join("、")}`,
                `可稍后再说「有谁回复了」或「张同学回复了吗」。`,
              ].join("\n")
            : "当前没有等待回复的会话。可先「打招呼提问」或「问张同学：…」。",
    };
  }

  if (classified.intent === HR_INTENTS.SCREEN_ANSWERS) {
    if (!activeJob) {
      return {
        ...base,
        handled: true,
        reply: "还没有候选人。先初筛并打招呼提问。",
      };
    }
    const cands = await listCandidates(pool, activeJob.id);
    const targets = cands.filter(
      (c) =>
        c.verdict === VERDICT.GREET ||
        c.verdict === VERDICT.MAYBE ||
        parseMeta(c.meta).funnelStage === FUNNEL_STAGE.GREET_SENT ||
        parseMeta(c.meta).funnelStage === FUNNEL_STAGE.FOLLOWUP_SENT,
    );
    if (!targets.length) {
      return {
        ...base,
        handled: true,
        reply: "没有待二次筛选的人。请先对≥80%人选「打招呼提问」。",
      };
    }
    const rescored = [];
    const hrReviewList = [];
    for (const c of targets) {
      const scored = scoreAnswerExcerpt(
        c.chat_excerpt,
        activeJob.job_title,
        `${activeJob.notes || ""}\n${message}`,
      );
      const answerScore = typeof scored === "number" ? scored : scored.score;
      const needsHrReview = Boolean(scored?.needsHrReview);
      const replyModality = scored?.summary || "文字";
      const verdict = verdictFromAnswerScore(answerScore, { needsHrReview });
      const meta = buildCandidateMeta(c.meta, {
        funnelStage:
          verdict === VERDICT.REJECT
            ? FUNNEL_STAGE.REJECTED
            : needsHrReview
              ? FUNNEL_STAGE.PORTFOLIO_REVIEW
              : FUNNEL_STAGE.ANSWER_SCORED,
        answerScore,
        needsHrReview,
        replyModality,
        replyModalities: scored?.modalities || ["text"],
        repliedAt: answerScore > 0 ? new Date().toISOString() : parseMeta(c.meta).repliedAt || null,
      });
      const reason = reasonForAnswerVerdict(verdict, answerScore, {
        needsHrReview,
        summary: replyModality,
      });
      await pool.query(
        `UPDATE hr_candidates SET verdict = ?, reason = ?, meta = ? WHERE id = ?`,
        [verdict, reason, JSON.stringify(meta), c.id],
      );
      const row = { ...c, verdict, meta, score: c.score, reason };
      rescored.push(row);
      if (needsHrReview && verdict !== VERDICT.REJECT) hrReviewList.push(row);
    }
    const pass = rescored.filter((c) => c.verdict === VERDICT.RESUME);
    await pool.query(`UPDATE hr_jobs SET stage = 'answer_screened', summary = ? WHERE id = ?`, [
      `二次筛：可下简历 ${pass.length}｜待人事目视 ${hrReviewList.length} / ${rescored.length}`,
      activeJob.id,
    ]);
    return {
      ...base,
      handled: true,
      candidates: rescored,
      clientActions: pass.length
        ? [
            clientAction("request_resumes", {
              limit: pass.length,
              names: pass.map((c) => c.name),
            }),
          ]
        : [],
      actions: [
        ...(pass.length
          ? [
              { id: "request_resume", label: "请求简历" },
              { id: "download_resume", label: "下载简历到桌面" },
              { id: "prepare_invite", label: "约面试（需确认）" },
            ]
          : []),
      ],
      reply: [
        `【漏斗第3步】二次筛选（机器分仅供参考；阈值 ${FUNNEL.REJECT_BELOW}% / ${FUNNEL.ADVANCE_AT}%）：`,
        ...formatCandidateLines(rescored, 10),
        "",
        hrReviewList.length
          ? [
              `⚠ 以下 ${hrReviewList.length} 人回复含【图片/视频/网站】，请人事打开材料自己确认后再推进：`,
              ...hrReviewList.map(
                (c) =>
                  `- ${c.name}｜回复形态：${parseMeta(c.meta).replyModality}｜机器分 ${parseMeta(c.meta).answerScore}%（未自动放行）`,
              ),
              "确认合适后可再说「约面试」；机器筛选不能替代你目视作品集。",
            ].join("\n")
          : null,
        pass.length
          ? `文字回复达标≥${FUNNEL.ADVANCE_AT}% 共 ${pass.length} 人 → 已下发本机「请求简历 → 下载到桌面」。完成后可说「约面试」或「只约张同学，明天下午3点线上面试」。`
          : !hrReviewList.length
            ? `本批无人自动达标。可「问某人：…」补问后重试二次筛选。`
            : "含多媒体回复的候选人需人事确认后，再说「只约某人」+时间+线上/线下。",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  if (classified.intent === HR_INTENTS.FOLLOWUP_24H) {
    if (!activeJob) {
      return {
        ...base,
        handled: true,
        reply: "还没有任务。先初筛并打招呼。",
      };
    }
    const cands = await listCandidates(pool, activeJob.id);
    let due = pickFollowupDue(cands);
    if (!due.length) {
      due = cands.filter((c) => {
        const meta = parseMeta(c.meta);
        return (
          meta.funnelStage === FUNNEL_STAGE.GREET_SENT &&
          !meta.repliedAt &&
          c.verdict !== VERDICT.REJECT
        );
      });
    }
    if (!due.length) {
      return {
        ...base,
        handled: true,
        reply: `当前没有「已打招呼且未回复」的候选人。打招呼后满 ${FUNNEL.FOLLOWUP_HOURS} 小时会进入趣味复聊队列。`,
      };
    }
    const draft = funFollowupMessage(activeJob.job_title);
    const nowIso = new Date().toISOString();
    for (const c of due) {
      const meta = buildCandidateMeta(c.meta, {
        funnelStage: FUNNEL_STAGE.FOLLOWUP_SENT,
        followupAt: nowIso,
      });
      await pool.query(
        `UPDATE hr_candidates SET ask_status = 'followup_queued', chat_excerpt = CONCAT(COALESCE(chat_excerpt,''), ?), meta = ? WHERE id = ?`,
        [`\n[趣味复聊] ${draft}`, JSON.stringify(meta), c.id],
      );
    }
    return {
      ...base,
      handled: true,
      candidates: due,
      clientActions: [
        clientAction("auto_rechat", {
          message: draft,
          limit: due.length,
          names: due.map((c) => c.name),
        }),
      ],
      reply: [
        `【漏斗·24h复聊】已对 ${due.length} 位未回复合适人选下发趣味性复聊（本机）：`,
        draft,
        ...due.map((c) => `- ${c.name}`),
        "",
        "有回复后说「根据回复二次筛选」。",
      ].join("\n"),
    };
  }

  if (classified.intent === HR_INTENTS.REQUEST_RESUME) {
    const cands = activeJob ? await listCandidates(pool, activeJob.id) : [];
    const named = resolveTargetCandidates(cands, hints.targetNames);
    let targets;
    if (named) {
      if (!named.length) {
        return {
          ...base,
          handled: true,
          reply: `没有匹配到你说的人（${(hints.targetNames || []).join("、") || "未识别姓名"}）。当前名单：${cands.map((c) => c.name).join("、") || "空"}。可以说「向高佳伟请求简历」。`,
        };
      }
      targets = named.slice();
      for (const c of targets) {
        if (c.verdict === VERDICT.REJECT) {
          const meta = buildCandidateMeta(c.meta, {
            shortlisted: true,
            pinnedByEmployer: true,
            funnelStage: FUNNEL_STAGE.RESUME_REQUESTED,
          });
          await pool.query(`UPDATE hr_candidates SET verdict = ?, meta = ?, reason = ? WHERE id = ?`, [
            VERDICT.GREET,
            JSON.stringify(meta),
            "雇主点名指定，恢复可求简历",
            c.id,
          ]);
          c.verdict = VERDICT.GREET;
          c.meta = meta;
        }
      }
    } else {
      const shortlisted = cands.filter((c) => parseMeta(c.meta).shortlisted);
      targets = (
        shortlisted.length
          ? shortlisted
          : cands.filter((c) => c.verdict === VERDICT.RESUME || c.verdict === VERDICT.GREET)
      ).slice(0, Math.max(1, activeJob?.headcount || 5));
    }
    if (!named) {
      targets = targets.filter((c) => {
        const stage = parseMeta(c.meta).funnelStage;
        return c.verdict === VERDICT.RESUME || stage === FUNNEL_STAGE.ANSWER_SCORED;
      });
    }
    if (!targets.length) {
      return {
        ...base,
        handled: true,
        candidates: [],
        clientActions: [],
        reply:
          "当前没有通过二筛的候选人可请求简历。请先检查回复并执行「根据回复二次筛选」；只有答复评分达到 80% 才进入此步骤。",
      };
    }
    for (const c of targets) {
      const meta = buildCandidateMeta(c.meta, { funnelStage: FUNNEL_STAGE.RESUME_REQUESTED });
      await pool.query(`UPDATE hr_candidates SET meta = ? WHERE id = ?`, [JSON.stringify(meta), c.id]);
    }
    return {
      ...base,
      handled: true,
      candidates: targets,
      clientActions: [
        clientAction("request_resumes", {
          limit: targets.length || 5,
          names: targets.map((c) => c.name),
        }),
      ],
      actions: [{ id: "request_resume", label: "本机自动请求简历" }],
      reply: [
        targets.length
          ? named
            ? `【定向】仅对 ${targets.map((c) => c.name).join("、")} 请求附件简历（本机 Boss）：\n${formatCandidateLines(targets, targets.length).join("\n")}`
            : `【漏斗】对择优名单 ${targets.length} 人请求附件简历（本机 Boss）：\n${formatCandidateLines(targets, targets.length).join("\n")}`
          : "已下发【自动请求简历】到本机 Boss（沟通列表）。建议先完成初筛择优，再请求。",
        "全程本机执行；服务端不持有 Boss Cookie。",
      ].join("\n"),
    };
  }

  if (classified.intent === HR_INTENTS.DOWNLOAD_RESUME) {
    const cands = activeJob ? await listCandidates(pool, activeJob.id) : [];
    const named = resolveTargetCandidates(cands, hints.targetNames);
    let targets;
    if (named) {
      if (!named.length) {
        return {
          ...base,
          handled: true,
          reply: `没有匹配到你说的人（${(hints.targetNames || []).join("、") || "未识别姓名"}）。当前名单：${cands.map((c) => c.name).join("、") || "空"}。`,
        };
      }
      targets = named.slice();
      for (const c of targets) {
        if (c.verdict === VERDICT.REJECT) {
          const meta = buildCandidateMeta(c.meta, {
            shortlisted: true,
            pinnedByEmployer: true,
            funnelStage: FUNNEL_STAGE.RESUME_REQUESTED,
          });
          await pool.query(`UPDATE hr_candidates SET verdict = ?, meta = ?, reason = ? WHERE id = ?`, [
            VERDICT.RESUME,
            JSON.stringify(meta),
            "雇主点名指定，恢复可下载简历",
            c.id,
          ]);
          c.verdict = VERDICT.RESUME;
          c.meta = meta;
        }
      }
    } else {
      const shortlisted = cands.filter((c) => parseMeta(c.meta).shortlisted);
      targets = (
        shortlisted.length
          ? shortlisted
          : cands.filter(
              (c) =>
                c.verdict === VERDICT.RESUME ||
                c.verdict === VERDICT.INVITE ||
                parseMeta(c.meta).funnelStage === FUNNEL_STAGE.RESUME_REQUESTED,
            )
      ).slice(0, Math.max(1, activeJob?.headcount || 5));
    }
    if (!targets.length) {
      return {
        ...base,
        handled: true,
        candidates: [],
        clientActions: [],
        reply: "当前没有已请求或已收到简历的候选人。请先完成二筛并请求简历。",
      };
    }
    if (activeJob) {
      await pool.query(`UPDATE hr_jobs SET stage = 'resume_downloading' WHERE id = ?`, [activeJob.id]);
    }
    return {
      ...base,
      handled: true,
      candidates: targets,
      clientActions: [
        clientAction("download_resumes", {
          limit: targets.length || 5,
          names: targets.map((c) => c.name),
        }),
      ],
      actions: [
        { id: "download_resume", label: "本机自动下载简历到桌面" },
        { id: "prepare_invite", label: "约面试（需确认）" },
      ],
      reply: [
        named
          ? `已下发【自动下载简历】到本机 Boss（仅 ${targets.map((c) => c.name).join("、")}）；文件保存到你电脑【桌面】。`
          : "已下发【自动下载简历】到本机 Boss（仅择优名单）；文件保存到你电脑【桌面】。",
        ...formatCandidateLines(targets, targets.length || 5),
        "简历+聊天回复齐备后，可说「约面试」生成草稿（人工确认后才发送）。",
      ].join("\n"),
    };
  }

  if (classified.intent === HR_INTENTS.AUTO_RECHAT) {
    const draft =
      hints.rechatMessage ||
      funFollowupMessage(activeJob?.job_title) ||
      "您好，想跟您再确认一下：本周是否方便线上面试？以及最早到岗时间？";
    return {
      ...base,
      handled: true,
      clientActions: [clientAction("auto_rechat", { message: draft, limit: 5 })],
      actions: [{ id: "auto_rechat", label: "本机自动复聊" }],
      reply: [
        "已下发【自动复聊】到本机 Boss 窗口。",
        `文案：${draft}`,
        "若要走标准漏斗的 24h 趣味复聊，可说「趣味复聊」或「24小时未回复跟进」。",
      ].join("\n"),
    };
  }

  if (classified.intent === HR_INTENTS.TALENT_POOL) {
    if (!activeJob) {
      return { ...base, handled: true, reply: "还没有任务。面试通过但未入职时，再说「存入人才库」。" };
    }
    const cands = await listCandidates(pool, activeJob.id);
    const targets = cands.filter(
      (c) => c.verdict === VERDICT.INVITE || c.invite_status === "sent" || c.verdict === VERDICT.RESUME,
    );
    for (const c of targets) {
      const meta = buildCandidateMeta(c.meta, { funnelStage: FUNNEL_STAGE.TALENT_POOL });
      await pool.query(`UPDATE hr_candidates SET verdict = ?, meta = ?, reason = ? WHERE id = ?`, [
        VERDICT.TALENT,
        JSON.stringify(meta),
        "面试通过未入职，已存人才库",
        c.id,
      ]);
    }
    await pool.query(`UPDATE hr_jobs SET stage = 'talent_pool' WHERE id = ?`, [activeJob.id]);
    return {
      ...base,
      handled: true,
      candidates: targets,
      reply: targets.length
        ? `已将 ${targets.length} 人标记为人才库（面试通过未入职）。\n${targets.map((c) => `- ${c.name}`).join("\n")}`
        : "当前没有可入库人选。约面发送后或答对≥80%名单可入库。",
    };
  }

  if (classified.intent === HR_INTENTS.PREPARE_INVITE || classified.intent === HR_INTENTS.FILL_INVITE_DETAILS) {
    if (!activeJob) {
      return {
        ...base,
        handled: true,
        reply: "还没有可约面名单。请先跑完：初筛→提问→二次筛（或人事目视多媒体）。",
      };
    }
    const all = await listCandidates(pool, activeJob.id);
    const plan = jobMeta(activeJob).invitePlan;
    const interviewFromMsg = hints.interview || {};
    const priorInterview = plan?.interview || {};
    const details = mergeInterviewDetails(priorInterview, interviewFromMsg);

    let candidateIds = null;
    if (classified.intent === HR_INTENTS.FILL_INVITE_DETAILS && plan?.candidateIds?.length) {
      candidateIds = plan.candidateIds;
    } else {
      const named = resolveTargetCandidates(all, hints.targetNames);
      if (named) {
        if (!named.length) {
          return {
            ...base,
            handled: true,
            reply: `没找到要约的人（${(hints.targetNames || []).join("、") || "未识别"}）。当前：${all.map((c) => c.name).join("、") || "空"}。例：「只约张同学，明天下午3点线上面试」`,
          };
        }
        candidateIds = named.map((c) => c.id);
      } else if (plan?.candidateIds?.length && classified.intent === HR_INTENTS.FILL_INVITE_DETAILS) {
        candidateIds = plan.candidateIds;
      }
    }

    const prepared = await prepareInviteBatch(
      pool,
      userId,
      activeJob,
      candidateIds,
      null,
      details,
    );
    return {
      ...base,
      handled: true,
      requireConfirm: Boolean(prepared.ok),
      pendingInvite: prepared.ok ? { id: prepared.batchId, status: "pending_confirm" } : base.pendingInvite,
      candidates: prepared.candidates || [],
      reply: prepared.message,
    };
  }

  if (classified.intent === HR_INTENTS.CONTINUE || classified.intent === HR_INTENTS.NEED_LOGIN) {
    if (login?.demo) {
      return {
        ...base,
        handled: true,
        openLoginWizard: true,
        reply:
          "当前是【演示模式】（DEMO_HR_PIPELINE=1）。\n可用：「招 5 个 Java 后端」跑完整漏斗演示；量产请用桌面客户端登录 Boss。",
      };
    }
    if (!login?.loggedIn && !login?.desktopDeferred) {
      return {
        ...base,
        handled: true,
        openLoginWizard: true,
        clientActions: [clientAction("open_boss_login", {})],
        reply:
          "请先在桌面客户端打开本机 Boss 并检验登录态。通过后可说：\n- 招 5 个 Java 后端（完整漏斗）\n- 问张同学：…… / 有谁回复了\n- 根据回复二次筛选\n- 只约张同学，明天下午3点线上面试（需确认）",
      };
    }
    return {
      ...base,
      handled: true,
      reply: [
        "可以说一句话招聘，例如：",
        "「招 3 个 AI 开发，长沙，熟练 LangChain」",
        "我会先复述意图请你确认，再在本机 Boss 执行（拉沟通 → JD 初筛）。",
        "",
        "也可继续说：问某人… / 有谁回复了 / 只约某人+时间+线上线下 → 确认发送。",
      ].join("\n"),
    };
  }

  return { ...base, handled: false, reply: null };
}


export async function getHrPipelineSnapshot(pool, userId) {
  await ensureHrPipelineTables(pool);
  const job = await getActiveJob(pool, userId);
  const pendingInvite = await getPendingInvite(pool, userId);
  const candidates = job ? await listCandidates(pool, job.id) : [];
  const preferences = await getHrPreferences(pool, userId);
  return { job, pendingInvite, candidates, preferences };
}
