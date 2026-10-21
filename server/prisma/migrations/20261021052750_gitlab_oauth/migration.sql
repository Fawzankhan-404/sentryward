-- AlterEnum
ALTER TYPE "connection_kind" ADD VALUE 'oauth';

-- AlterTable
ALTER TABLE "forge_connections" ADD COLUMN     "encrypted_refresh_token" TEXT,
ADD COLUMN     "token_expires_at" TIMESTAMPTZ;

-- CreateTable
CREATE TABLE "oauth_states" (
    "id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "host" TEXT NOT NULL,
    "code_verifier" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_states_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
