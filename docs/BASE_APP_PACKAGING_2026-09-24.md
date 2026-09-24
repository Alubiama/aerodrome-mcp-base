# Base App packaging evidence — 2026-09-24

Status: **web preview preparation only**. Collect is not registered or verified as a Base App. This file is a current-source checkpoint, not a publication claim.

## Current evidence

- The previously indexed Base [Create a Mini App](https://docs.base.org/base-app/miniapps/mini-apps) URL now redirects to the general Build on Base overview. The [current Base documentation index](https://docs.base.org/llms.txt) does not list the older Mini App registration guide. Therefore, its archived `/.well-known/farcaster.json`, account-association and post-to-publish instructions are not treated as current requirements for this existing web app.
- A [Base documentation issue](https://github.com/base/docs/issues/1247) records the ambiguity between the legacy manifest/import flow and a newer standard-web-app path. This issue is a user's report, not definitive platform policy. Current dashboard behavior must decide the route.
- `https://base.dev` currently redirects to `https://dashboard.base.org/`. Public access to its authenticated registration flow has not been verified.
- The current public [Base Dashboard registration entry](https://dashboard.base.org/register) loads without an account and asks for an app name before **Continue**. The form does not publicly expose later fields, domain verification, listing criteria, or Base App mobile behavior. Entering a name has not been submitted. Registration in this dashboard must not be equated with Base App discovery or approval without further evidence.
- The [Base Dashboard home](https://dashboard.base.org/) states that login is required to register an app. The current browser session is unauthenticated; clicking **Log In** did not expose a completed account session or later registration steps. No account, wallet signature, or app registration was created.
- Collect must work for Rabby-only users without requiring Coinbase Wallet. The dashboard's supported login methods have not been verified, so registration must not be described as requiring a Coinbase wallet. Collect's address-first web flow and named Rabby browser-provider path remain separate from dashboard registration.
- The [Base home page](https://www.base.org/) describes the newer Base Dashboard as a place to register apps. This supports using the live dashboard as the next source of truth, but does not establish the full flow or required metadata. The older [Mini App guide URL](https://docs.base.org/base-app/miniapps/mini-apps) currently redirects to a general overview, so its cached search snippet is not a current instruction.

## Safe preparation completed

- Both existing web pages carry a truthful short description, a Base-blue browser theme color and the app's existing SVG icon. The descriptions state that Collect cannot send transactions.
- At a 320 px viewport, the basket landing page remains usable in the local preview: hero, address field, View wallet and saved-address controls fit within the viewport. This is a browser check, not a Base App WebView check.
- The application remains address-first and read-only. It does not add MiniKit, a signed manifest, account association, notifications, a transaction SDK, or any sending capability simply to claim Base App compatibility.

## Next verification gates

1. Manually release the merged read-only build to its public HTTPS origin. Compare `/healthz` `releaseCommit` with the chosen Git SHA and confirm `sendingEnabled:false`, then verify the actual public HTML, API, and mobile behavior unauthenticated. The commit field uses Render's documented runtime `RENDER_GIT_COMMIT`; a missing or mismatched field is not proof of the intended release.
2. In the current authenticated Base dashboard, inspect the steps after the public app-name form: existing web-app URL, metadata, ownership proof, listing/discovery rules, and any wallet requirements. Record screen/UI evidence before registering; avoid copying legacy instructions from search results.
3. Prepare accurate share artwork and any dashboard-required metadata on a distinct preview origin. Test the URL in Base App on a physical mobile device, including address-only browsing and wallet connect behavior. Keep wallet signing disabled.
4. Complete security gates and product utility validation before publishing a transaction feature. Registration or discovery must never be described as an audit, endorsement, distribution promise or airdrop eligibility signal.
