#!/usr/bin/env node

import { readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PLUGIN_NAME = "opencode-notifier-plugin";
const PLUGIN_ENTRY_FILE = "opencode-notifier-plugin.js";

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

function isNotifierPluginEntry(entry, pluginSpecifier) {
  return isLegacyPluginEntry(entry) || entry === pluginSpecifier || isNotifierFilePluginEntry(entry);
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

async function readJsonOrDefault(filePath, fallback) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function main() {
  const repoRoot = resolve(process.cwd());
  const pluginSpecifier = pathToFileURL(resolve(repoRoot, "opencode-plugin", PLUGIN_ENTRY_FILE)).href;
  const candidates = candidateConfigDirs();
  const configDir =
    candidates.find((dir) => existsSync(join(dir, "opencode.json")) || existsSync(join(dir, "package.json")))
    || candidates.find((dir) => existsSync(dir));

  if (!configDir) {
    process.stdout.write("OpenCode config 디렉터리를 찾지 못했습니다.\n");
    return;
  }

  const configPath = join(configDir, "opencode.json");
  const pkgPath = join(configDir, "package.json");

  const config = await readJsonOrDefault(configPath, {});
  if (Array.isArray(config.plugin)) {
    config.plugin = config.plugin.filter((entry) => !isNotifierPluginEntry(entry, pluginSpecifier));
  }
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  if (existsSync(pkgPath)) {
    const pkg = await readJsonOrDefault(pkgPath, {});
    if (pkg.dependencies && typeof pkg.dependencies === "object") {
      delete pkg.dependencies[PLUGIN_NAME];
    }
    await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  }

  await rm(join(configDir, "node_modules", PLUGIN_NAME), { recursive: true, force: true });

  process.stdout.write("OpenCode notifier plugin 제거 완료\n");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
