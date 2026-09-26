import "server-only";

import { createHmac } from "node:crypto";
import { Contract, JsonRpcProvider, Wallet, formatEther, type InterfaceAbi } from "ethers";

import { commitment } from "@/lib/chain/blocks";
import abi from "@/lib/chain/TripLedgerAnchor.abi.json";
import type { LedgerEvent } from "@/lib/ledger/types";
import { HttpError } from "./trips";

/**
 * On-chain anchoring on Ethereum Sepolia (a free public testnet).
 *
 * The app owns one wallet (ANCHOR_PRIVATE_KEY, server-side only). Anchoring a
 * trip sends one transaction to the TripLedgerAnchor contract with three
 * hashes — block count, last block hash, Merkle root. The trip is identified
 * on-chain only by HMAC-SHA256(ANCHOR_SALT, tripId), so nobody can link an
 * anchor to a trip without the app. Reads go through a free public RPC.
 */

export const SEPOLIA = { chainId: 11155111, name: "Ethereum Sepolia (testnet)", explorer: "https://sepolia.etherscan.io", rpc: "https://ethereum-sepolia-rpc.publicnode.com" };

function cfg() {
  return {
    key: process.env.ANCHOR_PRIVATE_KEY ?? "",
    contract: process.env.ANCHOR_CONTRACT ?? "",
    rpc: process.env.ANCHOR_RPC_URL || SEPOLIA.rpc,
    salt: process.env.ANCHOR_SALT || "grouptrip-ledger-anchor",
    deployBlock: Number(process.env.ANCHOR_DEPLOY_BLOCK) || 0,
  };
}

export const chainConfigured = () => {
  const c = cfg();
  return /^0x[0-9a-fA-F]{64}$/.test(c.key) && /^0x[0-9a-fA-F]{40}$/.test(c.contract);
};

export const tripKey = (tripId: string) => "0x" + createHmac("sha256", cfg().salt).update(tripId).digest("hex");
const b32 = (hex: string) => "0x" + hex;
const unb32 = (hex: string) => hex.replace(/^0x/, "").toLowerCase();

let cached: { rpc: string; provider: JsonRpcProvider } | null = null;
function provider() {
  const { rpc } = cfg();
  if (!cached || cached.rpc !== rpc) cached = { rpc, provider: new JsonRpcProvider(rpc, SEPOLIA.chainId, { staticNetwork: true }) };
  return cached.provider;
}
const reader = () => new Contract(cfg().contract, abi as InterfaceAbi, provider());
const writer = () => new Contract(cfg().contract, abi as InterfaceAbi, new Wallet(cfg().key, provider()));

/** Transactions this server sent and hasn't yet seen mined, per trip. */
const pending = new Map<string, { txHash: string; blocks: number; headHash: string; merkleRoot: string; sentAt: number }>();

export type OnChainAnchor = { index: number; blocks: number; anchoredAt: number; headHash: string; merkleRoot: string; txHash: string | null; txUrl: string | null };

export async function chainStatus() {
  const c = cfg();
  const base = {
    configured: chainConfigured(),
    network: SEPOLIA.name,
    chainId: SEPOLIA.chainId,
    explorer: SEPOLIA.explorer,
    contract: c.contract || null,
    contractUrl: c.contract ? `${SEPOLIA.explorer}/address/${c.contract}` : null,
    wallet: null as string | null,
    walletUrl: null as string | null,
    balanceEth: null as string | null,
    error: null as string | null,
  };
  if (!/^0x[0-9a-fA-F]{64}$/.test(c.key)) return base;
  const address = new Wallet(c.key).address;
  base.wallet = address;
  base.walletUrl = `${SEPOLIA.explorer}/address/${address}`;
  try {
    base.balanceEth = formatEther(await provider().getBalance(address));
  } catch (e) {
    base.error = `Couldn't reach Sepolia: ${(e as Error).message.slice(0, 120)}`;
  }
  return base;
}

/** Every anchor recorded for this trip, read straight from the contract, with the transaction that wrote it. */
export async function readAnchors(tripId: string): Promise<OnChainAnchor[]> {
  if (!chainConfigured()) return [];
  const key = tripKey(tripId);
  const c = reader();
  const count = Number(await c.count(key));
  const from = Math.max(0, count - 20);
  const anchors: OnChainAnchor[] = [];
  for (let i = from; i < count; i++) {
    const a = await c.get(key, i);
    anchors.push({ index: i, blocks: Number(a.blocks), anchoredAt: Number(a.anchoredAt) * 1000, headHash: unb32(a.headHash), merkleRoot: unb32(a.merkleRoot), txHash: null, txUrl: null });
  }
  // Transaction hashes come from the contract's Anchored events (best effort: public RPCs limit log ranges).
  try {
    // Ask the node directly: ethers caches getBlockNumber briefly, which can miss a just-mined seal.
    const latest = Number(await provider().send("eth_blockNumber", []));
    const step = 45_000;
    for (let to = latest; to >= cfg().deployBlock && anchors.some((a) => !a.txHash); to -= step) {
      // All Anchored events from our contract, matched to this trip here (some nodes mishandle topic filters).
      const logs = await c.queryFilter("Anchored", Math.max(cfg().deployBlock, to - step + 1), to);
      for (const log of logs) {
        const args = (log as unknown as { args: { tripKey: string; index: bigint } }).args;
        if (args.tripKey.toLowerCase() !== key.toLowerCase()) continue;
        const index = Number(args.index);
        const a = anchors.find((x) => x.index === index);
        if (a) {
          a.txHash = log.transactionHash;
          a.txUrl = `${SEPOLIA.explorer}/tx/${log.transactionHash}`;
        }
      }
      if (!cfg().deployBlock) break; // without a known deploy block, only look at the recent range
    }
  } catch {
    /* the anchors themselves are still valid without their tx links */
  }
  const p = pending.get(tripId);
  if (p && anchors.some((a) => a.blocks >= p.blocks)) pending.delete(tripId);
  return anchors;
}

export function pendingAnchor(tripId: string) {
  const p = pending.get(tripId);
  if (!p) return null;
  if (Date.now() - p.sentAt > 10 * 60_000) {
    pending.delete(tripId);
    return null;
  }
  return { ...p, txUrl: `${SEPOLIA.explorer}/tx/${p.txHash}` };
}

/** Sends one transaction that commits the trip's current chain to Sepolia. Returns as soon as it's broadcast. */
export async function anchorTrip(tripId: string, events: LedgerEvent[]) {
  if (!chainConfigured()) throw new HttpError(503, "Blockchain anchoring isn't set up on this server yet (see docs/BLOCKCHAIN.md)");
  const c = commitment(events);
  if (c.blocks === 0) throw new HttpError(400, "This trip has no blocks yet");
  const p = pendingAnchor(tripId);
  if (p) throw new HttpError(409, "An anchor for this trip is already on its way — wait for it to be mined", { txHash: p.txHash });
  const existing = await readAnchors(tripId);
  const last = existing.at(-1);
  if (last && last.blocks >= c.blocks) throw new HttpError(409, `Already anchored up to block #${last.blocks - 1} — add something to the trip first`);
  // A new seal may only EXTEND what is already sealed: the first `last.blocks` blocks must still
  // produce exactly the fingerprint on-chain. Otherwise someone rewrote history — refuse to bless it.
  if (last) {
    const prefix = commitment(events.slice(0, last.blocks));
    if (prefix.headHash !== last.headHash || prefix.merkleRoot !== last.merkleRoot) {
      throw new HttpError(409, `Refusing to seal: blocks #0–#${last.blocks - 1} no longer match the seal already on Ethereum — the history was changed`);
    }
  }
  try {
    const tx = await writer().anchor(tripKey(tripId), c.blocks, b32(c.headHash), b32(c.merkleRoot));
    pending.set(tripId, { txHash: tx.hash, blocks: c.blocks, headHash: c.headHash, merkleRoot: c.merkleRoot, sentAt: Date.now() });
    return { txHash: tx.hash as string, txUrl: `${SEPOLIA.explorer}/tx/${tx.hash}`, ...c };
  } catch (e) {
    const msg = (e as { shortMessage?: string; message: string }).shortMessage ?? (e as Error).message;
    if (/insufficient funds/i.test(msg)) throw new HttpError(402, "The app's Sepolia wallet is out of test ETH — top it up from a faucet");
    throw new HttpError(502, `Sepolia rejected the transaction: ${msg.slice(0, 160)}`);
  }
}
