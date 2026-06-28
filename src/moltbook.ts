/**
 * moltbook.ts — typed Moltbook API client.
 *
 * SECURITY CONTRACT (holds as implemented):
 *  - Invariant #1: the ONLY place that attaches MOLTBOOK_API_KEY is the private
 *    `request()` helper, and it calls assertMoltbookUrl(url) BEFORE fetch.
 *    Every URL is built from MOLTBOOK_API_BASE; nothing is built from
 *    feed/comment content. There is exactly ONE fetch path (in `request()`).
 *  - Invariant #2: this client is the worker's ONLY network egress. No other
 *    module calls fetch(). No eval / dynamic import / shell here.
 *  - Invariant #4: there is NO dm()/readDms()/sendDm() method on purpose.
 *  - The API key is never logged, never put in an error message, never in a URL.
 *
 * The constructor takes the raw key string (env.MOLTBOOK_API_KEY). `register`
 * is the ONE unauthenticated call (no Authorization header) and is founder-run.
 */

// The `request()` helper builds every URL from MOLTBOOK_API_BASE and calls
// assertMoltbookUrl(url) BEFORE fetch. Imported from the single source of truth
// in ./security — never redefined here.
import { MOLTBOOK_API_BASE, assertMoltbookUrl } from "./security";
import type { VerificationRequired, VerificationChallenge } from "./types";

/** Sort modes for GET /feed. */
export type FeedSort = "hot" | "new" | "top";

/** Sort modes for GET /posts. */
export type PostsSort = "hot" | "new" | "top" | "rising";

/** Sort modes for GET /posts/:id/comments. */
export type CommentsSort = "best" | "new" | "old";

/** Search target. */
export type SearchType = "posts" | "comments" | "all";

/** Body for POST /agents/register (unauthenticated, founder-run). */
export interface RegisterBody {
  name: string;
  description: string;
}

/** Response of POST /agents/register. */
export interface RegisterResult {
  agent: {
    api_key: string;
    claim_url: string;
    verification_code: string;
  };
}

/** Response of GET /agents/status. */
export interface StatusResult {
  status: "pending_claim" | "claimed" | string;
}

/** Body for POST /posts. */
export interface CreatePostBody {
  submolt_name: string;
  /** <= 300 chars. */
  title: string;
  /** <= 40000 chars. */
  content?: string;
  url?: string;
  type?: string;
}

/** Body for POST /posts/:id/comments. */
export interface CreateCommentBody {
  content: string;
  parent_id?: string;
}

/** Body for POST /verify. */
export interface VerifyBody {
  verification_code: string;
  /** Answer formatted to exactly 2 decimals, e.g. "12.00". */
  answer: string;
}

/** Optional cursor/limit/sort/filter params for list endpoints. */
export interface ListParams {
  sort?: string;
  limit?: number;
  cursor?: string;
  filter?: string;
}

/**
 * A write call either succeeds with `data`, or Moltbook demands verification
 * first. createPost/createComment auto-attempt /verify once when a challenge is
 * returned: on success they yield `{ data }`; if the challenge is unsolved or a
 * fresh challenge is returned, the (latest) VerificationRequired envelope is
 * surfaced so the executor can decide whether to retry under its budget caps.
 */
export type WriteResult<T> = { data: T } | VerificationRequired;

/** Rate-limit headers Moltbook returns on every response. */
export interface RateLimitInfo {
  limit?: number;
  remaining?: number;
  reset?: number;
  retryAfter?: number;
}

/**
 * Thrown on HTTP 429 from Moltbook. Carries the parsed rate-limit window so the
 * caller can back off correctly (Retry-After seconds, plus the limit/remaining/
 * reset trio). Never carries the API key.
 */
export class RateLimitError extends Error {
  /** HTTP status (always 429). */
  readonly status = 429;
  /** Seconds to wait before retrying, from the Retry-After header if present. */
  readonly retry_after?: number;
  /** Parsed X-RateLimit-* headers. */
  readonly rateLimit: RateLimitInfo;

  constructor(rateLimit: RateLimitInfo, message?: string) {
    super(message ?? "Moltbook rate limit exceeded (HTTP 429)");
    this.name = "RateLimitError";
    this.rateLimit = rateLimit;
    this.retry_after = rateLimit.retryAfter;
    // Restore prototype chain for instanceof across transpile targets.
    Object.setPrototypeOf(this, RateLimitError.prototype);
  }
}

/**
 * Thrown on a non-2xx, non-429 Moltbook response. Carries the status and the
 * parsed rate-limit window (still present on errors). Never carries the key.
 */
export class MoltbookHttpError extends Error {
  readonly status: number;
  readonly rateLimit: RateLimitInfo;
  /** Parsed error body, if any (UNTRUSTED — for logging the reason only). */
  readonly body?: unknown;

  constructor(
    status: number,
    rateLimit: RateLimitInfo,
    body?: unknown,
    message?: string,
  ) {
    super(message ?? `Moltbook request failed (HTTP ${status})`);
    this.name = "MoltbookHttpError";
    this.status = status;
    this.rateLimit = rateLimit;
    this.body = body;
    Object.setPrototypeOf(this, MoltbookHttpError.prototype);
  }
}

/* ------------------------------------------------------------------ */
/* Write-verification: de-obfuscate the lobster/physics math challenge */
/* ------------------------------------------------------------------ */

/** Number words 0..19 and the tens, for parsing spelled-out operands. */
const ONES: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};

const TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

const SCALES: Record<string, number> = {
  hundred: 100,
  thousand: 1000,
  million: 1000000,
};

/** Operator detection. The op may be spelled out (preferred — robust against
 * scattered symbol noise) or appear as an isolated arithmetic glyph. */
type Op = "+" | "-" | "*" | "/";

const OP_WORDS: Array<{ re: RegExp; op: Op }> = [
  // Multiplication
  { re: /\b(times|multiplied by|product of)\b/, op: "*" },
  // Division
  { re: /\b(divided by|over|per|quotient of)\b/, op: "/" },
  // Addition
  { re: /\b(plus|added to|sum of|combined with|increased by)\b/, op: "+" },
  // Subtraction
  {
    re: /\b(minus|subtracted from|less|decreased by|difference of|difference between|reduced by|take away)\b/,
    op: "-",
  },
];

/**
 * Strip the scattered-symbol obfuscation and normalize alternating caps.
 *
 * Returns a lower-cased string where runs of "scattered" punctuation/symbols
 * are collapsed to single spaces, BUT structural arithmetic glyphs (+ - * / x ×
 * ÷) and digits/decimal points are preserved as standalone tokens so a symbol
 * operator survives. Hyphens that glue number words (e.g. "thirty-four") are
 * preserved between two letters.
 */
function deobfuscate(raw: string): string {
  if (typeof raw !== "string") return "";
  let s = raw.toLowerCase();

  // Normalize unicode arithmetic glyphs to ASCII so detection is uniform.
  s = s.replace(/\u00d7/g, " * ").replace(/\u00f7/g, " / ");

  // Drop every "scattered symbol" (~ ! @ # $ % ^ & ( ) [ ] { } | \\ : ; " ' < >
  // ? , and stray emoji / box-drawing) to a space, KEEPING letters, digits, '.',
  // the four arithmetic glyphs (+ - * /) and whitespace. Hyphens are kept here so
  // compound number words ("thirty-four") survive; the tokenizer later decides
  // whether a '-' is a compound-glue hyphen (letter-letter) or a minus operator.
  s = s.replace(/[^a-z0-9.+\-*/\s]/g, " ");

  // Space out arithmetic glyphs that are NOT a hyphen between two letters, so a
  // symbol operator tokenizes on its own while "thirty-four" stays glued:
  //  - '+', '*', '/' are always operators -> isolate them.
  s = s.replace(/([+*/])/g, " $1 ");
  //  - '-' only when it is NOT letter-hyphen-letter (a compound number word).
  //    Zero-width lookarounds replace just the hyphen, leaving its neighbours.
  s = s.replace(/(?<![a-z])-|-(?![a-z])/g, " - ");

  // Collapse whitespace.
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Parse a contiguous spelled-out number phrase (already lower-cased, words
 * separated by single spaces or hyphens) into a number. Handles 0..billions
 * with "hundred"/"thousand"/"million" scales. Returns null if no number words.
 */
function parseNumberWords(phrase: string): number | null {
  const tokens = phrase.split(/[\s-]+/).filter(Boolean);
  let total = 0;
  let current = 0;
  let sawAny = false;

  for (const tok of tokens) {
    if (tok === "and") continue; // "one hundred and five"
    if (tok in ONES) {
      current += ONES[tok]!;
      sawAny = true;
    } else if (tok in TENS) {
      current += TENS[tok]!;
      sawAny = true;
    } else if (tok === "hundred") {
      current = (current === 0 ? 1 : current) * 100;
      sawAny = true;
    } else if (tok in SCALES && tok !== "hundred") {
      const scale = SCALES[tok]!;
      total += (current === 0 ? 1 : current) * scale;
      current = 0;
      sawAny = true;
    } else {
      // Unknown token breaks the number phrase.
      break;
    }
  }
  if (!sawAny) return null;
  return total + current;
}

/**
 * Extract the two operands (in order) from a cleaned challenge string.
 *
 * Strategy: walk the tokens; collect a number whenever we hit either a digit
 * literal or a run of number-words; collect at most the first two. Digit
 * literals take precedence so "12.50" is read whole.
 */
function extractOperands(clean: string): number[] {
  const tokens = clean.split(" ").filter(Boolean);
  const nums: number[] = [];
  let wordRun: string[] = [];

  const flushWords = () => {
    if (wordRun.length === 0) return;
    const v = parseNumberWords(wordRun.join(" "));
    if (v !== null) nums.push(v);
    wordRun = [];
  };

  for (const tok of tokens) {
    // A pure decimal/integer literal (allow a single leading sign only if it is
    // the whole token, which deobfuscate isolated; but operands are unsigned in
    // these problems, so treat a lone "-"/"+"/"*"/"/" as an operator, not sign).
    if (/^[0-9]+(\.[0-9]+)?$/.test(tok)) {
      flushWords();
      nums.push(parseFloat(tok));
      if (nums.length >= 2) break;
      continue;
    }
    // Number word (possibly hyphen-compound like "thirty-four")?
    const wordParts = tok.split("-").filter(Boolean);
    const isNumberWord = wordParts.every(
      (p) => p in ONES || p in TENS || p in SCALES || p === "and",
    );
    if (isNumberWord && wordParts.length > 0) {
      for (const p of wordParts) wordRun.push(p);
      continue;
    }
    // Any other word terminates an in-progress word-run.
    flushWords();
    if (nums.length >= 2) break;
  }
  flushWords();
  return nums.slice(0, 2);
}

/**
 * Detect the single operator. Word cues win (robust against scattered glyph
 * noise); fall back to an isolated arithmetic glyph token if no word matched.
 */
function extractOperator(clean: string): Op | null {
  for (const { re, op } of OP_WORDS) {
    if (re.test(clean)) return op;
  }
  // Fall back: find a glyph that stands alone as a token (deobfuscate spaced
  // them out). Prefer the first such glyph between the two operands.
  const tokens = clean.split(" ").filter(Boolean);
  for (const tok of tokens) {
    if (tok === "*" || tok === "x") return "*";
    if (tok === "/") return "/";
    if (tok === "+") return "+";
    if (tok === "-") return "-";
  }
  return null;
}

/**
 * Solve the obfuscated lobster/physics math word-problem and return the answer
 * formatted to exactly 2 decimals ("NN.NN").
 *
 * The challenge text is UNTRUSTED data: this never executes it, only parses two
 * numbers + one operator (+ - * /). De-obfuscation strips scattered symbols and
 * normalizes alternating caps before parsing number words / digits.
 *
 * @param challenge_text Obfuscated math word problem from Moltbook.
 * @returns The numeric answer as a 2-decimal string, e.g. "42.00".
 * @throws Error if two operands and one operator cannot be parsed (so the caller
 *         does NOT submit a guessed answer toward the 10-failure auto-suspend).
 */
export function solveChallenge(challenge_text: string): string {
  const clean = deobfuscate(challenge_text);
  const operands = extractOperands(clean);
  const op = extractOperator(clean);

  if (operands.length < 2 || op === null) {
    throw new Error(
      `solveChallenge: could not parse a two-operand single-operator problem`,
    );
  }
  const [a, b] = operands as [number, number];

  let result: number;
  switch (op) {
    case "+":
      result = a + b;
      break;
    case "-":
      result = a - b;
      break;
    case "*":
      result = a * b;
      break;
    case "/":
      if (b === 0) {
        throw new Error("solveChallenge: division by zero in challenge");
      }
      result = a / b;
      break;
  }

  if (!Number.isFinite(result)) {
    throw new Error("solveChallenge: non-finite result");
  }
  return result.toFixed(2);
}

/** Construct a client bound to the founder-issued key. */
export function createMoltbookClient(apiKey: string): MoltbookClient {
  return new MoltbookClient(apiKey);
}

/* ------------------------------------------------------------------ */
/* Internal helpers (module-private)                                   */
/* ------------------------------------------------------------------ */

/** Build a URL query string (leading "?") from a sparse param map. */
function buildQuery(
  query?: Record<string, string | number | undefined>,
): string {
  if (!query) return "";
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    sp.append(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/** Parse the X-RateLimit-* / Retry-After headers off a response. */
function parseRateLimit(headers: Headers): RateLimitInfo {
  const num = (name: string): number | undefined => {
    const raw = headers.get(name);
    if (raw === null) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  return {
    limit: num("X-RateLimit-Limit"),
    remaining: num("X-RateLimit-Remaining"),
    reset: num("X-RateLimit-Reset"),
    retryAfter: num("Retry-After"),
  };
}

/** Structural type-guard for the verification-required envelope. */
function isVerificationRequired(v: unknown): v is VerificationRequired {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o.verification_required !== true) return false;
  const post = o.post as Record<string, unknown> | undefined;
  const ver = post?.verification as Record<string, unknown> | undefined;
  return (
    typeof ver === "object" &&
    ver !== null &&
    typeof ver.verification_code === "string" &&
    typeof ver.challenge_text === "string"
  );
}

/**
 * Typed Moltbook REST client. All authenticated traffic flows through the single
 * `request()` chokepoint, which is the ONLY place the key is attached and the
 * ONLY fetch() in the worker.
 */
export class MoltbookClient {
  /** @param apiKey Bearer key (env.MOLTBOOK_API_KEY). Held privately; never logged. */
  constructor(private readonly apiKey: string) {}

  /**
   * The ONE chokepoint for Moltbook traffic.
   *   1. Builds `url` from MOLTBOOK_API_BASE (+ path/query).
   *   2. Calls assertMoltbookUrl(url) BEFORE fetch (invariant #1 — the key is
   *      never sent off-origin).
   *   3. Attaches `Authorization: Bearer <apiKey>` unless `authenticated:false`
   *      (register() is the only unauthenticated call).
   *   4. Parses rate-limit headers; throws RateLimitError on 429 (with
   *      retry_after) and MoltbookHttpError on other non-2xx.
   *   5. Never includes the key in logs, errors, or the URL.
   *
   * @param method HTTP method.
   * @param path API path beginning with "/" (appended to MOLTBOOK_API_BASE).
   * @param opts  Optional JSON body, query params, and auth toggle.
   * @returns Parsed JSON of type T.
   */
  private async request<T>(
    method: string,
    path: string,
    opts?: {
      body?: unknown;
      query?: Record<string, string | number | undefined>;
      authenticated?: boolean;
    },
  ): Promise<T> {
    // 1. Build the URL strictly from the trusted base + caller path/query.
    const url = `${MOLTBOOK_API_BASE}${path}${buildQuery(opts?.query)}`;

    // 2. Structural guarantee: the key is only ever attached to a Moltbook URL.
    //    Runs BEFORE the credential is placed on the request.
    assertMoltbookUrl(url);

    // 3. Headers. Authorization is attached unless this is register().
    const authenticated = opts?.authenticated !== false;
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (authenticated) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    const hasBody = opts?.body !== undefined;
    if (hasBody) {
      headers["Content-Type"] = "application/json";
    }

    const res = await fetch(url, {
      method,
      headers,
      body: hasBody ? JSON.stringify(opts!.body) : undefined,
    });

    // 4. Parse rate-limit headers off EVERY response (success or error).
    const rateLimit = parseRateLimit(res.headers);

    if (res.status === 429) {
      // Never echo the key; the message is generic + the window is structured.
      throw new RateLimitError(rateLimit);
    }

    // Read the body once. Moltbook returns JSON; tolerate empty/non-JSON.
    const text = await res.text();
    let parsed: unknown = undefined;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text; // non-JSON body; surface raw text on errors
      }
    }

    if (!res.ok) {
      throw new MoltbookHttpError(res.status, rateLimit, parsed);
    }

    return parsed as T;
  }

  /**
   * Issue a write, and if Moltbook returns a verification challenge, solve the
   * math and POST /verify ONCE. On verify success returns `{ data }` (the verify
   * response); otherwise surfaces the (latest) VerificationRequired envelope so
   * the executor can decide whether to retry under its budget caps. A challenge
   * we cannot parse is surfaced un-attempted (we never submit a guess toward the
   * 10-consecutive-failure auto-suspend).
   */
  private async writeWithVerification<T>(
    method: string,
    path: string,
    body: unknown,
  ): Promise<WriteResult<T>> {
    const first = await this.request<unknown>(method, path, { body });

    if (!isVerificationRequired(first)) {
      return { data: first as T };
    }

    const challenge: VerificationChallenge = first.post.verification;

    let answer: string;
    try {
      answer = solveChallenge(challenge.challenge_text);
    } catch {
      // Unsolvable obfuscation: surface the envelope un-attempted.
      return first;
    }

    const verifyResp = await this.request<unknown>("POST", "/verify", {
      body: { verification_code: challenge.verification_code, answer },
    });

    // Moltbook may re-challenge (wrong answer / fresh problem). If so, surface
    // that fresh envelope rather than pretending success.
    if (isVerificationRequired(verifyResp)) {
      return verifyResp;
    }
    return { data: verifyResp as T };
  }

  // -- Account / identity -------------------------------------------------

  /** POST /agents/register — UNAUTHENTICATED, founder-run only. */
  async register(body: RegisterBody): Promise<RegisterResult> {
    return this.request<RegisterResult>("POST", "/agents/register", {
      body,
      authenticated: false,
    });
  }

  /** GET /agents/me — current agent profile. */
  async me(): Promise<unknown> {
    return this.request<unknown>("GET", "/agents/me");
  }

  /** GET /agents/status — pending_claim | claimed. */
  async status(): Promise<StatusResult> {
    return this.request<StatusResult>("GET", "/agents/status");
  }

  /** GET /home — one-call dashboard (account, activity, follows, what-to-do-next). */
  async home(): Promise<unknown> {
    return this.request<unknown>("GET", "/home");
  }

  // -- Reads --------------------------------------------------------------

  /** GET /feed?sort=&limit=[&filter=following]. */
  async feed(params?: {
    sort?: FeedSort;
    limit?: number;
    filter?: "following";
  }): Promise<unknown> {
    return this.request<unknown>("GET", "/feed", {
      query: {
        sort: params?.sort,
        limit: params?.limit,
        filter: params?.filter,
      },
    });
  }

  /** GET /posts?sort=&limit=[&cursor=]. */
  async listPosts(params?: {
    sort?: PostsSort;
    limit?: number;
    cursor?: string;
  }): Promise<unknown> {
    return this.request<unknown>("GET", "/posts", {
      query: {
        sort: params?.sort,
        limit: params?.limit,
        cursor: params?.cursor,
      },
    });
  }

  /** GET /posts/:id. */
  async getPost(postId: string): Promise<unknown> {
    return this.request<unknown>(
      "GET",
      `/posts/${encodeURIComponent(postId)}`,
    );
  }

  /** GET /posts/:id/comments?sort=&limit=[&cursor=]. */
  async getComments(
    postId: string,
    params?: { sort?: CommentsSort; limit?: number; cursor?: string },
  ): Promise<unknown> {
    return this.request<unknown>(
      "GET",
      `/posts/${encodeURIComponent(postId)}/comments`,
      {
        query: {
          sort: params?.sort,
          limit: params?.limit,
          cursor: params?.cursor,
        },
      },
    );
  }

  /** GET /search?q=&type=&limit=. */
  async search(
    q: string,
    params?: { type?: SearchType; limit?: number },
  ): Promise<unknown> {
    return this.request<unknown>("GET", "/search", {
      query: { q, type: params?.type, limit: params?.limit },
    });
  }

  // -- Writes (may return a verification challenge) -----------------------

  /** POST /posts — create a post. Auto-solves & POSTs /verify on challenge. */
  async createPost(body: CreatePostBody): Promise<WriteResult<unknown>> {
    return this.writeWithVerification<unknown>("POST", "/posts", body);
  }

  /** POST /posts/:id/comments — comment or threaded reply. Auto-verifies on challenge. */
  async createComment(
    postId: string,
    body: CreateCommentBody,
  ): Promise<WriteResult<unknown>> {
    return this.writeWithVerification<unknown>(
      "POST",
      `/posts/${encodeURIComponent(postId)}/comments`,
      body,
    );
  }

  /** POST /posts/:id/upvote. */
  async upvotePost(postId: string): Promise<WriteResult<unknown>> {
    return this.writeWithVerification<unknown>(
      "POST",
      `/posts/${encodeURIComponent(postId)}/upvote`,
      undefined,
    );
  }

  /** POST /posts/:id/downvote. */
  async downvotePost(postId: string): Promise<WriteResult<unknown>> {
    return this.writeWithVerification<unknown>(
      "POST",
      `/posts/${encodeURIComponent(postId)}/downvote`,
      undefined,
    );
  }

  /** POST /comments/:id/upvote. */
  async upvoteComment(commentId: string): Promise<WriteResult<unknown>> {
    return this.writeWithVerification<unknown>(
      "POST",
      `/comments/${encodeURIComponent(commentId)}/upvote`,
      undefined,
    );
  }

  /** POST /agents/:name/follow. */
  async follow(agentName: string): Promise<WriteResult<unknown>> {
    return this.writeWithVerification<unknown>(
      "POST",
      `/agents/${encodeURIComponent(agentName)}/follow`,
      undefined,
    );
  }

  /** DELETE /agents/:name/follow. */
  async unfollow(agentName: string): Promise<WriteResult<unknown>> {
    return this.writeWithVerification<unknown>(
      "DELETE",
      `/agents/${encodeURIComponent(agentName)}/follow`,
      undefined,
    );
  }

  /** POST /verify — answer a write-verification math challenge ("NN.NN"). */
  async verify(body: VerifyBody): Promise<unknown> {
    return this.request<unknown>("POST", "/verify", { body });
  }
}
