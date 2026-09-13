import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "./config.js";
import { historyDirectory } from "./mcp/changes.js";

export function testConfigPathOverride() {
  const original = process.env.AERODROME_CONFIG_PATH;
  const historyOriginal = process.env.AERODROME_HISTORY_DIR;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aero-config-test-"));
  const valid = path.join(directory, "valid.json"), invalid = path.join(directory, "invalid.json"), large = path.join(directory, "large.json"), missing = path.join(directory, "missing.json");
  try {
    fs.writeFileSync(valid, "{}"); fs.writeFileSync(invalid, "{\"veNftTokenIds\":\"bad\"}"); fs.writeFileSync(large, " ".repeat(64001));
    process.env.AERODROME_CONFIG_PATH = valid; assert.deepEqual(loadConfig().veNftTokenIds, []);
    process.env.AERODROME_CONFIG_PATH = invalid; assert.throws(() => loadConfig(), /Configuration is invalid/);
    process.env.AERODROME_CONFIG_PATH = missing; assert.throws(() => loadConfig(), /Configured configuration file is unavailable/);
    process.env.AERODROME_CONFIG_PATH = "relative.json"; assert.throws(() => loadConfig(), /must be an absolute path/);
    process.env.AERODROME_CONFIG_PATH = large; assert.throws(() => loadConfig(), /Configuration too large/);
    fs.writeFileSync(invalid, "{private-example-not-json"); process.env.AERODROME_CONFIG_PATH = invalid;
    assert.throws(() => loadConfig(), error => error instanceof Error && error.message === "Configuration is invalid.");
    process.env.AERODROME_HISTORY_DIR = directory; assert.equal(historyDirectory(),directory);
    process.env.AERODROME_HISTORY_DIR = "relative"; assert.throws(()=>historyDirectory(),/absolute path/);
  } finally {
    if (original === undefined) delete process.env.AERODROME_CONFIG_PATH; else process.env.AERODROME_CONFIG_PATH = original;
    if (historyOriginal === undefined) delete process.env.AERODROME_HISTORY_DIR; else process.env.AERODROME_HISTORY_DIR = historyOriginal;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

testConfigPathOverride();
console.log("Config path override tests passed.");
