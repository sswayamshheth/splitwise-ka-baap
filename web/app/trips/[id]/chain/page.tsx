"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { cx, Icon } from "@/components/app/kit";
import { buildChain, canonical, commitment, merkleProof, verifyChain, verifyMerkleProof, type Block } from "@/lib/chain/blocks";
import { api } from "@/lib/client/api";
import { useTrip } from "@/lib/client/trip";
import { buildNameLookup, describeEvent } from "@/lib/ledger/describe";
import type { LedgerEvent } from "@/lib/ledger/types";

type Anchor = { index: number; blocks: number; anchoredAt: number; headHash: string; merkleRoot: string; txHash: string | null; txUrl: string | null };
type ChainInfo = {
  status: { configured: boolean; network: string; chainId: number; explorer: string; contract: string | null; contractUrl: string | null; wallet: string | null; walletUrl: string | null; balanceEth: string | null; latestBlock: number | null; error: string | null };
  tripKey: string | null;
  anchors: Anchor[];
  pending: { txHash: string; txUrl: string; blocks: number } | null;
  readError: string | null;
};

const short = (h: string, n = 8) => `${h.slice(0, n)}…${h.slice(-4)}`;
const when = (ts: number) => new Date(ts).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

/** A copy of the events with one block's contents quietly edited — what a dishonest database edit would look like. */
function tamperedCopy(events: LedgerEvent[], height: number): { events: LedgerEvent[]; what: string } {
  const copy = structuredClone(events);
  const e = copy[height] as LedgerEvent & { expense?: { amountPaise: number; title: string } };
  if (e.type === "EXPENSE_ADDED" && e.expense) {
    e.expense.amountPaise += 100;
    return { events: copy, what: `"${e.expense.title}" made ₹1 more expensive` };
  }
  copy[height] = { ...copy[height], ts: copy[height].ts + 60_000 };
  return { events: copy, what: "its timestamp moved by one minute" };
}

/**
 * Blockchain proof: the trip's ledger as a chain of SHA-256 blocks, verified
 * here in the browser, and its fingerprint sealed on Ethereum Sepolia.
 */
export default function ChainPage() {
  const trip = useTrip();
  const base = `/trips/${trip.tripId}`;
  const [info, setInfo] = useState<ChainInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string; link?: string } | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [tamperAt, setTamperAt] = useState<number | null>(null);

  const [run, setRun] = useState(0);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [, setTick] = useState(0);

  const events = trip.events;
  // Timed so the judges can see the work happen: hash -> link check -> Merkle root.
  const timed = useMemo(() => {
    const t0 = performance.now();
    const blocks = buildChain(events);
    const t1 = performance.now();
    const check = verifyChain(blocks, events);
    const t2 = performance.now();
    const now = commitment(events);
    const t3 = performance.now();
    return { blocks, check, now, ms: { hash: t1 - t0, links: t2 - t1, merkle: t3 - t2 } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, run]);
  const { blocks, check, now } = timed;
  const names = useMemo(() => buildNameLookup(events, trip.meId), [events, trip.meId]);

  const load = useCallback(async () => {
    try {
      setInfo(await api<ChainInfo>(`/api/trips/${trip.tripId}/chain`));
      setLoadedAt(Date.now());
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [trip.tripId]);
  useEffect(() => {
    void load();
  }, [load]);
  // While a transaction is being mined (~12 s per Sepolia block), check again every few seconds;
  // otherwise refresh every 12 s so the live Ethereum block number keeps moving on screen.
  useEffect(() => {
    const t = setInterval(() => void load(), info?.pending ? 5000 : 12_000);
    return () => clearInterval(t);
  }, [info?.pending, load]);
  // Re-render every second for the "read Ns ago" counter.
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const latest = info?.anchors.at(-1) ?? null;
  // Does the ledger we have now still produce the fingerprint that was put on-chain?
  const verdictFor = (a: Anchor, evs: LedgerEvent[]) => {
    if (evs.length < a.blocks) return false;
    const c = commitment(evs.slice(0, a.blocks));
    return c.headHash === a.headHash && c.merkleRoot === a.merkleRoot;
  };
  // Every seal ever published must still match — re-sealing after an edit can't hide it.
  const failed = info ? info.anchors.filter((a) => !verdictFor(a, events)) : [];
  const latestOk = latest ? failed.length === 0 : null;
  const unanchored = latest ? blocks.length - latest.blocks : blocks.length;

  const tamper = useMemo(() => {
    if (tamperAt === null) return null;
    const t = tamperedCopy(events, tamperAt);
    const reChained = buildChain(t.events);
    return { ...t, check: verifyChain(blocks, t.events), reChained, onChainOk: info?.anchors.length ? info.anchors.every((a) => verdictFor(a, t.events)) : null };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tamperAt, events, blocks, info]);

  async function anchorNow() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ txHash: string; txUrl: string; blocks: number }>(`/api/trips/${trip.tripId}/chain`, { body: {} });
      setMsg({ tone: "ok", text: `Sent to Sepolia — sealing ${r.blocks} blocks. It's confirmed in a new Ethereum block in about 15 seconds.`, link: r.txUrl });
      await load();
    } catch (e) {
      setMsg({ tone: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const firstExpense = events.findIndex((e) => e.type === "EXPENSE_ADDED");
  const list = [...blocks].reverse();
  const visible = showAll ? list : list.slice(0, 12);
  const leaves = blocks.map((b) => b.hash);

  return (
    <main className="mx-auto flex w-full max-w-[520px] flex-1 flex-col gap-space-md px-margin pb-32 pt-space-xs">
      <section>
        <Link href={base} className="mb-1 inline-flex items-center gap-1 font-label-md text-label-md text-primary">
          <Icon name="arrow_back" className="text-[18px]" /> Trip
        </Link>
        <p className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">Tamper-proof ledger</p>
        <h2 className="font-headline-md text-headline-md tracking-tight text-on-surface">Blockchain proof</h2>
        <p className="mt-1 font-body-md text-body-md text-on-surface-variant">
          Every change to this trip is a block, sealed with SHA-256 and linked to the one before it. The chain&apos;s fingerprint is published on Ethereum, so no one — not even us — can quietly rewrite what happened.
        </p>
      </section>

      {/* live verification log: what just happened, step by step */}
      <section className="rounded-2xl bg-inverse-surface p-space-md text-inverse-on-surface shadow-sm">
        <div className="flex items-center justify-between gap-2">
          <p className="flex items-center gap-2 font-title-md text-title-md">
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary-fixed opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-primary-fixed" />
            </span>
            Live verification
          </p>
          <button
            onClick={() => {
              setRun((r) => r + 1);
              void load();
            }}
            className="flex items-center gap-1 rounded-full bg-white/10 px-3 py-1 font-label-md text-label-md hover:bg-white/20"
          >
            <Icon name="refresh" className="text-[16px]" /> Re-run
          </button>
        </div>
        <ol className="mt-space-sm space-y-1.5 font-mono text-[12px] leading-snug">
          <li>
            ✓ Hashed {blocks.length} ledger events with SHA-256 in this browser · {timed.ms.hash.toFixed(1)} ms
          </li>
          <li>
            {check.ok ? "✓" : "✗"} Checked {blocks.length} links (each block → previous block&apos;s hash) · {check.ok ? "intact" : `broken at #${check.brokenAt}`} · {timed.ms.links.toFixed(1)} ms
          </li>
          <li>
            ✓ Built the Merkle tree → root {short(now.merkleRoot)} · {timed.ms.merkle.toFixed(1)} ms
          </li>
          {info?.status.configured ? (
            <>
              <li>
                ✓ Connected to Ethereum Sepolia · latest Ethereum block{" "}
                <a href={`${info.status.explorer}/block/${info.status.latestBlock ?? ""}`} target="_blank" rel="noreferrer" className="underline">
                  #{info.status.latestBlock?.toLocaleString("en-US") ?? "…"}
                </a>
                {loadedAt ? ` · read ${Math.max(0, Math.round((Date.now() - loadedAt) / 1000))}s ago` : ""}
              </li>
              <li>
                ✓ Read {info.anchors.length} seal{info.anchors.length === 1 ? "" : "s"} from contract{" "}
                {info.status.contractUrl ? (
                  <a href={info.status.contractUrl} target="_blank" rel="noreferrer" className="underline">
                    {short(info.status.contract ?? "", 6)}
                  </a>
                ) : null}
                {latest ? ` → on-chain root ${short(latest.merkleRoot)}` : " → nothing sealed yet"}
              </li>
              {latest ? (
                <li className={latestOk ? "text-primary-fixed" : "text-error-container"}>
                  {latestOk ? "✓" : "✗"} Browser fingerprint {latestOk ? "=" : "≠"} Ethereum fingerprint for blocks #0–#{latest.blocks - 1}
                  {unanchored > 0 ? ` · ${unanchored} newer block${unanchored === 1 ? "" : "s"} waiting to be sealed` : " · everything sealed"}
                </li>
              ) : null}
            </>
          ) : info ? (
            <li>– Not connected to Ethereum on this server</li>
          ) : (
            <li className="animate-pulse">… contacting Ethereum Sepolia</li>
          )}
        </ol>
      </section>

      {/* the chain, drawn: last few blocks linked by their hashes, ending in the Ethereum seal */}
      <section className="-mx-margin overflow-x-auto px-margin">
        <div className="flex w-max items-stretch gap-1.5 pb-1">
          {blocks.slice(-4).map((b) => (
            <div key={b.height} className="flex items-center gap-1.5">
              <div className={cx("w-[132px] rounded-xl p-2 shadow-sm", latest && b.height < latest.blocks ? "bg-primary-fixed/50" : "bg-surface-container-lowest")}>
                <p className="font-title-md text-[13px] text-on-surface">Block #{b.height}</p>
                <p className="truncate font-label-sm text-[11px] text-on-surface-variant">{b.type.replace(/_/g, " ").toLowerCase()}</p>
                <p className="mt-1 font-mono text-[10px] text-on-surface">hash {b.hash.slice(0, 8)}</p>
                <p className="font-mono text-[10px] text-on-surface-variant">prev {b.prevHash.slice(0, 8)}</p>
              </div>
              <Icon name="arrow_forward" className="text-[16px] text-outline" />
            </div>
          ))}
          <div className={cx("flex w-[132px] flex-col justify-center rounded-xl p-2 shadow-sm", latestOk ? "bg-tertiary-fixed" : "bg-surface-container")}>
            <p className="flex items-center gap-1 font-title-md text-[13px] text-on-tertiary-fixed">
              <Icon name="deployed_code" className="text-[16px]" /> Ethereum
            </p>
            <p className="font-mono text-[10px] text-on-tertiary-fixed-variant">{latest ? `root ${latest.merkleRoot.slice(0, 8)}` : "not sealed"}</p>
            <p className="font-label-sm text-[11px] text-on-tertiary-fixed-variant">{latest ? `${latest.blocks} blocks sealed` : "press Seal below"}</p>
          </div>
        </div>
      </section>

      {/* 1 · local chain, verified in this browser */}
      <section className="rounded-2xl bg-surface-container-lowest p-space-md shadow-sm">
        <div className="flex items-center gap-space-sm">
          <span className={cx("flex h-10 w-10 items-center justify-center rounded-full", check.ok ? "bg-primary-container text-on-primary" : "bg-error text-on-error")}>
            <Icon name={check.ok ? "link" : "link_off"} />
          </span>
          <div>
            <p className="font-title-md text-title-md text-on-surface">{check.ok ? `Chain intact · ${blocks.length} blocks` : "Chain broken"}</p>
            <p className="font-label-sm text-label-sm text-on-surface-variant">Recomputed just now in your browser — not taken on our word</p>
          </div>
        </div>
        <dl className="mt-space-sm grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-label-md text-label-md">
          <dt className="text-on-surface-variant">Latest block hash</dt>
          <dd className="truncate font-mono text-on-surface" title={now.headHash}>{short(now.headHash, 12)}</dd>
          <dt className="text-on-surface-variant">Merkle root</dt>
          <dd className="truncate font-mono text-on-surface" title={now.merkleRoot}>{short(now.merkleRoot, 12)}</dd>
        </dl>
      </section>

      {/* 2 · on-chain anchor */}
      <section className="rounded-2xl bg-surface-container-lowest p-space-md shadow-sm">
        <div className="flex items-center gap-space-sm">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-tertiary-fixed text-on-tertiary-fixed-variant">
            <Icon name="deployed_code" />
          </span>
          <div className="min-w-0">
            <p className="font-title-md text-title-md text-on-surface">On-chain seal · {info?.status.network ?? "Ethereum Sepolia (testnet)"}</p>
            <p className="font-label-sm text-label-sm text-on-surface-variant">Only hashes go on-chain — no names, amounts or trip ids</p>
          </div>
        </div>

        {loadError ? <p className="mt-space-sm font-body-md text-body-md text-error">{loadError}</p> : null}
        {!info && !loadError ? <p className="mt-space-sm font-body-md text-body-md text-on-surface-variant">Reading the contract on Sepolia…</p> : null}

        {info && !info.status.configured ? (
          <p className="mt-space-sm rounded-xl bg-surface-container-low p-space-sm font-body-md text-body-md text-on-surface-variant">
            This server isn&apos;t connected to Sepolia yet. The chain above still works; see <code>docs/BLOCKCHAIN.md</code> to connect it (free, about 5 minutes).
          </p>
        ) : null}

        {info?.status.configured ? (
          <>
            {latest ? (
              <div className={cx("mt-space-sm rounded-xl p-space-sm", latestOk ? "bg-primary-fixed/40" : "bg-error-container")}>
                <p className={cx("flex items-center gap-1.5 font-title-md text-title-md", latestOk ? "text-on-primary-fixed-variant" : "text-on-error-container")}>
                  <Icon name={latestOk ? "verified" : "gpp_bad"} className="text-[20px]" />
                  {latestOk
                    ? `Blocks #0–#${latest.blocks - 1} match ${info.anchors.length === 1 ? "the seal" : `all ${info.anchors.length} seals`} on Ethereum`
                    : `History changed — it no longer matches the seal of ${when(failed[0].anchoredAt)}`}
                </p>
                <p className="mt-1 font-label-sm text-label-sm text-on-surface-variant">
                  Sealed {when(latest.anchoredAt)} · root {short(latest.merkleRoot)}
                  {latest.txUrl ? (
                    <>
                      {" · "}
                      <a href={latest.txUrl} target="_blank" rel="noreferrer" className="text-primary underline">
                        view transaction on Etherscan
                      </a>
                    </>
                  ) : null}
                </p>
              </div>
            ) : (
              <p className="mt-space-sm font-body-md text-body-md text-on-surface-variant">Not sealed on-chain yet.</p>
            )}

            {info.pending ? (
              <p className="mt-space-sm flex items-center gap-2 font-body-md text-body-md text-on-surface-variant">
                <Icon name="hourglass_top" className="animate-pulse text-[18px]" /> Waiting for Ethereum to mine the seal of {info.pending.blocks} blocks…{" "}
                <a href={info.pending.txUrl} target="_blank" rel="noreferrer" className="text-primary underline">
                  track it
                </a>
              </p>
            ) : null}

            <button
              onClick={() => void anchorNow()}
              disabled={busy || !!info.pending || unanchored <= 0}
              className="mt-space-sm flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary-container font-title-md text-title-md text-on-primary disabled:opacity-40"
            >
              <Icon name="lock" className="text-[20px]" />
              {busy ? "Sending…" : unanchored > 0 ? `Seal ${unanchored} new block${unanchored === 1 ? "" : "s"} on Ethereum` : "Everything is sealed"}
            </button>
            {msg ? (
              <p className={cx("mt-2 font-label-md text-label-md", msg.tone === "ok" ? "text-primary" : "text-error")}>
                {msg.text}{" "}
                {msg.link ? (
                  <a href={msg.link} target="_blank" rel="noreferrer" className="underline">
                    Etherscan
                  </a>
                ) : null}
              </p>
            ) : null}

            <details className="mt-space-sm font-label-sm text-label-sm text-on-surface-variant">
              <summary className="cursor-pointer text-primary">Verify it yourself on Etherscan</summary>
              <ol className="mt-1 list-decimal space-y-1 pl-5">
                <li>
                  Open the contract{" "}
                  {info.status.contractUrl ? (
                    <a href={info.status.contractUrl} target="_blank" rel="noreferrer" className="text-primary underline">
                      {short(info.status.contract ?? "", 10)}
                    </a>
                  ) : null}{" "}
                  → Read Contract → <code>count</code> / <code>get</code>.
                </li>
                <li>
                  Use this trip&apos;s on-chain key: <code className="break-all">{info.tripKey}</code>
                </li>
                <li>The headHash and merkleRoot you see there must equal the ones above.</li>
              </ol>
              {info.status.walletUrl ? (
                <p className="mt-1">
                  App wallet:{" "}
                  <a href={info.status.walletUrl} target="_blank" rel="noreferrer" className="text-primary underline">
                    {short(info.status.wallet ?? "", 10)}
                  </a>
                  {info.status.balanceEth ? ` · ${Number(info.status.balanceEth).toFixed(4)} SepoliaETH (free test money)` : ""}
                </p>
              ) : null}
              {info.status.error || info.readError ? <p className="mt-1 text-error">{info.status.error ?? info.readError}</p> : null}
            </details>

            {info.anchors.length > 1 ? (
              <div className="mt-space-sm">
                <p className="font-label-md text-label-md text-on-surface-variant">Seal history</p>
                {[...info.anchors].reverse().map((a) => (
                  <div key={a.index} className="flex items-center justify-between border-t border-surface-container py-1.5 font-label-sm text-label-sm">
                    <span>
                      #{a.index} · {a.blocks} blocks · {when(a.anchoredAt)}
                    </span>
                    <span className="flex items-center gap-2">
                      {verdictFor(a, events) ? <span className="text-primary">✓ matches</span> : <span className="text-error">✗ differs</span>}
                      {a.txUrl ? (
                        <a href={a.txUrl} target="_blank" rel="noreferrer" className="text-primary underline">
                          tx
                        </a>
                      ) : null}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
          </>
        ) : null}
      </section>

      {/* 3 · tamper demo */}
      <section className="rounded-2xl bg-surface-container-lowest p-space-md shadow-sm">
        <p className="font-title-md text-title-md text-on-surface">What if someone edits the database?</p>
        <p className="font-body-md text-body-md text-on-surface-variant">A simulation on a copy in your browser — the real ledger isn&apos;t touched.</p>
        <div className="mt-space-sm flex gap-2">
          <button
            onClick={() => setTamperAt(tamperAt === null ? Math.max(0, firstExpense) : null)}
            className={cx("flex h-11 flex-1 items-center justify-center gap-2 rounded-xl font-title-md text-title-md", tamperAt === null ? "bg-error text-on-error" : "bg-surface-container text-on-surface")}
          >
            <Icon name={tamperAt === null ? "edit_off" : "undo"} className="text-[20px]" />
            {tamperAt === null ? "Tamper with an old block" : "Undo simulation"}
          </button>
        </div>
        {tamper ? (
          <div className="mt-space-sm space-y-2 rounded-xl bg-error-container/60 p-space-sm font-body-md text-body-md text-on-error-container">
            <p>
              Block #{tamperAt} edited: {tamper.what}.
            </p>
            {!tamper.check.ok ? <p>🔗 {tamper.check.reason}. Every block after it now has a different hash — {blocks.length - (tamperAt ?? 0)} blocks break.</p> : null}
            <p>
              Even if the attacker re-seals the whole chain, the new Merkle root <code>{short(commitment(tamper.events).merkleRoot)}</code> ≠ the one on Ethereum{" "}
              <code>{latest ? short(latest.merkleRoot) : "(seal it first)"}</code>
              {tamper.onChainOk === false ? " → caught ✗" : ""}.
            </p>
            <label className="flex items-center gap-2 font-label-md text-label-md">
              Edit block
              <select value={tamperAt ?? 0} onChange={(e) => setTamperAt(Number(e.target.value))} className="rounded-lg border border-outline-variant bg-surface px-2 py-1">
                {blocks.map((b) => (
                  <option key={b.height} value={b.height}>
                    #{b.height} · {b.type.replace(/_/g, " ").toLowerCase()}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : null}
      </section>

      {/* 4 · the blocks */}
      <section>
        <h3 className="mb-space-sm font-headline-sm text-headline-sm text-on-surface">The blocks</h3>
        <div className="flex flex-col">
          {visible.map((b: Block) => {
            const d = describeEvent(events[b.height], names);
            const broken = tamper && tamperAt !== null && b.height >= tamperAt;
            const sealed = latest && b.height < latest.blocks;
            const isOpen = open === b.height;
            const proof = isOpen && latest && b.height < latest.blocks ? merkleProof(leaves.slice(0, latest.blocks), b.height) : null;
            return (
              <div key={b.height} className="flex gap-space-sm">
                <div className="flex flex-col items-center">
                  <span className={cx("mt-3 h-3 w-3 shrink-0 rounded-full", broken ? "bg-error" : sealed ? "bg-primary" : "bg-outline-variant")} />
                  <span className={cx("w-0.5 flex-1", broken ? "bg-error/50" : "bg-surface-container-high")} />
                </div>
                <button onClick={() => setOpen(isOpen ? null : b.height)} className={cx("mb-2 min-w-0 flex-1 rounded-xl p-space-sm text-left shadow-sm", broken ? "bg-error-container/70" : "bg-surface-container-lowest")}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-title-md text-[15px] text-on-surface">
                      #{b.height} · {d.title}
                    </span>
                    <span className="shrink-0 font-label-sm text-label-sm text-on-surface-variant">{sealed ? "sealed ✓" : "not sealed yet"}</span>
                  </div>
                  <p className="mt-0.5 font-mono text-[11px] text-on-surface-variant">
                    hash {short(broken && tamper ? tamper.reChained[b.height].hash : b.hash)} ← prev {short(broken && tamper ? tamper.reChained[b.height].prevHash : b.prevHash)}
                  </p>
                  {isOpen ? (
                    <div className="mt-2 space-y-1 break-all font-mono text-[11px] text-on-surface">
                      <p>dataHash = SHA-256(event JSON) = {b.dataHash}</p>
                      <p>prevHash = {b.prevHash}</p>
                      <p>
                        hash = SHA-256({b.height} | prevHash | dataHash | {b.ts}) = {b.hash}
                      </p>
                      <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-container-low p-2">{canonical(events[b.height]).slice(0, 1200)}</pre>
                      {proof && latest ? (
                        <p className="font-body-md text-[12px] text-primary">
                          Merkle proof: {proof.length} sibling hashes lead from this block to the on-chain root →{" "}
                          {verifyMerkleProof(b.hash, proof, latest.merkleRoot) ? "included ✓" : "not included ✗"}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </button>
              </div>
            );
          })}
        </div>
        {list.length > visible.length ? (
          <button onClick={() => setShowAll(true)} className="font-label-md text-label-md text-primary">
            Show all {list.length} blocks
          </button>
        ) : null}
      </section>
    </main>
  );
}
