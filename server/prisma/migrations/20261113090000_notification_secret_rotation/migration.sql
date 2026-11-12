-- AlterTable
ALTER TABLE "notification_targets" ADD COLUMN     "encrypted_previous_secret" TEXT,
ADD COLUMN     "previous_secret_expires_at" TIMESTAMPTZ;
