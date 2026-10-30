-- AlterTable
ALTER TABLE "repositories" ADD COLUMN     "position" INTEGER;

-- CreateIndex
CREATE INDEX "review_jobs_repository_id_created_at_idx" ON "review_jobs"("repository_id", "created_at");
