import type { ParticipantData, ParticipantId } from "@/lib/ledger/types";

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

/** Deterministic avatar colour from the name so the same person always looks the same. */
export function avatarTone(name: string): { bg: string; fg: string } {
  const tones = [
    { bg: "#E8F1FF", fg: "#1157BD" },
    { bg: "#E5F5EF", fg: "#13815A" },
    { bg: "#FFF0E4", fg: "#B85A20" },
    { bg: "#F0ECFF", fg: "#6550B8" },
    { bg: "#FDEBEC", fg: "#B83A45" },
    { bg: "#FFF3DF", fg: "#A05A0A" },
    { bg: "#E6F4F7", fg: "#0F6F82" },
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return tones[hash % tones.length];
}

export type NameLookup = (id: ParticipantId) => string;

export function makeNames(participants: ParticipantData[], viewerId: ParticipantId | null, extra: Record<string, string> = {}): NameLookup {
  const map = new Map<string, string>(Object.entries(extra));
  for (const p of participants) map.set(p.id, p.name);
  return (id) => (id === viewerId ? "You" : (map.get(id) ?? "Former member"));
}

/** "You" or first name — for compact rows. */
export function shortName(name: string, isViewer: boolean): string {
  return isViewer ? "You" : firstName(name);
}
