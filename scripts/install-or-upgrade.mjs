#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { access, chmod, copyFile, cp, mkdir, open, readFile, readlink, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_VERSION = "0.6.0";
const LOCK_STALE_MS = 10 * 60 * 1000;
const MARKER = "style-memory-mcp:v0.6.0";

/**
 * Install a built runtime into an isolated root. Every mutable external path
 * is supplied by the caller so E10 can exercise the transaction in a sandbox.
 */
export async function installOrUpgrade(options = {}) {
  const sourceRoot = resolve(options.sourceRoot ?? join(SCRIPT_DIR, ".."));
  if (typeof options.installRoot !== "string" || !options.installRoot.trim()) {
    throw new Error("installRoot is required");
  }
  if (typeof options.storePath !== "string" || !options.storePath.trim()) {
    throw new Error("storePath is required");
  }
  const installRoot = resolve(options.installRoot);
  const storePath = resolve(options.storePath);
  const homeRoot = process.env.HOME ? resolve(process.env.HOME) : undefined;
  if (installRoot === resolve("/") || (homeRoot && installRoot === homeRoot)) {
    throw new Error("installRoot must be an explicit non-root sandbox path");
  }

  const version = options.version ?? await readPackageVersion(sourceRoot);
  const fault = options.fault ?? process.env.STYLE_MEMORY_INSTALL_FAULT;
  const verifySource = options.verifySource ?? true;
  const token = randomUUID();
  const runtimeRoot = join(installRoot, "runtime");
  const stagingRoot = join(installRoot, "staging");
  const backupRoot = join(installRoot, "backup");
  const stagingPath = join(stagingRoot, `${version}-${process.pid}-${token}`);
  const runtimePath = join(runtimeRoot, version);
  const activePath = join(installRoot, "active");
  const launcherPath = join(installRoot, "launcher.mjs");
  const mcpConfigPath = options.mcpConfigPath ? resolve(options.mcpConfigPath) : undefined;
  const agentInstructionPath = options.agentInstructionPath ? resolve(options.agentInstructionPath) : undefined;

  await mkdir(installRoot, { recursive: true, mode: 0o700 });
  const lock = await acquireLock(join(installRoot, "install.lock"), options.staleLockMs ?? LOCK_STALE_MS);
  if (!lock) return { ok: false, code: "LOCKED", installRoot, version };

  const original = {
    activeTarget: await readSymlinkTarget(activePath),
    launcher: await snapshotFile(launcherPath),
    config: mcpConfigPath ? await snapshotFile(mcpConfigPath) : undefined,
    instruction: agentInstructionPath ? await snapshotFile(agentInstructionPath) : undefined,
    store: await snapshotFile(storePath),
  };
  const createdBackups = [];
  let switched = false;
  let migrated = false;
  let runtimeCreated = false;

  try {
    await maybeFail(fault, "build");
    if (verifySource) await verifySourceTree(sourceRoot);

    await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
    await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    await mkdir(backupRoot, { recursive: true, mode: 0o700 });
    await cp(join(sourceRoot, "dist"), join(stagingPath, "dist"), { recursive: true });
    await cp(join(sourceRoot, "node_modules"), join(stagingPath, "node_modules"), { recursive: true });
    await copyFile(join(sourceRoot, "package.json"), join(stagingPath, "package.json"));
    await writeJson(join(stagingPath, "runtime.json"), {
      serverVersion: version,
      builtAt: new Date().toISOString(),
      sourceRoot,
    });
    await access(join(stagingPath, "dist", "server.js"));

    if (await pathExists(storePath)) {
      const storeBackup = `${storePath}.install-backup-${token}`;
      await copyFile(storePath, storeBackup);
      await chmod(storeBackup, 0o600);
      createdBackups.push(storeBackup);
      await maybeFail(fault, "migrate");
      const storeModule = await import(pathToFileURL(join(stagingPath, "dist", "store.js")).href);
      const migration = await storeModule.migrateStoreFile(storePath);
      migrated = migration.migrated === true;
    }

    if (!(await pathExists(runtimePath))) {
      await rename(stagingPath, runtimePath);
      runtimeCreated = true;
    } else {
      await access(join(runtimePath, "dist", "server.js"));
      await rm(stagingPath, { recursive: true, force: true });
    }

    const launcherText = launcherSource();
    if (!(await sameFileText(launcherPath, launcherText))) {
      await backupBeforeChange(launcherPath, backupRoot, token, createdBackups);
      await atomicWrite(launcherPath, launcherText, 0o755);
      await chmod(launcherPath, 0o755);
    }

    const currentTarget = original.activeTarget;
    const currentVersion = currentTarget ? currentTarget.split(/[\\/]/).at(-1) : undefined;
    if (currentVersion !== version) {
      if (currentTarget) {
        const backupLink = join(backupRoot, `active-${currentVersion || "unknown"}-${token}`);
        await symlink(resolve(installRoot, currentTarget), backupLink);
        createdBackups.push(backupLink);
      }
      await switchActive(activePath, runtimePath, token);
      switched = true;
    }

    if (mcpConfigPath || agentInstructionPath) {
      await configureHosts({
        mcpConfigPath,
        agentInstructionPath,
        launcherPath,
        storePath,
        backupRoot,
        token,
        createdBackups,
      });
    }
    await maybeFail(fault, "config");
    await maybeFail(fault, "switch");
    await maybeFail(fault, "server");
    await maybeFail(fault, "handshake");
    const handshake = await verifyRuntime(launcherPath, storePath, version);

    await releaseLock(lock);
    return {
      ok: true,
      code: currentVersion === version ? "ALREADY_ACTIVE" : "INSTALLED",
      version,
      installRoot,
      runtimePath,
      launcherPath,
      storePath,
      migrated,
      handshake,
      backups: createdBackups,
    };
  } catch (error) {
    const rollback = await rollbackInstall({
      activePath,
      launcherPath,
      mcpConfigPath,
      agentInstructionPath,
      storePath,
      original,
      switched,
      stagingPath,
      runtimePath,
      runtimeCreated,
    });
    await releaseLock(lock);
    return {
      ok: false,
      code: "ROLLED_BACK",
      version,
      installRoot,
      fault: fault ?? "none",
      error: error instanceof Error ? error.message : String(error),
      rollback,
    };
  }
}

async function verifySourceTree(sourceRoot) {
  const commands = [
    ["npm", ["run", "check"]],
    ["npm", ["test"]],
    ["npm", ["run", "build"]],
  ];
  for (const [command, args] of commands) {
    const result = spawnSync(command, args, { cwd: sourceRoot, encoding: "utf8", stdio: "pipe" });
    if (result.status !== 0) {
      const tail = `${result.stdout || ""}\n${result.stderr || ""}`.trim().slice(-1200);
      throw new Error(`source verification failed: ${command} ${args.join(" ")}\n${tail}`);
    }
  }
}

async function verifyRuntime(launcherPath, storePath, expectedVersion) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [launcherPath],
    env: { ...process.env, STYLE_MEMORY_PATH: storePath, STYLE_MEMORY_TOOLSET: "admin" },
  });
  const client = new Client({ name: "style-memory-install-check", version: "1" }, { capabilities: {} });
  try {
    await client.connect(transport);
    const bootstrapResult = await client.callTool({ name: "bootstrap_style_memory", arguments: { channel: "agent", policy: "event", sessionId: "install-check" } });
    const bootstrap = parseToolJson(bootstrapResult);
    const statusResult = await client.callTool({ name: "get_style_memory_status", arguments: {} });
    const status = parseToolJson(statusResult);
    if (bootstrap.serverVersion !== expectedVersion || bootstrap.storeVersion !== 2) throw new Error("runtime bootstrap handshake mismatch");
    if (status.serverVersion !== expectedVersion || status.storeVersion !== 2 || !String(status.runtimePath).includes(`/runtime/${expectedVersion}/`)) {
      throw new Error("runtime status handshake mismatch");
    }
    return { serverVersion: bootstrap.serverVersion, storeVersion: bootstrap.storeVersion, runtimePath: status.runtimePath, revision: bootstrap.revision };
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}

function parseToolJson(result) {
  const text = result?.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("runtime returned no text handshake");
  return JSON.parse(text);
}

async function configureHosts({ mcpConfigPath, agentInstructionPath, launcherPath, storePath, backupRoot, token, createdBackups }) {
  if (mcpConfigPath) {
    const current = await readJsonOrEmpty(mcpConfigPath);
    const next = { ...current, mcpServers: { ...(isObject(current.mcpServers) ? current.mcpServers : {}) } };
    const previous = isObject(next.mcpServers["style-memory"]) ? next.mcpServers["style-memory"] : {};
    next.mcpServers["style-memory"] = {
      ...previous,
      command: process.execPath,
      args: [launcherPath],
      env: { ...(isObject(previous.env) ? previous.env : {}), STYLE_MEMORY_PATH: storePath },
    };
    const text = `${JSON.stringify(next, null, 2)}\n`;
    if (!(await sameFileText(mcpConfigPath, text))) {
      await backupBeforeChange(mcpConfigPath, backupRoot, token, createdBackups);
      await atomicWrite(mcpConfigPath, text, 0o600);
    }
  }
  if (agentInstructionPath) {
    const current = await readTextOrEmpty(agentInstructionPath);
    const protocol = `\n\n<!-- ${MARKER} -->\nAt the start of each new session, call bootstrap_style_memory, then read the returned capsule before the first substantive reply. If initialization.status is pending, inspect at most 12 host-local sessions from the last 30 days and call bootstrap_style_memory once more with only sanitized aggregate initialization fields; never send raw sessions, titles, identity, secrets, files, or full conversation logs. If history is unavailable, send initialization.action=skip. Use observe_style_event only according to the returned channel/policy.\n`;
    const withoutOldProtocol = current.replace(/\n*<!-- style-memory-mcp:v\d+\.\d+\.\d+ -->\n[^\n]*(?:\n|$)/g, "").trimEnd();
    const next = current.includes(`<!-- ${MARKER} -->`) ? current : `${withoutOldProtocol}${protocol}`;
    if (!(await sameFileText(agentInstructionPath, next))) {
      await backupBeforeChange(agentInstructionPath, backupRoot, token, createdBackups);
      await atomicWrite(agentInstructionPath, next, 0o600);
    }
  }
}

async function rollbackInstall({ activePath, launcherPath, mcpConfigPath, agentInstructionPath, storePath, original, switched, stagingPath, runtimePath, runtimeCreated }) {
  const actions = [];
  await rm(stagingPath, { recursive: true, force: true });
  if (switched) {
    if (original.activeTarget) await replaceSymlink(activePath, original.activeTarget);
    else await unlink(activePath).catch(() => undefined);
    actions.push("active");
  }
  if (runtimeCreated) {
    await rm(runtimePath, { recursive: true, force: true });
    actions.push("newRuntime");
  }
  await restoreFile(launcherPath, original.launcher);
  if (mcpConfigPath) await restoreFile(mcpConfigPath, original.config);
  if (agentInstructionPath) await restoreFile(agentInstructionPath, original.instruction);
  await restoreFile(storePath, original.store);
  if (original.store?.exists) actions.push("store");
  if (original.config?.exists || mcpConfigPath) actions.push("config");
  if (original.instruction?.exists || agentInstructionPath) actions.push("instruction");
  return { restored: actions, oldRuntime: original.activeTarget, newRuntime: runtimePath };
}

async function acquireLock(lockPath, staleLockMs) {
  try {
    const handle = await open(lockPath, "wx", 0o600);
    const token = randomUUID();
    await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }));
    await handle.close();
    return { lockPath, token };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    let stale = false;
    try {
      const stat = await (await import("node:fs/promises")).stat(lockPath);
      const raw = JSON.parse(await readFile(lockPath, "utf8"));
      stale = Date.now() - stat.mtimeMs > staleLockMs && !isProcessAlive(raw.pid);
    } catch {
      stale = false;
    }
    if (stale) {
      await rename(lockPath, `${lockPath}.stale-${Date.now()}-${randomUUID()}`).catch(() => undefined);
      return acquireLock(lockPath, staleLockMs);
    }
    return undefined;
  }
}

async function releaseLock(lock) {
  try {
    const current = JSON.parse(await readFile(lock.lockPath, "utf8"));
    if (current.token === lock.token) await unlink(lock.lockPath);
  } catch {
    // A concurrent stale-lock repair may already have moved the lock.
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function switchActive(activePath, runtimePath, token) {
  const next = `${activePath}.next-${token}`;
  await symlink(relative(dirname(activePath), runtimePath), next);
  await rename(next, activePath);
}

async function replaceSymlink(linkPath, target) {
  const next = `${linkPath}.rollback-${randomUUID()}`;
  await symlink(target, next);
  await rename(next, linkPath);
}

async function backupBeforeChange(filePath, backupRoot, token, createdBackups) {
  if (!(await pathExists(filePath))) return;
  const backup = join(backupRoot, `${filePath.split(/[\\/]/).at(-1)}-${token}.bak`);
  await copyFile(filePath, backup);
  createdBackups.push(backup);
}

async function snapshotFile(filePath) {
  try { return { exists: true, data: await readFile(filePath) }; }
  catch (error) { if (error?.code === "ENOENT") return { exists: false }; throw error; }
}

async function restoreFile(filePath, snapshot) {
  if (!snapshot) return;
  if (snapshot.exists) await atomicWrite(filePath, snapshot.data);
  else await unlink(filePath).catch(() => undefined);
}

async function readSymlinkTarget(filePath) {
  try { return await readlink(filePath); }
  catch (error) { if (error?.code === "ENOENT") return undefined; throw error; }
}

async function pathExists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

async function sameFileText(filePath, expected) {
  try { return (await readFile(filePath, "utf8")) === expected; } catch { return false; }
}

async function readTextOrEmpty(filePath) {
  try { return await readFile(filePath, "utf8"); } catch (error) { if (error?.code === "ENOENT") return ""; throw error; }
}

async function readJsonOrEmpty(filePath) {
  const text = await readTextOrEmpty(filePath);
  if (!text.trim()) return {};
  const parsed = JSON.parse(text);
  if (!isObject(parsed)) throw new Error(`unsupported host config root: ${filePath}`);
  return parsed;
}

async function atomicWrite(filePath, data, mode = 0o600) {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const temp = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temp, "w", mode);
  try {
    if (typeof data === "string") await handle.writeFile(data, "utf8");
    else await handle.writeFile(data);
    await handle.sync();
  } finally { await handle.close(); }
  await rename(temp, filePath).catch(async (error) => { await unlink(temp).catch(() => undefined); throw error; });
}

async function writeJson(filePath, value) { await atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`); }
async function readPackageVersion(sourceRoot) { try { return JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8")).version || DEFAULT_VERSION; } catch { return DEFAULT_VERSION; } }
function isObject(value) { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function launcherSource() { return `#!/usr/bin/env node\nimport { join } from "node:path";\nimport { realpath } from "node:fs/promises";\nimport { fileURLToPath, pathToFileURL } from "node:url";\nconst root = fileURLToPath(new URL(".", import.meta.url));\nconst runtimePath = await realpath(join(root, "active"));\nprocess.env.STYLE_MEMORY_RUNTIME_PATH = join(runtimePath, "dist", "server.js");\nawait import(pathToFileURL(join(runtimePath, "dist", "server.js")).href);\n`; }
async function maybeFail(actual, point) { if (actual === point) throw new Error(`fault injection: ${point}`); }

if (pathToFileURL(process.argv[1] || "").href === import.meta.url) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.installRoot || !args.storePath) {
    console.error("Usage: install-or-upgrade --install-root PATH --store PATH [--mcp-config PATH] [--agent-instruction PATH] [--fault POINT]");
    process.exitCode = 2;
  } else {
    const result = await installOrUpgrade(args);
    console.log(JSON.stringify(result));
    process.exitCode = result.ok ? 0 : 1;
  }
}

export function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const normalizedKey = key === "store" ? "storePath" : key;
    out[normalizedKey] = argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[++index] : true;
  }
  return out;
}
