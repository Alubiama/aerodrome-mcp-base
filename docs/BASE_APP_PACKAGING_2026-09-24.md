# Base App packaging evidence — 2026-09-24

Status: **web preview preparation only**. Collect is not registered or verified as a Base App. This file is a current-source checkpoint, not a publication claim.

## Current evidence

- The previously indexed Base [Create a Mini App](https://docs.base.org/base-app/miniapps/mini-apps) URL now redirects to the general Build on Base overview. The [current Base documentation index](https://docs.base.org/llms.txt) does not list the older Mini App registration guide. Therefore, its archived `/.well-known/farcaster.json`, account-association and post-to-publish instructions are not treated as current requirements for this existing web app.
- A [Base documentation issue](https://github.com/base/docs/issues/1247) records the ambiguity between the legacy manifest/import flow and a newer standard-web-app path. This issue is a user's report, not definitive platform policy. Current dashboard behavior must decide the route.
- `https://base.dev` currently redirects to `https://dashboard.base.org/`. Public access to its authenticated registration flow has not been verified.

## Safe preparation completed

- Both existing web pages carry a truthful short description, a Base-blue browser theme color and the app's existing SVG icon. The descriptions state that Collect cannot send transactions.
- At a 320 px viewport, the basket landing page remains usable in the local preview: hero, address field, View wallet and saved-address controls fit within the viewport. This is a browser check, not a Base App WebView check.
- The application remains address-first and read-only. It does not add MiniKit, a signed manifest, account association, notifications, a transaction SDK, or any sending capability simply to claim Base App compatibility.

## Next verification gates

1. Release the merged read-only build to its public HTTPS origin; confirm the actual public HTML, API, mobile behavior and no-send boundary unauthenticated.
2. In the current authenticated Base dashboard, inspect how an existing standard web app is registered and which metadata and ownership proofs it actually requests. Record screen/UI evidence and select the current path; avoid copying legacy instructions from search results.
3. Prepare accurate share artwork and any dashboard-required metadata on a distinct preview origin. Test the URL in Base App on a physical mobile device, including address-only browsing and wallet connect behavior. Keep wallet signing disabled.
4. Complete security gates and product utility validation before publishing a transaction feature. Registration or discovery must never be described as an audit, endorsement, distribution promise or airdrop eligibility signal.
