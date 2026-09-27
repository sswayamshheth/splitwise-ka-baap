import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Signed-in user for the route handlers.
vi.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ userId: "user_nugen_test" }), currentUser: async () => null }));

import type { AgentTurn } from "@/lib/ai/agent";
import { extractCommand, introducesNoNumbers, keepsAllNumbers, numbersIn, parseJsonObject, sanitizeWeatherNotes, type WeatherNoteInput } from "@/lib/ai/nugenGuards";
import { answerOffline } from "@/lib/ai/offline";
import { phraseTurn } from "@/lib/ai/phrase";
import { planOffline } from "@/lib/itinerary/planner";
import { buildGoaEvents } from "@/lib/ledger/demo-goa";
import { computeLedger } from "@/lib/ledger/engine";
import { reduceEvents } from "@/lib/ledger/reduce";
import { DEFAULT_NUGEN_MODEL, NUGEN_URL, NugenError, nugenChat, nugenConfigured, nugenTry } from "@/lib/server/nugen";

const KEY = "nk_test_SECRET_do_not_leak_12345";

function goa() {
  const events = buildGoaEvents();
  const state = reduceEvents(events)!;
  return { state, ledger: computeLedger(state), events, viewerId: state.participants[0].id, now: Date.now() };
}

const okFetch = (content: string) =>
  vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), { status: 200 }));

beforeEach(() => {
  delete process.env.NUGEN_API_KEY;
  delete process.env.NUGEN_MODEL;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.NUGEN_API_KEY;
  delete process.env.NUGEN_MODEL;
});

describe("NuGen client (server-only)", () => {
  it("is off without a key, and says so with a code (not an error message for users)", async () => {
    expect(nugenConfigured()).toBe(false);
    await expect(nugenChat([{ role: "user", content: "hi" }])).rejects.toMatchObject({ code: "not-configured" });
  });

  it("posts to the chat completions endpoint with a Bearer key and the default model", async () => {
    process.env.NUGEN_API_KEY = KEY;
    const f = okFetch("Hello there");
    expect(await nugenChat([{ role: "user", content: "hi" }], { fetchImpl: f as unknown as typeof fetch })).toBe("Hello there");
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(NUGEN_URL);
    expect((init!.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(String(init!.body));
    expect(body.model).toBe(DEFAULT_NUGEN_MODEL);
    expect(body.stream).toBe(false);
  });

  it("uses NUGEN_MODEL when set", async () => {
    process.env.NUGEN_API_KEY = KEY;
    process.env.NUGEN_MODEL = "my-aligned-model";
    const f = okFetch("ok");
    await nugenChat([{ role: "user", content: "hi" }], { fetchImpl: f as unknown as typeof fetch });
    expect(JSON.parse(String(f.mock.calls[0][1]!.body)).model).toBe("my-aligned-model");
  });

  it("times out cleanly when NuGen is slow", async () => {
    process.env.NUGEN_API_KEY = KEY;
    const slow = vi.fn((_u: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_res, rej) => init!.signal!.addEventListener("abort", () => rej(new Error("aborted")))));
    await expect(nugenChat([{ role: "user", content: "hi" }], { timeoutMs: 20, fetchImpl: slow as unknown as typeof fetch })).rejects.toMatchObject({ code: "timeout" });
  });

  it("maps failures to codes without the key or the response body", async () => {
    process.env.NUGEN_API_KEY = KEY;
    const fail = vi.fn(async () => new Response(`upstream error mentioning ${KEY}`, { status: 500 }));
    const err = await nugenChat([{ role: "user", content: "x" }], { fetchImpl: fail as unknown as typeof fetch }).catch((e) => e);
    expect(err).toBeInstanceOf(NugenError);
    expect(err.code).toBe("http-500");
    expect(String(err.message)).not.toContain(KEY);
    const empty = vi.fn(async () => new Response(JSON.stringify({ choices: [] }), { status: 200 }));
    await expect(nugenChat([{ role: "user", content: "x" }], { fetchImpl: empty as unknown as typeof fetch })).rejects.toMatchObject({ code: "bad-response" });
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(nugenChat([{ role: "user", content: "x" }], { fetchImpl: down as unknown as typeof fetch })).rejects.toMatchObject({ code: "network" });
  });

  it("nugenTry returns null and logs only the error code", async () => {
    process.env.NUGEN_API_KEY = KEY;
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fail = vi.fn(async () => new Response(`bad ${KEY}`, { status: 401 }));
    expect(await nugenTry([{ role: "user", content: "x" }], { fetchImpl: fail as unknown as typeof fetch }, "t")).toBeNull();
    expect(log).toHaveBeenCalledWith("[t] failed:", "http-401");
    expect(JSON.stringify(log.mock.calls)).not.toContain(KEY);
  });
});

describe("guards on anything NuGen writes", () => {
  it("normalises and compares numbers", () => {
    expect([...numbersIn("₹1,275 and 8.0 km, day 3")]).toEqual(["1275", "8", "3"]);
    expect(introducesNoNumbers("You're owed ₹1,275.", "Aaryan is owed ₹1,275")).toBe(true);
    expect(introducesNoNumbers("You're owed about ₹1,300.", "Aaryan is owed ₹1,275")).toBe(false);
    expect(keepsAllNumbers("Kabir owes the most.", "Kabir owes ₹575")).toBe(false);
  });

  it("extracts one planner command", () => {
    expect(extractCommand('Command: "add water sports on day 2."\nThanks!')).toBe("add water sports on day 2");
    expect(extractCommand("NONE")).toBe("NONE");
  });

  it("keeps only safe weather notes and orderings of the code's own ideas", () => {
    const input: WeatherNoteInput = {
      days: [{ date: "2026-10-02", alerts: [{ label: "Heavy rain", reason: "85% chance of rain" }], atRisk: [{ itemId: "raft", title: "River rafting", reasons: ["Heavy rain: 85% chance of rain"] }], alternatives: ["Museum", "Café lunch"] }],
    };
    const raw = parseJsonObject(
      'Sure! {"notes": {"raft": "Rafting may be washed out with an 85% chance of rain.", "ghost": "invented item", "raft2": "x"}, "order": {"2026-10-02": ["Café lunch", "Skydiving", "Museum"]}}',
    );
    const out = sanitizeWeatherNotes(raw, input);
    expect(out.notes).toEqual({ raft: "Rafting may be washed out with an 85% chance of rain." });
    expect(out.order).toEqual({ "2026-10-02": ["Café lunch", "Museum"] });
    // A note that adds a number (a new "alert") is dropped.
    expect(sanitizeWeatherNotes({ notes: { raft: "Expect 120 mm of rain and hail." } }, input).notes).toEqual({});
    expect(sanitizeWeatherNotes(null, input)).toEqual({ notes: {}, order: {} });
  });
});

describe("assistant: NuGen only rewords engine answers", () => {
  const turn = (): AgentTurn => answerOffline("Who owes the most?", goa());

  it("uses the rewording when it keeps every figure and adds none", async () => {
    const t = turn();
    const figures = t.verification.verified;
    const reworded = `Here's where things stand: ${t.text.replace(/\s+/g, " ")}`;
    const r = await phraseTurn("Who owes the most?", t, async () => ({ text: reworded }));
    expect(r.phrased).toBe(true);
    expect(r.turn.verification.unverified).toEqual([]);
    expect(r.turn.verification.verified.length).toBeGreaterThanOrEqual(figures.length);
  });

  it("keeps the original when NuGen invents, drops or fails", async () => {
    const t = turn();
    const invented = await phraseTurn("q", t, async () => ({ text: `${t.text} Also, everyone owes ₹99,999.` }));
    expect(invented).toEqual({ turn: t, phrased: false });
    const dropped = await phraseTurn("q", t, async () => ({ text: "Someone owes the most." }));
    expect(dropped.phrased).toBe(false);
    expect((await phraseTurn("q", t, async () => ({ text: null }))).phrased).toBe(false);
    expect(
      (
        await phraseTurn("q", t, async () => {
          throw new Error("offline");
        })
      ).phrased,
    ).toBe(false);
  });

  it("doesn't send help text or unverified answers to NuGen at all", async () => {
    const post = vi.fn(async () => ({ text: "anything" }));
    await phraseTurn("q", answerOffline("what is the meaning of life", goa()), post);
    expect(post).not.toHaveBeenCalled();
  });
});

describe("plan assistant: NuGen only rewrites the request into a planner command", () => {
  it("the planner understands the kind of command NuGen is asked to produce", () => {
    const state = goa().state;
    expect(planOffline(state, "We want our pulses racing").understood).toBe(false);
    expect(planOffline(state, "add water sports on day 2").understood).toBe(true);
  });
});

describe("routes: fallback, status and no secrets in responses", () => {
  it("/api/status reports nugen only when the key is set, without revealing it", async () => {
    const { GET } = await import("@/app/api/status/route");
    const off = await (await GET()).json();
    expect(off.ai).toBe("offline");
    process.env.NUGEN_API_KEY = KEY;
    const res = await GET();
    const text = await res.text();
    expect(JSON.parse(text).ai).toBe("nugen");
    expect(text).not.toContain(KEY);
  });

  it("/api/ai/phrase returns text:null without a key and when NuGen fails", async () => {
    const { POST } = await import("@/app/api/ai/phrase/route");
    const req = () => new Request("http://x/api/ai/phrase", { method: "POST", body: JSON.stringify({ question: "q", answer: "Kabir owes ₹575" }) });
    expect(await (await POST(req())).json()).toEqual({ text: null });
    process.env.NUGEN_API_KEY = KEY;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`boom ${KEY}`, { status: 503 })));
    const res = await POST(req());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ text: null });
    expect(text).not.toContain(KEY);
  });

  it("/api/ai/phrase returns NuGen's wording when it works, never the key", async () => {
    process.env.NUGEN_API_KEY = KEY;
    vi.stubGlobal("fetch", okFetch("Kabir owes the most — ₹575."));
    const { POST } = await import("@/app/api/ai/phrase/route");
    const res = await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ question: "q", answer: "Kabir owes ₹575" }) }));
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ text: "Kabir owes the most — ₹575." });
    expect(text).not.toContain(KEY);
  });

  it("/api/ai/weather-notes is empty without a key and sanitises NuGen's reply with one", async () => {
    const { POST } = await import("@/app/api/ai/weather-notes/route");
    const payload = { days: [{ date: "2026-10-02", alerts: [{ label: "Heavy rain", reason: "85% chance of rain" }], atRisk: [{ itemId: "raft", title: "River rafting", reasons: ["Heavy rain: 85% chance of rain"] }], alternatives: ["Museum"] }] };
    const req = () => new Request("http://x", { method: "POST", body: JSON.stringify(payload) });
    expect(await (await POST(req())).json()).toEqual({ notes: {}, order: {} });
    process.env.NUGEN_API_KEY = KEY;
    vi.stubGlobal("fetch", okFetch('{"notes":{"raft":"Rain is likely, so rafting could be cancelled.","x":"new"},"order":{"2026-10-02":["Museum","Bungee"]}}'));
    const text = await (await POST(req())).text();
    expect(JSON.parse(text)).toEqual({ notes: { raft: "Rain is likely, so rafting could be cancelled." }, order: { "2026-10-02": ["Museum"] } });
    expect(text).not.toContain(KEY);
  });
});
