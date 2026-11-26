import type { ChangeSet } from "../core/models.ts";
import type { Config } from "./schema.ts";

type Change = Pick<ChangeSet, "title" | "author" | "labels" | "baseRef" | "headRef">;

// The review_jobs trigger (ReviewTrigger in prisma/schema.prisma), spelled out
// so the review engine does not import the database client.
export type ReviewTrigger = "manual" | "webhook" | "comment";

// Why an automatic review should not run for this change, or null. Titles and
// branches match on a substring (titles ignoring case, so "wip" catches
// "WIP:"); logins and labels must match exactly, labels case-sensitively as
// the forges treat them. `actor` is whoever opened or pushed, which can differ
// from the author.
export function skipFilterReason(triggers: Config["triggers"], change: Change, actor?: string | null): string | null {
  const title = change.title.toLowerCase();
  const phrase = triggers.ignoreTitles.find((p) => title.includes(p.toLowerCase()));
  if (phrase) return `The title contains "${phrase}"`;

  const people = [change.author, actor].filter((login): login is string => Boolean(login));
  const login = people.find((person) => triggers.skipAuthors.some((skip) => skip.toLowerCase() === person.toLowerCase()));
  if (login) return `Changes by ${login} are not reviewed automatically`;

  const label = (change.labels ?? []).find((name) => triggers.skipLabels.includes(name));
  if (label) return `The change has the label "${label}"`;

  const source = change.headRef && triggers.skipSourceBranches.find((part) => change.headRef!.includes(part));
  if (source) return `The source branch ${change.headRef} matches "${source}"`;

  const target = change.baseRef && triggers.skipTargetBranches.find((part) => change.baseRef!.includes(part));
  if (target) return `The target branch ${change.baseRef} matches "${target}"`;

  return null;
}

// Matched exactly by worker/burst.ts to tell that a change is still paused, so
// the wording is part of the behaviour.
export const BURST_PAUSED_REASON =
  "Automatic reviews are paused after a burst of pushes; comment /sentryward review to resume";

// The change's push history, read by the worker (worker/burst.ts): pushes
// since the window opened (or since the last requested review, if later),
// counting this one, and whether a pause began after that request.
export type PushBurst = { pushesInWindow: number; pausedSinceRequest: boolean };

// Decided by the worker rather than in the webhook handler, because only then
// is the full configuration known, including the repository file. A manual
// review is never skipped; someone asked for it, and so did a permitted review
// command. Without `burst` (the trigger check, which has no history) a push is
// never paused.
export function skipReason(
  job: { trigger: ReviewTrigger; event?: string | null; actor?: string | null },
  config: Config,
  change: Parameters<typeof skipFilterReason>[1] & { isDraft: boolean },
  burst?: PushBurst,
): string | null {
  const { triggers } = config;
  if (job.trigger === "webhook") {
    if (triggers.review === "manual") return "Automatic reviews are turned off for this repository";
    if (change.isDraft && triggers.review !== "all") return "Draft changes are not reviewed automatically";
    if (job.event === "push" && !triggers.reviewOnPush) return "New commits are not reviewed automatically";
    const filtered = skipFilterReason(triggers, change, job.actor);
    if (filtered) return filtered;
    // Checked last, so a change the filters skip anyway is not marked paused.
    if (job.event === "push" && triggers.pauseOnBurst && burst) {
      if (burst.pausedSinceRequest || burst.pushesInWindow >= triggers.pauseAfterPushes) return BURST_PAUSED_REASON;
    }
    return null;
  }
  if (job.trigger === "comment" && !triggers.command) {
    return "Review commands are turned off for this repository";
  }
  return null;
}

// Automatic reviews include the walkthrough only when the summary trigger
// allows it; a requested review follows the walkthrough setting alone.
export function walkthroughEnabled(trigger: ReviewTrigger, config: Config, isDraft: boolean): boolean {
  if (!config.output.walkthrough) return false;
  if (trigger !== "webhook") return true;
  return config.triggers.summary === "published" && !isDraft;
}
