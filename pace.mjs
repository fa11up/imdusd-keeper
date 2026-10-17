#!/usr/bin/env node
// The pacer: the vault's paced figures and every position's collateral term, kept current.
//
// Reports by default. `--execute` paces and re-prices, and requires KEEPER_MNEMONIC in the environment;
// every transaction goes through lib/tx.mjs (kill switch, gas ceiling, ETH floor, simulate first).
//
// TWO DUTIES, BOTH PERMISSIONLESS, NEITHER DONE BY ANYONE ELSE. Since protocol d3861ac the vault PACES
// what a redemption is paid against (backing per imdUSD), the fee base, the debt the work ceiling counts
// and, since 92b873b, the price a redemption is paid at: each moves at most one PACE_INTERVAL per pacing
// and only when someone paces, so a recovery after a fall reaches redeemers only while the vault is paced.
// Every call that moves capital paces first; through a quiet spell nobody does, and `pace()` is the call
// that does nothing else. And a position's collateral term is fixed at the price it was last touched at
// (`securedCollateral`): after a fall an idle debt-bound term reads low, after a recovery a term fixed at
// the low reads high, and until `resecure(owner)` existed only the owner, a redemption or a liquidation
// corrected it. The keeper re-prices every affected term after a price move, so no stale term outlives
// the move.
import { readProvider } from "./lib/rpc.mjs";
import { providers, Contract, BigNumber, utils } from "ethers";
import { makerVault, discoverOwners } from "./lib/vault.mjs";
import { loadDeployment } from "./lib/deployment.mjs";
import { send, describe, keeperSigner } from "./lib/tx.mjs";
import cfg from "./config.js";

const FEED_ABI = ["function latestValue() view returns (uint256,uint64)", "function isStale() view returns (bool)"];
/** CDPVault `_positions` (mapping slot 14); Position = collateral, debt, recentlyMinted, mintedAt, secured (+0..+4). */
const POSITIONS_SLOT = 14;
const WAD = BigNumber.from(10).pow(18);
const execute = process.argv.includes("--execute");
const wad = (x) => utils.formatUnits(x, 18);
const secs = (s) => (s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`);



/** CDPVault._priceAgrees, read: fresh price and NHI feeds, and a fresh spot within skew() of the primary. */
async function priceAgrees(vault, provider) {
  const [priceAddr, nhiAddr, spotAddr, skew] = await Promise.all([
    vault.priceFeed(), vault.nhiFeed(), vault.spotFeed(), vault.skew(),
  ]);
  const [p, n, s] = [priceAddr, nhiAddr, spotAddr].map((a) => new Contract(a, FEED_ABI, provider));
  const [pStale, nStale, sStale, [primary], [spot]] = await Promise.all([
    p.isStale(), n.isStale(), s.isStale(), p.latestValue(), s.latestValue(),
  ]);
  if (pStale || nStale || sStale || primary.isZero() || spot.isZero()) return false;
  return primary.sub(spot).abs().lte(primary.mul(skew).div(10_000));
}

async function main() {
  const dep = loadDeployment(cfg);
  if (dep.dialect !== "maker") throw new Error("the pacer needs a vault with paced figures (protocol d3861ac or later, maker interface)");
  const provider = readProvider(cfg);
  if (dep.chainId) {
    const { chainId } = await provider.getNetwork();
    if (chainId !== dep.chainId) throw new Error(`the read RPC is chain ${chainId}, the deployment is chain ${dep.chainId}`);
  }
  const vault = makerVault(dep.vault, provider, dep.dialect);
  const now = (await provider.getBlock("latest")).timestamp;
  const [pacedResult, interval, collAddr] = await Promise.all([vault.paced(), vault.paceInterval(), vault.collateralPriceFeed()]);
  // By index: ethers names a tuple's outputs on the result array, except one that collides with an array
  // method, and `at` is one (Array.prototype.at).
  const [pacedBacking, pacedSupply, pacedDebt, pacedAt, backingAt, pacedPrice] = pacedResult;
  const feed = new Contract(collAddr, FEED_ABI, provider);
  const [[price, priceAt], stale] = await Promise.all([feed.latestValue(), feed.isStale()]);

  const sinceAt = now - pacedAt.toNumber();
  const sinceBacking = now - backingAt.toNumber();
  console.log(`vault   ${dep.vault}`);
  console.log(`paced   backing ${wad(pacedBacking)}  supply ${wad(pacedSupply)}  debt ${wad(pacedDebt)}  payout price ${pacedPrice.toString()}`);
  console.log(`clocks  supply and debt paced ${secs(sinceAt)} ago, backing ${secs(sinceBacking)} ago; interval ${secs(Number(interval))}`);
  console.log(`price   ${price.toString()} per 1e18 raw collateral, updated ${secs(now - Number(priceAt))} ago${stale ? "  *** STALE ***" : ""}`);

  let signer = null;
  if (execute) {
    signer = keeperSigner(provider, cfg);
  }
  const live = signer ? vault.connect(signer) : null;

  // 1. pace(), only when a pacing would move a figure redeemers are paid by, and only once its clock is due.
  //    The vault paces itself inside every draw, repay and redemption, so this is for quiet spells only, and
  //    elapsed time counts at most one interval between pacings. Pacing every hour regardless cost ~24
  //    transactions a day while the paced figures already matched the live ones (mainnet, 2026-10-12):
  //    - backing (backing clock): a recovery below par that has not reached redeemers yet;
  //    - payout price (backing clock): the paced price still above the feed by more than priceGapBps; it falls
  //      at most 1% an hour, and redeemers are paid at the higher of the two;
  //    - supply, the redemption fee base (supply clock): off the live supply by more than supplyLagBps.
  //    The backing clock moves only at a USABLE price (CDPVault._pace: fresh price and NHI feeds, a fresh spot
  //    within skew() of the primary); pacing for it at an unusable price paid for a clock it cannot move.
  const P = cfg.PACE ?? {};
  const margin = P.marginSeconds ?? 300;
  const atDue = sinceAt + margin >= Number(interval);
  const backingDue = sinceBacking + margin >= Number(interval);
  const stable = new Contract(await vault.stablecoin(), ["function totalSupply() view returns (uint256)"], provider);
  const [liveBacking, liveSupply] = await Promise.all([vault.backingPerUnit(), stable.totalSupply()]);
  const gap = (a, b) => (b.isZero() ? 0 : Number(a.sub(b).abs().mul(10_000).div(b)));
  const backingWork = pacedBacking.lt(WAD) && liveBacking.gt(pacedBacking) && gap(liveBacking, pacedBacking) > (P.backingGapBps ?? 10);
  const priceWork = !price.isZero() && pacedPrice.gt(price) && gap(pacedPrice, price) > (P.priceGapBps ?? 100);
  const supplyWork = gap(pacedSupply, liveSupply) > (P.supplyLagBps ?? 500);
  const clockWork = backingDue && (backingWork || priceWork) ? await priceAgrees(vault, provider) : false;
  const why = [
    clockWork && backingWork && `backing ${wad(pacedBacking)} -> ${wad(liveBacking)}`,
    clockWork && priceWork && `payout price ${(gap(pacedPrice, price) / 100).toFixed(2)}% above the feed`,
    atDue && supplyWork && `fee base ${(gap(pacedSupply, liveSupply) / 100).toFixed(2)}% off the supply`,
  ].filter(Boolean);
  if (why.length) {
    console.log(`ACT     pace()  — ${why.join("; ")}`);
    if (live) {
      const res = await send(signer, "pace", () => live.sim.pace(), () => live.pace(), cfg);
      console.log(`        ${describe(res)}`);
    }
  } else if ((backingWork || priceWork) && backingDue && !clockWork) {
    console.log(`        pace() would not move ${backingWork ? "backing" : `the payout price (${(gap(pacedPrice, price) / 100).toFixed(2)}% above the feed)`} yet: the vault moves it only at a usable price (price and NHI fresh, spot fresh and within skew); waiting`);
  } else {
    console.log(`        pace() not needed: paced figures match (backing ${wad(pacedBacking)}, payout price ${(gap(pacedPrice, price) / 100).toFixed(2)}% from the feed, fee base ${(gap(pacedSupply, liveSupply) / 100).toFixed(2)}% from the supply)`);
  }

  // 2. resecure(owner) for every term the price move touched.
  if (stale || price.isZero()) {
    console.log(`        re-price: pricing is stale, so resecure() would revert; waiting for an update`);
    if (!execute) console.log("report only. Add --execute (with KEEPER_MNEMONIC) to pace and re-price.");
    return;
  }
  // WHEN A RE-PRICE CHANGES ANYTHING (mainnet review 2026-10-11). The terms feed one figure: the vault counts its
  // secured collateral as backing only up to (debt - bad debt) x mat (CDPVault._securedCollateralValue). With
  // positions near 200% the terms sum to about twice the debt in value, past that cap, so the figure is the cap
  // whatever each term says: 37 re-prices on launch day (two thirds of the keeper's gas) moved it by nothing. So
  // compare the figure as the stored terms give it with the figure re-priced terms would give, and re-price only
  // when they differ by more than PACE.resecureToleranceBps (0.5%), largest discrepancy first, until they agree.
  const { owners, logsSeen } = await discoverOwners(cfg.INDEXER, dep.vault, {
    dialect: dep.dialect, apiKey: process.env.BLOCKSCOUT_API_KEY, provider, fromBlock: dep.block,
  });
  const raw = new Contract(dep.vault, ["function totalDebt() view returns (uint256)", "function totalBadDebt() view returns (uint256)", "function mat() view returns (uint256)"], provider);
  const [totalDebt, badDebt, mat] = await Promise.all([raw.totalDebt(), raw.totalBadDebt(), raw.mat()]);
  const rows = [];
  for (const owner of owners) {
    const base = BigNumber.from(utils.keccak256(utils.defaultAbiCoder.encode(["address", "uint256"], [owner, POSITIONS_SLOT])));
    const [coll, debt, stored] = await Promise.all([0, 1, 4].map((i) => provider.getStorageAt(dep.vault, base.add(i).toHexString()).then(BigNumber.from)));
    if (debt.isZero()) continue;
    // CDPVault._secured: min(collateral, principal x 2e18 / price).
    const fresh = debt.mul(WAD).mul(2).div(price);
    const term = coll.lt(fresh) ? coll : fresh;
    rows.push({ owner, debt, stored, term });
  }
  const sum = (k) => rows.reduce((a, r) => a.add(r[k]), BigNumber.from(0));
  const prior = totalDebt.gt(badDebt) ? totalDebt.sub(badDebt) : BigNumber.from(0);
  const cap = prior.mul(mat).div(100);
  const figure = (units) => { const v = units.mul(price).div(WAD); return v.gt(cap) ? cap : v; };
  const figStored = figure(sum("stored")), figTrue = figure(sum("term"));
  const tol = cfg.PACE?.resecureToleranceBps ?? 50;
  const off = figTrue.isZero() ? 0 : figStored.sub(figTrue).abs().mul(10_000).div(figTrue).toNumber();
  console.log(`owners  ${owners.length} from ${logsSeen} logs, ${rows.length} with debt`);
  console.log(`        backing from terms: stored ${wad(figStored)} vs re-priced ${wad(figTrue)} (cap ${wad(cap)}): ${(off / 100).toFixed(2)}% apart, tolerance ${(tol / 100).toFixed(2)}%`);
  if (off <= tol) {
    console.log(`        re-price: nothing to do (the figure would not move)`);
    if (!execute) console.log("report only. Add --execute (with KEEPER_MNEMONIC) to pace and re-price.");
    return;
  }
  // Largest |stored - term| first, until the figure from the terms is within tolerance.
  rows.sort((a, b) => (a.stored.sub(a.term).abs().gt(b.stored.sub(b.term).abs()) ? -1 : 1));
  const cap_ = cfg.PACE?.resecureMaxPerRun ?? 20;
  let units = sum("stored");
  let sent = 0;
  for (const r of rows.slice(0, cap_)) {
    if (r.stored.eq(r.term)) break;
    console.log(`ACT     resecure(${r.owner})  debt ${wad(r.debt)}  term ${r.stored.toString()} -> ${r.term.toString()}`);
    if (live) {
      const res = await send(signer, "resecure", () => live.sim.resecure(r.owner), () => live.resecure(r.owner), cfg);
      console.log(`        ${describe(res)}`);
      if (!res.hash) break;
      sent += 1;
    }
    units = units.sub(r.stored).add(r.term);
    const now_ = figure(units);
    if (now_.sub(figTrue).abs().mul(10_000).lte(figTrue.mul(tol))) break;
  }
  if (execute) console.log(`        re-priced ${sent}`);
  if (!execute) console.log("report only. Add --execute (with KEEPER_MNEMONIC) to pace and re-price.");
}

main().catch((e) => { console.error("pace failed:", e.message); process.exitCode = 1; });
