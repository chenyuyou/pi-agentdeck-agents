---
description: Ask the planner subagent for an implementation plan
argument-hint: "<feature, change, or problem to plan>"
---

Use the Agent tool with `subagent_type: "planner"` and `run_in_background: false` to produce an
implementation plan for this, then present the plan as-is:

$ARGUMENTS

Do not start implementing. If the planner lists open decisions, ask me before coding.
