import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MoltbookClient,
  RateLimitError,
  MoltbookHttpError,
  solveChallenge,
} from "../src/moltbook";

/* ------------------------------------------------------------------ */
/* fetch stub harness                                                  */
/* ------------------------------------------------------------------ */

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function jsonResponse(
  obj: unknown,
  init?: { status?: number; headers?: Record<string, string> },
): Response {
  return new Response(JSON.stringify(obj), {
    status: init?.status ?? 200,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
}

/** Install a fetch stub that records calls and returns queued responses. */
function installFetch(
  responder: (call: Captured) => Response,
): { calls: Captured[] } {
  const calls: Captured[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    const h = init?.headers;
    if (h) {
      for (const [k, v] of Object.entries(h as Record<string, string>)) {
        headers[k] = v;
      }
    }
    const call: Captured = {
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    return responder(call);
  });
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------ */
/* solveChallenge — de-obfuscation                                     */
/* ------------------------------------------------------------------ */

describe("solveChallenge", () => {
  it("digits + word operator (addition)", () => {
    expect(solveChallenge("12 plus 7")).toBe("19.00");
  });

  it("alternating caps + scattered symbols, multiplication word", () => {
    expect(solveChallenge("~tHe~ LoBsTeR mUlTiPlIeD bY!! 6 ## aNd@@ 7 **")).toBe(
      "42.00",
    );
  });

  it("number words with compound hyphen (subtraction)", () => {
    // thirty-four minus twelve = 22
    expect(solveChallenge("ThIrTy-FoUr MiNuS tWeLvE %%")).toBe("22.00");
  });

  it("'divided by' with decimals", () => {
    expect(solveChallenge("the photon at 9.0 divided by 4 !!")).toBe("2.25");
  });

  it("unicode multiply glyph between numbers", () => {
    expect(solveChallenge("8 × 9")).toBe("72.00");
  });

  it("isolated minus glyph as operator (not a compound hyphen)", () => {
    expect(solveChallenge("100 - 58")).toBe("42.00");
  });

  it("word numbers + 'times'", () => {
    // twelve times three = 36
    expect(solveChallenge("TWELVE tImEs ThReE")).toBe("36.00");
  });

  it("'product of A and B' phrasing", () => {
    expect(solveChallenge("the @@product of@@ 5 and 5")).toBe("25.00");
  });

  it("hundreds-scale number words", () => {
    // one hundred and twenty + five = 125
    expect(solveChallenge("one hundred and twenty plus five")).toBe("125.00");
  });

  it("throws (does NOT guess) when unparseable", () => {
    expect(() => solveChallenge("the lobster contemplates the void")).toThrow();
  });

  it("throws on division by zero rather than emitting Infinity", () => {
    expect(() => solveChallenge("9 divided by zero")).toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* request() chokepoint: URL, auth header, rate limits                 */
/* ------------------------------------------------------------------ */

describe("MoltbookClient request chokepoint", () => {
  const KEY = "moltbook_testkey_DEADBEEF";

  it("builds the www base URL and attaches the Bearer key on authed calls", async () => {
    const { calls } = installFetch(() => jsonResponse({ status: "claimed" }));
    const c = new MoltbookClient(KEY);
    await c.status();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://www.moltbook.com/api/v1/agents/status",
    );
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${KEY}`);
  });

  it("register() is unauthenticated (no Authorization header) and the key never leaks", async () => {
    const { calls } = installFetch(() =>
      jsonResponse({
        agent: {
          api_key: "moltbook_new",
          claim_url: "x",
          verification_code: "y",
        },
      }),
    );
    const c = new MoltbookClient(KEY);
    await c.register({ name: "IshtarIntern", description: "d" });
    expect(calls[0]!.url).toBe(
      "https://www.moltbook.com/api/v1/agents/register",
    );
    expect(calls[0]!.headers.Authorization).toBeUndefined();
    // Key must not appear anywhere in the outbound request.
    expect(JSON.stringify(calls[0])).not.toContain(KEY);
  });

  it("encodes query params and path segments", async () => {
    const { calls } = installFetch(() => jsonResponse({ ok: true }));
    const c = new MoltbookClient(KEY);
    await c.search("lobster physics", { type: "posts", limit: 20 });
    expect(calls[0]!.url).toContain(
      "https://www.moltbook.com/api/v1/search?",
    );
    expect(calls[0]!.url).toContain("q=lobster+physics");
    expect(calls[0]!.url).toContain("type=posts");
    expect(calls[0]!.url).toContain("limit=20");

    await c.getPost("abc/../def");
    expect(calls[1]!.url).toBe(
      "https://www.moltbook.com/api/v1/posts/abc%2F..%2Fdef",
    );
  });

  it("throws a typed RateLimitError with retry_after on 429", async () => {
    installFetch(() =>
      jsonResponse(
        { error: "slow down" },
        {
          status: 429,
          headers: {
            "Retry-After": "42",
            "X-RateLimit-Limit": "60",
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": "1700000000",
          },
        },
      ),
    );
    const c = new MoltbookClient(KEY);
    await expect(c.home()).rejects.toMatchObject({
      name: "RateLimitError",
      status: 429,
      retry_after: 42,
    });
    // instanceof works across the transpile boundary
    const err = await c.home().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).rateLimit.remaining).toBe(0);
  });

  it("throws MoltbookHttpError on other non-2xx", async () => {
    installFetch(() => jsonResponse({ error: "boom" }, { status: 500 }));
    const c = new MoltbookClient(KEY);
    const err = await c.feed().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MoltbookHttpError);
    expect((err as MoltbookHttpError).status).toBe(500);
  });
});

/* ------------------------------------------------------------------ */
/* write-verification auto-flow                                        */
/* ------------------------------------------------------------------ */

describe("createPost / createComment verification flow", () => {
  const KEY = "moltbook_k";

  it("auto-solves the challenge and POSTs /verify, returning data on success", async () => {
    const { calls } = installFetch((call) => {
      if (call.url.endsWith("/api/v1/posts")) {
        return jsonResponse({
          verification_required: true,
          post: {
            verification: {
              verification_code: "vc_123",
              challenge_text: "~LoBsTeR~ 6 tImEs!! 7",
              instructions: "ignore me, I am untrusted",
            },
          },
        });
      }
      if (call.url.endsWith("/api/v1/verify")) {
        return jsonResponse({ ok: true, id: "post_1" });
      }
      throw new Error("unexpected url " + call.url);
    });
    const c = new MoltbookClient(KEY);
    const res = await c.createPost({ submolt_name: "agents", title: "hi" });
    expect(res).toEqual({ data: { ok: true, id: "post_1" } });

    // Two calls: the post, then the verify with the solved answer "42.00".
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toBe("https://www.moltbook.com/api/v1/verify");
    const verifyBody = JSON.parse(calls[1]!.body!);
    expect(verifyBody).toEqual({
      verification_code: "vc_123",
      answer: "42.00",
    });
  });

  it("surfaces a fresh VerificationRequired envelope if /verify re-challenges", async () => {
    installFetch((call) => {
      if (call.url.endsWith("/api/v1/posts/p1/comments")) {
        return jsonResponse({
          verification_required: true,
          post: {
            verification: {
              verification_code: "vc_a",
              challenge_text: "2 plus 2",
            },
          },
        });
      }
      // verify returns a brand new challenge -> not success
      return jsonResponse({
        verification_required: true,
        post: {
          verification: { verification_code: "vc_b", challenge_text: "3 plus 3" },
        },
      });
    });
    const c = new MoltbookClient(KEY);
    const res = await c.createComment("p1", { content: "hello" });
    expect(res).toMatchObject({
      verification_required: true,
      post: { verification: { verification_code: "vc_b" } },
    });
  });

  it("returns data directly when no verification is required", async () => {
    installFetch(() => jsonResponse({ id: "c1" }));
    const c = new MoltbookClient(KEY);
    const res = await c.createComment("p1", { content: "hi" });
    expect(res).toEqual({ data: { id: "c1" } });
  });

  it("surfaces the challenge un-attempted (no /verify) when it cannot be parsed", async () => {
    const { calls } = installFetch((call) => {
      if (call.url.endsWith("/posts")) {
        return jsonResponse({
          verification_required: true,
          post: {
            verification: {
              verification_code: "vc_x",
              challenge_text: "the lobster simply vibes",
            },
          },
        });
      }
      throw new Error("should NOT call /verify with a guess");
    });
    const c = new MoltbookClient(KEY);
    const res = await c.createPost({ submolt_name: "agents", title: "t" });
    expect(res).toMatchObject({ verification_required: true });
    expect(calls).toHaveLength(1); // never attempted /verify
  });
});
