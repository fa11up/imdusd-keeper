import { test } from "node:test";
import assert from "node:assert/strict";
import { plane, planeServers } from "../lib/plane.mjs";

// A provider whose ENS record is `text`; null reads as no resolver.
const ens = (text) => ({ getResolver: async () => (text === null ? null : { getText: async () => text }) });
const ok = (body) => ({ ok: true, json: async () => body });
const requests = (...statuses) => ({ requests: statuses.map((status, i) => ({ status, createdAt: `t${i}` })) });

test("servers: ENS record first, then the config's, deduplicated, https only", async () => {
  const s = await planeServers(ens("https://a.example/, http://plain.example ,https://b.example"), { API_BASE: "https://b.example", API_FALLBACKS: ["https://c.example"] });
  assert.deepEqual(s, ["https://a.example", "https://b.example", "https://c.example"]);
});

test("servers: an unreadable ENS record falls back to the config", async () => {
  const broken = { getResolver: async () => { throw new Error("rpc down"); } };
  assert.deepEqual(await planeServers(broken, { API_BASE: "https://api.example" }), ["https://api.example"]);
});

test("fails over to the next server when the first does not answer /health", async () => {
  const fetchImpl = async (u) => {
    if (u.startsWith("https://a.example")) throw new Error("ENOTFOUND");
    return ok(u.endsWith("/health") ? { status: "ok" } : requests("attested"));
  };
  const p = await plane(ens("https://a.example,https://b.example"), {}, fetchImpl);
  assert.equal(p.base, "https://b.example");
  assert.equal(p.ok, true);
});

test("holds when no server answers", async () => {
  const p = await plane(ens("https://a.example"), {}, async () => { throw new Error("ENOTFOUND"); });
  assert.equal(p.base, null);
  assert.equal(p.ok, false);
});

test("holds when the newest settled requests were all blocked (the 2026-10-23 outage)", async () => {
  const fetchImpl = async (u) => ok(u.endsWith("/health") ? { status: "ok" } : requests("pending", "blocked", "blocked", "blocked", "attested"));
  const p = await plane(ens("https://a.example"), {}, fetchImpl);
  assert.equal(p.ok, false);
  assert.match(p.why, /all blocked/);
});

test("a blocked request among answered ones does not hold", async () => {
  const fetchImpl = async (u) => ok(u.endsWith("/health") ? { status: "ok" } : requests("blocked", "attested", "blocked"));
  assert.equal((await plane(ens("https://a.example"), {}, fetchImpl)).ok, true);
});

test("holdAfterBlocked 0 only picks a server (the relay's use)", async () => {
  const fetchImpl = async (u) => ok(u.endsWith("/health") ? { status: "ok" } : requests("blocked", "blocked", "blocked"));
  const p = await plane(ens("https://a.example"), { PLANE: { holdAfterBlocked: 0 } }, fetchImpl);
  assert.equal(p.ok, true);
  assert.equal(p.base, "https://a.example");
});
