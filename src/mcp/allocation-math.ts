/**
 * allocation-math.ts — standalone pure TypeScript, zero dependencies.
 *
 * Public, generic, synthetic arithmetic helpers for basis-point (bps)
 * allocation accounting. These are hypothetical read-only helpers;
 * they are NOT a network, optimizer, or financial advice.
 *
 * All value math uses bigint to avoid float drift. Weights are integers.
 */

const BPS_DENOMINATOR = 10000n;

/** Thrown for invalid inputs. Kept local & dependency-free. */
export class AllocationMathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AllocationMathError";
  }
}

function assertNonNegativeBigints(powers: bigint[], label: string): void {
  for (let i = 0; i < powers.length; i++) {
    const p = powers[i];
    if (typeof p !== "bigint") {
      throw new AllocationMathError(`${label}[${i}] must be a bigint`);
    }
    if (p < 0n) {
      throw new AllocationMathError(`${label}[${i}] must be nonnegative`);
    }
  }
}

function validateWeights(weightsBps: number[]): void {
  if (!Array.isArray(weightsBps) || weightsBps.length === 0) {
    throw new AllocationMathError("weightsBps must be a nonempty array");
  }
  let sum = 0;
  for (let i = 0; i < weightsBps.length; i++) {
    const w = weightsBps[i];
    if (typeof w !== "number" || !Number.isInteger(w)) {
      throw new AllocationMathError(`weightsBps[${i}] must be an integer`);
    }
    if (w < 0 || w > 10000) {
      throw new AllocationMathError(`weightsBps[${i}] must be in 0..10000`);
    }
    sum += w;
  }
  if (sum !== 10000) {
    throw new AllocationMathError(
      `weightsBps must sum to exactly 10000 (got ${sum})`,
    );
  }
}

/**
 * Split each NFT's voting power across pools by weight, per NFT, floored.
 *
 * For every NFT i and pool p:
 *     contribution[i][p] = floor(powers[i] * weightsBps[p] / 10000)
 * The per-pool output is the SUM of these per-NFT contributions:
 *     out[p] = sum_i contribution[i][p]
 *
 * Dust (the truncated remainder of each NFT*pool product) is NEVER
 * redistributed; it is simply discarded. Consequently sum(out) <= sum(powers).
 *
 * @returns bigint[] of length weightsBps.length, one total per pool.
 */
export function splitVotingPower(
  powers: bigint[],
  weightsBps: number[],
): bigint[] {
  if (!Array.isArray(powers)) {
    throw new AllocationMathError("powers must be an array");
  }
  assertNonNegativeBigints(powers, "powers");
  validateWeights(weightsBps);

  const poolCount = weightsBps.length;
  const totals: bigint[] = new Array(poolCount).fill(0n);

  for (let i = 0; i < powers.length; i++) {
    const power = powers[i];
    for (let p = 0; p < poolCount; p++) {
      // floor(power * bps / 10000) — bigint division truncates toward zero,
      // and all operands are nonnegative, so this is exact floor.
      const share = (power * BigInt(weightsBps[p])) / BPS_DENOMINATOR;
      totals[p] += share; // accumulate per pool across NFTs
    }
  }
  return totals;
}

/**
 * Estimate a single deposit's share of a pool.
 *
 * Given current pool `supply`, the depositor's own `existing` balance,
 * and the `allocated` amount being added to the pool, returns:
 *
 *     allocated === 0                       -> 0n
 *     deposit * allocated
 *       ----------------------------
 *       (supply - existing) + allocated
 *
 * i.e. deposit's claim divided by the pool capacity that existed before
 * this deposit plus the newly allocated amount. Integer floor division.
 *
 * Validates: all args nonnegative; existing <= supply.
 *
 * @returns bigint share (>= 0), floored.
 */
export function estimateShare(
  deposit: bigint,
  supply: bigint,
  existing: bigint,
  allocated: bigint,
): bigint {
  for (const [v, name] of [
    [deposit, "deposit"],
    [supply, "supply"],
    [existing, "existing"],
    [allocated, "allocated"],
  ] as const) {
    if (typeof v !== "bigint") {
      throw new AllocationMathError(`${name} must be a bigint`);
    }
    if (v < 0n) {
      throw new AllocationMathError(`${name} must be nonnegative`);
    }
  }
  if (existing > supply) {
    throw new AllocationMathError("existing must be <= supply");
  }

  if (allocated === 0n) {
    return 0n;
  }

  const denominator = supply - existing + allocated;
  if (denominator === 0n) {
    // Unreachable given allocated > 0, but guarded for safety.
    return 0n;
  }
  return (deposit * allocated) / denominator;
}
