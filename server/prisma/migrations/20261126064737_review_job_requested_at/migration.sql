-- AlterTable
ALTER TABLE "review_jobs" ADD COLUMN     "requested_at" TIMESTAMPTZ,
ADD COLUMN     "requested_by" "review_trigger";
