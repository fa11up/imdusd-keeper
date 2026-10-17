// What a fresh PRIMARY answer would be, before paying for one.
//
// The price feed's question is the MEDIAN of N evenly spaced samples of the v4 pool across a window of hours
// ending at the request (bodies/price.json: window.hours, "samples N" in the recipe). In a rally that median
// lags the live pool, so a fresh price can land still too far from the spot for the vault to act (skew), and
// the 0.5 IMD buys nothing. Reading the same samples ourselves tells us whether a purchase would reopen it.
//
// The samples are past blocks, so this needs archive state: publicnode serves only the last ~128 blocks
// (and answers older calls with a bare revert), eth.drpc.org serves all of them.
import { providers, BigNumber } from "ethers";
import { readSpot } from "./pool.mjs";

const BLOCKS_PER_HOUR = 300; // 12-second slots

/** { hours, samples } from the price body's bytes (hex), or null when the body does not say. */
export function windowOf(bodyHex) {
  try {
    const j = JSON.parse(Buffer.from(bodyHex.slice(2), "hex").toString("utf8"));
    const hours = Number(j.window?.hours);
    const m = /samples (\d+)/.exec(j.definitions?.recipe ?? "");
    if (!hours || !m) return null;
    return { hours, samples: Number(m[1]) };
  } catch {
    return null;
  }
}

/** The median the panel would compute for a window ending at `toBlock`. */
export async function projectMedian(rpcUrl, pool, toBlock, { hours, samples }) {
  const provider = new providers.JsonRpcProvider(rpcUrl);
  const span = hours * BLOCKS_PER_HOUR;
  const blocks = Array.from({ length: samples }, (_, i) => toBlock - span + Math.round((i * span) / (samples - 1)));
  const values = await Promise.all(blocks.map((b) => readSpot(provider, pool, b).then((r) => r.spot)));
  const sorted = [...values].sort((a, b) => (a.lt(b) ? -1 : a.gt(b) ? 1 : 0));
  const mid = Math.floor(samples / 2);
  return samples % 2 ? sorted[mid] : sorted[mid - 1].add(sorted[mid]).div(2);
}

/** |a - b| / base, in basis points. */
export function gapBps(a, b, base) {
  const d = BigNumber.from(a).gt(b) ? BigNumber.from(a).sub(b) : BigNumber.from(b).sub(a);
  return d.mul(10_000).div(base).toNumber();
}
