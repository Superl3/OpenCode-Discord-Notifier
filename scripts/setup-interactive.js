#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeSingleLine(value, maxChars = 80) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }

  if (text.length <= maxChars) {
    return text;
  }

  return text.slice(0, Math.max(1, maxChars)).trim();
}

function normalizeEnvironmentLabel(value) {
  return normalizeSingleLine(value, 60);
}

function resolveRuntimeEnvironmentKey() {
  const explicit = normalizeSingleLine(process.env.OPENCODE_ENV_KEY, 120);
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

function candidateOpenCodeConfigDirs() {
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
  dirs.push(resolve(process.cwd(), ".opencode"));
  return [...new Set(dirs)];
}

function resolveOpenCodeConfigDir() {
  const candidates = candidateOpenCodeConfigDirs();

  const withNotifierConfig = candidates.find((dir) => existsSync(join(dir, "opencode-notifier-plugin.json")));
  if (withNotifierConfig) {
    return withNotifierConfig;
  }

  const withOpenCodeConfig = candidates.find((dir) => existsSync(join(dir, "opencode.json")));
  if (withOpenCodeConfig) {
    return withOpenCodeConfig;
  }

  const existingDir = candidates.find((dir) => existsSync(dir));
  if (existingDir) {
    return existingDir;
  }

  return candidates[0];
}

async function readJsonTemplate(filePath) {
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);

  if (!isPlainObject(parsed)) {
    throw new Error(`${filePath} 파일의 루트는 object여야 합니다.`);
  }

  return parsed;
}

async function readJsonIfExists(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function writeJson(filePath, data) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function cloneObject(value) {
  return JSON.parse(JSON.stringify(value));
}

function resolveEnvironmentLabel(config, runtimeEnvironmentKey) {
  const environment = isPlainObject(config?.environment) ? config.environment : null;
  if (!environment) {
    return "";
  }

  const labelsByKey = isPlainObject(environment.labelsByKey) ? environment.labelsByKey : null;
  if (!labelsByKey) {
    return "";
  }

  const label = normalizeEnvironmentLabel(labelsByKey[runtimeEnvironmentKey]);
  return label || "";
}

function applyEnvironmentLabel(template, runtimeEnvironmentKey, environmentLabel) {
  const next = cloneObject(template);
  next.environment = isPlainObject(next.environment) ? next.environment : {};

  const labelsByKey = isPlainObject(next.environment.labelsByKey)
    ? { ...next.environment.labelsByKey }
    : {};

  labelsByKey[runtimeEnvironmentKey] = environmentLabel;

  next.environment.labelsByKey = labelsByKey;
  next.environment.lastConfiguredKey = runtimeEnvironmentKey;
  return next;
}

function isPlaceholder(value) {
  const text = String(value ?? "").trim().toUpperCase();
  return !text || text.includes("PUT_YOUR") || text.includes("YOUR_") || text.includes("DISCORD_BOT_TOKEN");
}

function isValidSnowflake(value) {
  return /^\d{15,22}$/.test(value);
}

function ask(rl, promptText) {
  return new Promise((resolveAsk) => {
    rl.question(promptText, (answer) => resolveAsk(answer));
  });
}

async function askRequired(rl, promptText, validator, invalidMessage) {
  while (true) {
    const answer = (await ask(rl, promptText)).trim();
    if (validator(answer)) {
      return answer;
    }
    process.stdout.write(`${invalidMessage}\n`);
  }
}

async function askChoice(rl, promptText, choices, fallbackKey) {
  const options = choices.map((item) => `${item.key}) ${item.label}`).join("\n");
  const suffix = fallbackKey ? ` [기본값 ${fallbackKey}]` : "";

  while (true) {
    const answer = (await ask(rl, `${promptText}\n${options}\n선택${suffix}: `)).trim();
    const selected = answer || fallbackKey;

    if (choices.some((item) => item.key === selected)) {
      return selected;
    }

    process.stdout.write("올바른 번호를 입력해 주세요.\n");
  }
}

async function askEnvironmentLabel(rl, fallbackLabel) {
  const suffix = fallbackLabel ? ` [기본값: ${fallbackLabel}]` : "";

  while (true) {
    const answer = (await ask(
      rl,
      `현재 OpenCode 실행 환경 레이블을 입력해 주세요 (예: 집-PC, 회사-노트북, WSL-main)${suffix}: `
    )).trim();

    const normalized = normalizeEnvironmentLabel(answer || fallbackLabel);
    if (normalized) {
      return normalized;
    }

    process.stdout.write("환경 레이블은 비어 있을 수 없습니다. 1~60자로 입력해 주세요.\n");
  }
}

function applyDiscordFields(template, token, targetType, targetId, mentionUserId) {
  const next = cloneObject(template);
  next.discord = isPlainObject(next.discord) ? next.discord : {};
  next.discord.botToken = token;
  next.discord.targets = [{ type: targetType, id: targetId }];
  next.discord.mentionUserId = mentionUserId || null;
  return next;
}

function runPluginInstall(repoRoot) {
  const scriptPath = resolve(repoRoot, "scripts", "install-opencode-plugin.js");
  const run = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    stdio: "inherit"
  });

  if (run.status !== 0) {
    throw new Error("플러그인 설치 스크립트가 실패했습니다. 위 로그를 확인해 주세요.");
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const isPostinstallMode = args.has("--postinstall");

  const repoRoot = resolve(process.cwd());
  const cliTemplatePath = resolve(repoRoot, "opencode-notifier.config.example.json");
  const pluginTemplatePath = resolve(repoRoot, "opencode-notifier-plugin.config.example.json");
  const cliConfigPath = resolve(repoRoot, "opencode-notifier.config.json");
  const openCodeConfigDir = resolveOpenCodeConfigDir();
  const pluginConfigPath = join(openCodeConfigDir, "opencode-notifier-plugin.json");
  const runtimeEnvironmentKey = resolveRuntimeEnvironmentKey();

  const existingCliConfig = await readJsonIfExists(cliConfigPath);
  const existingPluginConfig = await readJsonIfExists(pluginConfigPath);
  const hasExistingConfig = Boolean(existingCliConfig || existingPluginConfig);
  const existingEnvironmentLabel =
    resolveEnvironmentLabel(existingPluginConfig, runtimeEnvironmentKey)
    || resolveEnvironmentLabel(existingCliConfig, runtimeEnvironmentKey);
  const hasCurrentEnvironmentLabel = Boolean(existingEnvironmentLabel);

  if (isPostinstallMode && process.env.OPENCODE_NOTIFIER_SKIP_SETUP === "1") {
    return;
  }

  if (isPostinstallMode && hasExistingConfig && hasCurrentEnvironmentLabel) {
    return;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    if (isPostinstallMode) {
      if (hasExistingConfig && !hasCurrentEnvironmentLabel) {
        process.stdout.write(
          [
            "OpenCode notifier: 현재 실행 환경 레이블이 아직 등록되지 않았습니다.",
            `- 환경 키: ${runtimeEnvironmentKey}`,
            "- 다음 명령으로 레이블을 등록해 주세요: npm run setup"
          ].join("\n") + "\n"
        );
      } else {
        process.stdout.write("OpenCode notifier: 초기 설정은 건너뛰었습니다. 필요하면 'npm run setup'을 실행하세요.\n");
      }
      return;
    }

    throw new Error("인터랙티브 터미널에서 실행해 주세요. 예: npm run setup");
  }

  if (!existsSync(cliTemplatePath) || !existsSync(pluginTemplatePath)) {
    throw new Error("예시 설정 파일을 찾지 못했습니다. 저장소 루트에서 실행해 주세요.");
  }

  const cliTemplate = await readJsonTemplate(cliTemplatePath);
  const pluginTemplate = await readJsonTemplate(pluginTemplatePath);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });

  let modeChoice = "1";
  let token = "";
  let targetType = "channel";
  let targetId = "";
  let mentionUserId = "";
  let environmentLabel = existingEnvironmentLabel;
  let installPluginNow = true;

  try {
    process.stdout.write("\nOpenCode Discord Notifier 인터랙티브 설정\n\n");

    if (isPostinstallMode) {
      const beginChoice = await askChoice(
        rl,
        "지금 Discord 알림 초기 설정을 진행할까요?",
        [
          { key: "1", label: "네, 바로 설정" },
          { key: "2", label: "아니요, 나중에 설정" }
        ],
        "1"
      );

      if (beginChoice === "2") {
        process.stdout.write("설정을 건너뛰었습니다. 나중에 'npm run setup'으로 다시 실행할 수 있습니다.\n");
        return;
      }
    }

    modeChoice = await askChoice(
      rl,
      "설치 모드를 선택해 주세요.",
      [
        { key: "1", label: "OpenCode IDE 플러그인 (권장)" },
        { key: "2", label: "CLI 래퍼" },
        { key: "3", label: "플러그인 + CLI 둘 다" }
      ],
      "1"
    );

    token = await askRequired(
      rl,
      "디스코드 봇 토큰을 입력해 주세요: ",
      (value) => value.length >= 20 && !isPlaceholder(value),
      "유효한 봇 토큰을 입력해 주세요. (placeholder 값은 사용할 수 없습니다.)"
    );

    const targetChoice = await askChoice(
      rl,
      "알림 대상을 선택해 주세요.",
      [
        { key: "1", label: "채널 ID로 전송" },
        { key: "2", label: "DM 유저 ID로 전송" }
      ],
      "1"
    );

    targetType = targetChoice === "2" ? "user" : "channel";
    targetId = await askRequired(
      rl,
      targetType === "channel"
        ? "디스코드 채널 ID를 입력해 주세요: "
        : "DM 대상 유저 ID를 입력해 주세요: ",
      isValidSnowflake,
      "ID는 숫자로만 된 Discord snowflake(15~22자리)여야 합니다."
    );

    mentionUserId = (await ask(rl, "알림에 멘션할 유저 ID(선택, Enter로 건너뛰기): ")).trim();
    if (mentionUserId && !isValidSnowflake(mentionUserId)) {
      process.stdout.write("유효하지 않은 멘션 ID라서 멘션 없이 저장합니다.\n");
      mentionUserId = "";
    }

    if (hasExistingConfig && !existingEnvironmentLabel) {
      process.stdout.write(
        [
          "\n현재 실행 환경은 아직 레이블이 등록되지 않았습니다.",
          `- 환경 키: ${runtimeEnvironmentKey}`,
          "- 아래에서 이 환경에 사용할 레이블을 지정해 주세요."
        ].join("\n") + "\n"
      );
    }

    environmentLabel = await askEnvironmentLabel(rl, existingEnvironmentLabel);

    if (modeChoice === "1" || modeChoice === "3") {
      const installChoice = await askChoice(
        rl,
        "플러그인 설치 스크립트(npm run plugin:install)를 지금 실행할까요?",
        [
          { key: "1", label: "네, 바로 설치" },
          { key: "2", label: "아니요, 설정만 저장" }
        ],
        "1"
      );
      installPluginNow = installChoice === "1";
    }
  } finally {
    rl.close();
  }

  const shouldWritePlugin = modeChoice === "1" || modeChoice === "3";
  const shouldWriteCli = modeChoice === "2" || modeChoice === "3";

  if (shouldWriteCli) {
    const cliBase = existingCliConfig || cliTemplate;
    const cliWithDiscord = applyDiscordFields(cliBase, token, targetType, targetId, mentionUserId);
    const cliConfig = applyEnvironmentLabel(cliWithDiscord, runtimeEnvironmentKey, environmentLabel);
    await writeJson(cliConfigPath, cliConfig);
  }

  if (shouldWritePlugin) {
    const pluginBase = existingPluginConfig || pluginTemplate;
    const pluginWithDiscord = applyDiscordFields(pluginBase, token, targetType, targetId, mentionUserId);
    const pluginConfig = applyEnvironmentLabel(pluginWithDiscord, runtimeEnvironmentKey, environmentLabel);
    await writeJson(pluginConfigPath, pluginConfig);
  }

  if (shouldWritePlugin && installPluginNow) {
    runPluginInstall(repoRoot);
  }

  const lines = ["\n설정이 완료되었습니다."];
  if (shouldWriteCli) {
    lines.push(`- CLI 설정 파일: ${cliConfigPath}`);
    lines.push("- 실행: npm run start -- --config ./opencode-notifier.config.json");
  }
  if (shouldWritePlugin) {
    lines.push(`- 플러그인 설정 파일: ${pluginConfigPath}`);
    lines.push(`- OpenCode config dir: ${openCodeConfigDir}`);
    lines.push("- OpenCode IDE를 재시작하면 플러그인이 새 설정으로 동작합니다.");
    if (!installPluginNow) {
      lines.push("- 플러그인 미설치 상태라면 수동 실행: npm run plugin:install");
    }
  }
  lines.push(`- 환경 레이블: ${environmentLabel}`);
  lines.push(`- 환경 키: ${runtimeEnvironmentKey}`);

  process.stdout.write(`${lines.join("\n")}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
