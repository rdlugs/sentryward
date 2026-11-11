-- AlterTable
ALTER TABLE "notification_targets" ADD COLUMN     "membership_id" UUID;

-- AlterTable
ALTER TABLE "review_jobs" ADD COLUMN     "author_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "notification_targets_membership_id_key" ON "notification_targets"("membership_id");

-- AddForeignKey
ALTER TABLE "notification_targets" ADD CONSTRAINT "notification_targets_membership_id_fkey" FOREIGN KEY ("membership_id") REFERENCES "memberships"("id") ON DELETE CASCADE ON UPDATE CASCADE;
