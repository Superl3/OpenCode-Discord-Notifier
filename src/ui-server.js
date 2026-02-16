#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, relative, resolve } from "node:path";

const HOST = process.env.NOTIFIER_UI_HOST ?? "127.0.0.1";
const PORT = Number.parseInt(process.env.NOTIFIER_UI_PORT ?? "4780", 10);

const WORKDIR = process.cwd();
const STATIC_DIR = resolve(WORKDIR, "ui");
const DEFAULT_CONFIG_PATH = "opencode-notifier.config.json";
const EXAMPLE_CONFIG_PATH = resolve(WORKDIR, "opencode-notifier.config.example.json");
const NOTIFIER_SCRIPT_PATH = resolve(WORKDIR, "src/opencode-notifier.js");

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 32000;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": MIME_TYPES[".json"] });
  response.end(JSON.stringify(payload));
}

function sendText(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(payload);
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function truncateOutput(value) {
  if (value.length <= MAX_OUTPUT_CHARS) {
    return value;
  }
  return `${value.slice(0, MAX_OUTPUT_CHARS)}\n... [truncated]`;
}

function toRelativePath(absPath) {
  const rel = relative(WORKDIR, absPath);
  return rel.startsWith("..") ? absPath : rel.replace(/\\/g, "/");
}

function resolveConfigPath(inputPath) {
  const raw = typeof inputPath === "string" && inputPath.trim().length > 0
    ? inputPath.trim()
    : DEFAULT_CONFIG_PATH;

  return resolve(WORKDIR, raw);
}

async function parseJsonBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;

    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejectBody(new Error("Request body too large."));
        request.destroy();
        return;
      }

      chunks.push(chunk);
    });

    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();

      if (!raw) {
        resolveBody({});
        return;
      }

      try {
        const parsed = JSON.parse(raw);
        resolveBody(parsed);
      } catch {
        rejectBody(new Error("Body must be valid JSON."));
      }
    });

    request.on("error", (error) => {
      rejectBody(error);
    });
  });
}

async function readConfig(configPathInput) {
  const configPath = resolveConfigPath(configPathInput);

  try {
    const raw = await readFile(configPath, "utf8");
    return {
      config: JSON.parse(raw),
      exists: true,
      path: toRelativePath(configPath),
      source: "config"
    };
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }

    const template = await readFile(EXAMPLE_CONFIG_PATH, "utf8");
    return {
      config: JSON.parse(template),
      exists: false,
      path: toRelativePath(configPath),
      source: "template"
    };
  }
}

async function saveConfig(configPathInput, config) {
  if (!isPlainObject(config)) {
    throw new Error("Config must be a JSON object.");
  }

  const targetPath = resolveConfigPath(configPathInput);
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  return {
    path: toRelativePath(targetPath)
  };
}

async function runDryRun(config) {
  if (!isPlainObject(config)) {
    throw new Error("Dry-run requires a config object.");
  }

  const tempConfigPath = resolve(WORKDIR, `.opencode-notifier.ui.${randomUUID()}.json`);

  await writeFile(tempConfigPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const args = [
    NOTIFIER_SCRIPT_PATH,
    "--dry-run",
    "--once",
    "--config",
    tempConfigPath,
    "--",
    process.execPath,
    "-e",
    "console.log('build complete'); console.log('[assistant] Build finished. Updated 3 files and waiting for your next instruction.'); console.log('waiting for input');"
  ];

  let stdout = "";
  let stderr = "";
  let timedOut = false;

  const child = spawn(process.execPath, args, {
    cwd: WORKDIR,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, 20000);

  try {
    const result = await new Promise((resolveResult, rejectResult) => {
      child.once("error", (error) => {
        rejectResult(error);
      });

      child.once("close", (code, signal) => {
        resolveResult({ code, signal });
      });
    });

    return {
      command: [process.execPath, ...args],
      code: result.code,
      signal: result.signal,
      timedOut,
      stdout: truncateOutput(stdout),
      stderr: truncateOutput(stderr)
    };
  } finally {
    clearTimeout(timeout);
    await rm(tempConfigPath, { force: true });
  }
}

async function serveStatic(pathname, response) {
  const normalizedPath = pathname === "/" ? "/index.html" : pathname;
  const absolutePath = resolve(STATIC_DIR, `.${normalizedPath}`);

  if (!absolutePath.startsWith(STATIC_DIR)) {
    sendText(response, 403, "Forbidden");
    return;
  }

  try {
    const content = await readFile(absolutePath);
    const mimeType = MIME_TYPES[extname(absolutePath)] ?? "application/octet-stream";
    response.writeHead(200, { "Content-Type": mimeType });
    response.end(content);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      sendText(response, 404, "Not Found");
      return;
    }

    sendText(response, 500, "Failed to read static asset.");
  }
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${HOST}:${PORT}`}`);
    const pathname = url.pathname;

    if (request.method === "GET" && pathname === "/api/health") {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "GET" && pathname === "/api/config") {
      const configPath = url.searchParams.get("path");
      const loaded = await readConfig(configPath);
      sendJson(response, 200, loaded);
      return;
    }

    if (request.method === "POST" && pathname === "/api/config/save") {
      const body = await parseJsonBody(request);
      const result = await saveConfig(body.path, body.config);
      sendJson(response, 200, { ok: true, ...result });
      return;
    }

    if (request.method === "POST" && pathname === "/api/dry-run") {
      const body = await parseJsonBody(request);
      const result = await runDryRun(body.config);
      sendJson(response, 200, { ok: true, ...result });
      return;
    }

    if (pathname.startsWith("/api/")) {
      sendJson(response, 404, { ok: false, error: "Unknown API route." });
      return;
    }

    await serveStatic(pathname, response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(response, 500, { ok: false, error: message });
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`Notifier UI running at http://${HOST}:${PORT}\n`);
});
