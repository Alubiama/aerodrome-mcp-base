# Security and reporting

This is an experimental read-only blockchain integration, not a wallet or trading agent. It neither accepts signing secrets nor exposes transaction methods. Wallet data sent to an MCP client may be sensitive even though blockchain addresses are public.

This source release has local regression checks, not an independent security audit. Reviews of an earlier parent project must not be presented as an audit of this repository.

Treat token metadata and provider responses as untrusted. Preserve partial coverage and failure states. Never paste credentials or private wallet history into an issue. If a future public repository enables private vulnerability reporting, use that channel for sensitive reports; no reporting URL is advertised before publication.

If a local baseline is corrupted or locked, stop and inspect it. Do not delete evidence or bypass a lock while another process might be writing. Unexpected RPC/config errors return a bounded MCP error instead of private details.
