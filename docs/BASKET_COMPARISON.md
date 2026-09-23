# Read-only basket comparison

For 2–5 selected ERC-20 inputs to USDC, Collect checks the full selection and
each candidate formed by leaving out one token. Each candidate receives its
own complete Aerodrome classic-pool plan, Base `eth_simulateV1` sequence, and
whole-candidate network-fee estimate. Quotes and simulations are bound to the
same Base block hash, and a mismatched simulation parent hash fails closed.

Results are ranked by estimated USDC after network costs **only among the
sampled candidates** when fee conversion and gas-price inputs match and the
verified candidates have not expired. Failed and unknown candidates remain
visible. A partial or incomparable response cannot establish the best basket.
Other subsets, stable pools, Slipstream and aggregators are not covered.

In a read-only same-block probe at Base block 51707310, a test basket of 1 JESS
and 0.00001 WETH estimated 0.020125 USDC after network costs, while WETH alone
estimated 0.023260 USDC. This demonstrates why a positive token quote does not
prove that including the token improves the basket. The figures are historical
estimates, not guaranteed payouts or wallet execution evidence.

The comparison response contains no executable calls. Sending remains disabled.
The simulator uses `validation=false`, so nonce, ETH gas affordability, wallet
execution, transaction inclusion, malicious-token behavior and the exact
deployed router security boundary remain unverified. The fee estimate can
change before execution.

RPC method reference: https://ethereum.github.io/execution-apis/api/methods/eth_simulateV1/
