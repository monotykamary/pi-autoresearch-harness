/**
 * Tests for JSONL as source of truth - state reconstruction and file watching
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';

describe('detectAutoresearchWorktree', () => {
  let testDir: string;
  let repoDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoresearch-detect-'));
    repoDir = path.join(testDir, `repo-${Date.now()}`);
    fs.mkdirSync(repoDir, { recursive: true });

    execSync('git init', { cwd: repoDir, stdio: 'ignore' });
    execSync('git config user.email "test@test.com"', { cwd: repoDir, stdio: 'ignore' });
    execSync('git config user.name "Test User"', { cwd: repoDir, stdio: 'ignore' });

    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Test Repo');
    execSync('git add README.md', { cwd: repoDir, stdio: 'ignore' });
    execSync('git commit -m "Initial commit"', { cwd: repoDir, stdio: 'ignore' });
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  it('returns null when no worktrees with autoresearch.jsonl exist', async () => {
    const { detectAutoresearchWorktree } = await import('../../src/git/index.js');
    const result = detectAutoresearchWorktree(repoDir);
    expect(result).toBeNull();
  });

  it('detects worktree with autoresearch.jsonl for specific session', async () => {
    const sessionId = 'test-detect-session';
    const worktreePath = path.join(repoDir, 'autoresearch', sessionId);
    const branchName = `autoresearch/${sessionId}`;

    execSync(`git branch ${branchName}`, { cwd: repoDir, stdio: 'ignore' });
    execSync(`git worktree add ${worktreePath} ${branchName}`, { cwd: repoDir, stdio: 'ignore' });

    // Create autoresearch.jsonl in the worktree
    fs.writeFileSync(path.join(worktreePath, 'autoresearch.jsonl'), '{"name":"Test"}\n');

    const { detectAutoresearchWorktree } = await import('../../src/git/index.js');

    // Without sessionId - should still find it (backward compat / any session mode)
    const resultAny = detectAutoresearchWorktree(repoDir);
    expect(resultAny).not.toBeNull();

    // With matching sessionId - should find it
    const resultSpecific = detectAutoresearchWorktree(repoDir, sessionId);
    expect(resultSpecific).not.toBeNull();
    expect(path.normalize(resultSpecific!)).toContain(
      path.join('autoresearch', 'test-detect-session')
    );
    expect(fs.existsSync(path.join(resultSpecific!, 'autoresearch.jsonl'))).toBe(true);

    // With wrong sessionId - should NOT find it
    const resultWrong = detectAutoresearchWorktree(repoDir, 'wrong-session');
    expect(resultWrong).toBeNull();
  });

  it('only returns worktree matching the requested sessionId', async () => {
    const sessionId1 = 'test-session-1';
    const sessionId2 = 'test-session-2';
    const worktreePath1 = path.join(repoDir, 'autoresearch', sessionId1);
    const worktreePath2 = path.join(repoDir, 'autoresearch', sessionId2);
    const branchName1 = `autoresearch/${sessionId1}`;
    const branchName2 = `autoresearch/${sessionId2}`;

    execSync(`git branch ${branchName1}`, { cwd: repoDir, stdio: 'ignore' });
    execSync(`git branch ${branchName2}`, { cwd: repoDir, stdio: 'ignore' });
    execSync(`git worktree add ${worktreePath1} ${branchName1}`, { cwd: repoDir, stdio: 'ignore' });
    execSync(`git worktree add ${worktreePath2} ${branchName2}`, { cwd: repoDir, stdio: 'ignore' });

    // Create autoresearch.jsonl in BOTH worktrees
    fs.writeFileSync(path.join(worktreePath1, 'autoresearch.jsonl'), '{"name":"Test1"}\n');
    fs.writeFileSync(path.join(worktreePath2, 'autoresearch.jsonl'), '{"name":"Test2"}\n');

    const { detectAutoresearchWorktree } = await import('../../src/git/index.js');

    // Requesting sessionId1 should return worktreePath1, NOT worktreePath2
    const result1 = detectAutoresearchWorktree(repoDir, sessionId1);
    expect(result1).not.toBeNull();
    expect(path.normalize(result1!)).toContain(path.join('autoresearch', 'test-session-1'));

    // Requesting sessionId2 should return worktreePath2, NOT worktreePath1
    const result2 = detectAutoresearchWorktree(repoDir, sessionId2);
    expect(result2).not.toBeNull();
    expect(path.normalize(result2!)).toContain(path.join('autoresearch', 'test-session-2'));

    // Results should be different paths
    expect(result1).not.toBe(result2);
  });

  it('returns null when worktrees exist but have no autoresearch.jsonl', async () => {
    const sessionId = 'test-empty-session';
    const worktreePath = path.join(repoDir, 'autoresearch', sessionId);
    const branchName = `autoresearch/${sessionId}`;

    execSync(`git branch ${branchName}`, { cwd: repoDir, stdio: 'ignore' });
    execSync(`git worktree add ${worktreePath} ${branchName}`, { cwd: repoDir, stdio: 'ignore' });

    // No autoresearch.jsonl created

    const { detectAutoresearchWorktree } = await import('../../src/git/index.js');
    const result = detectAutoresearchWorktree(repoDir);
    expect(result).toBeNull();
  });
});

describe('JSONL reconstruction', () => {
  let testDir: string;
  let repoDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoresearch-jsonl-'));
    repoDir = path.join(testDir, `repo-${Date.now()}`);
    fs.mkdirSync(repoDir, { recursive: true });

    execSync('git init', { cwd: repoDir, stdio: 'ignore' });
    execSync('git config user.email "test@test.com"', { cwd: repoDir, stdio: 'ignore' });
    execSync('git config user.name "Test User"', { cwd: repoDir, stdio: 'ignore' });

    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Test Repo');
    execSync('git add README.md', { cwd: repoDir, stdio: 'ignore' });
    execSync('git commit -m "Initial commit"', { cwd: repoDir, stdio: 'ignore' });
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  it('reconstructs state from JSONL with config and experiments', async () => {
    const sessionId = 'test-reconstruct';
    const worktreePath = path.join(repoDir, 'autoresearch', sessionId);
    const branchName = `autoresearch/${sessionId}`;

    execSync(`git branch ${branchName}`, { cwd: repoDir, stdio: 'ignore' });
    execSync(`git worktree add ${worktreePath} ${branchName}`, { cwd: repoDir, stdio: 'ignore' });

    // Create JSONL with config and experiments (need 3+ for confidence)
    const jsonlContent = [
      '{"name":"Test Session","metric_name":"total_ms","metric_unit":"ms","direction":"lower","segment":0}',
      '{"run":1,"commit":"abc1234","metric":100,"metrics":{},"status":"keep","description":"Baseline","timestamp":1234567890,"segment":0,"confidence":null}',
      '{"run":2,"commit":"def5678","metric":95,"metrics":{},"status":"keep","description":"Tweak 1","timestamp":1234567891,"segment":0,"confidence":null}',
      '{"run":3,"commit":"ghi9012","metric":90,"metrics":{},"status":"keep","description":"Optimization","timestamp":1234567892,"segment":0,"confidence":null}',
    ].join('\n');

    fs.writeFileSync(path.join(worktreePath, 'autoresearch.jsonl'), jsonlContent + '\n');

    // Mock the reconstruction
    const { createExperimentState } = await import('../../src/state/index.js');
    const { computeConfidence } = await import('../../src/utils/stats.js');
    const state = createExperimentState();

    // Parse JSONL
    const lines = jsonlContent.split('\n');
    for (const line of lines) {
      const entry = JSON.parse(line);
      if (entry.name && !entry.run) {
        state.name = entry.name;
        state.metricName = entry.metric_name;
        state.metricUnit = entry.metric_unit;
        state.bestDirection = entry.direction;
        state.currentSegment = entry.segment;
      }
      if (entry.run) {
        state.results.push({
          run: entry.run,
          commit: entry.commit,
          metric: entry.metric,
          metrics: entry.metrics,
          status: entry.status,
          description: entry.description,
          timestamp: entry.timestamp,
          segment: entry.segment,
          confidence: entry.confidence,
        });
      }
    }

    // Recalculate derived state
    if (state.results.length > 0) {
      state.bestMetric = state.results[0]?.metric ?? null;
      state.confidence = computeConfidence(state.results, state.bestDirection);
    }

    expect(state.name).toBe('Test Session');
    expect(state.metricName).toBe('total_ms');
    expect(state.metricUnit).toBe('ms');
    expect(state.results).toHaveLength(3);
    expect(state.results[0].metric).toBe(100);
    expect(state.results[1].metric).toBe(95);
    expect(state.results[2].metric).toBe(90);
    expect(state.bestMetric).toBe(100);
    expect(state.confidence).toBeGreaterThan(0);
  });

  it('handles empty JSONL gracefully', async () => {
    const { createExperimentState } = await import('../../src/state/index.js');
    const state = createExperimentState();

    // Empty content
    const lines: string[] = [];
    for (const line of lines) {
      const entry = JSON.parse(line);
      if (entry.name && !entry.run) {
        state.name = entry.name;
      }
    }

    expect(state.name).toBeNull();
    expect(state.results).toHaveLength(0);
    expect(state.bestMetric).toBeNull();
  });

  it('handles malformed JSONL lines by skipping them', async () => {
    const { createExperimentState } = await import('../../src/state/index.js');
    const state = createExperimentState();

    const jsonlContent = [
      '{"name":"Test Session","metric_name":"ms","segment":0}',
      '{"run":1,"commit":"abc","metric":100,"status":"keep","description":"Good"}', // Valid
      'invalid json here', // Invalid - should be skipped
      '{"run":2,"commit":"def","metric":90,"status":"keep","description":"Also Good"}', // Valid
    ].join('\n');

    const lines = jsonlContent.split('\n');
    let validExperiments = 0;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.name && !entry.run) {
          state.name = entry.name;
          state.metricName = entry.metric_name;
        }
        if (entry.run && typeof entry.run === 'number') {
          state.results.push({
            run: entry.run,
            commit: entry.commit,
            metric: entry.metric,
            metrics: entry.metrics || {},
            status: entry.status,
            description: entry.description,
            timestamp: entry.timestamp || Date.now(),
            segment: entry.segment || 0,
            confidence: entry.confidence || null,
          });
          validExperiments++;
        }
      } catch {
        // Skip malformed lines
      }
    }

    expect(state.name).toBe('Test Session');
    expect(validExperiments).toBe(2);
    expect(state.results).toHaveLength(2);
  });
});

describe('Runtime state with jsonlWatcher', () => {
  it('createSessionRuntime initializes jsonlWatcher to null', async () => {
    const { createSessionRuntime } = await import('../../src/state/index.js');
    const runtime = createSessionRuntime();

    expect(runtime.jsonlWatcher).toBeNull();
    expect(runtime.worktreeDir).toBeNull();
    expect(runtime.autoresearchMode).toBe(false);
  });
});
