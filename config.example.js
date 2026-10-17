// Copy to config.js and edit. NO PRIVATE KEYS IN THIS FILE — the key comes from KEEPER_MNEMONIC in .env.
//
// Every protocol address comes from the deployment record, never from this file: deployment/mainnet/ is the
// record imdUSD's DeployMainnet wrote after verifying the stack on chain (deployment.json, plus the exact
// Intake bodies whose keccak the OracleAsker pins). `npm run verify-deployment` checks it against the chain.
//
// The defaults below are SAFE FOR A NEW OPERATOR: the keeper pays gas only, never its own IMD. Every loop
// that spends anything else is opt-in and says so.
export default {
  API_BASE: "https://api.imd.fun",

  DEPLOYMENT: process.env.DEPLOYMENT || "./deployment/mainnet/deployment.json",

  // Which loops the daemon (index.mjs) runs, in this order. Drop names to specialise: ["positions"] is a
  // liquidator, ["watch", "relay"] an oracle helper. pace and drip also need PACE.enabled / DRIP.enabled below.
  LOOPS: ["watch", "relay", "positions", "pace", "drip"],

  // One chain: the vault, the feeds, the asker and IMD's pool are all on Ethereum mainnet. Use a
  // provider you trust for SENDING; a public node is fine for reads but has dropped logs on us before.
  MAINNET_RPC_URL: process.env.MAINNET_RPC_URL || "https://ethereum-rpc.publicnode.com",
  VAULT_RPC_URL: process.env.VAULT_RPC_URL || process.env.MAINNET_RPC_URL || "https://ethereum-rpc.publicnode.com",
  // Every read (calls, estimates, nonces, receipts) goes to these, failing over in order after a 2 s stall. The env
  // var READ_RPC_URLS (comma-separated) overrides this list.
  READ_RPC_URLS: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"],

  // Position discovery. Mainnet Blockscout wants a real User-Agent and, past its anonymous quota,
  // BLOCKSCOUT_API_KEY in the environment.
  INDEXER: "https://eth.blockscout.com",

  // Read by the legacy watcher and the stale-price estimate; the same pool the asker reads.
  POOL: {
    poolManager: "0x000000000004444c5dc75cb358380d2e3de08a90",
    poolId: "0xb07d640fd9e2eb9dc81b953c8e4fd006bdfeaf276010fb5418eb763ca15abfb3",
    invert: false,
  },

  // --- guard rails on every transaction (lib/tx.mjs) ---
  MAX_GAS_GWEI: 30, // send nothing while gas is above this
  // Two floors (lib/tx.mjs): housekeeping (pace, resecure) stops first, so the oracle keep-alive and liquidations
  // keep their gas; they stop only at MIN_ETH, which still covers a bark and its bite.
  MIN_ETH: 0.003,
  ROUTINE_MIN_ETH: 0.02,
  // The tip over the base fee, per tier (ethers' default 1.5 gwei was ~90% of every fee at a 0.13 gwei base fee).
  // Sends go through a private mempool the read RPCs cannot see, so a tip too low to be included soon would
  // leave the next send reusing its nonce: keep both well above zero.
  FEES: { routine: { tipGwei: 0.05 }, urgent: { tipGwei: 0.5 } },
  GAS_MARGIN_BPS: 2500, // gas limit = the node's estimate plus this (a quarter): the vault's cost moves with the block time
  // `touch state/STOP` halts every send without restarting the daemon; delete it to resume.

  // --- spending the keeper's OWN IMD (OracleAsker.askPaidMany / askPaid), at most this much per UTC day ---
  // Two uses, sharing this budget: (1) the oracle fallback below, and (2) when pricing is stale and a
  // position would be under mat at the pool's price, a fresh price + spot so the liquidation can happen.
  // The Treasury-paid path (falls, NHI keep-alive) costs the keeper gas only and is not limited here.
  ASK_PAID_IMD_PER_DAY: 0, // 0 = off. 2 would allow two price + spot pairs a day at 0.5 IMD each
  // Oracle fallback while the Treasury bootstraps (its only sIMD income is the liquidation cut, so on day one
  // it cannot fund the asker): whenever the Treasury would pay but cannot even after fundOracle, the keeper
  // pays instead, in this priority under the daily cap — (1) NHI near stale (a stale NHI halts the vault a
  // day after launch, 0.5 IMD a day), (2) a FALL of the pool past the Treasury's trigger, armed and still
  // present 5 blocks later (price + spot together), (3) the PRIMARY feed once its allowance has widened to
  // the asker's threshold after nine silent hours (the spot is left to the Treasury: the vault refuses to
  // act while primary and spot disagree, so a walked spot alone moves nothing). Never for a rise. Turn off
  // once the Treasury carries the oracle; the keeper is then liquidation-only.
  KEEPER_ORACLE_FALLBACK: false,

  // Price and spot must agree within the vault's `skew` (5%) or borrowing, withdrawing against debt, marking,
  // liquidating and redeeming pause. In a rally the primary (a 2h median) lags the spot and the Treasury never
  // pays for rises, so this rule buys with the keeper's OWN IMD, under its own daily cap, and ONLY when the
  // answers it projects (the same pool samples the panel reads, from archiveRpc) would reopen the vault.
  // earlyBps: act from skew minus this (before the pause). marginBps: projected gap must be <= skew minus this.
  // Off: it buys price + spot with the keeper's OWN IMD, and the keeper holds none (Treasury-paid updates only).
  DIVERGENCE: { enabled: false, imdPerDay: 3, earlyBps: 100, marginBps: 100, minSpotLifeMinutes: 30, whenStale: true, archiveRpc: "https://eth.drpc.org" },

  // While the OracleAsker has a request in flight for a feed, leave its answer to the Intake's own callback for this
  // long after issue (relaying first only duplicates the delivery); past it, relay it.
  RELAY_CALLBACK_GRACE_SECONDS: 600,
  // The same for a Treasury-paid request, longer: if a relay lands first, the Intake's late callback reverts and the
  // asker backs the feed off for two hours.
  RELAY_TREASURY_CALLBACK_GRACE_SECONDS: 1800,
  // Relay attestations other people bought for these feeds too. Safe because every mainnet feed pins its question and
  // the relayer checks the question hash first (lib/attestation.mjs). Default true with a deployment record.
  RELAY_ANY: true,

  INTERVALS: {
    watchSeconds: 60, // drift arming is block-sensitive: arm, then ask 5..100 blocks later
    relaySeconds: 120,
    positionsSeconds: 300,
    paceSeconds: 300, // the pacer checks often and acts rarely: pace() once an hour, resecure() after a price move
    dripSeconds: 3600, // each drip() releases at most one hour of the buffer
  },

  // --- the pacer (pace.mjs) ---
  // The vault's paced figures (what a redemption is paid against, the fee base, the work ceiling's debt, the
  // payout price) move at most one PACE_INTERVAL per pacing, so a recovery reaches redeemers only while someone
  // paces: pace() when either paced clock is within marginSeconds of the interval. A position's collateral term
  // is fixed at the price it was last touched at, so after the price moves repriceMoveBps or more, resecure()
  // every position whose term depends on the price (debt-bound: above 200% at the old or the new price),
  // largest debt first, at most resecureMaxPerRun per run; collateral-bound terms need no re-price.
  // pace() only when it moves something (pace.mjs): backing below par with a recovery pending, the payout price
  // more than priceGapBps above the feed, or the fee base more than supplyLagBps off the supply.
  // Dust and risk (lib/risk.mjs). Loans owing under minDebt imdUSD are never barked, bitten or bought a
  // price for (a bark costs more gas than its chip earns). A fall is bought for the Treasury only while a loan above
  // minDebt would sit under mat x (1 + marginBps) at the pool's price; NHI keep-alive and wide-open refreshes are not gated.
  RISK: { minDebt: 15, marginBps: 1000 },
  // enabled: false drops the pacer loop (index.mjs).
  // The INFER dripper loop (drip.mjs): off unless enabled. Hourly; routine tier. drip() pays its caller 1% of the release.
  // backstopMinutes: drip only after this long without anyone dripping (others drip hourly for the 1%; never race them).
  DRIP: { enabled: false, dripper: "0x0c1CE09ccfe9243c4ad23C3CAEE0C11D4E8340d3", backstopMinutes: 75 },
  // The pacer earns nothing: it is a public good (it lets a recovery reach redeemers). Turn it on to help.
  PACE: { enabled: false, marginSeconds: 300, resecureToleranceBps: 50, resecureMaxPerRun: 20, backingGapBps: 10, priceGapBps: 100, supplyLagBps: 500 }, // resecure only when stored terms would move the capped backing figure
};
