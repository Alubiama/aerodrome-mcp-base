# Collect Mini App staging

Collect's Mini App launch URL is `https://collect-base.onrender.com/miniapp`. It opens the same read-only basket as `/basket`; transaction sending remains disabled. The ordinary `/basket` page keeps `frame-ancestors 'none'`. Only `/miniapp` permits embedding by the listed Farcaster and Base hosts.

The manifest is served at `/.well-known/farcaster.json` with `noindex: true` during testing. Until domain ownership is signed, it intentionally has no `accountAssociation` and will fail the ownership portion of Mini App validation. This is a staged preview, not a published or verified listing.

Owner step after the deploy: use the [Farcaster manifest tool](https://farcaster.xyz/~/developers/mini-apps/manifest) to sign the exact domain `collect-base.onrender.com`. Add the resulting `header`, `payload`, and `signature` as `FARCASTER_HEADER`, `FARCASTER_PAYLOAD`, and `FARCASTER_SIGNATURE` on the Render service. Never enter a seed phrase or private key into this repo or Render. The server checks that the signed payload names the configured domain, but Farcaster's preview must independently verify the signature.

Then check the [Mini App preview](https://farcaster.xyz/~/developers/mini-apps/preview) for manifest validation, share card, splash dismissal and mobile launch. Test address entry and a read-only quote in the client. Confirm whether the Base App accepts this Farcaster-compatible Mini App before changing `noindex` or announcing it. Browser-wallet extensions such as Rabby may not be available inside a mobile Mini App; address paste remains supported.

References: [publishing](https://miniapps.farcaster.xyz/docs/guides/publishing), [sharing](https://miniapps.farcaster.xyz/docs/guides/sharing), [loading](https://miniapps.farcaster.xyz/docs/guides/loading).
