/**
 * Before/after iteration hooks for autoresearch sessions
 *
 * Spawns executable scripts at iteration boundaries, pipes JSON context on
 * stdin, captures stdout as steer messages for the agent.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveBashPath } from './platform.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TIMEOUT_MS = 30_000;
const STDOUT_MAX_BYTES = 8 * 1024;
const TRUNCATION_MARKER = '\n…[truncated: hook stdout exceeded 8KB]';
const HOOKS_DIR = 'autoresearch.hooks';

const NEWLINE = 0x0a;
const UTF8_CONT_MASK = 0xc0;
const UTF8_CONT = 0x80; // continuation byte: 10xxxxxx
const UTF8_LEAD = 0xc0; // multi-byte leader: 11xxxxxx

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type HookStage = 'before' | 'after';

export interface SessionSnapshot {
  metric_name: string;
  metric_unit: string;
  direction: 'lower' | 'higher';
  baseline_metric: number | null;
  best_metric: number | null;
  run_count: number;
  goal: string;
}

interface BeforeHookPayload {
  event: 'before';
  cwd: string;
  next_run: number;
  last_run: Record<string, unknown> | null;
  session: SessionSnapshot;
}

interface AfterHookPayload {
  event: 'after';
  cwd: string;
  run_entry: Record<string, unknown>;
  session: SessionSnapshot;
}

export type HookPayload = BeforeHookPayload | AfterHookPayload;

interface HookResult {
  fired: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Trim at the last newline, falling back to the last complete UTF-8 character. */
function truncateAtBoundary(buf: Buffer): Buffer {
  const newlineEnd = buf.lastIndexOf(NEWLINE);
  if (newlineEnd >= 0) return buf.subarray(0, newlineEnd + 1);
  let end = buf.length;
  while (end > 0 && (buf[end - 1] & UTF8_CONT_MASK) === UTF8_CONT) end--;
  if (end > 0 && (buf[end - 1] & UTF8_CONT_MASK) === UTF8_LEAD) end--;
  return buf.subarray(0, end);
}

function hookScriptPath(workDir: string, stage: HookStage): string {
  return path.join(workDir, HOOKS_DIR, `${stage}.sh`);
}

function isExecutableFile(filePath: string): boolean {
  try {
    if (process.platform !== 'win32') fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

const notFired: HookResult = {
  fired: false,
  stdout: '',
  stderr: '',
  exitCode: null,
  timedOut: false,
  durationMs: 0,
};

// ---------------------------------------------------------------------------
// Core hook runner
// ---------------------------------------------------------------------------

export async function runHook(payload: HookPayload): Promise<HookResult> {
  const script = hookScriptPath(payload.cwd, payload.event);
  if (!isExecutableFile(script)) return notFired;

  const t0 = Date.now();
  return new Promise<HookResult>((resolve) => {
    const child = spawn(resolveBashPath(), [script.replace(/\\/g, '/')], {
      cwd: payload.cwd,
      timeout: TIMEOUT_MS,
      windowsHide: true,
    });

    let stdout = '';
    let stdoutBytes = 0;
    let stdoutFull = false;
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdoutFull) return;
      const remaining = STDOUT_MAX_BYTES - stdoutBytes;
      if (chunk.length <= remaining) {
        stdout += chunk.toString('utf8');
        stdoutBytes += chunk.length;
        return;
      }
      const kept = truncateAtBoundary(chunk.subarray(0, remaining));
      stdout += kept.toString('utf8') + TRUNCATION_MARKER;
      stdoutFull = true;
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    const finish = (exitCode: number | null, extraErr = '') => {
      const combinedStderr = extraErr ? (stderr ? `${stderr}\n${extraErr}` : extraErr) : stderr;
      resolve({
        fired: true,
        stdout,
        stderr: combinedStderr,
        exitCode,
        timedOut: child.killed,
        durationMs: Date.now() - t0,
      });
    };

    child.on('error', (err) => finish(null, err.message));
    child.on('close', (code) => finish(code));

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Steer message and logging
// ---------------------------------------------------------------------------

export function steerMessageFor(stage: HookStage, result: HookResult): string | null {
  if (!result.fired) return null;
  if (result.timedOut) return `[${stage} hook timed out after ${TIMEOUT_MS / 1000}s]`;
  if (result.exitCode !== 0) {
    const parts = [`[${stage} hook exited ${result.exitCode}]`];
    const err = result.stderr.trim();
    const out = result.stdout.trim();
    if (err) parts.push(err);
    if (out) parts.push(out);
    return parts.join('\n');
  }
  return result.stdout.trim() || null;
}

function hookLogEntry(stage: HookStage, result: HookResult): Record<string, unknown> {
  return {
    type: 'hook',
    stage,
    exit_code: result.exitCode,
    duration_ms: result.durationMs,
    stdout_bytes: Buffer.byteLength(result.stdout, 'utf8'),
    timed_out: result.timedOut,
  };
}

/** Check if the JSONL file starts with a config entry (i.e., is a valid autoresearch log) */
function hasConfigHeader(jsonlPath: string): boolean {
  if (!fs.existsSync(jsonlPath)) return false;
  try {
    const content = fs.readFileSync(jsonlPath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry && typeof entry === 'object' && entry.type === 'config') return true;
      } catch {}
    }
    return false;
  } catch {
    return false;
  }
}

export function appendHookLogEntryIfConfigured(
  jsonlPath: string,
  stage: HookStage,
  result: HookResult
): boolean {
  if (!result.fired) return false;
  if (!hasConfigHeader(jsonlPath)) return false;

  try {
    fs.appendFileSync(jsonlPath, JSON.stringify(hookLogEntry(stage, result)) + '\n');
    return true;
  } catch {
    return false;
  }
}
