# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased] - 2026-04-28

### Added

- Auto-compact resume pipeline: when pi auto-compacts context, autoresearch now automatically resumes the loop by detecting `session_compact` events and re-prompting the agent to re-read `autoresearch.md`, the tail of `autoresearch.jsonl`, `autoresearch.ideas.md`, and `git log` before continuing.
- Before/after iteration hooks: optional `autoresearch.hooks/before.sh` and `autoresearch.hooks/after.sh` scripts fire at iteration boundaries, with JSON context on stdin and stdout captured as steer messages for the agent.
- `autoresearch-hooks` skill with 10 example hook scripts for research fetching, learnings capture, notifications, anti-thrash, and idea rotation.
- Live dashboard export: `/autoresearch export` opens a browser-based live dashboard with SSE updates showing experiment history, charts, and metrics.
- `/autoresearch off` now aborts any running operation via `ctx.abort()`.
- `/autoresearch clear` now deletes `autoresearch.jsonl`.
- `autoresearch-finalize` skill: turns noisy experiment branches into clean, independent review branches.
- System prompt injection (`before_agent_start`): when autoresearch mode is active, the extension adds persistent guidance to every turn's system prompt, surviving compaction.
- Auto-detection of active autoresearch sessions on startup (if `autoresearch.jsonl` exists, mode is re-activated).

### Fixed

- Windows support: the harness now starts lazily on the first autoresearch command without `npx`, avoids visible console windows, uses the OS temp directory for logs, resolves Git Bash, terminates process trees, and handles worktree paths across separators.
- The npm `pi-autoresearch` binary now uses a JavaScript launcher instead of asking Node to execute TypeScript directly.
- Manual `/compact` mid-iteration no longer leaves the loop stuck — `session_compact` schedules a fresh resume.
- Compaction during agent setup (before the first `log_experiment`) now resumes — the post-compaction gate is permissive.
- Rapid back-to-back compactions all resume — no cooldown gate.

### Removed

- Removed `lastAutoResumeTime` from runtime (the cooldown it supported is replaced by `MAX_AUTORESUME_TURNS`).
