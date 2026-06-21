---
description: Deep pre-ship pass — hunt development smells, refactor, and verify against the checklist with pasted evidence
---

The owner has decided this project is finished and wants the Phase 2 deep pass.
The owner does not read code, so every claim must be backed by visible evidence in
the chat, and the final report must be in plain English.

Do the following, in order:

1. **Read the checklist.** Open `.claude/pre-ship-checklist.yaml` and follow it.

2. **Detect the project type.** Decide whether this is a static site (files only,
   e.g. GitHub Pages) or has a server/API/edge functions you control. State which,
   and therefore which checks apply. Skip the server-only checks for a static site.

3. **Smell hunt + refactor.** Find development smells (dead code, leftover
   test/preview files, commented-out blocks, duplicated markup, hardcoded values
   that should be variables, unclear naming, unused images/CSS/scripts). Show the
   owner what you propose to remove and why, then clean it up. When unsure about
   deleting something, ask before deleting.

4. **Run every applicable check.** For each one, actually run it (grep, read the
   file, run the audit) and **paste the evidence** into the chat, followed by a
   one-line plain-English verdict. Never assert "passed" without showing why.

5. **Final report** in plain English: what was cleaned up, which checks passed
   (with the evidence shown), which failed or were skipped and what that means, and
   anything that needs the owner's decision before going live.

Do not push or deploy anything. This pass prepares the project; the owner ships.
