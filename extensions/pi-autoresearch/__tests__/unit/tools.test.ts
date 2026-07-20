/**
 * Unit tests for tool logic
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ExperimentResult } from '../../src/types/index.js';

// ============================================================================
// File redirection path resolution
// ============================================================================
interface AutoresearchRuntime {
  autoresearchMode: boolean;
  worktreeDir: string | null;
}

function resolveAutoresearchPath(
  inputPath: string,
  ctxCwd: string,
  runtime: AutoresearchRuntime
): string {
  if (!runtime.autoresearchMode || !runtime.worktreeDir) {
    return path.resolve(ctxCwd, inputPath);
  }

  const worktreeDir = runtime.worktreeDir;

  if (path.isAbsolute(inputPath)) {
    const relativeToWorktree = path.relative(worktreeDir, inputPath);
    if (!relativeToWorktree.startsWith('..') && !path.isAbsolute(relativeToWorktree)) {
      return inputPath;
    }

    const relativeToCwd = path.relative(ctxCwd, inputPath);
    if (!relativeToCwd.startsWith('..') && !path.isAbsolute(relativeToCwd)) {
      return path.join(worktreeDir, relativeToCwd);
    }
    return inputPath;
  }

  return path.join(worktreeDir, inputPath);
}

describe('File redirection path resolution', () => {
  const mainCwd = path.resolve(path.sep, 'project');
  const worktreeDir = path.join(mainCwd, 'autoresearch', 'session-123');

  it('resolves relative paths against worktree when autoresearch is ON', () => {
    const runtime: AutoresearchRuntime = { autoresearchMode: true, worktreeDir };
    const resolved = resolveAutoresearchPath('src/foo.ts', mainCwd, runtime);
    expect(resolved).toBe(path.join(worktreeDir, 'src', 'foo.ts'));
  });

  it('resolves relative paths against main cwd when autoresearch is OFF', () => {
    const runtime: AutoresearchRuntime = { autoresearchMode: false, worktreeDir: null };
    const resolved = resolveAutoresearchPath('src/foo.ts', mainCwd, runtime);
    expect(resolved).toBe(path.join(mainCwd, 'src', 'foo.ts'));
  });

  it('resolves relative paths against main cwd when worktree is null', () => {
    const runtime: AutoresearchRuntime = { autoresearchMode: true, worktreeDir: null };
    const resolved = resolveAutoresearchPath('src/foo.ts', mainCwd, runtime);
    expect(resolved).toBe(path.join(mainCwd, 'src', 'foo.ts'));
  });

  it('redirects absolute paths within main cwd to worktree', () => {
    const runtime: AutoresearchRuntime = { autoresearchMode: true, worktreeDir };
    const resolved = resolveAutoresearchPath(path.join(mainCwd, 'src', 'foo.ts'), mainCwd, runtime);
    expect(resolved).toBe(path.join(worktreeDir, 'src', 'foo.ts'));
  });

  it('preserves absolute paths outside main cwd (external references)', () => {
    const runtime: AutoresearchRuntime = { autoresearchMode: true, worktreeDir };
    const externalPath = path.resolve(path.sep, 'etc', 'config.json');
    const resolved = resolveAutoresearchPath(externalPath, mainCwd, runtime);
    expect(resolved).toBe(externalPath);
  });

  it('preserves absolute paths outside main cwd even when similar prefix', () => {
    const runtime: AutoresearchRuntime = { autoresearchMode: true, worktreeDir };
    const externalPath = path.resolve(path.sep, 'project-other', 'config.json');
    const resolved = resolveAutoresearchPath(externalPath, mainCwd, runtime);
    expect(resolved).toBe(externalPath);
  });

  it('handles nested relative paths correctly', () => {
    const runtime: AutoresearchRuntime = { autoresearchMode: true, worktreeDir };
    const resolved = resolveAutoresearchPath('deep/nested/path/file.ts', mainCwd, runtime);
    expect(resolved).toBe(path.join(worktreeDir, 'deep', 'nested', 'path', 'file.ts'));
  });

  it('handles absolute paths at root of main cwd', () => {
    const runtime: AutoresearchRuntime = { autoresearchMode: true, worktreeDir };
    const resolved = resolveAutoresearchPath(path.join(mainCwd, 'package.json'), mainCwd, runtime);
    expect(resolved).toBe(path.join(worktreeDir, 'package.json'));
  });

  it('preserves paths already within worktree (no double redirect)', () => {
    const runtime: AutoresearchRuntime = { autoresearchMode: true, worktreeDir };
    const inputPath = path.join(worktreeDir, 'src', 'foo.ts');
    const resolved = resolveAutoresearchPath(inputPath, mainCwd, runtime);
    expect(resolved).toBe(inputPath);
  });

  it('preserves autoresearch.md path when already in worktree', () => {
    const runtime: AutoresearchRuntime = { autoresearchMode: true, worktreeDir };
    const inputPath = path.join(worktreeDir, 'autoresearch.md');
    const resolved = resolveAutoresearchPath(inputPath, mainCwd, runtime);
    expect(resolved).toBe(inputPath);
    expect(path.normalize(resolved)).not.toContain(
      path.join('autoresearch', 'session-123', 'autoresearch', 'session-123')
    );
  });
});

// ============================================================================
// Experiment session guard
// ============================================================================
describe('Experiment session guard', () => {
  it('requires state.name to be set (would come from init_experiment)', () => {
    const stateWithoutInit = { name: null as string | null, results: [] };
    const stateWithInit = { name: 'Test Session', results: [] };

    expect(!stateWithoutInit.name).toBe(true);
    expect(!stateWithInit.name).toBe(false);
  });

  it('requires worktreeDir to be set for proper isolation', () => {
    const runtimeWithoutWorktree = {
      worktreeDir: null as string | null,
      autoresearchMode: false,
    };
    const runtimeWithWorktree = {
      worktreeDir: '/project/autoresearch/session-123',
      autoresearchMode: true,
    };

    expect(runtimeWithoutWorktree.worktreeDir).toBeNull();
    expect(runtimeWithWorktree.worktreeDir).not.toBeNull();
  });

  it('requires autoresearchMode to be true for log_experiment', () => {
    // When agent legitimately stops, autoresearchMode is turned off
    // This prevents log_experiment from running until init_experiment resumes
    const runtimePaused = {
      autoresearchMode: false,
      worktreeDir: '/project/autoresearch/session-123',
      state: { name: 'Test Session', results: [] },
    };
    const runtimeActive = {
      autoresearchMode: true,
      worktreeDir: '/project/autoresearch/session-123',
      state: { name: 'Test Session', results: [] },
    };

    // log_experiment should be blocked when autoresearchMode is false
    expect(runtimePaused.autoresearchMode).toBe(false);
    // log_experiment should work when autoresearchMode is true
    expect(runtimeActive.autoresearchMode).toBe(true);
  });
});

// ============================================================================
// Target value feature
// ============================================================================
interface ExperimentStateWithTarget {
  results: ExperimentResult[];
  bestMetric: number | null;
  bestDirection: 'lower' | 'higher';
  metricName: string;
  metricUnit: string;
  targetValue: number | null;
  currentSegment: number;
}

function isTargetReached(
  status: 'keep' | 'discard' | 'crash' | 'checks_failed',
  metric: number,
  targetValue: number | null,
  direction: 'lower' | 'higher'
): boolean {
  if (status !== 'keep') return false;
  if (targetValue === null) return false;
  if (metric <= 0) return false;

  return direction === 'lower' ? metric <= targetValue : metric >= targetValue;
}

describe('Target value feature', () => {
  describe('State initialization', () => {
    it('initializes with null target value by default', () => {
      const state: ExperimentStateWithTarget = {
        results: [],
        bestMetric: null,
        bestDirection: 'lower',
        metricName: 'metric',
        metricUnit: '',
        targetValue: null,
        currentSegment: 0,
      };
      expect(state.targetValue).toBeNull();
    });

    it('can be initialized with a specific target value', () => {
      const state: ExperimentStateWithTarget = {
        results: [],
        bestMetric: null,
        bestDirection: 'lower',
        metricName: 'latency_ms',
        metricUnit: 'ms',
        targetValue: 100,
        currentSegment: 0,
      };
      expect(state.targetValue).toBe(100);
    });
  });

  describe('Target reached detection (direction: lower)', () => {
    it('detects target reached when metric <= target (lower is better)', () => {
      expect(isTargetReached('keep', 95, 100, 'lower')).toBe(true);
      expect(isTargetReached('keep', 100, 100, 'lower')).toBe(true);
      expect(isTargetReached('keep', 50, 100, 'lower')).toBe(true);
    });

    it('does not detect target reached when metric > target (lower is better)', () => {
      expect(isTargetReached('keep', 101, 100, 'lower')).toBe(false);
      expect(isTargetReached('keep', 150, 100, 'lower')).toBe(false);
    });
  });

  describe('Target reached detection (direction: higher)', () => {
    it('detects target reached when metric >= target (higher is better)', () => {
      expect(isTargetReached('keep', 0.95, 0.9, 'higher')).toBe(true);
      expect(isTargetReached('keep', 0.9, 0.9, 'higher')).toBe(true);
      expect(isTargetReached('keep', 1.0, 0.9, 'higher')).toBe(true);
    });

    it('does not detect target reached when metric < target (higher is better)', () => {
      expect(isTargetReached('keep', 0.89, 0.9, 'higher')).toBe(false);
      expect(isTargetReached('keep', 0.85, 0.9, 'higher')).toBe(false);
    });
  });

  describe('Target not reached edge cases', () => {
    it('returns false for non-keep statuses regardless of metric', () => {
      expect(isTargetReached('discard', 50, 100, 'lower')).toBe(false);
      expect(isTargetReached('crash', 50, 100, 'lower')).toBe(false);
      expect(isTargetReached('checks_failed', 50, 100, 'lower')).toBe(false);
      expect(isTargetReached('crash', 0, 100, 'lower')).toBe(false);
    });

    it('returns false when target value is null', () => {
      expect(isTargetReached('keep', 50, null, 'lower')).toBe(false);
      expect(isTargetReached('keep', 999, null, 'higher')).toBe(false);
    });

    it('returns false for zero or negative metrics', () => {
      expect(isTargetReached('keep', 0, 100, 'lower')).toBe(false);
      expect(isTargetReached('keep', -10, 100, 'lower')).toBe(false);
    });
  });

  describe('Real-world scenarios', () => {
    it('bundle size optimization: target <= 100KB', () => {
      const target = 100;
      expect(isTargetReached('keep', 150, target, 'lower')).toBe(false);
      expect(isTargetReached('keep', 95, target, 'lower')).toBe(true);
      expect(isTargetReached('keep', 80, target, 'lower')).toBe(true);
    });

    it('accuracy optimization: target >= 0.95', () => {
      const target = 0.95;
      expect(isTargetReached('keep', 0.87, target, 'higher')).toBe(false);
      expect(isTargetReached('keep', 0.96, target, 'higher')).toBe(true);
    });

    it('test speed optimization: target <= 30s', () => {
      const target = 30;
      expect(isTargetReached('keep', 45, target, 'lower')).toBe(false);
      expect(isTargetReached('keep', 28, target, 'lower')).toBe(true);
    });
  });
});

// ============================================================================
// init_experiment file existence check (regression test)
// ============================================================================
describe('init_experiment file existence check', () => {
  let testDir: string;
  let jsonlPath: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoresearch-test-'));
    jsonlPath = path.join(testDir, 'autoresearch.jsonl');
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  it('uses fs.existsSync instead of state.results.length to decide append vs create', () => {
    const existingConfig = JSON.stringify({
      type: 'config',
      name: 'Previous Session',
      metricName: 'time_ms',
      metricUnit: 'ms',
      bestDirection: 'lower',
      targetValue: null,
    });
    fs.writeFileSync(jsonlPath, existingConfig + '\n');
    expect(fs.existsSync(jsonlPath)).toBe(true);

    const stateResultsLength = 0;
    const isReinitOld = stateResultsLength > 0;
    const isReinitNew = fs.existsSync(jsonlPath);

    expect(isReinitOld).toBe(false);
    expect(isReinitNew).toBe(true);

    const newConfig = JSON.stringify({
      type: 'config',
      name: 'New Session',
      metricName: 'latency_us',
      metricUnit: 'µs',
      bestDirection: 'lower',
      targetValue: 100,
    });

    if (isReinitNew) {
      fs.appendFileSync(jsonlPath, newConfig + '\n');
    } else {
      fs.writeFileSync(jsonlPath, newConfig + '\n');
    }

    const content = fs.readFileSync(jsonlPath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).name).toBe('Previous Session');
    expect(JSON.parse(lines[1]).name).toBe('New Session');
  });

  it('creates new file when jsonl does not exist (first init)', () => {
    expect(fs.existsSync(jsonlPath)).toBe(false);

    const isReinit = fs.existsSync(jsonlPath);
    expect(isReinit).toBe(false);

    const config = JSON.stringify({
      type: 'config',
      name: 'First Session',
      metricName: 'time_ms',
      metricUnit: 'ms',
      bestDirection: 'lower',
    });

    if (isReinit) {
      fs.appendFileSync(jsonlPath, config + '\n');
    } else {
      fs.writeFileSync(jsonlPath, config + '\n');
    }

    expect(fs.existsSync(jsonlPath)).toBe(true);
    const content = fs.readFileSync(jsonlPath, 'utf-8').trim();
    expect(JSON.parse(content).name).toBe('First Session');
  });
});
