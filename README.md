# imdusd-keeper

A keeper for the **imdUSD** CDP vault on Ethereum mainnet. Anyone can run it: every call it makes is
permissionless, and a protocol is safer with many keepers than with one.

**It starts report-only.** Without `--execute` it reads the chain, prints what it would do and sends
nothing. Run it that way for a day before you give it a key.

- [What it does](#what-it-does)
- [Quick start (no key, no risk)](#quick-start-no-key-no-risk)
- [Choose a setup](#choose-a-setup)
- [Wallet and funding](#wallet-and-funding)
- [Running it](#running-it)
- [Configuration reference](#configuration-reference)
- [Reading the output](#reading-the-output)
- [Operating it](#operating-it)
- [How it decides](#how-it-decides)
- [Security](#security)

## What it does

Five loops share one key and take turns on one queue, so two of them never race for a nonce. The order
is watch, relay, positions, pace, drip: buy the price update, land it, act on it, then housekeeping.

| loop | script | what it does | costs you | earns you |
|---|---|---|---|---|
| **watch** | `watch.mjs` | Keeps the vault's oracle fresh using the **Treasury's** IMD. When IMD's pool falls past a feed's trigger it calls `OracleAsker.arm`, then `ask` 5–100 blocks later. It asks for NHI when that feed nears stale. It refreshes a feed whose allowance has widened. It calls `Treasury.fundOracle()` when the asker cannot cover an update | gas | nothing directly; a fresh price is what makes liquidations and redemptions possible |
| **relay** | `relay.mjs` | Puts attested oracle answers on chain through the permissionless `SwarmRelay` when the Intake's own callback has not delivered them | gas | nothing directly |
| **positions** | `positions.mjs` | Finds every vault position, `bark`s those under `mat`, and `bite`s them after the `lull` | gas + imdUSD inventory (a bite burns **your** imdUSD) | the liquidation bonus in sIMD, plus the barker's `chip` because it barks what it bites. Season 1 also credits liquidators with 3 days of holding points per imdUSD repaid |
| **pace** | `pace.mjs` | Calls `pace()` and `resecure(owner)` so the paced figures redemptions use keep up with the market | gas | nothing: a public good. **Off by default** |
| **drip** | `drip.mjs` | Calls `InferDripper.drip()`, which streams the Treasury's INFER to stakers, when nobody else has for 75 minutes | gas | 1% of each release, in INFER. **Off by default** |

By default the keeper never spends its own IMD. Buying oracle updates with it is opt-in and capped per
UTC day (see [spending your own IMD](#spending-your-own-imd-all-off-by-default)).

## Quick start (no key, no risk)

You need Node.js 20.6 or later. Nothing else is required to watch.

```bash
git clone https://github.com/fa11up/imdusd-keeper && cd imdusd-keeper
npm install
cp config.example.js config.js     # works as is; no secrets go in this file
npm run verify-deployment          # checks the shipped record against the chain; must end "the record matches the chain"
node index.mjs --once              # one report-only pass of every enabled loop
```

You can run any loop on its own: `node watch.mjs`, `node relay.mjs`, `node positions.mjs`,
`node pace.mjs`, `node drip.mjs`. Each prints its full reasoning. `npm test` runs the unit tests.

## Choose a setup

Edit `LOOPS` (and two `enabled` flags) in `config.js`. Every setup below starts report-only. Add
`--execute` once the reports look right.

**1. Observer.** No key and no funds. Run report-only to learn the protocol, or alongside your own
monitoring. This is the default config without `--execute`.

**2. Liquidator.** Earns the bonus, and needs ETH plus imdUSD.

```js
LOOPS: ["relay", "positions"],
```

The relayer is included because a liquidation can only happen right after a fresh price lands. Add
`"watch"` too if you are willing to spend gas so the Treasury buys updates after a fall. It makes more
liquidations possible, and it only asks when a loan of `RISK.minDebt` or more is actually at risk, or
when the price and spot feeds disagree.

**3. Oracle helper.** A public good, gas only.

```js
LOOPS: ["watch", "relay"],
```

It keeps the Treasury-paid oracle running. The Treasury pays the 0.5 IMD per update; you pay gas.

**4. Full keeper.** Everything a protocol operator runs.

```js
LOOPS: ["watch", "relay", "positions", "pace", "drip"],
PACE: { enabled: true, /* … */ },
DRIP: { enabled: true, /* … */ },
```

**5. Drip bounty only.** The cheapest earner: about 0.03 ETH of float, no imdUSD.

```js
LOOPS: ["drip"],
DRIP: { enabled: true, /* … */ },
```

Others race for this bounty every hour. The keeper is a backstop: it only drips when nobody has for
`backstopMinutes`, so it rarely wins, but it never loses gas to a revert.

**6. Oracle sponsor.** You spend your own IMD to keep prices fresh: in the first days after a launch,
before the Treasury can pay, or in a rally the Treasury will not pay for. Add to any setup:

```js
ASK_PAID_IMD_PER_DAY: 2,          // your IMD, per UTC day
KEEPER_ORACLE_FALLBACK: true,     // pay when the Treasury would but cannot
DIVERGENCE: { enabled: true, imdPerDay: 3, /* … */ },  // reopen a vault paused by price/spot disagreement
```

## Wallet and funding

Use a **fresh wallet** that holds nothing but the keeper's operating balance.

```bash
cast wallet new-mnemonic                              # Foundry; or any wallet that exports a BIP-39 phrase
cast wallet address --mnemonic "word word …"          # the keeper's address (first account, m/44'/60'/0'/0/0)
cp .env.example .env && chmod 600 .env                # put the phrase in KEEPER_MNEMONIC, in double quotes
```

| balance | needed by | how much | note |
|---|---|---|---|
| **ETH** | every loop that sends | 0.03–0.05 ETH to start | Every send except the drip (ask, arm, fundOracle, relay, bark, bite, pace, resecure) stops below `MIN_ETH` (0.003). The drip stops below `ROUTINE_MIN_ETH` (0.02), so it can never spend the gas a bite needs. Pace and resecure keep the cheap routine tip |
| **imdUSD** | positions (bite) | as much as you want to be able to liquidate | `bite` burns the caller's imdUSD; with none you can bark but not bite, and a bite is sized down to what you hold. Buy it in the imdUSD/USDC pool, or borrow it from the vault against IMD. It is working capital, not an expense: a bite returns more value in sIMD than it burns |
| **IMD** | only the opt-in spending rules | 0.5 IMD per update | approval to the asker is sent automatically, for the exact amount, when first needed |

**What you receive.**
- **Bite:** the vault's collateral, **sIMD** (staked IMD, `gem` in the deployment record). Unstake it to
  IMD at the staking vault when you want to sell. You cannot unstake sIMD in the same block you
  received it.
- **Drip:** INFER.

## Running it

### By hand

```bash
node index.mjs                          # daemon, report-only, loops on their INTERVALS
node index.mjs --once                   # one pass of each enabled loop, then exit
node --env-file=.env index.mjs --execute          # daemon that acts; refuses to start without KEEPER_MNEMONIC
node --env-file=.env positions.mjs --execute      # one loop, one pass, acting
node relay.mjs --any                    # relay: also consider attestations other people bought (default with a record)
```

The scripts do not read `.env` on their own. Pass `--env-file=.env` to Node, or export the variables in
your shell. Do not `source .env` unless the phrase is quoted, or its words become separate commands.

### As a service (systemd, recommended)

`keeper.service` is a **user** unit: the keeper never runs as root. It loads `.env` itself, if present.
Without one it still runs, report-only.

```bash
mkdir -p state ~/.config/systemd/user           # the unit may write only state/, so it must exist
cp keeper.service ~/.config/systemd/user/imdusd-keeper.service
# edit WorkingDirectory / EnvironmentFile / ReadWritePaths if the checkout is not ~/imdusd-keeper
loginctl enable-linger $USER                # keep it running after you log out
systemctl --user daemon-reload && systemctl --user enable --now imdusd-keeper
journalctl --user -u imdusd-keeper -f       # watch it
```

The unit runs report-only until you change its `ExecStart` to `/usr/bin/env node index.mjs --execute`
and restart it.

### From cron

`--once` runs each enabled loop once and exits, for a scheduler you already have:

```cron
*/5 * * * * cd ~/imdusd-keeper && /usr/bin/node --env-file=.env index.mjs --once --execute >> keeper.log 2>&1
```

The daemon is better for the watcher: arming is block-sensitive, so it must ask 5–100 blocks after it
arms. A 5-minute cron (about 25 blocks) still fits inside that window.

## Configuration reference

All settings are in `config.js`, which is gitignored and holds no keys. `config.example.js` is the
template, with every default commented. Every key has a default, so you can delete any line you do not
need. The daemon runs each tick of each loop as a fresh process, so a loop's settings take effect on its
next tick. `LOOPS` and `INTERVALS` are read once at start, so changing them needs a restart.

### Environment variables (`.env`)

| variable | default | meaning |
|---|---|---|
| `KEEPER_MNEMONIC` | none | The signing key, as a BIP-39 phrase in double quotes. Needed only for `--execute`. The keeper signs with the first account |
| `VAULT_RPC_URL` | `MAINNET_RPC_URL`, then publicnode | Where **signed transactions** are sent. Use a private mempool so a bark or bite cannot be copied ahead of you: `https://rpc.mevblocker.io` or `https://rpc.flashbots.net` |
| `READ_RPC_URLS` | publicnode, drpc | Comma-separated read RPCs (calls, estimates, nonces, receipts), tried in order with failover after a 2 s stall. Overrides `READ_RPC_URLS` in config.js. Your own node or a paid endpoint goes first |
| `MAINNET_RPC_URL` | publicnode | Used for the stale-price pool estimate, and as the fallback for `VAULT_RPC_URL` |
| `BLOCKSCOUT_API_KEY` | none | For position discovery past Blockscout's anonymous quota. A free key from eth.blockscout.com is enough |
| `DEPLOYMENT` | `./deployment/mainnet/deployment.json` | A different deployment record |

### Deployment and data

| key | default | meaning |
|---|---|---|
| `DEPLOYMENT` | the shipped mainnet record | Where every address and oracle body comes from. See [the deployment record](#the-deployment-record) |
| `API_BASE` | `https://api.imd.fun` | The IdentityMD oracle plane: lists attested requests and serves their signatures, plus the `/swarm` reading behind the NHI feed. Tried after the servers in the `imd.servers` text record of `identitymd.eth`, which the plane's operator keeps on chain; the first server whose `/health` answers is used (`lib/plane.mjs`) |
| `API_FALLBACKS` | `[]` | More plane servers to try after ENS and `API_BASE` |
| `PLANE` | `{ holdAfterBlocked: 3, timeoutMs: 8000 }` | No update is bought while no plane server answers, or while the plane's newest `holdAfterBlocked` settled oracle requests were all `blocked` (a plane that is up but failing every job). Paid requests are not refunded, so holding costs only time. `0` turns the second check off; `timeoutMs` is per server |
| `INDEXER` | `https://eth.blockscout.com` | Position discovery. `"rpc"` reads `eth_getLogs` from your node, which is for local forks only (see [why](#position-discovery-needs-an-indexer)) |
| `POOL` | IMD/ETH v4 pool | `{ poolManager, poolId, invert }`: the pool the price feeds read, used for the stale-price estimate. `invert: false` is ETH per IMD, the direction every feed quotes |

### Which loops run, and how often

| key | default | meaning |
|---|---|---|
| `LOOPS` | all five | The loops the daemon runs. Omitted, it runs all of them. `pace` and `drip` also need their `enabled` flag |
| `INTERVALS.watchSeconds` | 60 | Watcher cadence. Keep it at or under about 5 minutes: an arm must be followed by its ask within 100 blocks |
| `INTERVALS.relaySeconds` | 120 | Relayer cadence |
| `INTERVALS.positionsSeconds` | 300 | Liquidator cadence. A bark has a lull (6 h on mainnet) before it can be bitten, so every block is not needed |
| `INTERVALS.paceSeconds` | 300 | The pacer checks often and acts rarely |
| `INTERVALS.dripSeconds` | 3600 | Each `drip()` releases at most one hour of the dripper's buffer |

### Guard rails on every send

| key | default | meaning |
|---|---|---|
| `MAX_GAS_GWEI` | 30 | Send nothing while the network gas price is above this |
| `MIN_ETH` | 0.003 | Urgent sends (ask, arm, fundOracle, relay, bark, bite, approve) stop below this balance |
| `ROUTINE_MIN_ETH` | 0.02 | The drip stops below this (pace and resecure stop only at `MIN_ETH`). Keep it above `MIN_ETH` |
| `FEES.routine.tipGwei` / `FEES.urgent.tipGwei` | 0.05 / 0.5 | Priority tip per tier, over a fee cap of twice the base fee. Too low and a private-mempool send sits unmined; keep both above zero |
| `GAS_MARGIN_BPS` | 2500 | Gas limit = the node's estimate + 25%. The vault's gas cost moves with the block time; unused margin costs nothing |

Kill switch: `touch state/STOP` stops every send without stopping the daemon. Delete the file to resume.

### Which loans are worth acting on

| key | default | meaning |
|---|---|---|
| `RISK.minDebt` | 15 (imdUSD) | Loans below this are dust: never barked, bitten or bought a price for. Each bark costs more gas than a dust loan's chip earns. Lower it if your gas is cheap and you want them |
| `RISK.marginBps` | 1000 | The watcher buys a Treasury-paid price after a fall only while a loan above `minDebt` would sit under `mat × (1 + margin)` at the pool's price (170% × 1.1 = 187%), or while the price and spot feeds disagree past the vault's skew. NHI keep-alive and wide-open refreshes are never gated |

### Spending your own IMD (all off by default)

`ASK_PAID_IMD_PER_DAY` and `DIVERGENCE.imdPerDay` are separate daily budgets. Each resets at 00:00
UTC and is recorded in `state/`.

| key | default | meaning |
|---|---|---|
| `ASK_PAID_IMD_PER_DAY` | 0 | Your IMD the keeper may spend per UTC day on (a) `KEEPER_ORACLE_FALLBACK` below, and (b) the liquidator's own rule: when pricing is stale and a position would be under `mat` at the pool's price, buy a fresh price + spot so it can be liquidated. 0 turns both off. Each update is 0.5 IMD; a price + spot pair is 1 IMD |
| `KEEPER_ORACLE_FALLBACK` | false | Pay for exactly what the Treasury would pay for, when it cannot (even after `fundOracle`). In priority order: NHI near stale (a stale NHI halts the vault), a confirmed fall (price + spot together), the primary once its allowance has widened. Never a rise. Useful in a new deployment's first days |
| `DIVERGENCE.enabled` | false | Buy updates when the price (a 2-hour median) and the spot disagree past the vault's skew, which pauses borrowing, redemption and liquidation. This happens in rallies, which the Treasury never pays for. It buys only when its projection says the purchase would reopen the vault |
| `DIVERGENCE.imdPerDay` | 3 | Its own daily budget |
| `DIVERGENCE.earlyBps` | 100 | Act from skew minus this, before the pause |
| `DIVERGENCE.marginBps` | 100 | The projected gap after buying must be at most skew minus this |
| `DIVERGENCE.minSpotLifeMinutes` | 30 | Re-buy the spot too if its value would expire sooner than this |
| `DIVERGENCE.whenStale` | true | Also act on a stale pair that still disagrees with the market |
| `DIVERGENCE.archiveRpc` | `https://eth.drpc.org` | An archive node, needed to read the past pool samples the median is built from |

### Relaying

| key | default | meaning |
|---|---|---|
| `RELAY_ANY` | true | Relay attestations other people bought for these feeds, not only this keeper's. Safe on mainnet: every feed pins its question, and the relayer checks the question hash before sending. `--any` forces it on |
| `RELAY_CALLBACK_GRACE_SECONDS` | 600 | While the asker has a request in flight, leave delivery to the Intake's callback for this long |
| `RELAY_TREASURY_CALLBACK_GRACE_SECONDS` | 1800 | The same for Treasury-paid requests. If a relay lands first, the late callback reverts and backs the feed off for 2 hours |

### The pacer (`PACE`)

| key | default | meaning |
|---|---|---|
| `enabled` | false | Run the pacer loop at all |
| `marginSeconds` | 300 | Consider `pace()` once a paced clock is this close to a full interval (one hour) |
| `backingGapBps` | 10 | Pace if backing per imdUSD is below par and the live figure is ahead of the paced one by more than this |
| `priceGapBps` | 100 | Pace if the paced payout price sits above the feed by more than this. Redemptions then pay too little, and pacing lets the payout price fall toward the market |
| `supplyLagBps` | 500 | Pace if the redemption fee base is this far off the live supply |
| `resecureToleranceBps` | 50 | Re-price positions only when that would move the vault's backing figure by more than this |
| `resecureMaxPerRun` | 20 | At most this many `resecure` calls per run, largest discrepancy first |

`pace()` is sent only when it moves something. Without these conditions it would cost about 24
transactions a day for nothing.

### The dripper (`DRIP`)

| key | default | meaning |
|---|---|---|
| `enabled` | false | Run the drip loop at all |
| `dripper` | the mainnet InferDripper | The contract to call |
| `infer` | the INFER token | Only used to report the buffer and sINFER balance |
| `backstopMinutes` | 75 | Drip only when nobody has dripped for this long, in chain time. Bots drip hourly for the 1%; racing them buys reverts |

### Other deployments (no record)

Without a `DEPLOYMENT`, the keeper falls back to hand-written addresses: `VAULT`, `FEEDS` (`[{ role,
address, payload }]`), `VAULT_INTERFACE` (`"maker"`, or `"legacy"` for vaults built before the MakerDAO
renaming), `TRIGGER_FRACTION_OF_CAP` (0.5) and `STALENESS_MARGIN_SECONDS`. In that mode the watcher never spends: it prints what to buy. Use it for
testnets. On mainnet, always use the record.

## Reading the output

Each line is prefixed with a timestamp and the loop's name. The words that matter:

| word | meaning |
|---|---|
| `hold` / `nothing to do.` | Checked, nothing needed |
| `ACT` | Would act now. Report-only mode stops here |
| `WAIT` / `wait` | Will act later: an arm maturing, a lull running, an allowance widening, a callback in flight |
| `BLOCKED` | Cannot act, and says why. A stale price is normal on mainnet: prices are bought on demand |
| `sent 0x… (block N, gas G)` | Mined |
| `refused <reason>` | The simulation reverted, so nothing was sent and nothing was spent. The reason is the contract's |
| `skipped <reason>` | A guard rail held it back: gas price, ETH floor, kill switch, budget |
| `FAIL`, `BODY MISMATCH`, `REFUSING` | Configuration problems: fix before running `--execute` |

Exit codes are information, not crashes. 1 is an error (a failed read, a body mismatch), and 2 means a
pool read came back inverted, which the keeper refuses to act on. The daemon logs the code and carries
on to the next tick.

`state/` (gitignored, the only directory the service may write) holds:

| file | contents |
|---|---|
| `STOP` | the kill switch, if present |
| `requests.json` | oracle requests this keeper bought, for the relayer |
| `spend.json`, `agreement.json` | today's own-IMD spending, per budget |
| `owners.json` | discovered position owners, shared by the loops (refreshed every few minutes) |

Deleting `state/` is safe. It forgets today's budgets, so don't delete it to get around them.

## Operating it

- **First day.** Report-only. Read each loop's reasoning and check that the balances it reports are the
  ones you funded.
- **Going live.** Fund the wallet, then run `node --env-file=.env <loop>.mjs --execute` once per loop
  by hand. Then switch the service to `--execute`.
- **Watch the floors.** A loop that logs `skipped … below MIN_ETH` is idle. Top the wallet up.
- **Updating.** `git pull && npm ci`, run `npm run verify-deployment`, then
  `systemctl --user restart imdusd-keeper`. Your `config.js` and `.env` are untouched. Compare
  `config.example.js` for new keys: every key has a default, so a missing one never breaks the keeper.
- **Rotating the key.** Stop the service and move the balances to a new wallet. Then replace
  `KEEPER_MNEMONIC` and start the service again.
- **Stopping fast.** `touch state/STOP` stops all sending immediately. `systemctl --user stop
  imdusd-keeper` stops the daemon itself.

### The deployment record

`deployment/mainnet/` is the record imdUSD's `DeployMainnet` wrote after reading the whole stack back off
the chain:
- `deployment.json`: the vault, feeds, asker, Treasury, …;
- `bodies/`: the exact oracle request bodies.

The asker pins the keccak of each body, so a single different byte is `WrongBody` on every ask. That is
why the keeper reads the bodies from files rather than building them.

`npm run verify-deployment` checks three things:
- every address has code;
- the vault points at the record's Treasury, collateral and stablecoin;
- the asker pins each body file's hash.

If the protocol redeploys, replace the record with the new one and run the check before restarting. A
hand-copied address is how an earlier testnet launch shipped dead.

## How it decides

### Watch movement, not a clock

A `SwarmFeed` accepts at most `maxDeviationBps` of change per update while its value is fresh, so the cap
and the update cadence are one knob. Updating on a schedule pays for requests in a flat market and still
misses a fast one. The watcher fires when the pool leaves a band narrower than the cap, so cost scales
with volatility.

The Treasury pays for **falls only**: its rise trigger is zero. Before asking, the keeper checks
`SwarmFeed.accepts(value)`, because an answer the feed would refuse is still charged in full.

The pool read (`lib/pool.mjs`) is a port of the oracle plane's own `univ4-spot` recipe, not an
approximation. A feed only accepts an answer to the question it pins, and that question names the
recipe. The keeper refuses a spot at or above 1e18, which means the direction is inverted.

### Liquidations: being the barker is the edge

The vault speaks MakerDAO:
1. `bark` marks a position below `mat`.
2. Its `lull` must pass.
3. `bite` then repays its debt for collateral, inside its `tail`.

The bonus is split into `chip` for whoever barked and `cut` for the protocol. `bite` pays the caller
`seized - cut` when the caller also barked, and `seized - cut - chip` otherwise. So the keeper barks
with `barkFor(owner, itself)` what it intends to bite.

`lib/vault.mjs` transcribes `bite`'s arithmetic, floors and dust sweep included. It reproduces live
stress-test payouts to the wei.

**A stale feed blocks everything.** `bite` requires fresh prices that agree with each other. While
pricing is stale, no position can be liquidated, however far underwater. `positions.mjs` says so on its
first line rather than reporting an empty list. It then estimates every position at the pool's price,
and (only if you opt in with `ASK_PAID_IMD_PER_DAY`) buys a fresh price + spot when a liquidation is
waiting on one.

### Position discovery needs an indexer

Positions live in a `mapping(address => Position)`, so events are the only index. A public RPC is not a
sound source for them. Measured against this vault:
- a 50,000-block `eth_getLogs` span returned the depositor;
- a 40,669-block span inside the same range returned nothing;
- neither call returned an error.

For a liquidator, "the node declined to look" must not look the same as "there are no positions". So
discovery reads Blockscout, paginated, and throws if it gets no logs at all.

### The relayer, and what it refuses

`relay.mjs` re-applies every check `submitAttestation` makes before it spends gas. `consumer` is a field
the **requester** chooses, so anyone can buy an attestation over a figure of their choosing that names a
feed. Relaying someone else's attestation is therefore safe only on a feed that **pins its question**.
Every mainnet feed does, and the relayer checks the question hash before it sends.

### The pacer

The vault paces four figures: what a redemption is paid against, the fee base, the work ceiling's debt
and the payout price. Each moves at most one `PACE_INTERVAL` (an hour) per pacing, and only when someone
paces. Through a quiet spell nobody does, so a recovery reaches redeemers late. A position's collateral
term is also fixed at the price it was last touched at; `resecure(owner)` re-prices it.

## What a keeper cannot win

Paid attestations are discoverable (`GET /oracle/requests` is public), and `SwarmRelay` is
permissionless. So a searcher can `relayAndBite` ahead of whoever paid for the update. What is never at
risk is the protocol's share: `cut → feeRecipient()` and `chip → barker` do not depend on `msg.sender`.
Competition between keepers is over the liquidator's margin, which is revenue, not solvency.

## Security

- **Use a fresh wallet** with only an operating balance. The key sits in the environment of a
  long-running process, so treat it as hot. `chmod 600 .env`.
- `config.js` holds no keys. `.env`, `config.js` and `state/` are gitignored.
- `keeper.service` runs as your user with `ProtectSystem=strict`, `ProtectHome=read-only` and only
  `state/` writable.
- Do not run it on a machine that executes other people's code: a CI runner, a shared box, a swarm
  worker.
- Send through a private mempool (`VAULT_RPC_URL`). On the public mempool a bite can be copied.

## License

MIT. No warranty: everything this sends is irreversible, and the positions it liquidates belong to real
borrowers. Read the reports before you enable `--execute`.
