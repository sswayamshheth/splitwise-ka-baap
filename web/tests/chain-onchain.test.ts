import { readFileSync } from "node:fs";
import path from "node:path";
import { ContractFactory, JsonRpcProvider, Wallet } from "ethers";
import ganache from "ganache";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ userId: null }), currentUser: async () => null }));

import { commitment } from "@/lib/chain/blocks";
import { buildGoaEvents } from "@/lib/ledger/demo-goa";

/**
 * The real contract and the real server code (lib/server/chain.ts), against a
 * local in-memory Ethereum node that uses Sepolia's chain id. Nothing is sent
 * to any network and no test ETH is spent.
 */
const PORT = 8599;
const KEY = "0x" + "11".repeat(32);
const OTHER = "0x" + "22".repeat(32);
let server: ReturnType<typeof ganache.server>;
let chain: typeof import("@/lib/server/chain");
const artifact = JSON.parse(readFileSync(path.resolve(__dirname, "..", "..", "contracts", "TripLedgerAnchor.json"), "utf8"));

beforeAll(async () => {
  server = ganache.server({
    chain: { chainId: 11155111 },
    wallet: { accounts: [KEY, OTHER].map((secretKey) => ({ secretKey, balance: "0x56BC75E2D63100000" })) },
    logging: { quiet: true },
  } as never); // ganache's option types don't resolve without a flavor generic
  await server.listen(PORT);
  const provider = new JsonRpcProvider(`http://127.0.0.1:${PORT}`, 11155111, { staticNetwork: true });
  const contract = await new ContractFactory(artifact.abi, artifact.bytecode, new Wallet(KEY, provider)).deploy();
  await contract.waitForDeployment();
  process.env.ANCHOR_RPC_URL = `http://127.0.0.1:${PORT}`;
  process.env.ANCHOR_PRIVATE_KEY = KEY;
  process.env.ANCHOR_CONTRACT = await contract.getAddress();
  process.env.ANCHOR_SALT = "test-salt";
  process.env.ANCHOR_DEPLOY_BLOCK = "0";
  chain = await import("@/lib/server/chain");
}, 60_000);

afterAll(async () => {
  await server?.close();
});

describe("on-chain anchoring (local Sepolia-like node)", () => {
  const events = buildGoaEvents(Date.UTC(2026, 8, 27));
  const TRIP = "trip_chain_test";

  it("reports the connection and the wallet balance", async () => {
    const s = await chain.chainStatus();
    expect(s.configured).toBe(true);
    expect(s.wallet).toBe(new Wallet(KEY).address);
    expect(Number(s.balanceEth)).toBeGreaterThan(0);
  });

  it("anchors a trip and reads back exactly the fingerprint the browser computes", async () => {
    const sent = await chain.anchorTrip(TRIP, events.slice(0, 10));
    expect(sent.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    const anchors = await chain.readAnchors(TRIP);
    expect(anchors).toHaveLength(1);
    const expected = commitment(events.slice(0, 10));
    expect(anchors[0]).toMatchObject({ index: 0, blocks: 10, headHash: expected.headHash, merkleRoot: expected.merkleRoot, txHash: sent.txHash });
    expect(chain.pendingAnchor(TRIP)).toBeNull();
  });

  it("only accepts a longer chain — history can't be rewound or re-anchored", async () => {
    await expect(chain.anchorTrip(TRIP, events.slice(0, 10))).rejects.toMatchObject({ status: 409 });
    await expect(chain.anchorTrip(TRIP, events.slice(0, 5))).rejects.toMatchObject({ status: 409 });
    await chain.anchorTrip(TRIP, events);
    const anchors = await chain.readAnchors(TRIP);
    expect(anchors.map((a) => a.blocks)).toEqual([10, events.length]);
    expect(anchors[1].merkleRoot).toBe(commitment(events).merkleRoot);
  });

  it("refuses to seal a longer chain whose older blocks were edited", async () => {
    const edited = structuredClone(events);
    const i = edited.findIndex((e) => e.type === "EXPENSE_ADDED");
    (edited[i] as Extract<(typeof edited)[number], { type: "EXPENSE_ADDED" }>).expense.amountPaise += 100;
    const longer = [...edited, { ...edited[edited.length - 1], id: "ev_extra", ts: edited[edited.length - 1].ts + 1 }];
    await expect(chain.anchorTrip(TRIP, longer)).rejects.toMatchObject({ status: 409 });
    expect((await chain.readAnchors(TRIP)).map((a) => a.blocks)).toEqual([10, events.length]);
  });

  it("the contract itself refuses writes from any other wallet and older chains", async () => {
    const provider = new JsonRpcProvider(`http://127.0.0.1:${PORT}`, 11155111, { staticNetwork: true });
    const { Contract } = await import("ethers");
    const stranger = new Contract(process.env.ANCHOR_CONTRACT!, artifact.abi, new Wallet(OTHER, provider));
    await expect(stranger.anchor(chain.tripKey(TRIP), 999, "0x" + "ab".repeat(32), "0x" + "cd".repeat(32))).rejects.toThrow(/NotOwner|revert/);
    const owner = new Contract(process.env.ANCHOR_CONTRACT!, artifact.abi, new Wallet(KEY, provider));
    await expect(owner.anchor(chain.tripKey(TRIP), 3, "0x" + "ab".repeat(32), "0x" + "cd".repeat(32))).rejects.toThrow(/NotNewer|revert/);
  });

  it("keeps trips apart and never puts the trip id on-chain", async () => {
    expect(chain.tripKey("trip_a")).not.toBe(chain.tripKey("trip_b"));
    expect(chain.tripKey(TRIP)).not.toContain(Buffer.from(TRIP).toString("hex"));
    expect(await chain.readAnchors("trip_never_anchored")).toEqual([]);
  });
});
