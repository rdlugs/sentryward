import type { Prisma } from "../generated/prisma/client.ts";
import { prisma } from "./prisma.ts";

type Scope = "enqueue" | "replies" | "backlog" | "approval";

// Serializes work on one pull/merge request until the transaction ends. Each
// kind of work has its own scope, so queueing a review never waits on a thread
// reply being recorded for the same change, and the reverse. The backlog is
// per repository, so its lock passes number 0 (no change has it) to cover them all.
export async function lockChange(
  tx: Prisma.TransactionClient,
  scope: Scope,
  repositoryId: string,
  number: number,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${scope}:${repositoryId}`}::text), ${number}::int)`;
}

export interface HeldLock {
  release(): Promise<void>;
}

// The lock above, held across work that is not itself in the transaction (forge
// calls, writes through the shared client) until release(). The transaction
// only keeps the lock: it is opened, locked and left waiting. `timeoutMs`
// bounds the whole hold, so a holder that never releases (a crash mid-run)
// frees the lock when Prisma rolls the transaction back; `waitMs` bounds the
// wait for the lock, and a lock not taken in time rejects.
export function holdChangeLock(
  scope: Scope,
  repositoryId: string,
  number: number,
  options: { timeoutMs: number; waitMs?: number },
): Promise<HeldLock> {
  return new Promise<HeldLock>((resolveHeld, rejectHeld) => {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => (finish = resolve));
    let acquired = false;
    const done: Promise<void> = prisma.$transaction(
      async (tx) => {
        if (options.waitMs !== undefined) {
          await tx.$executeRaw`SELECT set_config('lock_timeout', ${`${Math.max(1, Math.round(options.waitMs))}ms`}, true)`;
        }
        await lockChange(tx, scope, repositoryId, number);
        acquired = true;
        resolveHeld({
          release: async () => {
            finish();
            await done.catch(() => undefined);
          },
        });
        await finished;
      },
      { timeout: options.timeoutMs, maxWait: options.timeoutMs },
    );
    done.catch((err: unknown) => {
      if (!acquired) rejectHeld(err);
      // A hold past its timeout was rolled back, which released the lock early.
      else console.error("[lock] change lock %s:%s#%d ended before its release", scope, repositoryId, number, err);
    });
  });
}
