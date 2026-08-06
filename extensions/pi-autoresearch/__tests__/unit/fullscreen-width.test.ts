import { describe, expect, it } from 'vitest';
import { visibleWidth } from '@earendil-works/pi-tui';
import { fitOverlayTitle } from '../../src/ui/fullscreen.js';

describe('autoresearch fullscreen width', () => {
  it.each([10, 20, 60])('fits dynamic titles within %i columns', (width) => {
    const title = fitOverlayTitle('🔬 autoresearch: ' + 'experiment-'.repeat(20), width);
    expect(visibleWidth(title)).toBeLessThanOrEqual(width);
  });
});
