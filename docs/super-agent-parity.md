# Super-agent reference and scope

The behavioral reference is DeepSeek's public `dsh-superagent-prototype` at `8c32a9d`: intake routes requests, a task retains a Worker/workspace, the Worker executes and self-reviews, and thread follow-ups return to that task. MiMo implements this ownership model with native Sessions, Inbox, Actors and Todo.

This is not source or feature parity. This refactor deliberately omits the prototype's custom background shell engine, extra human-priority slot, web panel, assignment subsystem and deployment-specific integrations. It also removes our previous independent Verifier/candidate state machine, duplicate planning tools and alternate chat renderer. No additional Super-agent token or round counter is introduced.

See [current architecture, usage and acceptance boundary](super-agent.md). Deterministic lifecycle tests do not prove better delivery quality than Build. A quality comparison must freeze this new implementation and rerun identical external benchmark cases and scoring; earlier results cannot be attributed to it.
