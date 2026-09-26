import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { buildChain, canonical, commitment, merkleProof, merkleRoot, verifyChain, verifyMerkleProof, ZERO_HASH } from "@/lib/chain/blocks";
import { sha256 } from "@/lib/chain/sha256";
import { buildGoaEvents } from "@/lib/ledger/demo-goa";
import type { LedgerEvent } from "@/lib/ledger/types";

const nodeSha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe("sha256", () => {
  it("matches Node's crypto, including multi-block and non-ASCII input", () => {
    const samples = ["", "abc", "₹1,25,000 · Goa ✈️", "a".repeat(55), "a".repeat(56), "a".repeat(64), "x".repeat(1000)];
    for (let i = 0; i < 40; i++) samples.push(Math.random().toString(36).repeat(i + 1));
    for (const s of samples) expect(sha256(s)).toBe(nodeSha(s));
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("hash chain", () => {
  const events = buildGoaEvents(Date.UTC(2026, 8, 27));

  it("links every block to the previous one", () => {
    const blocks = buildChain(events);
    expect(blocks).toHaveLength(events.length);
    expect(blocks[0].prevHash).toBe(ZERO_HASH);
    for (let i = 1; i < blocks.length; i++) expect(blocks[i].prevHash).toBe(blocks[i - 1].hash);
    expect(verifyChain(blocks, events)).toEqual({ ok: true, blocks: events.length });
  });

  it("canonical JSON ignores key order, so a database reordering keys changes nothing", () => {
    expect(canonical({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } })).toBe(canonical({ a: { d: [1, { y: 2, z: 1 }] }, b: 1 }));
    const shuffled = events.map((e) => JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(e).reverse()))) as LedgerEvent);
    expect(buildChain(shuffled).at(-1)!.hash).toBe(buildChain(events).at(-1)!.hash);
  });

  it("detects a changed amount in an old block", () => {
    const blocks = buildChain(events);
    const i = events.findIndex((e) => e.type === "EXPENSE_ADDED");
    const tampered = structuredClone(events);
    const e = tampered[i] as Extract<LedgerEvent, { type: "EXPENSE_ADDED" }>;
    e.expense.amountPaise += 100; // one rupee
    const check = verifyChain(blocks, tampered);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.brokenAt).toBe(i);
    // …and the re-sealed chain no longer matches what was committed on-chain.
    expect(commitment(tampered).merkleRoot).not.toBe(commitment(events).merkleRoot);
    expect(commitment(tampered).headHash).not.toBe(commitment(events).headHash);
  });

  it("detects a deleted or reordered block", () => {
    const blocks = buildChain(events);
    expect(verifyChain(blocks, events.slice(0, -1)).ok).toBe(false);
    const swapped = [...events];
    [swapped[3], swapped[4]] = [swapped[4], swapped[3]];
    expect(verifyChain(blocks, swapped).ok).toBe(false);
    expect(verifyChain(buildChain(swapped), events).ok).toBe(false);
  });
});

describe("merkle tree", () => {
  it("proves every leaf is in the root, for odd and even sizes", () => {
    for (const n of [1, 2, 3, 5, 8, 13]) {
      const leaves = Array.from({ length: n }, (_, i) => sha256(`leaf ${i}`));
      const root = merkleRoot(leaves);
      for (let i = 0; i < n; i++) expect(verifyMerkleProof(leaves[i], merkleProof(leaves, i), root)).toBe(true);
      expect(verifyMerkleProof(sha256("not a leaf"), merkleProof(leaves, 0), root)).toBe(false);
    }
  });
});
