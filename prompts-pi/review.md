---
description: Have the reviewer subagent review the current changes
argument-hint: "[optional focus]"
---

Use the Agent tool with `subagent_type: "reviewer"` and `run_in_background: false` to review the
changes in this repository, then report its findings verbatim.

Focus: $ARGUMENTS

Give the reviewer the concrete artifact to inspect (staged/unstaged diff, branch, or the plan file)
rather than a general instruction.
