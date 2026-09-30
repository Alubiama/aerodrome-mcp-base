# External integration pilot — proposed, not completed

## One bounded job

Independently reproduce the existing [TRY_IT.md](docs/TRY_IT.md) job — explain a reward change — and then test whether its structured evidence improves one dashboard or agent workflow that a developer already maintains. No external developer has agreed to this pilot yet.

This pilot is the **first** external integration candidate. The original allocation inspection panel pilot is preserved below as a separate, later candidate.

## Acceptance

1. Before installation, record one recent instance when the developer had to explain a reward change, what they actually used, and why their existing approach was sufficient or insufficient. Do not infer demand from interest in the demo.
2. A developer other than the author installs from the public release using only the published [TRY_IT.md](docs/TRY_IT.md) steps, without private configuration or private setup help.
3. Reproduce the reward-change report on synthetic fixture data alone:
   - `BASELINE_CREATED` contains no changes (no earlier observation to compare).
   - `COMPARED` contains the reward row with `before: "100"`, `after: "125"`, `deltaRaw: "25"`, and a finding identifying blocks `100` and `101`.
4. Confirm the run needed no wallet, signature, RPC call, API key or model.
5. Keep the boundaries visible: these are raw fixture units, not dollars, APR or live AERO rewards; the cause of the change, whether a claim occurred, and realized income remain unknown/unestablished.
6. Map the report fields to one existing screen or agent response. If the developer chooses to integrate them into a test application, check that block references and unknowns survive rendering. Record what their current solution already handles better. An output review without integration is still useful feedback, but not an integration.
7. Record setup time, code changes and failed steps. Sanitize artifacts before sharing.
8. Stop after one test session. If the developer wants to keep a working integration, fix its largest obstacle next. If their current solution is sufficient, do not add speculative features. If installation or evidence fails, fix the observed failure before repeating that step.

Track three separate outcomes: an independent run, a useful test integration, and continued use. A correct run alone shows reproducibility, not integration or adoption. Likes, views, positive comments and author-operated demos prove none of these. Production adoption and willingness to pay remain unproven.

## Ask the evaluator

- What is your recent **actual alternative** for checking a reward change — the tool or manual step you really used last time?
- Where did **setup friction** appear (install, fixture, output format, explanation gap)?
- What does your **current solution already do** well enough that this would not replace?

Choose a relevant recipient and context before any invitation. No partnership, deadline or feature commitment is implied. Share synthetic fixtures, not private decision cards or wallet history.

## Later candidate — allocation inspection panel (not the first pilot)

Preserved from the original proposal for a later, separate session. Embed one allocation inspection panel in an existing test application: run `example:stdio`, render the Equal split plus its three stress results (raw SYN subtotals 20, 16, 14, 10), and exercise the partial fixture so the UI shows incomplete coverage and known-entry subtotals, never a complete reward claim. Evaluate with the same evidence standard above: an independently working useful integration, adoption unproven.
