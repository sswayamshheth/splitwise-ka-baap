// Creates the app's own Sepolia wallet (once) and a salt for hiding trip ids,
// saved in web/.env.local. Prints only the PUBLIC address — paste that into a
// Sepolia faucet to get free test ETH.
// Run from web/:  npm run chain:wallet
import { randomBytes } from "node:crypto";
import { JsonRpcProvider, Wallet, formatEther } from "ethers";

import { EXPLORER, readEnv, rpcUrl, writeEnv } from "./env.mjs";

const env = readEnv();
let key = env.ANCHOR_PRIVATE_KEY;
if (!key) {
  key = Wallet.createRandom().privateKey;
  writeEnv({ ANCHOR_PRIVATE_KEY: key });
  console.log("Created a new wallet and saved its private key in web/.env.local (never share or commit that file).");
}
if (!env.ANCHOR_SALT) writeEnv({ ANCHOR_SALT: randomBytes(32).toString("hex") });

const wallet = new Wallet(key);
console.log(`\nWallet address: ${wallet.address}`);
console.log(`Explorer:       ${EXPLORER}/address/${wallet.address}`);
try {
  const bal = await new JsonRpcProvider(rpcUrl(env)).getBalance(wallet.address);
  console.log(`Balance:        ${formatEther(bal)} SepoliaETH (test money, worth nothing)`);
  if (bal === 0n) console.log("\nNext: get free test ETH — open https://cloud.google.com/application/web3/faucet/ethereum/sepolia, paste the address above, then run: npm run chain:deploy");
} catch (e) {
  console.log(`(Couldn't reach the Sepolia RPC to check the balance: ${e.shortMessage ?? e.message})`);
}
