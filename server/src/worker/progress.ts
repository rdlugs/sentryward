import type { Config } from "../review/config/schema.ts";
import type { PipelineProgress, ReviewProgress, ReviewStep } from "../review/core/models.ts";
import { publishes } from "../review/publish/publisher.ts";
import { verifies } from "../review/validate/verify.ts";
import { recordProgress } from "./queue.ts";

export type WriteProgress = (id: string, attempts: number, progress: ReviewProgress) => Promise<void>;

export interface ProgressRecorder {
  set(progress: PipelineProgress): void;
  // The steps the run will go through, kept on every later write.
  plan(steps: ReviewStep[]): void;
  // Waits for the writes already asked for, so none lands after the job finishes.
  flush(): Promise<void>;
}

// The steps a run with this config goes through, from the same checks that
// decide whether the pipeline and runJob report verifying and publishing.
export function reviewSteps(config: Config): ReviewStep[] {
  return [
    "fetching",
    "preparing",
    "reviewing",
    ...(verifies(config) ? (["verifying"] as const) : []),
    ...(publishes(config) ? (["publishing"] as const) : []),
  ];
}

// Progress is best effort: a failed write is logged and never fails the
// review. Writes go one at a time, and while one is in flight only the latest
// update waits behind it, so passes finishing together cost one write, not
// one each, and an older stage never lands after a newer one.
export function progressRecorder(
  job: { id: string; attempts: number },
  write: WriteProgress = recordProgress,
): ProgressRecorder {
  let steps: ReviewStep[] | undefined;
  let pending: ReviewProgress | undefined;
  let running: Promise<void> | undefined;

  const drain = async () => {
    while (pending) {
      const next = pending;
      pending = undefined;
      await write(job.id, job.attempts, next).catch((err: unknown) =>
        console.error(`[worker] could not record progress for job ${job.id}`, err),
      );
    }
    running = undefined;
  };

  const set = (progress: PipelineProgress) => {
    pending = steps ? { ...progress, steps } : progress;
    running ??= drain();
  };

  return {
    set,
    plan(planned) {
      steps = planned;
    },
    flush: () => running ?? Promise.resolve(),
  };
}
