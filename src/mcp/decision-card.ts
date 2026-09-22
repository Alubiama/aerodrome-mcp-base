import { createHash } from "node:crypto";
import * as z from "zod/v4";
import { allocationsInputSchema, allocationsSchema, getAllocationComparison, compareAllocationEvidence } from "./allocations.js";
import { createDefaultRuntime, type ToolRuntime } from "./data.js";

export const decisionCardInputSchema = z.strictObject({
  allocation: allocationsInputSchema,
  selectedScenario: z.string().max(60).optional(),
  reason: z.string().trim().max(1000).default("")
}).refine(v => v.selectedScenario === undefined || v.allocation.scenarios.some(s => s.name === v.selectedScenario), "Selected scenario must exist")
.refine(v => v.selectedScenario === undefined || v.reason.length > 0, "Explicit selection requires a reason");
const cardPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1), readOnly: z.literal(true),
  decisionStatus: z.enum(["DRAFT", "USER_SELECTED"]),
  input: decisionCardInputSchema,
  comparison: allocationsSchema,
  limitations: z.array(z.string())
});
export const decisionCardSchema = cardPayloadSchema.extend({cardId:z.string().regex(/^[a-f0-9]{64}$/)});
function digest(payload: z.infer<typeof cardPayloadSchema>) {
  return createHash("sha256").update(JSON.stringify(cardPayloadSchema.parse(payload))).digest("hex");
}
export function buildDecisionCard(input: z.input<typeof decisionCardInputSchema>, comparison: z.infer<typeof allocationsSchema>) {
  const parsed = decisionCardInputSchema.parse(input);
  // Recompute from evidence to prevent mismatched input or stale scenario calculations.
  const computed = compareAllocationEvidence(parsed.allocation,comparison.evidence);
  const payload = cardPayloadSchema.parse({schemaVersion:1,readOnly:true,
    decisionStatus:parsed.selectedScenario === undefined ? "DRAFT" : "USER_SELECTED",
    input:parsed,comparison:computed,
    limitations:["USER_SELECTED records an explicit caller assertion, not independent proof of human approval or an executed vote.",
      "Current deposits and competing votes may change. This is not a forecast, actual claimable reward, profit or transaction simulation.",
      "Contains private decision context and position identifiers. Save locally; do not publish this card.",
      "cardId is a content checksum, not a signature or independent proof of on-chain facts."]});
  return decisionCardSchema.parse({...payload,cardId:digest(payload)});
}
export function validateDecisionCard(raw: unknown) {
  const card=decisionCardSchema.parse(raw);
  const {cardId,...payload}=card;
  if(digest(payload)!==cardId) throw new Error("Decision card checksum mismatch");
  const expected=buildDecisionCard(card.input,card.comparison);
  if(expected.cardId!==cardId) throw new Error("Decision card calculations mismatch");
  return card;
}
export async function getDecisionCard(input: z.input<typeof decisionCardInputSchema>,runtime: ToolRuntime=createDefaultRuntime()) {
  const parsed=decisionCardInputSchema.parse(input);
  return buildDecisionCard(parsed,await getAllocationComparison(parsed.allocation,runtime));
}
