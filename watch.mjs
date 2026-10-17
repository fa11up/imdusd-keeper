#!/usr/bin/env node
// The price-movement watcher: decides WHEN a feed needs a new attestation, and never buys one.
//
// WHY MOVEMENT AND NOT A CLOCK. A SwarmFeed accepts at most `maxDeviationBps` of change per update
// while its current value is fresh. So the cap and the update cadence are one knob, not two: a cap is
// only safe if the market cannot move further than the cap between updates. Updating on a schedule
// gets this wrong in both directions — it pays for requests in a flat market and still misses a fast
// one. IMD moved 44.6% in a day once, and a request bought with guards pinned to the old
// level was refused by the panel, costing 0.5 IMD for nothing.
//
// So: watch the pool continuously, and fire when spot leaves a band NARROWER than the cap.
//
// TWO MODES.
//
// With an OracleAsker (any deployment record from DeployMainnet), the keeper drives the TREASURY-paid
// path and pays only gas: `Treasury.fundOracle()` when the asker cannot cover one update, `arm(feed)`
// when pool drift passes the feed's trigger, `ask(feed, body)` once the arm has matured, `ask(nhi,
// body)` when NHI nears stale, and `ask(feed, body)` for any feed whose allowance has WIDENED with
// staleness to the asker's threshold (a feed's bound grows the longer it is silent — SwarmFeed — so a
// silent feed is refreshed before one purchase could re-anchor it far from the market). Every one of
// those is permissionless and refuses on chain unless the chain shows the need, so the keeper decides
// nothing the contract does not re-check. The trigger is ASYMMETRIC (infer-protocol
// docs/oracle-guards/): a FALL of the pool below a feed is bought at a quarter of its cap; a rise is
// never paid for by the Treasury (rise trigger 0).
//
// Before asking for a fall it checks the move against the feed's current allowance from its epoch
// anchor: a figure outside it would be refused on delivery, so the request is not bought until the
// allowance has widened to reach it.
//
// Without one (Sepolia launch 688), IT DOES NOT SPEND: buying a request there costs 0.5 IMD through a
// browser and cannot be undone, so it prints the exact commands instead.
import { readProvider } from "./lib/rpc.mjs";
import { providers, Contract, BigNumber, utils } from "ethers";
import { readSpot } from "./lib/pool.mjs";
import { loadDeployment } from "./lib/deployment.mjs";
import { send, describe, keeperSigner } from "./lib/tx.mjs";
import { spentToday, recordSpend } from "./lib/spend.mjs";
import { readLiveNhi } from "./lib/nhi.mjs";
import { loansAtRisk, riskCfg, pairDisagrees, pairGapBps } from "./lib/risk.mjs";
import { windowOf, projectMedian, gapBps } from "./lib/median.mjs";
import cfg from "./config.js";

const ASKER_ABI = [
  // treasuryPaid sits before inFlight since infer-protocol's sweep fixes: decoded by name below, but the shape must match.
  "function feeds(address) view returns (bytes32 bodyHash, bool tracksPool, bool keepAlive, uint64 lastAsk, uint64 armedAt, uint64 inFlightAt, bool treasuryPaid, bytes32 inFlight)",
  "function nearStale(address) view returns (bool)",
  "function wideOpen(address) view returns (bool)",
  "function driftBps(address) view returns (uint256)",
  "function triggerBps(address) view returns (uint256 fall, uint256 rise)",
  "function poolPrice() view returns (uint256)",
  "function price() view returns (uint256)",
  "function arm(address)",
  "function ask(address, bytes) returns (bytes32)",
  "function askPaidMany(address[] feeds, bytes[] bodies, uint256 maxPriceEach) returns (bytes32[])",
];
const TREASURY_ABI = ["function fundOracle() returns (uint256)"];
const VAULT_ABI = ["function skew() view returns (uint256)", "function treasury() view returns (address)", "function totalDebt() view returns (uint256)", "function gem() view returns (address)"];
const SHARE_ABI = ["function maxWithdraw(address) view returns (uint256)"];
const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
];
// OracleAsker's arming rule (DeploymentConfig ARM_DELAY_BLOCKS / ARM_WINDOW_BLOCKS). Only used to
// decide when to TRY; the asker enforces the real values and a mismatch is caught by simulation.
const ARM_DELAY_BLOCKS = 5;
const ARM_WINDOW_BLOCKS = 100;
const ASK_TIMEOUT = 2 * 3600;

const FEED_ABI = [
  "function latestValue() view returns (uint256 value, uint64 updatedAt)",
  "function isStale() view returns (bool)",
  "function maxAge() view returns (uint256)",
  "function maxDeviationBps() view returns (uint256)",
  "function lastToBlock() view returns (uint64)",
  "function epoch() view returns (uint256 anchor, uint64 openedAt, uint256 allowanceBps)",
  "function accepts(uint256 value) view returns (bool)",
];

const BPS = 10_000;
const bps = (a, b) => (b.isZero() ? null : a.sub(b).abs().mul(BPS).div(b).toNumber());
const ago = (s) => (s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`);

/** How many successive capped updates it takes to walk `from` to `to`. */
function stepsNeeded(from, to, capBps) {
  if (from.isZero()) return 1;
  const ratio = Number(utils.formatUnits(to.mul(1e9).div(from), 9));
  const step = 1 + capBps / BPS;
  return Math.max(1, Math.ceil(Math.abs(Math.log(ratio)) / Math.log(step)));
}

async function main() {
  const dep = loadDeployment(cfg);
  if (dep.asker) return askerMode(dep);
  const mainnet = new providers.JsonRpcProvider(cfg.MAINNET_RPC_URL);
  const vaultChain = readProvider(cfg);

  const { sqrtPriceX96, spot } = await readSpot(mainnet, cfg.POOL);
  const net = await vaultChain.getNetwork();
  const now = Math.floor(Date.now() / 1000);

  console.log(`pool    ${cfg.POOL.poolId.slice(0, 18)}… on PoolManager ${cfg.POOL.poolManager.slice(0, 10)}…`);
  console.log(`spot    ${spot.toString()} wei ETH per 1e18 IMD   (sqrtPriceX96 ${sqrtPriceX96.toString()})`);
  // The direction check that has bitten us: inverting gives a number ~1e20, which reads as a market
  // move rather than a misreading. A correct answer is many orders of magnitude below 1e18.
  if (spot.gte(utils.parseEther("1"))) {
    console.log("REFUSING: spot is at or above 1e18, which means the direction is inverted, not that IMD is worth an ETH.");
    process.exitCode = 2;
    return;
  }
  console.log(`feeds   on chain ${net.chainId}\n`);

  let anyAction = false;
  for (const f of cfg.FEEDS) {
    const feed = new Contract(f.address, FEED_ABI, vaultChain);
    let value, updatedAt, stale, cap, maxAge;
    try {
      [[value, updatedAt], stale, cap, maxAge] = await Promise.all([
        feed.latestValue(), feed.isStale(), feed.maxDeviationBps(), feed.maxAge(),
      ]);
    } catch (e) {
      console.log(`${f.role.padEnd(6)} ${f.address}  UNREADABLE: ${e.shortMessage || e.message}`);
      continue;
    }

    const capBps = cap.toNumber();
    const triggerBps = Math.floor(capBps * cfg.TRIGGER_FRACTION_OF_CAP);
    const age = updatedAt === 0 ? null : now - Number(updatedAt);
    const drift = value.isZero() ? null : bps(spot, value);
    const nearStale = age !== null && Number(maxAge) - age <= cfg.STALENESS_MARGIN_SECONDS;

    console.log(`${f.role.padEnd(6)} ${f.address}`);
    console.log(`       value ${value.toString()}${age === null ? "  (never set)" : `  set ${ago(age)} ago of ${ago(Number(maxAge))} allowed`}`);
    if (drift === null) {
      console.log(`       drift  n/a — the feed holds no value, so there is no band to leave`);
    } else {
      console.log(`       drift  ${(drift / 100).toFixed(2)}%  vs trigger ${(triggerBps / 100).toFixed(2)}%  vs cap ${(capBps / 100).toFixed(2)}%`);
    }

    const reasons = [];
    if (stale) reasons.push("STALE — the vault is halted and the next accepted value re-anchors with no deviation bound");
    else if (nearStale) reasons.push(`within ${ago(cfg.STALENESS_MARGIN_SECONDS)} of going stale`);
    if (drift !== null && drift >= triggerBps) reasons.push(`spot has left the trigger band (${(drift / 100).toFixed(2)}% >= ${(triggerBps / 100).toFixed(2)}%)`);

    if (drift !== null && drift > capBps) {
      const n = stepsNeeded(value, spot, capBps);
      reasons.push(
        `GAP EXCEEDS THE CAP: ${(drift / 100).toFixed(2)}% > ${(capBps / 100).toFixed(2)}%, so ONE attestation cannot close it. ` +
        `Needs ${n} successive updates (${(n * 0.5).toFixed(1)} IMD), each landing inside the band at the time. ` +
        `This is the state the watcher exists to prevent.`,
      );
    }

    if (reasons.length === 0) {
      console.log(`       hold   inside the band and fresh\n`);
      continue;
    }
    anyAction = true;
    for (const r of reasons) console.log(`       ACT    ${r}`);
    console.log(`       run    preflight the oracle request for ${f.address} (guards pinned to the feed's live band), then buy it at the IdentityMD control plane`);
    console.log(`       order  walk the feed to market FIRST, then pin guards, then pay — in that order, same sitting\n`);
  }

  if (!anyAction) console.log("nothing to do.");
  else console.log("This watcher does not spend. Review each command before running it.");
}

async function askerMode(dep) {
  const provider = readProvider(cfg);
  const execute = process.argv.includes("--execute");
  let signer = null;
  if (execute) {
    signer = keeperSigner(provider, cfg);
  }
  const asker = new Contract(dep.asker, ASKER_ABI, signer ?? provider);
  const [head, pool, treasuryAddr] = await Promise.all([
    provider.getBlock("latest"), asker.poolPrice(), new Contract(dep.vault, VAULT_ABI, provider).treasury(),
  ]);
  if (pool.gte(utils.parseEther("1"))) {
    console.log("REFUSING: the asker reads the pool at or above 1e18, which means an inverted reading.");
    process.exitCode = 2;
    return;
  }
  let price_ = BigNumber.from(0);
  try { price_ = await asker.price(); } catch { /* an Intake with no price list reads as not sold */ }
  const held = await new Contract(dep.imd, ERC20, provider).balanceOf(dep.asker);
  console.log(`asker   ${dep.asker}  holds ${utils.formatEther(held)} IMD, update price ${price_.isZero() ? "NOT SOLD" : `${utils.formatEther(price_)} IMD`}`);
  console.log(`pool    ${pool.toString()} wei ETH per 1e18 IMD at block ${head.number}`);
  // DAY ONE (final review 2026-10-07, medium): the Treasury's only sIMD income is the liquidation cut, so
  // until revenue lands it cannot fund the asker and the keeper carries the oracle with its own IMD.
  let treasuryCanFund = true;
  try {
    const gem = await new Contract(dep.vault, VAULT_ABI, provider).gem();
    const withdrawable = await new Contract(gem, SHARE_ABI, provider).maxWithdraw(treasuryAddr);
    treasuryCanFund = !price_.isZero() && held.add(withdrawable).gte(price_);
    if (!treasuryCanFund) {
      const who = cfg.KEEPER_ORACLE_FALLBACK === false || !Number(cfg.ASK_PAID_IMD_PER_DAY ?? 0)
        ? "nobody pays for an update until the asker or the Treasury holds IMD: top up the asker"
        : "the keeper carries the oracle within ASK_PAID_IMD_PER_DAY until revenue lands";
      console.log(`FUNDING the Treasury cannot pay for an update yet (${utils.formatEther(withdrawable)} IMD withdrawable, the asker holds ${utils.formatEther(held)}): ${who}`);
    }
  } catch { /* a collateral that is not a share: fundOracle pays from the Treasury's own balance */ }
  console.log();

  const tasks = [];
  const seen = []; // per feed, for the keeper-paid step below
  // A FALL IS BOUGHT ONLY WHILE A REAL LOAN IS AT RISK: lib/risk.mjs. Read once per run, and only
  // when a fall would otherwise be armed or asked. If the check itself fails, buy as before: a missed liquidation
  // costs more than an unneeded update.
  let risk;
  let divergence;
  const fallWorthBuying = async () => {
    if (risk === undefined) {
      try {
        risk = await loansAtRisk({ dep, provider, cfg, pool });
      } catch (e) {
        risk = null;
        console.log(`risk    the at-risk check failed (${e.message.slice(0, 80)}): a fall is bought as before\n`);
      }
    }
    if (risk === null) return true;
    const { minDebt, marginBps } = riskCfg(cfg);
    // The pair disagreeing past skew shuts redemption and borrowing: worth a fall even with every loan safe.
    if (divergence === undefined) {
      try {
        const byRole = (role) => new Contract(dep.feeds.find((x) => x.role === role).address, FEED_ABI, provider).latestValue();
        const [[primary], [spot], skewBn] = await Promise.all([byRole("price"), byRole("spot"), new Contract(dep.vault, VAULT_ABI, provider).skew()]);
        divergence = { yes: pairDisagrees(primary, spot, skewBn.toNumber()), gap: pairGapBps(primary, spot), skew: skewBn.toNumber() };
      } catch (e) {
        divergence = null;
        console.log(`risk    the divergence check failed (${e.message.slice(0, 80)}): only the at-risk rule decides`);
      }
    }
    if (divergence?.yes) {
      console.log(`       buy   price and spot are ${(divergence.gap / 100).toFixed(2)}% apart, past skew ${(divergence.skew / 100).toFixed(2)}%: redemption and borrowing are shut, so the fall is bought`);
      return true;
    }
    if (risk.atRisk.length === 0) {
      console.log(`       hold  no loan of ${minDebt}+ imdUSD would be under ${risk.threshold}% (mat + ${marginBps / 100}%) at the pool's price (${risk.checked} checked): a fall is not bought`);
      return false;
    }
    for (const r of risk.atRisk) console.log(`       risk  ${r.owner} at ~${r.cr}% < ${risk.threshold}%, debt ${utils.formatEther(r.debt)}`);
    return true;
  };
  for (const f of dep.feeds) {
    const feed = new Contract(f.address, FEED_ABI, provider);
    const [[value, updatedAt], stale, maxAge, capBn, cfgRow, nearStale, drift, [fall, rise], wide, [anchor,, allowance]] = await Promise.all([
      feed.latestValue(), feed.isStale(), feed.maxAge(), feed.maxDeviationBps(),
      asker.feeds(f.address), asker.nearStale(f.address), asker.driftBps(f.address), asker.triggerBps(f.address),
      asker.wideOpen(f.address), feed.epoch(),
    ]);
    if (cfgRow.bodyHash !== f.body.hash) {
      console.log(`${f.role.padEnd(6)} BODY MISMATCH: the asker pins ${cfgRow.bodyHash}, the local body hashes ${f.body.hash}. Fix DEPLOYMENT.`);
      process.exitCode = 1;
      continue;
    }
    const falling = pool.lt(value);
    // Zero means the Treasury never pays in that direction (rises, by design).
    const trigger = (falling ? fall : rise).toNumber();
    const drifted = trigger !== 0 && drift.toNumber() > trigger;
    const age = Number(updatedAt) === 0 ? null : head.timestamp - Number(updatedAt);
    const inFlight = cfgRow.inFlight !== utils.hexZeroPad("0x", 32) && head.timestamp < Number(cfgRow.inFlightAt) + ASK_TIMEOUT;
    console.log(`${f.role.padEnd(6)} ${f.address}`);
    console.log(`       value ${value.toString()}${age === null ? "  (never set)" : `  set ${ago(age)} ago of ${ago(Number(maxAge))}`}${stale ? "  STALE" : ""}`);
    if (cfgRow.tracksPool) {
      const t = trigger === 0 ? "never paid for" : `trigger ${(trigger / 100).toFixed(2)}%`;
      console.log(`       drift ${(drift.toNumber() / 100).toFixed(2)}% ${falling ? "BELOW" : "above"} the feed, ${t}   pool-tracked`);
    }
    if (cfgRow.keepAlive) console.log(`       kept alive by the Treasury: asked for once ${nearStale ? "now (near stale)" : "75% of maxAge has passed"}`);
    // The epoch bound: every value accepted within one lifetime must sit within `allowance` of the anchor,
    // and the allowance widens the longer the feed is stale (hourly). An epoch opened wide also holds every
    // value after its first to the cap around that first one (SwarmFeed._epochFirst). The pool's distance from the ANCHOR is what
    // decides whether an attestation bought now could land.
    const allow = allowance.toNumber();
    // The pool for the pool-tracked feeds; for NHI, the live index the body computes from /swarm, read
    // once per run. Null when it cannot be read: then the keeper buys as it did before.
    let live = cfgRow.tracksPool ? pool : null;
    if (f.role === "nhi") {
      live = await readLiveNhi(cfg.API_BASE);
      if (live === null) console.log("       live  NHI: the control plane could not be read; buying without the allowance check");
      else console.log(`       live  NHI ${utils.formatEther(live)} from ${cfg.API_BASE}/swarm`);
    }
    const anchorDrift = anchor.isZero() || live === null ? null : bps(live, anchor);
    console.log(`       allow ${(allow / 100).toFixed(1)}% from the epoch anchor${anchorDrift === null ? "" : `; the pool is ${(anchorDrift / 100).toFixed(2)}% from it`}${wide ? "   WIDE OPEN: the Treasury refreshes it" : ""}`);
    const lifeLeft = age === null ? 0 : Number(maxAge) - age;
    seen.push({ f, feed, value, stale, falling, drift: drift.toNumber(), inFlight, lifeLeft, wide, allow, anchorDrift });
    if (inFlight) { console.log(`       wait  request ${cfgRow.inFlight.slice(0, 18)}… in flight\n`); continue; }

    // Bought while the pool sits further from the anchor than the allowance, an attestation is refused on
    // delivery (ExcessDeviation): the IMD is lost and the asker backs the feed off for ASK_TIMEOUT. The
    // allowance widens by an eighth of the cap (2.5 points at the launch cap) for every hour stale, so wait.
    // Ask the feed itself (SwarmFeed.accepts) rather than re-deriving its rule: after a value pushed in at the
    // end of an epoch, an honest value back at the level the expired epoch held is accepted by the way back
    // (final sweep panel 4) although it sits past the allowance from the new anchor, and that purchase is the
    // one that ends the vault's halt. A feed deployed before accepts() existed falls back to the anchor check.
    let beyond = anchorDrift !== null && anchorDrift > allow;
    if (live !== null) {
      try {
        beyond = !(await feed.accepts(live));
      } catch {
        /* an older feed without accepts(): the anchor check stands */
      }
    }
    const waitBeyond = () => {
      // SwarmFeed._allowanceNow: the cap through the first hour stale; from a whole hour past the lifetime,
      // twice the cap, plus an eighth of the cap for every further whole hour.
      const cap = capBn.toNumber(), base = 2 * cap, growth = cap / 8;
      const periodsNeeded = anchorDrift <= base ? 1 : Math.ceil((anchorDrift - base) / growth) + 1;
      const pastLifetime = age === null ? 0 : age - Number(maxAge); // negative while the value is fresh
      const hours = Math.max(0, Math.ceil((periodsNeeded * 3600 - pastLifetime) / 3600));
      console.log(`       wait  the ${f.role === "nhi" ? "live index" : "pool"} is ${(anchorDrift / 100).toFixed(2)}% from the anchor, past the ${(allow / 100).toFixed(1)}% allowance: an update now would be refused and still charged; the allowance reaches it in about ${hours} hour(s), and the keeper holds its budget for that purchase`);
    };
    if (cfgRow.keepAlive && nearStale) {
      // An NHI answer the feed would refuse is not bought (second-half review 2026-10-07, low): a refusal
      // costs the full price, and four of them were the keeper's whole day while the vault halted at 24h.
      if (beyond) waitBeyond();
      else tasks.push({ f, what: "ask", kind: "alive", why: "near stale; the Treasury keeps this feed alive" });
    } else if (wide) {
      // wideOpen is true only while the value is stale (OracleAsker, since the review of cc4103f), so this
      // is bought once per silence: the delivered value is fresh and closes its wide epoch behind it.
      if (beyond) waitBeyond();
      else tasks.push({ f, what: "ask", kind: "wide", why: `its allowance has widened to ${(allow / 100).toFixed(1)}%: refreshed before one purchase could re-anchor it` });
    } else if (cfgRow.tracksPool && drifted) {
      if (beyond) {
        waitBeyond();
      } else if (!(await fallWorthBuying())) {
        // logged by fallWorthBuying
      } else {
        const armedAt = Number(cfgRow.armedAt);
        if (armedAt === 0 || head.number > armedAt + ARM_WINDOW_BLOCKS) tasks.push({ f, what: "arm", kind: "fall", why: "pool has drifted past the trigger" });
        else if (head.number >= armedAt + ARM_DELAY_BLOCKS) tasks.push({ f, what: "ask", kind: "fall", why: `drift armed at block ${armedAt} and still present` });
        else console.log(`       wait  armed at ${armedAt}; ask from block ${armedAt + ARM_DELAY_BLOCKS}`);
      }
    } else if (stale && cfgRow.tracksPool) {
      console.log(`       hold  stale but the pool has not moved: the Treasury does not pay for that until the allowance widens.`);
    } else {
      console.log(`       hold`);
    }
    console.log();
  }

  // THE KEEPER'S OWN IMD, AS A FALLBACK FOR THE TREASURY (added for launch: the keeper manages the oracle until
  // revenue lands in the Treasury). It pays for exactly
  // what the Treasury would pay for, and only when it cannot — after fundOracle the asker still holds less
  // than one update. In priority order under ASK_PAID_IMD_PER_DAY: (1) NHI near stale, because a stale NHI
  // halts the whole vault a day after launch — but never an NHI answer the feed's allowance would refuse
  // (lib/nhi.mjs reads the live index first; a refused answer is charged in full); (2) a FALL of the pool below the price, armed and still present
  // 5 blocks later (price + spot together); (3) the PRIMARY feed once its allowance has widened to the asker's
  // threshold — the spot is left to the Treasury, because the vault refuses to act while primary and spot
  // disagree, so a walked spot alone moves nothing. Never for a rise. Switch off with KEEPER_ORACLE_FALLBACK =
  // false once the Treasury carries the oracle; the positions loop still buys a price when a liquidation
  // waits on one.
  await keepAgreement({ dep, signer, asker, head, pool, seen, tasks, each: price_ });
  if (tasks.length === 0) { console.log("nothing to do."); return; }
  for (const t of tasks) console.log(`ACT     ${t.what} ${t.f.role}: ${t.why}`);
  if (!signer) { console.log("\nreport only. Add --execute (with KEEPER_MNEMONIC) to act; the Treasury pays its asks, the keeper pays gas."); return; }

  // The asker can only spend what the Treasury streamed it. fundOracle tops it up to one day's budget
  // and is permissionless; call it first if an ask is due and one update would not be covered.
  const asks = tasks.filter((t) => t.what === "ask");
  let funded = held;
  if (asks.length && !price_.isZero() && held.lt(price_.mul(asks.length))) {
    const treasury = new Contract(treasuryAddr, TREASURY_ABI, signer);
    const r = await send(signer, "fundOracle", () => treasury.callStatic.fundOracle(), () => treasury.fundOracle(), cfg);
    console.log(`fund    ${describe(r)}`);
    funded = await new Contract(dep.imd, ERC20, provider).balanceOf(dep.asker);
  }
  const fallback = { alive: null, fall: null, wide: null };
  for (const t of tasks) {
    if (t.what === "ask" && !price_.isZero() && funded.lt(price_)) {
      // The Treasury cannot pay for this one.
      const covered = cfg.KEEPER_ORACLE_FALLBACK !== false && (t.kind === "alive" || t.kind === "fall" || (t.kind === "wide" && t.f.role === "price"));
      if (covered) fallback[t.kind] = t;
      else console.log(`ask     ${t.f.role}: the Treasury cannot cover it (${utils.formatEther(funded)} IMD at the asker)${cfg.KEEPER_ORACLE_FALLBACK === false ? "; keeper fallback is off" : ""}.`);
      continue;
    }
    const r = t.what === "arm"
      ? await send(signer, `arm ${t.f.role}`, () => asker.callStatic.arm(t.f.address), () => asker.arm(t.f.address), cfg)
      : await send(signer, `ask ${t.f.role}`, () => asker.callStatic.ask(t.f.address, t.f.body.bytes), () => asker.ask(t.f.address, t.f.body.bytes), cfg);
    console.log(`${t.what.padEnd(7)} ${t.f.role}: ${describe(r)}`);
    if (t.what === "ask" && r.hash) funded = funded.sub(price_);
  }
  const row = (role) => seen.find((x) => x.f.role === role && !x.inFlight);
  const groups = [];
  if (fallback.alive) groups.push({ label: "NHI near stale", rows: [row("nhi")] });
  // A fall moves the price AND the spot: the vault acts only while they agree, so both are bought together.
  if (fallback.fall) groups.push({ label: "a fall", rows: [row("price"), row("spot")] });
  else if (fallback.wide) groups.push({ label: "a wide-open primary", rows: [row("price")] });
  for (const g of groups) {
    const rows = g.rows.filter(Boolean);
    if (!rows.length) continue;
    console.log(`KEEP    the Treasury cannot pay for ${g.label}; the keeper buys ${rows.map((x) => x.f.role).join(" + ")} with its own IMD`);
    await keeperBuys(dep, signer, asker, rows, price_);
  }
}

// PRICE AND SPOT MUST AGREE (seen in the first rally after launch, 2026-10-11). The vault refuses to borrow,
// withdraw against debt, mark, liquidate or redeem while the primary (a 2-hour median) and the spot (the last
// block) are more than `skew` apart. In a rally the median lags, the Treasury never pays for rises (by
// design), so the vault sits paused with both feeds fresh. This rule pays from the keeper's OWN IMD, under its
// own daily budget (DIVERGENCE.imdPerDay, ledger state/agreement.json), and only for a purchase that would
// reopen the vault: it reads the samples the panel will read (lib/median.mjs) and buys the primary, plus the
// spot when the spot's own value is part of the gap or near its end of life, only when the projected answers
// sit within `skew` less a margin. Otherwise it says how far the median still lags, and waits for the window
// to roll forward. Falls are left to the Treasury's trigger. With whenStale, a STALE pair that still disagrees is
// bought the same way (the rally's pause outlives the feeds' hour); a stale pair that agrees is never bought
// here, so this is no keep-alive clock (~24 IMD/day, rejected at launch).
async function keepAgreement({ dep, signer, asker, head, pool, seen, tasks, each }) {
  const d = cfg.DIVERGENCE;
  if (!d?.enabled) return;
  const price = seen.find((x) => x.f.role === "price");
  const spot = seen.find((x) => x.f.role === "spot");
  if (!price || !spot) return;
  const say = (m) => console.log(`agree   ${m}`);
  if (price.inFlight || spot.inFlight) return say("a price or spot request is in flight: wait for it");
  if (tasks.some((t) => t.what === "ask" && (t.f.role === "price" || t.f.role === "spot"))) return say("the Treasury is buying price/spot this run");
  if ((price.stale || spot.stale) && !d.whenStale) return say("price or spot is stale: out of scope (DIVERGENCE.whenStale is off)");
  if (price.value.isZero() || spot.value.isZero()) return;

  const skew = (await new Contract(dep.vault, VAULT_ABI, asker.provider).skew()).toNumber();
  const trigger = Math.max(0, skew - (d.earlyBps ?? 100));
  // Fresh pair: the gap between them is what pauses the vault. Stale pair: the vault is paused anyway, and what
  // matters is how far the market has run from the stored price (a quiet stale pair stays unbought: no clock).
  const stalePair = price.stale || spot.stale;
  const gap = stalePair ? gapBps(pool, price.value, price.value) : gapBps(spot.value, price.value, price.value);
  say(
    stalePair
      ? `stale pair: the market is ${(gap / 100).toFixed(2)}% from the stored price, acts from ${(trigger / 100).toFixed(2)}%`
      : `price ${price.value} vs spot ${spot.value}: ${(gap / 100).toFixed(2)}% apart, skew ${(skew / 100).toFixed(2)}%, acts from ${(trigger / 100).toFixed(2)}%`,
  );
  if (gap < trigger) return stalePair && say("stale, but the market is still near the stored price: not this rule's to buy");

  const win = windowOf(price.f.body.bytes);
  if (!win) return say("the price body names no window/samples: cannot project, nothing bought");
  let median;
  try {
    median = await projectMedian(d.archiveRpc ?? "https://eth.drpc.org", cfg.POOL, head.number, win);
  } catch (e) {
    return say(`cannot read the window's samples (${e.message.slice(0, 80)}): nothing bought`);
  }
  const target = Math.max(0, skew - (d.marginBps ?? 100));
  const keepSpot = gapBps(median, spot.value, median) <= target && spot.lifeLeft >= (d.minSpotLifeMinutes ?? 30) * 60;
  const withLive = gapBps(median, pool, median) <= target;
  say(`a fresh price would read the ${win.hours}h median ${median}: ${(gapBps(median, spot.value, median) / 100).toFixed(2)}% from the spot feed, ${(gapBps(median, pool, median) / 100).toFixed(2)}% from the live pool; needs <= ${(target / 100).toFixed(2)}%`);
  let rows;
  if (keepSpot) rows = [price];
  else if (withLive) rows = [price, spot];
  else return say("the median still lags: a purchase now would not reopen the vault. Waiting for the window to roll forward.");
  // Delivery is checked against each feed's epoch bound; a refused answer is charged in full.
  for (const [r, v] of [[price, median], [spot, pool]]) {
    if (!rows.includes(r)) continue;
    try { if (!(await r.feed.accepts(v))) return say(`${r.f.role} would refuse ${v} (epoch bound): nothing bought`); } catch { /* older feed */ }
  }
  say(`BUY ${rows.map((r) => r.f.role).join(" + ")} with the keeper's IMD: the projected answers reopen the vault`);
  if (!signer) return say("report only: nothing bought");
  await keeperBuys(dep, signer, asker, rows, each, { budgetImd: d.imdPerDay ?? 0, ledger: "agreement", label: "DIVERGENCE.imdPerDay" });
}

/** Buy `rows` with the keeper's own IMD in one transaction, within the shared daily budget. */
async function keeperBuys(dep, signer, asker, rows, each, { budgetImd = cfg.ASK_PAID_IMD_PER_DAY ?? 0, ledger = "spend", label = "ASK_PAID_IMD_PER_DAY" } = {}) {
  const budget = utils.parseEther(String(budgetImd));
  if (each.isZero()) { console.log("keep    the Intake is not selling updates: nothing bought."); return; }
  const need = each.mul(rows.length);
  if (budget.isZero()) { console.log(`keep    ${label} is 0: buying with the keeper's IMD is off.`); return; }
  if (spentToday(ledger).add(need).gt(budget)) {
    console.log(`keep    ${utils.formatEther(need)} IMD would exceed today's ${label} (${utils.formatEther(spentToday(ledger))} of ${utils.formatEther(budget)} spent).`);
    return;
  }
  const imd = new Contract(dep.imd, ERC20, signer);
  if ((await imd.balanceOf(signer.address)).lt(need)) { console.log(`keep    the keeper holds less than ${utils.formatEther(need)} IMD: top it up.`); return; }
  if ((await imd.allowance(signer.address, dep.asker)).lt(need)) {
    const a = await send(signer, "approve", () => imd.callStatic.approve(dep.asker, need), () => imd.approve(dep.asker, need), cfg);
    console.log(`approve ${describe(a)}`);
    if (!a.hash) return;
  }
  const feeds = rows.map((x) => x.f.address);
  const bodies = rows.map((x) => x.f.body.bytes);
  const r = await send(
    signer, `askPaidMany ${rows.map((x) => x.f.role).join("+")}`,
    () => asker.callStatic.askPaidMany(feeds, bodies, each),
    () => asker.askPaidMany(feeds, bodies, each), cfg,
  );
  console.log(`keep    ${rows.map((x) => x.f.role).join(" + ")}: ${describe(r)}`);
  if (r.hash) recordSpend(need, ledger);
}

main().catch((e) => {
  console.error("watcher failed:", e.message);
  process.exitCode = 1;
});
