# Blockchain in GroupTrip Ledger

**One line:** every change to a trip is a SHA-256 block linked to the one before it, and the chain's fingerprint is sealed on Ethereum — so nobody (including us, the app's owners) can quietly rewrite who paid what.

Everything here is free: Ethereum **Sepolia** is a public test network (test ETH from a faucet, worth nothing), reads go through a free public RPC (`ethereum-sepolia-rpc.publicnode.com`), and the explorer is Etherscan.

## How it works

```
 ledger event (expense added, someone leaves, refund…)
        │  canonical JSON (keys sorted)
        ▼
 dataHash = SHA-256(event)
 hash     = SHA-256(height | prevHash | dataHash | timestamp)      ← block
        │
 block #0 ──► block #1 ──► block #2 ──► … ──► block #N   (each stores the previous hash)
        │
 Merkle root over all block hashes (one 32-byte fingerprint of the whole history)
        │
        ▼
 Ethereum Sepolia · TripLedgerAnchor contract
   anchor(tripKey, blocks, headHash, merkleRoot)   ← one transaction, signed by the app's wallet
```

| Piece | Where | What it guarantees |
|---|---|---|
| SHA-256 hash chain | `web/lib/chain/blocks.ts`, `sha256.ts` | Change one rupee in block 5 → its hash changes → block 6 no longer points to it → every later block breaks. Deleting or reordering blocks breaks it too. |
| Merkle tree | `blocks.ts` (`merkleRoot`, `merkleProof`) | One root commits to every block; a short proof shows a single block is included without revealing the others. |
| Browser verification | `web/app/trips/[id]/chain/page.tsx` | The browser recomputes every hash itself — you don't take the server's word for it. |
| Smart contract | `contracts/TripLedgerAnchor.sol` | Stores `(blocks, headHash, merkleRoot, time)` per trip. **Append-only**: only the app wallet can write, and the block count must grow. Old seals can never be changed or deleted, so a rewritten history is always caught against them. The server also refuses to seal a chain whose earlier blocks no longer match the previous seal, and the page checks the ledger against **every** seal ever published, not just the latest. |
| Privacy | `web/lib/server/chain.ts` | Only hashes go on-chain. The trip is identified by `HMAC-SHA256(ANCHOR_SALT, tripId)`, so an outsider can't even tell which trip an anchor belongs to. No names, amounts, UPI ids or phone numbers leave the app. |
| Signing | Ethereum transaction (ECDSA secp256k1) | Each anchor is signed by the app's wallet; the private key lives only in the server's environment. |

**What goes on-chain vs off-chain**

- Off-chain (in the app's database): the full ledger events — needed to compute balances, never public.
- On-chain (public, permanent): 3 hashes + a count per anchor. Costs a fraction of a cent of *test* ETH.

**What it does NOT do (be honest with judges):** it doesn't move money on-chain (payments are Razorpay test mode / UPI), and it doesn't encrypt the database — its job is *integrity* (tamper-evidence), not secrecy. Secrecy comes from putting only salted hashes on-chain.

## Demo script (60 seconds)

1. Open a trip → **Blockchain proof**. "Chain intact · N blocks" — computed in this browser.
2. Tap **Seal N new blocks on Ethereum** → Etherscan link → the transaction is public.
3. Open **Verify it yourself on Etherscan** → contract → Read Contract → `get(tripKey, 0)`: the same `headHash` and `merkleRoot` as the app shows.
4. Tap **Tamper with an old block** (simulation on a copy): the chain breaks from that block on, and even a re-sealed chain has a different Merkle root than the one on Ethereum → caught.
5. Add an expense in the app → the Blockchain page shows "1 new block not sealed yet" → seal it → the contract refuses to ever go back to the old count.

## Setup (once, ~5 minutes, free)

From `web/`:

```bash
npm run chain:wallet     # creates the app wallet + salt in .env.local, prints the PUBLIC address
# get free Sepolia test ETH for that address:
#   https://cloud.google.com/application/web3/faucet/ethereum/sepolia   (Google sign-in, 0.05 ETH/day)
#   (alternatives: https://sepolia-faucet.pk910.de — browser mining, no sign-in)
npm run chain:wallet     # run again: should now show a balance
npm run chain:deploy     # deploys the contract, saves ANCHOR_CONTRACT + ANCHOR_DEPLOY_BLOCK in .env.local
# restart the app (npm run build && npm start, or npm run dev)
```

`npm run chain:compile` recompiles `contracts/TripLedgerAnchor.sol` (solc 0.8.28, offline) into `contracts/TripLedgerAnchor.json` and `web/lib/chain/TripLedgerAnchor.abi.json`.

Environment (all server-side, in `web/.env.local`, never committed):

| Variable | Meaning |
|---|---|
| `ANCHOR_PRIVATE_KEY` | The app wallet's private key (test wallet only — never put real funds in it). |
| `ANCHOR_SALT` | Secret salt that hides trip ids on-chain. |
| `ANCHOR_CONTRACT` | Deployed `TripLedgerAnchor` address. |
| `ANCHOR_DEPLOY_BLOCK` | Block it was deployed in (speeds up finding transaction links). |
| `ANCHOR_RPC_URL` | Optional; defaults to the free publicnode Sepolia RPC. |

For Vercel, add the same variables in the project's environment settings.

## Tests

- `web/tests/chain.test.ts` — SHA-256 matches Node's crypto (incl. ₹ and emoji), chain links, key-order independence, tamper / delete / reorder detection, Merkle proofs for every leaf.
- `web/tests/chain-onchain.test.ts` — deploys the **real contract** on a local in-memory Ethereum node (Sepolia chain id, no network, no ETH) and runs the **real server code**: anchor, read back identical hashes, reject re-anchoring or rewinding, reject writes from other wallets, trip ids never appear on-chain.
