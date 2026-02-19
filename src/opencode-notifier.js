#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { delimiter, resolve } from "node:path";
import { createInterface } from "node:readline";

const DISCORD_CONTENT_LIMIT = 2000;
const DEFAULT_CONFIG_PATH = "opencode-notifier.config.json";
const DEFAULT_MAX_BUFFER_LINES = 800;
const DEFAULT_COMMAND_CANDIDATES = ["opencode", "oh-my-opencode", "opencode-cli"];

const DEFAULT_BUILD_COMPLETE_PATTERNS = [
  "build complete",
  "build completed",
  "completed successfully",
  "all checks passed"
];

const DEFAULT_WAITING_INPUT_PATTERNS = [
  "waiting for input",
  "ready for input",
  "user input required",
  "type your message"
];

function logInfo(message) {
  process.stderr.write(`[notifier] ${message}\n`);
}

function logError(message) {
  process.stderr.write(`[notifier:error] ${message}\n`);
}

function printHelp() {
  process.stdout.write(
    [
      "OpenCode Discord Notifier",
      "",
      "Usage:",
      "  npm run start -- --config ./opencode-notifier.config.json -- opencode",
      "  npm run start -- --config ./opencode-notifier.config.json",
      "",
      "Options:",
      "  --config <path>   Config file path (default: opencode-notifier.config.json)",
      "  --profile <name>  Config profile name (from config.profiles)",
      "  --dry-run         Do not call Discord API; print payload only",
      "  --once            Send only the first notification after process starts",
      "  -h, --help        Show this help",
      "",
      "Command override:",
      "  Use '--' to override command from config",
      "  Example: npm run start -- --config ./opencode-notifier.config.json -- opencode --model fast"
    ].join("\n") + "\n"
  );
}

function parseArgs(argv) {
  const parsed = {
    configPath: DEFAULT_CONFIG_PATH,
    dryRun: false,
    once: false,
    profile: null,
    commandOverride: null
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === "--") {
      const command = argv[i + 1];
      if (!command) {
        throw new Error("Expected a command after '--'.");
      }

      parsed.commandOverride = {
        command,
        args: argv.slice(i + 2)
      };
      return parsed;
    }

    if (token === "--help" || token === "-h") {
      printHelp();
      process.exit(0);
    }

    if (token === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }

    if (token === "--once") {
      parsed.once = true;
      continue;
    }

    if (token === "--profile") {
      const next = argv[i + 1];
      if (!next) {
        throw new Error("Missing value for --profile.");
      }
      parsed.profile = next;
      i += 1;
      continue;
    }

    if (token.startsWith("--profile=")) {
      parsed.profile = token.slice("--profile=".length);
      continue;
    }

    if (token === "--config") {
      const next = argv[i + 1];
      if (!next) {
        throw new Error("Missing value for --config.");
      }
      parsed.configPath = next;
      i += 1;
      continue;
    }

    if (token.startsWith("--config=")) {
      parsed.configPath = token.slice("--config=".length);
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  return parsed;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseRegExpLiteral(value) {
  if (typeof value !== "string") {
    return null;
  }

  if (!value.startsWith("/") || value.lastIndexOf("/") === 0) {
    return null;
  }

  const lastSlash = value.lastIndexOf("/");
  const body = value.slice(1, lastSlash);
  const flags = value.slice(lastSlash + 1);

  if (!body) {
    return null;
  }

  return new RegExp(body, flags || "i");
}

function toRegExp(value) {
  if (value instanceof RegExp) {
    return value;
  }

  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Pattern values must be non-empty strings.");
  }

  const literal = parseRegExpLiteral(value);
  if (literal) {
    return literal;
  }

  return new RegExp(escapeRegExp(value), "i");
}

function compilePatternList(values, fallback) {
  const source = Array.isArray(values) && values.length > 0 ? values : fallback;
  return source.map((pattern) => toRegExp(pattern));
}

function safeTest(regex, input) {
  regex.lastIndex = 0;
  return regex.test(input);
}

function matchesAny(input, patterns) {
  if (!input) {
    return false;
  }

  for (const pattern of patterns) {
    if (safeTest(pattern, input)) {
      return true;
    }
  }

  return false;
}

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function normalizeMultilineText(value) {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncateText(value, maxChars) {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function normalizeSingleLine(value, maxChars = 120) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }

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

function normalizeBufferLine(line) {
  return stripAnsi(line).replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
}

function isIntermediateAnalysisMessage(value) {
  const text = normalizeMultilineText(String(value ?? ""));
  if (!text) {
    return false;
  }

  const hardMarkers = [
    /\[search-mode\]/i,
    /\[analyze-mode\]/i,
    /<analysis>/i,
    /launch multiple background agents/i,
    /do not edit files; rely on repository read\/search only/i
  ];

  if (hardMarkers.some((marker) => marker.test(text))) {
    return true;
  }

  const softMarkers = [
    /literal request\s*:/i,
    /actual need\*{0,2}\s*:/i,
    /success looks like\*{0,2}\s*:/i,
    /maximize search effort/i,
    /opencode\s*-\s*ses_[a-z0-9]+/i
  ];

  let markerHits = 0;
  for (const marker of softMarkers) {
    if (marker.test(text)) {
      markerHits += 1;
    }
  }

  return markerHits >= 2;
}

function heuristicSummary(text, maxBullets) {
  const cleaned = normalizeMultilineText(text)
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

function parseJsonObject(text) {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Config root must be an object.");
  }
  return parsed;
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
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

function deepMerge(base, override) {
  if (!isPlainObject(base)) {
    return isPlainObject(override) ? { ...override } : override;
  }

  if (!isPlainObject(override)) {
    return { ...base };
  }

  const merged = { ...base };
  for (const [key, nextValue] of Object.entries(override)) {
    const prevValue = merged[key];

    if (isPlainObject(prevValue) && isPlainObject(nextValue)) {
      merged[key] = deepMerge(prevValue, nextValue);
      continue;
    }

    merged[key] = nextValue;
  }

  return merged;
}

function uniqueNonEmptyStrings(values) {
  const result = [];
  const seen = new Set();

  for (const raw of Array.isArray(values) ? values : []) {
    if (typeof raw !== "string") {
      continue;
    }

    const value = raw.trim();
    if (!value || seen.has(value)) {
      continue;
    }

    seen.add(value);
    result.push(value);
  }

  return result;
}

function applyProfile(config, profileName) {
  if (!profileName) {
    return config;
  }

  const profiles = isPlainObject(config?.profiles) ? config.profiles : null;
  if (!profiles) {
    throw new Error("--profile 옵션을 사용했지만 config.profiles가 없습니다.");
  }

  const selected = profiles[profileName];
  if (!isPlainObject(selected)) {
    const available = Object.keys(profiles).join(", ");
    throw new Error(`profile '${profileName}'을(를) 찾지 못했습니다. 사용 가능: ${available || "(없음)"}`);
  }

  const merged = deepMerge(config, selected);
  delete merged.profiles;
  return merged;
}

function getPathEntries(pathValue) {
  return String(pathValue ?? "")
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

function getExecutableSuffixes(command) {
  if (process.platform !== "win32") {
    return [""];
  }

  if (/\.[A-Za-z0-9]+$/.test(command)) {
    return [""];
  }

  return [".exe", ".cmd", ".bat", ".com", ""];
}

function isPathLikeCommand(command) {
  return command.includes("/") || command.includes("\\") || command.startsWith(".");
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveExecutable(command, cwd, envPathValue) {
  const suffixes = getExecutableSuffixes(command);

  if (isPathLikeCommand(command)) {
    const basePath = resolve(cwd, command);
    for (const suffix of suffixes) {
      const candidate = `${basePath}${suffix}`;
      if (await fileExists(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  const pathEntries = getPathEntries(envPathValue);
  for (const dir of pathEntries) {
    const basePath = resolve(dir, command);
    for (const suffix of suffixes) {
      const candidate = `${basePath}${suffix}`;
      if (await fileExists(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

async function loadConfig(filePath) {
  const resolvedPath = resolve(process.cwd(), filePath);
  const rawText = await readFile(resolvedPath, "utf8");
  const parsed = parseJsonObject(rawText);
  return { resolvedPath, parsed };
}

function buildRuntimeConfig(config, cliOptions) {
  const mergedConfig = applyProfile(config, cliOptions.profile);
  const openCode = mergedConfig.openCode ?? {};
  const detection = mergedConfig.detection ?? {};
  const message = mergedConfig.message ?? {};
  const parser = mergedConfig.parser ?? {};
  const discord = mergedConfig.discord ?? {};
  const environment = mergedConfig.environment ?? {};

  const commandConfig = cliOptions.commandOverride ?? {
    command: openCode.command ?? "opencode",
    args: Array.isArray(openCode.args) ? openCode.args : []
  };

  if (typeof commandConfig.command !== "string" || commandConfig.command.trim().length === 0) {
    throw new Error("openCode.command must be a non-empty string.");
  }

  const targets = Array.isArray(discord.targets) ? discord.targets : [];
  if (!cliOptions.dryRun) {
    if (!discord.botToken || typeof discord.botToken !== "string") {
      throw new Error("discord.botToken is required unless --dry-run is used.");
    }
    if (targets.length === 0) {
      throw new Error("discord.targets must contain at least one target unless --dry-run is used.");
    }
  }

  return {
    dryRun: cliOptions.dryRun,
    once: cliOptions.once,
    openCode: {
      command: commandConfig.command,
      args: commandConfig.args,
      commandCandidates: uniqueNonEmptyStrings(openCode.commandCandidates),
      useShell: openCode.useShell === true,
      cwd: typeof openCode.cwd === "string" ? resolve(process.cwd(), openCode.cwd) : process.cwd(),
      env: openCode.env && typeof openCode.env === "object" ? openCode.env : {}
    },
    detection: {
      buildCompletePatterns: compilePatternList(
        detection.buildCompletePatterns,
        DEFAULT_BUILD_COMPLETE_PATTERNS
      ),
      waitingInputPatterns: compilePatternList(
        detection.waitingInputPatterns,
        DEFAULT_WAITING_INPUT_PATTERNS
      ),
      readyWindowMs: Number.isFinite(detection.readyWindowMs) ? detection.readyWindowMs : 120000,
      cooldownMs: Number.isFinite(detection.cooldownMs) ? detection.cooldownMs : 90000
    },
    parser: {
      assistantBlockStartPatterns: compilePatternList(parser.assistantBlockStartPatterns, []),
      assistantBlockEndPatterns: compilePatternList(parser.assistantBlockEndPatterns, []),
      noisePatterns: compilePatternList(parser.noisePatterns, []),
      tailLines: Number.isFinite(parser.tailLines) ? parser.tailLines : 24,
      maxBufferLines: Number.isFinite(parser.maxBufferLines)
        ? parser.maxBufferLines
        : DEFAULT_MAX_BUFFER_LINES
    },
    message: {
      mode: ["raw", "cleaned", "summary"].includes(message.mode) ? message.mode : "summary",
      title:
        typeof message.title === "string" && message.title.trim().length > 0
          ? message.title.trim()
          : "OpenCode 완료 알림",
      includeMetadata: message.includeMetadata === true,
      includeRawInCodeBlock: message.includeRawInCodeBlock === true,
      maxChars: Number.isFinite(message.maxChars)
        ? Math.min(Math.max(300, message.maxChars), DISCORD_CONTENT_LIMIT)
        : 1900,
      summaryMaxBullets: Number.isFinite(message.summaryMaxBullets) ? message.summaryMaxBullets : 8
    },
    discord: {
      botToken: discord.botToken ?? "",
      targets,
      mentionUserId: typeof discord.mentionUserId === "string" ? discord.mentionUserId : null,
      timeoutMs: Number.isFinite(discord.timeoutMs) ? discord.timeoutMs : 10000
    },
    environment: resolveEnvironmentRuntime(environment)
  };
}

function buildEnvironmentLabelTitle(title, environmentLabel) {
  if (!environmentLabel) {
    return title;
  }

  return `[${environmentLabel}] ${title}`;
}

function buildUnregisteredEnvironmentNotice(runtimeKey) {
  return [
    "⚠️ **현재 실행 환경 레이블이 등록되지 않았습니다.**",
    `- 환경 키: \`${truncateText(runtimeKey, 120)}\``,
    "- 해결: `npm run setup`을 실행해서 이 환경의 레이블을 등록해 주세요."
  ].join("\n");
}

function buildCommandPreview(config) {
  return [config.openCode.command, ...config.openCode.args].join(" ").trim();
}

function buildMessageMetadata(config, measuredAt, elapsedMs) {
  const commandPreview = buildCommandPreview(config);
  const metadata = [
    `- 시간: ${new Date(measuredAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`,
    "- 트리거: 빌드 완료 -> 입력 대기",
    `- 모드: ${config.message.mode}`,
    `- 실행 명령: \`${truncateText(commandPreview, 120)}\``
  ];

  if (elapsedMs !== null) {
    metadata.splice(1, 0, `- 경과 시간: ${formatDurationMs(elapsedMs)}`);
  }

  return metadata.join("\n");
}

function getDisplayEnvironmentLabel(environment) {
  return environment?.label || "미등록 환경";
}

function shouldShowEnvironmentNotice(environment) {
  return Boolean(environment?.requiresSetup && environment?.runtimeKey);
}

function createMessageHeader(config) {
  const environmentLabel = getDisplayEnvironmentLabel(config.environment);
  const title = buildEnvironmentLabelTitle(config.message.title, environmentLabel);
  return `**${title}**`;
}

function createMetadataSection(config, measuredAt, elapsedMs) {
  return buildMessageMetadata(config, measuredAt, elapsedMs);
}

function createEnvironmentNoticeSection(config) {
  if (!shouldShowEnvironmentNotice(config.environment)) {
    return "";
  }

  return buildUnregisteredEnvironmentNotice(config.environment.runtimeKey);
}

async function discordRequest({ token, path, method, body, timeoutMs }) {
  const response = await fetch(`https://discord.com/api/v10${path}`, {
    method,
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json"
    },
    signal: AbortSignal.timeout(timeoutMs),
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

class OpenCodeDiscordNotifier {
  constructor(runtimeConfig) {
    this.config = runtimeConfig;
    this.buffer = [];
    this.child = null;
    this.lastBuildCompleteAt = 0;
    this.lastNotificationAt = 0;
    this.pendingNotification = false;
    this.notificationEnabled = true;
    this.notificationCount = 0;
    this.dmChannelCache = new Map();

    if (this.config.environment.requiresSetup) {
      logInfo(
        [
          "Current runtime environment label is missing.",
          `environmentKey=${this.config.environment.runtimeKey}`,
          "run `npm run setup` to register an environment label."
        ].join(" ")
      );
    }
  }

  addBufferLine(line, source) {
    const normalized = normalizeBufferLine(line);
    if (!normalized) {
      return null;
    }

    const entry = {
      line: normalized,
      source,
      time: Date.now()
    };

    this.buffer.push(entry);

    const over = this.buffer.length - this.config.parser.maxBufferLines;
    if (over > 0) {
      this.buffer.splice(0, over);
    }

    return entry;
  }

  findLastMatchingEntry(patterns) {
    for (let i = this.buffer.length - 1; i >= 0; i -= 1) {
      const entry = this.buffer[i];
      if (matchesAny(entry.line, patterns)) {
        return entry;
      }
    }

    return null;
  }

  extractAssistantBlock() {
    const starts = this.config.parser.assistantBlockStartPatterns;
    const ends = this.config.parser.assistantBlockEndPatterns;

    if (starts.length === 0) {
      return "";
    }

    let active = false;
    let current = [];
    let lastComplete = "";

    for (const entry of this.buffer) {
      const text = entry.line;

      if (!active && matchesAny(text, starts)) {
        active = true;
        current = [];
        continue;
      }

      if (!active) {
        continue;
      }

      if (ends.length > 0 && matchesAny(text, ends)) {
        if (current.length > 0) {
          lastComplete = current.join("\n");
        }
        active = false;
        current = [];
        continue;
      }

      current.push(text);
    }

    if (active && current.length > 0) {
      return current.join("\n");
    }

    return lastComplete;
  }

  extractTailMessage() {
    const lines = [];
    const tailLines = this.config.parser.tailLines;
    const noisePatterns = this.config.parser.noisePatterns;

    for (let i = this.buffer.length - 1; i >= 0; i -= 1) {
      const text = this.buffer[i].line;

      if (matchesAny(text, this.config.detection.waitingInputPatterns)) {
        continue;
      }

      if (matchesAny(text, this.config.detection.buildCompletePatterns)) {
        continue;
      }

      if (noisePatterns.length > 0 && matchesAny(text, noisePatterns)) {
        continue;
      }

      lines.unshift(text);
      if (lines.length >= tailLines) {
        break;
      }
    }

    return lines.join("\n");
  }

  buildMessageBody(rawMessage, metadata = {}) {
    const normalized = normalizeMultilineText(String(rawMessage ?? ""));
    const missingMessageNotice = "마지막 메시지를 추출하지 못했습니다. parser 패턴을 조정해 주세요.";
    const measuredAt = Number.isFinite(metadata.measuredAt) ? metadata.measuredAt : Date.now();
    const elapsedMs = Number.isFinite(metadata.elapsedMs) && metadata.elapsedMs >= 0 ? metadata.elapsedMs : null;

    let renderedBody = normalized;
    if (!renderedBody) {
      renderedBody = this.config.message.mode === "summary"
        ? `- ${missingMessageNotice}`
        : `(${missingMessageNotice})`;
    }

    if (this.config.message.mode === "cleaned") {
      renderedBody = normalized || renderedBody;
    }

    if (this.config.message.mode === "summary") {
      renderedBody = normalized
        ? heuristicSummary(normalized, this.config.message.summaryMaxBullets)
        : renderedBody;
    }

    const sections = [];
    sections.push(createMessageHeader(this.config));

    const environmentNotice = createEnvironmentNoticeSection(this.config);
    if (environmentNotice) {
      sections.push(environmentNotice);
    }

    if (this.config.message.includeMetadata) {
      sections.push(createMetadataSection(this.config, measuredAt, elapsedMs));
    }

    sections.push(this.config.message.mode === "summary" ? "**요약된 마지막 메시지**" : "**마지막 메시지**");
    sections.push(renderedBody);

    if (this.config.message.includeRawInCodeBlock && this.config.message.mode !== "raw") {
      sections.push("**원문 tail**");
      sections.push(`\`\`\`text\n${truncateText(normalized || "(비어 있음)", 700)}\n\`\`\``);
    }

    let content = sections.filter(Boolean).join("\n\n");

    if (this.config.discord.mentionUserId) {
      content = `<@${this.config.discord.mentionUserId}>\n${content}`;
    }

    return truncateText(content, this.config.message.maxChars);
  }

  async resolveChannelForTarget(target) {
    if (!target || typeof target !== "object") {
      throw new Error("discord.targets includes an invalid entry.");
    }

    if (target.type === "channel") {
      if (typeof target.id !== "string" || target.id.length === 0) {
        throw new Error("channel target requires a string 'id'.");
      }
      return target.id;
    }

    if (target.type === "user") {
      if (typeof target.id !== "string" || target.id.length === 0) {
        throw new Error("user target requires a string 'id'.");
      }

      if (this.dmChannelCache.has(target.id)) {
        return this.dmChannelCache.get(target.id);
      }

      const dm = await discordRequest({
        token: this.config.discord.botToken,
        path: "/users/@me/channels",
        method: "POST",
        timeoutMs: this.config.discord.timeoutMs,
        body: {
          recipient_id: target.id
        }
      });

      if (!dm || typeof dm.id !== "string") {
        throw new Error(`Failed to resolve DM channel for user ${target.id}.`);
      }

      this.dmChannelCache.set(target.id, dm.id);
      return dm.id;
    }

    throw new Error(`Unknown target type: ${String(target.type)}`);
  }

  async sendToDiscord(content) {
    if (this.config.dryRun) {
      logInfo("Dry run mode: Discord API call skipped.");
      process.stdout.write(`\n----- DRY RUN PAYLOAD BEGIN -----\n${content}\n----- DRY RUN PAYLOAD END -----\n\n`);
      return;
    }

    const payload = {
      content: truncateText(content, DISCORD_CONTENT_LIMIT),
      allowed_mentions: {
        parse: [],
        users: this.config.discord.mentionUserId ? [this.config.discord.mentionUserId] : []
      }
    };

    for (const target of this.config.discord.targets) {
      const channelId = await this.resolveChannelForTarget(target);

      await discordRequest({
        token: this.config.discord.botToken,
        path: `/channels/${channelId}/messages`,
        method: "POST",
        timeoutMs: this.config.discord.timeoutMs,
        body: payload
      });
    }
  }

  async notifyIfReady(triggerLine, triggerTime = Date.now()) {
    const now = Number.isFinite(triggerTime) ? triggerTime : Date.now();

    if (!this.notificationEnabled) {
      return;
    }

    if (this.pendingNotification) {
      return;
    }

    if (!this.lastBuildCompleteAt) {
      return;
    }

    if (now - this.lastBuildCompleteAt > this.config.detection.readyWindowMs) {
      return;
    }

    if (now - this.lastNotificationAt < this.config.detection.cooldownMs) {
      return;
    }

    this.pendingNotification = true;

    try {
      const assistantBlock = normalizeMultilineText(this.extractAssistantBlock());
      let extracted = assistantBlock;

      if (!extracted) {
        const tail = normalizeMultilineText(this.extractTailMessage());
        if (!isIntermediateAnalysisMessage(tail)) {
          extracted = tail;
        }
      }

      if (extracted && isIntermediateAnalysisMessage(extracted)) {
        logInfo("Skipped notification: extracted text looks like an intermediate analysis block.");
        return;
      }

      let elapsedMs = null;
      if (this.lastBuildCompleteAt) {
        const startEntry = this.findLastMatchingEntry(this.config.detection.buildCompletePatterns);
        const startAt = startEntry?.time ?? this.lastBuildCompleteAt;
        elapsedMs = Math.max(0, now - startAt);
      }

      const content = this.buildMessageBody(extracted, {
        measuredAt: now,
        elapsedMs
      });
      await this.sendToDiscord(content);
      this.lastNotificationAt = now;
      this.notificationCount += 1;

      logInfo(`Notification sent (count=${this.notificationCount}) on line: ${triggerLine}`);

      if (this.config.once) {
        this.notificationEnabled = false;
        logInfo("'--once' enabled: further notifications disabled.");
      }
    } catch (error) {
      logError(error instanceof Error ? error.message : String(error));
    } finally {
      this.pendingNotification = false;
    }
  }

  async handleLine(line, source) {
    const entry = this.addBufferLine(line, source);

    const normalized = normalizeBufferLine(line);
    if (!normalized) {
      return;
    }

    if (matchesAny(normalized, this.config.detection.buildCompletePatterns)) {
      this.lastBuildCompleteAt = entry?.time ?? Date.now();
      logInfo(`Build completion matched: ${normalized}`);
    }

    if (matchesAny(normalized, this.config.detection.waitingInputPatterns)) {
      await this.notifyIfReady(normalized, entry?.time ?? Date.now());
    }
  }

  async run() {
    const { command, args, commandCandidates, cwd, env, useShell } = this.config.openCode;
    const mergedEnv = {
      ...process.env,
      ...env
    };

    const commandsToTry = uniqueNonEmptyStrings([command, ...commandCandidates, ...DEFAULT_COMMAND_CANDIDATES]);
    const attempted = [];
    let resolvedCommand = null;

    for (const candidateCommand of commandsToTry) {
      attempted.push(candidateCommand);
      const found = await resolveExecutable(candidateCommand, cwd, mergedEnv.PATH);
      if (found) {
        resolvedCommand = found;
        break;
      }
    }

    if (!resolvedCommand) {
      const requested = [command, ...commandCandidates].filter(Boolean).join(", ");
      throw new Error(
        [
          "openCode command를 실행할 수 없습니다.",
          `요청된 command: ${requested || "(없음)"}`,
          `시도한 후보: ${attempted.join(", ")}`,
          "해결: openCode.command에 절대 경로를 지정하거나, commandCandidates에 실제 실행 가능한 명령(예: oh-my-opencode)을 추가하세요."
        ].join(" ")
      );
    }

    const isWindowsScript = process.platform === "win32" && /\.(cmd|bat)$/i.test(resolvedCommand);
    const spawnCommand = isWindowsScript ? (process.env.ComSpec || "cmd.exe") : resolvedCommand;
    const spawnArgs = isWindowsScript
      ? ["/d", "/s", "/c", resolvedCommand, ...args]
      : args;
    const fullCommand = [spawnCommand, ...spawnArgs].join(" ").trim();

    logInfo(`Launching command: ${fullCommand}`);

    try {
      this.child = spawn(spawnCommand, spawnArgs, {
        cwd,
        env: mergedEnv,
        stdio: ["inherit", "pipe", "pipe"],
        shell: useShell && !isWindowsScript
      });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        throw new Error(`openCode command를 실행할 수 없습니다. 현재 command = "${resolvedCommand}" 입니다. PATH와 실행 파일 권한을 확인하세요.`);
      }

      throw error;
    }

    const cleanupSignalHandlers = this.installSignalHandlers();

    this.child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
    });

    this.child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
    });

    const stdoutReader = createInterface({ input: this.child.stdout });
    stdoutReader.on("line", (line) => {
      this.handleLine(line, "stdout").catch((error) => {
        logError(error instanceof Error ? error.message : String(error));
      });
    });

    const stderrReader = createInterface({ input: this.child.stderr });
    stderrReader.on("line", (line) => {
      this.handleLine(line, "stderr").catch((error) => {
        logError(error instanceof Error ? error.message : String(error));
      });
    });

    await new Promise((resolveRun, rejectRun) => {
      const onSpawnError = (error) => {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          rejectRun(new Error(`openCode command를 실행할 수 없습니다. 현재 command = "${resolvedCommand}" 입니다. PATH와 실행 파일 권한을 확인하세요.`));
          return;
        }

        rejectRun(error);
      };

      this.child.once("error", onSpawnError);

      this.child.once("close", (code, signal) => {
        stdoutReader.close();
        stderrReader.close();
        cleanupSignalHandlers();

        if (signal) {
          logInfo(`Child exited via signal: ${signal}`);
        } else {
          logInfo(`Child exited with code: ${String(code)}`);
        }

        resolveRun();
      });
    });
  }

  installSignalHandlers() {
    const forwardSignal = (signal) => {
      if (!this.child || this.child.killed) {
        return;
      }
      this.child.kill(signal);
    };

    const onSigint = () => forwardSignal("SIGINT");
    const onSigterm = () => forwardSignal("SIGTERM");

    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);

    return () => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    };
  }
}

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  const loaded = await loadConfig(cli.configPath);
  const runtime = buildRuntimeConfig(loaded.parsed, cli);

  logInfo(`Loaded config: ${loaded.resolvedPath}`);

  const notifier = new OpenCodeDiscordNotifier(runtime);
  await notifier.run();
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  logError(message);
  process.exitCode = 1;
});
