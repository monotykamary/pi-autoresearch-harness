import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

export function defaultLogPath(): string {
  return path.join(tmpdir(), 'pi-autoresearch-harness.log');
}

let cachedBashPath: string | null = null;

export function resolveBashPath(): string {
  if (process.env.PI_AUTORESEARCH_BASH) return process.env.PI_AUTORESEARCH_BASH;
  if (cachedBashPath) return cachedBashPath;
  if (process.platform !== 'win32') return 'bash';

  const candidates: string[] = [];
  try {
    const gitPaths = execFileSync('where.exe', ['git'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split(/\r?\n/)
      .filter(Boolean);
    for (const gitPath of gitPaths) {
      const dir = path.dirname(gitPath);
      candidates.push(path.join(dir, 'bash.exe'));
      candidates.push(path.join(dir, '..', 'bin', 'bash.exe'));
      candidates.push(path.join(dir, '..', 'usr', 'bin', 'bash.exe'));
    }
  } catch {}

  for (const root of [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'),
  ]) {
    if (root) candidates.push(path.join(root, 'Git', 'bin', 'bash.exe'));
  }

  cachedBashPath = candidates.find((candidate) => fs.existsSync(candidate)) ?? 'bash';
  return cachedBashPath;
}
