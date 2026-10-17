#!/usr/bin/env node
// The relay loop: find attestations that belong to our feeds and put them on chain.
//
// SAFETY RULE, and it is the whole design. By default this relays ONLY requests we bought, tracked in
// state/requests.json. It will not relay an arbitrary attested request that names one of our feeds as
// its consumer — because on a feed WITHOUT question binding, that is precisely the HIGH finding of
// audit c71449d1: `consumer.verifyingContract` is a field the requester chooses, so anyone can buy an
// attestation over a figure of their choosing, name our feed, and get a genuine attester signature
// over our feed's own domain. Signature, replay, freshness and panel floors all pass by construction.
//
// `--any` relays unowned attestations too, and refuses to do so unless the feed PINS A QUESTION and
// the attestation answers it. On such a feed the figure cannot be arbitrary, so a free price update
// from someone else's request is a gift rather than an attack.
import { readProvider } from "./lib/rpc.mjs";
import { providers, Contract } from "ethers";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { preflight, listAttested, fetchAttestation, RELAY_ABI, FEED_ABI } from "./lib/attestation.mjs";
import { loadDeployment } from "./lib/deployment.mjs";
import { send, describe, keeperSigner } from "./lib/tx.mjs";
import cfg from "./config.js";

const STATE = new URL("./state/requests.json", import.meta.url);
const execute = process.argv.includes("--execute");
// A DeployMainnet deployment pins a question on every feed, so --any is its default: an answer the
// Intake failed to deliver, or one a stranger bought, still lands (each is checked against the feed's
// question first). Legacy config keeps the old default of relaying only what we bought.
const dep = loadDeployment(cfg);
const any = process.argv.includes("--any") || dep.relayAny;

const loadState = () => {
  if (!existsSync(STATE)) return { owned: [], relayed: [] };
  return JSON.parse(readFileSync(STATE, "utf8"));
};
const saveState = (s) => {
  mkdirSync(new URL("./state/", import.meta.url), { recursive: true });
  writeFileSync(STATE, `${JSON.stringify(s, null, 2)}\n`);
};

// WAIT FOR THE CALLBACK. When the OracleAsker has a request in flight for a feed, the Intake will deliver its answer
// itself (onOracleResult relays it). Relaying first only duplicates that delivery: the callback then finds the
// answer used (ReplayedAttestation, `Delivered(..., false)`) and both sides pay gas for one update (seen
// 2026-10-12: we relayed 14 blocks before the Intake's callback). So while a request is in flight, an answer is
// left to the callback for this long after it was issued; past it the callback is presumed lost and we relay.
// Answers bought outside the asker (the plane's API) get no callback and are relayed at once.
// A TREASURY-PAID request waits longer. If our relay lands first and the Intake's callback comes after, the feed refuses
// the duplicate and the asker reads that as a refused Treasury purchase: it holds off Treasury-paid updates for the
// feed for ASK_TIMEOUT (2 h). Seen 2026-10-13: the Intake delivered 1 h late, after our relay at 10 min, and price +
// spot went stale with the Treasury locked out. A caller-paid duplicate costs only gas, so it keeps the short wait.
const CALLBACK_GRACE = Number(cfg.RELAY_CALLBACK_GRACE_SECONDS ?? 600);
const TREASURY_CALLBACK_GRACE = Number(cfg.RELAY_TREASURY_CALLBACK_GRACE_SECONDS ?? 1800);
const ASKER_ABI = [
  "function feeds(address) view returns (bytes32 bodyHash, bool tracksPool, bool keepAlive, uint64 lastAsk, uint64 armedAt, uint64 inFlightAt, bool treasuryPaid, bytes32 inFlight)",
];
const NONE = `0x${"0".repeat(64)}`;

const feedByAddress = (addr) =>
  dep.feeds.find((f) => f.address.toLowerCase() === String(addr).toLowerCase());

async function main() {
  const provider = readProvider(cfg);
  const state = loadState();
  let signer = null;
  if (execute) {
    signer = keeperSigner(provider, cfg);
    console.log(`keeper  ${signer.address}`);
  }

  // Candidates: everything we bought and have not yet relayed, plus — with --any — whatever the plane
  // lists as attested for one of our feeds.
  const asker = dep.asker ? new Contract(dep.asker, ASKER_ABI, provider) : null;
  const pending = state.owned.filter((id) => !state.relayed.includes(id));
  const candidates = pending.map((id) => ({ id, owned: true }));

  if (any) {
    const listed = await listAttested(cfg.API_BASE, 100);
    for (const r of listed) {
      if (state.relayed.includes(r.id) || candidates.some((c) => c.id === r.id)) continue;
      candidates.push({ id: r.id, owned: false });
    }
  }

  if (candidates.length === 0) {
    console.log(`nothing to relay. ${state.owned.length} owned requests, ${state.relayed.length} already on chain.`);
    if (!any) console.log("Add --any to also consider attestations bought by others (question-bound feeds only).");
    return;
  }

  for (const c of candidates) {
    const att = await fetchAttestation(cfg.API_BASE, c.id);
    if (!att.ok) { console.log(`${c.id}  not attested yet (HTTP ${att.status})`); continue; }

    const consumer = att.body.domain?.verifyingContract;
    const feed = feedByAddress(consumer);
    if (!feed) { if (c.owned) console.log(`${c.id}  consumer ${consumer} is not one of our feeds`); continue; }

    const pf = await preflight(provider, feed.address, att.body, signer?.address);
    console.log(`\n${c.id}  -> ${feed.role} ${feed.address}`);
    console.log(`  figure ${pf.message.figure}  window ${pf.message.fromBlock}..${pf.message.toBlock}  panel ${pf.message.panelSize}/${pf.message.agreed}`);
    console.log(`  route  ${pf.viaRelay ? `through SwarmRelay ${pf.relayer} (permissionless)` : "direct, as the pinned relayer"}`);
    console.log(`  owned  ${c.owned ? "yes, we bought it" : "no, someone else bought it"}`);
    console.log(`  question-bound feed: ${pf.pinsQuestion}${pf.pinsQuestion ? `, matches: ${pf.questionMatches}` : ""}`);

    if (!c.owned && !pf.pinsQuestion) {
      // The refusal that matters. A feed that does not verify its question will accept any figure a
      // signed attestation carries, so relaying a stranger's request is handing them our price.
      console.log(`  REFUSED: this feed pins no question, so an attestation we did not buy could carry`);
      console.log(`           any figure at all. Relaying it would be the HIGH finding, executed.`);
      continue;
    }
    if (pf.fail.includes("requestId already consumed")) {
      // On chain already (the Intake's callback, or anyone's relay): done, stop re-checking it every pass.
      console.log(`  already on chain: delivered by the Intake's callback or another relayer`);
      state.relayed.push(c.id);
      saveState(state);
      continue;
    }
    if (pf.fail.length) { console.log(`  WOULD REVERT:\n    - ${pf.fail.join("\n    - ")}`); continue; }
    if (asker) {
      const row = await asker.feeds(feed.address);
      const age = (await provider.getBlock("latest")).timestamp - Number(pf.message.issuedAt);
      const grace = row.treasuryPaid ? TREASURY_CALLBACK_GRACE : CALLBACK_GRACE;
      if (row.inFlight !== NONE && age < grace) {
        console.log(`  waiting: the asker's ${row.treasuryPaid ? "Treasury-paid " : ""}request is in flight, the Intake's callback delivers it (${grace - age}s left before we relay)`);
        continue;
      }
      if (row.inFlight !== NONE) console.log(`  no callback ${age}s after issue: relaying it ourselves`);
    }
    console.log(`  all guards pass`);

    if (!execute) { console.log(`  (report only; add --execute to send)`); continue; }
    const target = pf.viaRelay
      ? new Contract(pf.relayer, RELAY_ABI, signer)
      : new Contract(feed.address, FEED_ABI, signer);
    const args = pf.viaRelay ? [feed.address, pf.tuple, pf.signature] : [pf.tuple, pf.signature];
    const fn = pf.viaRelay ? "relay" : "submitAttestation";
    const r = await send(signer, `relay ${c.id}`, () => target.callStatic[fn](...args), () => target[fn](...args), cfg);
    console.log(`  ${describe(r)}`);
    if (r.hash) { state.relayed.push(c.id); saveState(state); }
  }
}

main().catch((e) => { console.error("relay failed:", e.message); process.exitCode = 1; });
