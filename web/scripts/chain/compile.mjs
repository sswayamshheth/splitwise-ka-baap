// Compiles contracts/TripLedgerAnchor.sol with solc-js (no internet needed)
// and writes the ABI + bytecode to contracts/TripLedgerAnchor.json.
// Run from web/:  npm run chain:compile
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const solc = require("solc");
const dir = path.resolve(process.cwd(), "..", "contracts");
const source = readFileSync(path.join(dir, "TripLedgerAnchor.sol"), "utf8");
const input = {
  language: "Solidity",
  sources: { "TripLedgerAnchor.sol": { content: source } },
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "paris", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (out.errors ?? []).filter((e) => e.severity === "error");
if (errors.length) {
  console.error(errors.map((e) => e.formattedMessage).join("\n"));
  process.exit(1);
}
const c = out.contracts["TripLedgerAnchor.sol"].TripLedgerAnchor;
writeFileSync(
  path.join(dir, "TripLedgerAnchor.json"),
  JSON.stringify({ contractName: "TripLedgerAnchor", compiler: `solc ${solc.version()}`, abi: c.abi, bytecode: "0x" + c.evm.bytecode.object }, null, 2) + "\n",
);
// The app imports the ABI from inside web/ (Next only bundles files in the project).
writeFileSync(path.resolve(process.cwd(), "lib", "chain", "TripLedgerAnchor.abi.json"), JSON.stringify(c.abi, null, 2) + "\n");
console.log(`Compiled with solc ${solc.version()} → contracts/TripLedgerAnchor.json (${c.evm.bytecode.object.length / 2} bytes)`);
