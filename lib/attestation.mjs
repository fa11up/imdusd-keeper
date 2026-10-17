// Fetching an attestation and checking, locally, every guard `SwarmFeed.submitAttestation` applies.
//
// Extracted from oracle/relay-attestation.js so a loop can use it. The point of checking locally is
// not politeness about gas: a request once attested perfectly 14-of-14 and still could not be
// relayed, because the feed checks the SIGNED panel against its own floors and the signature was
// made under the service's default domain. Both were knowable without sending anything.
import { BigNumber, Contract, utils } from "ethers";

export const FEED_ABI = [
  "function attester() view returns (address)",
  "function relayer() view returns (address)",
  "function attestationChainId() view returns (uint256)",
  "function attestationAnswerType() view returns (uint8)",
  "function maxAge() view returns (uint256)",
  "function maxDeviationBps() view returns (uint256)",
  "function usedRequests(bytes32) view returns (bool)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function MIN_PANEL_SIZE() view returns (uint16)",
  "function MIN_AGREED() view returns (uint16)",
  "function minAgreed() view returns (uint16)",
  "function latestValue() view returns (uint256,uint64)",
  "function lastToBlock() view returns (uint64)",
  "function expectedQuestionHash(uint64,uint64) pure returns (bytes32)",
  "function submitAttestation((bytes32,uint256,bytes32,uint8,bytes,uint256,uint64,uint64,bytes32,bytes32,uint16,uint16,uint16,uint64,uint64),bytes)",
];

export const RELAY_ABI = [
  "function relay(address feed,(bytes32,uint256,bytes32,uint8,bytes,uint256,uint64,uint64,bytes32,bytes32,uint16,uint16,uint16,uint64,uint64) a,bytes sig)",
];

const ANSWER_TYPE = { bool: 0, address: 1, bytes32: 2, uint256: 3 };

export async function fetchAttestation(apiBase, id, fetchImpl = fetch) {
  const res = await fetchImpl(`${apiBase}/oracle/requests/${id}/attestation`, { headers: { accept: "application/json" } });
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, body: await res.json() };
}

export async function listAttested(apiBase, limit = 100, fetchImpl = fetch) {
  const res = await fetchImpl(`${apiBase}/oracle/requests?limit=${limit}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`/oracle/requests returned ${res.status}`);
  const body = await res.json();
  const items = Array.isArray(body) ? body : body.requests ?? body.items ?? [];
  return items.filter((r) => r.status === "attested");
}

export function toTuple(m) {
  const answerType = typeof m.answerType === "string" ? ANSWER_TYPE[m.answerType] : Number(m.answerType);
  return [
    m.requestId, BigNumber.from(m.chainId), m.questionHash, answerType, m.answer,
    BigNumber.from(m.figure), m.fromBlock, m.toBlock, m.blockHash, m.panelJobId,
    m.panelSize, m.quorum, m.agreed, m.issuedAt, m.expiresAt,
  ];
}

/**
 * Every precondition, checked against the feed's own on-chain configuration.
 * Returns { fail: string[], route, viaRelay, pinsQuestion, questionMatches }.
 */
export async function preflight(provider, feedAddress, attestation, selfAddress) {
  const { domain, message: m, signature, signer } = attestation;
  const feed = new Contract(feedAddress, FEED_ABI, provider);
  const answerType = typeof m.answerType === "string" ? ANSWER_TYPE[m.answerType] : Number(m.answerType);

  const [attester, relayer, chainId, wantType, maxAge, devBps, used, sep, minPanel, minAgreed] = await Promise.all([
    feed.attester(), feed.relayer(), feed.attestationChainId(), feed.attestationAnswerType(),
    feed.maxAge(), feed.maxDeviationBps(), feed.usedRequests(m.requestId), feed.DOMAIN_SEPARATOR(),
    feed.MIN_PANEL_SIZE(),
    // The feed's own floor (price and spot demand 67 of 100 from 2026-10-11); a feed built before then has only MIN_AGREED.
    feed.minAgreed().catch(() => feed.MIN_AGREED()),
  ]);
  const [curVal, curAt] = await feed.latestValue();
  const head = await provider.getBlock("latest");
  const { chainId: hereId } = await provider.getNetwork();
  const now = head.timestamp;
  const fail = [];

  if (signer.toLowerCase() !== attester.toLowerCase()) fail.push(`signer ${signer} != attester ${attester}`);
  const relayerCode = await provider.getCode(relayer);
  const viaRelay = relayerCode !== "0x";
  if (!viaRelay && selfAddress && selfAddress.toLowerCase() !== relayer.toLowerCase()) {
    fail.push(`we are not the pinned relayer ${relayer} and it is not a contract to route through`);
  }
  if (!BigNumber.from(m.chainId).eq(chainId)) fail.push(`payload chainId ${m.chainId} != ${chainId}`);
  if (answerType !== Number(wantType)) fail.push(`answerType ${answerType} != ${wantType}`);
  if (used) fail.push("requestId already consumed");
  if (now > Number(m.expiresAt)) fail.push(`expired ${now - Number(m.expiresAt)}s ago`);
  if (now - Number(m.issuedAt) > Number(maxAge)) fail.push("issuedAt older than maxAge");
  if (curAt && Number(m.issuedAt) < Number(curAt)) fail.push("older than the stored value");
  // The feed takes the signed `answer` (one uint256 word); a nonzero `figure` must equal it (feeds from 2026-10-11).
  const answerHex = typeof m.answer === "string" ? m.answer : "0x";
  const value = answerHex.length === 66 ? BigNumber.from(answerHex) : null;
  if (!value) fail.push("answer is not one 32-byte word");
  else if (value.isZero()) fail.push("answer is zero");
  else if (!BigNumber.from(m.figure).isZero() && !BigNumber.from(m.figure).eq(value)) fail.push("figure disagrees with answer");
  if (Number(m.panelSize) < Number(minPanel)) fail.push(`panelSize ${m.panelSize} < floor ${minPanel}`);
  if (Number(m.agreed) < Number(minAgreed)) fail.push(`agreed ${m.agreed} < floor ${minAgreed}`);
  if (Number(m.agreed) > Number(m.panelSize)) fail.push(`agreed ${m.agreed} > panelSize ${m.panelSize}`);
  if (!curVal.isZero()) {
    const f = value ?? BigNumber.from(m.figure);
    const change = f.gt(curVal) ? f.sub(curVal) : curVal.sub(f);
    const allowed = curVal.mul(devBps).div(10_000);
    if (change.gt(allowed)) fail.push(`deviation ${change} > allowed ${allowed}: needs successive updates`);
  }
  // The window rules a question-bound feed applies (SwarmFeed._requireQuestion): it must advance past
  // the last accepted window and, when the data chain is this chain, be neither in the future nor
  // further behind the head than the feed's own lifetime in blocks (launch audit F1).
  try {
    const last = await feed.lastToBlock();
    if (Number(m.toBlock) <= Number(last)) fail.push(`window ${m.toBlock} does not advance past ${last}`);
  } catch { /* feeds without question binding keep no window */ }
  if (Number(chainId) === Number(hereId)) {
    if (Number(m.toBlock) > head.number) fail.push(`window ends at ${m.toBlock}, after the head ${head.number}`);
    else if (head.number - Number(m.toBlock) > Math.floor(Number(maxAge) / 12)) {
      fail.push(`window ended ${head.number - Number(m.toBlock)} blocks ago, more than maxAge/12 = ${Math.floor(Number(maxAge) / 12)}`);
    }
  }
  const expectedDomain = utils._TypedDataEncoder.hashDomain(domain);
  if (expectedDomain !== sep) fail.push(`domain mismatch: signed ${expectedDomain} vs feed ${sep} — was consumer set?`);

  // Does this feed verify WHICH question the figure answers? The live feeds predate question binding
  // and return zero, which is why relaying an attestation we did not buy is only safe on a feed that
  // pins one. See the HIGH finding of audit c71449d1.
  let pinsQuestion = false;
  let questionMatches = false;
  try {
    const expected = await feed.expectedQuestionHash(m.fromBlock, m.toBlock);
    pinsQuestion = expected !== utils.hexZeroPad("0x0", 32);
    questionMatches = pinsQuestion && expected.toLowerCase() === String(m.questionHash).toLowerCase();
    if (pinsQuestion && !questionMatches) fail.push(`questionHash ${m.questionHash} != feed's ${expected}`);
  } catch {
    pinsQuestion = false; // older feeds have no such function at all
  }

  return { fail, relayer, viaRelay, pinsQuestion, questionMatches, tuple: toTuple(m), signature, message: m };
}
