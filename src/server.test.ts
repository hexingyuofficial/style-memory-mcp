import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const dir = join(tmpdir(), `style-memory-server-${randomUUID()}`);
const dataPath = join(dir, "store.json");
let client: Client;

before(async () => {
  await mkdir(dir, { recursive: true });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/server.ts"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      STYLE_MEMORY_PATH: dataPath,
      STYLE_MEMORY_CHANNEL: "agent",
      STYLE_MEMORY_AGENT_POLICY: "event",
    },
  });
  client = new Client({ name: "v06-schema-test", version: "1" }, { capabilities: {} });
  await client.connect(transport);
});

after(async () => {
  await client?.close();
  await rm(dir, { recursive: true, force: true });
});

describe("v0.6 runtime schema", () => {
  it("rejects raw session history and identity fields during initialization", async () => {
    const result = await client.callTool({
      name: "bootstrap_style_memory",
      arguments: {
        channel: "agent",
        policy: "event",
        sessionId: "schema-reject",
        initialization: {
          action: "complete",
          sessions: [{ title: "private title", messages: ["full conversation"] }],
          addresses: ["real name"],
          failureRules: ["private event"],
        },
      },
    });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /Invalid arguments|Unrecognized key/i);
  });

  it("accepts a bounded aggregate initialization payload", async () => {
    const result = await client.callTool({
      name: "bootstrap_style_memory",
      arguments: {
        channel: "agent",
        policy: "event",
        sessionId: "schema-accept",
        initialization: {
          action: "complete",
          lookbackDays: 30,
          sessionCount: 4,
          observedVoice: { verbosity: 2, rhythm: "short direct clauses" },
        },
      },
    });
    assert.equal(result.isError, undefined);
    assert.match(JSON.stringify(result.content), /completed/);
  });
});
