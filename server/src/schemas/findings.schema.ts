import { z } from "zod";
import { CATEGORIES, KINDS, SEVERITIES } from "../review/core/severity.ts";

export const findingStateSchema = z.enum(["open", "resolved", "ignored"]);

export const ignoreReasonSchema = z.enum(["false_positive", "intentional", "fix_later", "not_specified"]);

export const listFindingsQuerySchema = z.object({
  repoId: z.uuid().optional(),
  state: findingStateSchema.optional(),
  ignoreReason: ignoreReasonSchema.optional(),
  severity: z.enum(SEVERITIES).optional(),
  category: z.enum(CATEGORIES).optional(),
  kind: z.enum(KINDS).optional(),
  q: z.string().trim().max(200).optional(),
  sort: z
    .enum(["title", "number", "repository", "state", "severity", "category", "kind", "author", "lastSeenAt"])
    .default("lastSeenAt"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const findingStatsQuerySchema = z.object({
  repoId: z.uuid().optional(),
  days: z.coerce.number().int().min(1).max(365).default(30),
});

export const findingIdParamSchema = z.object({ id: z.uuid() });

// "resolved" belongs to the worker: only a later run can show a finding is gone.
export const updateFindingSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("open") }),
  z.object({
    state: z.literal("ignored"),
    reason: ignoreReasonSchema.default("not_specified"),
    note: z.string().trim().max(1000, "Keep the note under 1000 characters").optional(),
  }),
]);
