import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const DISCORD_CONTENT_LIMIT = 2000;

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
      timeoutMs: 10000
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
      timeoutMs: Number.isFinite(merged.discord?.timeoutMs) ? merged.discord.timeoutMs : 10000
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
  const measuredAt = Number.isFinite(options.measuredAt) ? options.measuredAt : Date.now();
  const elapsedMs = Number.isFinite(options.elapsedMs) && options.elapsedMs >= 0 ? options.elapsedMs : null;
  const normalized = normalizeText(state.lastAssistantText);
  const missing = "마지막 assistant 메시지를 아직 찾지 못했습니다.";
  const headerTitle = buildHeaderTitle(config, state);

  let body = "";
  if (terminationNotice) {
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

  const sections = [`**${headerTitle}**`];

  if (shouldShowEnvironmentNotice(config.environment)) {
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

  if (!terminationNotice && config.message.includeRawInCodeBlock && config.message.mode !== "raw") {
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
    sessionTitle: "",
    assistantMessageIds: new Set(),
    mutedAssistantMessageIds: new Set(),
    textByMessageId: new Map(),
    lastAssistantMessageId: null,
    lastAssistantText: "",
    lastNotifiedMessageId: null,
    lastNotifiedTextKey: "",
    lastNotifiedAt: 0,
    responseStartedAt: 0,
    lastAssistantUpdatedAt: 0,
    waitingForInputReady: false,
    pendingTerminationNotice: null
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

  async function resolveChannelForTarget(target) {
    if (target.type === "channel") {
      return target.id;
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

  async function sendNotification(content) {
    const payload = {
      content: truncateText(content, DISCORD_CONTENT_LIMIT),
      allowed_mentions: {
        parse: [],
        users: config.discord.mentionUserId ? [config.discord.mentionUserId] : []
      }
    };

    for (const target of config.discord.targets) {
      const channelId = await resolveChannelForTarget(target);
      await discordRequest(config, `/channels/${channelId}/messages`, "POST", payload);
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

    if (isSubagentSessionTitle(state.sessionTitle)) {
      return;
    }

    if (!state.waitingForInputReady && !terminationNotice) {
      return;
    }

    const now = Date.now();
    if (now - state.lastNotifiedAt < config.trigger.cooldownMs) {
      return;
    }

    if (!terminationNotice && config.trigger.requireAssistantMessage && !state.lastAssistantMessageId) {
      return;
    }

    if (!terminationNotice && isIntermediateAnalysisMessage(state.lastAssistantText)) {
      return;
    }

    if (
      !terminationNotice &&
      state.lastAssistantMessageId &&
      state.lastAssistantMessageId === state.lastNotifiedMessageId
    ) {
      return;
    }

    const currentTextKey = terminationNotice
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

    const content = buildMessageBody(config, state, triggerKind, {
      terminationNotice,
      measuredAt: now,
      elapsedMs
    });
    await sendNotification(content);
    state.lastNotifiedAt = now;
    state.lastNotifiedMessageId = state.lastAssistantMessageId;
    state.lastNotifiedTextKey = currentTextKey;
    state.responseStartedAt = 0;
    state.lastAssistantUpdatedAt = 0;
    state.waitingForInputReady = false;
    state.pendingTerminationNotice = null;
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

      if (isSubagentSessionTitle(state.sessionTitle)) {
        state.waitingForInputReady = false;
        state.pendingTerminationNotice = null;
        return;
      }

      if (event.type === "message.updated") {
        const info = props.info;
        if (info?.role === "assistant" && typeof info.id === "string") {
          const now = Date.now();

          state.assistantMessageIds.add(info.id);
          state.waitingForInputReady = false;
          state.pendingTerminationNotice = null;

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
            state.waitingForInputReady = info.id !== state.lastNotifiedMessageId;
          }
        }
        return;
      }

      if (event.type === "message.part.updated") {
        const part = props.part;
        if (part?.type !== "text" || typeof part.messageID !== "string") {
          return;
        }

        const now = Date.now();
        const nextText = normalizeText(part.text ?? "");
        state.textByMessageId.set(part.messageID, nextText);

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
          state.waitingForInputReady = part.messageID !== state.lastNotifiedMessageId;
          state.pendingTerminationNotice = null;
        }
        return;
      }

      if (event.type === "session.status") {
        const statusType = props.status?.type;

        const terminationNotice = extractTerminationNotice(event);
        if (terminationNotice) {
          state.pendingTerminationNotice = terminationNotice;
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
