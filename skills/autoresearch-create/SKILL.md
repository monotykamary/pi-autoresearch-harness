---
name: autoresearch-create
description: Set up and run an autonomous experiment loop for any optimization target. Gathers what to optimize, then starts the loop immediately. Use when asked to "run autoresearch", "optimize X in a loop", "set up autoresearch for X", or "start experiments".
---

# Autoresearch

Autonomous experiment loop: try ideas, keep what works, discard what doesn't, never stop.

## When to Use

Autoresearch is designed for **systematic experimentation** — it adds overhead (worktree setup, git commits, benchmark time, context consumption) that pays off when:

- You're running **10+ iterations** exploring variants
- Each iteration involves **expensive operations** (ML training, large builds, integration tests)
- The metric is **noisy** and needs statistical confidence
- You have a **verifiable target** (latency, throughput, accuracy, bundle size, etc.)

For quick wins — one-shot fixes, lint/type feedback under 1s, or trivial changes — regular `bash` and `edit` are faster. Use this skill when the autonomous loop justifies the setup cost.

## CLI

The `pi-autoresearch` CLI auto-spawns a long-lived harness server on first use. Every call dispatches an action to the harness, which holds persistent experiment state across calls.

```bash
pi-autoresearch activate "<goal>"   # Enter autoresearch mode, create worktree
pi-autoresearch init --name "..." --metric-name "..." [--metric-unit ""] [--direction lower|higher] [--target-value N] [--max-experiments N]
pi-autoresearch run "<command>" [--timeout 600] [--checks-timeout 300]
pi-autoresearch log --metric N --status keep|discard|crash|checks_failed --description "..." [--metrics '{"k":v}'] [--asi '{"k":"v"}'] [--force]
pi-autoresearch status              # Show current experiment state
pi-autoresearch list                # List all results
pi-autoresearch deactivate          # Leave autoresearch mode
pi-autoresearch clear               # Clear state and remove worktree
```

Also accepts JSON for programmatic use:

```bash
pi-autoresearch '{ "action": "run", "command": "bash autoresearch.sh" }'
```

### Server management

| Command                     | Behavior                            |
| --------------------------- | ----------------------------------- |
| `pi-autoresearch --status`  | Print health JSON or exit 1 if down |
| `pi-autoresearch --start`   | Start the harness server            |
| `pi-autoresearch --stop`    | Graceful shutdown                   |
| `pi-autoresearch --restart` | Stop + start fresh                  |
| `pi-autoresearch --logs`    | Follow the server log               |

Env vars: `PI_AUTORESEARCH_PORT` (default `9878`), `PI_AUTORESEARCH_LOG` (default: OS temp directory), and `PI_AUTORESEARCH_BASH` (optional Git Bash path on Windows).

## Workflow

1. Ask (or infer): **Goal**, **Command**, **Metric** (+ direction), **Target** (optional), **Files in scope**, **Constraints**.
2. `pi-autoresearch activate "optimize X"` — creates a git worktree at `autoresearch/<session-id>/`.
3. Write `autoresearch.md` and `autoresearch.sh` inside the worktree. Commit both.
4. `pi-autoresearch init --name "..." --metric-name "..." --direction lower` → run baseline → `pi-autoresearch log --metric N --status keep --description "baseline"` → start looping immediately.
5. `pi-autoresearch run "bash autoresearch.sh"` → `pi-autoresearch log --metric N --status keep|discard --description "..." --asi '{"hypothesis":"..."}'` → repeat forever.

### Worktree Pattern

Autoresearch automatically uses **git worktrees** for isolation:

```
project/
├── src/                    # Your main code (stays clean)
├── autoresearch/
│   └── <session-id>/      # Isolated worktree for experiments
│       ├── autoresearch.md
│       ├── autoresearch.sh
│       └── autoresearch.jsonl
└── ...
```

**Benefits:**

- Main working directory stays clean — no pollution from failed experiments
- Side commits accumulate in the worktree without affecting your main branch
- Easy to merge back successful changes, discard the rest

**Lifecycle:**

1. `pi-autoresearch activate "optimize X"` → creates worktree automatically
2. Experiments run inside `autoresearch/<session-id>/`
3. `pi-autoresearch clear` → removes worktree and branch

### `autoresearch.md`

This is the heart of the session. A fresh agent with no context should be able to read this file and run the loop effectively. Invest time making it excellent.

```markdown
# Autoresearch: <goal>

## Objective

<Specific description of what we're optimizing and the workload.>

## Metrics

- **Primary**: <name> (<unit>, lower/higher is better) — the optimization target
- **Target**: <value or "none"> — stop when <condition>
- **Secondary**: <name>, <name>, ... — independent tradeoff monitors

## How to Run

`./autoresearch.sh` — outputs `METRIC name=number` lines.

## Files in Scope

<Every file the agent may modify, with a brief note on what it does.>

## Off Limits

<What must NOT be touched.>

## Constraints

<Hard rules: tests must pass, no new deps, etc.>

## What's Been Tried

<Update this section as experiments accumulate. Note key wins, dead ends,
and architectural insights so the agent doesn't repeat failed approaches.>
```

Update `autoresearch.md` periodically — especially the "What's Been Tried" section — so resuming agents have full context.

### `autoresearch.sh`

Bash script (`set -euo pipefail`) that: pre-checks fast (syntax errors in <1s), runs the benchmark, and outputs structured lines to stdout. Keep the script fast — every second is multiplied by hundreds of runs.

**For fast, noisy benchmarks** (< 5s), run the workload multiple times inside the script and report the median. This produces stable data points and makes the confidence score reliable from the start. Slow workloads (ML training, large builds) don't need this — single runs are fine.

#### Structured output

- `METRIC name=value` — primary metric (must match `init`'s `--metric-name`) and any secondary metrics. Parsed automatically by `run`.

#### Design the script to inform optimization

The script should output **whatever data helps you make better decisions in the next iteration.** Think about what you'll need to see after each run to know where to focus:

- Phase timings when the workload has distinct stages
- Error counts, failure categories, or test names when checks can fail in different ways
- Memory usage, cache hit rates, or other runtime diagnostics when relevant
- Anything domain-specific that would help localize regressions or identify bottlenecks

The script runs the same code every iteration — but you can **update it during the loop** if you discover you need more signal. Add instrumentation as you learn what matters.

#### Agent-supplied ASI via `log`

Use `log`'s `--asi` parameter to annotate each run with **whatever would help the next iteration make a better decision.** Free-form key/value pairs — you decide what's worth recording. Don't repeat the description or raw output; capture what you'd lose after a context reset.

**Annotate failures and crashes heavily.** Discarded and crashed runs are reverted — the code changes are gone. The only record that survives is the description and ASI in `autoresearch.jsonl`. If you don't capture what you tried and why it failed, future iterations will waste time re-discovering the same dead ends.

### `autoresearch.checks.sh` (optional)

Bash script (`set -euo pipefail`) for backpressure/correctness checks: tests, types, lint, etc. **Only create this file when the user's constraints require correctness validation** (e.g., "tests must pass", "types must check").

When this file exists:

- Runs automatically after every **passing** benchmark in `run`.
- If checks fail, `run` reports it clearly — log as `--status checks_failed`.
- Its execution time does **NOT** affect the primary metric.
- You cannot `--status keep` a result when checks have failed.
- Has a separate timeout (default 300s, configurable via `--checks-timeout`).

When this file does **not** exist, everything behaves exactly as before — no changes to the loop.

**Keep output minimal.** Only the last 80 lines of checks output are fed back on failure. Suppress verbose progress/success output and let only errors through. This keeps context lean and helps the agent pinpoint what broke.

```bash
#!/bin/bash
set -euo pipefail
# Example: run tests and typecheck — suppress success output, only show errors
pnpm test --run --reporter=dot 2>&1 | tail -50
pnpm typecheck 2>&1 | grep -i error || true
```

## Loop Rules

**LOOP FOREVER.** Never ask "should I continue?" — the user expects autonomous work.

- **Primary metric is king.** Improved → `--status keep`. Worse/equal → `--status discard`. Secondary metrics rarely affect this.
- **Annotate every run with `--asi`.** Record what you learned — not what you did. What would help the next iteration or a fresh agent resuming this session?
- **Watch the confidence score.** After 3+ runs, `log` reports a confidence score (best improvement as a multiple of the session noise floor). ≥2.0× means the improvement is likely real. <1.0× means it's within noise — consider re-running to confirm before keeping. The score is advisory — it never auto-discards.
- **Simpler is better.** Removing code for equal perf = keep. Ugly complexity for tiny gain = probably discard.
- **Don't thrash.** Repeatedly reverting the same idea? Try something structurally different.
- **Crashes:** fix if trivial, otherwise log and move on. Don't over-invest.
- **Think longer when stuck.** Re-read source files, study the profiling data, reason about what the CPU is actually doing. The best ideas come from deep understanding, not from trying random variations.
- **Resuming:** if `autoresearch.md` exists, read it + git log, continue looping.

**NEVER STOP.** The user may be away for hours. Keep going until interrupted.

## Ideas Backlog

When you discover complex but promising optimizations that you won't pursue right now, **append them as bullets to `autoresearch.ideas.md`**. Don't let good ideas get lost.

On resume (context limit, crash), check `autoresearch.ideas.md` — prune stale/tried entries, experiment with the rest. When all paths are exhausted, delete the file and write a final summary.

## User Messages During Experiments

If the user sends a message while an experiment is running, finish the current `run` + `log` cycle first, then incorporate their feedback in the next iteration. Don't abandon a running experiment.

## System Prompt Guidance

When autoresearch mode is active, follow these rules:

- You are in autoresearch mode for LONG-HORIZON OPTIMIZATION with verifiable metrics.
- Purpose: Optimize a primary metric through an autonomous experiment loop. NEVER STOP until interrupted.
- Read `autoresearch.md` at the start of every session and after compaction.
- Write promising but deferred optimizations as bullet points to `autoresearch.ideas.md`.
- Be careful not to overfit to the benchmarks and do not cheat on the benchmarks.
- Autoresearch is ONLY for long-horizon optimization tasks with verifiable metrics. Do NOT use for: general development, one-off commits, exploratory coding without a metric, or tasks without a measurable optimization target.
- If `autoresearch.checks.sh` exists, it runs automatically after every passing benchmark. If checks fail, log as `--status checks_failed`. You cannot use `--status keep` when checks failed.
- If the user sends a follow-on message while an experiment is running, finish the current run + log cycle first, then address their message.
