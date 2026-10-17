// node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { BigNumber } from "ethers";
import { pairDisagrees, pairGapBps as gapBps } from "../lib/risk.mjs";

const e15 = (x) => BigNumber.from(Math.round(x * 1e6)).mul(BigNumber.from(10).pow(9));

test("the vault's own measure: gap in bps of the primary", () => {
  assert.equal(gapBps(e15(2.6065), e15(2.4248)), 697); // 2026-10-16: redemption reverted PriceDivergence
  assert.equal(gapBps(e15(2.586073), e15(2.485304)), 389); // after the refresh: agrees
});

test("a fall is worth buying while the pair is past skew, not inside it", () => {
  assert.equal(pairDisagrees(e15(2.6065), e15(2.4248), 500), true);
  assert.equal(pairDisagrees(e15(2.586073), e15(2.485304), 500), false);
  assert.equal(pairDisagrees(e15(2.5), e15(2.5 * 0.95), 500), false, "exactly at skew agrees, as _withinSkew does");
});

test("an unset feed never triggers a purchase", () => {
  assert.equal(pairDisagrees(BigNumber.from(0), e15(2.4), 500), false);
  assert.equal(pairDisagrees(e15(2.4), BigNumber.from(0), 500), false);
});
