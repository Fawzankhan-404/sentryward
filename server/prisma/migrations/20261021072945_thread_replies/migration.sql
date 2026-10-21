-- CreateEnum
CREATE TYPE "thread_reply_kind" AS ENUM ('ignore', 'question');

-- CreateEnum
CREATE TYPE "thread_reply_status" AS ENUM ('queued', 'running', 'done', 'skipped', 'failed');

-- CreateTable
CREATE TABLE "thread_replies" (
    "id" UUID NOT NULL,
    "repository_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "thread_id" TEXT NOT NULL,
    "comment_id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "kind" "thread_reply_kind" NOT NULL,
    "body" TEXT NOT NULL,
    "ignore_reason" "ignore_reason",
    "ignore_note" TEXT,
    "status" "thread_reply_status" NOT NULL DEFAULT 'queued',
    "answer_comment_id" TEXT,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_at" TIMESTAMPTZ,
    "finished_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "thread_replies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "thread_replies_repository_id_number_created_at_idx" ON "thread_replies"("repository_id", "number", "created_at");

-- CreateIndex
CREATE INDEX "thread_replies_status_created_at_idx" ON "thread_replies"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "thread_replies_repository_id_comment_id_key" ON "thread_replies"("repository_id", "comment_id");

-- AddForeignKey
ALTER TABLE "thread_replies" ADD CONSTRAINT "thread_replies_repository_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
