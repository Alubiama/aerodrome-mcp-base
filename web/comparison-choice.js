const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

function usdcRaw(value) {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d{1,6})?$/.test(value)) return null;
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const raw = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0') || '0');
  return negative ? -raw : raw;
}

// This is a read-only convenience for a complete, unexpired sampled comparison.
// It never treats one-token omissions as a search of every possible subset.
export function sampledSelectionChoice(data, originalTokens, now = Date.now()) {
  if (data?.status !== 'COMPLETE_SAMPLED' || !Array.isArray(originalTokens) || originalTokens.length < 2 || originalTokens.length > 5 || !Array.isArray(data.candidates) || data.candidates.length !== originalTokens.length + 1) return null;
  if (new Set(originalTokens.map(x => typeof x === 'string' ? x.toLowerCase() : '')).size !== originalTokens.length) return null;
  const expected = [originalTokens, ...originalTokens.map((_, i) => originalTokens.filter((__, j) => i !== j))];
  let baseline = null;
  const rows = [];
  for (let i = 0; i < expected.length; i++) {
    const row = data.candidates[i];
    if (row?.status !== 'ESTIMATED' || !Array.isArray(row.tokens) || row.tokens.length !== expected[i].length || !row.tokens.every((token, j) => same(token, expected[i][j]))) return null;
    const net = usdcRaw(row.netUsdc);
    const expires = Date.parse(row.expiresAt);
    const ethPrice = usdcRaw(row.priceUsdcPerEth);
    if (net === null || !Number.isFinite(expires) || expires <= now || !/^\d+$/.test(row.gasPriceWei) || BigInt(row.gasPriceWei) <= 0n || ethPrice === null || ethPrice <= 0n) return null;
    const feeInputs = `${row.gasPriceWei}:${row.priceUsdcPerEth}`;
    if (baseline !== null && feeInputs !== baseline) return null;
    baseline = feeInputs;
    rows.push({ tokens: row.tokens, net });
  }
  const full = rows[0];
  const best = rows.slice(1).reduce((top, row) => row.net > top.net ? row : top, rows[1]);
  return best.net > 0n && best.net > full.net ? { tokens: best.tokens, improvementUsdc: usdcRawToString(best.net - full.net) } : null;
}

function usdcRawToString(value) {
  const whole = value / 1_000_000n;
  const fractional = (value % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${whole}${fractional ? `.${fractional}` : ''}`;
}
