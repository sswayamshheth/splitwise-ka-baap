// Tiny helpers shared by the chain scripts: read/update web/.env.local
// without ever printing secret values.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const ENV_FILE = path.resolve(process.cwd(), ".env.local");
export const DEFAULT_RPC = "https://ethereum-sepolia-rpc.publicnode.com";
export const CHAIN_ID = 11155111n; // Ethereum Sepolia testnet
export const EXPLORER = "https://sepolia.etherscan.io";

export function readEnv() {
  const env = {};
  if (!existsSync(ENV_FILE)) return env;
  for (const line of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

/** Sets KEY=value lines in .env.local, keeping everything else as it is. */
export function writeEnv(values) {
  let text = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : "";
  for (const [k, v] of Object.entries(values)) {
    const re = new RegExp(`^${k}=.*$`, "m");
    text = re.test(text) ? text.replace(re, `${k}=${v}`) : `${text}${text && !text.endsWith("\n") ? "\n" : ""}${k}=${v}\n`;
  }
  writeFileSync(ENV_FILE, text);
}

export const rpcUrl = (env) => env.ANCHOR_RPC_URL || DEFAULT_RPC;
