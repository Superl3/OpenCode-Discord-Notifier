#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const PLUGIN_NAME = "opencode-notifier-plugin";

function toPosixPath(value) {
  return String(value).replace(/\\/g, "/");
}

function candidateConfigDirs() {
  const dirs = [];
  const home = homedir();

  dirs.push(join(home, ".config", "opencode"));

  const appData = process.env.APPDATA;
  if (appData) {
    dirs.push(join(appData, "opencode"));
  }

  return dirs;
}

async function readJsonOrDefault(filePath, fallback) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function ensureConfigDir() {
  const candidates = candidateConfigDirs();
  const existing = candidates.find((dir) => existsSync(dir));
  const target = existing || candidates[0];
  await mkdir(target, { recursive: true });
  return target;
}

async function updateOpenCodeConfig(configDir) {
  const configPath = join(configDir, "opencode.json");
  const config = await readJsonOrDefault(configPath, {});
  const plugins = Array.isArray(config.plugin) ? config.plugin : [];

  if (!plugins.some((entry) => entry === PLUGIN_NAME || entry.startsWith(`${PLUGIN_NAME}@`))) {
    plugins.push(PLUGIN_NAME);
  }

  config.plugin = plugins;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return configPath;
}

async function updateConfigPackage(configDir, pluginPackageDir) {
  const packagePath = join(configDir, "package.json");
  const pkg = await readJsonOrDefault(packagePath, {});

  pkg.dependencies = typeof pkg.dependencies === "object" && pkg.dependencies
    ? pkg.dependencies
    : {};

  pkg.dependencies[PLUGIN_NAME] = `file:${toPosixPath(pluginPackageDir)}`;

  await writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  return packagePath;
}

function installDependencies(configDir) {
  const commands = process.platform === "win32"
    ? [
        { cmd: "npm.cmd", args: ["install", "--prefix", configDir], shell: false },
        { cmd: "npm", args: ["install", "--prefix", configDir], shell: false },
        {
          cmd: process.env.ComSpec || "cmd.exe",
          args: ["/d", "/s", "/c", "npm", "install", "--prefix", configDir],
          shell: false
        }
      ]
    : [{ cmd: "npm", args: ["install", "--prefix", configDir], shell: false }];

  let lastError = null;

  for (const item of commands) {
    const install = spawnSync(item.cmd, item.args, {
      stdio: "inherit",
      shell: item.shell
    });

    if (install.status === 0) {
      return;
    }

    if (install.error) {
      lastError = install.error.message;
    } else {
      lastError = `exit code ${String(install.status)}`;
    }
  }

  throw new Error(`npm install failed while installing OpenCode notifier plugin (${lastError ?? "unknown"}).`);
}

async function main() {
  const repoRoot = resolve(process.cwd());
  const pluginPackageDir = resolve(repoRoot, "opencode-plugin");
  const configDir = await ensureConfigDir();

  const configPath = await updateOpenCodeConfig(configDir);
  const packagePath = await updateConfigPackage(configDir, pluginPackageDir);
  installDependencies(configDir);

  process.stdout.write(
    [
      "OpenCode notifier plugin 설치 완료",
      `- OpenCode config: ${configPath}`,
      `- Plugin package: ${packagePath}`,
      "- 적용 후 OpenCode IDE를 재시작하면 플러그인 목록에서 확인할 수 있습니다."
    ].join("\n") + "\n"
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
