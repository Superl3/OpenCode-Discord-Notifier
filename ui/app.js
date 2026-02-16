const elements = {
  configPath: document.getElementById("configPath"),
  botToken: document.getElementById("botToken"),
  mentionUserId: document.getElementById("mentionUserId"),
  openCodeCommand: document.getElementById("openCodeCommand"),
  openCodeCommandCandidates: document.getElementById("openCodeCommandCandidates"),
  openCodeArgs: document.getElementById("openCodeArgs"),
  openCodeUseShell: document.getElementById("openCodeUseShell"),
  messageMode: document.getElementById("messageMode"),
  includeMetadata: document.getElementById("includeMetadata"),
  includeRawInCodeBlock: document.getElementById("includeRawInCodeBlock"),
  userTargets: document.getElementById("userTargets"),
  channelTargets: document.getElementById("channelTargets"),
  buildPatterns: document.getElementById("buildPatterns"),
  waitPatterns: document.getElementById("waitPatterns"),
  assistantStartPatterns: document.getElementById("assistantStartPatterns"),
  assistantEndPatterns: document.getElementById("assistantEndPatterns"),
  rawJson: document.getElementById("rawJson"),
  runCommand: document.getElementById("runCommand"),
  dryRunOutput: document.getElementById("dryRunOutput"),
  statusBar: document.getElementById("statusBar"),
  loadConfigBtn: document.getElementById("loadConfigBtn"),
  formToJsonBtn: document.getElementById("formToJsonBtn"),
  jsonToFormBtn: document.getElementById("jsonToFormBtn"),
  formatJsonBtn: document.getElementById("formatJsonBtn"),
  saveConfigBtn: document.getElementById("saveConfigBtn"),
  dryRunBtn: document.getElementById("dryRunBtn"),
  copyCommandBtn: document.getElementById("copyCommandBtn")
};

let currentConfig = null;

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function splitLines(raw) {
  return String(raw ?? "")
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
}

function assignLines(node, values) {
  node.value = Array.isArray(values) ? values.join("\n") : "";
}

function parseJsonEditor() {
  const text = elements.rawJson.value.trim();
  if (!text) {
    throw new Error("JSON editor가 비어 있습니다.");
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("JSON 파싱에 실패했습니다. 문법을 확인해 주세요.");
  }

  if (!isPlainObject(parsed)) {
    throw new Error("루트는 JSON object여야 합니다.");
  }

  return parsed;
}

function writeJsonEditor(config) {
  elements.rawJson.value = `${JSON.stringify(config, null, 2)}\n`;
}

function setStatus(message, type = "neutral") {
  elements.statusBar.textContent = message;
  elements.statusBar.classList.remove("ok", "error");

  if (type === "ok") {
    elements.statusBar.classList.add("ok");
  }

  if (type === "error") {
    elements.statusBar.classList.add("error");
  }
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function extractTargets(config) {
  const targets = safeArray(config?.discord?.targets);
  const userIds = [];
  const channelIds = [];

  for (const target of targets) {
    if (!isPlainObject(target) || typeof target.id !== "string") {
      continue;
    }

    if (target.type === "user") {
      userIds.push(target.id);
      continue;
    }

    if (target.type === "channel") {
      channelIds.push(target.id);
    }
  }

  return { userIds, channelIds };
}

function fillFormFromConfig(config) {
  const openCode = isPlainObject(config.openCode) ? config.openCode : {};
  const detection = isPlainObject(config.detection) ? config.detection : {};
  const parser = isPlainObject(config.parser) ? config.parser : {};
  const message = isPlainObject(config.message) ? config.message : {};
  const discord = isPlainObject(config.discord) ? config.discord : {};
  const targets = extractTargets(config);

  elements.botToken.value = typeof discord.botToken === "string" ? discord.botToken : "";
  elements.mentionUserId.value = typeof discord.mentionUserId === "string" ? discord.mentionUserId : "";

  elements.openCodeCommand.value = typeof openCode.command === "string" ? openCode.command : "opencode";
  assignLines(elements.openCodeCommandCandidates, safeArray(openCode.commandCandidates));
  assignLines(elements.openCodeArgs, safeArray(openCode.args));
  elements.openCodeUseShell.checked = openCode.useShell === true;

  elements.messageMode.value = ["summary", "cleaned", "raw"].includes(message.mode)
    ? message.mode
    : "summary";
  elements.includeMetadata.checked = message.includeMetadata !== false;
  elements.includeRawInCodeBlock.checked = message.includeRawInCodeBlock === true;

  assignLines(elements.userTargets, targets.userIds);
  assignLines(elements.channelTargets, targets.channelIds);

  assignLines(elements.buildPatterns, safeArray(detection.buildCompletePatterns));
  assignLines(elements.waitPatterns, safeArray(detection.waitingInputPatterns));
  assignLines(elements.assistantStartPatterns, safeArray(parser.assistantBlockStartPatterns));
  assignLines(elements.assistantEndPatterns, safeArray(parser.assistantBlockEndPatterns));
}

function mergeQuickFormIntoConfig(baseConfig) {
  const config = deepClone(isPlainObject(baseConfig) ? baseConfig : {});

  config.openCode = isPlainObject(config.openCode) ? config.openCode : {};
  config.detection = isPlainObject(config.detection) ? config.detection : {};
  config.parser = isPlainObject(config.parser) ? config.parser : {};
  config.message = isPlainObject(config.message) ? config.message : {};
  config.discord = isPlainObject(config.discord) ? config.discord : {};

  config.openCode.command = elements.openCodeCommand.value.trim() || "opencode";
  config.openCode.commandCandidates = splitLines(elements.openCodeCommandCandidates.value);
  config.openCode.args = splitLines(elements.openCodeArgs.value);
  config.openCode.useShell = elements.openCodeUseShell.checked;
  config.openCode.cwd = typeof config.openCode.cwd === "string" && config.openCode.cwd
    ? config.openCode.cwd
    : ".";
  config.openCode.env = isPlainObject(config.openCode.env) ? config.openCode.env : {};

  config.detection.buildCompletePatterns = splitLines(elements.buildPatterns.value);
  config.detection.waitingInputPatterns = splitLines(elements.waitPatterns.value);

  config.parser.assistantBlockStartPatterns = splitLines(elements.assistantStartPatterns.value);
  config.parser.assistantBlockEndPatterns = splitLines(elements.assistantEndPatterns.value);

  config.message.mode = elements.messageMode.value;
  config.message.includeMetadata = elements.includeMetadata.checked;
  config.message.includeRawInCodeBlock = elements.includeRawInCodeBlock.checked;

  const userIds = splitLines(elements.userTargets.value);
  const channelIds = splitLines(elements.channelTargets.value);

  config.discord.botToken = elements.botToken.value.trim();
  config.discord.mentionUserId = elements.mentionUserId.value.trim() || null;
  config.discord.targets = [
    ...userIds.map((id) => ({ type: "user", id })),
    ...channelIds.map((id) => ({ type: "channel", id }))
  ];

  if (!Number.isFinite(config.discord.timeoutMs)) {
    config.discord.timeoutMs = 10000;
  }

  return config;
}

function updateRunCommandPreview() {
  const path = elements.configPath.value.trim() || "opencode-notifier.config.json";
  elements.runCommand.textContent = `npm run start -- --config "${path}"`;
}

async function loadConfig() {
  const path = elements.configPath.value.trim();
  const response = await fetch(`/api/config?path=${encodeURIComponent(path)}`);
  const body = await response.json();

  if (!response.ok || !body || body.error) {
    throw new Error(body?.error ?? `로드 실패 (${response.status})`);
  }

  currentConfig = body.config;
  fillFormFromConfig(currentConfig);
  writeJsonEditor(currentConfig);
  updateRunCommandPreview();

  const sourceLabel = body.source === "config" ? "저장된 설정" : "예시 템플릿";
  setStatus(`${sourceLabel} 로드 완료 (${body.path})`, "ok");
}

function formToJson() {
  const base = currentConfig ?? {};
  const next = mergeQuickFormIntoConfig(base);

  currentConfig = next;
  writeJsonEditor(next);
  setStatus("빠른 설정 값을 JSON에 반영했습니다.", "ok");
}

function jsonToForm() {
  const parsed = parseJsonEditor();
  currentConfig = parsed;
  fillFormFromConfig(parsed);
  setStatus("JSON 값을 빠른 설정 폼에 반영했습니다.", "ok");
}

async function saveConfig() {
  const config = parseJsonEditor();
  const path = elements.configPath.value.trim();

  const response = await fetch("/api/config/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, config })
  });

  const body = await response.json();
  if (!response.ok || !body || body.error) {
    throw new Error(body?.error ?? `저장 실패 (${response.status})`);
  }

  currentConfig = config;
  setStatus(`저장 완료: ${body.path}`, "ok");
}

function renderDryRunResult(body) {
  const commandLine = Array.isArray(body.command) ? body.command.join(" ") : "(명령 미수신)";
  const lines = [
    `$ ${commandLine}`,
    `종료 코드: ${String(body.code)}${body.signal ? ` | 시그널: ${body.signal}` : ""}${body.timedOut ? " | 타임아웃" : ""}`,
    "",
    "--- 표준오류(stderr) ---",
    body.stderr || "(비어 있음)",
    "",
    "--- 표준출력(stdout) ---",
    body.stdout || "(비어 있음)"
  ];

  elements.dryRunOutput.textContent = lines.join("\n");
}

async function runDryRun() {
  const config = parseJsonEditor();

  setStatus("드라이런 실행 중...", "neutral");

  const response = await fetch("/api/dry-run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ config })
  });

  const body = await response.json();
  if (!response.ok || !body || body.error) {
    throw new Error(body?.error ?? `드라이런 실패 (${response.status})`);
  }

  renderDryRunResult(body);

  if (body.code === 0 && !body.timedOut) {
    setStatus("드라이런 성공. 감지/포맷 결과는 아래 출력창에서 확인하세요.", "ok");
  } else {
    setStatus("드라이런 완료. 오류 로그를 확인해 주세요.", "error");
  }
}

async function copyRunCommand() {
  const path = elements.configPath.value.trim() || "opencode-notifier.config.json";
  const command = `npm run start -- --config "${path}"`;

  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(command);
  } else {
    elements.runCommand.textContent = command;
  }

  setStatus("실행 명령을 클립보드에 복사했습니다.", "ok");
}

function formatJson() {
  const parsed = parseJsonEditor();
  writeJsonEditor(parsed);
  setStatus("JSON 포맷 정리 완료.", "ok");
}

function bindEvents() {
  elements.configPath.addEventListener("input", updateRunCommandPreview);

  elements.loadConfigBtn.addEventListener("click", () => {
    loadConfig().catch((error) => setStatus(error.message, "error"));
  });

  elements.formToJsonBtn.addEventListener("click", () => {
    try {
      formToJson();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), "error");
    }
  });

  elements.jsonToFormBtn.addEventListener("click", () => {
    try {
      jsonToForm();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), "error");
    }
  });

  elements.formatJsonBtn.addEventListener("click", () => {
    try {
      formatJson();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), "error");
    }
  });

  elements.saveConfigBtn.addEventListener("click", () => {
    saveConfig().catch((error) => setStatus(error.message, "error"));
  });

  elements.dryRunBtn.addEventListener("click", () => {
    runDryRun().catch((error) => setStatus(error.message, "error"));
  });

  elements.copyCommandBtn.addEventListener("click", () => {
    copyRunCommand().catch((error) => setStatus(error.message, "error"));
  });
}

function init() {
  bindEvents();
  updateRunCommandPreview();
  loadConfig().catch((error) => setStatus(error.message, "error"));
}

init();
