#!/usr/bin/env node
// The daemon: the three loops on independent intervals, in one process, on one key.
//
// They are one process because they share a key, a nonce and a reason to exist, and because the
// competitive play couples them: a liquidation is only possible on a fresh feed, so the keeper that
// relays the update is the one positioned to act on it. Splitting them across machines would mean
// coordinating a nonce across machines, which is a worse problem than any it solves.
//
// ONE AT A TIME. The loops used to run concurrently, which is harmless while they only read and a
// nonce race the moment two of them send: ethers assigns each signer its next nonce independently, so
// a relay and a bite in the same second collide and one is dropped or replaces the other. They now
// take turns on one queue, in the order that matters — watch (buy the update), relay (land it),
// positions (act on it) — each on its own interval.
//
// Each iteration is isolated: a loop that throws logs and waits for its next tick rather than taking
// the process down. A keeper that dies on the first RPC hiccup is worse than one that reports it.
import { spawn } from "node:child_process";
import cfg from "./config.js";

const EXECUTE = process.argv.includes("--execute");
const once = process.argv.includes("--once");

const LOOPS = [
  { name: "watch", script: "watch.mjs", every: cfg.INTERVALS.watchSeconds, passes: EXECUTE ? ["--execute"] : [] },
  { name: "relay", script: "relay.mjs", every: cfg.INTERVALS.relaySeconds, passes: EXECUTE ? ["--execute"] : [] },
  { name: "positions", script: "positions.mjs", every: cfg.INTERVALS.positionsSeconds, passes: EXECUTE ? ["--execute"] : [] },
  // The pacer: keeps the vault's paced figures moving through quiet spells and re-prices collateral terms after a
  // price move. Last in the order: it acts on the update the relay landed and after the liquidations it enabled.
  { name: "pace", script: "pace.mjs", every: cfg.INTERVALS.paceSeconds ?? 300, passes: EXECUTE ? ["--execute"] : [] },
  // PACE.enabled false leaves the pacer out entirely: no pace(), no
  // resecure(), no reads. Anyone may still call either; every capital-moving call paces the vault on its own.
  // The INFER dripper: releases the Treasury's INFER for stakers into sINFER, hourly. Routine tier.
  { name: "drip", script: "drip.mjs", every: cfg.INTERVALS.dripSeconds ?? 3600, passes: EXECUTE ? ["--execute"] : [] },
]
  // LOOPS (config.js) names the loops this keeper runs; omitted, it runs all of them. pace and drip also need
  // their own `enabled` flag, because each spends gas for nothing (pace) or for a bounty others race for (drip).
  .filter((l) => !Array.isArray(cfg.LOOPS) || cfg.LOOPS.includes(l.name))
  .filter((l) => l.name !== "pace" || cfg.PACE?.enabled !== false)
  .filter((l) => l.name !== "drip" || cfg.DRIP?.enabled === true);

const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);

function run(loop) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [new URL(loop.script, import.meta.url).pathname, ...loop.passes], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    const prefix = `${stamp()} ${loop.name.padEnd(9)}`;
    const emit = (buf) => {
      for (const line of String(buf).split("\n")) if (line.trim()) console.log(`${prefix} | ${line}`);
    };
    child.stdout.on("data", emit);
    child.stderr.on("data", emit);
    // A non-zero exit is information — a stale feed exits 3, a bad direction 2 — not a reason to stop.
    child.on("close", (code) => {
      if (code) console.log(`${prefix} | exit ${code}`);
      resolve(code);
    });
  });
}

async function schedule() {
  const next = new Map(LOOPS.map((l) => [l.name, 0]));
  for (;;) {
    for (const loop of LOOPS) {
      if (Date.now() < next.get(loop.name)) continue;
      try {
        await run(loop);
      } catch (e) {
        console.log(`${stamp()} ${loop.name.padEnd(9)} | loop error: ${e.message}`);
      }
      next.set(loop.name, Date.now() + loop.every * 1000);
    }
    if (once) return;
    const wake = Math.min(...next.values()) - Date.now();
    await new Promise((r) => setTimeout(r, Math.max(1000, wake)));
  }
}

console.log(`${stamp()} daemon    | starting ${EXECUTE ? "IN EXECUTE MODE" : "in report-only mode"}`);
for (const l of LOOPS) console.log(`${stamp()} daemon    | ${l.name} every ${l.every}s`);
if (EXECUTE && !process.env.KEEPER_MNEMONIC) {
  console.error(`${stamp()} daemon    | --execute without KEEPER_MNEMONIC: refusing to start`);
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`${stamp()} daemon    | ${signal}, stopping`);
    process.exit(0);
  });
}

await schedule();
