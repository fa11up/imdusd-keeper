#!/usr/bin/env node
// Checks the deployment record against the chain before the keeper trusts it: every address holds code, the
// vault points at the record's Treasury, collateral and stablecoin, and the OracleAsker pins the keccak of each
// body file byte for byte (a different byte is `WrongBody` on every ask). Read-only; needs no key.
import { Contract, utils } from "ethers";
import { readProvider } from "../lib/rpc.mjs";
import { loadDeployment } from "../lib/deployment.mjs";
import cfg from "../config.js";

const dep = loadDeployment(cfg);
const raw = JSON.parse((await import("node:fs")).readFileSync(cfg.DEPLOYMENT, "utf8"));
const provider = readProvider(cfg);
const fail = [];
const ok = (m) => console.log(`ok      ${m}`);
const bad = (m) => { fail.push(m); console.log(`FAIL    ${m}`); };

const { chainId } = await provider.getNetwork();
chainId === dep.chainId ? ok(`chain ${chainId}`) : bad(`RPC is on chain ${chainId}, the record is for ${dep.chainId}`);

for (const [name, addr] of Object.entries(raw)) {
  if (typeof addr !== "string" || !utils.isAddress(addr)) continue;
  (await provider.getCode(addr)) === "0x" ? bad(`${name} ${addr} has no code`) : ok(`${name.padEnd(19)} ${addr}`);
}

const vault = new Contract(dep.vault, [
  "function treasury() view returns (address)",
  "function gem() view returns (address)",
  "function stablecoin() view returns (address)",
], provider);
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const checks = [["treasury", raw.treasury], ["gem", raw.gem], ["stablecoin", raw.stablecoin]];
for (const [fn, want] of checks) {
  try {
    const got = await vault[fn]();
    same(got, want) ? ok(`vault.${fn}() = record`) : bad(`vault.${fn}() = ${got}, record says ${want}`);
  } catch { console.log(`skip    vault.${fn}() not exposed`); }
}

const asker = new Contract(dep.asker, ["function feeds(address) view returns (bytes32 bodyHash, bool, bool, uint64, uint64, uint64, bool, bytes32)"], provider);
for (const f of dep.feeds) {
  const { bodyHash } = await asker.feeds(f.address);
  bodyHash === f.body.hash ? ok(`asker pins the ${f.role} body (${f.body.hash.slice(0, 12)}…)`) : bad(`${f.role}: asker pins ${bodyHash}, the file hashes ${f.body.hash}`);
}

console.log(fail.length ? `\n${fail.length} check(s) failed: do not run the keeper on this record.` : "\nthe record matches the chain.");
process.exitCode = fail.length ? 1 : 0;
