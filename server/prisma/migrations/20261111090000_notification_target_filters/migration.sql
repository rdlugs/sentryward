-- CreateEnum
CREATE TYPE "notification_min_severity" AS ENUM ('minor', 'major', 'critical');

-- AlterEnum
ALTER TYPE "notification_event" ADD VALUE 'resolved';

-- AlterTable
ALTER TABLE "notification_targets" ADD COLUMN     "min_severity" "notification_min_severity",
ADD COLUMN     "only_verdict_changes" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "repository_ids" UUID[] DEFAULT ARRAY[]::UUID[];
