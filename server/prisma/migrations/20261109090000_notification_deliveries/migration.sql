-- CreateEnum
CREATE TYPE "notification_delivery_status" AS ENUM ('sent', 'failed');

-- CreateTable
CREATE TABLE "notification_deliveries" (
    "id" UUID NOT NULL,
    "target_id" UUID NOT NULL,
    "job_id" UUID,
    "event" TEXT NOT NULL,
    "status" "notification_delivery_status" NOT NULL,
    "http_status" INTEGER,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notification_deliveries_target_id_created_at_idx" ON "notification_deliveries"("target_id", "created_at");

-- CreateIndex
CREATE INDEX "notification_deliveries_created_at_idx" ON "notification_deliveries"("created_at");

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "notification_targets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "review_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
