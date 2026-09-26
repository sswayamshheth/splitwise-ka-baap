import type { LedgerEvent } from "@/lib/ledger/types";
import { sha256 } from "./sha256";

/**
 * The trip ledger as a hash chain.
 *
 * Every ledger event (expense added, someone leaves, a refund…) becomes one
 * block. A block's hash covers its position, the event's content hash and the
 * previous block's hash:
 *
 *   dataHash = SHA-256(canonical JSON of the event)
 *   hash     = SHA-256(height | prevHash | dataHash | timestamp)
 *
 * Change one rupee in block 5 and its dataHash changes, so its hash changes,
 * so block 6's prevHash no longer matches — every later block breaks. A Merkle
 * root over all block hashes is what we publish on-chain (Ethereum Sepolia):
 * one 32-byte fingerprint that commits to the whole history.
 *
 * Pure functions, no I/O: the browser runs them too, to verify independently.
 */

export const ZERO_HASH = "0".repeat(64);

export type Block = {
  height: number;
  eventId: string;
  type: string;
  ts: number;
  actor: string;
  dataHash: string;
  prevHash: string;
  hash: string;
};

/**
 * Canonical JSON: object keys sorted, undefined dropped. The same event always
 * serialises to the same bytes, whichever database stored it or in what key
 * order (Postgres jsonb, for one, reorders keys).
 */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const s = JSON.stringify(value);
    return s === undefined ? "null" : s;
  }
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonical(v))).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}

export const hashEvent = (e: LedgerEvent) => sha256(canonical(e));
export const linkHash = (height: number, prevHash: string, dataHash: string, ts: number) => sha256(`${height}|${prevHash}|${dataHash}|${ts}`);

export function buildChain(events: LedgerEvent[]): Block[] {
  const blocks: Block[] = [];
  let prev = ZERO_HASH;
  events.forEach((e, height) => {
    const dataHash = hashEvent(e);
    const hash = linkHash(height, prev, dataHash, e.ts);
    blocks.push({ height, eventId: e.id, type: e.type, ts: e.ts, actor: e.actor, dataHash, prevHash: prev, hash });
    prev = hash;
  });
  return blocks;
}

export type ChainCheck = { ok: true; blocks: number } | { ok: false; blocks: number; brokenAt: number; reason: string };

/** Re-derives every block from the events and checks the links. */
export function verifyChain(blocks: Block[], events: LedgerEvent[]): ChainCheck {
  if (blocks.length !== events.length) return { ok: false, blocks: blocks.length, brokenAt: Math.min(blocks.length, events.length), reason: "Block count doesn't match the event count" };
  let prev = ZERO_HASH;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.prevHash !== prev) return { ok: false, blocks: blocks.length, brokenAt: i, reason: `Block #${i} points to the wrong previous block` };
    const dataHash = hashEvent(events[i]);
    if (dataHash !== b.dataHash) return { ok: false, blocks: blocks.length, brokenAt: i, reason: `Block #${i}'s contents were changed after it was sealed` };
    if (linkHash(i, prev, dataHash, events[i].ts) !== b.hash) return { ok: false, blocks: blocks.length, brokenAt: i, reason: `Block #${i}'s hash doesn't match` };
    prev = b.hash;
  }
  return { ok: true, blocks: blocks.length };
}

/** Pairwise SHA-256 up to a single root; an odd node is paired with itself. */
export function merkleLevels(leaves: string[]): string[][] {
  if (leaves.length === 0) return [[ZERO_HASH]];
  const levels = [leaves];
  while (levels[levels.length - 1].length > 1) {
    const cur = levels[levels.length - 1];
    const next: string[] = [];
    for (let i = 0; i < cur.length; i += 2) next.push(sha256(cur[i] + (cur[i + 1] ?? cur[i])));
    levels.push(next);
  }
  return levels;
}

export const merkleRoot = (leaves: string[]) => merkleLevels(leaves).at(-1)![0];

export type ProofStep = { sibling: string; side: "left" | "right" };

/** The sibling hashes that lead from one block to the root. */
export function merkleProof(leaves: string[], index: number): ProofStep[] {
  const levels = merkleLevels(leaves);
  const proof: ProofStep[] = [];
  let i = index;
  for (let l = 0; l < levels.length - 1; l++) {
    const cur = levels[l];
    const isRight = i % 2 === 1;
    const sibling = isRight ? cur[i - 1] : (cur[i + 1] ?? cur[i]);
    proof.push({ sibling, side: isRight ? "left" : "right" });
    i = Math.floor(i / 2);
  }
  return proof;
}

export function verifyMerkleProof(leaf: string, proof: ProofStep[], root: string): boolean {
  let h = leaf;
  for (const s of proof) h = s.side === "left" ? sha256(s.sibling + h) : sha256(h + s.sibling);
  return h === root;
}

/** What goes on-chain for a trip: how many blocks, the last block's hash and the Merkle root. */
export function commitment(events: LedgerEvent[]) {
  const blocks = buildChain(events);
  return { blocks: blocks.length, headHash: blocks.at(-1)?.hash ?? ZERO_HASH, merkleRoot: merkleRoot(blocks.map((b) => b.hash)) };
}
