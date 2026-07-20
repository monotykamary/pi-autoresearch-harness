/**
 * Pi Autoresearch Harness Server
 *
 * Long-lived HTTP server that holds experiment state and dispatches actions.
 * The CLI (`pi-autoresearch init`, `pi-autoresearch run`, etc.) sends action
 * requests here; the server manages state, runs experiments, and handles git.
 *
 * Endpoints (bind 127.0.0.1:9878 by default; override with $PI_AUTORESEARCH_PORT):
 *   POST /action   body = JSON { action, ...params }
 *                  Headers: x-session-id
 *                  Response: { ok: true, result: { text, details } } | { ok: false, error: string }
 *   GET  /health   { ok: true, uptime, cwd }
 *   POST /quit     graceful shutdown
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { execSync, execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { defaultLogPath, resolveBashPath } from './platform.js';
import {
  runHook,
  steerMessageFor,
  appendHookLogEntryIfConfigured,
  type HookPayload,
  type SessionSnapshot,
} from './hooks.js';

// =============================================================================
// Types
// =============================================================================

interface ExperimentResult {
  commit: string;
  metric: number;
  metrics: Record<string, number>;
  status: 'keep' | 'discard' | 'crash' | 'checks_failed';
  description: string;
  timestamp: number;
  segment: number;
  confidence: number | null;
  asi?: Record<string, unknown>;
}

interface MetricDef {
  name: string;
  unit: string;
}

interface ExperimentState {
  results: ExperimentResult[];
  bestMetric: number | null;
  bestDirection: 'lower' | 'higher';
  metricName: string;
  metricUnit: string;
  secondaryMetrics: MetricDef[];
  name: string | null;
  currentSegment: number;
  maxExperiments: number | null;
  confidence: number | null;
  targetValue: number | null;
}

interface SessionState {
  autoresearchMode: boolean;
  worktreeDir: string | null;
  state: ExperimentState;
  startingCommit: string | null;
  lastRunChecks: { pass: boolean; output: string; duration: number } | null;
  lastRunDuration: number | null;
  experimentCompletedWaitingForLog: boolean;
  runningExperiment: { startedAt: number; command: string } | null;
  lastRunSucceeded: boolean | null;
}

// =============================================================================
// Constants
// =============================================================================

const EXPERIMENT_MAX_LINES = 10;
const EXPERIMENT_MAX_BYTES = 4 * 1024;
const METRIC_LINE_PREFIX = 'METRIC';
const DENIED_METRIC_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_AUTORESUME_TURNS = 20;
const BENCHMARK_GUARDRAIL =
  'Be careful not to overfit to the benchmarks and do not cheat on the benchmarks.';
const HOOKS_DIR = 'autoresearch.hooks';

// =============================================================================
// Utilities
// =============================================================================

function commas(n: number): string {
  const s = String(Math.round(n));
  const parts: string[] = [];
  for (let i = s.length; i > 0; i -= 3) {
    parts.unshift(s.slice(Math.max(0, i - 3), i));
  }
  return parts.join(',');
}

function fmtNum(n: number, decimals: number = 0): string {
  if (decimals > 0) {
    const int = Math.floor(Math.abs(n));
    const frac = (Math.abs(n) - int).toFixed(decimals).slice(1);
    return (n < 0 ? '-' : '') + commas(int) + frac;
  }
  return commas(n);
}

function formatNum(value: number | null, unit: string): string {
  if (value === null) return '—';
  const u = unit || '';
  if (value === Math.round(value)) return fmtNum(value) + u;
  return fmtNum(value, 2) + u;
}

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function isBetter(current: number, best: number, direction: 'lower' | 'higher'): boolean {
  return direction === 'lower' ? current < best : current > best;
}

function parseMetricLines(output: string): Map<string, number> {
  const metrics = new Map<string, number>();
  const regex = new RegExp(`^${METRIC_LINE_PREFIX}\\s+([\\w.µ]+)=(\\S+)\\s*$`, 'gm');
  let match;
  while ((match = regex.exec(output)) !== null) {
    const name = match[1];
    if (DENIED_METRIC_NAMES.has(name)) continue;
    const value = Number(match[2]);
    if (Number.isFinite(value)) {
      metrics.set(name, value);
    }
  }
  return metrics;
}

function inferUnit(name: string): string {
  if (name.endsWith('µs')) return 'µs';
  if (name.endsWith('_ms')) return 'ms';
  if (name.endsWith('_s') || name.endsWith('_sec')) return 's';
  if (name.endsWith('_kb')) return 'kb';
  if (name.endsWith('_mb')) return 'mb';
  return '';
}

function sortedMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function computeConfidence(
  results: ExperimentResult[],
  direction: 'lower' | 'higher'
): number | null {
  const validResults = results.filter((r) => r.metric > 0);
  if (validResults.length < 3) return null;

  const values = validResults.map((r) => r.metric);
  const median = sortedMedian(values);
  const deviations = values.map((v) => Math.abs(v - median));
  const mad = sortedMedian(deviations);

  if (mad === 0) return null;

  const baseline = validResults[0]?.metric ?? null;
  if (baseline === null) return null;

  let bestKept: number | null = null;
  for (const r of validResults) {
    if (r.status === 'keep' && r.metric > 0) {
      if (bestKept === null || isBetter(r.metric, bestKept, direction)) {
        bestKept = r.metric;
      }
    }
  }
  if (bestKept === null || bestKept === baseline) return null;

  const delta = Math.abs(bestKept - baseline);
  return delta / mad;
}

function isAutoresearchShCommand(command: string): boolean {
  let cmd = command.trim();
  cmd = cmd.replace(/^(?:\w+=\S*\s+)+/, '');
  let prev: string;
  do {
    prev = cmd;
    cmd = cmd.replace(/^(?:env|time|nice|nohup)(?:\s+-\S+(?:\s+\d+)?)*\s+/, '');
  } while (cmd !== prev);
  return /^(?:(?:bash|sh|source)\s+(?:-\w+\s+)*)?(?:\.\/|\/[\w/.-]*\/)?autoresearch\.sh(?:\s|$)/.test(
    cmd
  );
}

/** Best = optimal metric across kept experiments in current segment */
function findBestMetric(results: ExperimentResult[], direction: 'lower' | 'higher'): number | null {
  const kept = results.filter((r) => r.status === 'keep').map((r) => r.metric);
  if (kept.length === 0) return null;
  return direction === 'lower' ? Math.min(...kept) : Math.max(...kept);
}

/** Build a session snapshot for hook payloads */
function buildSessionSnapshot(state: ExperimentState): SessionSnapshot {
  // bestMetric in state is the baseline (first run). For hooks, best_metric
  // means the best kept metric across all runs.
  const bestMetric = findBestMetric(state.results, state.bestDirection);
  return {
    metric_name: state.metricName,
    metric_unit: state.metricUnit,
    direction: state.bestDirection,
    baseline_metric: state.bestMetric,
    best_metric: bestMetric,
    run_count: state.results.length,
    goal: state.name ?? '',
  };
}

/** Read the last run entry from autoresearch.jsonl for hook payloads */
function readLastRunJsonl(workDir: string): Record<string, unknown> | null {
  const jsonlPath = join(workDir, 'autoresearch.jsonl');
  if (!fs.existsSync(jsonlPath)) return null;
  try {
    const lines = fs.readFileSync(jsonlPath, 'utf-8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry && typeof entry === 'object' && typeof entry.run === 'number') return entry;
      } catch {}
    }
  } catch {}
  return null;
}

/** Fire a hook and return the steer message (or null) */
async function fireHook(payload: HookPayload): Promise<string | null> {
  const result = await runHook(payload);
  const jsonlPath = join(payload.cwd, 'autoresearch.jsonl');
  appendHookLogEntryIfConfigured(jsonlPath, payload.event, result);
  return steerMessageFor(payload.event, result);
}

function normalizePath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function canonicalPath(filePath: string): string {
  try {
    return normalizePath(fs.realpathSync.native(filePath));
  } catch {
    return normalizePath(resolve(filePath));
  }
}

function worktreePaths(output: string): string[] {
  return output
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice(9).trim());
}

function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    return;
  }

  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  }
}

function createTempFileAllocator(): () => string {
  let p: string | undefined;
  return () => {
    if (!p) {
      const id = randomBytes(8).toString('hex');
      p = join(tmpdir(), `pi-experiment-${id}.log`);
    }
    return p;
  };
}

function registerSecondaryMetrics(state: ExperimentState, metrics: Record<string, number>): void {
  for (const name of Object.keys(metrics)) {
    if (!state.secondaryMetrics.find((m) => m.name === name)) {
      state.secondaryMetrics.push({ name, unit: inferUnit(name) });
    }
  }
}

function updateStateAfterLog(state: ExperimentState, experiment: ExperimentResult): void {
  registerSecondaryMetrics(state, experiment.metrics);
  state.bestMetric = state.results[0]?.metric ?? null;
  state.confidence = computeConfidence(state.results, state.bestDirection);
  experiment.confidence = state.confidence;
}

function resetForReinit(state: ExperimentState, incrementSegment: boolean = true): void {
  if (incrementSegment) {
    state.currentSegment++;
  }
  state.bestMetric = null;
  state.secondaryMetrics = [];
  state.confidence = null;
}

function createExperimentState(): ExperimentState {
  return {
    results: [],
    bestMetric: null,
    bestDirection: 'lower',
    metricName: 'metric',
    metricUnit: '',
    secondaryMetrics: [],
    name: null,
    currentSegment: 0,
    maxExperiments: null,
    confidence: null,
    targetValue: null,
  };
}

function createSessionState(): SessionState {
  return {
    autoresearchMode: false,
    worktreeDir: null,
    state: createExperimentState(),
    startingCommit: null,
    lastRunChecks: null,
    lastRunDuration: null,
    experimentCompletedWaitingForLog: false,
    runningExperiment: null,
    lastRunSucceeded: null,
  };
}

// =============================================================================
// Truncation (replaces @earendil-works/pi-coding-agent truncateTail)
// =============================================================================

interface TruncationResult {
  content: string;
  truncated: boolean;
  truncatedBy: 'lines' | 'bytes' | null;
  totalLines: number;
  outputLines: number;
}

const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 50 * 1024;

function truncateTail(
  text: string,
  opts: { maxLines?: number; maxBytes?: number } = {}
): TruncationResult {
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  const lines = text.split('\n');
  const totalLines = lines.length;

  // Truncate by bytes first
  if (Buffer.byteLength(text, 'utf-8') > maxBytes) {
    let truncated = text;
    while (Buffer.byteLength(truncated, 'utf-8') > maxBytes && truncated.length > 0) {
      const nlIdx = truncated.indexOf('\n');
      if (nlIdx === -1) break;
      truncated = truncated.slice(nlIdx + 1);
    }
    const outputLines = truncated.split('\n').length;
    return {
      content: truncated,
      truncated: true,
      truncatedBy: 'bytes',
      totalLines,
      outputLines,
    };
  }

  // Truncate by lines
  if (totalLines > maxLines) {
    const tail = lines.slice(-maxLines);
    return {
      content: tail.join('\n'),
      truncated: true,
      truncatedBy: 'lines',
      totalLines,
      outputLines: maxLines,
    };
  }

  return {
    content: text,
    truncated: false,
    truncatedBy: null,
    totalLines,
    outputLines: totalLines,
  };
}

// =============================================================================
// Git operations
// =============================================================================

function getGlobalGitignorePath(): string | null {
  try {
    const result = execSync('git config --global core.excludesfile', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const configured = result.trim();
    if (configured) return configured;
  } catch {
    // Not configured
  }
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  const candidates = [
    join(home, '.gitignore'),
    join(home, '.gitignore_global'),
    join(home, '.config', 'git', 'ignore'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return join(home, '.gitignore');
}

function ensureGlobalGitignore(): void {
  try {
    const gitignorePath = getGlobalGitignorePath();
    if (!gitignorePath) return;
    const pattern = 'autoresearch/';
    let content = '';
    if (fs.existsSync(gitignorePath)) {
      content = fs.readFileSync(gitignorePath, 'utf-8');
      if (content.split(/\r?\n/).some((line) => line.trim() === pattern)) return;
    }
    const parentDir = dirname(gitignorePath);
    if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
    const entry =
      content.endsWith('\n') || content === ''
        ? `# pi-autoresearch worktrees\n${pattern}\n`
        : `\n# pi-autoresearch worktrees\n${pattern}\n`;
    fs.appendFileSync(gitignorePath, entry, 'utf-8');
  } catch {
    // Best effort
  }
}

function resolveWorkDir(ctxCwd: string, session: SessionState): string {
  if (session.worktreeDir) return session.worktreeDir;
  return ctxCwd;
}

function detectAutoresearchWorktree(ctxCwd: string, sessionId?: string): string | null {
  try {
    const output = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: ctxCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    for (const worktreePath of worktreePaths(output)) {
      if (sessionId) {
        const expectedSuffix = normalizePath(join('autoresearch', sessionId));
        if (!canonicalPath(worktreePath).endsWith(expectedSuffix)) continue;
      }
      const jsonlPath = join(worktreePath, 'autoresearch.jsonl');
      if (fs.existsSync(jsonlPath)) return worktreePath;
    }
  } catch {
    // Git command failed
  }
  return null;
}

function createAutoresearchWorktree(ctxCwd: string, sessionId: string): string | null {
  const worktreeName = `autoresearch/${sessionId}`;
  const worktreePath = join(ctxCwd, worktreeName);

  try {
    const listOutput = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: ctxCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    if (
      worktreePaths(listOutput).some(
        (existingPath) => canonicalPath(existingPath) === canonicalPath(worktreePath)
      ) &&
      fs.existsSync(worktreePath)
    ) {
      return worktreePath;
    }
    // Prune stale entries
    try {
      execFileSync('git', ['worktree', 'prune'], {
        cwd: ctxCwd,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch {}
  } catch {}

  const autoresearchDir = join(ctxCwd, 'autoresearch');
  if (!fs.existsSync(autoresearchDir)) {
    fs.mkdirSync(autoresearchDir, { recursive: true });
  }

  const branchName = `autoresearch/${sessionId}`;

  try {
    const branchOutput = execFileSync('git', ['branch', '--list', branchName], {
      cwd: ctxCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    if (!branchOutput.trim()) {
      execFileSync('git', ['branch', branchName], {
        cwd: ctxCwd,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    }

    execFileSync('git', ['worktree', 'add', worktreePath, branchName], {
      cwd: ctxCwd,
      stdio: ['pipe', 'pipe', 'ignore'],
    });

    ensureGlobalGitignore();
    return worktreePath;
  } catch {
    return null;
  }
}

function removeAutoresearchWorktree(ctxCwd: string, worktreePath: string): void {
  try {
    const branchName = execFileSync('git', ['branch', '--show-current'], {
      cwd: worktreePath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    execFileSync('git', ['worktree', 'remove', '--force', worktreePath], {
      cwd: ctxCwd,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    if (branchName) {
      execFileSync('git', ['branch', '-D', branchName], {
        cwd: ctxCwd,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    }
    const autoresearchDir = join(ctxCwd, 'autoresearch');
    try {
      if (fs.existsSync(autoresearchDir)) {
        const entries = fs.readdirSync(autoresearchDir);
        if (entries.length === 0) fs.rmdirSync(autoresearchDir);
      }
    } catch {}
  } catch {
    // Best effort
  }
}

function getProtectedFiles(): string[] {
  return [
    'autoresearch.jsonl',
    'autoresearch.md',
    'autoresearch.ideas.md',
    'autoresearch.sh',
    'autoresearch.checks.sh',
  ];
}

function gitExec(
  args: string[],
  cwd: string,
  timeout: number = 10000
): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      timeout,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (e: any) {
    return {
      code: e.status ?? 1,
      stdout: e.stdout?.toString() ?? '',
      stderr: e.stderr?.toString() ?? '',
    };
  }
}

// =============================================================================
// Session management
// =============================================================================

const sessions = new Map<string, SessionState>();

function getSession(cwd: string, sessionId?: string): SessionState {
  const key = sessionId ? `${cwd}:${sessionId}` : cwd;
  let session = sessions.get(key);
  if (!session) {
    session = createSessionState();
    sessions.set(key, session);
  }
  return session;
}

function reconstructStateFromJsonl(session: SessionState, cwd: string): void {
  const workDir = resolveWorkDir(cwd, session);
  const jsonlPath = join(workDir, 'autoresearch.jsonl');

  // Preserve worktreeDir
  const preservedWorktreeDir = session.worktreeDir;

  session.state = createExperimentState();
  session.lastRunChecks = null;
  session.lastRunDuration = null;
  session.runningExperiment = null;
  session.experimentCompletedWaitingForLog = false;
  session.lastRunSucceeded = null;

  if (fs.existsSync(jsonlPath)) {
    try {
      const content = fs.readFileSync(jsonlPath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);

          // Config header
          if (entry.name && !entry.run) {
            session.state.name = entry.name;
            session.state.metricName = entry.metric_name ?? 'metric';
            session.state.metricUnit = entry.metric_unit ?? '';
            session.state.bestDirection = entry.direction ?? 'lower';
            session.state.targetValue = entry.target_value ?? null;
            session.state.maxExperiments = entry.max_experiments ?? null;
            session.state.currentSegment = entry.segment ?? 0;
          }

          // Experiment result
          if (entry.run && typeof entry.run === 'number') {
            const experiment: ExperimentResult = {
              commit: entry.commit ?? 'unknown',
              metric: entry.metric ?? 0,
              metrics: entry.metrics ?? {},
              status: entry.status ?? 'discard',
              description: entry.description ?? '',
              timestamp: entry.timestamp ?? Date.now(),
              segment: entry.segment ?? 0,
              confidence: entry.confidence ?? null,
              asi: entry.asi,
            };
            session.state.results.push(experiment);
            if (experiment.metrics) {
              registerSecondaryMetrics(session.state, experiment.metrics);
            }
          }
        } catch {
          // Skip malformed lines
        }
      }

      if (session.state.results.length > 0) {
        session.state.bestMetric = session.state.results[0]?.metric ?? null;
        session.state.confidence = computeConfidence(
          session.state.results,
          session.state.bestDirection
        );
      }
    } catch {
      // JSONL corrupted
    }
  }

  // Restore worktreeDir
  if (preservedWorktreeDir) {
    session.worktreeDir = preservedWorktreeDir;
  }
}

// =============================================================================
// Action dispatch
// =============================================================================

async function dispatchAction(
  action: string,
  params: Record<string, unknown>,
  cwd: string,
  sessionId?: string
): Promise<{ text: string; details: unknown }> {
  const session = getSession(cwd, sessionId);
  const workDir = resolveWorkDir(cwd, session);

  switch (action) {
    // ---- Activate autoresearch mode ----
    case 'activate': {
      const goal = params.goal as string | undefined;
      if (session.autoresearchMode) {
        return { text: 'Autoresearch already active.', details: { active: true } };
      }

      // Detect existing worktree
      if (!session.worktreeDir && sessionId) {
        const detected = detectAutoresearchWorktree(cwd, sessionId);
        if (detected) {
          session.worktreeDir = detected;
          reconstructStateFromJsonl(session, cwd);
        }
      }

      // Create worktree if needed
      if (!session.worktreeDir && sessionId) {
        const created = createAutoresearchWorktree(cwd, sessionId);
        if (created) {
          session.worktreeDir = created;
        } else {
          return {
            text: '❌ Failed to create autoresearch worktree.',
            details: { error: 'worktree_failed' },
          };
        }
      }

      session.autoresearchMode = true;

      const worktreeNote = session.worktreeDir
        ? `\n📁 Isolated worktree: ${session.worktreeDir}`
        : '';
      const goalNote = goal ? `\nGoal: ${goal}` : '';

      return {
        text: `✅ Autoresearch mode activated.${goalNote}${worktreeNote}\n\nNext: write autoresearch.md and autoresearch.sh, then call pi-autoresearch init. ${BENCHMARK_GUARDRAIL}`,
        details: { active: true, worktreeDir: session.worktreeDir },
      };
    }

    // ---- Deactivate autoresearch mode ----
    case 'deactivate': {
      session.autoresearchMode = false;
      session.state = createExperimentState();
      session.lastRunChecks = null;
      session.lastRunDuration = null;
      session.runningExperiment = null;
      session.experimentCompletedWaitingForLog = false;
      session.lastRunSucceeded = null;

      return {
        text: 'Autoresearch mode deactivated. Worktree preserved.',
        details: { active: false },
      };
    }

    // ---- Clear state and optionally remove worktree ----
    case 'clear': {
      session.autoresearchMode = false;
      session.state = createExperimentState();
      session.lastRunChecks = null;
      session.lastRunDuration = null;
      session.runningExperiment = null;
      session.experimentCompletedWaitingForLog = false;
      session.lastRunSucceeded = null;

      // Remove worktree
      if (session.worktreeDir) {
        removeAutoresearchWorktree(cwd, session.worktreeDir);
        session.worktreeDir = null;
      }

      // Remove JSONL
      const jsonlPath = join(workDir, 'autoresearch.jsonl');
      if (fs.existsSync(jsonlPath)) {
        try {
          fs.unlinkSync(jsonlPath);
        } catch {}
      }

      return { text: 'Autoresearch cleared. JSONL deleted, worktree removed.', details: {} };
    }

    // ---- Init experiment session ----
    case 'init': {
      const name = params.name as string;
      const metricName = params.metric_name as string;
      const metricUnit = (params.metric_unit as string) ?? '';
      const direction = (params.direction as 'lower' | 'higher') ?? 'lower';
      const targetValue = params.target_value as number | undefined;
      const maxExperiments = params.max_experiments as number | undefined;

      if (!name || !metricName) {
        return {
          text: '❌ init requires --name and --metric-name.',
          details: { error: 'missing_params' },
        };
      }

      // Auto-create worktree if not already exists
      if (!session.worktreeDir && sessionId) {
        const created = createAutoresearchWorktree(cwd, sessionId);
        if (created) {
          session.worktreeDir = created;
        } else {
          return { text: '❌ Worktree creation failed.', details: { error: 'worktree_failed' } };
        }
      }

      const workDir = resolveWorkDir(cwd, session);
      const jsonlPath = join(workDir, 'autoresearch.jsonl');
      const isReinit = fs.existsSync(jsonlPath);

      session.state.name = name;
      session.state.metricName = metricName;
      session.state.metricUnit = metricUnit;
      if (direction === 'lower' || direction === 'higher') {
        session.state.bestDirection = direction;
      }
      session.state.targetValue = targetValue ?? null;
      session.state.maxExperiments = maxExperiments ?? null;

      if (isReinit) {
        resetForReinit(session.state, true);
      }

      // Write config header to jsonl
      try {
        const config = JSON.stringify({
          type: 'config',
          name: session.state.name,
          metric_name: session.state.metricName,
          metric_unit: session.state.metricUnit,
          direction: session.state.bestDirection,
          target_value: session.state.targetValue,
          max_experiments: session.state.maxExperiments,
          segment: session.state.currentSegment,
        });
        if (isReinit) {
          fs.appendFileSync(jsonlPath, config + '\n');
        } else {
          fs.writeFileSync(jsonlPath, config + '\n');
        }
      } catch (e) {
        return {
          text: `⚠️ Failed to write autoresearch.jsonl: ${e instanceof Error ? e.message : String(e)}`,
          details: {},
        };
      }

      session.autoresearchMode = true;

      const reinitNote = isReinit
        ? ' (re-initialized — previous results archived, new baseline needed)'
        : '';
      const targetNote =
        session.state.targetValue !== null
          ? `\nTarget: ${session.state.targetValue}${session.state.metricUnit} (${session.state.bestDirection} is better) — loop stops when reached`
          : '';
      const worktreeNote = session.worktreeDir ? `\n📁 Worktree: ${session.worktreeDir}` : '';
      const workDirNote = workDir !== cwd ? `\nWorking directory: ${workDir}` : '';

      return {
        text: `✅ Experiment initialized: "${session.state.name}"${reinitNote}\nMetric: ${session.state.metricName} (${session.state.metricUnit || 'unitless'}, ${session.state.bestDirection} is better)${targetNote}${worktreeNote}${workDirNote}\nConfig written to autoresearch.jsonl. Now run the baseline with pi-autoresearch run.`,
        details: { name, metricName, metricUnit, direction, targetValue: targetValue ?? null },
      };
    }

    // ---- Run experiment ----
    case 'run': {
      const command = params.command as string;
      const timeoutSeconds = (params.timeout_seconds as number) ?? 600;
      const checksTimeoutSeconds = (params.checks_timeout_seconds as number) ?? 300;

      if (!command) {
        return { text: '❌ run requires a command.', details: { error: 'missing_params' } };
      }

      const state = session.state;

      // Guard: require init
      if (!state.name) {
        return {
          text: '❌ Experiment session not initialized. Call pi-autoresearch init first.',
          details: {},
        };
      }

      // Block if max experiments reached
      if (state.maxExperiments !== null && state.results.length >= state.maxExperiments) {
        return {
          text: `🛑 Maximum experiments reached (${state.maxExperiments}). The experiment loop is done.`,
          details: {},
        };
      }

      // Fire before-hook (before capturing starting commit / running experiment)
      let beforeHookSteer: string | null = null;
      try {
        beforeHookSteer = await fireHook({
          event: 'before',
          cwd: workDir,
          next_run: state.results.length + 1,
          last_run: readLastRunJsonl(workDir),
          session: buildSessionSnapshot(state),
        });
      } catch {}

      // Clear stale starting commit
      session.startingCommit = null;

      // Capture starting commit
      try {
        const result = gitExec(['rev-parse', '--short=7', 'HEAD'], workDir, 5000);
        if (result.code === 0) {
          session.startingCommit = result.stdout.trim();
        }
      } catch {}

      // Guard: if autoresearch.sh exists, only allow running it
      const autoresearchShPath = join(workDir, 'autoresearch.sh');
      if (fs.existsSync(autoresearchShPath) && !isAutoresearchShCommand(command)) {
        return {
          text: `❌ autoresearch.sh exists — you must run it instead of a custom command.\n\nFound: ${autoresearchShPath}\nYour command: ${command}\n\nUse: pi-autoresearch run "bash autoresearch.sh"`,
          details: { command, exitCode: null, durationSeconds: 0, passed: false },
        };
      }

      session.runningExperiment = { startedAt: Date.now(), command };

      const t0 = Date.now();
      const getTempFile = createTempFileAllocator();
      const timeout = timeoutSeconds * 1000;

      // Spawn process and capture output
      const {
        exitCode,
        killed: timedOut,
        output,
        tempFilePath: streamTempFile,
        actualTotalBytes,
      } = await new Promise<{
        exitCode: number | null;
        killed: boolean;
        output: string;
        tempFilePath: string | undefined;
        actualTotalBytes: number;
      }>((resolve) => {
        let processTimedOut = false;
        const child = spawn(resolveBashPath(), ['-c', command], {
          cwd: workDir,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });

        const chunks: Buffer[] = [];
        let chunksBytes = 0;
        const maxChunksBytes = DEFAULT_MAX_BYTES * 2;

        let tempFilePath: string | undefined;
        let tempFileStream: ReturnType<typeof fs.createWriteStream> | undefined;
        let totalBytes = 0;

        const handleData = (data: Buffer) => {
          totalBytes += data.length;

          if (totalBytes > DEFAULT_MAX_BYTES && !tempFilePath) {
            tempFilePath = getTempFile();
            tempFileStream = fs.createWriteStream(tempFilePath);
            for (const chunk of chunks) {
              tempFileStream.write(chunk);
            }
          }

          if (tempFileStream) {
            tempFileStream.write(data);
          }

          chunks.push(data);
          chunksBytes += data.length;

          while (chunksBytes > maxChunksBytes && chunks.length > 1) {
            const removed = chunks.shift()!;
            chunksBytes -= removed.length;
          }
          if (chunks.length > 0 && chunksBytes > maxChunksBytes) {
            const buf = chunks[0];
            const nlIdx = buf.indexOf(0x0a);
            if (nlIdx !== -1 && nlIdx < buf.length - 1) {
              chunks[0] = buf.subarray(nlIdx + 1);
              chunksBytes -= nlIdx + 1;
            }
          }
        };

        if (child.stdout) child.stdout.on('data', handleData);
        if (child.stderr) child.stderr.on('data', handleData);

        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        if (timeout > 0) {
          timeoutHandle = setTimeout(() => {
            processTimedOut = true;
            if (child.pid) killProcessTree(child.pid);
          }, timeout);
        }

        child.on('error', (err) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          if (tempFileStream) tempFileStream.end();
          resolve({
            exitCode: 1,
            killed: false,
            output: err.message,
            tempFilePath: undefined,
            actualTotalBytes: 0,
          });
        });

        child.on('close', (code) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          if (tempFileStream) tempFileStream.end();

          const fullBuffer = Buffer.concat(chunks);
          resolve({
            exitCode: code,
            killed: processTimedOut,
            output: fullBuffer.toString('utf-8'),
            tempFilePath,
            actualTotalBytes: totalBytes,
          });
        });
      }).finally(() => {
        session.runningExperiment = null;
      });

      const durationSeconds = (Date.now() - t0) / 1000;
      session.lastRunDuration = durationSeconds;
      const benchmarkPassed = exitCode === 0 && !timedOut;

      // Run checks if benchmark passed
      let checksPass: boolean | null = null;
      let checksTimedOut = false;
      let checksOutput = '';
      let checksDuration = 0;

      const checksPath = join(workDir, 'autoresearch.checks.sh');
      if (benchmarkPassed && fs.existsSync(checksPath)) {
        const checksTimeout = checksTimeoutSeconds * 1000;
        const ct0 = Date.now();
        try {
          const stdout = execFileSync(resolveBashPath(), [checksPath.replace(/\\/g, '/')], {
            cwd: workDir,
            encoding: 'utf-8',
            timeout: checksTimeout,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          checksDuration = (Date.now() - ct0) / 1000;
          checksPass = true;
          checksOutput = stdout.trim();
        } catch (e: any) {
          checksDuration = (Date.now() - ct0) / 1000;
          checksTimedOut = e?.code === 'ETIMEDOUT';
          checksPass = false;
          checksOutput = [e?.stdout, e?.stderr, e instanceof Error ? e.message : String(e)]
            .filter(Boolean)
            .join('\n')
            .trim();
        }
      }

      session.lastRunChecks =
        checksPass !== null
          ? { pass: checksPass, output: checksOutput, duration: checksDuration }
          : null;

      const passed = benchmarkPassed && (checksPass === null || checksPass);
      session.experimentCompletedWaitingForLog = true;
      session.lastRunSucceeded = passed;

      // Handle output truncation
      let fullOutputPath: string | undefined = streamTempFile;
      const totalLines = output.split('\n').length;
      if (
        !fullOutputPath &&
        (actualTotalBytes > EXPERIMENT_MAX_BYTES || totalLines > EXPERIMENT_MAX_LINES)
      ) {
        fullOutputPath = getTempFile();
        fs.writeFileSync(fullOutputPath, output);
      }

      const displayTruncation = truncateTail(output, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });

      const llmTruncation = truncateTail(output, {
        maxLines: EXPERIMENT_MAX_LINES,
        maxBytes: EXPERIMENT_MAX_BYTES,
      });

      // Parse METRIC lines
      const parsedMetricMap = parseMetricLines(output);
      const parsedMetrics = parsedMetricMap.size > 0 ? Object.fromEntries(parsedMetricMap) : null;
      const parsedPrimary = parsedMetricMap.get(state.metricName) ?? null;

      // Build response text
      let text = '';
      if (beforeHookSteer) {
        text += `🪝 before-hook: ${beforeHookSteer}\n\n`;
      }
      if (timedOut) {
        text += `⏰ TIMEOUT after ${durationSeconds.toFixed(1)}s\n`;
      } else if (!benchmarkPassed) {
        text += `💥 FAILED (exit code ${exitCode}) in ${durationSeconds.toFixed(1)}s\n`;
      } else if (checksTimedOut) {
        text += `✅ Benchmark PASSED in ${durationSeconds.toFixed(1)}s\n`;
        text += `⏰ CHECKS TIMEOUT after ${checksDuration.toFixed(1)}s\n`;
      } else if (checksPass === false) {
        text += `✅ Benchmark PASSED in ${durationSeconds.toFixed(1)}s\n`;
        text += `💥 CHECKS FAILED in ${checksDuration.toFixed(1)}s\n`;
        text += `Log as 'checks_failed' — benchmark metric is valid but checks did not pass.\n`;
      } else {
        text += `✅ PASSED in ${durationSeconds.toFixed(1)}s\n`;
        if (checksPass === true) {
          text += `✅ Checks passed in ${checksDuration.toFixed(1)}s\n`;
        }
      }

      if (state.bestMetric !== null) {
        text += `📊 Current best ${state.metricName}: ${formatNum(state.bestMetric, state.metricUnit)}\n`;
      }

      if (parsedMetrics) {
        const secondary = Object.entries(parsedMetrics).filter(([k]) => k !== state.metricName);
        text += `\n📐 Parsed metrics:`;
        if (parsedPrimary !== null) {
          text += ` ★ ${state.metricName}=${formatNum(parsedPrimary, state.metricUnit)}`;
        }
        for (const [name, value] of secondary) {
          text += ` ${name}=${value}`;
        }
        text += `\nUse these values directly in pi-autoresearch log.\n`;
      }

      text += `\n${llmTruncation.content}`;

      if (llmTruncation.truncated) {
        if (llmTruncation.truncatedBy === 'lines') {
          text += `\n\n[Showing last ${llmTruncation.outputLines} of ${llmTruncation.totalLines} lines.`;
        } else {
          text += `\n\n[Showing last ${llmTruncation.outputLines} lines (${formatSize(EXPERIMENT_MAX_BYTES)} limit).`;
        }
        if (fullOutputPath) {
          text += ` Full output: ${fullOutputPath}`;
        }
        text += `]`;
      }

      if (checksPass === false) {
        text += `\n\n── Checks output (last 80 lines) ──\n${checksOutput.split('\n').slice(-80).join('\n')}`;
      }

      return {
        text,
        details: {
          command,
          exitCode,
          durationSeconds,
          passed,
          timedOut,
          parsedMetrics,
          parsedPrimary,
          metricName: state.metricName,
          metricUnit: state.metricUnit,
          checksPass,
          checksOutput: checksOutput.split('\n').slice(-80).join('\n'),
          checksDuration,
        },
      };
    }

    // ---- Log experiment result ----
    case 'log': {
      const metric = params.metric as number;
      const status = params.status as 'keep' | 'discard' | 'crash' | 'checks_failed';
      const description = params.description as string;
      const secondaryMetrics = (params.metrics as Record<string, number>) ?? {};
      const asi = params.asi as Record<string, unknown> | undefined;
      const force = params.force as boolean | undefined;

      if (metric === undefined || !status || !description) {
        return {
          text: '❌ log requires --metric, --status, and --description.',
          details: { error: 'missing_params' },
        };
      }

      const state = session.state;

      // Guard: require autoresearch mode
      if (!session.autoresearchMode) {
        return {
          text: '❌ Autoresearch mode is not active. Call pi-autoresearch activate first.',
          details: {},
        };
      }

      // Guard: require init
      if (!state.name) {
        return {
          text: '❌ Experiment session not initialized. Call pi-autoresearch init first.',
          details: {},
        };
      }

      // Gate: prevent "keep" when checks failed
      if (status === 'keep' && session.lastRunChecks && !session.lastRunChecks.pass) {
        return {
          text: `❌ Cannot keep — autoresearch.checks.sh failed.\n\n${session.lastRunChecks.output.slice(-500)}\n\nLog as 'checks_failed' instead.`,
          details: {},
        };
      }

      // Validate secondary metrics (skip for crashes where metrics may be unavailable)
      if (state.secondaryMetrics.length > 0 && status !== 'crash') {
        const knownNames = new Set(state.secondaryMetrics.map((m) => m.name));
        const providedNames = new Set(Object.keys(secondaryMetrics));

        const missing = [...knownNames].filter((n) => !providedNames.has(n));
        if (missing.length > 0) {
          return {
            text: `❌ Missing secondary metrics: ${missing.join(', ')}\n\nExpected: ${[...knownNames].join(', ')}\nGot: ${[...providedNames].join(', ') || '(none)'}`,
            details: {},
          };
        }

        const newMetrics = [...providedNames].filter((n) => !knownNames.has(n));
        if (newMetrics.length > 0 && !force) {
          return {
            text: `❌ New secondary metric(s) not previously tracked: ${newMetrics.join(', ')}\n\nUse --force to add.`,
            details: {},
          };
        }
      }

      let commitHash = session.startingCommit ?? 'unknown';
      if (commitHash === 'unknown') {
        try {
          const result = gitExec(['rev-parse', '--short=7', 'HEAD'], workDir, 5000);
          if (result.code === 0) {
            commitHash = result.stdout.trim().slice(0, 7);
          }
        } catch {}
      }

      const experiment: ExperimentResult = {
        commit: commitHash,
        metric,
        metrics: secondaryMetrics,
        status,
        description,
        timestamp: Date.now(),
        segment: state.currentSegment,
        confidence: null,
        asi: asi && Object.keys(asi).length > 0 ? asi : undefined,
      };

      state.results.push(experiment);
      updateStateAfterLog(state, experiment);

      const allResultsCount = state.results.length;
      let text = `Logged #${allResultsCount}: ${experiment.status} — ${experiment.description}`;

      if (state.bestMetric !== null) {
        text += `\nBaseline ${state.metricName}: ${formatNum(state.bestMetric, state.metricUnit)}`;
        if (allResultsCount > 1 && status === 'keep' && metric > 0) {
          const delta = metric - state.bestMetric;
          const pct = ((delta / state.bestMetric) * 100).toFixed(1);
          const sign = delta > 0 ? '+' : '';
          text += ` | this: ${formatNum(metric, state.metricUnit)} (${sign}${pct}%)`;
        }
      }

      // Secondary metrics
      if (Object.keys(secondaryMetrics).length > 0) {
        const firstResultMetrics = state.results[0]?.metrics ?? {};
        const parts: string[] = [];
        for (const [name, value] of Object.entries(secondaryMetrics)) {
          const def = state.secondaryMetrics.find((m) => m.name === name);
          const unit = def?.unit ?? '';
          let part = `${name}: ${formatNum(value, unit)}`;
          const bv = firstResultMetrics[name];
          if (bv !== undefined && state.results.length > 1 && bv !== 0) {
            const d = value - bv;
            const p = ((d / bv) * 100).toFixed(1);
            const s = d > 0 ? '+' : '';
            part += ` (${s}${p}%)`;
          }
          parts.push(part);
        }
        text += `\nSecondary: ${parts.join('  ')}`;
      }

      // ASI summary
      if (experiment.asi) {
        const asiParts: string[] = [];
        for (const [k, v] of Object.entries(experiment.asi)) {
          const s = typeof v === 'string' ? v : JSON.stringify(v);
          asiParts.push(`${k}: ${s.length > 80 ? s.slice(0, 77) + '…' : s}`);
        }
        if (asiParts.length > 0) {
          text += `\n📋 ASI: ${asiParts.join(' | ')}`;
        }
      }

      // Confidence
      if (state.confidence !== null) {
        const confStr = state.confidence.toFixed(1);
        if (state.confidence >= 2.0) {
          text += `\n📊 Confidence: ${confStr}× noise floor — improvement is likely real`;
        } else if (state.confidence >= 1.0) {
          text += `\n📊 Confidence: ${confStr}× noise floor — improvement is above noise but marginal`;
        } else {
          text += `\n⚠️ Confidence: ${confStr}× noise floor — improvement is within noise. Consider re-running to confirm.`;
        }
      }

      text += `\n(${allResultsCount} experiments`;
      if (state.maxExperiments !== null) {
        text += ` / ${state.maxExperiments} max`;
      }
      text += `)`;

      // Persist to JSONL
      try {
        const jsonlPath = join(workDir, 'autoresearch.jsonl');
        const jsonlEntry: Record<string, unknown> = { run: state.results.length, ...experiment };
        if (!experiment.asi) delete jsonlEntry.asi;
        fs.appendFileSync(jsonlPath, JSON.stringify(jsonlEntry) + '\n');
      } catch (e) {
        text += `\n⚠️ Failed to write autoresearch.jsonl: ${e instanceof Error ? e.message : String(e)}`;
      }

      // Auto-commit on keep
      if (status === 'keep') {
        try {
          const resultData: Record<string, unknown> = {
            status,
            [state.metricName || 'metric']: metric,
            ...secondaryMetrics,
          };
          const commitMsg = `${description}\n\nResult: ${JSON.stringify(resultData)}`;

          const addResult = gitExec(['add', '-A'], workDir);
          if (addResult.code !== 0) {
            const addErr = (addResult.stdout + addResult.stderr).trim();
            throw new Error(`git add failed: ${addErr.slice(0, 200)}`);
          }

          const diffResult = gitExec(['diff', '--cached', '--quiet'], workDir);
          if (diffResult.code === 0) {
            text += `\n📝 Git: nothing to commit (working tree clean)`;
          } else {
            const gitResult = gitExec(['commit', '-m', commitMsg], workDir);
            if (gitResult.code === 0) {
              text += `\n📝 Git: committed`;
              try {
                const shaResult = gitExec(['rev-parse', '--short=7', 'HEAD'], workDir, 5000);
                const newSha = shaResult.stdout.trim();
                if (newSha && newSha.length >= 7) {
                  experiment.commit = newSha;
                }
              } catch {}
            } else {
              const gitOutput = (gitResult.stdout + gitResult.stderr).trim();
              text += `\n⚠️ Git commit failed: ${gitOutput.slice(0, 200)}`;
            }
          }
        } catch (e) {
          text += `\n⚠️ Git commit error: ${e instanceof Error ? e.message : String(e)}`;
        }
      }

      // Auto-revert on discard/crash/checks_failed
      if (status !== 'keep') {
        try {
          for (const file of getProtectedFiles()) {
            if (fs.existsSync(join(workDir, file))) gitExec(['add', '--', file], workDir);
          }
          const checkoutResult = gitExec(['checkout', '--', '.'], workDir);
          const cleanResult = gitExec(['clean', '-fd'], workDir);
          if (checkoutResult.code !== 0 || cleanResult.code !== 0) {
            throw new Error((checkoutResult.stderr || cleanResult.stderr).trim());
          }
          text += `\n📝 Git: reverted changes (${status}) — autoresearch files preserved`;
        } catch (e) {
          text += `\n⚠️ Git revert failed: ${e instanceof Error ? e.message : String(e)}`;
        }
      }

      // Fire after-hook (after logging, before clearing state)
      try {
        const afterSteer = await fireHook({
          event: 'after',
          cwd: workDir,
          run_entry: { run: allResultsCount, ...experiment },
          session: buildSessionSnapshot(state),
        });
        if (afterSteer) {
          text += `\n🪝 after-hook: ${afterSteer}`;
        }
      } catch {}

      // Clear running state
      session.runningExperiment = null;
      session.experimentCompletedWaitingForLog = false;
      session.lastRunSucceeded = null;
      session.lastRunChecks = null;
      session.lastRunDuration = null;
      session.startingCommit = null;

      // Check max experiments
      const limitReached = state.maxExperiments !== null && allResultsCount >= state.maxExperiments;
      if (limitReached) {
        text += `\n\n🛑 Maximum experiments reached (${state.maxExperiments}). STOP the experiment loop now.`;
        session.autoresearchMode = false;
      }

      // Check target value
      const targetReached =
        status === 'keep' &&
        state.targetValue !== null &&
        metric > 0 &&
        (state.bestDirection === 'lower'
          ? metric <= state.targetValue
          : metric >= state.targetValue);
      if (targetReached) {
        text += `\n\n🎯 TARGET REACHED! ${state.metricName} = ${formatNum(metric, state.metricUnit)} (target: ${formatNum(state.targetValue, state.metricUnit)})`;
        text += `\n✅ Optimization complete. STOP the experiment loop now.`;
        session.autoresearchMode = false;
      }

      return { text, details: { experiment, state } };
    }

    // ---- Show status ----
    case 'status': {
      const state = session.state;
      if (!state.name) {
        return {
          text: session.autoresearchMode
            ? 'Autoresearch mode active (no experiment initialized yet)'
            : 'Autoresearch mode inactive',
          details: { active: session.autoresearchMode, initialized: false },
        };
      }

      const cur = state.results;
      const kept = cur.filter((r) => r.status === 'keep').length;
      const crashed = cur.filter((r) => r.status === 'crash').length;
      const discarded = cur.filter((r) => r.status === 'discard').length;

      let bestPrimary: number | null = null;
      for (const r of cur) {
        if (r.status === 'keep' && r.metric > 0) {
          if (bestPrimary === null || isBetter(r.metric, bestPrimary, state.bestDirection)) {
            bestPrimary = r.metric;
          }
        }
      }

      let text = `🔬 ${state.name}\n`;
      text += `Runs: ${cur.length} (${kept} kept, ${discarded} discarded, ${crashed} crashed)\n`;
      text += `★ ${state.metricName}: ${formatNum(bestPrimary ?? state.bestMetric, state.metricUnit)} (${state.bestDirection} is better)`;

      if (state.confidence !== null) {
        text += `\nConfidence: ${state.confidence.toFixed(1)}× noise floor`;
      }
      if (state.targetValue !== null && bestPrimary !== null) {
        const reached =
          state.bestDirection === 'lower'
            ? bestPrimary <= state.targetValue
            : bestPrimary >= state.targetValue;
        text += `\nTarget: ${formatNum(state.targetValue, state.metricUnit)} ${reached ? '✓ REACHED' : ''}`;
      }
      if (session.worktreeDir) {
        text += `\nWorktree: ${session.worktreeDir}`;
      }
      if (session.runningExperiment) {
        const elapsed = formatElapsed(Date.now() - session.runningExperiment.startedAt);
        text += `\n⏳ Running: ${session.runningExperiment.command} (${elapsed})`;
      }

      return { text, details: { state, active: session.autoresearchMode } };
    }

    // ---- List results ----
    case 'list': {
      const state = session.state;
      if (state.results.length === 0) {
        return { text: 'No experiments yet.', details: { results: [] } };
      }

      const lines: string[] = [];
      const header =
        `#`.padEnd(4) +
        `commit`.padEnd(9) +
        `★ ${state.metricName}`.padEnd(20) +
        `status`.padEnd(12) +
        `description`;
      lines.push(header);
      lines.push('─'.repeat(header.length));

      for (let i = 0; i < state.results.length; i++) {
        const r = state.results[i];
        const commitDisplay = r.status !== 'keep' ? '—' : r.commit;
        const primaryStr = formatNum(r.metric, state.metricUnit);
        lines.push(
          `${String(i + 1).padEnd(4)}${commitDisplay.padEnd(9)}${primaryStr.padEnd(20)}${r.status.padEnd(12)}${r.description}`
        );
      }

      // Summary
      const kept = state.results.filter((r) => r.status === 'keep').length;
      lines.push('');
      lines.push(`${state.results.length} runs (${kept} kept)`);
      if (state.bestMetric !== null) {
        lines.push(`Baseline: ${formatNum(state.bestMetric, state.metricUnit)}`);
      }

      return { text: lines.join('\n'), details: { results: state.results, state } };
    }

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

// =============================================================================
// HTTP Server
// =============================================================================

const PORT = Number(process.env.PI_AUTORESEARCH_PORT ?? 9878);
const startedAt = Date.now();
const LOG = process.env.PI_AUTORESEARCH_LOG ?? defaultLogPath();

const TEXT_JSON = { 'content-type': 'application/json; charset=utf-8' } as const;
const TEXT_PLAIN = { 'content-type': 'text/plain; charset=utf-8' } as const;

function serverLog(msg: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  try {
    fs.appendFileSync(LOG, line);
  } catch {}
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function header(req: IncomingMessage, name: string): string | undefined {
  const val = req.headers[name.toLowerCase()];
  if (typeof val === 'string') return val;
  if (Array.isArray(val)) return val[0];
  return undefined;
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, TEXT_JSON);
    res.end(
      JSON.stringify({
        ok: true,
        uptime: Math.floor((Date.now() - startedAt) / 1000),
        cwd: process.cwd(),
        sessions: sessions.size,
      })
    );
    return;
  }

  // Action endpoint
  if (req.method === 'POST' && url.pathname === '/action') {
    let body: string;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400, TEXT_JSON);
      res.end(JSON.stringify({ ok: false, error: 'failed to read body' }));
      return;
    }

    let params: Record<string, unknown>;
    try {
      params = JSON.parse(body);
    } catch {
      res.writeHead(400, TEXT_JSON);
      res.end(JSON.stringify({ ok: false, error: 'invalid JSON' }));
      return;
    }

    const action = params.action;
    if (!action || typeof action !== 'string') {
      res.writeHead(400, TEXT_JSON);
      res.end(JSON.stringify({ ok: false, error: "missing or invalid 'action' field" }));
      return;
    }

    const sessionId = header(req, 'x-session-id');
    const encodedCwd = header(req, 'x-cwd');
    const cwd = encodedCwd ? decodeURIComponent(encodedCwd) : process.cwd();

    serverLog(`action: ${action} session: ${sessionId || '(none)'}`);

    try {
      const result = await dispatchAction(action, params, cwd, sessionId);
      serverLog(`action: ${action} -> ok`);
      res.writeHead(200, TEXT_JSON);
      res.end(JSON.stringify({ ok: true, result }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      serverLog(`action: ${action} -> error: ${msg}`);
      res.writeHead(500, TEXT_JSON);
      res.end(JSON.stringify({ ok: false, error: msg }));
    }
    return;
  }

  // Graceful shutdown
  if (req.method === 'POST' && url.pathname === '/quit') {
    res.writeHead(200, TEXT_JSON);
    res.end(JSON.stringify({ ok: true }));
    setTimeout(() => {
      server.close();
      process.exit(0);
    }, 100);
    return;
  }

  // 404
  res.writeHead(404, TEXT_PLAIN);
  res.end('not found\n');
});

server.listen(PORT, '127.0.0.1', () => {
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : PORT;
  const msg = JSON.stringify({
    ok: true,
    ready: true,
    port: actualPort,
    message: `pi-autoresearch harness listening on http://127.0.0.1:${actualPort}`,
  });
  process.stdout.write(msg + '\n');
  serverLog(`harness started on port ${actualPort}`);
});

// Graceful shutdown on signals
const shutdown = (signal: string) => {
  serverLog(`received ${signal}, shutting down`);
  server.close();
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
