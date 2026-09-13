// Process-level persistence probe. Fixtures contain only synthetic test data.
import assert from "node:assert/strict";
import fs from "node:fs";
import { getWalletChanges } from "./mcp/changes.js";
const [mode, directory, fixture, requestId] = process.argv.slice(2);
const { cfg, current } = JSON.parse(fs.readFileSync(fixture, "utf8"));
const runtime = { cfg, client: {} };
if (mode === "busy") {
  await assert.rejects(getWalletChanges(runtime, directory, async () => { throw new Error("Must lock before RPC"); }, { requestId }), /HISTORY_BUSY/);
} else {
  const result = await getWalletChanges(runtime, directory, async () => {
    if (mode === "replay") throw new Error("Replay called RPC");
    if (mode === "hold") {
      process.stdout.write("locked\n");
      await new Promise<void>(resolve => process.stdin.once("data", () => resolve()));
    }
    return current;
  }, { requestId });
  if (mode === "replay") process.stdout.write(JSON.stringify(result));
}
