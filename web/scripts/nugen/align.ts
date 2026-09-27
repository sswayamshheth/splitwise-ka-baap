/**
 * GroupTrip Intelligence — Nugen alignment pipeline (per docs.nugen.in / api.nugen.in/openapi-public.json).
 *
 *   npx vite-node --config vitest.config.ts scripts/nugen/align.ts build          # dataset only (no key needed)
 *   NUGEN_API_KEY=... npx vite-node --config vitest.config.ts scripts/nugen/align.ts run
 *   NUGEN_API_KEY=... npx vite-node --config vitest.config.ts scripts/nugen/align.ts status <alignment_id>
 *   NUGEN_API_KEY=... npx vite-node --config vitest.config.ts scripts/nugen/align.ts deploy <model_id>
 *
 * run:  1. build corpus + benchmark from real trips (.data/db.json) and the recorded real world capture
 *       2. POST /api/v3/documents/create (multipart, plain text)        → document_ids
 *       3. poll GET /api/v3/documents/{id}/status until READY
 *       4. POST /api/v3/benchmarks/upload (JSON [{sample_num,instruction,response}])  → benchmark_id
 *       5. POST /api/v3/alignment-projects/create {alignment_name, base_model_id, document_ids, benchmark_id}
 *       6. prints alignment_id; poll with `status`; when complete, GET /api/v3/alignment-projects/{id} gives model_id
 *       7. `deploy <model_id>` → POST /api/v3/models/{model_id}/deployment; then set NUGEN_MODEL_ID=<model_id>
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { buildDataset } from "@/lib/nugen/dataset";
import type { TwinWorld } from "@/lib/twin/twin";

const API = process.env.NUGEN_API_BASE || "https://api.nugen.in";
const KEY = process.env.NUGEN_API_KEY;
const BASE = process.env.NUGEN_BASE_MODEL || "qwen-v2p5-0p5b-instruct";
const OUT = path.join(process.cwd(), "data", "nugen");

async function call(method: string, p: string, body?: BodyInit, json = true): Promise<Record<string, unknown>> {
  if (!KEY) throw new Error("NUGEN_API_KEY is not set");
  const res = await fetch(`${API}${p}`, { method, headers: { authorization: `Bearer ${KEY}`, ...(json && body ? { "content-type": "application/json" } : {}) }, body });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

function build() {
  const db = JSON.parse(readFileSync(".data/db.json", "utf8")) as { events: Record<string, unknown[]> };
  const replayDir = path.join(process.cwd(), "data", "replay");
  const world = JSON.parse(readFileSync(path.join(replayDir, "candolim-north-goa.json"), "utf8")) as TwinWorld;
  const trips = Object.entries(db.events).map(([id, events]) => ({ id, events: events as never }));
  const { corpus, benchmark } = buildDataset(trips, world);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, "corpus.txt"), corpus);
  writeFileSync(path.join(OUT, "benchmark.json"), JSON.stringify(benchmark, null, 1));
  console.log(`corpus.txt ${corpus.length} chars · benchmark.json ${benchmark.length} samples → ${OUT}`);
  return { corpus, benchmark };
}

async function run() {
  const { corpus, benchmark } = build();
  const form = new FormData();
  form.append("files", new Blob([corpus], { type: "text/plain" }), "grouptrip-intelligence.txt");
  form.append("names", "GroupTrip Intelligence corpus");
  form.append("categories", "travel");
  const docs = await call("POST", "/api/v3/documents/create", form, false);
  const ids = docs.document_ids as string[];
  console.log("documents", ids);
  for (const id of ids) {
    for (let i = 0; i < 60; i++) {
      const st = await call("GET", `/api/v3/documents/${id}/status`);
      console.log("document", id, st.status);
      if (st.status === "READY") break;
      if (st.status === "FAILED") throw new Error(`document ${id} failed`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  const bform = new FormData();
  bform.append("file", new Blob([JSON.stringify(benchmark)], { type: "application/json" }), "benchmark.json");
  bform.append("document_id", ids[0]);
  bform.append("benchmark_name", "grouptrip-intelligence-v1");
  bform.append("description", "Scenario parsing, weather adaptation picks and grounded explanations from the GroupTrip Ledger engines");
  let benchmarkId: string | undefined;
  try {
    const b = await call("POST", "/api/v3/benchmarks/upload", bform, false);
    benchmarkId = b.benchmark_id as string;
    console.log("benchmark", benchmarkId);
  } catch (e) {
    console.warn("benchmark upload failed (alignment continues without it):", (e as Error).message);
  }
  const job = await call("POST", "/api/v3/alignment-projects/create", JSON.stringify({ alignment_name: "grouptrip-intelligence", base_model_id: BASE, document_ids: ids, benchmark_id: benchmarkId, description: "GroupTrip Intelligence: weather adaptation, What-If scenarios, grounded explanations" }));
  console.log("alignment", job);
  console.log(`\nSet NUGEN_ALIGNMENT_ID=${String(job.alignment_id)} and poll: scripts/nugen/align.ts status ${String(job.alignment_id)}`);
}

async function status(id: string) {
  console.log(await call("GET", `/api/v3/alignment-projects/${id}/status`));
  const full = await call("GET", `/api/v3/alignment-projects/${id}`);
  console.log(full);
  if (full.model_id) console.log(`\nAligned model: ${String(full.model_id)} → deploy: scripts/nugen/align.ts deploy ${String(full.model_id)}`);
}

async function deploy(modelId: string) {
  console.log(await call("POST", `/api/v3/models/${modelId}/deployment`));
  console.log(`\nWhen deployed, set NUGEN_MODEL_ID=${modelId} in the server env.`);
}

const [cmd, arg] = process.argv.slice(2);
const main = cmd === "run" ? run() : cmd === "status" ? status(arg) : cmd === "deploy" ? deploy(arg) : Promise.resolve(build());
main.catch((e) => {
  console.error(e.message);
  process.exit(1);
});
