# Uniswap developer feedback — StableCoinManager (ETHGlobal Tokyo 2026, Continuity Track)

## What we built with Uniswap
StableCoinManager is an MCP server on Cloudflare Workers that pays x402 invoices for AI agents under code-enforced spending limits. When the agent's wallet holds the wrong asset, Uniswap is the swap venue: the `plan` and `swap` tools quote, simulate and prepare exact-input swaps against the Uniswap v2 USDC/WETH pool on Ethereum mainnet. Every step is a plain JSON-RPC call (`eth_call` quotes, prepared Router calldata, an explicit allowance requirement) made through `@elsoul/erpc-sdk`; there is no private DEX client and no aggregator API in the path. Slippage is capped at 50 bps and the deadline at 600 s by the server's policy, which the agent can tighten but never widen.

Where it lives: `src/chain/swap.ts` (quote → simulate → prepare → allowance → sign → broadcast), `src/lib/routes.ts` (which routes are possible today), `src/route/mcp/tools/plan.ts` and `src/route/mcp/tools/swapBridge.ts` (the MCP tools). The prepared route is returned to the agent; broadcasting is gated behind our funded production canary and is pinned by a test that counts the module's importers.

## What worked well
- The v2 Pair / Router surface is small and stable. Quoting with `getAmountsOut` and building `swapExactTokensForTokens` calldata is a few dozen lines once the addresses are known.
- Simulating with `eth_call` before preparing the transaction gave us a reliable "will this succeed" signal without any off-chain service.

## What cost us time
1. **Allowance is a second signature.** A swap preparation that only returns router calldata is incomplete for an automated wallet: the ERC-20 approval has to be modelled, simulated and signed as its own step, and the daily spending ceiling has to account for it. A "prepare swap" helper that returns the ordered list of transactions (approve, swap) would remove a whole class of half-done flows.
2. **No canonical machine-readable deployment registry.** Factory, Router, Quoter and well-known pair addresses per `chainId` are scattered across docs pages. A signed JSON (or an npm package with typed exports) of deployments per chain would save every integrator an afternoon and remove copy-paste address risk in payment code.
3. **Exact-output for payments.** x402 invoices name an exact stablecoin amount, so a payment swap is naturally exact-output ("pay exactly N of token B from whatever token A"). That is straightforward on v3 (`QuoterV2.quoteExactOutputSingle` + `SwapRouter02.exactOutputSingle`) but v2 needs `getAmountsIn` and a maximum-input bound. A short, canonical recipe for "exact-output swap into a stablecoin with a slippage bound and a deadline" — on v2, v3 and v4 — would fit agent payments perfectly.

## What we would use next
- v3 exact-output on Base (our x402 rail settles EURC on Base), once our SDK publishes a reviewed Base pool.
- v4 hooks as a place to enforce per-agent spending limits on-chain instead of only in the server.
