-- Explicit `model` of actor spawn/run, stored resolved as provider/model so a finished subagent
-- woken by actor send runs on the same model. NULL = no explicit model (inherit / agent config).
ALTER TABLE `actor_registry` ADD COLUMN `model_ref` text;
