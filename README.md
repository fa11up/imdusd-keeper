# imdusd-keeper

A keeper for the **imdUSD** CDP vault on Ethereum mainnet. Anyone can run it: every call it makes is
permissionless, and a protocol is safer with many keepers than with one.

**It starts report-only.** Without `--execute` it reads the chain, prints what it would do and sends
nothing. Run it that way for a day before you give it a key.

| loop | what it does | what it costs you | what it earns you |
|---|---|---|---|
| **watch** (`watch.mjs`) | asks the Treasury-paid `OracleAsker` for a new price when IMD's pool falls past a feed's trigger, keeps the NHI feed alive, refreshes a feed whose allowance has widened, calls `Treasury.fundOracle()` when the asker runs dry | gas | nothing directly; a fresh price is what makes liquidations possible |
| **relay** (`relay.mjs`) | puts attested oracle answers on chain through the permissionless `SwarmRelay` when the Intake's callback did not | gas | nothing directly |
| **positions** (`positions.mjs`) | `bark`s positions under `mat`, then `bite`s them after the `lull` | gas + imdUSD inventory (a bite burns **your** imdUSD) | the liquidation bonus, plus the barker's `chip` if you barked it too |
| **pace** (`pace.mjs`), off by default | `pace()` and `resecure(owner)` so redemptions track a recovery | gas | nothing: a public good |
| **drip** (`drip.mjs`), off by default | `InferDripper.drip()` when nobody else has for 75 minutes | gas | 1% of each release, in INFER |

The defaults never spend your IMD. Buying oracle updates with your own IMD (`ASK_PAID_IMD_PER_DAY`,
`KEEPER_ORACLE_FALLBACK`, `DIVERGENCE`) is opt-in and capped per UTC day.

## Quick start

```bash
git clone https://github.com/fa11up/imdusd-keeper && cd imdusd-keeper
npm install
cp config.example.js config.js     # addresses come from deployment/, not from here; no secrets
npm run verify-deployment          # the shipped record against the chain: must end "the record matches the chain"
node index.mjs --once              # one report-only pass of every enabled loop
```

Each loop also runs on its own: `node watch.mjs`, `node positions.mjs`, `node relay.mjs`,
`node pace.mjs`, `node drip.mjs`. Add `--execute` to act.

To act:

```bash
cp .env.example .env               # KEEPER_MNEMONIC (a fresh wallet), VAULT_RPC_URL (a private mempool)
node index.mjs --execute           # refuses to start without KEEPER_MNEMONIC
```

### As a service

`keeper.service` is a **user** systemd unit, so the keeper never runs as root:

```bash
mkdir -p ~/.config/systemd/user
cp keeper.service ~/.config/systemd/user/imdusd-keeper.service   # edit WorkingDirectory if not ~/imdusd-keeper
loginctl enable-linger $USER
systemctl --user daemon-reload && systemctl --user enable --now imdusd-keeper
journalctl --user -u imdusd-keeper -f
```

It runs report-only until you add `--execute` to `ExecStart`.

## Funding

| balance | for | note |
|---|---|---|
| **ETH** | gas | `MIN_ETH` (0.003) is the floor for urgent sends (asks, relays, barks, bites); `ROUTINE_MIN_ETH` (0.02) for housekeeping (pace, resecure, drip), so housekeeping never eats the gas a bite needs |
| **imdUSD** | bite inventory | `bite` burns the caller's imdUSD. With none you can bark but not bite. Working capital, not an expense: the bite returns more than it burns |
| **IMD** | optional | only if you opt in to buying oracle updates yourself (0.5 IMD each) |

## Configuration

Everything is in `config.js` (gitignored) and commented in `config.example.js`. The parts you are most
likely to change:

| key | default | meaning |
|---|---|---|
| `DEPLOYMENT` | `./deployment/mainnet/deployment.json` | the record every address and oracle body comes from |
| `VAULT_RPC_URL` (env) | public RPC | where signed transactions go. **Use a private mempool** (`https://rpc.mevblocker.io`, `https://rpc.flashbots.net`) so a bite is not copied ahead of you |
| `READ_RPC_URLS` (env) | publicnode, drpc | reads, with failover |
| `BLOCKSCOUT_API_KEY` (env) | none | position discovery past Blockscout's anonymous quota |
| `MAX_GAS_GWEI` | 30 | send nothing above this |
| `RISK.minDebt` | 15 imdUSD | loans below this are dust: never barked, bitten or bought a price for (a bark costs more gas than its chip) |
| `ASK_PAID_IMD_PER_DAY` | 0 | your own IMD the keeper may spend on oracle updates per UTC day |
| `PACE.enabled`, `DRIP.enabled` | false | the two optional loops |
| `INTERVALS` | 60 / 120 / 300 / 300 / 3600 s | watch / relay / positions / pace / drip |

**Kill switch:** `touch state/STOP` stops every send without stopping the daemon. Delete it to resume.

### The deployment record

`deployment/mainnet/` is the record imdUSD's `DeployMainnet` wrote after reading the whole stack back off
chain: `deployment.json` (vault, feeds, asker, Treasury, …) and `bodies/` (the exact oracle request
bodies). The asker pins the keccak of each body, so a different byte is `WrongBody` on every ask, which is
why the keeper reads bodies from files rather than building them. `npm run verify-deployment` checks
every address has code, the vault points at the record's Treasury, collateral and stablecoin, and the
asker pins each body file's hash. A hand-copied address is how an earlier testnet launch shipped dead.

## How it decides

### Guard rails on every send (`lib/tx.mjs`)

Simulate first (a doomed transaction costs nothing and its revert reason is logged), the gas ceiling,
the two ETH floors, the kill switch, a small tip per tier instead of ethers' 1.5 gwei default, and a gas
limit of the estimate plus `GAS_MARGIN_BPS`: the vault's cost moves with the block time, and a bare
estimate ran out of gas in its last store on a fork. The loops take turns on one queue, so one key never
has two transactions racing for a nonce.

### Watch movement, not a clock

A `SwarmFeed` accepts at most `maxDeviationBps` of change per update while its value is fresh, so the cap
and the update cadence are one knob. Updating on a schedule pays for requests in a flat market and still
misses a fast one. The watcher fires when the pool leaves a band narrower than the cap, so cost scales
with volatility. The Treasury pays for **falls only** (its rise trigger is zero), and before asking the
keeper checks `SwarmFeed.accepts(value)`: an answer the feed would refuse is still charged in full.

A fall is bought only while a loan above `RISK.minDebt` would sit under `mat × (1 + RISK.marginBps)` at
the pool's price, **or** while the price and spot feeds disagree past the vault's `skew` (which shuts
borrowing and redemption). A fall that leaves every real loan safe and the pair in agreement is not worth
an update.

The pool read (`lib/pool.mjs`) is a port of the oracle plane's own `univ4-spot` recipe, not an
approximation: a feed only accepts an answer to the question it pins, and that question names the
recipe. It refuses a spot at or above 1e18, which means the direction is inverted.

### Liquidations: being the barker is the edge

The vault speaks MakerDAO: `bark` marks a position below `mat`, its `lull` must pass, then `bite` repays
its debt for collateral inside its `tail`. The bonus is split into `chip` for whoever barked and `cut`
for the protocol. `bite` pays the caller `seized - cut` when the caller also barked, `seized - cut -
chip` otherwise, so bark what you intend to bite. `lib/vault.mjs` transcribes `bite`'s arithmetic,
floors and dust sweep included; it reproduces live stress-test payouts to the wei.

**A stale feed blocks everything.** `bite` requires fresh, agreeing prices, so no position can be
liquidated while pricing is stale, however underwater. `positions.mjs` says so as its first line rather
than reporting an empty list, estimates every position at the pool's price, and (only if you opt in
with `ASK_PAID_IMD_PER_DAY`) buys a fresh price + spot when a liquidation is waiting on one.

### Position discovery needs an indexer

Positions live in a `mapping(address => Position)`; events are the only index. A public RPC is not a
sound source: measured against this vault, a 50,000-block `eth_getLogs` span returned the depositor while
a 40,669-block span inside the same range returned nothing, neither erroring. For a liquidator, "the node
declined to look" and "there are no positions" must not look the same, so discovery reads Blockscout,
paginated, and throws if it gets no logs at all. `INDEXER: "rpc"` is for local forks only.

### The relayer, and the one thing it refuses

`relay.mjs` re-applies every guard `submitAttestation` checks before spending gas. `consumer` is a field
the **requester** chooses, so anyone can buy an attestation over a figure of their choosing that names a
feed. Relaying someone else's attestation is therefore only safe on a feed that **pins its question**;
every mainnet feed does, and the relayer checks the question hash before sending. While the asker has a
request in flight it leaves delivery to the Intake's callback for `RELAY_CALLBACK_GRACE_SECONDS`, because
a relay that lands first makes the late callback revert and backs the feed off.

### The pacer

The vault paces what a redemption is paid against, the fee base, the work ceiling's debt and the payout
price: each moves at most one `PACE_INTERVAL` (an hour) per pacing, and only when someone paces. Through a
quiet spell nobody does, so a recovery reaches redeemers late. And a position's collateral term is fixed
at the price it was last touched at; `resecure(owner)` re-prices it. `pace.mjs` calls `pace()` only when
it moves something, and `resecure` only for terms whose re-price would move the backing figure.

## What a keeper cannot win

Paid attestations are discoverable (`GET /oracle/requests` is public) and `SwarmRelay` is permissionless,
so a searcher can `relayAndBite` ahead of whoever paid for the update. What is never at risk is the
protocol's share: `cut → feeRecipient()` and `chip → barker` do not depend on `msg.sender`. Competition
between keepers is over the liquidator's margin, which is revenue, not solvency.

## Security

* **Use a fresh wallet** that holds only an operating balance. The key is in the environment of a
  long-running process: treat it as hot.
* `config.js` holds no keys. `.env`, `config.js` and `state/` are gitignored.
* `keeper.service` runs as your user with `ProtectSystem=strict`, `ProtectHome=read-only` and only
  `state/` writable.
* Do not run it on a machine that executes other people's code (a CI runner, a shared box, a swarm
  worker).

## Exit codes

Each loop runs as a child process, so one that throws logs and waits for its next tick rather than
taking the daemon down. Non-zero exits are information: 3 means a feed is stale, 2 that a pool read came
back inverted.

## License

MIT. No warranty: everything this sends is irreversible, and the positions it liquidates belong to real
borrowers. Read the reports before you enable `--execute`.
