// The keeper's own-IMD spending ledger, one UTC day at a time. Shared by the watcher (which spends first,
// on keeping the oracle alive) and the positions loop (which spends what is left, on liquidations).
import { BigNumber } from "ethers";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

// `ledger` keeps a budget apart: "spend" (oracle fallback + liquidation prices) and "agreement" (the
// divergence rule in watch.mjs) each have their own daily cap.
const file = (ledger) => new URL(`../state/${ledger}.json`, import.meta.url);
const today = () => new Date().toISOString().slice(0, 10);

export function spentToday(ledger = "spend") {
  if (!existsSync(file(ledger))) return BigNumber.from(0);
  const s = JSON.parse(readFileSync(file(ledger), "utf8"));
  return s.day === today() ? BigNumber.from(s.imd) : BigNumber.from(0);
}

export function recordSpend(amount, ledger = "spend") {
  mkdirSync(new URL("../state/", import.meta.url), { recursive: true });
  writeFileSync(file(ledger), `${JSON.stringify({ day: today(), imd: spentToday(ledger).add(amount).toString() })}\n`);
}
