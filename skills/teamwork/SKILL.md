---
name: teamwork
description: Coordinate overlapping edits with existing peers when the user authorizes shared-workspace collaboration.
---

Use only the communication channel and workspace the user authorized. This skill does not grant permission to create or message unrelated agents.

Before broad exploration, post a short scope/status note and one concrete interface proposal to the relevant peer. State which files you expect to edit and what evidence or decision you need. Use actual timestamps from a clock, not invented times. Check replies at phase boundaries, not in polling loops.

Before editing a shared file, acquire the agreed claim atomically. Record your identity and exact file path, re-read current contents, edit, verify, and release only your own claim. A written intention or old release note does not replace successful claim acquisition. Advisory claims are coordination, not a security boundary. If blocked, work on an independent module or leave an integration patch; never overwrite a peer's inbox or remove their lock.

Append messages, include the recipient and a specific question or result, and put replies in the recipient's inbox. Report test results with the code state they apply to. Coordinate one final build/integration owner instead of repeatedly running full suites while peers write.

A queued peer cannot answer. Avoid waiting indefinitely or holding a long model turn solely to poll: leave a bounded handoff with unresolved decisions. Preserve partial edits after interruption and verify their state before replaying actions.
