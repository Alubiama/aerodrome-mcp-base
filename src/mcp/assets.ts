import { getAddress, type Address } from "viem";
import { erc20Abi, veAbi } from "../abi.js";
import { normalizeAddress, walletAddress } from "../config.js";
import { getTokenMeta } from "../tokens.js";
import { unixSecondsToIso, type ToolRuntime } from "./data.js";
import { walletAssetsSchema } from "./assets-schema.js";

type ProtocolIdentity = { contracts: { votingEscrow: string } };
const MAX_UINT256 = 1n << 256n;
function source(contract: string, block: string) { return `https://basescan.org/address/${contract}?block=${block}`; }
function uint(value: unknown, label: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value >= MAX_UINT256) throw new Error(`Invalid uint256 for ${label}.`);
  return value;
}
function configuredIds(runtime: ToolRuntime): bigint[] {
  const ids = (runtime.cfg.veNftTokenIds ?? []).map(value => BigInt(value));
  if (ids.length > 16) throw new Error("Configured veNFT IDs exceed 16.");
  if (new Set(ids.map(String)).size !== ids.length || ids.some(id => id <= 0n || id >= MAX_UINT256)) throw new Error("Configured veNFT IDs are invalid or duplicated.");
  return ids;
}
function displayMeta(meta: Awaited<ReturnType<typeof getTokenMeta>>) {
  return meta.decimalsSource === "ASSUMED"
    ? { decimals: null, decimalsSource: "UNKNOWN" as const }
    : { decimals: meta.decimals, decimalsSource: meta.decimalsSource as "ONCHAIN" | "CANONICAL" };
}

/** Caller supplies an already chain-validated, block-pinned protocol observation. */
export async function getWalletAssets(runtime: ToolRuntime, protocol: ProtocolIdentity) {
  runtime.signal?.throwIfAborted();
  const pinned = runtime.pinnedObservation;
  if (!pinned?.value.blockHash || !/^0x[0-9a-fA-F]{64}$/.test(pinned.value.blockHash)) throw new Error("Wallet assets require a pinned observation with a block hash.");
  const wallet = walletAddress(runtime.cfg);
  const ids = configuredIds(runtime);
  const ve = normalizeAddress(protocol.contracts.votingEscrow, "protocol.contracts.votingEscrow");
  const block = pinned.rawBlockNumber;
  const blockText = pinned.value.blockNumber;
  const warnings: string[] = [];
  let balancesPartial = false, locksPartial = false;
  const balanceFail = (message: string) => { balancesPartial = true; warnings.push(message); };
  const lockFail = (message: string) => { locksPartial = true; warnings.push(message); };
  const liquidBalances: any[] = [];

  try {
    const amount = uint(await runtime.client.getBalance({ address: wallet, blockNumber: block }), "ETH balance");
    liquidBalances.push({ token: null, symbol: "ETH", status: "VERIFIED_POINT_IN_TIME", amountRaw: amount.toString(), decimals: 18, decimalsSource: "CANONICAL", source: source(wallet, blockText) });
  } catch { runtime.signal?.throwIfAborted(); balanceFail("ETH balance could not be verified."); liquidBalances.push({ token: null, symbol: "ETH", status: "READ_FAILED", amountRaw: null, decimals: 18, decimalsSource: "CANONICAL", source: source(wallet, blockText) }); }

  let escrowToken: Address | null = null;
  try {
    escrowToken = getAddress(await runtime.client.readContract({ address: ve, abi: veAbi, functionName: "token", blockNumber: block }) as Address);
    if (/^0x0{40}$/i.test(escrowToken)) throw new Error("zero escrow token");
  } catch { runtime.signal?.throwIfAborted(); escrowToken = null; balanceFail("Voting-escrow token could not be verified; its balance is unknown, not omitted."); lockFail("Voting-escrow token could not be verified; lock units are unknown."); }

  const tokenRows: Address[] = [];
  if (escrowToken) tokenRows.push(escrowToken);
  const usdc = runtime.cfg.tokens.USDC ? normalizeAddress(runtime.cfg.tokens.USDC, "cfg.tokens.USDC") : null;
  if (usdc && !tokenRows.some(token => token.toLowerCase() === usdc.toLowerCase())) tokenRows.push(usdc);
  for (const token of tokenRows) {
    runtime.signal?.throwIfAborted();
    try {
      const amount = uint(await runtime.client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [wallet], blockNumber: block }), `balanceOf(${token})`);
      const meta = await getTokenMeta(runtime.client, token, undefined, block);
      const display = displayMeta(meta);
      const unitsKnown = display.decimals !== null;
      if (!unitsKnown) balanceFail(`Decimals for ${token} are assumed; only the raw balance is reliable.`);
      liquidBalances.push({ token, symbol: meta.symbol, status: unitsKnown ? "VERIFIED_POINT_IN_TIME" : "READ_FAILED", amountRaw: amount.toString(), ...display, source: source(token, blockText) });
    } catch { runtime.signal?.throwIfAborted(); balanceFail(`Token balance for ${token} could not be verified.`); liquidBalances.push({ token, symbol: token, status: "READ_FAILED", amountRaw: null, decimals: null, decimalsSource: "UNKNOWN", source: source(token, blockText) }); }
  }

  const locks: any[] = [];
  for (const tokenId of ids) {
    runtime.signal?.throwIfAborted();
    const base = { tokenId: tokenId.toString(), token: escrowToken, source: source(ve, blockText) };
    try {
      const owner = getAddress(await runtime.client.readContract({ address: ve, abi: veAbi, functionName: "ownerOf", args: [tokenId], blockNumber: block }) as Address);
      if (owner.toLowerCase() !== wallet.toLowerCase()) { locks.push({ ...base, owner, status: "NOT_OWNED", principalRaw: null, decimals: null, decimalsSource: "UNKNOWN", permanent: null, unlockAt: null }); continue; }
      const escrowType = await runtime.client.readContract({ address: ve, abi: veAbi, functionName: "escrowType", args: [tokenId], blockNumber: block });
      if (escrowType === 1 || escrowType === 1n || escrowType === 2 || escrowType === 2n) { locksPartial = true; locks.push({ ...base, owner, status: "UNSUPPORTED_MANAGED", principalRaw: null, decimals: null, decimalsSource: "UNKNOWN", permanent: null, unlockAt: null }); continue; }
      if (escrowType !== 0 && escrowType !== 0n) throw new Error("Unknown escrow type");
      if (!escrowToken) { locks.push({ ...base, owner, status: "READ_FAILED", principalRaw: null, decimals: null, decimalsSource: "UNKNOWN", permanent: null, unlockAt: null }); continue; }
      const locked = await runtime.client.readContract({ address: ve, abi: veAbi, functionName: "locked", args: [tokenId], blockNumber: block }) as { amount: bigint; end: bigint; isPermanent: boolean };
      if (typeof locked.isPermanent !== "boolean") throw new Error("Invalid lock permanence");
      const amount = uint(locked.amount, `locked(${tokenId}).amount`);
      const end = locked.isPermanent ? null : uint(locked.end, `locked(${tokenId}).end`);
      let decimals: number | null = null, decimalsSource: "ONCHAIN" | "CANONICAL" | "UNKNOWN" = "UNKNOWN";
      if (escrowToken) try { const display = displayMeta(await getTokenMeta(runtime.client, escrowToken, undefined, block)); decimals = display.decimals; decimalsSource = display.decimalsSource; if (decimals === null) lockFail(`Decimals for voting-escrow token ${escrowToken} are assumed; lock units are unknown.`); } catch { lockFail("Voting-escrow token metadata could not be verified; lock units are unknown."); }
      locks.push({ ...base, owner, status: decimals === null ? "READ_FAILED" : "VERIFIED_POINT_IN_TIME", principalRaw: amount.toString(), decimals, decimalsSource, permanent: locked.isPermanent, unlockAt: end === null ? null : unixSecondsToIso(end, `locked(${tokenId}).end`) });
    } catch { runtime.signal?.throwIfAborted(); lockFail(`Configured veNFT #${tokenId} could not be verified.`); locks.push({ ...base, owner: null, status: "READ_FAILED", principalRaw: null, decimals: null, decimalsSource: "UNKNOWN", permanent: null, unlockAt: null }); }
  }
  runtime.signal?.throwIfAborted();
  return walletAssetsSchema.parse({ wallet, observation: pinned.value, balancesStatus: balancesPartial ? "PARTIAL_BOUNDED_SCOPE" : "VERIFIED_BOUNDED_SCOPE", locksStatus: locksPartial ? "PARTIAL_BOUNDED_SCOPE" : "VERIFIED_BOUNDED_SCOPE", liquidBalances, locks, warnings });
}
