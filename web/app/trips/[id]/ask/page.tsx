"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { cx, Icon, useFeedback } from "@/components/app/kit";
import { Face, FacePair } from "@/components/app/money/parts";
import { askClaude, proxyHealth, type AgentState, type AgentTurn, type ToolCallRecord } from "@/lib/ai/agent";
import { answerOffline } from "@/lib/ai/offline";
import type { ToolContext } from "@/lib/ai/tools";
import { extractAmounts } from "@/lib/ai/verify";
import { errorText, useTrip } from "@/lib/client/trip";
import { buildChangeEvents, type Change } from "@/lib/ledger/simulate";

/**
 * Ask the ledger (styled after the Stitch ai_trip_builder + whiteboard
 * screens). Claude (via /api/ai) or a rule-based offline router turns the
 * question into engine tool calls that run here, on this trip's own ledger.
 * Each answer shows the calls that produced it and a check that every ₹
 * figure came from them. The assistant can read and simulate; only the Apply
 * button (with confirmation) writes anything.
 */

type Mode = "claude" | "offline";
type Entry = { id: number; role: "user"; text: string } | { id: number; role: "assistant"; mode: Mode; turn: AgentTurn; notice?: string; applied?: number };

const SUGGESTIONS: { q: string; tag: string; icon: string }[] = [
  { q: "Who owes the most?", tag: "Balances", icon: "account_balance_wallet" },
  { q: "What if Siya leaves today?", tag: "What if", icon: "science" },
  { q: "What if the hotel price increases by ₹5,000?", tag: "What if", icon: "price_change" },
  { q: "Can we keep the trip below ₹1,00,000?", tag: "Budget", icon: "savings" },
  { q: "Why do I owe money?", tag: "Explain", icon: "help" },
  { q: "How much have we spent on stays?", tag: "Spending", icon: "hotel" },
  { q: "Is anything inconsistent?", tag: "Checks", icon: "rule" },
  { q: "How do we settle with fewest payments?", tag: "Settle", icon: "swap_horiz" },
];

const NOTE_TONES = ["bg-surface-container-lowest", "bg-surface-container", "bg-secondary-fixed/40", "bg-tertiary-fixed/50"];

const TOOL_LABELS: Record<string, string> = {
  get_trip_health: "Trip health",
  get_balances: "Balances",
  explain_balance: "Balance breakdown",
  get_spending: "Spending by category",
  list_bookings: "Bookings & participation",
  simulate_change: "What-if simulation (not applied)",
  get_settlement_plan: "Settlement optimiser",
  get_anomalies: "Consistency checks",
  check_budget_target: "Budget target check",
};

type SimData = { changeSpec: Change; change?: string; ledgerEventsToWrite?: number; tripSpend?: { before: { text: string }; after: { text: string } } };

export default function AskPage() {
  const trip = useTrip();
  const router = useRouter();
  const { confirm, toast } = useFeedback();
  const [health, setHealth] = useState<{ checked: boolean; ok: boolean; hasKey: boolean }>({ checked: false, ok: false, hasKey: false });
  const [mode, setMode] = useState<Mode>("offline");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const agentState = useRef<AgentState>({ messages: [] });
  const nextId = useRef(1);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    void proxyHealth(controller.signal).then((h) => {
      setHealth({ checked: true, ok: h.ok, hasKey: h.hasKey });
      if (h.ok && h.hasKey) setMode("claude");
    });
    return () => controller.abort();
  }, []);

  const claudeReady = health.ok && health.hasKey;
  const closed = trip.state.trip.status === "closed";
  const members = trip.state.participants.filter((p) => !p.leftOn);
  const ctx = (): ToolContext => ({ state: trip.state, ledger: trip.ledger, events: trip.events, viewerId: trip.meId, now: Date.now() });

  const applyChange = async (entryId: number, data: SimData) => {
    const ok = await confirm({
      title: "Apply this change to the trip?",
      message: `This is a real change, not a simulation: ${data.change ?? "the change"}. ${data.ledgerEventsToWrite ?? "The"} ledger event${data.ledgerEventsToWrite === 1 ? "" : "s"} will be written${
        data.tripSpend ? `; trip cost ${data.tripSpend.before.text} → ${data.tripSpend.after.text}` : ""
      }. Every balance and the settlement plan update accordingly.`,
      confirm: "Apply",
    });
    if (!ok) return;
    try {
      // Rebuilt on the live state at this moment, through the same validated commands.
      const written = await trip.run((state, c) => buildChangeEvents(state, data.changeSpec, c));
      setEntries((all) => all.map((e) => (e.id === entryId && e.role === "assistant" ? { ...e, applied: written.length } : e)));
      toast(`Applied · ${written.length} ledger event${written.length === 1 ? "" : "s"} written`);
    } catch (e) {
      toast(errorText(e), "error");
    }
  };

  const ask = async (question: string) => {
    const q = question.trim();
    if (!q || busy) return;
    setInput("");
    setEntries((e) => [...e, { id: nextId.current++, role: "user", text: q }]);
    setBusy(true);
    let entry: Entry;
    if (mode === "claude" && claudeReady) {
      try {
        const { turn, state } = await askClaude(agentState.current, q, ctx());
        agentState.current = state;
        entry = { id: nextId.current++, role: "assistant", mode: "claude", turn };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        entry = { id: nextId.current++, role: "assistant", mode: "offline", turn: answerOffline(q, ctx()), notice: `Claude unavailable (${reason}) — answered in offline mode.` };
      }
    } else {
      entry = { id: nextId.current++, role: "assistant", mode: "offline", turn: answerOffline(q, ctx()) };
    }
    setEntries((e) => [...e, entry]);
    setBusy(false);
    setTimeout(() => bottom.current?.scrollIntoView({ behavior: "smooth" }), 50);
  };

  return (
    <>
      <main className="mx-auto flex w-full max-w-[520px] flex-1 flex-col px-margin pb-44 pt-space-sm">
        {/* Editorial intro */}
        <span className="inline-flex items-center gap-1.5 self-start rounded-full bg-secondary-fixed/70 px-3 py-1 font-label-sm text-label-sm uppercase tracking-wider text-on-secondary-fixed-variant">
          <Icon name="auto_awesome" className="text-[14px]" /> Ledger assistant
        </span>
        <h2 className="mt-space-sm font-display-lg-mobile text-display-lg-mobile text-on-surface">Ask the ledger.</h2>
        <p className="mt-space-xs font-body-md text-body-md text-on-surface-variant">
          Plain-language questions, answered from {members.length} traveller{members.length === 1 ? "" : "s"}&apos; shared ledger — every figure computed by the engine, never guessed.
        </p>

        {/* Mode card */}
        <div className="mt-space-md flex flex-col gap-space-sm rounded-2xl bg-surface-container-low p-space-md">
          <div className="flex items-center gap-space-sm">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary-container text-on-primary">
              <Icon name={mode === "claude" ? "auto_awesome" : "rule"} className="text-[22px]" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-title-lg text-title-lg text-on-surface">{!health.checked ? "Checking the assistant…" : mode === "claude" ? "Claude · reads through ledger tools" : "Offline mode · rule-based"}</p>
              <p className="font-label-md text-label-md text-on-surface-variant">
                {claudeReady ? "Can read and simulate; only Apply (with confirmation) writes." : "Answers come from fixed templates over the same ledger tools."}
              </p>
            </div>
          </div>
          {claudeReady ? (
          <div className="grid grid-cols-2 gap-1 rounded-full bg-surface-container-high p-1">
            <button
              disabled={!claudeReady}
              onClick={() => claudeReady && setMode("claude")}
              className={cx("flex items-center justify-center gap-1 rounded-full py-1.5 font-label-md text-label-md transition-all disabled:opacity-40", mode === "claude" ? "bg-primary-container text-on-primary shadow-sm" : "text-on-surface-variant")}
            >
              <Icon name="auto_awesome" className="text-[16px]" /> {claudeReady ? "Claude" : "Claude (unavailable)"}
            </button>
            <button
              onClick={() => setMode("offline")}
              className={cx("flex items-center justify-center gap-1 rounded-full py-1.5 font-label-md text-label-md transition-all", mode === "offline" ? "bg-primary-container text-on-primary shadow-sm" : "text-on-surface-variant")}
            >
              <Icon name="rule" className="text-[16px]" /> Offline — no LLM
            </button>
          </div>
          ) : null}
        </div>

        {/* Pinned questions (whiteboard notes) */}
        {entries.length === 0 ? (
          <div className="mt-space-lg flex flex-col gap-space-sm">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1 font-label-md text-label-md uppercase tracking-wider text-on-surface-variant">
                <Icon name="push_pin" className="text-[16px]" /> Pinned questions
              </span>
              <FacePair names={members.slice(0, 3).map((p) => p.name)} size={24} />
            </div>
            <div className="grid grid-cols-2 gap-space-sm">
              {SUGGESTIONS.map((s, i) => (
                <button
                  key={s.q}
                  onClick={() => void ask(s.q)}
                  className={cx("flex flex-col gap-space-xs rounded-2xl p-space-md text-left shadow-sm transition-shadow hover:shadow-md", NOTE_TONES[i % NOTE_TONES.length])}
                >
                  <span className="flex items-center justify-between">
                    <span className="inline-flex items-center gap-1 rounded-full bg-surface-container-lowest/70 px-2 py-0.5 font-label-sm text-label-sm text-primary">
                      <span className="h-1.5 w-1.5 rounded-full bg-primary" /> {s.tag}
                    </span>
                    <Icon name={s.icon} className="text-[18px] text-on-surface-variant" />
                  </span>
                  <span className="font-headline-sm text-[17px] leading-snug text-on-surface">{s.q}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {/* Conversation */}
        <div className="mt-space-lg flex flex-col gap-space-md">
          {entries.map((e) =>
            e.role === "user" ? (
              <div key={e.id} className="flex items-end justify-end gap-space-sm">
                <div className="max-w-[80%] rounded-2xl rounded-br-md bg-primary-container px-space-md py-space-sm font-body-md text-body-md text-on-primary shadow-sm">{e.text}</div>
                <Face name={trip.fullName(trip.meId)} size={32} />
              </div>
            ) : (
              <AnswerCard
                key={e.id}
                entry={e}
                closed={closed}
                onOpenSimulator={(change) => router.push(`/trips/${trip.tripId}/simulate?change=${encodeURIComponent(JSON.stringify(change))}`)}
                onApply={(data) => applyChange(e.id, data)}
              />
            ),
          )}
          {busy ? (
            <div className="flex items-center gap-space-sm rounded-2xl bg-surface-container-low p-space-md text-on-surface-variant">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              <span className="font-body-md">{mode === "claude" ? "Claude is querying the ledger…" : "Querying the ledger…"}</span>
            </div>
          ) : null}
          {entries.length > 0 ? (
            <div className="flex gap-space-sm overflow-x-auto pb-1">
              {SUGGESTIONS.slice(0, 5).map((s) => (
                <button key={s.q} onClick={() => void ask(s.q)} className="shrink-0 rounded-full bg-surface-container-low px-space-md py-space-xs font-label-md text-label-md text-on-surface-variant hover:bg-surface-variant">
                  {s.q}
                </button>
              ))}
            </div>
          ) : null}
          <div ref={bottom} />
        </div>
      </main>

      {/* Composer */}
      <div className="fixed inset-x-0 bottom-0 z-40 bg-surface/85 pb-[env(safe-area-inset-bottom)] shadow-[0_-2px_12px_rgba(16,32,28,0.04)] backdrop-blur-xl">
        <form
          className="mx-auto flex max-w-[520px] items-center gap-space-sm px-margin py-space-sm"
          onSubmit={(ev) => {
            ev.preventDefault();
            void ask(input);
          }}
        >
          <input
            className="h-12 flex-1 rounded-full border border-outline-variant bg-surface-container-lowest px-space-lg font-body-md text-body-md text-on-surface outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about balances, spending, or a what-if…"
            aria-label="Question"
            disabled={busy}
          />
          <button
            type="submit"
            aria-label="Ask"
            disabled={busy || !input.trim()}
            className="flex h-12 w-12 items-center justify-center rounded-full bg-primary-container text-on-primary shadow-[0_8px_20px_rgba(30,111,100,0.35)] transition-all active:scale-95 disabled:opacity-40"
          >
            <Icon name="send" className="text-[22px]" />
          </button>
        </form>
      </div>
    </>
  );
}

function AnswerCard({ entry, closed, onOpenSimulator, onApply }: { entry: Extract<Entry, { role: "assistant" }>; closed: boolean; onOpenSimulator: (c: Change) => void; onApply: (d: SimData) => Promise<void> }) {
  const { turn } = entry;
  const [applying, setApplying] = useState(false);
  const unverified = new Set(turn.verification.unverified);
  const total = turn.verification.verified.length + turn.verification.unverified.length;
  const sim = turn.calls.find((c) => c.name === "simulate_change" && c.result.ok);
  const simData = sim ? ((sim.result as unknown as { data: SimData }).data ?? null) : null;
  return (
    <div className="overflow-hidden rounded-2xl bg-surface-container-lowest shadow-sm">
      <div className="flex flex-col gap-space-sm p-space-md">
        <div className="flex flex-wrap items-center gap-space-xs">
          <span
            className={cx(
              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-label-sm text-label-sm",
              entry.mode === "claude" ? "bg-tertiary-fixed text-on-tertiary-fixed-variant" : "bg-surface-container text-on-surface-variant",
            )}
          >
            <Icon name={entry.mode === "claude" ? "auto_awesome" : "rule"} className="text-[13px]" />
            {entry.mode === "claude" ? `Claude${turn.model ? ` · ${turn.model}` : ""}` : "Offline — rule-based, no LLM"}
          </span>
          {total > 0 ? (
            unverified.size === 0 ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-primary-fixed/60 px-2 py-0.5 font-label-sm text-label-sm text-on-primary-fixed-variant">
                <Icon name="verified" className="text-[13px]" /> All {total} figure{total === 1 ? "" : "s"} verified against the ledger
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-error-container px-2 py-0.5 font-label-sm text-label-sm text-on-error-container">
                <Icon name="report" className="text-[13px]" /> {unverified.size} of {total} figures not in engine output
              </span>
            )
          ) : null}
        </div>
        {entry.notice ? <p className="font-label-md text-label-md text-on-secondary-fixed-variant">{entry.notice}</p> : null}
        <HighlightedText text={turn.text} unverified={unverified} />
        {simData ? (
          <div className="flex flex-col gap-space-sm pt-space-xs">
            {entry.applied ? (
              <span className="inline-flex items-center gap-1 self-start rounded-full bg-primary-fixed/60 px-space-sm py-1 font-label-md text-label-md text-on-primary-fixed-variant">
                <Icon name="check_circle" className="text-[16px]" /> Applied · {entry.applied} ledger event{entry.applied === 1 ? "" : "s"} written
              </span>
            ) : (
              <button
                disabled={closed || applying}
                onClick={async () => {
                  setApplying(true);
                  await onApply(simData);
                  setApplying(false);
                }}
                className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary-container font-title-md text-title-md text-on-primary shadow-sm disabled:opacity-40"
              >
                Apply this change <Icon name="arrow_forward" className="text-[20px]" />
              </button>
            )}
            <button onClick={() => onOpenSimulator(simData.changeSpec)} className="flex items-center justify-center gap-1 font-label-md text-label-md text-primary">
              <Icon name="science" className="text-[16px]" /> Open in simulator to see every line
            </button>
          </div>
        ) : null}
      </div>
      {turn.calls.length ? <EngineCalls calls={turn.calls} /> : null}
    </div>
  );
}

function HighlightedText({ text, unverified }: { text: string; unverified: Set<string> }) {
  if (!unverified.size) return <p className="whitespace-pre-wrap font-body-md text-body-md text-on-surface">{text}</p>;
  const parts: { t: string; flag: boolean }[] = [];
  let last = 0;
  for (const a of extractAmounts(text)) {
    const at = text.indexOf(a.raw, last);
    if (at < 0) continue;
    parts.push({ t: text.slice(last, at), flag: false }, { t: a.raw, flag: unverified.has(a.raw) });
    last = at + a.raw.length;
  }
  parts.push({ t: text.slice(last), flag: false });
  return (
    <p className="whitespace-pre-wrap font-body-md text-body-md text-on-surface">
      {parts.map((p, i) =>
        p.flag ? (
          <mark key={i} className="rounded bg-error-container px-0.5 font-semibold text-on-error-container" title="Not found in any engine output">
            {p.t}
          </mark>
        ) : (
          <span key={i}>{p.t}</span>
        ),
      )}
    </p>
  );
}

function EngineCalls({ calls }: { calls: ToolCallRecord[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-space-sm bg-surface-container-low px-space-md py-space-sm">
      <button className="flex items-center gap-space-sm text-left" onClick={() => setOpen(!open)}>
        <Icon name="memory" className="text-[18px] text-on-surface-variant" />
        <span className="flex-1 font-label-md text-label-md text-on-surface-variant">Engine calls ({calls.length}) — where these numbers came from</span>
        <Icon name={open ? "expand_less" : "expand_more"} className="text-on-surface-variant" />
      </button>
      {open ? calls.map((c) => <CallCard key={c.id} call={c} />) : null}
    </div>
  );
}

function CallCard({ call }: { call: ToolCallRecord }) {
  const [raw, setRaw] = useState(false);
  const input = call.input && typeof call.input === "object" && Object.keys(call.input as object).length ? JSON.stringify(call.input) : "";
  const json = JSON.stringify(call.result.ok ? call.result.data : call.result, null, 2);
  return (
    <div className="flex flex-col gap-1 rounded-xl bg-surface-container-lowest p-space-sm">
      <div className="flex items-center justify-between gap-space-sm">
        <span className="font-label-md text-label-md text-on-surface">
          {TOOL_LABELS[call.name] ?? call.name} <span className="text-on-surface-variant">· {call.name}</span>
        </span>
        <span className={cx("rounded-full px-2 py-0.5 font-label-sm text-label-sm", call.result.ok ? "bg-primary-fixed/60 text-on-primary-fixed-variant" : "bg-secondary-fixed text-on-secondary-fixed-variant")}>
          {call.result.ok ? "ok" : "rejected"}
        </span>
      </div>
      {input ? <code className="break-all text-[11px] text-on-surface-variant">input {input}</code> : null}
      {!call.result.ok ? <p className="font-label-md text-label-md text-on-secondary-fixed-variant">{call.result.error}</p> : null}
      <button className="self-start font-label-sm text-label-sm text-primary" onClick={() => setRaw(!raw)}>
        {raw ? "Hide engine output" : "Show engine output (JSON)"}
      </button>
      {raw ? <pre className="max-h-72 overflow-auto whitespace-pre-wrap text-[11px] text-on-surface-variant">{json.length > 4000 ? `${json.slice(0, 4000)}\n…` : json}</pre> : null}
    </div>
  );
}
