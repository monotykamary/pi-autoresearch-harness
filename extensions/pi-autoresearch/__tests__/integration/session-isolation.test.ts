/**
 * Session isolation tests - ensure multiple sessions don't interfere with each other
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';

describe('Session Isolation', () => {
  let testDir: string;
  let repoDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoresearch-isolation-'));
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

  function createWorktree(sessionId: string): { worktreePath: string; branchName: string } {
    const branchName = `autoresearch/${sessionId}`;
    const worktreePath = path.join(repoDir, 'autoresearch', sessionId);

    execSync(`git branch ${branchName}`, { cwd: repoDir, stdio: 'ignore' });
    execSync(`git worktree add ${worktreePath} ${branchName}`, { cwd: repoDir, stdio: 'ignore' });

    return { worktreePath, branchName };
  }

  describe('detectAutoresearchWorktree session filtering', () => {
    it('returns null when requesting non-existent session worktree', async () => {
      const { detectAutoresearchWorktree } = await import('../../src/git/index.js');

      // Create a worktree for session-1
      createWorktree('session-1');

      // But request worktree for session-2
      const result = detectAutoresearchWorktree(repoDir, 'session-2');
      expect(result).toBeNull();
    });

    it('returns only the worktree for the requested session', async () => {
      const { detectAutoresearchWorktree } = await import('../../src/git/index.js');

      // Create worktrees for multiple sessions
      const { worktreePath: path1 } = createWorktree('alpha-session');
      const { worktreePath: path2 } = createWorktree('beta-session');
      const { worktreePath: path3 } = createWorktree('gamma-session');

      // Add jsonl to all worktrees
      fs.writeFileSync(path.join(path1, 'autoresearch.jsonl'), '{"name":"Alpha"}\n');
      fs.writeFileSync(path.join(path2, 'autoresearch.jsonl'), '{"name":"Beta"}\n');
      fs.writeFileSync(path.join(path3, 'autoresearch.jsonl'), '{"name":"Gamma"}\n');

      // Each session should only find its own worktree
      const resultAlpha = detectAutoresearchWorktree(repoDir, 'alpha-session');
      const resultBeta = detectAutoresearchWorktree(repoDir, 'beta-session');
      const resultGamma = detectAutoresearchWorktree(repoDir, 'gamma-session');

      expect(resultAlpha).toContain('alpha-session');
      expect(resultBeta).toContain('beta-session');
      expect(resultGamma).toContain('gamma-session');

      // Results should be different
      expect(resultAlpha).not.toBe(resultBeta);
      expect(resultBeta).not.toBe(resultGamma);
      expect(resultAlpha).not.toBe(resultGamma);
    });

    it('returns null for wrong session even when other sessions have jsonl', async () => {
      const { detectAutoresearchWorktree } = await import('../../src/git/index.js');

      // Create worktrees with jsonl
      const { worktreePath: path1 } = createWorktree('session-with-data');
      fs.writeFileSync(path.join(path1, 'autoresearch.jsonl'), '{"name":"HasData"}\n');

      // Create worktree WITHOUT jsonl
      const { worktreePath: path2 } = createWorktree('session-without-data');
      // No jsonl written

      // Requesting session-without-data should return null (no jsonl)
      const resultNoData = detectAutoresearchWorktree(repoDir, 'session-without-data');
      expect(resultNoData).toBeNull();

      // Requesting session-with-data should return the path
      const resultHasData = detectAutoresearchWorktree(repoDir, 'session-with-data');
      expect(resultHasData).not.toBeNull();
      expect(resultHasData).toContain('session-with-data');
    });
  });

  describe('worktree path construction', () => {
    it('creates worktree at correct session-specific path', async () => {
      const sessionId = 'my-test-session-123';
      const { createAutoresearchWorktree } = await import('../../src/git/index.js');

      // Mock ExtensionAPI for testing
      const mockPi = {
        exec: async (cmd: string, args: string[], _options: unknown) => {
          try {
            const result = execSync(`${cmd} ${args.join(' ')}`, {
              cwd: repoDir,
              encoding: 'utf-8',
              stdio: 'pipe',
            });
            return { code: 0, stdout: result, stderr: '' };
          } catch (e) {
            return { code: 1, stdout: '', stderr: String(e) };
          }
        },
      };

      const worktreePath = await createAutoresearchWorktree(mockPi as any, repoDir, sessionId);

      expect(worktreePath).not.toBeNull();
      expect(path.normalize(worktreePath!)).toContain(path.join('autoresearch', sessionId));
      expect(fs.existsSync(worktreePath!)).toBe(true);
      expect(fs.existsSync(path.join(worktreePath!, '.git'))).toBe(true);
    });

    it('creates different paths for different session IDs', async () => {
      const { createAutoresearchWorktree } = await import('../../src/git/index.js');

      const mockPi = {
        exec: async (cmd: string, args: string[], _options: unknown) => {
          try {
            const result = execSync(`${cmd} ${args.join(' ')}`, {
              cwd: repoDir,
              encoding: 'utf-8',
              stdio: 'pipe',
            });
            return { code: 0, stdout: result, stderr: '' };
          } catch (e) {
            return { code: 1, stdout: '', stderr: String(e) };
          }
        },
      };

      const path1 = await createAutoresearchWorktree(mockPi as any, repoDir, 'session-a');
      const path2 = await createAutoresearchWorktree(mockPi as any, repoDir, 'session-b');

      expect(path1).not.toBe(path2);
      expect(path1).toContain('session-a');
      expect(path2).toContain('session-b');
    });
  });

  describe('file isolation between sessions', () => {
    it("sessions cannot see each other's files in their worktrees", async () => {
      const { worktreePath: path1 } = createWorktree('isolated-1');
      const { worktreePath: path2 } = createWorktree('isolated-2');

      // Write different files in each worktree
      fs.writeFileSync(path.join(path1, 'session-file.txt'), 'I belong to session 1');
      fs.writeFileSync(path.join(path2, 'session-file.txt'), 'I belong to session 2');

      // Each file should only exist in its own worktree
      expect(fs.readFileSync(path.join(path1, 'session-file.txt'), 'utf-8')).toBe(
        'I belong to session 1'
      );
      expect(fs.readFileSync(path.join(path2, 'session-file.txt'), 'utf-8')).toBe(
        'I belong to session 2'
      );

      // Files should not leak between worktrees
      expect(fs.existsSync(path.join(path2, 'session-file.txt'))).toBe(true);
    });

    it('jsonl files are isolated per session', async () => {
      const { worktreePath: path1 } = createWorktree('jsonl-1');
      const { worktreePath: path2 } = createWorktree('jsonl-2');

      // Write different jsonl content
      fs.writeFileSync(
        path.join(path1, 'autoresearch.jsonl'),
        '{"name":"Session 1 Experiment"}\n{"run":1,"metric":100}\n'
      );
      fs.writeFileSync(
        path.join(path2, 'autoresearch.jsonl'),
        '{"name":"Session 2 Experiment"}\n{"run":1,"metric":200}\n'
      );

      // Verify isolation
      const content1 = fs.readFileSync(path.join(path1, 'autoresearch.jsonl'), 'utf-8');
      const content2 = fs.readFileSync(path.join(path2, 'autoresearch.jsonl'), 'utf-8');

      expect(content1).toContain('Session 1 Experiment');
      expect(content1).toContain('"metric":100');
      expect(content2).toContain('Session 2 Experiment');
      expect(content2).toContain('"metric":200');

      // Detection should return correct path for each session
      const { detectAutoresearchWorktree } = await import('../../src/git/index.js');

      expect(detectAutoresearchWorktree(repoDir, 'jsonl-1')).toContain('jsonl-1');
      expect(detectAutoresearchWorktree(repoDir, 'jsonl-2')).toContain('jsonl-2');
    });
  });

  describe('session cleanup isolation', () => {
    it("removing one session's worktree does not affect others", async () => {
      const { createAutoresearchWorktree, removeAutoresearchWorktree } =
        await import('../../src/git/index.js');

      const mockPi = {
        exec: async (cmd: string, args: string[], _options: unknown) => {
          try {
            const result = execSync(`${cmd} ${args.join(' ')}`, {
              cwd: repoDir,
              encoding: 'utf-8',
              stdio: 'pipe',
            });
            return { code: 0, stdout: result, stderr: '' };
          } catch (e) {
            return { code: 1, stdout: '', stderr: String(e) };
          }
        },
      };

      // Create two worktrees
      const path1 = await createAutoresearchWorktree(mockPi as any, repoDir, 'cleanup-test-1');
      const path2 = await createAutoresearchWorktree(mockPi as any, repoDir, 'cleanup-test-2');

      expect(fs.existsSync(path1!)).toBe(true);
      expect(fs.existsSync(path2!)).toBe(true);

      // Remove only the first worktree
      await removeAutoresearchWorktree(mockPi as any, repoDir, path1!);

      // First should be gone
      expect(fs.existsSync(path1!)).toBe(false);

      // Second should still exist
      expect(fs.existsSync(path2!)).toBe(true);
    });
  });
});
