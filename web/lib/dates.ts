const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Today's date as an ISO calendar string (local time). */
export function todayIso(now = new Date()): string {
  return toIso(now);
}

export function toIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function parseIso(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) return null;
  return d;
}

export function isValidIso(iso: string): boolean {
  return parseIso(iso) !== null;
}

/** "14 Sep" or "14 Sep 2026" when the year differs from the current one. */
export function formatDate(iso: string, opts: { year?: boolean } = {}): string {
  const d = parseIso(iso);
  if (!d) return iso;
  const showYear = opts.year ?? d.getFullYear() !== new Date().getFullYear();
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${showYear ? ` ${d.getFullYear()}` : ""}`;
}

/** "12–15 Sep 2026" style range. */
export function formatDateRange(startIso: string, endIso: string): string {
  const a = parseIso(startIso);
  const b = parseIso(endIso);
  if (!a || !b) return `${startIso} – ${endIso}`;
  const year = b.getFullYear();
  if (a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()) {
    return `${a.getDate()}–${b.getDate()} ${MONTHS[a.getMonth()]} ${year}`;
  }
  if (a.getFullYear() === b.getFullYear()) {
    return `${a.getDate()} ${MONTHS[a.getMonth()]} – ${b.getDate()} ${MONTHS[b.getMonth()]} ${year}`;
  }
  return `${a.getDate()} ${MONTHS[a.getMonth()]} ${a.getFullYear()} – ${b.getDate()} ${MONTHS[b.getMonth()]} ${year}`;
}

/** Relative time for the activity feed: "just now", "5 min ago", "Yesterday, 14:02", "3 Sep, 09:14". */
export function formatRelative(ts: number, now = Date.now()): string {
  const diff = now - ts;
  const minute = 60_000;
  const hour = 60 * minute;
  const d = new Date(ts);
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (diff < minute) return "Just now";
  if (diff < hour) return `${Math.floor(diff / minute)} min ago`;
  if (diff < 24 * hour && new Date(now).getDate() === d.getDate()) return `Today, ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (yesterday.getDate() === d.getDate() && yesterday.getMonth() === d.getMonth()) return `Yesterday, ${time}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${time}`;
}

export function daysBetween(startIso: string, endIso: string): number {
  const a = parseIso(startIso);
  const b = parseIso(endIso);
  if (!a || !b) return 0;
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}
