import { z } from "zod";
import { MAX_CHANGE_NUMBER, MAX_FOCUS, normalizeFocus } from "../review/core/models.ts";
import { pageSchema } from "./pagination.ts";

const changeNumber = z.number().int().min(1).max(MAX_CHANGE_NUMBER);

// The area this one review should look hardest at; blank means none.
const focus = z
  .string()
  .trim()
  .max(MAX_FOCUS, `Keep the focus under ${MAX_FOCUS} characters`)
  .optional()
  .transform((value) => normalizeFocus(value) ?? undefined);

export const createReviewSchema = z.object({
  url: z.string().trim().min(1, "Paste a pull or merge request URL"),
  focus,
});

// Picked from a repository's open changes rather than pasted as a link.
export const createReviewByRepoSchema = z.object({
  repoId: z.uuid(),
  number: changeNumber,
  focus,
});

export const listReviewsQuerySchema = z.object({
  repoId: z.uuid().optional(),
  status: z.enum(["queued", "running", "completed", "partial", "failed", "superseded", "skipped", "cancelled"]).optional(),
  verdict: z.enum(["pass", "blocked", "error"]).optional(),
  trigger: z.enum(["manual", "webhook", "comment"]).optional(),
  number: z.coerce.number().pipe(changeNumber).optional(),
  q: z.string().trim().max(200).optional(),
  // Superseded runs never reached a model; they are noise unless asked for.
  includeSuperseded: z.stringbool().default(false),
  // "changes" collapses every run of a pull/merge request into its latest one.
  view: z.enum(["changes", "runs"]).default("runs"),
  page: pageSchema,
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const reviewStatsQuerySchema = z.object({
  repoId: z.uuid().optional(),
  days: z.coerce.number().int().min(1).max(90).default(7),
});

export const reviewIdParamSchema = z.object({ id: z.uuid() });
