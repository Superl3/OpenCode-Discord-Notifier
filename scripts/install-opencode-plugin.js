#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PLUGIN_NAME = "opencode-notifier-plugin";
const PLUGIN_ENTRY_FILE = "opencode-notifier-plugin.js";

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
  const existing =
    candidates.find((dir) => existsSync(join(dir, "opencode.json")) || existsSync(join(dir, "package.json")))
    || candidates.find((dir) => existsSync(dir));

  const target = existing || candidates[0];
  await mkdir(target, { recursive: true });
  return target;
}

function isLegacyPluginEntry(entry) {
  return typeof entry === "string" && (entry === PLUGIN_NAME || entry.startsWith(`${PLUGIN_NAME}@`));
}

function isNotifierFilePluginEntry(entry) {
  if (typeof entry !== "string" || !entry.startsWith("file://")) {
    return false;
  }

  try {
    const url = new URL(entry);
    const normalizedPath = decodeURIComponent(url.pathname).replace(/\\/g, "/").toLowerCase();
    return (
      normalizedPath.endsWith("/opencode-plugin/index.js")
      || normalizedPath.endsWith(`/opencode-plugin/${PLUGIN_ENTRY_FILE}`)
    );
  } catch {
    return false;
  }
}

async function updateOpenCodeConfig(configDir, pluginSpecifier) {
  const configPath = join(configDir, "opencode.json");
  const config = await readJsonOrDefault(configPath, {});
  const plugins = Array.isArray(config.plugin)
    ? config.plugin.filter((entry) => !isLegacyPluginEntry(entry) && !isNotifierFilePluginEntry(entry))
    : [];

  plugins.push(pluginSpecifier);

  config.plugin = plugins;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return configPath;
}

function buildPluginSpecifier(repoRoot) {
  const pluginEntryPath = resolve(repoRoot, "opencode-plugin", PLUGIN_ENTRY_FILE);
  if (!existsSync(pluginEntryPath)) {
    throw new Error(`플러그인 진입 파일을 찾지 못했습니다: ${pluginEntryPath}`);
  }

  return pathToFileURL(pluginEntryPath).href;
}

async function main() {
  const repoRoot = resolve(process.cwd());
  const pluginSpecifier = buildPluginSpecifier(repoRoot);
  const configDir = await ensureConfigDir();

  const configPath = await updateOpenCodeConfig(configDir, pluginSpecifier);

  process.stdout.write(
    [
      "OpenCode notifier plugin 설치 완료",
      `- OpenCode config: ${configPath}`,
      `- Plugin specifier: ${pluginSpecifier}`,
      "- 적용 후 OpenCode IDE를 재시작하면 플러그인 목록에서 확인할 수 있습니다."
    ].join("\n") + "\n"
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
