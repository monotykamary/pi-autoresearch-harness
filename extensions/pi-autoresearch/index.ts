/**
 * autoresearch — Pi Extension (harness-based)
 *
 * Thin lifecycle shell for the autoresearch harness server.
 * All experiment interactions happen through the `pi-autoresearch` CLI,
 * which dispatches to a long-lived harness server holding experiment state.
 *
 * This extension:
 *   - Installs the CLI shell alias on session start
 *   - Manages the status widget and fullscreen dashboard
 *   - Provides the /autoresearch command (including live export)
 *   - Auto-resumes the experiment loop after pi context compaction
 *   - Injects autoresearch guidance into the system prompt
 *   - Writes session ID to disk for the harness server
 */

import { tmpdir } from 'node:os';
import * as fs from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn as spawnChild } from 'node:child_process';
import { createServer, type Server, type ServerResponse } from 'node:http';
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
} from '@earendil-works/pi-coding-agent';
import { Text, truncateToWidth } from '@earendil-works/pi-tui';
import type {
  AutoresearchRuntime,
  ExperimentState,
  ExperimentResult,
  MetricDef,
} from './src/types/index.js';
import { createRuntimeStore, createExperimentState } from './src/state/index.js';
import {
  createWidgetUpdater,
  clearSessionUi,
  createFullscreenHandler,
  createFullscreenState,
  clearFullscreen,
  type FullscreenState,
} from './src/ui/index.js';
import { renderDashboardLines } from './src/dashboard/index.js';
import { formatNum, isBetter, currentResults, findBaselineSecondary } from './src/utils/index.js';
import { getDisplayWorktreePath } from './src/git/index.js';
import {
  autoresearchSummaryPathsFor,
  buildAutoresearchCompactionSummary,
} from './src/compaction/index.js';
import { resolveAutoresearchShortcuts, dashboardHintVariants } from './src/shortcuts/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_AUTORESUME_TURNS = 20;
const SETTLED_WINDOW_MS = 800;
const BENCHMARK_GUARDRAIL =
  'Be careful not to overfit to the benchmarks and do not cheat on the benchmarks.';

// Session file paths (single source of truth for autoresearch.* filenames)
const autoresearchJsonlPath = (dir: string) => join(dir, 'autoresearch.jsonl');
const autoresearchMdPath = (dir: string) => join(dir, 'autoresearch.md');
const autoresearchIdeasPath = (dir: string) => join(dir, 'autoresearch.ideas.md');
const autoresearchChecksPath = (dir: string) => join(dir, 'autoresearch.checks.sh');
const autoresearchConfigPath = (dir: string) => join(dir, 'autoresearch.config.json');

// ---------------------------------------------------------------------------
// CLI path resolution
// ---------------------------------------------------------------------------

const __dirname = fileURLToPath(new URL('.', import.meta.url));

function getProjectRoot(): string {
  return join(__dirname, '..', '..');
}

function getCliPath(): string {
  return join(getProjectRoot(), 'harness', 'pi-autoresearch.mjs');
}

// ---------------------------------------------------------------------------
// Shell alias installation
// ---------------------------------------------------------------------------

function installShellAlias(): void {
  try {
    const agentBinDir = join(getAgentDir(), 'bin');
    if (!fs.existsSync(agentBinDir)) {
      fs.mkdirSync(agentBinDir, { recursive: true });
    }
    const cliPath = getCliPath();
    const linkPath = join(agentBinDir, 'pi-autoresearch');

    const wrapperContent = `#!/bin/sh
exec "${process.execPath.replace(/\\/g, '/')}" "${cliPath.replace(/\\/g, '/')}" "$@"
`;

    let currentContent: string | null = null;
    try {
      currentContent = fs.readFileSync(linkPath, 'utf-8');
    } catch {}
    if (currentContent !== wrapperContent) {
      fs.writeFileSync(linkPath, wrapperContent, { mode: 0o755 });
    }

    if (process.platform === 'win32') {
      const cmdPath = `${linkPath}.cmd`;
      const cmdContent = `@echo off\r\n"${process.execPath}" "${cliPath}" %*\r\n`;
      let currentCmdContent: string | null = null;
      try {
        currentCmdContent = fs.readFileSync(cmdPath, 'utf-8');
      } catch {}
      if (currentCmdContent !== cmdContent) fs.writeFileSync(cmdPath, cmdContent);
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

interface AutoresearchConfig {
  workingDir?: string;
  maxIterations?: number;
}

/** Read autoresearch.config.json from the given directory */
function readConfig(cwd: string): AutoresearchConfig {
  try {
    const configPath = autoresearchConfigPath(cwd);
    if (!fs.existsSync(configPath)) return {};
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    return {};
  }
}

/** Resolve the working directory for autoresearch operations */
function resolveWorkDir(ctxCwd: string): string {
  const config = readConfig(ctxCwd);
  if (config.workingDir) {
    return isAbsolute(config.workingDir) ? config.workingDir : join(ctxCwd, config.workingDir);
  }
  return ctxCwd;
}

// ---------------------------------------------------------------------------
// Widget (reads from harness server state via JSONL file watcher)
// ---------------------------------------------------------------------------

function createHarnessWidgetUpdater(
  getRuntime: (ctx: ExtensionContext) => AutoresearchRuntime,
  shortcuts: import('./src/shortcuts/index.js').AutoresearchShortcuts
) {
  return function updateWidget(extCtx: ExtensionContext): void {
    if (!extCtx.hasUI) return;

    const runtime = getRuntime(extCtx);
    const state = runtime.state;
    const termWidth = process.stdout.columns || 120;
    // Container wraps widgets with paddingX=1 (2 columns total). The
    // content width Text.render() receives is termWidth - 2. Truncate to
    // that width so wrapTextWithAnsi does not split lines.
    const width = termWidth - 2;

    if (state.results.length > 0) {
      if (runtime.dashboardExpanded) {
        extCtx.ui.setWidget('autoresearch', (_tui, theme) => {
          const lines: string[] = [];
          const collapseHints = dashboardHintVariants(shortcuts, 'collapse');
          const hintText = collapseHints.length > 0 ? ` ${collapseHints[0]} ` : '';
          const labelPrefix = '🔬 autoresearch';
          let nameStr = state.name ? `: ${state.name}` : '';
          // Expanded header: use termWidth for layout so border dashes span
          // the full terminal width. The last 2 visible chars may wrap to a
          // second line (Container passes contentWidth = termWidth - 2 to
          // Text.render), but since they are border dashes the visual gap
          // is negligible.
          const expandedW = termWidth;
          const maxLabelLen = hintText
            ? expandedW - 3 - 2 - hintText.length - 1
            : expandedW - 3 - 2 - 1;
          let label = labelPrefix + nameStr;
          if (label.length > maxLabelLen) {
            label = label.slice(0, maxLabelLen - 1) + '…';
          }
          const fillLen = Math.max(0, expandedW - 3 - 1 - label.length - 1 - hintText.length);
          const leftBorder = '───';
          const rightBorder = '─'.repeat(fillLen);
          lines.push(
            truncateToWidth(
              theme.fg('borderMuted', leftBorder) +
                theme.fg('accent', ' ' + label + ' ') +
                theme.fg('borderMuted', rightBorder) +
                theme.fg('dim', hintText),
              expandedW
            )
          );
          const worktreeDisplay = runtime.worktreeDir
            ? getDisplayWorktreePath(extCtx.cwd, runtime.worktreeDir)
            : null;
          // Dashboard table lines use content width so they don't wrap.
          lines.push(...renderDashboardLines(state, width, theme, 6, worktreeDisplay));
          return new Text(lines.join('\n'), 0, 0);
        });
      } else {
        extCtx.ui.setWidget('autoresearch', (_tui, theme) => {
          const cur = currentResults(state.results, state.currentSegment);
          const kept = cur.filter((r) => r.status === 'keep').length;
          const crashed = cur.filter((r) => r.status === 'crash').length;
          const checksFailed = cur.filter((r) => r.status === 'checks_failed').length;
          const baseline = state.bestMetric;
          const baselineSec = findBaselineSecondary(
            state.results,
            state.currentSegment,
            state.secondaryMetrics
          );

          let bestPrimary: number | null = null;
          let bestSec: Record<string, number> = {};
          let bestRunNum = 0;
          for (let i = state.results.length - 1; i >= 0; i--) {
            const r = state.results[i];
            if (r.segment !== state.currentSegment) continue;
            if (r.status === 'keep' && r.metric > 0) {
              if (bestPrimary === null || isBetter(r.metric, bestPrimary, state.bestDirection)) {
                bestPrimary = r.metric;
                bestSec = r.metrics ?? {};
                bestRunNum = i + 1;
              }
            }
          }

          const displayVal = bestPrimary ?? baseline;
          const parts = [
            theme.fg('accent', '🔬'),
            theme.fg('muted', ` ${state.results.length} runs`),
            theme.fg('success', ` ${kept} kept`),
            crashed > 0 ? theme.fg('error', ` ${crashed}💥`) : '',
            checksFailed > 0 ? theme.fg('error', ` ${checksFailed}⚠`) : '',
            theme.fg('dim', ' │ '),
            theme.fg(
              'warning',
              theme.bold(`★ ${state.metricName}: ${formatNum(displayVal, state.metricUnit)}`)
            ),
            bestRunNum > 0 ? theme.fg('dim', ` #${bestRunNum}`) : '',
          ];

          if (
            baseline !== null &&
            bestPrimary !== null &&
            baseline !== 0 &&
            bestPrimary !== baseline
          ) {
            const pct = ((bestPrimary - baseline) / baseline) * 100;
            const sign = pct > 0 ? '+' : '';
            const deltaColor = isBetter(bestPrimary, baseline, state.bestDirection)
              ? 'success'
              : 'error';
            parts.push(theme.fg(deltaColor, ` (${sign}${pct.toFixed(1)}%)`));
          }

          if (state.confidence !== null) {
            const confStr = state.confidence.toFixed(1);
            const confColor: Parameters<typeof theme.fg>[0] =
              state.confidence >= 2.0 ? 'success' : state.confidence >= 1.0 ? 'warning' : 'error';
            parts.push(theme.fg('dim', ' │ '));
            parts.push(theme.fg(confColor, `conf: ${confStr}×`));
          }

          if (state.targetValue !== null && displayVal !== null) {
            const reached =
              state.bestDirection === 'lower'
                ? displayVal <= state.targetValue
                : displayVal >= state.targetValue;
            parts.push(theme.fg('dim', ' │ '));
            if (reached) {
              parts.push(
                theme.fg('success', `🎯 ${formatNum(state.targetValue, state.metricUnit)} ✓`)
              );
            } else {
              parts.push(theme.fg('muted', `→ ${formatNum(state.targetValue, state.metricUnit)}`));
            }
          }

          if (state.secondaryMetrics.length > 0) {
            let secContent = '';
            for (const sm of state.secondaryMetrics) {
              const val = bestSec[sm.name];
              const bv = baselineSec[sm.name];
              if (val !== undefined) {
                if (secContent) secContent += '  ';
                secContent += `${sm.name}: ${formatNum(val, sm.unit)}`;
                if (bv !== undefined && bv !== 0 && val !== bv) {
                  const p = ((val - bv) / bv) * 100;
                  const s = p > 0 ? '+' : '';
                  secContent += ` ${s}${p.toFixed(1)}%`;
                }
              }
            }
            if (secContent) {
              parts.push(theme.fg('dim', ' │ '));
              parts.push(theme.fg('muted', secContent));
            }
          }

          if (state.name) {
            parts.push(theme.fg('dim', ` │ ${state.name}`));
          }

          const expandHints = dashboardHintVariants(shortcuts, 'expand');
          if (expandHints.length > 0) {
            parts.push(theme.fg('dim', `  (${expandHints[0]})`));
          }

          return new Text(truncateToWidth(parts.join(''), width), 0, 0);
        });
      }
      return;
    }

    // No results yet — show session status
    if (state.name) {
      extCtx.ui.setWidget('autoresearch', (_tui, theme) => {
        const parts = [
          theme.fg('accent', '🔬'),
          theme.fg('text', ` ${state.name}`),
          theme.fg('dim', ' — ready'),
        ];
        return new Text(truncateToWidth(parts.join(''), width), 0, 0);
      });
      return;
    }

    extCtx.ui.setWidget('autoresearch', undefined);
  };
}

// ---------------------------------------------------------------------------
// JSONL file watcher — reconstructs state when harness server writes to JSONL
// ---------------------------------------------------------------------------

function startJsonlWatcher(
  extCtx: ExtensionContext,
  getRuntime: (ctx: ExtensionContext) => AutoresearchRuntime,
  updateWidget: (ctx: ExtensionContext) => void
): void {
  const runtime = getRuntime(extCtx);
  if (runtime.jsonlWatcher) return;

  const workDir = runtime.worktreeDir ?? resolveWorkDir(extCtx.cwd);
  const jsonlPath = join(workDir, 'autoresearch.jsonl');
  if (!fs.existsSync(jsonlPath)) return;

  try {
    fs.watchFile(jsonlPath, { interval: 500 }, () => {
      reconstructStateFromJsonl(runtime, workDir);
      updateWidget(extCtx);
    });

    runtime.jsonlWatcher = {
      close() {
        fs.unwatchFile(jsonlPath);
      },
    };
  } catch {}
}

function reconstructStateFromJsonl(runtime: AutoresearchRuntime, workDir: string): void {
  const jsonlPath = join(workDir, 'autoresearch.jsonl');
  if (!fs.existsSync(jsonlPath)) return;

  const preservedWorktreeDir = runtime.worktreeDir;
  runtime.state = createExperimentState();

  try {
    const content = fs.readFileSync(jsonlPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.name && !entry.run) {
          runtime.state.name = entry.name;
          runtime.state.metricName = entry.metric_name ?? 'metric';
          runtime.state.metricUnit = entry.metric_unit ?? '';
          runtime.state.bestDirection = entry.direction ?? 'lower';
          runtime.state.targetValue = entry.target_value ?? null;
          runtime.state.maxExperiments = entry.max_experiments ?? null;
          runtime.state.currentSegment = entry.segment ?? 0;
        }
        if (entry.run && typeof entry.run === 'number') {
          const experiment: ExperimentResult = {
            run: entry.run,
            commit: entry.commit ?? 'unknown',
            metric: entry.metric ?? 0,
            metrics: entry.metrics ?? {},
            status: entry.status ?? 'discard',
            description: entry.description ?? '',
            timestamp: entry.timestamp ?? Date.now(),
            segment: entry.segment ?? 0,
            confidence: entry.confidence ?? null,
            asi: entry.asi,
          };
          runtime.state.results.push(experiment);
        }
      } catch {}
    }

    if (runtime.state.results.length > 0) {
      runtime.state.bestMetric = runtime.state.results[0]?.metric ?? null;
      runtime.state.confidence = null; // computed on server side
    }
  } catch {}

  if (preservedWorktreeDir) runtime.worktreeDir = preservedWorktreeDir;
}

// ---------------------------------------------------------------------------
// Session ID bridge — writes session ID to disk for harness server / CLI
// ---------------------------------------------------------------------------

function writeSessionId(ctx: ExtensionContext, dirs: { base: string }): void {
  try {
    const sessionId = ctx.sessionManager.getSessionId();
    if (sessionId) {
      const sessionFilePath = join(dirs.base, 'session-id');
      const sessionDir = join(dirs.base);
      if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(sessionFilePath, sessionId, 'utf-8');
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// Auto-compact resume pipeline
// ---------------------------------------------------------------------------

function hasPendingResume(runtime: AutoresearchRuntime): boolean {
  return runtime.pendingResumeMessage !== null;
}

function pausePendingResume(runtime: AutoresearchRuntime): void {
  if (!runtime.pendingResumeTimer) return;
  clearTimeout(runtime.pendingResumeTimer);
  runtime.pendingResumeTimer = null;
}

function cancelPendingResume(runtime: AutoresearchRuntime): void {
  pausePendingResume(runtime);
  runtime.pendingResumeMessage = null;
}

function isAgentSettled(ctx: ExtensionContext): boolean {
  return ctx.isIdle() && !ctx.hasPendingMessages();
}

function sendPendingResumeIfReady(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runtime: AutoresearchRuntime
): void {
  const message = runtime.pendingResumeMessage;
  if (!message) return;
  if (!runtime.autoresearchMode) {
    cancelPendingResume(runtime);
    return;
  }
  if (!isAgentSettled(ctx)) return;
  if (hasReachedAutoResumeLimit(runtime)) {
    cancelPendingResume(runtime);
    notifyAutoResumeLimitReached(ctx);
    return;
  }

  cancelPendingResume(runtime);
  runtime.autoResumeTurns++;
  pi.sendUserMessage(message);
}

function schedulePendingResume(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runtime: AutoresearchRuntime,
  message: string
): void {
  pausePendingResume(runtime);
  runtime.pendingResumeMessage = message;
  runtime.pendingResumeTimer = setTimeout(
    () => sendPendingResumeIfReady(pi, ctx, runtime),
    SETTLED_WINDOW_MS
  );
}

function reschedulePendingResume(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runtime: AutoresearchRuntime
): void {
  if (!hasPendingResume(runtime)) return;
  schedulePendingResume(pi, ctx, runtime, runtime.pendingResumeMessage!);
}

function hasRunExperimentsThisSession(runtime: AutoresearchRuntime): boolean {
  return runtime.experimentsThisSession > 0;
}

/** Strict gate: only resume after a turn if an experiment actually ran. */
function shouldAutoResumeAfterTurn(runtime: AutoresearchRuntime): boolean {
  return runtime.autoresearchMode && hasRunExperimentsThisSession(runtime);
}

/** Permissive gate: compaction itself is evidence the loop should continue. */
function shouldAutoResumeAfterCompact(runtime: AutoresearchRuntime): boolean {
  return runtime.autoresearchMode;
}

function hasReachedAutoResumeLimit(runtime: AutoresearchRuntime): boolean {
  return runtime.autoResumeTurns >= MAX_AUTORESUME_TURNS;
}

function notifyAutoResumeLimitReached(ctx: ExtensionContext): void {
  ctx.ui.notify(`Autoresearch auto-resume limit reached (${MAX_AUTORESUME_TURNS} turns)`, 'info');
}

function composeResumeMessage(_ctx: ExtensionContext): string {
  return [
    'Run the next iteration now.',
    'Use the persisted autoresearch state as needed, pick the most promising hypothesis, then call pi-autoresearch run + log.',
    BENCHMARK_GUARDRAIL,
  ].join(' ');
}

function composeCompactionResumeMessage(_ctx: ExtensionContext): string {
  // The compaction summary already contains the rules, ideas, and recent
  // runs — so this resume message just kicks the loop forward.
  return [
    'Run the next iteration now.',
    'Pick the most promising hypothesis from the ideas backlog or the latest `next:` hints in recent runs, then call pi-autoresearch run + log.',
    'Do not re-read autoresearch.md or autoresearch.jsonl — the compaction summary already contains them.',
    BENCHMARK_GUARDRAIL,
  ].join(' ');
}

function ensurePendingResume(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  gate: (runtime: AutoresearchRuntime) => boolean,
  composeMessage: (ctx: ExtensionContext) => string = composeResumeMessage
): void {
  const runtime = getRuntimeFromCtx(ctx);
  if (hasPendingResume(runtime)) {
    reschedulePendingResume(pi, ctx, runtime);
    return;
  }
  if (!gate(runtime)) return;
  if (hasReachedAutoResumeLimit(runtime)) {
    notifyAutoResumeLimitReached(ctx);
    return;
  }
  schedulePendingResume(pi, ctx, runtime, composeMessage(ctx));
}

/** Send a message immediately if idle, otherwise as a follow-up */
function sendWhenReady(pi: ExtensionAPI, ctx: ExtensionContext, message: string): void {
  if (ctx.isIdle()) {
    pi.sendUserMessage(message);
    return;
  }
  pi.sendUserMessage(message, { deliverAs: 'followUp' });
}

// ---------------------------------------------------------------------------
// Live dashboard export (HTTP server + SSE)
// ---------------------------------------------------------------------------

const TITLE_PLACEHOLDER = '__AUTORESEARCH_TITLE__';
const LOGO_PLACEHOLDER = '__AUTORESEARCH_LOGO__';

let cachedPackageRoot: string | null = null;

function packageRoot(): string {
  if (cachedPackageRoot) return cachedPackageRoot;
  const extensionDir = fs.realpathSync(join(__dirname));
  cachedPackageRoot = join(extensionDir, '..', '..');
  return cachedPackageRoot;
}

function templatePath(): string {
  return join(packageRoot(), 'assets', 'template.html');
}

function readTemplate(): string {
  return fs.readFileSync(templatePath(), 'utf-8');
}

let cachedLogoDataUrl: string | null = null;

function logoDataUrl(): string {
  if (cachedLogoDataUrl) return cachedLogoDataUrl;
  const logoPath = join(packageRoot(), 'assets', 'logo.webp');
  const bytes = fs.readFileSync(logoPath);
  cachedLogoDataUrl = `data:image/webp;base64,${bytes.toString('base64')}`;
  return cachedLogoDataUrl;
}

function readJsonlContent(workDir: string): string {
  return fs.readFileSync(autoresearchJsonlPath(workDir), 'utf-8').trim();
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function injectDataIntoTemplate(template: string, title: string): string {
  const escapedTitle = escapeHtml(title);
  return template.replace(TITLE_PLACEHOLDER, () => escapedTitle);
}

let dashboardServer: Server | null = null;
let dashboardServerPort: number | null = null;
let dashboardServerWorkDir: string | null = null;
let dashboardServerHtmlPath: string | null = null;
const dashboardSseClients = new Set<ServerResponse>();

function openInBrowser(url: string): void {
  if (process.platform === 'win32') {
    spawnChild('rundll32.exe', ['url.dll,FileProtocolHandler', url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
    return;
  }

  const openCmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawnChild(openCmd, [url], { detached: true, stdio: 'ignore' }).unref();
}

function stopDashboardServer(): void {
  for (const client of dashboardSseClients) {
    try {
      client.end();
    } catch {
      /* ignore */
    }
  }
  dashboardSseClients.clear();

  if (dashboardServer) {
    try {
      dashboardServer.close();
    } catch {
      /* ignore */
    }
  }

  dashboardServer = null;
  dashboardServerPort = null;
  dashboardServerWorkDir = null;
  dashboardServerHtmlPath = null;
}

function writeDashboardFile(workDir: string): string {
  const jsonlContent = readJsonlContent(workDir);
  // Extract session name from first config entry
  let sessionName = 'Autoresearch';
  for (const line of jsonlContent.split('\n').filter(Boolean)) {
    try {
      const entry = JSON.parse(line);
      if (entry && entry.type === 'config' && entry.name) {
        sessionName = entry.name;
        break;
      }
    } catch {}
  }
  const html = injectDataIntoTemplate(readTemplate(), sessionName).replace(
    LOGO_PLACEHOLDER,
    logoDataUrl()
  );
  const exportDir = fs.mkdtempSync(join(tmpdir(), 'pi-autoresearch-dashboard-'));
  const dest = join(exportDir, 'index.html');
  fs.writeFileSync(dest, html);
  return dest;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.jsonl': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function resolveServedFile(workDir: string, requestPath: string): string | null {
  if (requestPath === '/') return dashboardServerHtmlPath;
  if (requestPath === '/autoresearch.jsonl') return autoresearchJsonlPath(workDir);
  return null;
}

function registerSseClient(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('retry: 1000\n\n');
  dashboardSseClients.add(res);
  res.on('close', () => dashboardSseClients.delete(res));
}

function startStaticServer(workDir: string, dashboardHtmlPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const resolvedWorkDir = workDir;
    const resolvedDashboardHtmlPath = dashboardHtmlPath;

    if (dashboardServer && dashboardServerWorkDir === resolvedWorkDir && dashboardServerPort) {
      dashboardServerHtmlPath = resolvedDashboardHtmlPath;
      resolve(dashboardServerPort);
      return;
    }

    stopDashboardServer();
    dashboardServerHtmlPath = resolvedDashboardHtmlPath;

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');

      if (url.pathname === '/events') {
        registerSseClient(res);
        return;
      }

      const filePath = resolveServedFile(resolvedWorkDir, url.pathname);
      if (!filePath) {
        res.writeHead(404);
        res.end();
        return;
      }

      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end();
          return;
        }
        const ext = filePath.slice(filePath.lastIndexOf('.'));
        const contentType = CONTENT_TYPES[ext] ?? 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to bind dashboard server'));
        return;
      }
      dashboardServer = server;
      dashboardServerPort = address.port;
      dashboardServerWorkDir = resolvedWorkDir;
      resolve(address.port);
    });

    server.on('error', reject);
  });
}

async function exportDashboard(ctx: ExtensionContext): Promise<void> {
  const workDir = resolveWorkDir(ctx.cwd);
  const jsonlPath = autoresearchJsonlPath(workDir);

  if (!fs.existsSync(jsonlPath)) {
    ctx.ui.notify('No autoresearch.jsonl found — run some experiments first', 'error');
    return;
  }

  try {
    const dashboardHtmlPath = writeDashboardFile(workDir);
    const port = await startStaticServer(workDir, dashboardHtmlPath);
    const url = `http://127.0.0.1:${port}`;
    openInBrowser(url);
    ctx.ui.notify(`Dashboard at ${url} (live updates)`, 'info');
  } catch (error) {
    ctx.ui.notify(
      `Export failed: ${error instanceof Error ? error.message : String(error)}`,
      'error'
    );
  }
}

// ---------------------------------------------------------------------------
// /autoresearch command help
// ---------------------------------------------------------------------------

function autoresearchHelp(): string {
  return [
    'Usage: /autoresearch [off|clear|export|<text>]',
    '',
    'Commands:',
    '  off     — Stop autoresearch mode (aborts current run)',
    '  clear   — Delete autoresearch.jsonl and reset state',
    '  export  — Open live dashboard in browser',
    '  <text>  — Activate autoresearch mode with given goal',
    '',
    'Use pi-autoresearch CLI for experiment operations:',
    '  pi-autoresearch activate "goal"',
    '  pi-autoresearch init --name ... --metric-name ...',
    '  pi-autoresearch run "bash autoresearch.sh"',
    '  pi-autoresearch log --metric N --status keep --description "..."',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

// Late-bound: we need pi and getRuntime in the resume pipeline but they're
// only available inside the extension function. These are set once during init.
let _pi: ExtensionAPI;
let _getRuntime: (ctx: ExtensionContext) => AutoresearchRuntime;

function getRuntimeFromCtx(ctx: ExtensionContext): AutoresearchRuntime {
  return _getRuntime(ctx);
}

export default function autoresearchExtension(pi: ExtensionAPI) {
  _pi = pi;
  const runtimeStore = createRuntimeStore();
  const getSessionKey = (ctx: ExtensionContext) => ctx.sessionManager.getSessionId();
  const getRuntime = (ctx: ExtensionContext): AutoresearchRuntime =>
    runtimeStore.ensure(getSessionKey(ctx));
  _getRuntime = getRuntime;

  const uiState: FullscreenState = createFullscreenState();
  const clearOverlay = () => clearFullscreen(uiState);

  const shortcuts = resolveAutoresearchShortcuts();

  const updateWidget = createHarnessWidgetUpdater(getRuntime, shortcuts);

  function getDirs() {
    const baseDir = join(process.cwd(), '.pi', 'autoresearch');
    return { base: baseDir };
  }

  // ===========================================================================
  // /autoresearch command
  // ===========================================================================

  pi.registerCommand('autoresearch', {
    description: 'Start, stop, export, or clear autoresearch mode',
    handler: async (args, extCtx) => {
      const runtime = getRuntime(extCtx);
      const trimmedArgs = (args ?? '').trim();
      const command = trimmedArgs.toLowerCase();

      if (!trimmedArgs) {
        extCtx.ui.notify(autoresearchHelp(), 'info');
        return;
      }

      if (command === 'off') {
        const wasRunning = !extCtx.isIdle();

        runtime.autoresearchMode = false;
        runtime.dashboardExpanded = false;
        runtime.autoResumeTurns = 0;
        runtime.experimentsThisSession = 0;
        runtime.lastRunChecks = null;
        runtime.lastRunDuration = null;
        runtime.runningExperiment = null;
        cancelPendingResume(runtime);
        stopDashboardServer();

        if (runtime.jsonlWatcher) {
          runtime.jsonlWatcher.close();
          runtime.jsonlWatcher = null;
        }
        clearSessionUi(extCtx, clearOverlay);

        if (wasRunning) extCtx.abort();

        extCtx.ui.notify(
          wasRunning ? 'Autoresearch mode OFF — aborting current run' : 'Autoresearch mode OFF',
          'info'
        );
        return;
      }

      if (command === 'export') {
        await exportDashboard(extCtx);
        return;
      }

      if (command === 'clear') {
        const workDir = resolveWorkDir(extCtx.cwd);
        const jsonlPath = autoresearchJsonlPath(workDir);

        runtime.autoresearchMode = false;
        runtime.dashboardExpanded = false;
        runtime.autoResumeTurns = 0;
        runtime.experimentsThisSession = 0;
        runtime.lastRunChecks = null;
        runtime.runningExperiment = null;
        cancelPendingResume(runtime);
        runtime.state = createExperimentState();
        stopDashboardServer();

        if (runtime.jsonlWatcher) {
          runtime.jsonlWatcher.close();
          runtime.jsonlWatcher = null;
        }
        runtime.worktreeDir = null;
        updateWidget(extCtx);

        if (fs.existsSync(jsonlPath)) {
          try {
            fs.unlinkSync(jsonlPath);
            extCtx.ui.notify('Deleted autoresearch.jsonl and turned autoresearch mode OFF', 'info');
          } catch (error) {
            extCtx.ui.notify(
              `Failed to delete autoresearch.jsonl: ${error instanceof Error ? error.message : String(error)}`,
              'error'
            );
          }
        } else {
          extCtx.ui.notify('No autoresearch.jsonl found. Autoresearch mode OFF', 'info');
        }
        return;
      }

      if (runtime.autoresearchMode) {
        extCtx.ui.notify(
          "Autoresearch already active — use '/autoresearch off' to stop first",
          'info'
        );
        return;
      }

      // Activate
      runtime.autoresearchMode = true;
      runtime.autoResumeTurns = 0;

      const workDir = resolveWorkDir(extCtx.cwd);
      const hasRules = fs.existsSync(autoresearchMdPath(workDir));

      extCtx.ui.notify(
        hasRules
          ? 'Autoresearch mode ON — rules loaded from autoresearch.md'
          : 'Autoresearch mode ON — no autoresearch.md found, setting up',
        'info'
      );

      const kickoff = hasRules
        ? `Autoresearch mode active. ${trimmedArgs} ${BENCHMARK_GUARDRAIL}`
        : `Start autoresearch: ${trimmedArgs} ${BENCHMARK_GUARDRAIL}`;

      sendWhenReady(pi, extCtx, kickoff);
    },
  });

  // ===========================================================================
  // Keyboard shortcuts (configurable)
  // ===========================================================================

  // shortcuts resolved above (shared with widget updater)

  if (shortcuts.toggleDashboard) {
    pi.registerShortcut(shortcuts.toggleDashboard, {
      description: 'Toggle autoresearch dashboard',
      handler: async (ctx) => {
        const runtime = getRuntime(ctx);
        if (runtime.state.results.length === 0) {
          ctx.ui.notify('No experiments yet', 'info');
          return;
        }
        runtime.dashboardExpanded = !runtime.dashboardExpanded;
        updateWidget(ctx);
      },
    });
  }

  if (shortcuts.fullscreenDashboard) {
    const showFullscreen = createFullscreenHandler(uiState, { getRuntime });
    pi.registerShortcut(shortcuts.fullscreenDashboard, {
      description: 'Fullscreen autoresearch dashboard',
      handler: showFullscreen,
    });
  }

  // ===========================================================================
  // System prompt injection — autoresearch guidance on every turn
  // ===========================================================================

  pi.on('before_agent_start', async (event, extCtx) => {
    const runtime = getRuntime(extCtx);
    if (!runtime.autoresearchMode) return;

    const workDir = runtime.worktreeDir ?? resolveWorkDir(extCtx.cwd);
    const mdPath = autoresearchMdPath(workDir);
    const ideasPath = autoresearchIdeasPath(workDir);
    const hasIdeas = fs.existsSync(ideasPath);

    const checksPath = autoresearchChecksPath(workDir);
    const hasChecks = fs.existsSync(checksPath);

    let extra =
      '\n\n## Autoresearch Mode (ACTIVE)' +
      '\nYou are in autoresearch mode. Optimize the primary metric through an autonomous experiment loop.' +
      '\nUse pi-autoresearch init, run, and log to manage experiments. NEVER STOP until interrupted.' +
      `\nExperiment rules: ${mdPath} — read this file at the start of every session. After compaction, the rules are included in the compaction summary.` +
      "\nWrite promising but deferred optimizations as bullet points to autoresearch.ideas.md — don't let good ideas get lost." +
      `\n${BENCHMARK_GUARDRAIL}` +
      '\nIf the user sends a follow-on message while an experiment is running, finish the current run + log cycle first, then address their message in the next iteration.';

    if (hasChecks) {
      extra +=
        '\n\n## Backpressure Checks (ACTIVE)' +
        `\n${checksPath} exists and runs automatically after every passing benchmark in pi-autoresearch run.` +
        '\nIf the benchmark passes but checks fail, run will report it clearly.' +
        "\nUse status 'checks_failed' in log when this happens — it behaves like a crash (no commit, changes auto-reverted)." +
        "\nYou cannot use status 'keep' when checks have failed." +
        '\nThe checks execution time does NOT affect the primary metric.';
    }

    if (hasIdeas) {
      extra += `\n\n💡 Ideas backlog exists at ${ideasPath} — check it for promising experiment paths. Prune stale entries.`;
    }

    return {
      systemPrompt: event.systemPrompt + extra,
    };
  });

  // ===========================================================================
  // Lifecycle — auto-compact resume pipeline
  // ===========================================================================

  pi.on('agent_start', async (_event, extCtx) => {
    const runtime = getRuntime(extCtx);
    runtime.experimentsThisSession = 0;
    pausePendingResume(runtime);
  });

  pi.on('session_before_compact', async (event, extCtx) => {
    const runtime = getRuntime(extCtx);
    pausePendingResume(runtime);

    if (!runtime.autoresearchMode) return undefined;

    const workDir = runtime.worktreeDir ?? resolveWorkDir(extCtx.cwd);
    return {
      compaction: {
        summary: buildAutoresearchCompactionSummary(
          autoresearchSummaryPathsFor(workDir),
          runtime.state
        ),
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
      },
    };
  });

  pi.on('session_compact', async (_event, extCtx) => {
    ensurePendingResume(pi, extCtx, shouldAutoResumeAfterCompact, composeCompactionResumeMessage);
  });

  pi.on('agent_end', async (_event, extCtx) => {
    const runtime = getRuntime(extCtx);
    runtime.runningExperiment = null;
    ensurePendingResume(pi, extCtx, shouldAutoResumeAfterTurn);
  });

  // ===========================================================================
  // Lifecycle — session management
  // ===========================================================================

  pi.on('session_start', async (_event, extCtx) => {
    installShellAlias();
    writeSessionId(extCtx, getDirs());

    // Reconstruct state from existing JSONL
    const runtime = getRuntime(extCtx);
    const sessionId = getSessionKey(extCtx);

    // Auto-detect worktree
    if (!runtime.worktreeDir) {
      const { detectAutoresearchWorktree } = await import('./src/git/index.js');
      const detected = detectAutoresearchWorktree(extCtx.cwd, sessionId);
      if (detected) {
        runtime.worktreeDir = detected;
      }
    }

    const workDir = runtime.worktreeDir ?? resolveWorkDir(extCtx.cwd);
    const jsonlPath = autoresearchJsonlPath(workDir);

    // Auto-activate if autoresearch.jsonl exists (resume scenario)
    if (fs.existsSync(jsonlPath)) {
      runtime.autoresearchMode = true;
    }

    reconstructStateFromJsonl(runtime, workDir);
    startJsonlWatcher(extCtx, getRuntime, updateWidget);
    updateWidget(extCtx);
  });

  pi.on('session_before_switch', async (event, extCtx) => {
    const runtime = getRuntime(extCtx);
    cancelPendingResume(runtime);
    if (runtime.jsonlWatcher) {
      runtime.jsonlWatcher.close();
      runtime.jsonlWatcher = null;
    }
    if (event.reason === 'new') {
      clearSessionUi(extCtx, clearOverlay);
      runtimeStore.clear(getSessionKey(extCtx));
    }
  });

  pi.on('session_before_switch', async () => {
    clearOverlay();
  });

  pi.on('session_shutdown', async (_e, extCtx) => {
    const runtime = getRuntime(extCtx);
    cancelPendingResume(runtime);
    if (runtime.jsonlWatcher) {
      runtime.jsonlWatcher.close();
      runtime.jsonlWatcher = null;
    }
    clearSessionUi(extCtx, clearOverlay);
    runtimeStore.clear(getSessionKey(extCtx));
    stopDashboardServer();
  });
}
