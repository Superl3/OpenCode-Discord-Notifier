import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

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

function buildTextDedupeKey(value) {
  return normalizeText(value).replace(/\s+/g, " ").trim().slice(0, 800);
}

function normalizeRuntimeConfig(raw) {
  const merged = mergeConfig(buildDefaultConfig(), raw);
  const messageMode = ["raw", "cleaned", "summary"].includes(merged.message?.mode)
    ? merged.message.mode
    : "summary";

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
    }
  };
}

async function resolveConfig(directory, worktree) {
  const cwdRoot = resolve(directory || process.cwd());
  const worktreeRoot = resolve(worktree || cwdRoot);
  const userConfigDir = join(homedir(), ".config", "opencode");

  const candidates = [
    join(worktreeRoot, ".opencode", "opencode-notifier-plugin.json"),
    join(cwdRoot, ".opencode", "opencode-notifier-plugin.json"),
    join(userConfigDir, "opencode-notifier-plugin.json")
  ];

  for (const candidate of candidates) {
    const loaded = await readJsonIfExists(candidate);
    if (loaded && isPlainObject(loaded)) {
      return normalizeRuntimeConfig(loaded);
    }
  }

  const bridgeCandidates = [
    join(worktreeRoot, "opencode-notifier.config.json"),
    join(cwdRoot, "opencode-notifier.config.json")
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

function buildMessageBody(config, state, triggerKind) {
  const normalized = normalizeText(state.lastAssistantText);
  const missing = "마지막 assistant 메시지를 아직 찾지 못했습니다.";

  let body = normalized;
  if (!body) {
    body = config.message.mode === "summary" ? `- ${missing}` : `(${missing})`;
  }

  if (config.message.mode === "summary") {
    body = normalized ? heuristicSummary(normalized, config.message.summaryMaxBullets) : body;
  }

  const sections = [`**${config.message.title}**`];

  if (config.message.includeMetadata) {
    sections.push(
      [
        `- 시간: ${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`,
        `- 트리거: ${triggerKind}`,
        `- 세션: ${state.sessionID}`,
        `- 모드: ${config.message.mode}`
      ].join("\n")
    );
  }

  sections.push(config.message.mode === "summary" ? "**요약된 마지막 메시지**" : "**마지막 메시지**");
  sections.push(body);

  if (config.message.includeRawInCodeBlock && config.message.mode !== "raw") {
    sections.push("**원문**");
    sections.push(`\`\`\`text\n${truncateText(normalized || "(비어 있음)", 700)}\n\`\`\``);
  }

  let content = sections.filter(Boolean).join("\n\n");
  if (config.discord.mentionUserId) {
    content = `<@${config.discord.mentionUserId}>\n${content}`;
  }

  return truncateText(content, config.message.maxChars);
}

async function discordRequest(config, path, method, body) {
  const response = await fetch(`https://discord.com/api/v10${path}`, {
    method,
    headers: {
      Authorization: `Bot ${config.discord.botToken}`,
      "Content-Type": "application/json"
    },
    signal: AbortSignal.timeout(config.discord.timeoutMs),
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

function createSessionState(sessionID) {
  return {
    sessionID,
    assistantMessageIds: new Set(),
    textByMessageId: new Map(),
    lastAssistantMessageId: null,
    lastAssistantText: "",
    lastNotifiedMessageId: null,
    lastNotifiedTextKey: "",
    lastNotifiedAt: 0,
    waitingForInputReady: false
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

  return null;
}

export default async function OpenCodeNotifierPlugin(input) {
  const config = await resolveConfig(input.directory, input.worktree);
  const stateBySession = new Map();
  const dmChannelCache = new Map();

  function getState(sessionID) {
    if (!stateBySession.has(sessionID)) {
      stateBySession.set(sessionID, createSessionState(sessionID));
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

    if (!state.waitingForInputReady) {
      return;
    }

    const now = Date.now();
    if (now - state.lastNotifiedAt < config.trigger.cooldownMs) {
      return;
    }

    if (config.trigger.requireAssistantMessage && !state.lastAssistantMessageId) {
      return;
    }

    if (state.lastAssistantMessageId && state.lastAssistantMessageId === state.lastNotifiedMessageId) {
      return;
    }

    const currentTextKey = buildTextDedupeKey(state.lastAssistantText);
    if (
      currentTextKey &&
      currentTextKey === state.lastNotifiedTextKey &&
      now - state.lastNotifiedAt < config.trigger.dedupeWindowMs
    ) {
      return;
    }

    const content = buildMessageBody(config, state, triggerKind);
    await sendNotification(content);
    state.lastNotifiedAt = Date.now();
    state.lastNotifiedMessageId = state.lastAssistantMessageId;
    state.lastNotifiedTextKey = currentTextKey;
    state.waitingForInputReady = false;
  }

  return {
    event: async ({ event }) => {
      const sessionID = getSessionID(event);
      if (!sessionID) {
        return;
      }

      const state = getState(sessionID);
      const props = event.properties ?? {};

      if (event.type === "message.updated") {
        const info = props.info;
        if (info?.role === "assistant" && typeof info.id === "string") {
          state.assistantMessageIds.add(info.id);
          state.lastAssistantMessageId = info.id;
          state.waitingForInputReady = info.id !== state.lastNotifiedMessageId;

          const cachedText = state.textByMessageId.get(info.id);
          if (typeof cachedText === "string" && cachedText.trim()) {
            state.lastAssistantText = cachedText;
          }
        }
        return;
      }

      if (event.type === "message.part.updated") {
        const part = props.part;
        if (part?.type !== "text" || typeof part.messageID !== "string") {
          return;
        }

        const nextText = normalizeText(part.text ?? "");
        state.textByMessageId.set(part.messageID, nextText);

        if (state.assistantMessageIds.has(part.messageID) || state.lastAssistantMessageId === part.messageID) {
          state.lastAssistantText = nextText;
          state.waitingForInputReady = part.messageID !== state.lastNotifiedMessageId;
        }
        return;
      }

      if (event.type === "session.status") {
        const statusType = props.status?.type;
        if (statusType === "busy" || statusType === "retry") {
          state.waitingForInputReady = state.lastAssistantMessageId !== state.lastNotifiedMessageId;
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

      if (event.type === "session.idle" && config.trigger.notifyOnSessionIdle) {
        try {
          await notifyIfReady(state, "session.idle");
        } catch (error) {
          process.stderr.write(`[opencode-notifier-plugin] ${error instanceof Error ? error.message : String(error)}\n`);
        }
      }
    }
  };
}
