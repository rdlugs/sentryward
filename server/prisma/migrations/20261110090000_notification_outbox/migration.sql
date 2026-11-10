-- AlterEnum
ALTER TYPE "notification_delivery_status" ADD VALUE 'pending';

-- AlterTable
ALTER TABLE "notification_deliveries" ADD COLUMN     "locked_at" TIMESTAMPTZ,
ADD COLUMN     "next_attempt_at" TIMESTAMPTZ,
ADD COLUMN     "payload" JSONB,
ALTER COLUMN "attempts" SET DEFAULT 0,
ALTER COLUMN "finished_at" DROP NOT NULL;

-- AlterTable
ALTER TABLE "notification_targets" ADD COLUMN     "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "paused_reason" TEXT;

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN     "notify_auto_pause_after" INTEGER NOT NULL DEFAULT 5;

-- CreateIndex
CREATE INDEX "notification_deliveries_status_next_attempt_at_idx" ON "notification_deliveries"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "notification_deliveries_target_id_job_id_key" ON "notification_deliveries"("target_id", "job_id");

