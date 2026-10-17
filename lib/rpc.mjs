// Reads and sends go to different places (mainnet review 2026-10-11). VAULT_RPC_URL is meant for a private mempool (MEV Blocker,
// Flashbots Protect): right for SUBMITTING a signed transaction (private, no front-running), wrong for the keeper's hundreds of reads
// a minute, which it answered with 504s often enough to fail runs. Reads use READ_RPC_URLS (publicnode, then drpc,
// failing over); only a signed transaction goes to VAULT_RPC_URL.
import { providers } from "ethers";

const READS = ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"];

/** Every read: the first of READ_RPC_URLS that answers, the next after a two-second stall or an error. */
export function readProvider(cfg) {
  const urls = (process.env.READ_RPC_URLS?.split(",") ?? cfg.READ_RPC_URLS ?? READS).map((u) => u.trim()).filter(Boolean);
  if (urls.length === 1) return new providers.StaticJsonRpcProvider(urls[0], 1);
  return new providers.FallbackProvider(
    urls.map((u, i) => ({ provider: new providers.StaticJsonRpcProvider(u, 1), priority: i + 1, stallTimeout: 2000, weight: 1 })),
    1,
  );
}

/** Where signed transactions are submitted: VAULT_RPC_URL (a private mempool, ideally), else the first read RPC. */
export function sendProvider(cfg) {
  return new providers.StaticJsonRpcProvider(cfg.VAULT_RPC_URL || (cfg.READ_RPC_URLS ?? READS)[0], 1);
}
