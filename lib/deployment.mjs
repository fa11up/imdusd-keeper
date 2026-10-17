// One source of addresses: the record infer-protocol's DeployMainnet writes after it has read the
// whole stack back off chain (deploy/mainnet/out/deployment.json, with the Intake bodies beside it).
//
// WHY NOT ADDRESSES IN config.js. A hand-copied address is the exact failure that bricked launch 519.
// The deployment record is written by the script that verified every link, so pointing the keeper at
// it means the keeper acts on what the chain was checked to hold, and the asker bodies it sends are
// byte-for-byte the ones whose keccak the asker pins (a different byte is `WrongBody`).
//
// Without DEPLOYMENT, the legacy hand-written config (VAULT, FEEDS, VAULT_INTERFACE) still works, for
// Sepolia launch 688.
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { utils } from "ethers";

export function loadDeployment(cfg) {
  if (!cfg.DEPLOYMENT) {
    return {
      chainId: null,
      vault: cfg.VAULT,
      dialect: cfg.VAULT_INTERFACE ?? "maker",
      feeds: cfg.FEEDS.map((f) => ({ ...f, body: null })),
      asker: null,
      relayAny: cfg.RELAY_ANY ?? false,
    };
  }
  const path = resolve(cfg.DEPLOYMENT);
  if (!existsSync(path)) throw new Error(`DEPLOYMENT ${path} does not exist`);
  const d = JSON.parse(readFileSync(path, "utf8"));
  const bodies = join(dirname(path), "bodies");
  const body = (name) => {
    const bytes = readFileSync(join(bodies, `${name}.json`));
    return { bytes: utils.hexlify(bytes), hash: utils.keccak256(bytes) };
  };
  return {
    chainId: Number(d.chainId),
    block: Number(d.block),
    vault: d.vault,
    dialect: d.interface,
    feeds: [
      { role: "price", address: d.priceFeed, body: body("price") },
      { role: "nhi", address: d.nhiFeed, body: body("nhi") },
      { role: "spot", address: d.spotFeed, body: body("spot") },
    ],
    asker: d.oracleAsker,
    imd: d.imd,
    stablecoin: d.stablecoin,
    gem: d.gem,
    // Every feed of this deployment pins its question, so an attestation someone else bought is a
    // free, correct update rather than an attack: relay it (lib/attestation.mjs still checks the
    // question hash before sending).
    relayAny: cfg.RELAY_ANY ?? true,
  };
}
