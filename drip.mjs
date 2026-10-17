#!/usr/bin/env node
// The INFER dripper: releases what the Treasury sends for stakers into sINFER, one step per hour.
//
// Reports by default; `--execute` calls drip() (requires KEEPER_MNEMONIC). Every send goes through lib/tx.mjs in the
// ROUTINE tier: kill switch, gas ceiling, ROUTINE_MIN_ETH floor, simulate first, so housekeeping never spends the gas
// the oracle and liquidations need.
//
// WHY THE KEEPER DOES IT. InferDripper
// releases at most 1/168 of its balance per call (MAX_CATCHUP 1 hour of a 7-day DRAIN_PERIOD), and 1,000 INFER per
// hour (minDrip) once that is smaller, and only when someone calls drip(). It pays the caller 1% of each release, but
// nobody is guaranteed to call it. A missed hour is not paid later (the catch-up is capped at one hour); the INFER just
// stays in the buffer longer. An empty dripper reads canDrip() false and nothing is sent.
//
// BACKSTOP, NOT A RACER (2026-10-17, tx 0xeb41ed51…: the keeper's drip() reverted BelowMinDrip because another caller
// dripped earlier in the same block). Bots call drip() every hour for its 1%, so racing them only buys reverts. The
// keeper now drips only when nobody has for DRIP.backstopMinutes (75 by default): the release keeps its pace when the
// bots stop, and the keeper never competes for the same block. And it re-reads releasable() against minDrip right
// before simulating, so a drip that landed while it was deciding refuses for free.
import { readProvider } from "./lib/rpc.mjs";
import { Contract, utils } from "ethers";
import { send, describe, keeperSigner } from "./lib/tx.mjs";
import cfg from "./config.js";

const DRIPPER = cfg.DRIP?.dripper ?? "0x0c1CE09ccfe9243c4ad23C3CAEE0C11D4E8340d3";
const INFER = cfg.DRIP?.infer ?? "0x53d0eA0A685220718Dc6a0a6e4617194C6F37921";
const ABI = [
  "function canDrip() view returns (bool)",
  "function releasable() view returns (uint256)",
  "function lastDripAt() view returns (uint256)",
  "function minDrip() view returns (uint256)",
  "function vault() view returns (address)",
  "function drip() returns (uint256 toVault, uint256 toKeeper)",
];
const ERC20 = ["function balanceOf(address) view returns (uint256)"];
const execute = process.argv.includes("--execute");
const fmt = (x) => Number(utils.formatEther(x)).toLocaleString("en-US", { maximumFractionDigits: 0 });

const provider = readProvider(cfg);
const dripper = new Contract(DRIPPER, ABI, provider);
const [buffer, releasable, can, last, vault] = await Promise.all([
  new Contract(INFER, ERC20, provider).balanceOf(DRIPPER),
  dripper.releasable(),
  dripper.canDrip(),
  dripper.lastDripAt(),
  dripper.vault(),
]);
const staked = await new Contract(INFER, ERC20, provider).balanceOf(vault);
// Chain time, not the machine's clock: lastDripAt is a block timestamp.
const chainNow = (await provider.getBlock("latest")).timestamp;
const ago = Math.round(chainNow - last.toNumber());
console.log(`dripper ${DRIPPER}  buffer ${fmt(buffer)} INFER  releasable ${fmt(releasable)}  last drip ${ago < 7200 ? `${Math.round(ago / 60)}m` : `${(ago / 3600).toFixed(1)}h`} ago`);
console.log(`sINFER  ${vault}  holds ${fmt(staked)} INFER`);
if (!can) {
  console.log(buffer.isZero() ? "hold    the dripper is empty: nothing to release" : "hold    not ready (below minDrip within the hour, or sINFER has no shares)");
  process.exit(0);
}
const backstop = (cfg.DRIP?.backstopMinutes ?? 75) * 60;
if (ago < backstop) {
  console.log(`hold    dripped ${Math.round(ago / 60)}m ago (others drip hourly for the 1%); the keeper steps in only after ${backstop / 60}m without one`);
  process.exit(0);
}
if (!execute) {
  console.log(`report only: drip() would release ${fmt(releasable)} INFER (1% to the caller). Add --execute to send.`);
  process.exit(0);
}
const signer = keeperSigner(provider, cfg);
const d = dripper.connect(signer);
const minDrip = await dripper.minDrip();
// Re-read just before simulating: a drip that landed meanwhile leaves less than minDrip, and refuses here for free.
const check = async () => {
  const [now, lastNow] = await Promise.all([dripper.releasable(), dripper.lastDripAt()]);
  if (lastNow.gt(last)) throw new Error(`someone dripped at ${lastNow.toNumber()} while the keeper was deciding`);
  if (now.lt(minDrip) || now.isZero()) throw new Error(`releasable ${fmt(now)} below minDrip ${fmt(minDrip)}`);
  return d.callStatic.drip();
};
const r = await send(signer, "drip", check, () => d.drip(), cfg);
console.log(`drip    ${describe(r)}`);
