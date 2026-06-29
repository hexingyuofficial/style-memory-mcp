import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const testDir = join(tmpdir(), `style-memory-dict-${randomUUID()}`);
const dictionaryPath = join(testDir, "dictionary.json");
let savedDictionaryPath: string | undefined;

before(async () => {
  savedDictionaryPath = process.env.STYLE_MEMORY_DICTIONARY_PATH;
  await mkdir(testDir, { recursive: true });
  await writeFile(
    dictionaryPath,
    JSON.stringify({
      habits: [
        {
          kind: "catchphrase",
          text: "ship it",
          locale: "en",
          confidenceDelta: 0.2,
          useWhen: ["technical_chat"],
          avoidWhen: ["formal_writing"],
          match: "word",
        },
        {
          kind: "idiolect",
          text: "妙啊",
          locale: "zh-CN",
          match: "substring",
        },
      ],
    }),
    "utf8",
  );
  process.env.STYLE_MEMORY_DICTIONARY_PATH = dictionaryPath;
});

after(async () => {
  if (savedDictionaryPath === undefined) {
    delete process.env.STYLE_MEMORY_DICTIONARY_PATH;
  } else {
    process.env.STYLE_MEMORY_DICTIONARY_PATH = savedDictionaryPath;
  }
  await rm(testDir, { recursive: true, force: true });
});

describe("custom dictionary extraction", () => {
  it("loads custom dictionary entries from STYLE_MEMORY_DICTIONARY_PATH", async () => {
    const { extractHabits } = await import(`./extract.js?dict=${randomUUID()}`);
    const result = extractHabits("妙啊, let's ship it today");
    const texts = result.map((habit) => habit.text);

    assert.ok(texts.includes("妙啊"));
    assert.ok(texts.includes("ship it"));

    const shipIt = result.find((habit) => habit.text === "ship it");
    assert.equal(shipIt?.locale, "en");
    assert.equal(shipIt?.confidenceDelta, 0.2);
    assert.deepEqual(shipIt?.useWhen, ["technical_chat"]);
  });

  it("respects word matching for custom dictionary entries", async () => {
    const { extractHabits } = await import(`./extract.js?dict=${randomUUID()}`);
    const result = extractHabits("this shipment is late");
    assert.ok(!result.some((habit) => habit.text === "ship it"));
  });
});
