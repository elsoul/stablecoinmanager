# StableCoinManager by ERPC

An MCP server that manages stablecoin payments for AI agents: it reads a service's x402 payment requirements, swaps whatever the agent's wallet holds into the required stablecoin on Uniswap, bridges when the funds sit on another network, pays, and keeps receipts and spending limits — all over the RPC line via erpc-sdk.

ETHGlobal Tokyo 2026 · Continuity Track. ERPC (erpc.global, AS200261), erpc-sdk and ERPC's x402 storefront are the existing project; the MCP server, routing/quote logic, Uniswap swap + bridge execution and the policy/audit layer are built in this repository during September 25–27, 2026.
