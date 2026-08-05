/**
 * Product-facing Gateway skills: ready skills + easy env-only setup,
 * excluding debug / internal tooling.
 */

const DEBUG_NAME_RE = /debug|debugger|inspect|spike/i;

export function missingCounts(skill) {
  const missing = skill?.missing || {};
  return {
    bins: (missing.bins || []).length,
    anyBins: (missing.anyBins || []).length,
    env: (missing.env || []).length,
    config: (missing.config || []).length,
    os: (missing.os || []).length,
  };
}

export function isReadySkill(skill, { ignoreDisabled = false } = {}) {
  if (!skill) return false;
  if (!ignoreDisabled && skill.disabled) return false;
  if (skill.blockedByAllowlist || skill.blockedByAgentFilter) return false;
  if (skill.platformIncompatible) return false;
  // Disabled skills report eligible=false; judge readiness by missing deps instead.
  if (!ignoreDisabled && !skill.eligible) return false;
  if (ignoreDisabled && !skill.disabled && !skill.eligible) return false;
  const m = missingCounts(skill);
  return m.bins + m.anyBins + m.env + m.config + m.os === 0;
}

/** Easy setup: only missing env, and skill declares a primary API-key env. */
export function isEnvOnlySetupSkill(skill, { ignoreDisabled = false } = {}) {
  if (!skill) return false;
  if (!ignoreDisabled && skill.disabled) return false;
  if (skill.platformIncompatible) return false;
  if (!skill.primaryEnv) return false;
  const m = missingCounts(skill);
  if (m.bins + m.anyBins + m.config + m.os > 0) return false;
  return m.env > 0;
}

export function isExcludedByPolicy(skill, policy = {}) {
  const name = String(skill?.name || skill?.skillKey || "");
  const key = String(skill?.skillKey || skill?.name || "");
  const excludeNames = new Set(
    (policy.excludeNames || []).map((n) => String(n).toLowerCase()),
  );
  if (excludeNames.has(name.toLowerCase()) || excludeNames.has(key.toLowerCase())) {
    return true;
  }
  const patterns = policy.excludeNamePatterns || [];
  for (const pat of patterns) {
    try {
      if (new RegExp(pat, "i").test(name) || new RegExp(pat, "i").test(key)) {
        return true;
      }
    } catch {
      // ignore bad pattern
    }
  }
  if (DEBUG_NAME_RE.test(name) || DEBUG_NAME_RE.test(key)) return true;
  if (policy.userInvocableOnly !== false && skill.userInvocable === false) {
    return true;
  }
  return false;
}

export function selectProductSkills(report, catalog = {}) {
  const policy = catalog.policy || {};
  const labels = catalog.labels || {};
  const includeReady = policy.includeReady !== false;
  const includeEnvOnly = policy.includeEnvOnlySetup !== false;
  const skills = Array.isArray(report?.skills) ? report.skills : [];
  const out = [];

  for (const skill of skills) {
    if (isExcludedByPolicy(skill, policy)) continue;
    // Keep disabled skills visible so the client can re-enable them.
    const ready = isReadySkill(skill, { ignoreDisabled: true });
    const easy = isEnvOnlySetupSkill(skill, { ignoreDisabled: true });
    if (!(includeReady && ready) && !(includeEnvOnly && easy)) continue;

    const id = skill.skillKey || skill.name;
    const label = labels[id] || labels[skill.name] || {};
    const currentlyReady = isReadySkill(skill);
    const needsSetup = !currentlyReady && !skill.disabled;
    out.push({
      id,
      skillKey: id,
      name: label.name || skill.name,
      description: label.description || skill.description || "",
      emoji: label.emoji || skill.emoji || "技能",
      enabled: !skill.disabled,
      ready: currentlyReady,
      needsSetup,
      primaryEnv: skill.primaryEnv || null,
      missing: {
        bins: skill.missing?.bins || [],
        env: skill.missing?.env || [],
        config: skill.missing?.config || [],
        os: skill.missing?.os || [],
      },
      source: skill.source,
      bundled: Boolean(skill.bundled),
      homepage: skill.homepage || null,
      setupHint: needsSetup
        ? skill.primaryEnv
          ? `填写 ${skill.primaryEnv} 即可启用`
          : (skill.missing?.env || []).length
            ? `需要环境变量：${(skill.missing?.env || []).join(", ")}`
            : "需要额外配置"
        : null,
    });
  }

  out.sort((a, b) => a.name.localeCompare(b.name, "zh"));
  return out;
}
