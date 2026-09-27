import { afterEach, describe, expect, it, vi } from "vitest";

import { api, ApiError } from "@/lib/client/api";

afterEach(() => vi.unstubAllGlobals());

/** The error a failing call throws. */
const failure = (path: string): Promise<ApiError> => api<unknown>(path).then(() => { throw new Error("expected the call to fail"); }, (err: ApiError) => err);

describe("API client error wording", () => {
  it("never shows the browser's own network error text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const e = await failure("/api/x");
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(0);
    expect(e.message).toMatch(/Can't reach GroupTrip/);
    expect(e.message).not.toMatch(/Failed to fetch/);
  });

  it("uses the server's message when there is one, and calm wording otherwise", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Trip not found" }), { status: 404 })));
    expect((await failure("/api/x")).message).toBe("Trip not found");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>Gateway Timeout</html>", { status: 504 })));
    const e = await failure("/api/x");
    expect(e.status).toBe(504);
    expect(e.message).toBe("Something went wrong on our side — please try again in a moment.");
  });
});
