import { sdk } from '@farcaster/miniapp-sdk';

// The launch path is the only page that loads this bridge. Keep the ordinary
// read-only website independent of the host SDK and of any wallet provider.
window.addEventListener('load', () => {
  void sdk.actions.ready().catch(() => {
    // An ordinary browser has no Mini App host; the page remains usable there.
  });
}, { once: true });
