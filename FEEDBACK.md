# Uniswap developer feedback — StableCoinManager (ETHGlobal Tokyo 2026, Continuity Track)

## What we built with Uniswap
StableCoinManager is an MCP server on Cloudflare Workers that pays x402 invoices for AI agents under code-enforced spending limits. Uniswap is the curated swap venue for an agent that holds the wrong asset.

What runs in production today: the `plan` and `swap` tools resolve a swap against a reviewed Uniswap v2 pool (USDC/WETH on Ethereum mainnet, `src/lib/routes.ts`), apply the server's policy (slippage ≤ 50 bps, deadline ≤ 600 s, which the agent can tighten but never widen) and refuse anything outside the route table with the reason spelled out.

What is implemented and unit-tested but deliberately not wired to broadcast: the full quote → simulate → prepare → allowance path against that pool through `@elsoul/erpc-sdk` (`src/chain/swap.ts`). Every step is a plain JSON-RPC call (`eth_call` for the quote and the simulation, prepared Router calldata, an explicit allowance requirement); there is no private DEX client and no aggregator API. Broadcasting is gated behind our funded production canary, and a test pins that the module has no production importer, so the commit that wires it in has to say so.

## What worked well
- The v2 Pair / Router surface is small and stable. Quoting with `getAmountsOut` and building `swapExactTokensForTokens` calldata came out to a few dozen lines once the addresses were known.
- Simulating the prepared call with `eth_call` before signing gives a "will this succeed" signal without any off-chain service, which fits a payment path that must stay RPC-only.

## What cost us time
1. **Allowance is a second signature.** A swap preparation that only returns router calldata is incomplete for an automated wallet: the ERC-20 approval has to be modelled, simulated and signed as its own step, and the spending ceiling has to account for it. A "prepare swap" helper that returns the ordered list of transactions (approve, swap) would remove a whole class of half-done flows.
2. **No canonical machine-readable deployment registry.** Factory, Router, Quoter and well-known pair addresses per `chainId` are scattered across docs pages. A signed JSON (or an npm package with typed exports) of deployments per chain would save every integrator an afternoon and remove copy-paste address risk in payment code.
3. **Exact-output for payments.** x402 invoices name an exact stablecoin amount, so a payment swap is naturally exact-output ("pay exactly N of token B from whatever token A"). That is straightforward on v3 (`QuoterV2.quoteExactOutputSingle` + `SwapRouter02.exactOutputSingle`) but v2 needs `getAmountsIn` and a maximum-input bound. A short, canonical recipe for "exact-output swap into a stablecoin with a slippage bound and a deadline", on v2, v3 and v4, would fit agent payments perfectly.

## What we would use next
- Wiring the tested v2 path to broadcast once the canary has run, then v3 exact-output on Base (our x402 rail settles EURC on Base) once our SDK publishes a reviewed Base pool.
- v4 hooks as a place to enforce per-agent spending limits on-chain instead of only in the server.
