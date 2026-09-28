# Collect token-selection safety review — 2026-09-28

Scope: address-first inventory, token selection and read-only preview on Base. This is a focused internal review, not a smart-contract audit or a verdict that any token is safe. Transaction sending remains disabled.

## Findings and changes

| Finding | Before | Change | Remaining limit |
| --- | --- | --- | --- |
| Unknown airdrops could be selected in one click | Only promotional links or claim text in metadata blocked selection | Every non-core contract starts unverified and requires opening its details and acknowledging the full contract address before read-only preview. This acknowledgement is not persisted across a new wallet search. | A user can acknowledge without genuinely checking; the app cannot prove token legitimacy. |
| Core-token symbol impersonation | A different contract could display `USDC` or `WETH` without being caught by the existing text heuristic | Exact-symbol impostors are blocked using the Base contract address, both for indexer metadata and the refreshed onchain symbol. | Other symbols and Unicode lookalikes may be missed; all non-core addresses still require review. |
| Stale or forged selection state | The UI selection handler was the only place enforcing a selectable row | Every preview, plan and comparison request rechecks the selected row and review state. Refreshed rows that lose eligibility are removed from the selection. | Direct API clients can still request read-only quotes and unsigned plans. This must become a server-side admission gate before transaction sending is ever enabled. |
| Metadata and quote mistaken for safety proof | Estimated value and route information can appear next to an unknown asset | The interface labels unknown contracts as unverified, explains that acknowledgement only unlocks read-only preview, and links to the exact contract page on Base Blockscout. | A quoted or simulated sale does not certify mutable token code, transfer restrictions, future tax changes or the safety of an external website. |

The two known contract addresses in this narrow UI rule are Base USDC (`0x833589fcD6eDb6e08f4c7c32d4f71b54bdA02913`) and Base WETH (`0x4200000000000000000000000000000000000006`). “Known contract” means an exact address match only, not an endorsement of every interaction.

## Verification boundary

Unit and UI-flow tests cover metadata flags, an onchain `USDC` impostor, default-locked unknown rows, explicit review, selection reset and read-only request validation. Browser verification on the user's previously supplied public Base address found 412 token candidates; the first 16 showed disabled selection for unknown contracts, and reviewing one contract unlocked only that row. No wallet connection, approval, signature or swap was requested.

Before enabling any future send path: add server-side token admission independent of the browser, independently review any supported token universe, simulate the exact transaction sequence from the user's account, bind route and spender to the reviewed plan, and test with a disposable wallet and tiny amounts. These checks reduce risk but cannot guarantee that malicious tokens will be detected.

Reference guidance: [Coinbase on fake tokens](https://help.coinbase.com/en/wallet/security/fake-stablecoins), [Coinbase on token approvals](https://help.coinbase.com/en-gb/wallet/security/dapp-permissions-token-approvals), [ethereum.org on scam-token tricks](https://ethereum.org/developers/tutorials/scam-token-tricks).
