// Every transaction the keeper sends goes through here, so the guard rails live in one place.
//
//   - a KILL SWITCH: the file state/STOP makes every send refuse, without restarting the daemon;
//   - a GAS CEILING: nothing is sent while the network's gas price is above MAX_GAS_GWEI;
//   - TWO ETH FLOORS: routine sends (pace, resecure) stop below ROUTINE_MIN_ETH, so housekeeping never eats the
//     gas the oracle and liquidations need; urgent sends (ask, arm, fundOracle, relay, bark, bite) stop only below
//     MIN_ETH, so the last gas is never spent on a bark that cannot be followed by its bite. One floor for both
//     stopped everything at once (mainnet, 2026-10-12: below 0.01 ETH the oracle keep-alive stopped too);
//   - A SMALL TIP: ethers v5 tips 1.5 gwei by default, about 90% of every fee when the base fee was ~0.13 gwei
//     (2026-10-12). Each tier tips FEES[tier].tipGwei over twice the latest base fee instead;
//   - SIMULATE FIRST: the call is run with callStatic, so a doomed transaction costs nothing and its
//     revert reason is logged instead;
//   - a GAS MARGIN: the signer's gas limit is the node's estimate plus GAS_MARGIN_BPS (a quarter by
//     default). A node estimates against the latest block's timestamp and the transaction is mined a
//     second or more later, and the vault's cost moves with time: the first pacing of an hour, a term
//     that re-prices, a clock that changes value, each a few thousand gas more than the estimate saw.
//     An estimate with no margin then runs out of gas in the last store (seen on a fork: `lockIMD`
//     reverted with ReentrancySentryOOG at exactly the estimated limit) and still pays for the whole
//     limit. Unused margin costs nothing.
import { sendProvider } from "./rpc.mjs";
import { existsSync } from "node:fs";
import { utils, Wallet } from "ethers";

export const STOP = new URL("../state/STOP", import.meta.url);

/// The keeper's signer from KEEPER_MNEMONIC, with the gas margin on every estimate it makes.
export function keeperSigner(provider, cfg) {
  if (!process.env.KEEPER_MNEMONIC) throw new Error("--execute needs KEEPER_MNEMONIC in the environment");
  const signer = Wallet.fromMnemonic(process.env.KEEPER_MNEMONIC).connect(provider);
  // Calls, estimates, nonce and fees come from `provider` (the read RPCs); only the signed transaction goes to
  // the send RPC (lib/rpc.mjs). Its receipt is awaited on the read side too, and a reverted one throws, as
  // ethers' own wait() does. Every send() awaits its receipt before the next, so the nonce is never ahead.
  const out = sendProvider(cfg);
  signer.sendTransaction = async (tx) => {
    // The tier's tip over twice the latest base fee (the cap; what is paid is base fee + tip), unless the
    // caller set fees itself.
    if (tx.maxPriorityFeePerGas === undefined && tx.gasPrice === undefined) {
      const tier = cfg.FEES?.[signer.feeTier ?? "urgent"] ?? {};
      const tip = utils.parseUnits(String(tier.tipGwei ?? 0.3), "gwei");
      const base = (await provider.getBlock("latest")).baseFeePerGas;
      if (base) {
        tx = { ...tx, type: 2, maxPriorityFeePerGas: tip, maxFeePerGas: base.mul(2).add(tip) };
      }
    }
    const signed = await signer.signTransaction(await signer.populateTransaction(tx));
    const res = await out.sendTransaction(signed);
    res.wait = async (confirms = 1) => {
      const rc = await provider.waitForTransaction(res.hash, confirms, 15 * 60 * 1000);
      if (!rc) throw new Error(`${res.hash}: no receipt within 15 minutes`);
      if (rc.status === 0) throw new Error(`${res.hash} reverted`);
      return rc;
    };
    return res;
  };
  const bps = 10_000 + Number(cfg.GAS_MARGIN_BPS ?? 2_500);
  const estimate = signer.estimateGas.bind(signer);
  signer.estimateGas = async (tx) => (await estimate(tx)).mul(bps).div(10_000);
  return signer;
}

/** Housekeeping that can wait for a cheaper block and must never use the gas the urgent sends need. */
const ROUTINE = /^(pace|resecure|drip)\b/;

export async function send(signer, label, simulate, sendIt, cfg) {
  if (existsSync(STOP)) return { skipped: `kill switch: state/STOP exists, ${label} not sent` };
  const tier = ROUTINE.test(label) ? "routine" : "urgent";
  const provider = signer.provider;
  const [gasPrice, balance] = await Promise.all([provider.getGasPrice(), provider.getBalance(signer.address)]);
  const ceiling = utils.parseUnits(String(cfg.MAX_GAS_GWEI ?? 50), "gwei");
  if (gasPrice.gt(ceiling)) {
    return { skipped: `gas ${utils.formatUnits(gasPrice, "gwei")} gwei above MAX_GAS_GWEI ${cfg.MAX_GAS_GWEI ?? 50}` };
  }
  const floorName = tier === "routine" ? "ROUTINE_MIN_ETH" : "MIN_ETH";
  const floor = tier === "routine" ? cfg.ROUTINE_MIN_ETH ?? 0.02 : cfg.MIN_ETH ?? 0.003;
  if (balance.lt(utils.parseEther(String(floor)))) {
    return { skipped: `keeper holds ${utils.formatEther(balance)} ETH, below ${floorName} ${floor}: ${label} not sent; top it up` };
  }
  try {
    await simulate();
  } catch (e) {
    return { refused: e.errorName || e.reason || (e.shortMessage ?? e.message).slice(0, 140) };
  }
  signer.feeTier = tier;
  const tx = await sendIt();
  const rc = await tx.wait();
  return { hash: tx.hash, block: rc.blockNumber, gas: rc.gasUsed.toString() };
}

export function describe(r) {
  if (r.skipped) return `skipped ${r.skipped}`;
  if (r.refused) return `refused ${r.refused}`;
  return `sent    ${r.hash} (block ${r.block}, gas ${r.gas})`;
}
