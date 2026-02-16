#!/usr/bin/env node

import { readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PLUGIN_NAME = "opencode-notifier-plugin";

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

async function main() {
  const configDir = candidateConfigDirs().find((dir) => existsSync(dir));
  if (!configDir) {
    process.stdout.write("OpenCode config 디렉터리를 찾지 못했습니다.\n");
    return;
  }

  const configPath = join(configDir, "opencode.json");
  const pkgPath = join(configDir, "package.json");

  const config = await readJsonOrDefault(configPath, {});
  if (Array.isArray(config.plugin)) {
    config.plugin = config.plugin.filter(
      (entry) => !(entry === PLUGIN_NAME || (typeof entry === "string" && entry.startsWith(`${PLUGIN_NAME}@`)))
    );
  }
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const pkg = await readJsonOrDefault(pkgPath, {});
  if (pkg.dependencies && typeof pkg.dependencies === "object") {
    delete pkg.dependencies[PLUGIN_NAME];
  }
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

  await rm(join(configDir, "node_modules", PLUGIN_NAME), { recursive: true, force: true });

  process.stdout.write("OpenCode notifier plugin 제거 완료\n");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
