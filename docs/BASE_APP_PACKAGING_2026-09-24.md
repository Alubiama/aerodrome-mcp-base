# Base App packaging evidence — 2026-09-24

Status: **read-only web preview released; Base App registration unverified**. Collect is not registered or verified as a Base App. This file is a current-source checkpoint, not a publication claim.

## Current evidence

- The previously indexed Base [Create a Mini App](https://docs.base.org/base-app/miniapps/mini-apps) URL now redirects to the general Build on Base overview. The [current Base documentation index](https://docs.base.org/llms.txt) does not list the older Mini App registration guide. Therefore, its archived `/.well-known/farcaster.json`, account-association and post-to-publish instructions are not treated as current requirements for this existing web app.
- A [Base documentation issue](https://github.com/base/docs/issues/1247) records the ambiguity between the legacy manifest/import flow and a newer standard-web-app path. This issue is a user's report, not definitive platform policy. Current dashboard behavior must decide the route.
- `https://base.dev` currently redirects to `https://dashboard.base.org/`. Public access to its authenticated registration flow has not been verified.
- The current public [Base Dashboard registration entry](https://dashboard.base.org/register) loads without an account and asks for an app name before **Continue**. The form does not publicly expose later fields, domain verification, listing criteria, or Base App mobile behavior. Entering a name has not been submitted. Registration in this dashboard must not be equated with Base App discovery or approval without further evidence.
- The [Base Dashboard home](https://dashboard.base.org/) states that login is required to register an app. The current browser session is unauthenticated; clicking **Log In** did not expose a completed account session or later registration steps. No account, wallet signature, or app registration was created.
- Collect must work for Rabby-only users without requiring Coinbase Wallet. The dashboard's supported login methods have not been verified, so registration must not be described as requiring a Coinbase wallet. Collect's address-first web flow and named Rabby browser-provider path remain separate from dashboard registration.
- The [Base home page](https://www.base.org/) describes the newer Base Dashboard as a place to register apps. This supports using the live dashboard as the next source of truth, but does not establish the full flow or required metadata. The older [Mini App guide URL](https://docs.base.org/base-app/miniapps/mini-apps) currently redirects to a general overview, so its cached search snippet is not a current instruction.
- The read-only Collect web preview was manually deployed to `https://collect-base.onrender.com/basket` from `collect-render-preview` commit `561a85d87356fbdd79689d41067feee02a3882d8`. The public `/healthz` returned that exact `releaseCommit` with `sendingEnabled:false`; Render showed the deploy Live and Auto-Deploy Off. An unauthenticated browser displayed the address-first page, and a 390 px viewport showed no page-level horizontal overflow. This establishes the web release identity and limited browser behavior, not Base App registration or wallet safety.

## Safe preparation completed

- Both existing web pages carry a truthful short description, a Base-blue browser theme color and the app's existing SVG icon. The descriptions state that Collect cannot send transactions.
- At a 320 px viewport, the basket landing page remains usable in the local preview: hero, address field, View wallet and saved-address controls fit within the viewport. This is a browser check, not a Base App WebView check.
- The application remains address-first and read-only. It does not add MiniKit, a signed manifest, account association, notifications, a transaction SDK, or any sending capability simply to claim Base App compatibility.

## Next verification gates

1. In an authenticated Base dashboard, inspect the steps after the public app-name form: existing web-app URL, metadata, ownership proof, listing/discovery rules, and any wallet requirements. The current in-app browser session reached only the unauthenticated login screen; a click stayed on “Connecting…”. Record screen/UI evidence before registering; avoid copying legacy instructions from search results.
2. Prepare accurate share artwork and any dashboard-required metadata on a distinct preview origin. Test the released URL in Base App on a physical mobile device, including address-only browsing and Rabby wallet behavior. Keep wallet signing disabled.
3. Validate after-fee utility for a representative basket with an explicitly authorized public wallet address. A public non-user test address loaded inventory and one-token indicative quotes, but a two-token route probe returned `BASKET_UNAVAILABLE`; neither result proves real-wallet execution.
4. Complete independent security review and product utility validation before publishing a transaction feature. Registration or discovery must never be described as an audit, endorsement, distribution promise or airdrop eligibility signal.
