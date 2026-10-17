// Position discovery and the liquidation economics, computed the way CDPVault computes them.
//
// The arithmetic below is a transcription of `bite`, not an estimate. A liquidator that rounds
// differently either leaves money behind or sends a reverting transaction, and both are worse than
// not bidding. Every `mulDiv` here floors, as Solidity's does.
import { BigNumber, Contract, utils } from "ethers";

/**
 * The vault speaks MakerDAO (lock, draw, bark, bite, mat, lull, tail, chip, cut; see the protocol's
 * docs/NAMING.md). Deployments made before that rename expose the same functions under their old
 * names, so the keeper keeps one table per interface and speaks only the new vocabulary itself.
 *
 *   "maker"  — every deployment from protocol commit 892a055 on, and mainnet.
 *   "legacy" — anything deployed earlier, including Sepolia launch 688.
 *
 * Choose with VAULT_INTERFACE in config.js. A mismatch fails loudly on the first read (the function
 * does not exist), never silently.
 */
export const INTERFACES = {
  maker: {
    mat: "mat", lull: "lull", tail: "tail", chip: "chip", cut: "cut", stablecoin: "stablecoin", gem: "gem",
    barkFor: "barkFor", bite: "bite", heel: "heel", chop: "CHOP_PERCENT",
    ownerEvents: ["Lock", "Draw", "Earn"],
  },
  legacy: {
    mat: "minCR", lull: "gracePeriod", tail: "liquidationWindow", chip: "markerShareBps",
    cut: "protocolBonusShareBps", stablecoin: "compToken", gem: "imdToken",
    barkFor: "markUnderwaterFor", bite: "liquidate", heel: "clearRecoveredMark", chop: "LIQUIDATION_BONUS_PERCENT",
    ownerEvents: ["CollateralDeposited", "COMPMinted", "WorkMinted"],
  },
};

function names(dialect) {
  const n = INTERFACES[dialect];
  if (!n) throw new Error(`VAULT_INTERFACE must be "maker" or "legacy", not ${JSON.stringify(dialect)}`);
  return n;
}

export function vaultAbi(dialect) {
  const n = names(dialect);
  return [
    "function positions(address) view returns (uint256 collateral, uint256 debt)",
    "function collateralRatio(address) view returns (uint256)",
    "function liquidationMarks(address) view returns (uint256 markedAt, uint256 grace, bool marked, address marker)",
    `function ${n.mat}() view returns (uint256)`,
    `function ${n.lull}() view returns (uint256)`,
    `function ${n.tail}() view returns (uint256)`,
    `function ${n.chip}() view returns (uint256)`,
    `function ${n.cut}() view returns (uint256)`,
    "function totalDebt() view returns (uint256)",
    `function ${n.gem}() view returns (address)`,
    `function ${n.stablecoin}() view returns (address)`,
    "function priceFeed() view returns (address)",
    "function nhiFeed() view returns (address)",
    "function spotFeed() view returns (address)",
    "function skew() view returns (uint256)",
    "function collateralPriceFeed() view returns (address)",
    `function ${n.chop}() view returns (uint256)`,
    `function ${n.barkFor}(address owner, address beneficiary)`,
    `function ${n.bite}(address owner, uint256 debtToRepay)`,
    `function ${n.heel}(address owner)`,
    // The paced figures (protocol d3861ac and later, maker interface only): what a redemption is paid against
    // moves at a bounded rate, and only while someone paces; a position's collateral term is fixed at the price
    // it was last touched at until someone re-prices it. The pacer loop (pace.mjs) does both.
    "function pace()",
    "function resecure(address owner)",
    "function paced() view returns (uint256 backing, uint256 supply, uint256 debt, uint256 at, uint256 backingAt, uint256 price)",
    "function PACE_INTERVAL() view returns (uint256)",
    "function payoutPrice() view returns (uint256)",
    "function backingPerUnit() view returns (uint256)",
    ...n.ownerEvents.map((e) => `event ${e}(address indexed account, uint256 amount)`),
  ];
}

/**
 * The vault in Maker's words whatever its deployed names: `v.mat()`, `v.barkFor(...)`, `v.bite(...)`.
 * `v.sim` holds the same writes as callStatic, so every transaction can be simulated first.
 */
export function makerVault(address, providerOrSigner, dialect) {
  const n = names(dialect);
  const c = new Contract(address, vaultAbi(dialect), providerOrSigner);
  const read = (k) => () => c[n[k]]();
  const write = (k, via = c) => (...args) => via[n[k]](...args);
  return {
    address,
    raw: c,
    mat: read("mat"), lull: read("lull"), tail: read("tail"), chip: read("chip"), cut: read("cut"),
    stablecoin: read("stablecoin"),
    gem: read("gem"), chop: read("chop"), priceFeed: () => c.priceFeed(), totalDebt: () => c.totalDebt(),
    nhiFeed: () => c.nhiFeed(), spotFeed: () => c.spotFeed(), skew: () => c.skew(),
    // The feed `_price()` reads. A ParameterizedVault prices its collateral in USD per 1e18 RAW units
    // through `collateralPriceFeed` (sIMD: the share price over IMD/USD); older vaults read `priceFeed`
    // directly. Reading the IMD/ETH feed for an sIMD vault would price collateral in the wrong unit.
    collateralPriceFeed: () => c.collateralPriceFeed().catch(() => c.priceFeed()),
    positions: (o) => c.positions(o), collateralRatio: (o) => c.collateralRatio(o),
    liquidationMarks: (o) => c.liquidationMarks(o),
    barkFor: write("barkFor"), bite: write("bite"), heel: write("heel"),
    pace: () => c.pace(), resecure: (o) => c.resecure(o),
    paced: () => c.paced(), paceInterval: () => c.PACE_INTERVAL(), payoutPrice: () => c.payoutPrice(),
    backingPerUnit: () => c.backingPerUnit(),
    sim: {
      barkFor: write("barkFor", c.callStatic), bite: write("bite", c.callStatic), heel: write("heel", c.callStatic),
      pace: () => c.callStatic.pace(), resecure: (o) => c.callStatic.resecure(o),
    },
    connect: (signer) => makerVault(address, signer, dialect),
  };
}

const WAD = BigNumber.from(10).pow(18);
const FEED_ABI = ["function latestValue() view returns (uint256,uint64)", "function isStale() view returns (bool)"];

/** (100 + CHOP_PERCENT) * 1e16, as the contract spells it. Read from the vault, never assumed: the
 * first deployments paid 10%, mainnet pays 20%, and a keeper quoting the wrong one mis-sizes every bite. */
export const payoutScale = (chop) => BigNumber.from(100).add(chop).mul(BigNumber.from(10).pow(16));

/**
 * The price `bite` will use, and whether `bite` would refuse for staleness first. Mirrors
 * `_requireFreshFeeds`: the price feed, NHI and (on a ParameterizedVault) the collateral price feed,
 * which is itself stale whenever its IMD/ETH or ETH/USD leg is. The skew check against the spot
 * feed (`_requirePriceAgreement`) is not modelled; a bite refused for it is caught by simulation.
 */
export async function pricing(vault, provider) {
  const [priceAddr, nhiAddr, collAddr] = await Promise.all([vault.priceFeed(), vault.nhiFeed(), vault.collateralPriceFeed()]);
  const feed = (a) => new Contract(a, FEED_ABI, provider);
  const [[price], collStale, priceStale, nhiStale] = await Promise.all([
    feed(collAddr).latestValue(), feed(collAddr).isStale(), feed(priceAddr).isStale(), feed(nhiAddr).isStale(),
  ]);
  const why = [];
  if (priceStale) why.push("price feed stale");
  if (nhiStale) why.push("NHI feed stale");
  if (collStale && collAddr.toLowerCase() !== priceAddr.toLowerCase()) why.push("collateral price stale (IMD/ETH or ETH/USD leg)");
  return { price, stale: why.length > 0 || price.isZero(), why, collateralPriceFeed: collAddr };
}

/**
 * The three events that can create an obligation (lock, draw, earn), keyed by topic0. Read by topic
 * rather than by decoded name, because an indexer may label the indexed parameter differently from
 * our own ABI; topic1 is the account either way. Derived from the interface, never hard-coded, so a
 * renamed event cannot silently drop out of discovery.
 */
export function ownerTopics(dialect) {
  return Object.fromEntries(
    names(dialect).ownerEvents.map((e) => [utils.id(`${e}(address,uint256)`).toLowerCase(), e]),
  );
}

/**
 * Owners who have ever held a position, from an indexer rather than from eth_getLogs.
 *
 * WHY NOT THE RPC. Positions live in a mapping with no on-chain enumeration, so events are the only
 * index there is — and public RPCs are an unsound source for them. Measured against this vault on
 * 2026-10-04: a 50,000-block span returned the one real depositor while a 40,669-block span *inside
 * the same range* returned nothing, with no error either time. The node also caps ranges at 50,000
 * (-32701) and is not an archive node, so eth_getCode on a historical block fails outright. An empty
 * array from such a node is indistinguishable from "there are no positions", which for a liquidator
 * means silently doing nothing while a position rots.
 *
 * Blockscout returns the whole decoded history, paginated and deterministic, and is what this
 * repository already mandates for any historical log work.
 */
export async function discoverOwners(indexerBase, address, { dialect = "maker", fetchImpl = fetch, maxPages = 20, apiKey, provider, fromBlock } = {}) {
  const topics = ownerTopics(dialect);
  if (indexerBase === "rpc") return discoverOwnersFromNode(provider, address, topics, fromBlock);
  const owners = new Map(); // owner -> the events that named it, for the log
  let params = null;
  let pages = 0;
  let total = 0;

  while (pages < maxPages) {
    const url = new URL(`${indexerBase.replace(/\/$/, "")}/api/v2/addresses/${address}/logs`);
    if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const res = await fetchImpl(url, {
      // Mainnet Blockscout (eth.blockscout.com) answers a bare request with Cloudflare 1010: it wants a
      // real User-Agent and, past its anonymous quota, an x-api-key (BLOCKSCOUT_API_KEY).
      headers: {
        accept: "application/json",
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
        ...(apiKey ? { "x-api-key": apiKey } : {}),
      },
    });
    if (!res.ok) throw new Error(`indexer returned ${res.status} for ${url.pathname}`);
    const body = await res.json();
    const items = body.items ?? [];
    total += items.length;
    for (const it of items) {
      const [t0, t1] = it.topics ?? [];
      const name = topics[(t0 ?? "").toLowerCase()];
      if (!name || !t1) continue;
      const owner = `0x${t1.slice(-40)}`;
      owners.set(owner, (owners.get(owner) ?? new Set()).add(name));
    }
    params = body.next_page_params;
    pages += 1;
    if (!params) break;
  }

  // An empty history is a real answer only if the indexer answered at all. Zero logs from a contract
  // that must at least have emitted OracleSet in its constructor means the source is wrong.
  if (total === 0) throw new Error("indexer returned no logs at all for this address, which cannot be right: treat as a source failure, not an empty vault");
  return { owners: [...owners.keys()], evidence: owners, logsSeen: total, pages };
}

/**
 * LOCAL FORKS ONLY (INDEXER: "rpc"). eth_getLogs straight from the node, from the deployment block.
 * Sound against an anvil fork you are driving yourself, where the node holds every block it mined;
 * UNSOUND against a public node, which can return an empty array for a range it declined to search
 * (the measurement above). Refuses without a starting block rather than scanning from genesis.
 */
async function discoverOwnersFromNode(provider, address, topics, fromBlock) {
  if (!provider || fromBlock == null) throw new Error('INDEXER "rpc" needs the provider and the deployment block');
  const logs = await provider.getLogs({ address, fromBlock, toBlock: "latest" });
  if (logs.length === 0) throw new Error("the node returned no logs at all for the vault: treat as a source failure");
  const owners = new Map();
  for (const l of logs) {
    const name = topics[l.topics[0].toLowerCase()];
    if (!name || !l.topics[1]) continue;
    const owner = `0x${l.topics[1].slice(-40)}`;
    owners.set(owner, (owners.get(owner) ?? new Set()).add(name));
  }
  return { owners: [...owners.keys()], evidence: owners, logsSeen: logs.length, pages: 1 };
}

/** The largest `debtToRepay` the contract will accept: bounded by the debt and by the collateral.
 * When the collateral left is below the seizure for ONE wei of debt, bite takes it whole for any
 * repayment, so a single wei is the efficient bite (it drains the dust and records the bad debt). */
export function maxRepayable({ collateral, debt }, price, chop) {
  if (price.isZero() || collateral.isZero()) return BigNumber.from(0);
  const scale = payoutScale(chop);
  // collateralSeized = debtToRepay * scale / price must be <= collateral.
  const byCollateral = collateral.mul(price).div(scale);
  if (byCollateral.isZero()) return BigNumber.from(debt.isZero() ? 0 : 1);
  return byCollateral.lt(debt) ? byCollateral : debt;
}

/**
 * What biting `debtToRepay` pays, split exactly as `bite` splits it: `chip` to the barker, `cut` to
 * the protocol. `weAreMarker` is worth the chip, and is the reason to bark a position oneself.
 */
export function payout({ collateral, debt }, price, debtToRepay, { chipBps, cutBps, chop, weAreMarker }) {
  const scale = payoutScale(chop);
  const oneWeiSeizure = scale.div(price);
  let seizedBase = debtToRepay.mul(scale).div(price);
  if (seizedBase.gt(collateral)) {
    // Dust below one wei of debt is taken whole; any larger shortfall reverts InsufficientCollateral.
    if (collateral.isZero() || collateral.gte(oneWeiSeizure)) return null;
    seizedBase = collateral;
  }
  const principalValue = debtToRepay.mul(WAD).div(price);
  const bonus = seizedBase.gt(principalValue) ? seizedBase.sub(principalValue) : BigNumber.from(0);
  const protocolCut = bonus.mul(cutBps).div(10_000);
  const markerCut = bonus.mul(chipBps).div(10_000);

  // The dust sweep, folded in AFTER the split so it enlarges neither share. Only when debt survives.
  const remainder = collateral.sub(seizedBase);
  const sweeps = !remainder.isZero() && debtToRepay.lt(debt) && remainder.lt(oneWeiSeizure);
  const seized = sweeps ? seizedBase.add(remainder) : seizedBase;

  const toUs = weAreMarker ? seized.sub(protocolCut) : seized.sub(protocolCut).sub(markerCut);
  return { seized, bonus, protocolCut, markerCut, swept: sweeps ? remainder : BigNumber.from(0), toUs, principalValue };
}

/** Where a barked position sits: in its lull, inside its tail (biteable), or expired. */
export function markWindow(mark, tailSeconds, now) {
  if (!mark.marked) return { state: "unmarked" };
  const opens = mark.markedAt.add(mark.grace).toNumber();
  const closes = opens + Number(tailSeconds);
  if (now < opens) return { state: "grace", opens, closes, secondsToOpen: opens - now };
  if (now > closes) return { state: "expired", opens, closes };
  return { state: "actionable", opens, closes, secondsLeft: closes - now };
}
