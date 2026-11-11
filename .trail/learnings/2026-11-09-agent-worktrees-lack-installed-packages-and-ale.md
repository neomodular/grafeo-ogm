---
title: "Agent worktrees lack installed packages and cannot sign commits, so the main session finishes them"
author: Ale
date: 2026-11-09
standing: true
id: l-f9d59615
scope: repo
status: active
src: init-sessions
---

## Watch out
- Lint and type checks failed in lane worktrees only because dependencies were missing, not because of the code. Agents also cannot enter the ssh key passphrase, so their commits come out unsigned.
- In the code: In `.claude/worktrees/*`, symlink the main checkout's `node_modules` for the run and remove it before committing. Re-sign with `git rebase --exec 'git commit --amend --no-edit -S' main` after the user loads the key with ssh-add. Agents may commit with `-c commit.gpgsign=false`.

_From past Claude sessions here, Oct 24._
