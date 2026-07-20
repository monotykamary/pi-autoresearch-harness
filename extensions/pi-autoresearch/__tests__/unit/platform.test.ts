import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultLogPath, resolveBashPath } from '../../../../harness/platform.js';

describe('platform helpers', () => {
  it('stores the harness log in the OS temp directory', () => {
    expect(defaultLogPath()).toBe(path.join(tmpdir(), 'pi-autoresearch-harness.log'));
  });

  it('resolves a working Bash executable', () => {
    const result = spawnSync(resolveBashPath(), ['--version'], { windowsHide: true });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  });
});
