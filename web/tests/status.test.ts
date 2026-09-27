import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ userId: null }), currentUser: async () => null }));

import { GET } from "@/app/api/status/route";
import { setRepoForTests, type Repo } from "@/lib/server/repo";

const SECRETS = { SUPABASE_SECRET_KEY: "sb_secret_TESTVALUE_1234567890", CLERK_SECRET_KEY: "sk_test_TESTVALUE_1234567890", NUGEN_API_KEY: "nk_TESTVALUE_1234567890" };

const fakeRepo = (ping?: () => Promise<boolean>) => ({ kind: "supabase", ping }) as unknown as Repo;

afterEach(() => {
  setRepoForTests(null);
  for (const k of Object.keys(SECRETS)) delete process.env[k];
});

describe("/api/status (public)", () => {
  it("says the database is connected only when it answers", async () => {
    setRepoForTests(fakeRepo(async () => true));
    expect((await (await GET()).json()).database).toBe("connected");
    setRepoForTests(fakeRepo(async () => false));
    expect((await (await GET()).json()).database).toBe("unreachable");
    setRepoForTests(
      fakeRepo(async () => {
        throw new Error("network down");
      }),
    );
    expect((await (await GET()).json()).database).toBe("unreachable");
  });

  it("reports the local file store as local (development)", async () => {
    setRepoForTests({ kind: "file" } as unknown as Repo);
    expect((await (await GET()).json()).database).toBe("local");
  });

  it("reports the demo checkout when no payment keys are set", async () => {
    setRepoForTests(fakeRepo(async () => true));
    expect((await (await GET()).json()).payments).toBe("demo");
  });

  it("never includes a secret value", async () => {
    Object.assign(process.env, SECRETS);
    setRepoForTests(fakeRepo(async () => true));
    const text = await (await GET()).text();
    for (const v of Object.values(SECRETS)) expect(text).not.toContain(v);
    expect(JSON.parse(text)).toMatchObject({ ok: true, database: "connected", ai: "nugen" });
  });
});
