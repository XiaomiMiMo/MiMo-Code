-- Raw `model` argument of actor spawn/run (group name or provider/model), resolved again when a
-- finished subagent is woken by actor send. NULL = no explicit model (inherit / agent config).
ALTER TABLE `actor_registry` ADD COLUMN `model_ref` text;
