-- Preserve derived content for installations that have not applied this step.
-- Versioned history_index_migration cleans it in place and also repairs databases
-- where the earlier release already executed DELETE FROM history_fts.
SELECT 1;
