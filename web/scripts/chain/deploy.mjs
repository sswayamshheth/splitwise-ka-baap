// Deploys contracts/TripLedgerAnchor.json to Ethereum Sepolia with the app's
// wallet and saves the contract address in web/.env.local.
// Run from web/:  npm run chain:deploy
import { readFileSync } from "node:fs";
import path from "node:path";
import { ContractFactory, JsonRpcProvider, Wallet, formatEther } from "ethers";

import { CHAIN_ID, EXPLORER, readEnv, rpcUrl, writeEnv } from "./env.mjs";

const env = readEnv();
if (!env.ANCHOR_PRIVATE_KEY) {
  console.error("No wallet yet. Run: npm run chain:wallet");
  process.exit(1);
}
const provider = new JsonRpcProvider(rpcUrl(env));
const net = await provider.getNetwork();
if (net.chainId !== CHAIN_ID) {
  console.error(`That RPC is chain ${net.chainId}, not Sepolia (${CHAIN_ID}). Refusing to deploy.`);
  process.exit(1);
}
const wallet = new Wallet(env.ANCHOR_PRIVATE_KEY, provider);
const bal = await provider.getBalance(wallet.address);
console.log(`Wallet ${wallet.address} has ${formatEther(bal)} SepoliaETH`);
if (bal === 0n) {
  console.error("The wallet has no test ETH yet. Use a faucet first (see npm run chain:wallet).");
  process.exit(1);
}
if (env.ANCHOR_CONTRACT && !process.argv.includes("--force")) {
  console.log(`Already deployed at ${env.ANCHOR_CONTRACT} (${EXPLORER}/address/${env.ANCHOR_CONTRACT}). Use --force to deploy a new one.`);
  process.exit(0);
}

const artifact = JSON.parse(readFileSync(path.resolve(process.cwd(), "..", "contracts", "TripLedgerAnchor.json"), "utf8"));
const factory = new ContractFactory(artifact.abi, artifact.bytecode, wallet);
console.log("Deploying TripLedgerAnchor…");
const contract = await factory.deploy();
const tx = contract.deploymentTransaction();
console.log(`Transaction: ${EXPLORER}/tx/${tx.hash}`);
const receipt = await tx.wait(1);
const address = await contract.getAddress();
writeEnv({ ANCHOR_CONTRACT: address, ANCHOR_DEPLOY_BLOCK: String(receipt.blockNumber) });
console.log(`\nDeployed at ${address} in block ${receipt.blockNumber}`);
console.log(`Contract:    ${EXPLORER}/address/${address}`);
console.log("Saved ANCHOR_CONTRACT and ANCHOR_DEPLOY_BLOCK in web/.env.local. Restart the app to pick them up.");
