#!/usr/bin/env node

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const args = new Set(process.argv.slice(2));
const runSetup = args.has("--run-setup");
const skipNpmInstall = args.has("--skip-npm-install");
const skipOpencodeCheck = args.has("--skip-opencode-check");

const PLUGIN_ENTRY_FILE = "opencode-notifier-plugin.js";

function logStep(message) {
  process.stdout.write(`\n[bootstrap] ${message}\n`);
}

function logInfo(message) {
  process.stdout.write(`[bootstrap] ${message}\n`);
}

function logWarn(message) {
  process.stderr.write(`[bootstrap:warn] ${message}\n`);
}

function runCommand(command, { cwd = process.cwd(), optional = false } = {}) {
  const result = spawnSync(command, {
    cwd,
    shell: true,
    stdio: "inherit"
  });

  if (result.error) {
    if (optional) {
      logWarn(`${command} 실행 중 오류가 발생했습니다: ${result.error.message}`);
      return false;
    }
    throw result.error;
  }

  if (result.status !== 0) {
    if (optional) {
      logWarn(`${command} 실행이 실패했습니다 (exit ${String(result.status)}).`);
      return false;
    }
    throw new Error(`${command} 실행이 실패했습니다 (exit ${String(result.status)}).`);
  }

  return true;
}

function hasCommand(command) {
  const result = spawnSync(`${command} --version`, {
    shell: true,
    stdio: "ignore"
  });
  return result.status === 0;
}

function candidateConfigDirs() {
  const dirs = [];

  const explicit = process.env.OPENCODE_CONFIG_DIR || process.env.OPENCODE_CONFIG_HOME;
  if (explicit) {
    dirs.push(resolve(explicit));
  }

  if (process.env.XDG_CONFIG_HOME) {
    dirs.push(join(process.env.XDG_CONFIG_HOME, "opencode"));
  }

  if (process.env.APPDATA) {
    dirs.push(join(process.env.APPDATA, "opencode"));
  }

  if (process.env.LOCALAPPDATA) {
    dirs.push(join(process.env.LOCALAPPDATA, "opencode"));
  }

  dirs.push(join(homedir(), ".config", "opencode"));
  return [...new Set(dirs)];
}

function readJsonIfExists(filePath) {
  try {
    const raw = readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isNotifierPluginEntry(entry) {
  if (typeof entry !== "string" || !entry.startsWith("file://")) {
    return false;
  }

  try {
    const url = new URL(entry);
    const normalizedPath = decodeURIComponent(url.pathname).replace(/\\/g, "/").toLowerCase();
    return normalizedPath.endsWith(`/opencode-plugin/${PLUGIN_ENTRY_FILE}`);
  } catch {
    return false;
  }
}

function verifyPluginInstall() {
  for (const dir of candidateConfigDirs()) {
    const configPath = join(dir, "opencode.json");
    if (!existsSync(configPath)) {
      continue;
    }

    const config = readJsonIfExists(configPath);
    if (!config || !Array.isArray(config.plugin)) {
      continue;
    }

    const entry = config.plugin.find(isNotifierPluginEntry);
    if (entry) {
      return {
        configPath,
        entry
      };
    }
  }

  return null;
}

async function main() {
  const repoRoot = resolve(process.cwd());

  logStep("필수 의존성 확인 중 (node, npm)");
  if (!hasCommand("node")) {
    throw new Error("node 명령을 찾지 못했습니다. scripts/bootstrap-opencode.ps1 또는 .sh로 먼저 설치해 주세요.");
  }
  if (!hasCommand("npm")) {
    throw new Error("npm 명령을 찾지 못했습니다. scripts/bootstrap-opencode.ps1 또는 .sh로 먼저 설치해 주세요.");
  }
  logInfo("node/npm 확인 완료");

  if (!skipNpmInstall) {
    logStep("프로젝트 의존성 설치 중");
    runCommand("npm install --yes", { cwd: repoRoot });
  } else {
    logInfo("npm install 단계 생략 (--skip-npm-install)");
  }

  logStep("OpenCode 플러그인 등록 중");
  runCommand("npm run plugin:install", { cwd: repoRoot });

  const pluginInstall = verifyPluginInstall();
  if (pluginInstall) {
    logInfo(`플러그인 등록 확인: ${pluginInstall.configPath}`);
    logInfo(`- ${pluginInstall.entry}`);
  } else {
    logWarn("opencode.json에서 플러그인 엔트리를 확인하지 못했습니다. 'npm run plugin:install' 재실행을 권장합니다.");
  }

  if (!skipOpencodeCheck) {
    if (hasCommand("opencode")) {
      logInfo("opencode 명령 확인 완료");
    } else {
      logWarn("opencode 명령을 찾지 못했습니다. OpenCode CLI 설치 후 다시 실행해 주세요.");
    }
  }

  if (runSetup) {
    logStep("인터랙티브 설정 실행 중");
    runCommand("npm run setup", { cwd: repoRoot });
  } else {
    logInfo("기본 설치 완료. Discord 설정은 'npm run setup'으로 진행하세요.");
  }

  logStep("완료");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
