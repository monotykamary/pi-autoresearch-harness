/**
 * Git worktree management for autoresearch isolation
 *
 * Note: createAutoresearchWorktree and removeAutoresearchWorktree are
 * kept here because the extension's /autoresearch command and lifecycle
 * handlers may need to detect/work with worktrees. The harness server
 * has its own copy of the worktree creation/removal logic.
 */

import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { execSync } from 'node:child_process';

function normalizePath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function canonicalPath(filePath: string): string {
  try {
    return normalizePath(fs.realpathSync.native(filePath));
  } catch {
    return normalizePath(path.resolve(filePath));
  }
}

function worktreePaths(output: string): string[] {
  return output
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice(9).trim());
}

/** Get the path to the global gitignore file */
function getGlobalGitignorePath(): string | null {
  try {
    const result = execSync('git config --global core.excludesfile', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const configured = result.trim();
    if (configured) return configured;
  } catch {
    // Not configured, fall through to default
  }

  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const candidates = [
    path.join(home, '.gitignore'),
    path.join(home, '.gitignore_global'),
    path.join(home, '.config', 'git', 'ignore'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return path.join(home, '.gitignore');
}

/** Ensure autoresearch/ is in the global gitignore */
function ensureGlobalGitignore(): void {
  try {
    const gitignorePath = getGlobalGitignorePath();
    if (!gitignorePath) return;

    const pattern = 'autoresearch/';
    let content = '';

    if (fs.existsSync(gitignorePath)) {
      content = fs.readFileSync(gitignorePath, 'utf-8');
      if (content.split(/\r?\n/).some((line) => line.trim() === pattern)) {
        return;
      }
    }

    const parentDir = path.dirname(gitignorePath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    const entry =
      content.endsWith('\n') || content === ''
        ? `# pi-autoresearch worktrees\n${pattern}\n`
        : `\n# pi-autoresearch worktrees\n${pattern}\n`;

    fs.appendFileSync(gitignorePath, entry, 'utf-8');
  } catch {
    // Silently fail
  }
}

// resolveWorkDir moved to harness server

/** Detect autoresearch worktree by looking for autoresearch.jsonl in git worktrees */
export function detectAutoresearchWorktree(ctxCwd: string, sessionId?: string): string | null {
  try {
    const output = execSync('git worktree list --porcelain', {
      cwd: ctxCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });

    for (const worktreePath of worktreePaths(output)) {
      if (sessionId) {
        const expectedSuffix = normalizePath(path.join('autoresearch', sessionId));
        if (!canonicalPath(worktreePath).endsWith(expectedSuffix)) continue;
      }

      const jsonlPath = path.join(worktreePath, 'autoresearch.jsonl');
      if (fs.existsSync(jsonlPath)) return worktreePath;
    }
  } catch {
    // Git command failed or no worktrees
  }
  return null;
}

/** Get the worktree path for display purposes (relative if inside project) */
export function getDisplayWorktreePath(ctxCwd: string, worktreePath: string | null): string | null {
  if (!worktreePath) return null;
  const relativePath = path.relative(canonicalPath(ctxCwd), canonicalPath(worktreePath));
  if (!relativePath.startsWith('..') && !path.isAbsolute(relativePath)) {
    return relativePath || '.';
  }
  return worktreePath;
}

/**
 * Create a git worktree for autoresearch isolation.
 * Used by the extension when the /autoresearch command is invoked.
 * The harness server has its own copy for CLI-driven creation.
 */
export async function createAutoresearchWorktree(
  pi: {
    exec: (cmd: string, args: string[], opts: any) => Promise<{ code: number; stdout: string }>;
  },
  ctxCwd: string,
  sessionId: string
): Promise<string | null> {
  const worktreeName = `autoresearch/${sessionId}`;
  const worktreePath = path.join(ctxCwd, worktreeName);

  try {
    const result = await pi.exec('git', ['worktree', 'list', '--porcelain'], {
      cwd: ctxCwd,
      timeout: 10000,
    });
    if (
      worktreePaths(result.stdout ?? '').some(
        (existingPath) => canonicalPath(existingPath) === canonicalPath(worktreePath)
      ) &&
      fs.existsSync(worktreePath)
    ) {
      return worktreePath;
    }
    try {
      await pi.exec('git', ['worktree', 'prune'], { cwd: ctxCwd, timeout: 5000 });
    } catch {}
  } catch {}

  const autoresearchDir = path.join(ctxCwd, 'autoresearch');
  if (!fs.existsSync(autoresearchDir)) {
    fs.mkdirSync(autoresearchDir, { recursive: true });
  }

  const branchName = `autoresearch/${sessionId}`;

  try {
    const branchResult = await pi.exec('git', ['branch', '--list', branchName], {
      cwd: ctxCwd,
      timeout: 5000,
    });
    if (!branchResult.stdout?.trim()) {
      const createResult = await pi.exec('git', ['branch', branchName], {
        cwd: ctxCwd,
        timeout: 10000,
      });
      if (createResult.code !== 0) return null;
    }

    const worktreeResult = await pi.exec('git', ['worktree', 'add', worktreePath, branchName], {
      cwd: ctxCwd,
      timeout: 30000,
    });
    if (worktreeResult.code !== 0) return null;

    ensureGlobalGitignore();
    return worktreePath;
  } catch {
    return null;
  }
}

/**
 * Remove a git worktree and its associated branch.
 */
export async function removeAutoresearchWorktree(
  pi: {
    exec: (cmd: string, args: string[], opts: any) => Promise<{ code: number; stdout: string }>;
  },
  ctxCwd: string,
  worktreePath: string
): Promise<void> {
  try {
    const branchResult = await pi.exec('git', ['branch', '--show-current'], {
      cwd: worktreePath,
      timeout: 5000,
    });
    await pi.exec('git', ['worktree', 'remove', '--force', worktreePath], {
      cwd: ctxCwd,
      timeout: 30000,
    });

    const branchName = branchResult.stdout?.trim();
    if (branchName) {
      await pi.exec('git', ['branch', '-D', branchName], { cwd: ctxCwd, timeout: 10000 });
    }

    const autoresearchDir = path.join(ctxCwd, 'autoresearch');
    try {
      if (fs.existsSync(autoresearchDir)) {
        const entries = fs.readdirSync(autoresearchDir);
        if (entries.length === 0) fs.rmdirSync(autoresearchDir);
      }
    } catch {}
  } catch {}
}
