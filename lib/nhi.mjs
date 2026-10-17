// The network health index as the NHI oracle body defines it (deploy/mainnet/bodies/nhi.template.json
// in infer-protocol), computed from one live read of the control plane. The keeper reads it before
// buying an NHI answer: the feed bounds every value against its epoch's anchor, and a refused answer
// still costs the full price, so an answer the feed cannot accept is never bought (second-half review
// 2026-10-07, low). Exact integer arithmetic throughout, as the body requires.
import { BigNumber } from "ethers";

const WAD = BigNumber.from(10).pow(18);

/** The index from a /swarm document, scaled by 1e18 and truncated, exactly as the body computes it. */
export function nhiFromSwarm(doc) {
  const h = doc.health ?? {};
  const js = doc.counts?.jobStates ?? {};
  const n = (x) => BigNumber.from(Math.trunc(Number(x ?? 0)));
  // participation: p = floor(agentsOnline * 1e18 / seatsEnrolled), at most 1e18; 0 if no seats.
  let p = n(h.seatsEnrolled).isZero() ? BigNumber.from(0) : n(h.agentsOnline).mul(WAD).div(n(h.seatsEnrolled));
  if (p.gt(WAD)) p = WAD;
  // services: s = floor(u * 1e18 / 3), u the count of verifierUp, publisherUp, deployerUp that are true.
  const u = [h.verifierUp, h.publisherUp, h.deployerUp].filter((x) => x === true).length;
  const s = BigNumber.from(u).mul(WAD).div(3);
  // reliability: r = floor(d * 1e18 / (d + b)); 1e18 when d + b is 0. Executing jobs are ignored.
  const d = n(js.completed), b = n(js.blocked).add(n(js.cancelled));
  const r = d.add(b).isZero() ? WAD : d.mul(WAD).div(d.add(b));
  // answer = floor((4p + 3s + 3r) / 10)
  return p.mul(4).add(s.mul(3)).add(r.mul(3)).div(10);
}

/** One live read, or null when the control plane cannot be read (the caller then buys as before). */
export async function readLiveNhi(apiBase, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`${apiBase}/swarm`, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    return nhiFromSwarm(await res.json());
  } catch {
    return null;
  }
}
