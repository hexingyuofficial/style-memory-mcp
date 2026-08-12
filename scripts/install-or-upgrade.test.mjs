import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readlink, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { installOrUpgrade, parseArgs } from "./install-or-upgrade.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installerPath = join(repoRoot, "scripts", "install-or-upgrade.mjs");

test("installer requires explicit isolated paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "style-memory-install-args-"));
  try {
    await assert.rejects(
      () => installOrUpgrade({ sourceRoot: repoRoot, storePath: join(root, "store.json"), verifySource: false }),
      /installRoot is required/,
    );
    await assert.rejects(
      () => installOrUpgrade({ sourceRoot: repoRoot, installRoot: join(root, "install"), verifySource: false }),
      /storePath is required/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI accepts both documented store path spellings", () => {
  assert.deepEqual(
    parseArgs(["--install-root", "/tmp/install", "--store", "/tmp/store.json"]),
    { installRoot: "/tmp/install", storePath: "/tmp/store.json" },
  );
  assert.deepEqual(
    parseArgs(["--install-root", "/tmp/install", "--store-path", "/tmp/store.json"]),
    { installRoot: "/tmp/install", storePath: "/tmp/store.json" },
  );
});

test("installs into a completely fresh install root", async () => {
  const root = await mkdtemp(join(tmpdir(), "style-memory-install-fresh-"));
  try {
    const installRoot = join(root, "install");
    const storePath = join(root, "style-memory.json");
    const result = await installOrUpgrade({
      sourceRoot: repoRoot,
      installRoot,
      storePath,
      verifySource: false,
    });

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.code, "INSTALLED");
    assert.equal(await readlink(join(installRoot, "active")), "runtime/0.6.0");
    assert.equal(JSON.parse(await readFile(storePath, "utf8")).version, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installs a v0.4 fixture, migrates the store, and bootstraps three sessions", async () => {
  await withFixture(async (fixture) => {
    const result = await installOrUpgrade(fixture.options);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.code, "INSTALLED");
    assert.equal(await readlink(fixture.activePath), "runtime/0.6.0");
    assert.match(result.handshake.runtimePath, /\/runtime\/0\.6\.0\//);

    const migrated = JSON.parse(await readFile(fixture.storePath, "utf8"));
    assert.equal(migrated.version, 2);
    assert.equal(migrated.habits[0].id, "legacy-emoji");
    assert.equal(migrated.habits[0].text, "。。。");
    assert.equal(JSON.parse(await readFile(fixture.configPath, "utf8")).other.keep, true);
    assert.equal(JSON.parse(await readFile(fixture.configPath, "utf8")).mcpServers.other.command, "other");
    assert.equal(JSON.parse(await readFile(fixture.configPath, "utf8")).mcpServers["style-memory"].args[0], fixture.launcherPath);
    assert.match(await readFile(fixture.instructionPath, "utf8"), /style-memory-mcp:v0\.6\.0/);
    assert.doesNotMatch(await readFile(fixture.instructionPath, "utf8"), /style-memory-mcp:v0\.5\.0/);
    assert.equal(await fileExists(`${fixture.storePath}.v1-backup`), true);

    const sessions = await Promise.all(["e10-a", "e10-b", "e10-c"].map((sessionId) =>
      bootstrapSession(fixture.launcherPath, fixture.storePath, sessionId)));
    assert.deepEqual(sessions.map((session) => session.capsule), [sessions[0].capsule, sessions[0].capsule, sessions[0].capsule]);
    assert.deepEqual(sessions.map((session) => session.sessionId), ["e10-a", "e10-b", "e10-c"]);
  });
});

test("same-version installation is idempotent across three runs", async () => {
  await withFixture(async (fixture) => {
    const first = await installOrUpgrade(fixture.options);
    assert.equal(first.ok, true, JSON.stringify(first));
    const storeHash = await hashFile(fixture.storePath);
    const configHash = await hashFile(fixture.configPath);
    const instructionHash = await hashFile(fixture.instructionPath);
    const backupNames = await listNames(join(fixture.installRoot, "backup"));

    for (let index = 0; index < 3; index += 1) {
      const result = await installOrUpgrade(fixture.options);
      assert.equal(result.ok, true);
      assert.equal(result.code, "ALREADY_ACTIVE");
      assert.equal(await hashFile(fixture.storePath), storeHash);
      assert.equal(await hashFile(fixture.configPath), configHash);
      assert.equal(await hashFile(fixture.instructionPath), instructionHash);
      assert.deepEqual(await listNames(join(fixture.installRoot, "backup")), backupNames);
    }
  });
});

test("concurrent installers serialize on the install lock", async () => {
  await withFixture(async (fixture) => {
    const results = await Promise.all([
      installOrUpgrade(fixture.options),
      installOrUpgrade(fixture.options),
    ]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(results.filter((result) => result.code === "LOCKED").length, 1);
    assert.equal(await readlink(fixture.activePath), "runtime/0.6.0");
  });
});

test("each E10 fault point restores the old runtime, store, and host files", async () => {
  for (const fault of ["build", "migrate", "config", "switch", "server", "handshake"]) {
    await withFixture(async (fixture) => {
      const storeHash = await hashFile(fixture.storePath);
      const configHash = await hashFile(fixture.configPath);
      const instructionHash = await hashFile(fixture.instructionPath);
      const result = await installOrUpgrade({ ...fixture.options, fault });

      assert.equal(result.ok, false, fault);
      assert.equal(result.code, "ROLLED_BACK", fault);
      assert.equal(await readlink(fixture.activePath), "runtime/0.4.0", fault);
      assert.equal(await hashFile(fixture.storePath), storeHash, fault);
      assert.equal(await hashFile(fixture.configPath), configHash, fault);
      assert.equal(await hashFile(fixture.instructionPath), instructionHash, fault);
      assert.equal(await fileExists(join(fixture.installRoot, "runtime", "0.4.0", "runtime.json")), true, fault);
      assert.equal(await fileExists(join(fixture.installRoot, "runtime", "0.6.0", "runtime.json")), false, fault);
    }, { fault });
  }
});

test("stale locks are recoverable when their owner is dead", async () => {
  await withFixture(async (fixture) => {
    await writeFile(fixture.lockPath, JSON.stringify({ pid: 999999, token: "dead", createdAt: "2000-01-01T00:00:00.000Z" }));
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(fixture.lockPath, old, old);
    const result = await installOrUpgrade(fixture.options);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(await fileExists(fixture.lockPath), false);
  });
});

async function withFixture(callback, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), "style-memory-install-e10-"));
  try {
    const fixture = await makeFixture(root, extra);
    await callback(fixture);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function makeFixture(root, extra = {}) {
  const installRoot = join(root, "install");
  const storePath = join(root, "style-memory.json");
  const configPath = join(root, "host", "mcp.json");
  const instructionPath = join(root, "host", "AGENTS.md");
  const activePath = join(installRoot, "active");
  const launcherPath = join(installRoot, "launcher.mjs");
  const lockPath = join(installRoot, "install.lock");
  const oldRuntime = join(installRoot, "runtime", "0.4.0");

  await mkdir(join(oldRuntime, "dist"), { recursive: true });
  await cp(join(repoRoot, "dist"), join(oldRuntime, "dist"), { recursive: true });
  await writeFile(join(oldRuntime, "runtime.json"), JSON.stringify({ serverVersion: "0.4.0", fixture: true }));
  await symlink("runtime/0.4.0", activePath);
  await writeFile(storePath, JSON.stringify(legacyStore(storePath), null, 2));
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify({ other: { keep: true }, mcpServers: { other: { command: "other" } } }, null, 2) + "\n");
  await writeFile(instructionPath, "# Existing host instructions\n\n<!-- style-memory-mcp:v0.5.0 -->\nOld bootstrap protocol.\n");

  return {
    installRoot,
    storePath,
    configPath,
    instructionPath,
    activePath,
    launcherPath,
    lockPath,
    options: {
      sourceRoot: repoRoot,
      installRoot,
      storePath,
      mcpConfigPath: configPath,
      agentInstructionPath: instructionPath,
      verifySource: false,
      ...extra,
    },
  };
}

function legacyStore(storePath) {
  return {
    version: 1,
    settings: {
      dataPath: storePath,
      minPromoteCount: 3,
      candidateTtlDays: 30,
      inactiveTtlDays: 180,
      maxBriefItems: 8,
      allowLearning: true,
    },
    habits: [{
      id: "legacy-emoji",
      kind: "emoji",
      text: "。。。",
      confidence: 0.8,
      seenCount: 3,
      firstSeenAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-07-01T00:00:00.000Z",
      status: "active",
      pinned: false,
      useWhen: [],
      avoidWhen: [],
      example: "真的。。。",
      seenContexts: ["casual_chat", "technical_chat"],
    }],
    profile: { preferences: [] },
  };
}

async function bootstrapSession(launcherPath, storePath, sessionId) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [launcherPath],
    env: { ...process.env, STYLE_MEMORY_PATH: storePath },
  });
  const client = new Client({ name: `e10-${sessionId}`, version: "1" }, { capabilities: {} });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 3);
    const result = await client.callTool({ name: "bootstrap_style_memory", arguments: { channel: "agent", policy: "event", sessionId } });
    return JSON.parse(result.content.find((item) => item.type === "text").text);
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}

async function hashFile(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function fileExists(path) {
  try { await readFile(path); return true; } catch { return false; }
}

async function listNames(path) {
  try {
    const { readdir } = await import("node:fs/promises");
    return (await readdir(path)).sort();
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}
