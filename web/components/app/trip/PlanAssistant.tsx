"use client";

import { useState } from "react";

import { cx, Icon, Sheet, useFeedback } from "@/components/app/kit";
import { api } from "@/lib/client/api";
import { errorText, useTrip } from "@/lib/client/trip";
import { formatDate } from "@/lib/dates";
import type { PlanOp } from "@/lib/itinerary/planner";
import { addItineraryItem, removeItineraryItem, updateItineraryItem } from "@/lib/ledger/commands";
import { applyEvent } from "@/lib/ledger/reduce";
import type { LedgerEvent, TripState } from "@/lib/ledger/types";
import { formatMoney } from "@/lib/money";

/**
 * "Plan with AI": tell the planner what you want, review its proposed changes,
 * tick the ones you like, apply. Nothing changes until Apply; paid bookings are
 * never touched (they're cancelled from Activity, where the refund is handled).
 */

type Proposal = { ops: PlanOp[]; summary: string; understood: boolean; source: "ai" | "builtin"; model?: string; readAs?: string };

const SUGGESTIONS = ["Add water sports", "Add a food trail", "Add something relaxing on day 2", "Add 2 nightlife options", "Make it cheaper", "Make a new plan for our group"];

export function PlanAssistantCard({ onOpen }: { onOpen: () => void }) {
  return (
    <button onClick={onOpen} className="mt-space-sm flex w-full items-center gap-space-md rounded-xl bg-tertiary-fixed/70 p-space-md text-left transition-colors hover:bg-tertiary-fixed">
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-tertiary-container text-on-tertiary-container">
        <Icon name="auto_awesome" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="font-title-md text-title-md text-on-tertiary-fixed">Plan with AI</span>
        <span className="truncate font-label-sm text-label-sm text-on-tertiary-fixed-variant">“Add water sports” · “Make a new plan for our group” · “Make it cheaper”</span>
      </span>
      <Icon name="arrow_forward" className="text-on-tertiary-fixed-variant" />
    </button>
  );
}

export function PlanAssistantSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const trip = useTrip();
  const { toast } = useFeedback();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());

  async function ask(instruction: string) {
    if (!instruction.trim()) return;
    setText(instruction);
    setBusy(true);
    setProposal(null);
    try {
      const res = await api<Proposal>(`/api/trips/${trip.tripId}/plan-ai`, { body: { instruction } });
      setProposal(res);
      setPicked(new Set(res.ops.map((_, i) => i)));
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!proposal) return;
    const chosen = proposal.ops.filter((_, i) => picked.has(i));
    if (!chosen.length) return;
    setBusy(true);
    try {
      await trip.run((state, ctx) => {
        let working: TripState = state;
        const out: LedgerEvent[] = [];
        const everyone = state.participants.filter((p) => !p.leftOn).map((p) => p.id);
        chosen.forEach((op, i) => {
          const c = { ...ctx, now: Date.now() + i };
          let e: LedgerEvent;
          if (op.op === "add") {
            e = addItineraryItem(working, { title: op.item.title, category: op.item.category, date: op.item.date, vendor: op.item.vendor, estimatedPaise: op.item.estimatedPaise, participantIds: everyone }, c);
          } else if (op.op === "remove") {
            e = removeItineraryItem(working, op.itemId, c);
          } else {
            const it = working.itinerary.find((x) => x.id === op.itemId)!;
            e = updateItineraryItem(
              working,
              op.itemId,
              {
                title: op.changes.title ?? it.title,
                category: it.category,
                date: op.changes.date ?? it.date,
                endDate: it.endDate,
                time: it.time,
                location: it.location,
                vendor: it.vendor,
                vendorUpi: it.vendorUpi,
                vendorUpiName: it.vendorUpiName,
                estimatedPaise: op.changes.estimatedPaise ?? it.estimatedPaise,
                actualPaise: it.actualPaise,
                participantIds: it.participantIds,
                weights: it.weights,
                notes: it.notes,
                cancellationPolicy: it.cancellationPolicy,
                status: it.status,
              },
              c,
            );
          }
          out.push(e);
          working = applyEvent(working, e) ?? working;
        });
        return out;
      });
      toast(`Plan updated · ${chosen.length} change${chosen.length === 1 ? "" : "s"} applied`);
      setProposal(null);
      setText("");
      onClose();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  }

  const toggle = (i: number) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });

  return (
    <Sheet open={open} onClose={onClose} title="Plan with AI">
      <div className="flex items-end gap-2 rounded-xl bg-surface-container-low p-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void ask(text);
            }
          }}
          rows={2}
          placeholder="e.g. Add water sports on day 2 · Remove nightlife · Make a new plan for our group"
          className="min-h-[52px] flex-1 resize-none bg-transparent px-2 py-1.5 font-body-md text-body-md text-on-surface outline-none"
          autoFocus
        />
        <button
          onClick={() => void ask(text)}
          disabled={busy || !text.trim()}
          aria-label="Ask the planner"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary-container text-on-primary disabled:opacity-40"
        >
          <Icon name={busy ? "hourglass_top" : "arrow_upward"} />
        </button>
      </div>
      <div className="mt-space-sm flex flex-wrap gap-2">
        {SUGGESTIONS.map((s) => (
          <button key={s} disabled={busy} onClick={() => void ask(s)} className="rounded-full bg-surface-container px-3 py-1.5 font-label-md text-label-md text-on-surface-variant hover:bg-surface-variant disabled:opacity-40">
            {s}
          </button>
        ))}
      </div>

      {busy && !proposal ? <p className="mt-space-md font-body-md text-body-md text-on-surface-variant">Planning…</p> : null}

      {proposal ? (
        <div className="mt-space-lg flex flex-col gap-space-sm">
          <div className="flex items-center justify-between">
            <span className="font-title-md text-title-md text-on-surface">{proposal.ops.length ? "Proposed changes" : "No changes"}</span>
            <span className={cx("rounded-full px-2 py-0.5 font-label-sm text-label-sm", proposal.source === "ai" ? "bg-tertiary-fixed text-on-tertiary-fixed-variant" : "bg-surface-container text-on-surface-variant")}>
              {proposal.source === "ai" ? (proposal.model ?? "Claude") : "Built-in planner"}
            </span>
          </div>
          {proposal.readAs ? <p className="font-label-md text-label-md text-on-surface-variant">Read as “{proposal.readAs}” (suggested by NuGen)</p> : null}
          {proposal.summary ? <p className="font-body-md text-body-md text-on-surface-variant">{proposal.summary}</p> : null}
          {proposal.ops.map((op, i) => {
            const on = picked.has(i);
            const tone = op.op === "add" ? "text-primary" : op.op === "remove" ? "text-error" : "text-secondary";
            const icon = op.op === "add" ? "add_circle" : op.op === "remove" ? "remove_circle" : "edit";
            return (
              <button
                key={i}
                onClick={() => toggle(i)}
                className={cx("flex w-full items-start gap-3 rounded-xl p-3 text-left transition-colors", on ? "bg-surface-container-lowest shadow-sm ring-1 ring-primary/30" : "bg-surface-container-low opacity-60")}
              >
                <Icon name={on ? "check_box" : "check_box_outline_blank"} className="mt-0.5 text-[22px] text-primary" />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex items-center gap-1.5">
                    <Icon name={icon} className={cx("text-[18px]", tone)} />
                    <span className="truncate font-title-md text-title-md text-on-surface">{op.op === "add" ? op.item.title : op.title}</span>
                  </span>
                  <span className="font-label-sm text-label-sm text-on-surface-variant">
                    {op.op === "add"
                      ? `${op.item.category} · ${formatDate(op.item.date)} · est. ${formatMoney(op.item.estimatedPaise)}`
                      : op.op === "remove"
                        ? "Remove from the plan"
                        : [op.changes.date ? `Move to ${formatDate(op.changes.date)}` : "", op.changes.estimatedPaise !== undefined ? `Estimate ${formatMoney(op.changes.estimatedPaise)}` : "", op.changes.title ? `Rename to “${op.changes.title}”` : ""].filter(Boolean).join(" · ")}
                  </span>
                  {op.reason ? <span className="font-label-sm text-label-sm text-on-surface-variant/80">{op.reason}</span> : null}
                </span>
              </button>
            );
          })}
          {proposal.ops.length ? (
            <button
              onClick={() => void apply()}
              disabled={busy || picked.size === 0}
              className="mt-space-sm flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary-container font-title-md text-title-md text-on-primary disabled:opacity-40"
            >
              <Icon name="check" /> Apply {picked.size} change{picked.size === 1 ? "" : "s"}
            </button>
          ) : null}
          <p className="text-center font-label-sm text-label-sm text-on-surface-variant">Nothing changes until you apply. Paid bookings are never changed here — cancel them from Activity.</p>
        </div>
      ) : null}
    </Sheet>
  );
}
