#!/usr/bin/env node
// The CDP position watcher and liquidator.
//
// Reports by default. `--execute` barks and bites, and requires KEEPER_MNEMONIC in the environment;
// every transaction goes through lib/tx.mjs (kill switch, gas ceiling, ETH floor, simulate first).
//
// The vault speaks MakerDAO: `bark` marks a position below `mat`, its `lull` must pass, then `bite`
// repays its debt for collateral within the `tail`. See lib/vault.mjs for the two interfaces.
//
// BEING THE BARKER IS WORTH MONEY. `bite` pays the caller `seized - cut` when the caller also barked,
// and `seized - cut - chip` otherwise. So barking a position ourselves and biting it ourselves earns
// the chip on top; letting someone else bark it hands them the chip even if we do the biting.
// `barkFor(owner, beneficiary)` exists for exactly this.
//
// A STALE PRICE IS THE NORMAL STATE ON MAINNET, not an outage. Prices are bought on demand: the
// Treasury pays only when IMD's pool drifts (OracleAsker.ask), so a quiet market leaves the price feed
// stale and every bark and bite refused. When that happens this loop estimates every position at the
// pool's price, and if any would be under `mat` it may buy a fresh price and spot with the KEEPER'S
// OWN IMD (OracleAsker.askPaid), within ASK_PAID_IMD_PER_DAY. Off (0) by default.
import { readProvider } from "./lib/rpc.mjs";
import { providers, Contract, BigNumber, utils } from "ethers";
import { makerVault, discoverOwners, maxRepayable, payout, markWindow, pricing } from "./lib/vault.mjs";
import { loadDeployment } from "./lib/deployment.mjs";
import { readSpot } from "./lib/pool.mjs";
import { send, describe, keeperSigner } from "./lib/tx.mjs";
import { spentToday, recordSpend } from "./lib/spend.mjs";
import { isDust, saveOwners, riskCfg } from "./lib/risk.mjs";
import cfg from "./config.js";

const FEED_ABI = ["function latestValue() view returns (uint256,uint64)"];
const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];
const ASKER_ABI = [
  "function price() view returns (uint256)",
  "function askPaid(address feed, bytes body, uint256 maxPrice) returns (bytes32)",
];
const execute = process.argv.includes("--execute");
const wad = (x) => utils.formatUnits(x, 18);
const secs = (s) => (s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`);

async function main() {
  const dep = loadDeployment(cfg);
  const provider = readProvider(cfg);
  if (dep.chainId) {
    const { chainId } = await provider.getNetwork();
    if (chainId !== dep.chainId) throw new Error(`the read RPC is chain ${chainId}, the deployment is chain ${dep.chainId}`);
  }
  const vault = makerVault(dep.vault, provider, dep.dialect);
  const now = (await provider.getBlock("latest")).timestamp;

  const [mat, lull, tail, chipBps, cutBps, chop, stableAddr] = await Promise.all([
    vault.mat(), vault.lull(), vault.tail(), vault.chip(), vault.cut(), vault.chop(), vault.stablecoin(),
  ]).catch((e) => {
    const other = dep.dialect === "maker" ? "legacy" : "maker";
    throw new Error(`the vault did not answer its ${dep.dialect}-interface reads (${e.code ?? e.message.slice(0, 60)}). ` +
      `If it was deployed ${dep.dialect === "maker" ? "before" : "after"} protocol commit 892a055, set VAULT_INTERFACE: "${other}".`);
  });
  const px = await pricing(vault, provider);

  console.log(`vault   ${dep.vault}  (${dep.dialect} interface)`);
  console.log(`risk    mat ${mat}%  lull ${secs(Number(lull))}  tail ${secs(Number(tail))}  bonus ${chop}%`);
  console.log(`split   chip ${chipBps}bps to the barker  cut ${cutBps}bps to the protocol, of the bonus`);
  console.log(`price   ${px.price.toString()} per 1e18 raw collateral${px.stale ? `  *** STALE: ${px.why.join(", ") || "no value"} ***` : ""}`);

  let signer = null;
  let inventory = null;
  if (execute) {
    signer = keeperSigner(provider, cfg);
    const stable = new Contract(stableAddr, ERC20, provider);
    const [bal, eth] = await Promise.all([stable.balanceOf(signer.address), provider.getBalance(signer.address)]);
    console.log(`keeper  ${signer.address}  ${wad(eth)} ETH  ${wad(bal)} imdUSD inventory`);
    inventory = bal;
    // bite burns the CALLER's imdUSD. Inventory is working capital, not an expense.
    if (bal.isZero()) console.log(`        WARNING: no imdUSD. bite() burns the caller's, so nothing can be bitten.`);
  }

  // From an indexer, not eth_getLogs — see lib/vault.mjs for the measurement that forced this.
  const { owners, logsSeen } = await discoverOwners(cfg.INDEXER, dep.vault, {
    dialect: dep.dialect, apiKey: process.env.BLOCKSCOUT_API_KEY, provider, fromBlock: dep.block,
  });
  console.log(`\nowners  ${owners.length} from ${logsSeen} indexed logs`);
  saveOwners(owners); // the watcher's at-risk check reads it (lib/risk.mjs)

  // Dust (under RISK.minDebt) is never barked or bitten and never bought a price for: lib/risk.mjs.
  const rows = [];
  const dust = [];
  for (const owner of owners) {
    const pos = await vault.positions(owner);
    if (pos.debt.isZero()) continue;
    if (isDust(pos.debt, cfg)) { dust.push({ owner, pos }); continue; }
    rows.push({ owner, pos, mark: await vault.liquidationMarks(owner) });
  }
  console.log(`        ${rows.length + dust.length} with debt outstanding, ${dust.length} of them dust (under ${riskCfg(cfg).minDebt} imdUSD): left alone`);
  for (const d of dust) console.log(`        dust    ${d.owner}  debt ${wad(d.pos.debt)}`);
  console.log();

  if (px.stale) {
    await whilePricingIsStale(dep, provider, rows, mat, px, signer);
    return;
  }

  for (const r of rows) r.cr = await vault.collateralRatio(r.owner);
  rows.sort((a, b) => (a.cr.lt(b.cr) ? -1 : 1));

  for (const r of rows) {
    const win = markWindow(r.mark, tail, now);
    const crText = r.cr.gt(BigNumber.from(10).pow(9)) ? "inf" : `${r.cr}%`;
    console.log(`${r.owner}  CR ${crText}  collateral ${wad(r.pos.collateral)}  debt ${wad(r.pos.debt)}`);

    if (r.cr.gte(mat) && win.state === "unmarked") { console.log(`   healthy, unbarked — nothing to do\n`); continue; }
    if (r.cr.gte(mat)) { console.log(`   healthy but still barked — heel(${r.owner}) clears it; so does the borrower's next lock or wipe\n`); continue; }

    // bite burns OUR imdUSD, so a bite larger than the inventory reverts. Take what we can cover; the
    // rest stays biteable for us (with more inventory) or anyone else inside the tail.
    let repay = maxRepayable(r.pos, px.price, chop);
    if (inventory && repay.gt(inventory)) {
      console.log(`   inventory ${wad(inventory)} imdUSD covers only part of ${wad(repay)}: biting that much`);
      repay = inventory;
    }
    const asMarker = r.mark.marked && signer && r.mark.marker.toLowerCase() === signer.address.toLowerCase();
    const p = payout(r.pos, px.price, repay, { chipBps, cutBps, chop, weAreMarker: !!asMarker });
    console.log(`   UNDERWATER (CR ${crText} < mat ${mat}%)  max repay ${wad(repay)} imdUSD`);
    if (p) {
      console.log(`   payout  seized ${wad(p.seized)}  bonus ${wad(p.bonus)}  ours ${wad(p.toUs)} (collateral raw units / 1e18)`);
      if (!p.swept.isZero()) console.log(`   sweep   ${wad(p.swept)} of unreachable dust folded into the seizure`);
      if (!asMarker) console.log(`   note    barking it ourselves would add the chip, ${wad(p.markerCut)} — bark first`);
    }

    if (win.state === "unmarked") console.log(`   ACT     barkFor(${r.owner}, <us>)  then wait the lull, ${secs(Number(lull))}`);
    else if (win.state === "grace") console.log(`   WAIT    lull ends in ${secs(win.secondsToOpen)}, barked by ${r.mark.marker}`);
    else if (win.state === "actionable") console.log(`   ACT     bite(${r.owner}, ${repay.toString()})  — ${secs(win.secondsLeft)} left in the tail`);
    else console.log(`   ACT     bark EXPIRED past its tail — bark again before it can be bitten`);

    if (execute && signer) {
      const live = vault.connect(signer);
      let res = null;
      if (win.state === "unmarked" || win.state === "expired") {
        res = await send(signer, "bark", () => live.sim.barkFor(r.owner, signer.address), () => live.barkFor(r.owner, signer.address), cfg);
      } else if (win.state === "actionable" && !repay.isZero()) {
        res = await send(signer, "bite", () => live.sim.bite(r.owner, repay), () => live.bite(r.owner, repay), cfg);
      }
      if (res) console.log(`   ${describe(res)}`);
      if (res?.hash && win.state === "actionable") inventory = inventory.sub(repay);
    }
    console.log();
  }

  if (!execute) console.log("report only. Add --execute (with KEEPER_MNEMONIC) to bark and bite.");
}

/**
 * Nothing can be barked or bitten. Say so, estimate who would be under `mat` at the pool's price, and
 * — only with --execute and a nonzero ASK_PAID_IMD_PER_DAY — buy a fresh price and spot ourselves.
 */
async function whilePricingIsStale(dep, provider, rows, mat, px, signer) {
  console.log(`BLOCKED: pricing is stale (${px.why.join(", ") || "no value yet"}), so bark and bite revert for every position.`);
  if (rows.length === 0) { console.log(`         No position has debt, so nothing is waiting on a price.`); return; }

  // ESTIMATE, not the vault's figure: the last collateral price scaled by how far IMD's pool has moved
  // from the price feed's last value. It ignores any ETH/USD move since, which is why it only decides
  // whether to SPEND on a real price — never whether to bark.
  const priceFeed = new Contract(dep.feeds.find((f) => f.role === "price").address, FEED_ABI, provider);
  const [[last]] = await Promise.all([priceFeed.latestValue()]);
  const mainnet = new providers.JsonRpcProvider(cfg.MAINNET_RPC_URL);
  const { spot } = await readSpot(mainnet, cfg.POOL);
  if (last.isZero() || px.price.isZero()) {
    console.log(`         The feeds have never held a value, so nothing can be estimated. Seed them (runbook section 7).`);
    return;
  }
  const estimate = px.price.mul(spot).div(last);
  console.log(`         pool says IMD moved ${(spot.sub(last).mul(10_000).div(last).toNumber() / 100).toFixed(2)}% since the last price;`);
  let atRisk = 0;
  for (const r of rows) {
    const cr = r.pos.collateral.mul(estimate).mul(100).div(r.pos.debt.mul(BigNumber.from(10).pow(18)));
    if (cr.lt(mat)) {
      atRisk += 1;
      console.log(`         ${r.owner} would be at ~${cr}% < mat ${mat}% at the pool's price`);
    }
  }
  if (atRisk === 0) { console.log(`         no position would be under mat at the pool's price: nothing worth paying for.`); return; }

  const budget = utils.parseEther(String(cfg.ASK_PAID_IMD_PER_DAY ?? 0));
  if (!dep.asker || budget.isZero()) {
    console.log(`         ${atRisk} at risk. Buying a price ourselves is off (ASK_PAID_IMD_PER_DAY = 0, or no asker).`);
    return;
  }
  if (!signer) { console.log(`         ${atRisk} at risk; with --execute this would buy a price and a spot update.`); return; }

  const asker = new Contract(dep.asker, ASKER_ABI, signer);
  const imd = new Contract(dep.imd, ERC20, signer);
  const each = await asker.price();
  const need = each.mul(2);
  if (spentToday().add(need).gt(budget)) {
    console.log(`         ${atRisk} at risk, but ${wad(need)} IMD would exceed today's ASK_PAID budget (${wad(spentToday())} of ${wad(budget)} spent).`);
    return;
  }
  // The vault needs BOTH the price and the spot fresh, and within skew of each other: one alone buys nothing.
  for (const role of ["price", "spot"]) {
    const f = dep.feeds.find((x) => x.role === role);
    if ((await imd.allowance(signer.address, dep.asker)).lt(each)) {
      const a = await send(signer, "approve", () => imd.callStatic.approve(dep.asker, each), () => imd.approve(dep.asker, each), cfg);
      console.log(`         approve ${describe(a)}`);
      if (!a.hash) return;
    }
    const res = await send(
      signer, `askPaid ${role}`,
      () => asker.callStatic.askPaid(f.address, f.body.bytes, each),
      () => asker.askPaid(f.address, f.body.bytes, each), cfg,
    );
    console.log(`         askPaid ${role}: ${describe(res)}`);
    if (res.hash) recordSpend(each);
  }
}

main().catch((e) => { console.error("positions failed:", e.message); process.exitCode = 1; });
