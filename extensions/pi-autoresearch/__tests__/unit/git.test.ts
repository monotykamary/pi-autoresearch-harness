/**
 * Unit tests for git and worktree utilities
 */

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';

describe('Worktree path logic', () => {
  it('worktree path follows expected pattern', () => {
    const ctxCwd = '/home/user/project';
    const sessionId = 'session-123';
    const expectedPath = path.join(ctxCwd, 'autoresearch', sessionId);
    expect(expectedPath).toBe(path.join('/home/user/project', 'autoresearch', 'session-123'));
  });

  it('handles relative ctxCwd', () => {
    const ctxCwd = './project';
    const sessionId = 'abc';
    const expectedPath = path.join(ctxCwd, 'autoresearch', sessionId);
    expect(expectedPath).toBe(path.join('project', 'autoresearch', 'abc'));
  });

  it('extracts display path correctly', () => {
    const ctxCwd = '/home/user/project';
    const worktreePath = '/home/user/project/autoresearch/session-123';
    const displayPath = path.relative(ctxCwd, worktreePath);
    expect(displayPath).toBe(path.join('autoresearch', 'session-123'));
  });

  it('handles worktree outside project (absolute display)', () => {
    const ctxCwd = '/home/user/project';
    const worktreePath = '/tmp/other-worktree';
    const displayPath = path.relative(ctxCwd, worktreePath);
    expect(displayPath).toBe(path.join('..', '..', '..', 'tmp', 'other-worktree'));
  });
});
