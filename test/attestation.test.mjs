// lapsed(): the relay drops a candidate only for failures that time cannot undo.
import test from "node:test";
import assert from "node:assert/strict";
import { lapsed } from "../lib/attestation.mjs";

test("past expiresAt or older than maxAge: lapsed, dropped", () => {
  assert.equal(lapsed(["expired 12s ago"]), true);
  assert.equal(lapsed(["older than the stored value", "issuedAt older than maxAge"]), true);
});

test("anything else may still land later: kept", () => {
  assert.equal(lapsed([]), false);
  assert.equal(lapsed(["requestId already consumed"]), false);
  assert.equal(lapsed(["deviation 5 > allowed 3: needs successive updates"]), false);
});
