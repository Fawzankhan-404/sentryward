import { createHash, timingSafeEqual } from "node:crypto";
import type { IgnoreReason } from "../generated/prisma/client.ts";
import { HttpError } from "./httpError.ts";

// "/sentryward review" at the start of any line of a comment.
export const REVIEW_COMMAND = /^\/sentryward\s+review\b/im;

// "/sentryward ignore <reason> [note]" at the start of any line of a reply on a
// finding's thread; the rest of that line is the note.
const IGNORE_COMMAND = /^\/sentryward\s+ignore\b[ \t]*(\S*)[ \t]*(.*)$/im;

const IGNORE_REASONS: Record<string, IgnoreReason> = {
  "false-positive": "false_positive",
  intentional: "intentional",
};

// Same cap as a note typed in the dashboard (schemas/findings.schema.ts).
const MAX_NOTE = 1000;

export type ParsedReply =
  | { kind: "ignore"; reason: IgnoreReason | null; note: string | null }
  | { kind: "question" };

// What a reply on a finding's thread asks for. Anything that is not an ignore
// command is a question. A reason that is not understood keeps kind "ignore"
// with a null reason, so the bot answers with usage instead of guessing.
export function parseReply(body: string): ParsedReply {
  const match = IGNORE_COMMAND.exec(body);
  if (!match) return { kind: "question" };
  const reason = IGNORE_REASONS[match[1]!.toLowerCase()] ?? null;
  const note = match[2]!.trim().slice(0, MAX_NOTE);
  return { kind: "ignore", reason, note: note || null };
}

// Equal-length digests so the comparison takes the same time whatever the input.
export function safeEqual(a: string, b: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}

export function parseJson<T>(raw: Buffer): T {
  try {
    return JSON.parse(raw.toString("utf8")) as T;
  } catch {
    throw new HttpError(400, "Body is not JSON");
  }
}
