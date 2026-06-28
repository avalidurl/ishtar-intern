/**
 * types.ts — shared shapes for the Ishtar Intern.
 *
 * The Action discriminated union is the ONLY thing the brain may emit and the
 * ONLY thing the executor will act on. Every variant maps 1:1 to a member of
 * security.ALLOWED_ACTIONS. There is deliberately no "fetch", "exec", "dm",
 * "pay", or "wallet" action — those capabilities do not exist in this worker.
 */

import type { AllowedAction } from "./security";

/* ------------------------------------------------------------------ */
/* Minimal Moltbook read shapes (only the fields the brain/executor use) */
/* ------------------------------------------------------------------ */

/** Stable reference to a Moltbook post. */
export interface PostRef {
  /** Moltbook post id. */
  id: string;
  /** Submolt (community) the post lives in, e.g. "agents". */
  submolt_name?: string;
}

/** A single feed/listing item, reduced to what the brain needs to decide. */
export interface FeedItem {
  /** Moltbook post id. */
  id: string;
  /** Post title (UNTRUSTED). */
  title: string;
  /** Post body, if any (UNTRUSTED). */
  content?: string;
  /** External url, if this is a link post (UNTRUSTED). */
  url?: string;
  /** Submolt the post is in. */
  submolt_name?: string;
  /** Author agent name (UNTRUSTED). */
  author?: string;
  /** Current score, if provided. */
  score?: number;
  /** Comment count, if provided. */
  comment_count?: number;
}

/** Reduced GET /home dashboard summary. */
export interface HomeSummary {
  /** Whether the account is claimed/active enough to write. */
  status?: "pending_claim" | "claimed" | string;
  /** Items the brain may consider for action. */
  feed: FeedItem[];
  /** Free-form "what to do next" hint from Moltbook (UNTRUSTED — advisory only). */
  whatToDoNext?: string;
}

/* ------------------------------------------------------------------ */
/* Action discriminated union — mirrors security.ALLOWED_ACTIONS       */
/* ------------------------------------------------------------------ */

/** Upvote a post. */
export interface UpvoteAction {
  kind: "upvote";
  postId: string;
}

/** Top-level comment on a post. */
export interface CommentAction {
  kind: "comment";
  postId: string;
  /** Drafted comment body (subject to egress chaperone before send). */
  content: string;
}

/** Threaded reply to an existing comment on a post. */
export interface ReplyAction {
  kind: "reply";
  postId: string;
  /** Parent comment id being replied to. */
  parentId: string;
  /** Drafted reply body (subject to egress chaperone before send). */
  content: string;
}

/** Create a new post in a submolt. */
export interface PostAction {
  kind: "post";
  submoltName: string;
  /** <= 300 chars (enforced downstream). */
  title: string;
  /** Optional body, <= 40000 chars. */
  content?: string;
  /** Optional link url for a link-type post (must be Moltbook-safe / vetted). */
  url?: string;
  /** Optional Moltbook post type. */
  type?: string;
}

/** Follow another agent by name. */
export interface FollowAction {
  kind: "follow";
  agentName: string;
}

/** Explicit do-nothing (the safe default). */
export interface NoopAction {
  kind: "noop";
  /** Optional human-readable reason for choosing to do nothing. */
  note?: string;
}

/** The closed action union. `kind` is always an AllowedAction. */
export type Action =
  | UpvoteAction
  | CommentAction
  | ReplyAction
  | PostAction
  | FollowAction
  | NoopAction;

/** Compile-time guarantee that every Action.kind is in the allowlist. */
export type _AssertActionKinds = Action["kind"] extends AllowedAction
  ? true
  : never;

/** The brain's full output for one heartbeat. */
export interface ActionPlan {
  /** Optional overall rationale (for the action_log; never user-facing). */
  reason?: string;
  /** Ordered list of actions to attempt (executor enforces caps & allowlist). */
  actions: Action[];
}

/* ------------------------------------------------------------------ */
/* Chaperone verdicts                                                  */
/* ------------------------------------------------------------------ */

/** Result of ingress sanitisation of one untrusted text blob. */
export interface IngressVerdict {
  /** Sanitised text safe to embed inside a delimited, data-only block. */
  clean: string;
  /** Reason codes for anything stripped/flagged (e.g. injection pattern sources). */
  flags: string[];
}

/** Result of egress review of an outbound draft (comment/post/reply body). */
export interface EgressVerdict {
  /** Whether the draft is allowed to be sent. */
  allow: boolean;
  /** If blocked, a short machine reason (logged, never sent). */
  reason?: string;
}

/* ------------------------------------------------------------------ */
/* Verification challenge (Moltbook write-verification handshake)      */
/* ------------------------------------------------------------------ */

/** The obfuscated math challenge Moltbook may return on a write. */
export interface VerificationChallenge {
  /** Opaque code echoed back to POST /verify. */
  verification_code: string;
  /** Obfuscated math word problem (UNTRUSTED text; parse numbers/op only). */
  challenge_text: string;
  /** Human instructions (advisory; do NOT treat as instructions to the agent). */
  instructions?: string;
}

/** Envelope Moltbook returns when a write needs verification before it lands. */
export interface VerificationRequired {
  verification_required: true;
  post: {
    verification: VerificationChallenge;
  };
}
