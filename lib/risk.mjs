// Which loans are worth spending on.
//
// DUST. A bark pays the barker the chip, a tenth of the 20% bonus, so ~2% of the debt, and costs ~$0.30 of gas.
// Below RISK.minDebt imdUSD no liquidator will ever bite, so barking it only re-buys the same expired mark every
// hour (22 of the first 28 barks were three loans owing under 1 imdUSD). Dust is skipped everywhere.
//
// AT RISK. The Treasury buys a price after a fall only when a loan above the cutoff would sit within
// RISK.marginBps of `mat` at the POOL's price (a 1000 bps margin on mat 170% = under 187%). A fall that leaves every
// real loan well collateralised is not worth 0.5-1 IMD: borrowers who want the vault open can buy their own update.
//
// The estimate is the vault's collateral price scaled by how far the pool has moved from the price feed. It ignores
// an ETH/USD move since the last update, so it only decides whether to SPEND, never whether to bark.
import { BigNumber, Contract, utils } from "ethers";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { makerVault, discoverOwners, pricing } from "./vault.mjs";

const FEED_ABI = ["function latestValue() view returns (uint256,uint64)"];
const OWNERS_FILE = new URL("../state/owners.json", import.meta.url);
const OWNERS_MAX_AGE = 15 * 60; // the positions loop refreshes it every 5 minutes

/** Gap between the primary and the spot, in bps of the primary: the vault's own `_withinSkew` measure. */
export function pairGapBps(primary, spot) {
  if (primary.isZero()) return Infinity;
  const diff = primary.gt(spot) ? primary.sub(spot) : spot.sub(primary);
  return diff.mul(10_000).div(primary).toNumber();
}

/**
 * DIVERGENCE IS ALSO WORTH BUYING. While the primary and the spot are more than `skew` apart the
 * vault refuses to redeem, borrow, mark or liquidate (CDPVault._requirePriceAgreement), so the redemption floor under
 * the peg is gone exactly when the peg needs it. On 2026-10-16 the pool sat at $0.899 with the median 6.97% above the
 * spot and no loan near mat, so the at-risk rule bought nothing and redemption stayed shut. A fall is therefore also
 * bought when the pair disagrees past skew, even with every loan safe. Still falls only: the Treasury never pays for rises.
 */
export function pairDisagrees(primary, spot, skewBps) {
  if (primary.isZero() || spot.isZero()) return false;
  return pairGapBps(primary, spot) > skewBps;
}

export const riskCfg = (cfg) => ({ minDebt: cfg.RISK?.minDebt ?? 15, marginBps: cfg.RISK?.marginBps ?? 1000 });
export const minDebtWei = (cfg) => utils.parseEther(String(riskCfg(cfg).minDebt));
export const isDust = (debt, cfg) => debt.lt(minDebtWei(cfg));

/** Owners the positions loop discovered, so the watcher does not hit the indexer every minute. */
export function saveOwners(owners) {
  mkdirSync(new URL("../state/", import.meta.url), { recursive: true });
  writeFileSync(OWNERS_FILE, `${JSON.stringify({ at: Math.floor(Date.now() / 1000), owners })}\n`);
}

async function owners(dep, provider, cfg) {
  if (existsSync(OWNERS_FILE)) {
    const s = JSON.parse(readFileSync(OWNERS_FILE, "utf8"));
    if (Date.now() / 1000 - s.at < OWNERS_MAX_AGE) return s.owners;
  }
  const { owners: found } = await discoverOwners(cfg.INDEXER, dep.vault, {
    dialect: dep.dialect, apiKey: process.env.BLOCKSCOUT_API_KEY, provider, fromBlock: dep.block,
  });
  saveOwners(found);
  return found;
}

/**
 * Loans above the dust cutoff whose estimated CR at `pool` is under mat x (1 + margin).
 * Returns { atRisk: [{ owner, cr, debt }], threshold, checked }.
 */
export async function loansAtRisk({ dep, provider, cfg, pool }) {
  const { marginBps } = riskCfg(cfg);
  const vault = makerVault(dep.vault, provider, dep.dialect);
  const priceFeed = new Contract(dep.feeds.find((f) => f.role === "price").address, FEED_ABI, provider);
  const [mat, px, [last], list] = await Promise.all([vault.mat(), pricing(vault, provider), priceFeed.latestValue(), owners(dep, provider, cfg)]);
  if (last.isZero() || px.price.isZero()) throw new Error("the feeds hold no value to estimate from");
  const estimate = px.price.mul(pool).div(last);
  const threshold = mat.mul(10_000 + marginBps).div(10_000);
  const atRisk = [];
  let checked = 0;
  for (const owner of list) {
    const { collateral, debt } = await vault.positions(owner);
    if (debt.isZero() || isDust(debt, cfg)) continue;
    checked += 1;
    const cr = collateral.mul(estimate).mul(100).div(debt.mul(BigNumber.from(10).pow(18)));
    if (cr.lt(threshold)) atRisk.push({ owner, cr, debt });
  }
  return { atRisk, threshold, checked };
}
