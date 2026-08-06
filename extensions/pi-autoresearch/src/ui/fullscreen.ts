/**
 * Fullscreen dashboard overlay TUI
 */

import { matchesKey, Key, visibleWidth, truncateToWidth } from '@earendil-works/pi-tui';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { AutoresearchRuntime } from '../types/index.js';
import { renderDashboardLines } from '../dashboard/index.js';
import { formatElapsed } from '../utils/format.js';
import { getDisplayWorktreePath } from '../git/index.js';

const AUTORESEARCH_OVERLAY_MAX_HEIGHT_RATIO = 0.9;
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function fitOverlayTitle(titleContent: string, innerWidth: number): string {
  return truncateToWidth(` ${titleContent} `, Math.max(0, innerWidth), '');
}

/** Dependencies needed by fullscreen functions */
export interface FullscreenContext {
  getRuntime: (ctx: ExtensionContext) => AutoresearchRuntime;
}

/** UI state for fullscreen overlay */
export interface FullscreenState {
  overlayTui: { requestRender: () => void } | null;
  spinnerInterval: ReturnType<typeof setInterval> | null;
  spinnerFrame: number;
}

/**
 * Create initial fullscreen state
 */
export function createFullscreenState(): FullscreenState {
  return {
    overlayTui: null,
    spinnerInterval: null,
    spinnerFrame: 0,
  };
}

/**
 * Clear fullscreen overlay and spinner
 */
export function clearFullscreen(state: FullscreenState): void {
  state.overlayTui = null;
  if (state.spinnerInterval) {
    clearInterval(state.spinnerInterval);
    state.spinnerInterval = null;
  }
}

/**
 * Create fullscreen dashboard handler
 */
export function createFullscreenHandler(uiState: FullscreenState, ctx: FullscreenContext) {
  const { getRuntime } = ctx;

  return async function showFullscreen(extCtx: ExtensionContext): Promise<void> {
    const runtime = getRuntime(extCtx);
    const state = runtime.state;

    if (extCtx.mode !== 'tui') {
      extCtx.ui.notify('Autoresearch fullscreen dashboard is available in TUI mode.', 'info');
      return;
    }

    if (state.results.length === 0) {
      extCtx.ui.notify('No experiments yet', 'info');
      return;
    }

    await extCtx.ui.custom<void>(
      (tui, theme, _kb, done) => {
        let scrollOffset = 0;
        uiState.overlayTui = tui;

        // Start spinner interval for elapsed time animation
        uiState.spinnerInterval = setInterval(() => {
          uiState.spinnerFrame = (uiState.spinnerFrame + 1) % SPINNER.length;
          if (runtime.runningExperiment) tui.requestRender();
        }, 80);

        let lastSectionWidth = Math.max(10, (process.stdout.columns || 100) - 4);

        return {
          render(width: number): string[] {
            const termRows = process.stdout.rows || 40;
            const overlayRows = Math.max(
              10,
              Math.floor(termRows * AUTORESEARCH_OVERLAY_MAX_HEIGHT_RATIO)
            );
            const innerW = width - 2;
            const sectionW = innerW - 2;
            lastSectionWidth = sectionW;

            const border = (s: string) => theme.fg('dim', s);
            const pad = (s: string, len: number) =>
              s + ' '.repeat(Math.max(0, len - visibleWidth(s)));
            const row = (content: string) => {
              const safe = truncateToWidth(content, sectionW);
              return border('│') + pad(' ' + safe, innerW) + border('│');
            };
            const emptyRow = () => border('│') + ' '.repeat(innerW) + border('│');

            const worktreeDisplay = runtime.worktreeDir
              ? getDisplayWorktreePath(extCtx.cwd, runtime.worktreeDir)
              : null;
            const content = renderDashboardLines(state, sectionW, theme, 0, worktreeDisplay);

            // Add running experiment as next row in the list
            if (runtime.runningExperiment) {
              const elapsed = formatElapsed(Date.now() - runtime.runningExperiment.startedAt);
              const frame = SPINNER[uiState.spinnerFrame % SPINNER.length];
              const nextIdx = state.results.length + 1;
              content.push(
                `  ${theme.fg('dim', String(nextIdx).padEnd(3))}` +
                  theme.fg('warning', `${frame} running… ${elapsed}`)
              );
            }

            const totalRows = content.length;
            const chromeRows = 5;
            const viewportRows = Math.max(4, overlayRows - chromeRows);

            const maxScroll = Math.max(0, totalRows - viewportRows);
            if (scrollOffset > maxScroll) scrollOffset = maxScroll;
            if (scrollOffset < 0) scrollOffset = 0;

            const out: string[] = [];

            // Title bar with border
            const titlePrefix = '🔬 autoresearch';
            const nameStr = state.name ? `: ${state.name}` : '';
            const titleContent = titlePrefix + nameStr;
            const titleText = fitOverlayTitle(titleContent, innerW);
            const titleLen = visibleWidth(titleText);
            const borderLen = Math.max(0, innerW - titleLen);
            const leftBorder = Math.floor(borderLen / 2);
            const rightBorder = borderLen - leftBorder;

            out.push(
              border('╭' + '─'.repeat(leftBorder)) +
                theme.fg('accent', titleText) +
                border('─'.repeat(rightBorder) + '╮')
            );

            out.push(emptyRow());

            // Content rows with side borders
            const visible = content.slice(scrollOffset, scrollOffset + viewportRows);
            for (const line of visible) {
              out.push(row(line));
            }
            for (let i = visible.length; i < viewportRows; i++) {
              out.push(emptyRow());
            }

            // Footer row with scroll info and help
            const visibleStart = totalRows === 0 ? 0 : scrollOffset + 1;
            const visibleEnd = Math.min(scrollOffset + viewportRows, totalRows);
            const scrollState =
              totalRows <= viewportRows
                ? 'all'
                : scrollOffset === 0
                  ? 'top'
                  : visibleEnd >= totalRows
                    ? 'bottom'
                    : `${Math.round((visibleEnd / totalRows) * 100)}%`;
            const scrollInfo = ` ${visibleStart}-${visibleEnd}/${totalRows} • ${scrollState}`;
            const helpText = `↑↓/j/k scroll • u/d page • g/G top/bottom • esc close${scrollInfo}`;
            out.push(border('├' + '─'.repeat(innerW) + '┤'));
            out.push(row(theme.fg('dim', ' ' + helpText)));
            out.push(border('╰' + '─'.repeat(innerW) + '╯'));

            return out;
          },

          handleInput(data: string): void {
            const termRows = process.stdout.rows || 40;
            const overlayRows = Math.max(
              10,
              Math.floor(termRows * AUTORESEARCH_OVERLAY_MAX_HEIGHT_RATIO)
            );
            const chromeRows = 5;
            const viewportRows = Math.max(4, overlayRows - chromeRows);
            const worktreeDisplayRows = runtime.worktreeDir
              ? getDisplayWorktreePath(extCtx.cwd, runtime.worktreeDir)
              : null;
            const totalRows =
              renderDashboardLines(state, lastSectionWidth, theme, 0, worktreeDisplayRows).length +
              (runtime.runningExperiment ? 1 : 0);
            const maxScroll = Math.max(0, totalRows - viewportRows);

            if (matchesKey(data, Key.escape) || data === 'q') {
              done(undefined);
              return;
            }
            if (matchesKey(data, Key.up) || data === 'k') {
              scrollOffset = Math.max(0, scrollOffset - 1);
            } else if (matchesKey(data, Key.down) || data === 'j') {
              scrollOffset = Math.min(maxScroll, scrollOffset + 1);
            } else if (matchesKey(data, Key.pageUp) || data === 'u') {
              scrollOffset = Math.max(0, scrollOffset - viewportRows);
            } else if (matchesKey(data, Key.pageDown) || data === 'd') {
              scrollOffset = Math.min(maxScroll, scrollOffset + viewportRows);
            } else if (data === 'g') {
              scrollOffset = 0;
            } else if (data === 'G') {
              scrollOffset = maxScroll;
            }
            tui.requestRender();
          },

          invalidate(): void {},

          dispose(): void {
            clearFullscreen(uiState);
          },
        };
      },
      {
        overlay: true,
        overlayOptions: {
          width: '95%',
          maxHeight: '90%',
          anchor: 'center' as const,
        },
      }
    );
  };
}
