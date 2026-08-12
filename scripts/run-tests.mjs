#!/usr/bin/env node

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const tests = [
  ...findTests(join(root, "src"), (name) => name.endsWith(".test.ts")),
  ...findTests(join(root, "scripts"), (name) => name.endsWith(".test.mjs")),
];

if (tests.length === 0) {
  console.error("No test files found under src/**/*.test.ts or scripts/**/*.test.mjs");
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", ...tests],
  { stdio: "inherit" },
);

process.exit(result.status ?? 1);

function findTests(dir, matches) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findTests(path, matches));
    } else if (entry.isFile() && matches(entry.name)) {
      files.push(path);
    }
  }

  return files.sort();
}
