-- AlterTable
ALTER TABLE "findings" ADD COLUMN     "model" TEXT;

-- Best-effort backfill from the run that last reported each finding: the one
-- model its review passes used, else (results from before usage was recorded)
-- the model it was configured with. A run that used several models cannot say
-- which raised the finding, and tool or rule findings came from no model, so
-- those stay null.
UPDATE "findings" f
SET "model" = COALESCE(
  (
    SELECT min(u->>'model')
    FROM jsonb_array_elements(j."result"->'usage') u
    WHERE u->>'purpose' = 'review'
    HAVING count(DISTINCT u->>'model') = 1
  ),
  CASE WHEN NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(j."result"->'usage') u WHERE u->>'purpose' = 'review'
  ) THEN j."resolved_config" #>> '{config,llm,model}' END
)
FROM "review_jobs" j
WHERE j."id" = f."last_job_id"
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(j."result"->'findings') rf
    WHERE rf->>'fingerprint' = f."fingerprint" AND rf->>'source' IN ('tool', 'rule')
  );
