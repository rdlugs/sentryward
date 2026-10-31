-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN     "llm_provider_order" TEXT[] DEFAULT ARRAY[]::TEXT[];
