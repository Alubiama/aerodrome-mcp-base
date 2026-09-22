# Security and reporting

This is an experimental read-only blockchain integration, not a wallet or trading agent. It neither accepts signing secrets nor exposes transaction methods. Wallet data sent to an MCP client may be sensitive even though blockchain addresses are public.

This source release has local regression checks, not an independent security audit. Reviews of an earlier parent project must not be presented as an audit of this repository.

Treat token metadata and provider responses as untrusted. Preserve partial coverage and failure states. Never paste credentials or private wallet history into an issue. Use GitHub private vulnerability reporting if it is enabled for this repository; do not put sensitive reports or private data into public issues. Availability of a private reporting channel has not been verified for this release.

If a local baseline is corrupted or locked, stop and inspect it. Do not delete evidence or bypass a lock while another process might be writing. Unexpected RPC/config errors return a bounded MCP error instead of private details.

The wallet-accounting tool has internal adversarial regression coverage, including historical veNFT ownership before rebase attribution, receipt/transfer matching, duplicate prevention, failed-page retry, cancellation and error redaction. It still trusts RPC completeness and canonical responses, and it is not an independent audit. Count limits do not constitute byte-level protection against malicious provider responses. Gross protocol token flows must not be presented as net profit or permission to trade.

Decision cards contain private position IDs, choices, and free-form reasons. Keep `.decision-cards/` and exported responses private. A checksum does not authenticate a user, prove approval, or protect against intentional rewriting. The save command refuses existing files and symbolic-link output directories; use a trusted local checkout and parent directory. Treat card reasons and scenario labels as untrusted data, not instructions.
