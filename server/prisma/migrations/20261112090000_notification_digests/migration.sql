-- CreateEnum
CREATE TYPE "notification_delivery_mode" AS ENUM ('each', 'daily', 'weekly');

-- AlterEnum
ALTER TYPE "notification_delivery_status" ADD VALUE 'held';

-- AlterTable
ALTER TABLE "notification_targets" ADD COLUMN     "delivery_mode" "notification_delivery_mode" NOT NULL DEFAULT 'each',
ADD COLUMN     "digest_due_at" TIMESTAMPTZ,
ADD COLUMN     "digest_hour" INTEGER,
ADD COLUMN     "digest_since" TIMESTAMPTZ,
ADD COLUMN     "digest_time_zone" TEXT,
ADD COLUMN     "digest_weekday" INTEGER;

-- CreateIndex
CREATE INDEX "notification_targets_digest_due_at_idx" ON "notification_targets"("digest_due_at");
