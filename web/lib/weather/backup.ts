import { ensembleUrl, parseEnsemble } from "./ensemble";
import { metnoUrl, METNO_UA, parseMetno } from "./metno";
import type { Forecast, LatLon, WeatherDay } from "./openmeteo";

/**
 * What the app does when Open-Meteo's main forecast API can't be used (its
 * free daily quota is shared per network) — and how a forecast is extended to
 * trip days beyond its horizon:
 *
 * - MET Norway (high-resolution, hourly for the next ~2–3 days) supplies every
 *   day it covers hour by hour, all 24 hours — plus "now".
 * - Open-Meteo's GFS ensemble (a separate service, 35 days) supplies every other
 *   day, with a real chance of rain from its members.
 * - A day neither covers is left out — never guessed.
 */

export type JsonGetter = (url: string, headers?: Record<string, string>) => Promise<unknown>;

/** A MET day with all (or nearly all) of its hours: partial days (today from now on, the 6-hourly tail) are not complete. */
export const metDayComplete = (d: WeatherDay) => (d.hours?.length ?? 0) >= 22;

const fmt = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** Combines the available sources into one forecast (see above). Null when there is nothing. */
export function combineForecasts(parts: { primary?: Forecast | null; met?: Forecast | null; ensemble?: Forecast | null }): Forecast | null {
  const { primary, met, ensemble } = parts;
  if (primary) {
    // The main forecast wins; the ensemble only adds the days after its horizon.
    const last = primary.daily.at(-1)?.date ?? "";
    const extra = ensemble?.daily.filter((d) => d.date > last) ?? [];
    if (!extra.length) return primary;
    return { ...primary, daily: [...primary.daily, ...extra], sourceNote: `Open-Meteo to ${fmt(last)} + GFS ensemble to ${fmt(extra.at(-1)!.date)}` };
  }
  if (met && ensemble) {
    const ens = new Map(ensemble.daily.map((d) => [d.date, d]));
    const metByDate = new Map(met.daily.map((d) => [d.date, d]));
    const dates = [...new Set([...ens.keys(), ...metByDate.keys()])].sort();
    let metDays = 0;
    const daily: WeatherDay[] = [];
    for (const date of dates) {
      const m = metByDate.get(date);
      const e = ens.get(date);
      if (m && metDayComplete(m)) {
        // MET gives no chance of rain; the ensemble's (a coarser model) could contradict MET's own hourly rain, so none is shown.
        daily.push(m);
        metDays++;
      } else if (e) daily.push(e);
    }
    if (!metDays) return { ...ensemble, current: met.current, sourceNote: `Open-Meteo GFS ensemble to ${fmt(ensemble.daily.at(-1)!.date)}` };
    return {
      ...met,
      timezone: ensemble.timezone,
      daily,
      sourceNote: `MET Norway hour by hour for ${metDays} day${metDays === 1 ? "" : "s"} + Open-Meteo GFS ensemble to ${fmt(daily.at(-1)!.date)}`,
    };
  }
  if (ensemble) return { ...ensemble, sourceNote: `Open-Meteo GFS ensemble to ${fmt(ensemble.daily.at(-1)!.date)}` };
  if (met) return { ...met, sourceNote: `MET Norway to ${fmt(met.daily.at(-1)!.date)}` };
  return null;
}

/** The backup forecast when Open-Meteo's main API refused: MET Norway + the GFS ensemble, fetched together. */
export async function backupForecast(point: LatLon, label: string, getJson: JsonGetter): Promise<Forecast | null> {
  const eUrl = ensembleUrl(point);
  const mUrl = metnoUrl(point);
  const [eJson, mJson] = await Promise.all([getJson(eUrl).catch(() => null), getJson(mUrl, { "user-agent": METNO_UA }).catch(() => null)]);
  let ensemble: Forecast | null = null;
  try {
    if (eJson) ensemble = parseEnsemble(eJson, label, point, eUrl);
  } catch {
    ensemble = null;
  }
  // Group MET's UTC steps by the destination's real offset when the ensemble told us it (Singapore is UTC+8, not +7).
  const offsetSec = (eJson as { utc_offset_seconds?: unknown } | null)?.utc_offset_seconds;
  let met: Forecast | null = null;
  try {
    if (mJson) met = parseMetno(mJson, label, point, mUrl, Date.now(), typeof offsetSec === "number" ? offsetSec / 60 : undefined);
  } catch {
    met = null;
  }
  return combineForecasts({ met, ensemble });
}

/** Adds GFS-ensemble days after the main forecast's horizon when the trip runs past it. */
export async function extendForecast(primary: Forecast, point: LatLon, label: string, until: string | undefined, getJson: JsonGetter): Promise<Forecast> {
  const last = primary.daily.at(-1)?.date;
  if (!until || !last || until <= last) return primary;
  try {
    const url = ensembleUrl(point);
    return combineForecasts({ primary, ensemble: parseEnsemble(await getJson(url), primary.location.label, point, url) }) ?? primary;
  } catch {
    return primary;
  }
}
