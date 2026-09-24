import assert from 'node:assert/strict';
import { sampledSelectionChoice } from './comparison-choice.js';

const tokens = ['0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002', '0x0000000000000000000000000000000000000003'];
const now = Date.now();
const row = (selected, netUsdc) => ({ tokens: selected, status: 'ESTIMATED', netUsdc, gasPriceWei: '1000000', priceUsdcPerEth: '2500', expiresAt: new Date(now + 30_000).toISOString() });
const complete = { status: 'COMPLETE_SAMPLED', candidates: [row(tokens, '0.020000'), row([tokens[1], tokens[2]], '0.030000'), row([tokens[0], tokens[2]], '0.010000'), row([tokens[0], tokens[1]], '-0.001000')] };

assert.deepEqual(sampledSelectionChoice(complete, tokens, now), { tokens: [tokens[1], tokens[2]], improvementUsdc: '0.01' });
assert.equal(sampledSelectionChoice({ ...complete, status: 'PARTIAL_SAMPLED' }, tokens, now), null);
assert.equal(sampledSelectionChoice(complete, tokens, now + 30_001), null);
assert.equal(sampledSelectionChoice({ ...complete, candidates: [complete.candidates[0], { ...complete.candidates[1], gasPriceWei: '2000000' }, ...complete.candidates.slice(2)] }, tokens, now), null);
assert.equal(sampledSelectionChoice({ ...complete, candidates: [complete.candidates[0], { ...complete.candidates[1], priceUsdcPerEth: '0' }, ...complete.candidates.slice(2)] }, tokens, now), null);
assert.equal(sampledSelectionChoice({ ...complete, candidates: [complete.candidates[0], { ...complete.candidates[1], tokens: [tokens[2], tokens[1]] }, ...complete.candidates.slice(2)] }, tokens, now), null);
assert.equal(sampledSelectionChoice({ ...complete, candidates: [complete.candidates[0], { ...complete.candidates[1], status: 'UNKNOWN' }, ...complete.candidates.slice(2)] }, tokens, now), null);
assert.equal(sampledSelectionChoice({ ...complete, candidates: [row(tokens, '0.040000'), ...complete.candidates.slice(1)] }, tokens, now), null);
assert.equal(sampledSelectionChoice({ ...complete, candidates: [row(tokens, '0.020000'), row([tokens[1], tokens[2]], '-0.001000'), row([tokens[0], tokens[2]], '-0.002000'), row([tokens[0], tokens[1]], '-0.003000')] }, tokens, now), null);
console.log('PASS sampled selection only for complete, comparable, unexpired positive improvement.');
