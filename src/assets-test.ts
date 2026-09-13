import assert from "node:assert/strict";
import { publicConfig } from "./config.js";
import { getWalletAssets } from "./mcp/assets.js";
import { walletAssetsSchema } from "./mcp/assets-schema.js";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const WALLET = address(2), VE = address(3), ESCROW = address(4);
const pinned = { rawBlockNumber: 123n, rawTimestamp: 1500n, value: { observedAt: "2026-01-01T00:00:00.000Z", blockNumber: "123", blockHash: `0x${"ab".repeat(32)}`, blockTimestamp: "1970-01-01T00:25:00.000Z" } };

function fixture(mode = "normal") {
  const cfg = { ...publicConfig(), walletAddress: WALLET, veNftTokenIds: ["1"] };
  const controller = new AbortController();
  const client = {
    getBalance: async ({ blockNumber }: { blockNumber?: bigint }) => { if (blockNumber !== 123n) throw new Error("unpinned ETH"); if (mode === "balanceFail") throw new Error("unavailable"); return 125n; },
    readContract: async (call: { address: string; functionName: string; args?: unknown[]; blockNumber?: bigint }) => {
      if (call.blockNumber !== 123n) throw new Error("unpinned contract");
      if (mode === "cancel") controller.abort();
      switch (call.functionName) {
        case "token": if (mode === "escrowTokenFail") throw new Error("missing token"); return ESCROW;
        case "balanceOf": return call.address.toLowerCase() === ESCROW.toLowerCase() ? 100n : 2n;
        case "symbol": return call.address.toLowerCase() === ESCROW.toLowerCase() ? "AERO" : "USDC";
        case "decimals": if (mode === "unknownUnits" && call.address.toLowerCase() === ESCROW.toLowerCase()) throw new Error("missing decimals"); return call.address.toLowerCase() === ESCROW.toLowerCase() ? 18 : 6;
        case "ownerOf": if (mode === "ownerFail") throw new Error("owner unavailable"); return mode === "notOwned" ? address(9) : WALLET;
        case "escrowType": return mode === "managed" ? 2 : mode === "invalidType" ? 3 : 0;
        case "locked": return mode === "permanent" ? { amount: 50n, end: -1n, isPermanent: true } : { amount: 50n, end: 2000n, isPermanent: false };
        default: throw new Error(`unexpected ${call.functionName}`);
      }
    }
  };
  return { cfg, client, signal: controller.signal, pinnedObservation: pinned };
}

export async function testWalletAssets() {
  const normal = await getWalletAssets(fixture(), { contracts: { votingEscrow: VE } });
  walletAssetsSchema.parse(normal);
  assert.equal(normal.liquidBalances[0].amountRaw, "125");
  assert.equal(normal.locks[0].principalRaw, "50");
  assert.equal(normal.locks[0].unlockAt, "1970-01-01T00:33:20.000Z");
  assert.equal(normal.balancesStatus, "VERIFIED_BOUNDED_SCOPE");
  assert.equal(normal.locksStatus, "VERIFIED_BOUNDED_SCOPE");
  const permanent = await getWalletAssets(fixture("permanent"), { contracts: { votingEscrow: VE } });
  assert.equal(permanent.locks[0].permanent, true);
  assert.equal(permanent.locks[0].unlockAt, null);

  const balanceFail = await getWalletAssets(fixture("balanceFail"), { contracts: { votingEscrow: VE } });
  assert.equal(balanceFail.balancesStatus, "PARTIAL_BOUNDED_SCOPE");
  assert.equal(balanceFail.liquidBalances[0].status, "READ_FAILED");
  const managed = await getWalletAssets(fixture("managed"), { contracts: { votingEscrow: VE } });
  assert.equal(managed.locks[0].status, "UNSUPPORTED_MANAGED");
  assert.equal(managed.locksStatus, "PARTIAL_BOUNDED_SCOPE");
  const notOwned = await getWalletAssets(fixture("notOwned"), { contracts: { votingEscrow: VE } });
  assert.equal(notOwned.locks[0].status, "NOT_OWNED");
  assert.equal(notOwned.locksStatus, "VERIFIED_BOUNDED_SCOPE");
  const ownerFail = await getWalletAssets(fixture("ownerFail"), { contracts: { votingEscrow: VE } });
  assert.equal(ownerFail.locks[0].status, "READ_FAILED");
  assert.equal(ownerFail.locksStatus, "PARTIAL_BOUNDED_SCOPE");
  const invalidType = await getWalletAssets(fixture("invalidType"), { contracts: { votingEscrow: VE } });
  assert.equal(invalidType.locks[0].status, "READ_FAILED");
  const unknown = await getWalletAssets(fixture("unknownUnits"), { contracts: { votingEscrow: VE } });
  assert.equal(unknown.liquidBalances.find(row => row.token?.toLowerCase() === ESCROW.toLowerCase())?.decimals, null);
  assert.equal(unknown.liquidBalances.find(row => row.token?.toLowerCase() === ESCROW.toLowerCase())?.status, "READ_FAILED");
  assert.equal(unknown.locks[0].decimals, null);
  assert.equal(unknown.locks[0].status, "READ_FAILED");
  const escrowFail = await getWalletAssets(fixture("escrowTokenFail"), { contracts: { votingEscrow: VE } });
  assert.equal(escrowFail.balancesStatus, "PARTIAL_BOUNDED_SCOPE");
  assert.equal(escrowFail.locksStatus, "PARTIAL_BOUNDED_SCOPE");
  assert.equal(escrowFail.liquidBalances.some(row => row.symbol === "ESCROW"), false);
  assert.equal(escrowFail.locks[0].status, "READ_FAILED");
  await assert.rejects(getWalletAssets(fixture("cancel"), { contracts: { votingEscrow: VE } }));
  const noPin = fixture(); delete (noPin as { pinnedObservation?: unknown }).pinnedObservation;
  await assert.rejects(getWalletAssets(noPin, { contracts: { votingEscrow: VE } }), /pinned observation/);
}

testWalletAssets().then(() => console.log("Wallet assets tests passed.")).catch(error => { console.error(error); process.exit(1); });
