import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const DISCORD_CONTENT_LIMIT = 2000;
const DISCORD_THREAD_NAME_LIMIT = 100;
const DISCORD_THREAD_AUTO_ARCHIVE_MINUTES = new Set([60, 1440, 4320, 10080]);

function stripAnsi(value) {
  return String(value ?? "").replace(/\u001b\[[0-9;]*m/g, "");
}

function normalizeText(value) {
  return stripAnsi(String(value ?? ""))
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncateText(value, maxChars) {
  const text = String(value ?? "");
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function formatDurationMs(value) {
  if (!Number.isFinite(value) || value < 0) {
    return "측정 불가";
  }

  const roundedMs = Math.round(value);
  if (roundedMs < 1000) {
    return `${roundedMs}ms`;
  }

  const totalSeconds = Math.round(roundedMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}시간 ${minutes}분 ${seconds}초`;
  }

  if (minutes > 0) {
    return `${minutes}분 ${seconds}초`;
  }

  return `${seconds}초`;
}

function heuristicSummary(text, maxBullets) {
  const cleaned = normalizeText(text)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) {
    return "- 요약할 메시지가 없습니다.";
  }

  const chunks = cleaned
    .split(/(?<=[.!?])\s+|\n+/g)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length >= 8);

  const bullets = [];
  for (const chunk of chunks) {
    const normalized = chunk.replace(/^[-*\d.)\s]+/, "").trim();
    if (!normalized) {
      continue;
    }

    bullets.push(`- ${truncateText(normalized, 420)}`);
    if (bullets.length >= maxBullets) {
      break;
    }
  }

  if (bullets.length === 0) {
    return `- ${truncateText(cleaned, 820)}`;
  }

  return bullets.join("\n");
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function readJsonIfExists(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function buildDefaultConfig() {
  return {
    enabled: true,
    trigger: {
      notifyOnSessionIdle: true,
      notifyOnStatusIdle: false,
      cooldownMs: 60000,
      dedupeWindowMs: 15000,
      requireAssistantMessage: true
    },
    message: {
      mode: "summary",
      title: "OpenCode 입력 가능 알림",
      includeMetadata: false,
      includeRawInCodeBlock: false,
      maxChars: 1900,
      summaryMaxBullets: 8
    },
    discord: {
      botToken: "",
      targets: [],
      mentionUserId: null,
      timeoutMs: 10000,
      sessionThreadsEnabled: true,
      sessionThreadAutoArchiveMinutes: 1440
    },
    environment: {
      labelsByKey: {}
    }
  };
}

function mergeConfig(base, override) {
  if (!isPlainObject(base)) {
    return isPlainObject(override) ? { ...override } : base;
  }

  if (!isPlainObject(override)) {
    return { ...base };
  }

  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const prev = result[key];
    if (isPlainObject(prev) && isPlainObject(value)) {
      result[key] = mergeConfig(prev, value);
      continue;
    }
    result[key] = value;
  }
  return result;
}

function sanitizeTargets(rawTargets) {
  if (!Array.isArray(rawTargets)) {
    return [];
  }

  return rawTargets
    .filter((target) => isPlainObject(target))
    .filter((target) => typeof target.type === "string" && typeof target.id === "string")
    .map((target) => ({ type: target.type, id: target.id }));
}

function isPlaceholder(value) {
  const text = String(value ?? "").trim();
  if (!text) {
    return true;
  }

  const upper = text.toUpperCase();
  return upper.includes("PUT_YOUR") || upper.includes("YOUR_") || upper.includes("DISCORD_BOT_TOKEN");
}

function hasUsableDiscordConfig(config) {
  if (isPlaceholder(config.discord.botToken)) {
    return false;
  }

  if (!Array.isArray(config.discord.targets) || config.discord.targets.length === 0) {
    return false;
  }

  return config.discord.targets.every((target) => !isPlaceholder(target.id));
}

function normalizeSessionThreadAutoArchiveMinutes(value) {
  const normalized = Number.isFinite(value) ? Math.round(value) : 1440;
  if (DISCORD_THREAD_AUTO_ARCHIVE_MINUTES.has(normalized)) {
    return normalized;
  }

  return 1440;
}

function normalizeSingleLine(value, maxChars = 120) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return truncateText(text, maxChars);
}

function normalizeEnvironmentLabel(value) {
  return normalizeSingleLine(value, 60);
}

function normalizeEnvironmentKey(value) {
  return normalizeSingleLine(value, 160);
}

function resolveRuntimeEnvironmentKey() {
  const explicit = normalizeEnvironmentKey(process.env.OPENCODE_ENV_KEY);
  if (explicit) {
    return explicit;
  }

  const host = normalizeSingleLine(
    process.env.OPENCODE_ENV_HOST || process.env.COMPUTERNAME || process.env.HOSTNAME || "unknown-host",
    60
  ).toLowerCase();
  const user = normalizeSingleLine(
    process.env.OPENCODE_ENV_USER || process.env.USERNAME || process.env.USER || "unknown-user",
    60
  ).toLowerCase();

  return `${process.platform}:${host}:${user}`;
}

function sanitizeEnvironmentLabels(rawLabels) {
  if (!isPlainObject(rawLabels)) {
    return {};
  }

  const labelsByKey = {};
  for (const [rawKey, rawLabel] of Object.entries(rawLabels)) {
    const key = normalizeEnvironmentKey(rawKey);
    const label = normalizeEnvironmentLabel(rawLabel);
    if (!key || !label) {
      continue;
    }

    labelsByKey[key] = label;
  }

  return labelsByKey;
}

function resolveEnvironmentRuntime(rawEnvironment) {
  const runtimeKey = resolveRuntimeEnvironmentKey();
  const environment = isPlainObject(rawEnvironment) ? rawEnvironment : {};
  const labelsByKey = sanitizeEnvironmentLabels(environment.labelsByKey);
  const label = labelsByKey[runtimeKey] || "";

  return {
    runtimeKey,
    label,
    requiresSetup: !label
  };
}

function resolveWorkspaceName(directory, worktree) {
  const root = resolve(worktree || directory || process.cwd());
  const name = normalizeSingleLine(basename(root), 80);
  return name || "OpenCode";
}

function resolveOpenCodeUserConfigDirs() {
  const dirs = [];

  const explicit = normalizeSingleLine(process.env.OPENCODE_CONFIG_DIR || process.env.OPENCODE_CONFIG_HOME, 260);
  if (explicit) {
    dirs.push(resolve(explicit));
  }

  const xdgConfigHome = normalizeSingleLine(process.env.XDG_CONFIG_HOME, 260);
  if (xdgConfigHome) {
    dirs.push(join(xdgConfigHome, "opencode"));
  }

  const appData = normalizeSingleLine(process.env.APPDATA, 260);
  if (appData) {
    dirs.push(join(appData, "opencode"));
  }

  const localAppData = normalizeSingleLine(process.env.LOCALAPPDATA, 260);
  if (localAppData) {
    dirs.push(join(localAppData, "opencode"));
  }

  dirs.push(join(homedir(), ".config", "opencode"));
  return [...new Set(dirs)];
}

function extractSessionTitle(event) {
  const props = event?.properties ?? {};
  const candidates = [
    props.info?.title,
    props.info?.session?.title,
    props.info?.sessionTitle,
    props.info?.name,
    props.info?.session?.name,
    props.part?.title,
    props.part?.session?.title,
    props.part?.sessionTitle,
    props.part?.name,
    props.part?.session?.name,
    props.session?.title,
    props.session?.name,
    props.status?.title,
    props.title,
    props.sessionTitle,
    event?.title
  ];

  let genericFallback = "";

  for (const value of candidates) {
    if (typeof value !== "string") {
      continue;
    }

    const normalized = normalizeSingleLine(value);
    if (normalized) {
      if (!isGenericSessionTitle(normalized)) {
        return normalized;
      }

      if (!genericFallback) {
        genericFallback = normalized;
      }
    }
  }

  return genericFallback;
}

function isGenericSessionTitle(value) {
  const normalized = normalizeSingleLine(value, 200).toLowerCase();
  if (!normalized) {
    return true;
  }

  if (
    normalized === "새 작업" ||
    normalized === "새 세션" ||
    normalized === "new task" ||
    normalized === "new session" ||
    normalized === "new chat" ||
    normalized === "untitled"
  ) {
    return true;
  }

  if (/^(new session|child session)\s*-\s*\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}\.\d{3}z$/i.test(normalized)) {
    return true;
  }

  return false;
}

function shouldApplySessionTitle(currentTitle, nextTitle) {
  const nextNormalized = normalizeSingleLine(nextTitle, 200);
  if (!nextNormalized) {
    return false;
  }

  const nextIsGeneric = isGenericSessionTitle(nextNormalized);

  const currentNormalized = normalizeSingleLine(currentTitle, 200);
  if (!currentNormalized) {
    return !nextIsGeneric;
  }

  if (currentNormalized === nextNormalized) {
    return false;
  }

  const currentIsGeneric = isGenericSessionTitle(currentNormalized);

  if (currentIsGeneric && nextIsGeneric) {
    return false;
  }

  if (!currentIsGeneric && nextIsGeneric) {
    return false;
  }

  return true;
}

function isSubagentSessionTitle(value) {
  const title = normalizeSingleLine(value, 240);
  if (!title) {
    return false;
  }

  if (/\(@[a-z0-9_-]+\s+subagent\)/i.test(title)) {
    return true;
  }

  if (/\b@[a-z0-9_-]+\b/i.test(title) && /\bsubagent\b/i.test(title)) {
    return true;
  }

  return false;
}

function isSubagentSessionState(state) {
  if (state?.isChildSession) {
    return true;
  }

  return isSubagentSessionTitle(state?.sessionTitle);
}

function isDelegationToolName(value) {
  const tool = String(value ?? "").trim().toLowerCase();
  if (!tool) {
    return false;
  }

  return (
    tool === "task"
    || tool === "delegate_task"
    || tool === "call_omo_agent"
    || tool === "background_task"
  );
}

function isIntermediateAnalysisMessage(value) {
  const text = normalizeText(value);
  if (!text) {
    return false;
  }

  const hardMarkers = [
    /\[search-mode\]/i,
    /\[analyze-mode\]/i,
    /<analysis>/i,
    /<results>/i,
    /<files>/i,
    /<answer>/i,
    /^\s*goal\*{0,2}\b/im,
    /^\s*definition of done\*{0,2}\b/im,
    /^\s*plan\*{0,2}\b/im,
    /@[a-z0-9_-]+\s+subagent/i,
    /launch multiple background agents/i,
    /do not edit files; rely on repository read\/search only/i
  ];

  if (hardMarkers.some((marker) => marker.test(text))) {
    return true;
  }

  const markers = [
    /literal request\s*:/i,
    /actual need\*{0,2}\s*:/i,
    /success looks like\*{0,2}\s*:/i,
    /opencode\s*-\s*ses_[a-z0-9]+/i,
    /maximize search effort/i
  ];

  let markerHits = 0;
  for (const marker of markers) {
    if (marker.test(text)) {
      markerHits += 1;
    }
  }

  return markerHits >= 2;
}

function pickNormalizedString(candidates, maxChars = 120) {
  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }

    const normalized = normalizeSingleLine(candidate, maxChars);
    if (normalized) {
      return normalized;
    }
  }

  return "";
}

function isLikelyUserInterruptPrompt(value) {
  const text = String(value ?? "").toLowerCase();
  if (!text) {
    return false;
  }

  const positivePattern = /(input|required|enter|token|api[\s_-]?key|choose|choice|select|confirm|permission|approve|approval|respond|reply|prompt|question|manual|승인|선택|입력|토큰|권한|확인|응답|인증)/;
  const negativePattern = /(rate limit|quota|429|network|timeout|timed out|connection|econn|dns|service unavailable|backoff|일시|네트워크|타임아웃|연결|한도)/;
  return positivePattern.test(text) && !negativePattern.test(text);
}

function extractInterruptNotice(event) {
  const props = event?.properties ?? {};
  const eventType = normalizeSingleLine(event?.type, 120);
  const eventTypeLower = eventType.toLowerCase();

  if (!eventTypeLower) {
    return null;
  }

  if (eventTypeLower === "permission.asked" || eventTypeLower === "permission.requested") {
    const permissionName = pickNormalizedString(
      [
        props.permission,
        props.request?.permission,
        props.permission?.name,
        props.permission?.permission,
        props.permission?.type
      ],
      80
    );
    const permissionPattern = pickNormalizedString(
      [
        props.pattern,
        props.permission?.pattern,
        props.request?.pattern
      ],
      120
    );

    const detail = [permissionName, permissionPattern].filter(Boolean).join(" | ");

    return {
      kind: "permission_required",
      eventType,
      detail
    };
  }

  if (eventTypeLower === "session.status" && props.status?.type === "retry") {
    const statusMessage = pickNormalizedString(
      [
        props.status?.message,
        props.status?.reason
      ],
      180
    );

    if (isLikelyUserInterruptPrompt(statusMessage)) {
      return {
        kind: "input_required",
        eventType,
        detail: statusMessage
      };
    }
  }

  const explicitInterruptEvent = (
    eventTypeLower.includes("input.required")
    || eventTypeLower.includes("input.requested")
    || eventTypeLower.includes("interrupt.required")
    || eventTypeLower.includes("question.required")
  );

  if (!explicitInterruptEvent) {
    return null;
  }

  const detail = pickNormalizedString(
    [
      props.prompt?.message,
      props.prompt?.reason,
      props.interrupt?.message,
      props.interrupt?.reason,
      props.reason,
      props.status?.message
    ],
    180
  );

  return {
    kind: "input_required",
    eventType,
    detail
  };
}

function classifyTerminationKind(value) {
  const token = String(value ?? "").toLowerCase();
  if (!token) {
    return null;
  }

  if (/(cancel|cancelled|canceled|abort|aborted|취소)/.test(token)) {
    return "cancelled";
  }

  if (/(interrupt|interrupted|stop|stopped|terminate|terminated|killed|halt|중단|멈춤)/.test(token)) {
    return "interrupted";
  }

  return null;
}

function extractTerminationNotice(event) {
  const props = event?.properties ?? {};
  const candidates = [
    props.status?.type,
    props.status?.reason,
    props.reason,
    props.error?.type,
    props.error?.reason,
    event?.type
  ];

  for (const candidate of candidates) {
    const kind = classifyTerminationKind(candidate);
    if (!kind) {
      continue;
    }

    const detail = normalizeSingleLine(candidate, 60);
    return {
      kind,
      detail
    };
  }

  return null;
}

function buildTerminationBody(notice) {
  const headline = notice.kind === "cancelled"
    ? "- 이번 응답은 사용자가 취소했습니다."
    : "- 이번 응답은 중단되었습니다.";

  if (!notice.detail) {
    return headline;
  }

  const normalizedDetail = notice.detail.toLowerCase();
  if (
    normalizedDetail === "cancel" ||
    normalizedDetail === "cancelled" ||
    normalizedDetail === "canceled" ||
    normalizedDetail === "abort" ||
    normalizedDetail === "aborted" ||
    normalizedDetail === "interrupt" ||
    normalizedDetail === "interrupted" ||
    normalizedDetail === "stop" ||
    normalizedDetail === "stopped" ||
    normalizedDetail === "terminate" ||
    normalizedDetail === "terminated"
  ) {
    return headline;
  }

  return `${headline}\n- 상태: ${notice.detail}`;
}

function buildInterruptBody(notice, state) {
  const kindLabel = notice.kind === "permission_required"
    ? "권한/선택 확인 필요"
    : "사용자 입력 필요";
  const scopeLabel = isSubagentSessionState(state) ? "sub-agent" : "main-agent";

  const lines = [
    "🚨 **INTERRUPT NOTICE**",
    `- 상태: ${kindLabel}`,
    `- 범위: ${scopeLabel}`,
    "- 에이전트가 사용자 응답(선택/토큰 입력/승인)을 기다리는 중입니다."
  ];

  if (notice.eventType) {
    lines.push(`- 이벤트: ${notice.eventType}`);
  }

  if (notice.detail) {
    lines.push(`- 상세: ${notice.detail}`);
  }

  return lines.join("\n");
}

function buildRequestToken(value) {
  const compact = String(value ?? "").replace(/[^a-zA-Z0-9]/g, "");
  if (!compact) {
    return "unknown";
  }

  return compact.slice(-8);
}

function summarizeSubtaskProgress(state) {
  let pending = 0;
  let running = 0;
  let completed = 0;
  let failed = 0;

  for (const item of state.subtaskByCallId.values()) {
    const status = String(item?.status ?? "").toLowerCase();
    if (status === "pending") {
      pending += 1;
      continue;
    }

    if (status === "running") {
      running += 1;
      continue;
    }

    if (status === "completed") {
      completed += 1;
      continue;
    }

    if (status === "error") {
      failed += 1;
    }
  }

  const total = pending + running + completed + failed;
  if (total === 0) {
    return "🧩 하위 작업: 없음";
  }

  const parts = [];
  const working = pending + running;
  if (working > 0) {
    parts.push(`🔄 ${working} 진행중`);
  }
  if (completed > 0) {
    parts.push(`✅ ${completed} 완료`);
  }
  if (failed > 0) {
    parts.push(`❌ ${failed} 실패`);
  }

  return `🧩 하위 작업: ${parts.join(" / ")}`;
}

function buildProgressMessageBody(state, phase, options = {}) {
  const requestToken = buildRequestToken(state.currentRequestId);
  const promptPreview = normalizeSingleLine(state.currentRequestPreview, 160);
  const subtaskSummary = summarizeSubtaskProgress(state);
  const detail = normalizeSingleLine(options.detail, 180);
  const elapsedMs = Number.isFinite(options.elapsedMs) ? options.elapsedMs : null;
  const startedAt = Number.isFinite(state.currentRequestStartedAt) && state.currentRequestStartedAt > 0
    ? new Date(state.currentRequestStartedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })
    : "측정 불가";

  if (phase === "waiting_user") {
    const lines = [
      "🟠 사용자 응답 대기",
      `- 요청: #${requestToken}`,
      "- 상태: 선택/토큰 입력/승인 응답을 기다리는 중입니다.",
      `- ${subtaskSummary}`
    ];

    if (detail) {
      lines.push(`- 상세: ${detail}`);
    }

    return lines.join("\n");
  }

  if (phase === "completed" || phase === "cancelled") {
    const lines = [
      "~~🟡 작업 수행중...~~",
      phase === "cancelled" ? "⚪ 처리 종료(취소/중단)" : "✅ 처리 완료",
      `- 요청: #${requestToken}`,
      `- ${subtaskSummary}`
    ];

    if (elapsedMs !== null) {
      lines.push(`- 경과 시간: ${formatDurationMs(elapsedMs)}`);
    }

    if (detail) {
      lines.push(`- 비고: ${detail}`);
    }

    return lines.join("\n");
  }

  return [
    "🟡 작업 수행중...",
    `- 요청: #${requestToken}`,
    promptPreview ? `- 프롬프트: ${promptPreview}` : "- 프롬프트: (입력 텍스트 수집 중)",
    `- 시작 시각: ${startedAt}`,
    `- ${subtaskSummary}`
  ].join("\n");
}

function buildProgressSnapshotKey(state, phase, options = {}) {
  const detail = normalizeSingleLine(options.detail, 120);
  return [
    phase,
    state.currentRequestId,
    normalizeSingleLine(state.currentRequestPreview, 120),
    summarizeSubtaskProgress(state),
    detail
  ].join("|");
}

function buildTextDedupeKey(value) {
  return normalizeText(value).replace(/\s+/g, " ").trim().slice(0, 800);
}

function normalizeRuntimeConfig(raw) {
  const merged = mergeConfig(buildDefaultConfig(), raw);
  const messageMode = ["raw", "cleaned", "summary"].includes(merged.message?.mode)
    ? merged.message.mode
    : "summary";
  const environment = resolveEnvironmentRuntime(merged.environment);

  return {
    enabled: merged.enabled !== false,
    trigger: {
      notifyOnSessionIdle: merged.trigger?.notifyOnSessionIdle !== false,
      notifyOnStatusIdle: merged.trigger?.notifyOnStatusIdle === true,
      cooldownMs: Number.isFinite(merged.trigger?.cooldownMs) ? merged.trigger.cooldownMs : 60000,
      dedupeWindowMs: Number.isFinite(merged.trigger?.dedupeWindowMs)
        ? Math.min(Math.max(1000, merged.trigger.dedupeWindowMs), 300000)
        : 15000,
      requireAssistantMessage: merged.trigger?.requireAssistantMessage !== false
    },
    message: {
      mode: messageMode,
      title: typeof merged.message?.title === "string" && merged.message.title.trim()
        ? merged.message.title.trim()
        : "OpenCode 입력 가능 알림",
      includeMetadata: merged.message?.includeMetadata === true,
      includeRawInCodeBlock: merged.message?.includeRawInCodeBlock === true,
      maxChars: Number.isFinite(merged.message?.maxChars)
        ? Math.min(Math.max(300, merged.message.maxChars), DISCORD_CONTENT_LIMIT)
        : 1900,
      summaryMaxBullets: Number.isFinite(merged.message?.summaryMaxBullets)
        ? merged.message.summaryMaxBullets
        : 8
    },
    discord: {
      botToken: typeof merged.discord?.botToken === "string" ? merged.discord.botToken : "",
      targets: sanitizeTargets(merged.discord?.targets),
      mentionUserId: typeof merged.discord?.mentionUserId === "string"
        ? merged.discord.mentionUserId
        : null,
      timeoutMs: Number.isFinite(merged.discord?.timeoutMs) ? merged.discord.timeoutMs : 10000,
      sessionThreadsEnabled: merged.discord?.sessionThreadsEnabled !== false,
      sessionThreadAutoArchiveMinutes: normalizeSessionThreadAutoArchiveMinutes(
        merged.discord?.sessionThreadAutoArchiveMinutes
      )
    },
    environment
  };
}

function buildUnregisteredEnvironmentNotice(runtimeKey) {
  return [
    "⚠️ **현재 실행 환경 레이블이 등록되지 않았습니다.**",
    `- 환경 키: \`${truncateText(runtimeKey, 120)}\``,
    "- 해결: `npm run setup`을 실행해서 이 환경의 레이블을 등록해 주세요."
  ].join("\n");
}

function getDisplayEnvironmentLabel(environment) {
  return environment?.label || "미등록 환경";
}

function shouldShowEnvironmentNotice(environment) {
  return Boolean(environment?.requiresSetup && environment?.runtimeKey);
}

function buildHeaderTitle(config, state) {
  const sessionLabel = state.sessionTitle || state.sessionID;
  const sessionHeader = `${state.workspaceName} - ${sessionLabel}`;
  const titlePrefix = normalizeSingleLine(config.message.title, 120);
  const environmentLabel = getDisplayEnvironmentLabel(config.environment);
  const decoratedTitle = titlePrefix
    ? `[${environmentLabel}] ${titlePrefix}`
    : `[${environmentLabel}]`;

  return `${decoratedTitle} | ${sessionHeader}`;
}

function buildSessionThreadCacheKey(parentChannelId, sessionID) {
  return `${parentChannelId}::${sessionID}`;
}

function buildSessionThreadName(state) {
  const workspace = normalizeSingleLine(state.workspaceName, 42) || "OpenCode";
  const sessionLabel = normalizeSingleLine(state.sessionTitle || state.sessionID, 54) || state.sessionID;
  return truncateText(`${workspace} | ${sessionLabel}`, DISCORD_THREAD_NAME_LIMIT);
}

function buildSessionThreadStarterText(state) {
  const sessionLabel = normalizeSingleLine(state.sessionTitle || state.sessionID, 90) || state.sessionID;
  return truncateText(`🧵 OpenCode 세션 스레드 시작: ${sessionLabel}`, 180);
}

function buildTargetKey(target) {
  return `${target.type}:${target.id}`;
}

function canUseSessionThreadForTarget(config, target) {
  return config.discord.sessionThreadsEnabled && target?.type === "channel";
}

function shouldDisableThreadOnError(error) {
  const text = String(error instanceof Error ? error.message : error).toLowerCase();
  return (
    text.includes("(400)")
    || text.includes("(403)")
    || text.includes("missing access")
    || text.includes("missing permissions")
    || text.includes("invalid form body")
  );
}

function shouldRetryThreadCreationViaForumRoute(error) {
  const text = String(error instanceof Error ? error.message : error).toLowerCase();
  return (
    text.includes("(404)")
    || text.includes("(405)")
    || text.includes("channel type")
    || text.includes("cannot execute action")
  );
}

async function resolveConfig(directory, worktree) {
  const cwdRoot = resolve(directory || process.cwd());
  const worktreeRoot = resolve(worktree || cwdRoot);
  const userConfigDirs = resolveOpenCodeUserConfigDirs();

  const candidates = [
    join(worktreeRoot, ".opencode", "opencode-notifier-plugin.json"),
    join(cwdRoot, ".opencode", "opencode-notifier-plugin.json"),
    ...userConfigDirs.map((dir) => join(dir, "opencode-notifier-plugin.json"))
  ];

  for (const candidate of candidates) {
    const loaded = await readJsonIfExists(candidate);
    if (loaded && isPlainObject(loaded)) {
      return normalizeRuntimeConfig(loaded);
    }
  }

  const bridgeCandidates = [
    join(worktreeRoot, "opencode-notifier.config.json"),
    join(cwdRoot, "opencode-notifier.config.json"),
    ...userConfigDirs.map((dir) => join(dir, "opencode-notifier.config.json"))
  ];

  for (const candidate of bridgeCandidates) {
    const loaded = await readJsonIfExists(candidate);
    if (!loaded || !isPlainObject(loaded)) {
      continue;
    }

    const bridgeConfig = {
      enabled: true,
      message: loaded.message,
      discord: loaded.discord,
      environment: loaded.environment,
      trigger: {
        notifyOnSessionIdle: true,
        notifyOnStatusIdle: false,
        cooldownMs: loaded.detection?.cooldownMs,
        dedupeWindowMs: 15000,
        requireAssistantMessage: true
      }
    };

    return normalizeRuntimeConfig(bridgeConfig);
  }

  return normalizeRuntimeConfig({});
}

function buildMessageBody(config, state, triggerKind, options = {}) {
  const terminationNotice = options.terminationNotice ?? null;
  const interruptNotice = options.interruptNotice ?? null;
  const omitHeader = options.omitHeader === true;
  const measuredAt = Number.isFinite(options.measuredAt) ? options.measuredAt : Date.now();
  const elapsedMs = Number.isFinite(options.elapsedMs) && options.elapsedMs >= 0 ? options.elapsedMs : null;
  const normalized = normalizeText(state.lastAssistantText);
  const missing = "마지막 assistant 메시지를 아직 찾지 못했습니다.";
  const headerTitle = buildHeaderTitle(config, state);

  let body = "";
  if (interruptNotice) {
    body = buildInterruptBody(interruptNotice, state);
  } else if (terminationNotice) {
    body = buildTerminationBody(terminationNotice);
  } else {
    body = normalized;
    if (!body) {
      body = config.message.mode === "summary" ? `- ${missing}` : `(${missing})`;
    }

    if (config.message.mode === "summary") {
      body = normalized ? heuristicSummary(normalized, config.message.summaryMaxBullets) : body;
    }
  }

  const sections = [];

  if (!omitHeader) {
    sections.push(`**${headerTitle}**`);
  } else if (state.currentRequestId) {
    sections.push(`- 요청: #${buildRequestToken(state.currentRequestId)}`);
  }

  if (!omitHeader && shouldShowEnvironmentNotice(config.environment)) {
    sections.push(buildUnregisteredEnvironmentNotice(config.environment.runtimeKey));
  }

  if (config.message.includeMetadata) {
    const metadataLines = [
      `- 시간: ${new Date(measuredAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`,
      `- 트리거: ${triggerKind}`,
      `- 모드: ${config.message.mode}`
    ];

    if (elapsedMs !== null) {
      metadataLines.splice(1, 0, `- 경과 시간: ${formatDurationMs(elapsedMs)}`);
    }

    sections.push(
      metadataLines.join("\n")
    );
  }

  sections.push(body);

  if (!terminationNotice && !interruptNotice && config.message.includeRawInCodeBlock && config.message.mode !== "raw") {
    sections.push("**원문**");
    sections.push(`\`\`\`text\n${truncateText(normalized || "(비어 있음)", 700)}\n\`\`\``);
  }

  let content = sections.filter(Boolean).join("\n\n");
  if (config.discord.mentionUserId) {
    content = `<@${config.discord.mentionUserId}>\n${content}`;
  }

  return truncateText(content, config.message.maxChars);
}

function resolveFetchImplementation() {
  if (typeof fetch === "function") {
    return fetch;
  }

  throw new Error("Global fetch is unavailable. Use Node.js 18+ or a runtime with fetch support.");
}

function resolveTimeoutSignal(timeoutMs) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(timeoutMs);
  }

  return undefined;
}

async function discordRequest(config, path, method, body) {
  const fetchImpl = resolveFetchImplementation();
  const response = await fetchImpl(`https://discord.com/api/v10${path}`, {
    method,
    headers: {
      Authorization: `Bot ${config.discord.botToken}`,
      "Content-Type": "application/json"
    },
    signal: resolveTimeoutSignal(config.discord.timeoutMs),
    body: body ? JSON.stringify(body) : undefined
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Discord API ${method} ${path} failed (${response.status}): ${detail}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

function createSessionState(sessionID, workspaceName) {
  return {
    sessionID,
    workspaceName,
    isChildSession: false,
    sessionTitle: "",
    assistantMessageIds: new Set(),
    userMessageIds: new Set(),
    mutedAssistantMessageIds: new Set(),
    delegationMessageIds: new Set(),
    textByMessageId: new Map(),
    statusMessageByTarget: new Map(),
    subtaskByCallId: new Map(),
    lastAssistantMessageId: null,
    lastAssistantText: "",
    currentRequestId: null,
    currentRequestPreview: "",
    currentRequestStartedAt: 0,
    lastProgressSnapshotKey: "",
    lastNotifiedMessageId: null,
    lastNotifiedTextKey: "",
    lastNotifiedAt: 0,
    responseStartedAt: 0,
    lastAssistantUpdatedAt: 0,
    waitingForInputReady: false,
    pendingTerminationNotice: null,
    pendingInterruptNotice: null
  };
}

function getSessionID(event) {
  const props = event?.properties;
  if (typeof props?.sessionID === "string") {
    return props.sessionID;
  }

  if (typeof props?.info?.sessionID === "string") {
    return props.info.sessionID;
  }

  if (typeof props?.part?.sessionID === "string") {
    return props.part.sessionID;
  }

  if (typeof props?.info?.id === "string" && typeof event?.type === "string" && event.type.startsWith("session.")) {
    return props.info.id;
  }

  return null;
}

function createNoopHooks() {
  return {
    event: async () => {}
  };
}

export default async function OpenCodeNotifierPlugin(input) {
  try {
  const config = await resolveConfig(input.directory, input.worktree);
  const workspaceName = resolveWorkspaceName(input.directory, input.worktree);
  const stateBySession = new Map();
  const dmChannelCache = new Map();
  const sessionThreadChannelCache = new Map();
  const threadDisabledParentChannels = new Set();

  if (config.environment.requiresSetup) {
    process.stderr.write(
      [
        "[opencode-notifier-plugin] 현재 실행 환경 레이블이 등록되지 않았습니다.",
        `환경 키: ${config.environment.runtimeKey}`,
        "`npm run setup`을 실행해서 이 환경 레이블을 등록해 주세요."
      ].join(" ") + "\n"
    );
  }

  function getState(sessionID) {
    if (!stateBySession.has(sessionID)) {
      stateBySession.set(sessionID, createSessionState(sessionID, workspaceName));
    }
    return stateBySession.get(sessionID);
  }

  async function createThreadFromMessage(parentChannelId, state) {
    const starterMessage = await discordRequest(config, `/channels/${parentChannelId}/messages`, "POST", {
      content: buildSessionThreadStarterText(state),
      allowed_mentions: {
        parse: [],
        users: []
      }
    });

    if (!starterMessage || typeof starterMessage.id !== "string") {
      throw new Error(`Failed to create starter message for channel ${parentChannelId}`);
    }

    const thread = await discordRequest(config, `/channels/${parentChannelId}/messages/${starterMessage.id}/threads`, "POST", {
      name: buildSessionThreadName(state),
      auto_archive_duration: config.discord.sessionThreadAutoArchiveMinutes
    });

    if (!thread || typeof thread.id !== "string") {
      throw new Error(`Failed to create thread for channel ${parentChannelId}`);
    }

    return thread.id;
  }

  async function createForumThread(parentChannelId, state) {
    const thread = await discordRequest(config, `/channels/${parentChannelId}/threads`, "POST", {
      name: buildSessionThreadName(state),
      auto_archive_duration: config.discord.sessionThreadAutoArchiveMinutes,
      message: {
        content: buildSessionThreadStarterText(state),
        allowed_mentions: {
          parse: [],
          users: []
        }
      }
    });

    if (!thread || typeof thread.id !== "string") {
      throw new Error(`Failed to create forum thread for channel ${parentChannelId}`);
    }

    return thread.id;
  }

  async function createSessionThread(parentChannelId, state) {
    try {
      return await createThreadFromMessage(parentChannelId, state);
    } catch (error) {
      if (!shouldRetryThreadCreationViaForumRoute(error)) {
        throw error;
      }

      return createForumThread(parentChannelId, state);
    }
  }

  async function resolveChannelForTarget(target, state, options = {}) {
    if (target.type === "channel") {
      if (!canUseSessionThreadForTarget(config, target) || !state?.sessionID) {
        return target.id;
      }

      const cacheKey = buildSessionThreadCacheKey(target.id, state.sessionID);
      if (options.forceRefreshThread) {
        sessionThreadChannelCache.delete(cacheKey);
      }

      if (!options.forceRefreshThread && sessionThreadChannelCache.has(cacheKey)) {
        return sessionThreadChannelCache.get(cacheKey);
      }

      if (threadDisabledParentChannels.has(target.id) && !options.forceRefreshThread) {
        return target.id;
      }

      try {
        const threadChannelId = await createSessionThread(target.id, state);
        sessionThreadChannelCache.set(cacheKey, threadChannelId);
        return threadChannelId;
      } catch (error) {
        if (shouldDisableThreadOnError(error)) {
          threadDisabledParentChannels.add(target.id);
        }

        process.stderr.write(
          `[opencode-notifier-plugin] 세션 스레드 생성에 실패해 기본 채널로 전송합니다: ${error instanceof Error ? error.message : String(error)}\n`
        );
        return target.id;
      }
    }

    if (target.type !== "user") {
      throw new Error(`Unknown target type: ${target.type}`);
    }

    if (dmChannelCache.has(target.id)) {
      return dmChannelCache.get(target.id);
    }

    const channel = await discordRequest(config, "/users/@me/channels", "POST", {
      recipient_id: target.id
    });

    if (!channel || typeof channel.id !== "string") {
      throw new Error(`Failed to resolve DM channel for user ${target.id}`);
    }

    dmChannelCache.set(target.id, channel.id);
    return channel.id;
  }

  function buildDiscordPayload(content, allowMention = false) {
    return {
      content: truncateText(content, DISCORD_CONTENT_LIMIT),
      allowed_mentions: {
        parse: [],
        users: allowMention && config.discord.mentionUserId ? [config.discord.mentionUserId] : []
      }
    };
  }

  async function postChannelMessage(channelId, content, allowMention = false) {
    return discordRequest(config, `/channels/${channelId}/messages`, "POST", buildDiscordPayload(content, allowMention));
  }

  async function editChannelMessage(channelId, messageId, content) {
    return discordRequest(config, `/channels/${channelId}/messages/${messageId}`, "PATCH", buildDiscordPayload(content, false));
  }

  async function withTargetChannel(target, state, handler) {
    const useSessionThread = canUseSessionThreadForTarget(config, target);
    let firstError = null;

    for (let attempt = 0; attempt < (useSessionThread ? 2 : 1); attempt += 1) {
      const channelId = await resolveChannelForTarget(target, state, {
        forceRefreshThread: useSessionThread && attempt > 0
      });
      const isThreadChannel = target.type === "channel" && channelId !== target.id;

      try {
        return await handler({ channelId, isThreadChannel });
      } catch (error) {
        if (!firstError) {
          firstError = error;
        }

        if (!useSessionThread || attempt > 0) {
          throw error;
        }
      }
    }

    if (firstError) {
      throw firstError;
    }

    return null;
  }

  async function sendNotification(state, triggerKind, messageOptions) {
    for (const target of config.discord.targets) {
      await withTargetChannel(target, state, async ({ channelId, isThreadChannel }) => {
        const content = buildMessageBody(config, state, triggerKind, {
          ...messageOptions,
          omitHeader: isThreadChannel
        });
        await postChannelMessage(channelId, content, true);
      });
    }
  }

  async function upsertProgressStatus(state, phase, options = {}) {
    if (!config.enabled || !hasUsableDiscordConfig(config) || !state.currentRequestId) {
      return;
    }

    const snapshotKey = buildProgressSnapshotKey(state, phase, options);
    const forceUpdate = phase === "completed" || phase === "cancelled" || phase === "waiting_user";
    if (!forceUpdate && snapshotKey === state.lastProgressSnapshotKey) {
      return;
    }
    state.lastProgressSnapshotKey = snapshotKey;

    for (const target of config.discord.targets) {
      await withTargetChannel(target, state, async ({ channelId }) => {
        const targetKey = buildTargetKey(target);
        const entry = state.statusMessageByTarget.get(targetKey);
        const content = buildProgressMessageBody(state, phase, options);

        if (
          entry
          && entry.requestId === state.currentRequestId
          && entry.channelId === channelId
          && typeof entry.messageId === "string"
          && entry.messageId
        ) {
          try {
            await editChannelMessage(channelId, entry.messageId, content);
            return;
          } catch {
            // ignore and recreate below
          }
        }

        const sent = await postChannelMessage(channelId, content, false);
        if (sent && typeof sent.id === "string" && sent.id) {
          state.statusMessageByTarget.set(targetKey, {
            requestId: state.currentRequestId,
            channelId,
            messageId: sent.id
          });
        }
      });
    }
  }

  async function notifyIfReady(state, triggerKind) {
    if (!config.enabled) {
      return;
    }

    if (!hasUsableDiscordConfig(config)) {
      return;
    }

    const terminationNotice = state.pendingTerminationNotice;
    const interruptNotice = state.pendingInterruptNotice;

    if (isSubagentSessionState(state) && !interruptNotice) {
      return;
    }

    if (!state.waitingForInputReady && !terminationNotice && !interruptNotice) {
      return;
    }

    const now = Date.now();
    if (!interruptNotice && now - state.lastNotifiedAt < config.trigger.cooldownMs) {
      return;
    }

    if (!terminationNotice && !interruptNotice && config.trigger.requireAssistantMessage && !state.lastAssistantMessageId) {
      return;
    }

    if (!terminationNotice && !interruptNotice && isIntermediateAnalysisMessage(state.lastAssistantText)) {
      return;
    }

    if (
      !terminationNotice &&
      !interruptNotice &&
      state.lastAssistantMessageId &&
      state.lastAssistantMessageId === state.lastNotifiedMessageId
    ) {
      return;
    }

    if (
      !terminationNotice &&
      !interruptNotice &&
      state.lastAssistantMessageId &&
      state.delegationMessageIds.has(state.lastAssistantMessageId)
    ) {
      return;
    }

    const currentTextKey = interruptNotice
      ? `interrupt:${interruptNotice.kind}:${interruptNotice.eventType || ""}:${interruptNotice.detail || ""}`
      : terminationNotice
      ? `termination:${terminationNotice.kind}:${terminationNotice.detail || ""}`
      : buildTextDedupeKey(state.lastAssistantText);

    if (
      currentTextKey &&
      currentTextKey === state.lastNotifiedTextKey &&
      now - state.lastNotifiedAt < config.trigger.dedupeWindowMs
    ) {
      return;
    }

    const startedAt = state.responseStartedAt || state.lastAssistantUpdatedAt;
    const elapsedMs = startedAt > 0 ? Math.max(0, now - startedAt) : null;

    const messageOptions = {
      terminationNotice,
      interruptNotice,
      measuredAt: now,
      elapsedMs
    };
    await sendNotification(state, triggerKind, messageOptions);

    try {
      if (interruptNotice) {
        await upsertProgressStatus(state, "waiting_user", {
          detail: interruptNotice.detail || interruptNotice.eventType,
          elapsedMs
        });
      } else if (state.currentRequestId) {
        const phase = terminationNotice ? "cancelled" : "completed";
        await upsertProgressStatus(state, phase, {
          detail: terminationNotice?.detail || "",
          elapsedMs
        });

        state.currentRequestId = null;
        state.currentRequestPreview = "";
        state.currentRequestStartedAt = 0;
        state.subtaskByCallId.clear();
        state.userMessageIds.clear();
        state.lastProgressSnapshotKey = "";
      }
    } catch (error) {
      process.stderr.write(`[opencode-notifier-plugin] ${error instanceof Error ? error.message : String(error)}\n`);
    }

    state.lastNotifiedAt = now;
    state.lastNotifiedMessageId = state.lastAssistantMessageId;
    state.lastNotifiedTextKey = currentTextKey;
    state.responseStartedAt = 0;
    state.lastAssistantUpdatedAt = 0;
    state.waitingForInputReady = false;
    state.pendingTerminationNotice = null;
    state.pendingInterruptNotice = null;
  }

  return {
    event: async ({ event }) => {
      const sessionID = getSessionID(event);
      if (!sessionID) {
        return;
      }

      const state = getState(sessionID);
      const props = event.properties ?? {};
      const sessionTitle = extractSessionTitle(event);

      if (shouldApplySessionTitle(state.sessionTitle, sessionTitle)) {
        state.sessionTitle = sessionTitle;
      }

      const interruptNotice = extractInterruptNotice(event);
      if (interruptNotice) {
        state.pendingInterruptNotice = interruptNotice;
        state.waitingForInputReady = true;

        try {
          await upsertProgressStatus(state, "waiting_user", {
            detail: interruptNotice.detail || interruptNotice.eventType
          });
        } catch (error) {
          process.stderr.write(`[opencode-notifier-plugin] ${error instanceof Error ? error.message : String(error)}\n`);
        }

        try {
          await notifyIfReady(state, `interrupt: ${interruptNotice.kind}`);
        } catch (error) {
          process.stderr.write(`[opencode-notifier-plugin] ${error instanceof Error ? error.message : String(error)}\n`);
        }
        return;
      }

      if (
        (event.type === "session.created" || event.type === "session.updated")
        && typeof props.info?.parentID === "string"
        && props.info.parentID.trim()
      ) {
        state.isChildSession = true;
      }

      if (isSubagentSessionState(state)) {
        state.waitingForInputReady = false;
        state.pendingTerminationNotice = null;
        state.pendingInterruptNotice = null;
        return;
      }

      if (event.type === "message.updated") {
        const info = props.info;

        if (info?.role === "user" && typeof info.id === "string") {
          const now = Date.now();
          state.userMessageIds.add(info.id);
          state.currentRequestId = info.id;
          state.currentRequestStartedAt = now;
          state.currentRequestPreview = "";
          state.subtaskByCallId.clear();
          state.lastProgressSnapshotKey = "";

          const cachedPrompt = state.textByMessageId.get(info.id);
          if (typeof cachedPrompt === "string" && cachedPrompt.trim()) {
            state.currentRequestPreview = cachedPrompt;
          }

          try {
            await upsertProgressStatus(state, "started");
          } catch (error) {
            process.stderr.write(`[opencode-notifier-plugin] ${error instanceof Error ? error.message : String(error)}\n`);
          }

          return;
        }

        if (info?.role === "assistant" && typeof info.id === "string") {
          const now = Date.now();

          if (typeof info.agent === "string" && /-junior\b/i.test(info.agent)) {
            state.isChildSession = true;
          }

          state.assistantMessageIds.add(info.id);
          state.waitingForInputReady = false;
          state.pendingTerminationNotice = null;
          state.pendingInterruptNotice = null;

          if (!state.responseStartedAt) {
            state.responseStartedAt = now;
          }

          const cachedText = state.textByMessageId.get(info.id);
          if (typeof cachedText === "string" && cachedText.trim()) {
            if (isIntermediateAnalysisMessage(cachedText)) {
              state.mutedAssistantMessageIds.add(info.id);
              return;
            }

            state.mutedAssistantMessageIds.delete(info.id);
            state.lastAssistantMessageId = info.id;
            state.lastAssistantText = cachedText;
            state.lastAssistantUpdatedAt = now;
            state.waitingForInputReady = (
              info.id !== state.lastNotifiedMessageId
              && !state.delegationMessageIds.has(info.id)
            );
          }
        }
        return;
      }

      if (event.type === "message.part.updated") {
        const part = props.part;
        if (part?.type === "tool" && typeof part.messageID === "string") {
          if (isDelegationToolName(part.tool)) {
            state.delegationMessageIds.add(part.messageID);

            const rawStatus = normalizeSingleLine(part.state?.status, 40).toLowerCase();
            const status = ["pending", "running", "completed", "error"].includes(rawStatus)
              ? rawStatus
              : "running";
            const callID = typeof part.callID === "string" && part.callID
              ? part.callID
              : `${part.messageID}:${part.tool}`;
            state.subtaskByCallId.set(callID, {
              status,
              tool: part.tool
            });

            if (state.lastAssistantMessageId === part.messageID) {
              state.waitingForInputReady = false;
            }

            if (state.currentRequestId) {
              try {
                await upsertProgressStatus(state, "in_progress");
              } catch (error) {
                process.stderr.write(`[opencode-notifier-plugin] ${error instanceof Error ? error.message : String(error)}\n`);
              }
            }
          }
          return;
        }

        if (part?.type === "subtask") {
          if (state.currentRequestId) {
            const subtaskID = typeof part.id === "string" && part.id
              ? part.id
              : `${state.currentRequestId}:subtask:${state.subtaskByCallId.size + 1}`;
            state.subtaskByCallId.set(subtaskID, {
              status: "running",
              tool: typeof part.agent === "string" ? part.agent : "subtask"
            });

            try {
              await upsertProgressStatus(state, "in_progress");
            } catch (error) {
              process.stderr.write(`[opencode-notifier-plugin] ${error instanceof Error ? error.message : String(error)}\n`);
            }
          }
          return;
        }

        if (part?.type !== "text" || typeof part.messageID !== "string") {
          return;
        }

        const now = Date.now();
        const nextText = normalizeText(part.text ?? "");
        state.textByMessageId.set(part.messageID, nextText);

        if (state.currentRequestId === part.messageID && state.userMessageIds.has(part.messageID)) {
          state.currentRequestPreview = nextText;

          try {
            await upsertProgressStatus(state, "in_progress");
          } catch (error) {
            process.stderr.write(`[opencode-notifier-plugin] ${error instanceof Error ? error.message : String(error)}\n`);
          }
        }

        if (state.assistantMessageIds.has(part.messageID) || state.lastAssistantMessageId === part.messageID) {
          if (!state.responseStartedAt) {
            state.responseStartedAt = now;
          }

          if (isIntermediateAnalysisMessage(nextText)) {
            state.mutedAssistantMessageIds.add(part.messageID);
            if (state.lastAssistantMessageId === part.messageID) {
              state.lastAssistantMessageId = null;
              state.lastAssistantText = "";
            }
            state.waitingForInputReady = false;
            return;
          }

          state.mutedAssistantMessageIds.delete(part.messageID);
          state.lastAssistantMessageId = part.messageID;
          state.lastAssistantText = nextText;
          state.lastAssistantUpdatedAt = now;
          state.waitingForInputReady = (
            part.messageID !== state.lastNotifiedMessageId
            && !state.delegationMessageIds.has(part.messageID)
          );
          state.pendingTerminationNotice = null;
          state.pendingInterruptNotice = null;
        }
        return;
      }

      if (event.type === "session.status") {
        const statusType = props.status?.type;

        const terminationNotice = extractTerminationNotice(event);
        if (terminationNotice) {
          state.pendingTerminationNotice = terminationNotice;
          state.pendingInterruptNotice = null;
          state.waitingForInputReady = true;

          try {
            await notifyIfReady(state, `session.status: ${statusType || terminationNotice.kind}`);
          } catch (error) {
            process.stderr.write(`[opencode-notifier-plugin] ${error instanceof Error ? error.message : String(error)}\n`);
          }
          return;
        }

        if (statusType === "busy" || statusType === "retry") {
          state.responseStartedAt = Date.now();
          state.waitingForInputReady = state.lastAssistantMessageId !== state.lastNotifiedMessageId;
          state.pendingTerminationNotice = null;
          state.pendingInterruptNotice = null;
          return;
        }

        if (statusType === "idle" && config.trigger.notifyOnStatusIdle) {
          try {
            await notifyIfReady(state, "session.status: idle");
          } catch (error) {
            process.stderr.write(`[opencode-notifier-plugin] ${error instanceof Error ? error.message : String(error)}\n`);
          }
        }
        return;
      }

      const terminationNotice = extractTerminationNotice(event);
      if (terminationNotice) {
        state.pendingTerminationNotice = terminationNotice;
        state.pendingInterruptNotice = null;
        state.waitingForInputReady = true;

        try {
          await notifyIfReady(state, event.type);
        } catch (error) {
          process.stderr.write(`[opencode-notifier-plugin] ${error instanceof Error ? error.message : String(error)}\n`);
        }
        return;
      }

      if (event.type === "session.idle" && config.trigger.notifyOnSessionIdle) {
        try {
          await notifyIfReady(state, "session.idle");
        } catch (error) {
          process.stderr.write(`[opencode-notifier-plugin] ${error instanceof Error ? error.message : String(error)}\n`);
        }
      }
    }
  };
  } catch (error) {
    process.stderr.write(
      `[opencode-notifier-plugin] 플러그인 초기화 실패: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return createNoopHooks();
  }
}
