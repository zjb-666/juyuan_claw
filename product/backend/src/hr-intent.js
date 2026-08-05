/**
 * Dialogue intent classifier for HR recruitment digital employee.
 * Prefer conversation routing over forced UI mode pickers.
 * Funnel: JD筛 → 打招呼提问 → 答对再筛 → 简历 → 约面（见 hr-funnel.js）.
 */

export const HR_INTENTS = Object.freeze({
  SMALLTALK: "smalltalk",
  OPEN_BOSS: "open_boss",
  CHECK_BOSS: "check_boss",
  NEED_LOGIN: "need_login",
  INBOX: "inbox",
  SEARCH: "search",
  RUN_FUNNEL: "run_funnel",
  RANK: "rank",
  ASK_CANDIDATES: "ask_candidates",
  CHECK_REPLIES: "check_replies",
  SCREEN_ANSWERS: "screen_answers",
  FOLLOWUP_24H: "followup_24h",
  REQUEST_RESUME: "request_resume",
  DOWNLOAD_RESUME: "download_resume",
  AUTO_RECHAT: "auto_rechat",
  AUTO_ADVANCE: "auto_advance",
  SHORTLIST: "shortlist",
  PREPARE_INVITE: "prepare_invite",
  FILL_INVITE_DETAILS: "fill_invite_details",
  CONFIRM_INVITE: "confirm_invite",
  CANCEL_INVITE: "cancel_invite",
  /** One-shot hire plan awaiting user confirm before desktop Boss skills run. */
  CONFIRM_PLAN: "confirm_plan",
  CANCEL_PLAN: "cancel_plan",
  TALENT_POOL: "talent_pool",
  STATUS: "status",
  CONTINUE: "continue",
});

const WEATHER_RE =
  /天气|温度|降雨|气象|风力|湿度|日出日落|\b(weather|temperature|rain|forecast|humidity|wind)\b/i;

const INBOX_RE =
  /筛(选)?(?:今天|今日|当日)?(?:的)?投递|投递箱|谁投了|看投递|今天的投递|今日投递|简历投递|筛简历|收件箱|inbox|候选人投递/i;

const SEARCH_RE =
  /主动搜|帮我搜|去搜人|搜索候选人|搜候选人|搜人|猎头搜|主动找人|search\s*(for)?\s*candidate/i;

const RUN_FUNNEL_RE =
  /(?:跑|走|启动|开始)(?:一下)?(?:完整)?(?:招聘)?漏斗|一键(?:招聘|筛人|招人)|按流程招|全自动招|标准招聘流程/i;

/** Natural hire / continue-hire utterances (不必说「招」字; 含中文人数「三个」). */
const HIRE_TASK_RE =
  /我要招|招\s*\d+|招\s*[一二两三四五六七八九十]+|招聘|招人|需要找\s*\d+|找\s*\d+\s*(?:个|名|人)|找\s*[一二两三四五六七八九十]+\s*(?:个|名|人)|目标是找|把剩下的|将剩下的|剩下的\s*\d+|剩余的\s*\d+|今天.*\d+\s*(?:个|名|人)|处理.*\d+\s*(?:个|名)|筛(?:一下|选)?.*\d+\s*(?:个|名)/i;

const RANK_RE = /评优|排名|打分|综合评估|谁更合适|排序|推荐Top|Top\s*\d+/i;

/** Free-form candidate question (not a hire task). */
const CANDIDATE_QUESTION_RE =
  /[？?]|作品集|作品|到岗|薪资|加班|出差|方便(?:发|展示|给)|展示一下|有没有|能不能|可否|面试时间|期望|在职|是否|可以给我们|请问|您好[，,]/;

const ASK_RE =
  /^(?:问|问问|帮我问)|问(一下|他们|候选人)|追问|聊两句|代聊|发消息问|问问他们|问问候选人|打招呼|基础提问|岗位提问/i;

const CHECK_REPLIES_RE =
  /有谁回复|谁回复了|谁回了|具体谁回|查(?:一下)?回复|看(?:一下)?回复|看看.{0,12}回复|候选人回[复信了]|有新回复|回信通知|检查回复|通知我回复|等人回|(?:回复了|回信了|有没有回|回了吗|的回复|回信了吗)/i;

const SCREEN_ANSWERS_RE =
  /二次筛|再筛|根据回[复答]筛|回答筛|答对率|筛回答|回复评[估价优]|按回答评/i;

const FOLLOWUP_24H_RE =
  /24\s*小时|一天未回|未回复|没回[复信]|趣味复聊|追加复聊|跟进未回/i;

const REQUEST_RESUME_RE =
  /(?:自动)?(?:请求|求|要|获取)简历|帮我(?:请求|求)简历|request\s*resume/i;

const DOWNLOAD_RESUME_RE =
  /(?:自动)?下载简历|导出简历|保存简历|帮我下载简历|下载到桌面|简历.*?下载到桌面|download\s*resume/i;

const AUTO_RECHAT_RE =
  /(?:自动)?复聊|批量复聊|跟进(?:一下|聊天|消息)|再聊一遍|auto\s*re-?chat/i;

const AUTO_ADVANCE_RE =
  /自动推进(?:招呼|招聘|沟通)?(?:进度)?|推进招呼进度|一键推进(?:招聘|沟通|候选人)?|自动处理(?:候选人|沟通列表)|批量推进(?:候选人|沟通)?|继续自动招聘|自动跑下一步/i;

const SHORTLIST_RE = /可约面|约面名单|推荐约面|哪些可以约|面试名单|shortlist/i;

/** Includes selective invites: 只约张同学 / 约李同学面试 */
const PREPARE_INVITE_RE =
  /只约|只给.+?(?:面试|邀约)|约(?:一下)?[\u4e00-\u9fffA-Za-z0-9]{1,12}(?:面试|邀约)|约面试|邀约|一键约|发邀约|约他们面试|安排面试|发送面试邀请/i;

const CONFIRM_INVITE_RE =
  /确认发送|确认邀约|可以发|同意发送|发吧|确认约面|就这些人|按这个发/i;

const CANCEL_INVITE_RE = /取消邀约|先别发|不要发了|取消发送|撤回邀约/i;

/** Confirm one-shot hire plan (not invite). */
const CONFIRM_PLAN_RE =
  /确认执行|确认开始|开始执行|可以执行|执行吧|开始吧|就这样招|按这个(?:招|执行|来)|确认计划|没问题[，,]?开始|对的[，,]?开始/i;

const CANCEL_PLAN_RE =
  /取消(?:执行|计划|任务|招聘)|先别(?:执行|跑|招)|不要执行|取消招聘计划|先不招了/i;

const CITY_RE =
  /(?:北京|上海|广州|深圳|杭州|成都|武汉|西安|南京|苏州|长沙|重庆|天津|青岛|大连|厦门|郑州|合肥|福州|济南|沈阳|昆明|南昌|贵阳|海口|兰州|太原|石家庄|长春|哈尔滨|南宁|宁波|无锡|佛山|东莞|珠海)(?:市)?/;

const TALENT_POOL_RE = /人才库|入库|未入职|存入人才|通过未入职/i;

const OPEN_BOSS_RE =
  /打开\s*(?:boss|直聘|zhipin)?\s*(?:窗口|浏览器|页面)?|(?:boss|直聘)\s*窗口|显示\s*boss|切换\s*(?:到\s*)?boss/i;

const CHECK_BOSS_RE =
  /检验\s*(?:boss\s*)?登录(?:态)?|检查\s*(?:boss\s*)?登录|验证\s*(?:boss\s*)?登录|boss\s*登录态/i;

const LOGIN_RE = /登录|登陆|boss|直聘|zhipin|验证码/i;

const STATUS_RE = /当前进度|做到哪|招聘进度|当前任务|pipeline|任务状态|漏斗进度/i;

const HEADCOUNT_RE = /(\d+)\s*(?:个人|个人左右|个|名|人)/;

const CN_DIGIT = Object.freeze({
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
});

const INVITE_DETAIL_SIGNAL_RE =
  /线[上下]面试|线上|线下|视频面试|到公司|现场面试|地点|地址|明天|后天|本周|下周|\d{1,2}\s*[点时:：]|周[一二三四五六日天]/;

/** 「三个/十二个/二十个」→ Arabic digits so hire/funnel rules stay digit-based. */
export function normalizeChineseHeadcount(text) {
  return String(text || "").replace(
    /([一二两三四五六七八九十百零]{1,4})\s*(个人|个|名|人)/g,
    (full, cn, unit) => {
      const n = parseChineseCount(cn);
      return Number.isFinite(n) && n > 0 ? `${n}${unit}` : full;
    },
  );
}

function parseChineseCount(token) {
  const t = String(token || "").trim();
  if (!t) return null;
  if (t === "十") return 10;
  if (t === "百") return 100;
  if (/^十[一二三四五六七八九]$/.test(t)) return 10 + CN_DIGIT[t[1]];
  if (/^[二三四五六七八九]十$/.test(t)) return CN_DIGIT[t[0]] * 10;
  if (/^[二三四五六七八九]十[一二三四五六七八九]$/.test(t)) {
    return CN_DIGIT[t[0]] * 10 + CN_DIGIT[t[2]];
  }
  if (t.length === 1 && CN_DIGIT[t] != null) return CN_DIGIT[t];
  return null;
}

function cleanJobTitle(value) {
  let t = String(value || "")
    .replace(/^(?:帮我|请|麻烦|把|将|把剩下的|将剩下的)\s*/g, "")
    .replace(/^(?:剩下的|剩余的|今天|今日|当日)\s*/g, "")
    .replace(/(?:岗位|职位)$/g, "")
    .replace(/[,，。；;]\s*$/g, "")
    .replace(/\s*人$/g, "")
    .trim();
  t = t.replace(/\s*(?:招|需要|招满)?\s*\d+\s*(?:个人|个|名|人).*$/, "").trim();
  t = t.replace(/^(?:把|将|的|了)\s*/g, "").trim();
  // Strip leading Chinese count leftovers: 「三个智能体…」 after failed normalize.
  t = t.replace(/^[一二两三四五六七八九十]+\s*(?:个人|个|名|人)?/, "").trim();
  if (!t || /^\d+$/.test(t) || /^\d+\s*(?:个人|个|名|人)$/.test(t)) return "";
  if (t.length < 2) return "";
  // Never treat candidate Q&A / chat instructions as a job title.
  if (
    t.length > 40 ||
    /[？?]/.test(t) ||
    /^(?:问|请问|您好|追问)/.test(t) ||
    /有没有|能不能|可以展示|同学|方便发|期望薪资/.test(t)
  ) {
    return "";
  }
  return t.slice(0, 80);
}

/**
 * Extract job title / headcount / city / requirements hints from free text.
 * Supports one-shot: 「招 3 个 AI 开发，长沙，熟练 LangChain」.
 * @param {string} text
 */
export function extractJobHints(text) {
  const raw = normalizeChineseHeadcount(String(text || "").trim());
  let headcount = null;
  const hc = raw.match(HEADCOUNT_RE);
  if (hc) headcount = Number(hc[1]);

  // One-shot hire: 「招 3 个 AI 开发，…」— title stops at comma / end.
  let jobTitle = "";
  const oneShot = raw.match(
    /招\s*(\d+)\s*(?:个人|个|名|人)\s*([^，,。；;\n]{2,24})/,
  );
  if (oneShot) {
    if (!headcount) headcount = Number(oneShot[1]);
    jobTitle = cleanJobTitle(oneShot[2]);
  }

  // 「今天把剩下的5个ai工程师」→ 人数后的岗位名（必须带 个/名/人，避免「3点线上面试」误伤）
  if (!jobTitle) {
    const afterCount = raw.match(
      /(?:剩下的|剩余的)?\s*\d+\s*(?:个人|个|名|人)\s*([A-Za-z0-9\u4e00-\u9fff/+#\-·]{2,40})\s*$/,
    );
    if (afterCount?.[1]) {
      jobTitle = cleanJobTitle(afterCount[1]);
    }
  }

  const withoutHc = raw
    .replace(/[,，]?\s*(?:招|需要|招满|把|将)?\s*(?:剩下的|剩余的)?\s*\d+\s*(?:个人|个|名|人)(?:左右)?/g, " ")
    .replace(/今天|今日|当日/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!jobTitle) {
    const patterns = [
      /岗位[：:\s]*([^\n，,。；;]{2,40})/,
      /JD[：:\s]*([^\n，,。；;]{2,40})/i,
      /(?:筛(?:选)?|看|拉)\s*(?:今天|今日|当日)?\s*(?:的)?\s*投递(?:的)?\s*(.+)$/,
      /投递(?:的)?\s*(.+)$/,
      /(?:主动搜(?:人|索)?|帮我搜|去搜|搜索)\s*(.+)$/,
      /(?:招聘|招)\s*(.+)$/,
    ];
    for (const re of patterns) {
      const m = withoutHc.match(re);
      if (!m?.[1]) continue;
      // Prefer segment before first comma (city / skills often follow).
      const segment = String(m[1]).split(/[，,]/)[0];
      jobTitle = cleanJobTitle(segment);
      if (jobTitle) break;
    }
  }

  if (!jobTitle) {
    const leftoverRaw = withoutHc
      .replace(/^(?:帮我|请|麻烦|招聘|招人|招|把|将|处理|筛)\s*/g, "")
      .replace(/的投递|投递|漏斗|流程/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .split(/[，,]/)[0]
      .trim();
    // Leftover must look like a role name, not a full chat sentence.
    if (
      leftoverRaw &&
      leftoverRaw.length <= 24 &&
      !/^(?:问|请问)/.test(leftoverRaw) &&
      !/有没有|同学|展示|回复|邀约/.test(leftoverRaw)
    ) {
      const leftover = cleanJobTitle(leftoverRaw);
      if (leftover && !/漏斗|流程|进度|登录|作品集|您好/.test(leftover)) jobTitle = leftover;
    }
  }

  let city = null;
  const cityExplicit = raw.match(/(?:在|地点|工作地|城市|base)[：:\s]*([^\s，,。；;]{2,8})/i);
  if (cityExplicit?.[1] && CITY_RE.test(cityExplicit[1])) {
    city = cityExplicit[1].replace(/市$/, "");
  } else {
    const cityHit = raw.match(CITY_RE);
    if (cityHit) city = cityHit[0].replace(/市$/, "");
  }

  let requirements = null;
  const skillMatch = raw.match(
    /(?:熟练|精通|熟悉|要求|具备|需要会|会)\s*([A-Za-z0-9\u4e00-\u9fff/+\-·.#]{2,80})/,
  );
  if (skillMatch?.[1]) {
    requirements = skillMatch[1].replace(/[，,。；;]+$/, "").trim().slice(0, 120);
  } else {
    // Trailing comma clauses after city: 「…，长沙，熟练 LangChain」→ already handled;
    // if no skill verb, keep secondary clauses as soft requirements (skip pure city).
    const clauses = raw.split(/[，,]/).map((s) => s.trim()).filter(Boolean);
    const soft = clauses
      .slice(1)
      .filter((c) => c && !CITY_RE.test(c) && !/^招\s*\d+/.test(c) && c.length >= 2)
      .join("；");
    if (soft) requirements = soft.slice(0, 120);
  }

  const todayOnly = /今天|今日|当日/.test(raw);
  return {
    jobTitle,
    headcount: Number.isFinite(headcount) && headcount > 0 ? headcount : null,
    todayOnly,
    city,
    requirements,
  };
}

/**
 * Match known candidate names mentioned in text (张同学 / 只约张 / 问李同学：).
 * @param {string} text
 * @param {string[]} knownNames
 */
export function matchKnownNames(text, knownNames = []) {
  const raw = String(text || "");
  if (!raw || !knownNames.length) return [];
  const hit = [];
  for (const name of knownNames) {
    if (!name) continue;
    if (raw.includes(name)) {
      hit.push(name);
      continue;
    }
    const short = String(name).replace(/(同学|先生|女士)$/u, "");
    if (short.length >= 1 && raw.includes(short)) hit.push(name);
  }
  return [...new Set(hit)];
}

/**
 * Soft name hints when knownNames not yet loaded (e.g. 只约张同学 / 问张同学和李同学).
 */
export function extractTargetNameHints(text) {
  const raw = String(text || "");
  const found = new Set();
  const patterns = [
    /只(?:约|邀约|给|问|发给)\s*([^\s，,。；;、和与及]+)/g,
    /(?:约|发给)\s*([^\s，,。；;、]{2,12}?)\s*(?:面试|邀约)/g,
    /问\s*([^\s：:，,。]{2,12})\s*[：:]/g,
    /给\s*([^\s，,。；;]{2,12})\s*(?:发)?(?:面试)?邀约/g,
    // 「向高佳伟请求简历 / 向高佳伟询问期望薪资」
    /向\s*([^\s，,。；;、和与及]{1,12}?)\s*(?:请求|求|要|获取|询问|问)/g,
    /(?:请求|求|要|获取)(?:一下)?\s*([^\s，,。；;的]{2,12}?)\s*(?:的)?简历/g,
    /(?:询问|问问|问一下)\s*([^\s，,。；;的]{2,12}?)\s*(?:的)?(?:期望|薪资|到岗|作品)/g,
  ];
  for (const re of patterns) {
    for (const m of raw.matchAll(re)) {
      let token = String(m[1] || "")
        .replace(/^(?:一下|他们|候选人|他|她)/, "")
        .trim();
      token = token.replace(/^(?:问|和|与|给|约|向)/, "");
      if (token.length >= 2 && token.length <= 12 && !/面试|邀约|简历|问题|有没有|期望|薪资/.test(token)) {
        found.add(token);
      }
    }
  }
  // 「张同学」「李同学」— do not swallow leading 问/和 into the name.
  for (const m of raw.matchAll(/([\u4e00-\u9fff]{1,4}(?:同学|先生|女士))/g)) {
    let name = m[1];
    while (/^(?:问|和|与|给|约|帮|请|向)/.test(name) && name.length > 2) {
      name = name.slice(1);
    }
    if (/^(?:同学|先生|女士)$/.test(name)) continue;
    if (name.length >= 2) found.add(name);
  }
  return [...found];
}

/**
 * Interview logistics from free text.
 * @returns {{ mode: 'online'|'offline'|null, time: string|null, place: string|null, missing: string[] }}
 */
export function extractInterviewDetails(text) {
  const raw = String(text || "").trim();
  let mode = null;
  if (/线上面试|视频面试|线上\s*面|腾讯会议|飞书|zoom|远端|线上面/i.test(raw)) mode = "online";
  else if (/线下面试|到公司|现场面试|线下\s*面|来司|现场聊|线下地址|线下地点|线下面/.test(raw)) {
    mode = "offline";
  } else if (/线上/.test(raw) && !/线下/.test(raw)) mode = "online";
  else if (/线下/.test(raw) && !/线上/.test(raw)) mode = "offline";

  // Prefer full datetime phrases (含「明天下午3点」)，再退回「明天/周五」这类粗时间。
  let time = null;
  const timePatterns = [
    /((?:明天|后天|大后天|本周|下周)?\s*(?:周[一二三四五六日天]|星期[一二三四五六日天]|周五|周一|周二|周三|周四|周六|周日)?\s*(?:上午|下午|晚上|中午)\s*\d{1,2}\s*[点时:：]\s*\d{0,2}(?:\s*分)?)/,
    /((?:明天|后天|大后天|周[一二三四五六日天]|星期[一二三四五六日天]|周五|周一|周二|周三|周四|周六|周日)\s*(?:上午|下午|晚上|中午)?\s*\d{1,2}\s*[点时:：]\s*\d{0,2}(?:\s*分)?)/,
    /((?:上午|下午|晚上|中午)\s*\d{1,2}\s*[点时:：]\s*\d{0,2}(?:\s*分)?)/,
    /(\d{1,2}\s*[点时:：]\s*\d{0,2}(?:\s*分)?)/,
    /((?:明天|后天|本周[一二三四五六日天]|下周[一二三四五六日天]|周[一二三四五六日天]|周五)(?:\s*(?:上午|下午|晚上|中午))?)/,
  ];
  for (const re of timePatterns) {
    const m = raw.match(re);
    if (m?.[1]) {
      time = m[1].replace(/\s+/g, "").trim();
      break;
    }
  }
  // 「周五…下午3点」拆开写时拼起来
  if (time && /^(?:上午|下午|晚上|中午)?\d{1,2}点/.test(time)) {
    const day = raw.match(/(明天|后天|周[一二三四五六日天]|星期[一二三四五六日天]|周五|周一|周二|周三|周四|周六|周日)/);
    if (day?.[1] && !time.includes(day[1])) time = `${day[1]}${time}`;
  }

  let place = null;
  const placePatterns = [
    /(?:地点|地址|公司地址|线下地址|线下地点|面试地点)\s*[：:：]?\s*([^\n，,。；;]{2,40})/,
    /((?:[\u4e00-\u9fffA-Za-z0-9]{2,20})(?:国际|大厦|园区|广场|中心|大楼|大厦|写字楼)\s*\d{0,3}\s*楼?)/,
    /((?:[\u4e00-\u9fffA-Za-z0-9]{2,24})\d{1,3}\s*楼)/,
    /((?:[\u4e00-\u9fff]{1,20}(?:路|街|道)\s*\d{1,4}\s*号?(?:[\u4e00-\u9fff]{0,8})?))/,
    /(?:在|到)\s*([^\s，,。；;]{2,30}(?:大厦|园区|路|街|中心|办公室|国际|广场|楼)?)/,
  ];
  for (const re of placePatterns) {
    const m = raw.match(re);
    if (!m?.[1]) continue;
    let cand = m[1]
      .replace(/^(?:是|在|到)/, "")
      .replace(/^(?:明天|后天|大后天|本周|下周|周[一二三四五六日天]|星期[一二三四五六日天]|周五|周一|周二|周三|周四|周六|周日)/, "")
      .replace(/^(?:上午|下午|晚上|中午)/, "")
      .trim();
    if (!cand || /^(?:面试|线上|线下|邀约|同学)/.test(cand)) continue;
    if (/面试|线上|线下|邀约|同学/.test(cand) && !/(?:国际|大厦|园区|广场|中心|大楼|楼|路|街|号)/.test(cand)) {
      continue;
    }
    place = cand
      .replace(/(?:明天|后天|周[一二三四五六日天]|星期[一二三四五六日天]|周五|上午|下午|晚上|中午).*$/, "")
      .replace(/(?:面试|约面).*$/, "")
      .trim();
    if (place.length >= 2) break;
    place = null;
  }

  // 有明确地址形态但未写「线下」→ 默认线下
  if (!mode && place && !/线上|视频|腾讯会议|飞书|zoom/i.test(raw)) {
    mode = "offline";
  }
  // 「…面试」+ 楼/大厦地址，也视为线下
  if (!mode && /面试/.test(raw) && /(?:国际|大厦|园区|广场|中心|大楼|\d+\s*楼|路\d|街|号)/.test(raw) && !/线上|视频/.test(raw)) {
    mode = "offline";
  }

  const missing = [];
  if (!mode) missing.push("面试形式（线上/线下）");
  if (!time) missing.push("面试时间");
  if (mode === "offline" && !place) missing.push("线下地点");

  return { mode, time, place, missing };
}

function looksLikeHireTask(raw, hints) {
  // Asking candidates is never a new hire task.
  if (/^(?:问|问问|帮我问|追问)/.test(raw)) return false;
  if (/同学/.test(raw) && /有没有|能不能|作品|薪资|到岗|方便/.test(raw)) return false;
  if (HIRE_TASK_RE.test(raw) && hints.jobTitle) return true;
  if (HIRE_TASK_RE.test(raw) && /(?:个|名|人)\s*[A-Za-z0-9\u4e00-\u9fff]{2,}/.test(raw)) return true;
  if (hints.headcount && hints.jobTitle && /(今天|现在|目标|剩下|剩余|处理|筛|招|找)/.test(raw)) {
    return true;
  }
  if (/招\s*\d+|招聘|招人|需要找/.test(raw) && hints.jobTitle) return true;
  return false;
}

/**
 * 「问张同学和李同学有没有作品」→ question body without names.
 */
function stripAskPrefix(raw, knownNames = []) {
  let s = String(raw || "").trim();
  s = s
    .replace(/^向\s*[^\s，,。；;、]{1,12}\s*/, "")
    .replace(/^(?:帮我)?(?:问|问问|追问|询问)(?:一下)?/, "")
    .replace(/^(?:他们|候选人|他|她)[：:\s]*/, "")
    .trim();

  // Drop the resume-request clause so the remaining question stays clean.
  s = s
    .replace(/(?:请求|求|要|获取)(?:一下)?(?:他的|她的|其)?简历/g, " ")
    .replace(/^[，,、；;]\s*/, "")
    .replace(/^(?:并|并且|同时|顺便)\s*/, "")
    .replace(/^(?:询问|问问|问一下|问他|问她)/, "")
    .replace(/^(?:他的|她的|其)\s*/, "")
    .trim();

  // Strip known names joined by 和/与/、
  if (knownNames.length) {
    const sorted = [...knownNames].sort((a, b) => b.length - a.length);
    let changed = true;
    while (changed) {
      changed = false;
      for (const name of sorted) {
        const short = name.replace(/(同学|先生|女士)$/u, "");
        const re = new RegExp(
          `^(?:和|与|、|及|,|，)?(?:${escapeRegExp(name)}|${escapeRegExp(short)})`,
        );
        if (re.test(s)) {
          s = s.replace(re, "").trim();
          changed = true;
        }
      }
    }
  } else {
    s = s
      .replace(
        /^(?:[\u4e00-\u9fff]{1,4}(?:同学|先生|女士)?(?:和|与|、|及|,|，))+[\u4e00-\u9fff]{1,4}(?:同学|先生|女士)?/,
        "",
      )
      .replace(/^[\u4e00-\u9fff]{1,4}(?:同学|先生|女士)/, "")
      .trim();
  }

  s = s.replace(/^[：:\s]+/, "").trim();
  // If stripping emptied the string, fall back to original without leading 问
  if (s.length < 2) {
    s = String(raw || "")
      .replace(/^(?:帮我)?(?:问|问问|追问|询问)(?:一下)?/, "")
      .trim();
  }
  return s;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function looksLikeReplyStatus(raw, targetHints) {
  const text = String(raw || "").trim();
  if (!text) return false;
  if (CHECK_REPLIES_RE.test(text)) return true;
  // 「张同学回复了」「李同学回信了吗」「看看张的回复」
  if (targetHints.length && /回[复信]|有回|回了|回信/.test(text)) return true;
  if (/^(?:他|她|他们|她们)?(?:回[复信]了|有回复了吗|回了吗)/.test(text)) return true;
  return false;
}

function looksLikeCandidateAsk(raw, ctx, targetHints) {
  const text = String(raw || "").trim();
  if (!text) return false;
  if (/^(?:问|问问|帮我问|追问|询问)/.test(text)) return true;
  if (/^(?:打招呼|基础提问|岗位提问)/.test(text)) return true;
  if (/向.+?(?:询问|问)/.test(text)) return true;
  if (ASK_RE.test(text) && !/招\s*\d+|招聘漏斗|需要找/.test(text)) return true;
  if (
    (ctx.hasCandidates || targetHints.length > 0) &&
    targetHints.length > 0 &&
    /有没有|能不能|作品|薪资|到岗|方便|期望|离职|加班|面试|询问/.test(text)
  ) {
    return true;
  }
  // Free-form question to current shortlist (no name): 「您好，方便发一下作品集吗？」
  if (
    ctx.hasCandidates &&
    CANDIDATE_QUESTION_RE.test(text) &&
    text.length >= 6 &&
    text.length <= 500 &&
    !HIRE_TASK_RE.test(text)
  ) {
    return true;
  }
  return false;
}

/**
 * Classify a user utterance into an HR pipeline intent.
 * @param {string} text
 * @param {{
 *   loggedIn?: boolean,
 *   hasPendingInvite?: boolean,
 *   hasCandidates?: boolean,
 *   knownNames?: string[],
 *   hasInvitePlan?: boolean,
 * }} ctx
 */
export function classifyHrIntent(text, ctx = {}) {
  // Normalize「三个」→「3个」before digit-based hire/funnel rules.
  const raw = normalizeChineseHeadcount(String(text || "").trim());
  const hints = extractJobHints(raw);
  const known = Array.isArray(ctx.knownNames) ? ctx.knownNames : [];
  const targetNames = matchKnownNames(raw, known);
  const targetHints = targetNames.length ? targetNames : extractTargetNameHints(raw);
  const interview = extractInterviewDetails(raw);
  const enriched = {
    ...hints,
    targetNames: targetHints,
    interview,
  };

  if (!raw) return { intent: HR_INTENTS.SMALLTALK, confidence: 0, hints: enriched };

  if (WEATHER_RE.test(raw)) {
    return { intent: HR_INTENTS.SMALLTALK, confidence: 0.9, hints: enriched };
  }

  if (OPEN_BOSS_RE.test(raw)) {
    return { intent: HR_INTENTS.OPEN_BOSS, confidence: 0.95, hints: enriched };
  }
  if (CHECK_BOSS_RE.test(raw)) {
    return { intent: HR_INTENTS.CHECK_BOSS, confidence: 0.95, hints: enriched };
  }

  // Pending hire-plan confirm gate (one-shot → confirm → desktop execute).
  if (ctx.hasPendingPlan && CONFIRM_PLAN_RE.test(raw)) {
    return { intent: HR_INTENTS.CONFIRM_PLAN, confidence: 0.95, hints: enriched };
  }
  if (ctx.hasPendingPlan && CANCEL_PLAN_RE.test(raw)) {
    return { intent: HR_INTENTS.CANCEL_PLAN, confidence: 0.95, hints: enriched };
  }
  // Reuse invite confirm phrasing when only a hire plan is pending.
  if (ctx.hasPendingPlan && !ctx.hasPendingInvite && CONFIRM_INVITE_RE.test(raw)) {
    return { intent: HR_INTENTS.CONFIRM_PLAN, confidence: 0.9, hints: enriched };
  }
  if (ctx.hasPendingPlan && !ctx.hasPendingInvite && CANCEL_INVITE_RE.test(raw)) {
    return { intent: HR_INTENTS.CANCEL_PLAN, confidence: 0.9, hints: enriched };
  }

  if (ctx.hasPendingInvite && CONFIRM_INVITE_RE.test(raw)) {
    return { intent: HR_INTENTS.CONFIRM_INVITE, confidence: 0.95, hints: enriched };
  }
  if (ctx.hasPendingInvite && CANCEL_INVITE_RE.test(raw)) {
    return { intent: HR_INTENTS.CANCEL_INVITE, confidence: 0.95, hints: enriched };
  }

  if (CANCEL_INVITE_RE.test(raw)) {
    return { intent: HR_INTENTS.CANCEL_INVITE, confidence: 0.8, hints: enriched };
  }
  if (CONFIRM_INVITE_RE.test(raw) && (ctx.hasPendingInvite || PREPARE_INVITE_RE.test(raw))) {
    return { intent: HR_INTENTS.CONFIRM_INVITE, confidence: 0.85, hints: enriched };
  }

  // Completing invite logistics after 「只约张同学」asked for time/place/mode.
  if (
    ctx.hasInvitePlan &&
    INVITE_DETAIL_SIGNAL_RE.test(raw) &&
    !looksLikeHireTask(raw, hints) &&
    !ASK_RE.test(raw)
  ) {
    return { intent: HR_INTENTS.FILL_INVITE_DETAILS, confidence: 0.92, hints: enriched };
  }

  if (PREPARE_INVITE_RE.test(raw)) {
    return { intent: HR_INTENTS.PREPARE_INVITE, confidence: 0.9, hints: enriched };
  }
  if (TALENT_POOL_RE.test(raw)) {
    return { intent: HR_INTENTS.TALENT_POOL, confidence: 0.85, hints: enriched };
  }
  if (SHORTLIST_RE.test(raw)) {
    return { intent: HR_INTENTS.SHORTLIST, confidence: 0.85, hints: enriched };
  }
  if (looksLikeReplyStatus(raw, targetHints)) {
    return { intent: HR_INTENTS.CHECK_REPLIES, confidence: 0.92, hints: enriched };
  }
  if (FOLLOWUP_24H_RE.test(raw)) {
    return { intent: HR_INTENTS.FOLLOWUP_24H, confidence: 0.9, hints: enriched };
  }
  if (SCREEN_ANSWERS_RE.test(raw)) {
    return { intent: HR_INTENTS.SCREEN_ANSWERS, confidence: 0.9, hints: enriched };
  }
  if (DOWNLOAD_RESUME_RE.test(raw)) {
    return { intent: HR_INTENTS.DOWNLOAD_RESUME, confidence: 0.92, hints: enriched };
  }
  // 「向高佳伟请求简历，并询问期望薪资」→ 定向提问 + 顺带求简历（不要整份择优名单批量求简历）
  if (REQUEST_RESUME_RE.test(raw)) {
    const alsoAsk =
      looksLikeCandidateAsk(raw, ctx, targetHints) ||
      /询问|并问|顺便问|期望薪资|问他|问她|问一下/.test(raw);
    if (alsoAsk && targetHints.length) {
      let customQuestion = stripAskPrefix(raw, known.length ? known : targetHints);
      if (/^(?:打招呼(?:提问)?|基础提问|岗位提问|提问|一下|他们|请求简历|求简历)$/.test(customQuestion)) {
        customQuestion = "";
      }
      if (!customQuestion || customQuestion.length < 2) {
        customQuestion = /期望薪资|薪资/.test(raw)
          ? "请问您的期望薪资是多少？"
          : "想再跟您确认几个问题，方便回复一下吗？";
      }
      return {
        intent: HR_INTENTS.ASK_CANDIDATES,
        confidence: 0.96,
        hints: {
          ...enriched,
          jobTitle: "",
          alsoRequestResume: true,
          customQuestion,
          targetNames: targetHints,
        },
      };
    }
    return { intent: HR_INTENTS.REQUEST_RESUME, confidence: 0.92, hints: enriched };
  }
  if (AUTO_ADVANCE_RE.test(raw)) {
    return { intent: HR_INTENTS.AUTO_ADVANCE, confidence: 0.95, hints: enriched };
  }
  if (AUTO_RECHAT_RE.test(raw)) {
    const rechatMessage = String(raw)
      .replace(/^.*?(?:自动)?复聊[：:\s]*/i, "")
      .replace(/^.*?(?:跟进(?:一下|聊天|消息)?|再聊一遍)[：:\s]*/i, "")
      .trim();
    return {
      intent: HR_INTENTS.AUTO_RECHAT,
      confidence: 0.9,
      hints: { ...enriched, rechatMessage: rechatMessage || null },
    };
  }

  // Candidate Q&A must win over hire/funnel — 「问张同学…作品」 must not restart JD筛.
  if (looksLikeCandidateAsk(raw, ctx, targetHints) && !looksLikeHireTask(raw, hints)) {
    let customQuestion = stripAskPrefix(raw, known.length ? known : targetHints);
    if (/^(?:打招呼(?:提问)?|基础提问|岗位提问|提问|一下|他们)$/.test(customQuestion)) {
      customQuestion = "";
    }
    return {
      intent: HR_INTENTS.ASK_CANDIDATES,
      confidence: 0.93,
      hints: {
        ...enriched,
        jobTitle: "",
        customQuestion: customQuestion.length >= 2 ? customQuestion : null,
        targetNames: targetHints,
      },
    };
  }

  // Hire / funnel only when clearly a hiring task.
  if (RUN_FUNNEL_RE.test(raw)) {
    return { intent: HR_INTENTS.RUN_FUNNEL, confidence: 0.92, hints: enriched };
  }
  if (looksLikeHireTask(raw, hints)) {
    return { intent: HR_INTENTS.RUN_FUNNEL, confidence: 0.88, hints: enriched };
  }
  if (INBOX_RE.test(raw)) {
    return { intent: HR_INTENTS.INBOX, confidence: 0.92, hints: enriched };
  }
  if (SEARCH_RE.test(raw)) {
    return { intent: HR_INTENTS.SEARCH, confidence: 0.9, hints: enriched };
  }

  if (RANK_RE.test(raw)) {
    return { intent: HR_INTENTS.RANK, confidence: 0.8, hints: enriched };
  }
  if (STATUS_RE.test(raw)) {
    return { intent: HR_INTENTS.STATUS, confidence: 0.75, hints: enriched };
  }

  // Bare logistics while invite plan open (e.g. 「明天下午3点线上」)
  if (ctx.hasInvitePlan && INVITE_DETAIL_SIGNAL_RE.test(raw) && !looksLikeHireTask(raw, hints)) {
    return { intent: HR_INTENTS.FILL_INVITE_DETAILS, confidence: 0.85, hints: enriched };
  }

  // Narrow catch-all: role keywords alone (剪辑作品) must NOT restart funnel.
  if (/我要招|招\s*\d+|招聘|招人|筛(?:选)?(?:今天|今日)?投递|主动搜|跑漏斗|招聘漏斗/.test(raw)) {
    if (hints.jobTitle || hints.headcount) {
      return { intent: HR_INTENTS.RUN_FUNNEL, confidence: 0.7, hints: enriched };
    }
    if (/投递|简历/.test(raw)) {
      return { intent: HR_INTENTS.INBOX, confidence: 0.7, hints: enriched };
    }
    if (!ctx.loggedIn) {
      return { intent: HR_INTENTS.NEED_LOGIN, confidence: 0.75, hints: enriched };
    }
    return { intent: HR_INTENTS.CONTINUE, confidence: 0.55, hints: enriched };
  }

  if (LOGIN_RE.test(raw) && !ctx.loggedIn) {
    return { intent: HR_INTENTS.NEED_LOGIN, confidence: 0.8, hints: enriched };
  }

  return { intent: HR_INTENTS.SMALLTALK, confidence: 0.4, hints: enriched };
}

export function isRecruitmentRelatedIntent(intent) {
  return intent !== HR_INTENTS.SMALLTALK;
}
