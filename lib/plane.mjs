// Which IdentityMD control-plane server to talk to, and whether it is answering oracle requests at all.
//
// WHY. On 2026-10-23 the plane's domain (imd.fun) was put on a registrar hold for about ten hours: api.imd.fun
// stopped resolving, no attestation could be fetched, and every update bought in that window was paid for and never
// answered. Paid requests are not refunded. Two things follow:
//
//   1. SERVERS FROM ENS. The plane's operator publishes its servers on chain, in the `imd.servers` text record of
//      identitymd.eth (tx 0xb771f997…, block 26256551): a comma-separated list, tried in order. A registrar can
//      suspend a domain, not an ENS record. The list here is that record, then cfg.API_BASE and cfg.API_FALLBACKS,
//      deduplicated; the first server whose /health answers wins.
//
//   2. DON'T BUY WHILE THE PLANE IS FAILING. During the outage the direct host answered /health while every oracle
//      job failed (`blockedReason: node oracle_assess: internal_error`), so reachability alone is not enough. The
//      plane is held to be failing when its newest PLANE.holdAfterBlocked settled requests (default 3), anyone's,
//      were all `blocked`. Holding costs only time (feeds stay stale, as they would anyway); buying into a failing
//      plane costs 0.5 IMD per update.

const ENS_NAME = "identitymd.eth";
const ENS_KEY = "imd.servers";
const SETTLED = new Set(["attested", "disagreed", "blocked", "mismatch"]);

const clean = (u) => String(u).trim().replace(/\/+$/, "");
const isHttps = (u) => /^https:\/\/[a-z0-9.-]+(:\d+)?(\/[^\s]*)?$/i.test(u);

async function getJson(url, fetchImpl, timeoutMs) {
  const res = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** The `imd.servers` record of identitymd.eth as a list of https URLs; [] when ENS cannot be read. */
export async function ensServers(provider) {
  try {
    const resolver = await provider.getResolver(ENS_NAME);
    const text = resolver ? await resolver.getText(ENS_KEY) : null;
    return (text ?? "").split(",").map(clean).filter(isHttps);
  } catch {
    return [];
  }
}

/** Every candidate server, in the order to try: ENS first, then the config's own. */
export async function planeServers(provider, cfg) {
  const configured = [cfg.API_BASE, ...(cfg.API_FALLBACKS ?? [])].filter(Boolean).map(clean);
  const all = [...(await ensServers(provider)), ...configured];
  return [...new Set(all)];
}

/**
 * The server to use and whether buying an oracle update is worth it right now.
 * Returns { base, ok, why, servers }: `base` is null when no server answers /health; `ok` is false when there is
 * no server or the plane's newest settled requests were all blocked.
 */
export async function plane(provider, cfg, fetchImpl = fetch) {
  const servers = await planeServers(provider, cfg);
  const timeoutMs = cfg.PLANE?.timeoutMs ?? 8000;
  let base = null;
  for (const s of servers) {
    try {
      const h = await getJson(`${s}/health`, fetchImpl, timeoutMs);
      if (h?.status === "ok") { base = s; break; }
    } catch { /* next server */ }
  }
  if (!base) return { base: null, ok: false, why: `no plane server answers /health (tried ${servers.join(", ") || "none"})`, servers };
  const n = cfg.PLANE?.holdAfterBlocked ?? 3;
  if (!n) return { base, ok: true, why: "", servers };
  try {
    const body = await getJson(`${base}/oracle/requests?limit=25`, fetchImpl, timeoutMs);
    const settled = (body.requests ?? []).filter((r) => SETTLED.has(r.status)).slice(0, n);
    if (settled.length === n && settled.every((r) => r.status === "blocked")) {
      return { base, ok: false, why: `the plane's last ${n} settled oracle requests were all blocked (newest ${settled[0].createdAt})`, servers };
    }
  } catch (e) {
    return { base, ok: false, why: `${base}/oracle/requests could not be read (${e.message})`, servers };
  }
  return { base, ok: true, why: "", servers };
}

/** One line for the log. */
export function describePlane(p) {
  return p.ok ? `plane   ${p.base}${p.servers.length > 1 ? `  (servers: ${p.servers.join(", ")})` : ""}` : `plane   HOLD: ${p.why}; no update is bought this run`;
}
