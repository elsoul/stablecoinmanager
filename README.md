# StableCoinManager MCP

A wallet-holding agent that lives in a Cloudflare Worker.

Log in with Google from any MCP client — Claude, Codex, anything that speaks
MCP — and the worker reads x402 payment requirements, lines up the stablecoins
it needs through `@elsoul/erpc-sdk`, pays, and keeps the receipts. The private
keys stay in the worker — the one way out is `wallet_export_seed`, which is
confirmation-gated, rate limited and audited, and exists so that losing the
Durable Object does not mean losing the funds. The rate limit is claimed inside
the Durable Object, so concurrent calls cannot both pass it.

This is the deployed form of the demo recorded on 2026-09-18/19, where Claude
bought ERPC credit with EURC on Base and used it to provision a VPS and an
Unlimited RPC plan — except the wallet is no longer on somebody's laptop.

**Single owner by construction: one deployment = one wallet = one human.**

## What ships where

| PR | Surface |
|---|---|
| PR-0 | `deno/api/auth-api` seeded OAuth client (merged separately) |
| **PR-1 (this)** | scaffold, OAuth 2.1 AS, Google login via auth-api, wallet derivation, `wallet_status` / `holdings` / `wallet_export_seed`, `WalletLedger` DO schema |
| PR-2 | `x402_inspect` / `x402_pay` / `erpc_topup` / `history` / `receipt` / `policy_get` |
| PR-3 | `plan` / `swap` / `bridge` / `policy_set` |

Plan and acceptance criteria: `docs/superpowers/plans/2026-09-21-stablecoin-manager-mcp.md`.

## How a login works

```
MCP client ──OAuth 2.1 (DCR + PKCE)──▶  this worker  ──▶ auth-api (?provider=google) ──▶ Google
                                              │
                                    allowlist: provider === 'google'
                                            && isEmailVerified === true
                                            && email ∈ ALLOWED_GOOGLE_EMAILS
```

Two separate OAuth legs, and they are separate on purpose:

- **Client ↔ worker.** The worker is its own Authorization Server. It mints its
  own tokens with `aud` pinned to its own base URL, so a token issued by some
  other MCP server can never be replayed here.
- **Worker ↔ human.** auth-api answers only "which Google account is this?".
  We do not hold auth-api's customer JWT secret and therefore do not verify that
  token's signature — it is a response body received over TLS from the issuer we
  just POSTed to, the same trust argument `api/mcp/master-api` makes about
  Discord. It is read once and never stored or forwarded.

Making auth-api itself the AS was rejected: its access tokens carry no `aud`,
so the worker could only validate them by holding the shared customer secret —
which would make every dashboard token a key to this wallet.

The allowlist is re-checked **on every MCP call**, not only at login, so
removing an address takes effect immediately rather than after the current
token expires.

## What this worker's token is actually bound to

`cyan` raised this during the PR-0 review, so it is answered by measurement
rather than by design intent. auth-api has a route (`/oauth/login-url`) that
mints login state for an arbitrary `redirect_uri` without consulting its
seeded-client pin, which means **an auth-api access token proves only that
somebody completed a Google login somewhere** — it is not, on its own, a
capability for this wallet. Tracked as issue #13969.

So the question is not "is auth-api's token trustworthy?".

It is also **not** "what can make this worker mint an authorization code?" —
that was the question asked during PR-1 review, and asking it is what hid a
defect for a round. Naming the barrier as the population drops every route
that does not pass through it: the refresh grant never touches an `auth_code:`
key, so a search organised around that key could not see that refresh tokens
were neither single-use, rotated, nor bound to their client.

The question that finds everything is **"what can make `/mcp/*` call
`next()`?"** — i.e. what can produce a token this worker accepts. Measured
across the whole source, there are **two** producers, and both are the two call
sites of `generateMCPToken` in `route/oauth/token.ts`:

**1. The authorization-code grant.** `route/oauth/callback.ts` is the only
writer of an `auth_code:` KV entry, and before it writes one it requires
**all** of:

1. state that verifies under **this worker's** `OAUTH_STATE_SECRET` — an
   attacker cannot forge it, and auth-api never sees the secret;
2. an `upstreamVerifier` carried inside that signed state — so the upstream
   code is exchanged with a verifier only this worker holds;
3. a client id that is still registered here, with the presented
   `redirect_uri` among its registered callbacks;
4. `provider === 'google' && isEmailVerified === true && email ∈ ALLOWED_GOOGLE_EMAILS`.

**2. The refresh grant.** A refresh token is single-use (the stored entry is
destroyed before any further check can throw, so a rejected redemption still
consumes it), rotated (the caller never leaves with the token it arrived
with), and bound to the client it was issued to.

The binding matters because `/oauth/register` mints public clients by default
— `token_endpoint_auth_method: 'none'` — and for those, client identity is the
only thing distinguishing one caller from another at the token endpoint.
(`client_secret_post` is also accepted and `route/oauth/token.ts` authenticates
those clients with their secret; the binding applies to both.)

Two things revoke access here, and the stronger one is not the token lifetime:
the allowlist is re-checked on **every** `/mcp/*` call, so removing an address
stops an already-issued token immediately. Single use and rotation bound how
long a *leaked* token is useful when the owner is still authorized.

This worker also never accepts an auth-api token from a caller. The only
`exchangeAuthApiCode` call site is that same callback, on a back-channel POST
it initiates itself.

The registration allowlist is what keeps step 3 meaningful: it admits only the
hosted Claude and ChatGPT callbacks and RFC 8252 loopback. A loopback callback
resolves on **the browser's own machine**, so an attacker who registers one
still cannot have a victim's code delivered to themselves.

What is *not* claimed: that the worker is immune to a compromise of
`OAUTH_STATE_SECRET` or `JWT_SECRET`, or that an allowlisted owner's own
compromised browser cannot be used against it. The email allowlist in
particular does **not** help there, because such a victim is a legitimate
allowlisted user.

## The wallet

One 24-word mnemonic, two keys, three displayed wallets:

| Chain | Curve | Path | Compatible with |
|---|---|---|---|
| Solana | ed25519 | `m/44'/501'/0'/0'` | Phantom, Solflare |
| Ethereum / Base / Avalanche C | secp256k1 | `m/44'/60'/0'/0/0` | MetaMask |

The EVM address is the same on all three EVM chains — "three wallets" is a
display detail, not three keys.

The phrase lives in the `WALLET_MNEMONIC` Worker secret and nowhere else. It is
re-derived per request and never logged or returned, with one deliberate
exception: `wallet_export_seed`, which requires `confirm:"EXPORT"`, writes an
audit row, and is rate limited. That exception exists because a wallet whose
only copy lives in a Durable Object is a wallet that a deleted namespace
destroys.

`src/wallet/slip10.ts` is copied verbatim from `wallet/packages/core` (a
separate pnpm workspace, so it cannot be imported). `src/wallet/derive.test.ts`
pins the same golden addresses that implementation pins, plus the two canonical
public BIP-44 EVM vectors.

## Safety valve: ceilings, not prompts

The point of this worker is to pay without asking a human first, so the brake
is a ceiling rather than an approval dialog. Defaults (`POLICY_*` vars,
overridable at runtime by `policy_set` with an audit row):

| | |
|---|---|
| per payment | 50 EURC equivalent |
| per day | 200 EURC equivalent |
| networks | `eip155:8453`, `solana-mainnet` |
| assets | EURC, USDC |
| payee | ERPC treasury only, unless `POLICY_ALLOW_ANY_PAYTO=true` |
| slippage | ≤ 50 bps |
| deadline | ≤ 600 s |

Over-limit requests are **refused, never clamped** — quietly paying less than
asked is its own wrong answer.

## Chain access

Every chain call goes through `@elsoul/erpc-sdk`. There is no private RPC
client and no fallback path. What the published SDK cannot do yet, a tool
reports as `{ ok: false, error: 'unsupported_yet', needs: 'W1' }` rather than
reaching around it.

Measured against the published tarball of `@elsoul/erpc-sdk` 0.8.0 (2026-09-21,
re-measured at the start of implementation):

| probe | result |
|---|---|
| `baseRpc` | 0 |
| `solanaRpc` / `ethereumRpc` / `avalancheCRpc` | 11 each (positive control) |
| `"eip155:8453"` | 0 |
| bridge capability ids | exactly the two EURC Ethereum↔Solana ones |

So Base **balances** are not readable yet (wishlist W1). This does **not** block
ERPC credit top-up: paying an x402 402 with EIP-3009
`transferWithAuthorization` is a signature plus an HTTPS request, and the
facilitator submits the transaction — the payer needs no ETH.

Re-measure against the tarball, never the GitHub source tree (which carries
unreleased additions), when a new SDK version ships.

## Deploying

The KV namespace already exists (`mcp-stablecoin-manager-MCP_KV`,
`ad68f65964514401871ce3ba1d3bab66`) and its id is in `wrangler.toml`. CI
deploys on push to main. What CI does **not** do is set secrets:

```bash
# All five runtime secrets are operator-set, once. `wrangler deploy` preserves
# them, so CI redeploys do not disturb them.
pnpm -F mcp-stablecoin-manager exec wrangler secret put JWT_SECRET
pnpm -F mcp-stablecoin-manager exec wrangler secret put REFRESH_TOKEN_SECRET
pnpm -F mcp-stablecoin-manager exec wrangler secret put OAUTH_STATE_SECRET
pnpm -F mcp-stablecoin-manager exec wrangler secret put ERPC_API_KEY
pnpm -F mcp-stablecoin-manager wallet:init     # generates and pipes the mnemonic
```

🔴 **Immediately after `wallet:init`, take the offline backup.** Log in over
MCP and call `wallet_export_seed`, then store the phrase somewhere that is not
this deployment. Measured: `wrangler secret` offers `put`, `delete`, `list`
and `bulk` — **there is no `get`**, so nothing can read the phrase back out of
Cloudflare. `wallet_export_seed` is the only read path that exists, and it is
inside the worker whose throttle can refuse. Do this before funding the
wallet.

`deploy:prod` runs the production-config assertion itself rather than relying
on a `predeploy:prod` script. The pinned pnpm does run pre scripts — measured,
`pnpm run deploy:prod` prints the pre script's output before the main one — so
this is not a fix for a broken guard. It removes the guard's dependency on
`enable-pre-post-scripts` staying at its default, which is a setting anyone can
change repo-wide without touching this package.

**Why the OAuth secrets are not synced from GitHub**, which is what the plan
called for: this repository is at GitHub's hard limit of 100 Actions secrets,
so creating another one returns HTTP 400 — measured 2026-09-21,
`gh api repos/elsoul/vs2-app/actions/secrets` reports `total_count` 100 with an
empty page 2, while reading an existing secret still succeeds, so it is the cap
and not a permission. Freeing a slot means deleting someone else's secret,
which is not this thread's call.

Until the OAuth secrets are set, `/oauth/*` answers **503** and names what is
missing, and `/health` reports `config: "incomplete"` with the list. A worker
that booted and signed tokens with `undefined` would be worse than one that
refuses.

`wallet:init` never prints the phrase, never writes it to a file, and never
puts it in argv. It refuses to run when a `WALLET_MNEMONIC` secret already
exists, because replacing the phrase of a funded wallet strands the funds.
Use `--dry-run` to exercise it without credentials.

That assertion refuses to ship a config with a placeholder KV id, a missing
Durable Object binding or migration tag, a missing custom domain, an empty
login allowlist, `workers_dev = true`, a development secret, or a mnemonic or
API key written into the config.

`wrangler.toml` is **hand-managed** and is not generated from `slv.toml`: the
generator has no schema for `durable_objects` / `new_sqlite_classes`, so
regenerating would drop the `v1` migration tag and orphan the ledger. Same
precedent as `api/erpc/x402-rpc-api`.

## Rolling back a bad deploy

Three different things get called "rolling back" here, and they do not do the
same thing.

**1. Roll the Worker back to its previous version — the one you usually want.**

```bash
pnpm -F mcp-stablecoin-manager exec wrangler rollback
```

The Durable Object's storage, the KV namespace and the custom domain are all
untouched. This is the fast, safe operation for a bad deploy.

**2. Revert the service commit.** `api/mcp/stablecoin-manager/**` matches this
workflow's `paths:`, so the revert itself triggers a deploy of the reverted
code. This is the normal git path and it does reach production — but it takes a
CI run, so prefer (1) when something is actively broken.

**3. Revert the whole PR, workflow included.** This is the trap: removing
`.github/workflows/cf-mcp-stablecoin-manager.yml` means nothing triggers, so
**the deployed Worker keeps serving with nothing in the repo that manages it**.
A revert is not a teardown and, done this way, is not even a rollback.

## Retiring the worker

Retirement is a different operation with permanent consequences. Reverting the
PR does not perform it: the deployed Worker, its custom domain, its KV
namespace and the `WalletLedger` Durable Object all stay live.

To actually retire it:

```bash
# 1. Take the phrase out first, or the funds are unreachable afterwards.
#    (wallet_export_seed over MCP, then move the funds.)
# 2. Then, and only then:
pnpm -F mcp-stablecoin-manager exec wrangler delete
npx wrangler kv namespace delete --namespace-id ad68f65964514401871ce3ba1d3bab66
```

`wrangler delete` destroys the Durable Object's storage, which is the ledger:
every payment, receipt and audit row goes with it. Export what you need first.

## If `wallet_export_seed` refuses forever

The export throttle fails closed: a `throttles` row the worker would not have
written — a corrupted value, not the large positive integer it always stores —
reads as a live claim, and because it reads as live the upsert that would
replace it never runs. Correct for a rate limit on revealing a recovery
phrase, but it does not heal on its own.

If exports are refused long past the 300-second window, the row is the thing to
look at.

Be precise about what survives. The phrase is a Worker secret, not ledger
state, so **the worker keeps signing** no matter what the ledger says — the
wallet is not bricked. But "recoverable" does not mean "readable": `wrangler
secret` has no `get`, so **nobody can retrieve the phrase from Cloudflare**,
and the only read path is the `wallet_export_seed` that is currently refusing.

Which is why the offline backup is taken at setup time, before the wallet is
funded, and not left until it is needed.

## Local development

```bash
pnpm -F mcp-stablecoin-manager dev
pnpm -F mcp-stablecoin-manager check   # tsc, source and tests
pnpm -F mcp-stablecoin-manager test
```

The dev callback is `https://dev-mcp-stablecoin-manager.erpc.global:8787` — a
subdomain we own, mapped to `127.0.0.1` in `/etc/hosts`, served with
`--local-protocol https --port 8787`. Raw `localhost` / `127.0.0.1` is
deliberately **not** a registered redirect_uri on auth-api: the pin is what
keeps an authorization code from being delivered to a host we do not own.

## Connecting a client

```bash
claude mcp add --transport http scm https://mcp-stablecoin-manager.erpc.global/mcp
```

Then log in with Google. An account outside `ALLOWED_GOOGLE_EMAILS` gets a 403
and no authorization code is minted.
