#!/usr/bin/env node
/**
 * pi-autoresearch — CLI for autonomous experiment loops.
 *
 * Usage:
 *   pi-autoresearch activate "<goal>"
 *   pi-autoresearch init --name "..." --metric-name "..." [--metric-unit ""] [--direction lower] [--target-value N] [--max-experiments N]
 *   pi-autoresearch run "<command>" [--timeout 600] [--checks-timeout 300]
 *   pi-autoresearch log --metric N --status keep|discard|crash|checks_failed --description "..." [--metrics '{"k":v}'] [--asi '{"k":"v"}'] [--force]
 *   pi-autoresearch status
 *   pi-autoresearch list
 *   pi-autoresearch deactivate
 *   pi-autoresearch clear
 *
 * Also accepts JSON for programmatic use:
 *   pi-autoresearch '{ "action": "run", "command": "bash autoresearch.sh" }'
 *
 * Server management:
 *   pi-autoresearch --status
 *   pi-autoresearch --start
 *   pi-autoresearch --stop
 *   pi-autoresearch --restart
 *   pi-autoresearch --logs
 */

import { spawn as spawnChild } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import { fileURLToPath } from 'node:url';
import { defaultLogPath } from './platform.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PI_AUTORESEARCH_PORT ?? 9878);
const HOST = '127.0.0.1';
const BASE_URL = `http://${HOST}:${PORT}`;
const LOG = process.env.PI_AUTORESEARCH_LOG ?? defaultLogPath();

// =============================================================================
// HTTP helpers
// =============================================================================

function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 2000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') });
      });
    });
    req.on('error', (err) => resolve({ status: 0, body: err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, body: 'timeout' });
    });
  });
}

function httpPost(
  url: string,
  body: string,
  extraHeaders?: Record<string, string>
): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const data = Buffer.from(body, 'utf-8');
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-length': data.length,
          ...extraHeaders,
        },
        timeout: 60 * 60 * 1000, // 1 hour for long experiments
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') });
        });
      }
    );
    req.on('error', (err) => resolve({ status: 0, body: err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, body: 'timeout' });
    });
    req.write(data);
    req.end();
  });
}

// =============================================================================
// Session ID resolution
// =============================================================================

function readSessionIdFromFile(): string | undefined {
  try {
    const cwd = process.cwd();
    const sessionFilePath = path.join(cwd, '.pi', 'autoresearch', 'session-id');
    if (fs.existsSync(sessionFilePath)) {
      const id = fs.readFileSync(sessionFilePath, 'utf-8').trim();
      if (id) return id;
    }
  } catch {}
  return undefined;
}

function agentHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'x-cwd': encodeURIComponent(process.cwd()) };
  const sessionId = readSessionIdFromFile();
  if (sessionId) headers['x-session-id'] = sessionId;
  return headers;
}

// =============================================================================
// Server lifecycle
// =============================================================================

async function isUp(): Promise<boolean> {
  const { status } = await httpGet(`${BASE_URL}/health`);
  return status === 200;
}

async function startServer(): Promise<boolean> {
  if (await isUp()) return true;

  const serverLauncher = path.resolve(__dirname, 'server-launcher.mjs');
  const child = spawnChild(process.execPath, [serverLauncher], {
    cwd: process.cwd(),
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true,
    windowsHide: true,
    env: {
      ...process.env,
      PI_AUTORESEARCH_PORT: String(PORT),
      PI_AUTORESEARCH_LOG: LOG,
    },
  });
  child.on('error', () => {});
  child.unref();

  for (let i = 0; i < 150; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (await isUp()) return true;
  }

  process.stderr.write(`pi-autoresearch: server failed to start on ${BASE_URL} (see ${LOG})\n`);
  return false;
}

// =============================================================================
// Action dispatch
// =============================================================================

async function postAction(jsonBody: string): Promise<void> {
  const { status, body } = await httpPost(`${BASE_URL}/action`, jsonBody, agentHeaders());
  if (status === 200) {
    try {
      const parsed = JSON.parse(body);
      if (parsed.ok && parsed.result?.text) {
        process.stdout.write(parsed.result.text + '\n');
      } else if (!parsed.ok) {
        process.stderr.write(`Error: ${parsed.error}\n`);
        process.exit(1);
      }
    } catch {
      if (body.trim()) process.stdout.write(body + '\n');
    }
  } else if (status === 0) {
    process.stderr.write(`Error: cannot reach harness server at ${BASE_URL}\n`);
    process.exit(1);
  } else {
    try {
      const parsed = JSON.parse(body);
      process.stderr.write(`Error: ${parsed.error ?? body}\n`);
    } catch {
      process.stderr.write(`Error: HTTP ${status} — ${body}\n`);
    }
    process.exit(1);
  }
}

// =============================================================================
// Argument parser
// =============================================================================

function extractFlag(args: string[], name: string): string | undefined {
  const idx = args.findIndex((a) => a === `--${name}`);
  if (idx !== -1 && idx + 1 < args.length) {
    const val = args[idx + 1];
    args.splice(idx, 2);
    return val;
  }
  return undefined;
}

function extractFlagBool(args: string[], name: string): boolean {
  const idx = args.findIndex((a) => a === `--${name}`);
  if (idx !== -1) {
    args.splice(idx, 1);
    return true;
  }
  return false;
}

// =============================================================================
// CLI entrypoint
// =============================================================================

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);

  if (rawArgs.length === 0) {
    process.stdout.write(`pi-autoresearch — autonomous experiment loop CLI

Usage:
  pi-autoresearch activate "<goal>"
  pi-autoresearch init --name "..." --metric-name "..." [--metric-unit ""] [--direction lower|higher] [--target-value N] [--max-experiments N]
  pi-autoresearch run "<command>" [--timeout 600] [--checks-timeout 300]
  pi-autoresearch log --metric N --status keep|discard|crash|checks_failed --description "..." [--metrics '{"k":v}'] [--asi '{"k":"v"}'] [--force]
  pi-autoresearch status
  pi-autoresearch list
  pi-autoresearch deactivate
  pi-autoresearch clear

  pi-autoresearch --status     Check if harness server is running
  pi-autoresearch --start      Start the harness server
  pi-autoresearch --stop       Stop the harness server
  pi-autoresearch --restart    Restart the harness server
  pi-autoresearch --logs       Follow the server log

Also accepts JSON for programmatic use:
  pi-autoresearch '{ "action": "run", "command": "bash autoresearch.sh" }'

Environment:
  PI_AUTORESEARCH_PORT     Server port (default: 9878)
  PI_AUTORESEARCH_LOG      Log file (default: OS temp directory)
`);
    return;
  }

  const first = rawArgs[0];

  if (first === '--help' || first === '-h') {
    process.argv.splice(2);
    await main();
    return;
  }

  // --- Server management commands ---
  if (first === '--status') {
    const { status, body } = await httpGet(`${BASE_URL}/health`);
    process.stdout.write(status === 200 ? body + '\n' : '{"ok":false,"error":"down"}\n');
    process.exit(status === 200 ? 0 : 1);
  }

  if (first === '--start') {
    await startServer();
    const { body } = await httpGet(`${BASE_URL}/health`);
    process.stdout.write(body + '\n');
    return;
  }

  if (first === '--stop') {
    if (await isUp()) {
      await httpPost(`${BASE_URL}/quit`, '');
      process.stdout.write('{"ok":true,"stopped":true}\n');
    } else {
      process.stdout.write('{"ok":true,"stopped":false,"note":"already down"}\n');
    }
    return;
  }

  if (first === '--restart') {
    if (await isUp()) {
      await httpPost(`${BASE_URL}/quit`, '');
      await new Promise((r) => setTimeout(r, 200));
    }
    await startServer();
    const { body } = await httpGet(`${BASE_URL}/health`);
    process.stdout.write(body + '\n');
    return;
  }

  if (first === '--logs') {
    let offset = 0;
    const printAppended = () => {
      try {
        const size = fs.statSync(LOG).size;
        if (size < offset) offset = 0;
        if (size === offset) return;
        const length = size - offset;
        const buffer = Buffer.alloc(length);
        const fd = fs.openSync(LOG, 'r');
        try {
          fs.readSync(fd, buffer, 0, length, offset);
        } finally {
          fs.closeSync(fd);
        }
        offset = size;
        process.stdout.write(buffer);
      } catch {}
    };
    printAppended();
    fs.watchFile(LOG, { interval: 500 }, printAppended);
    process.on('SIGINT', () => {
      fs.unwatchFile(LOG);
      process.exit(0);
    });
    return;
  }

  // --- JSON passthrough ---
  if (first.startsWith('{')) {
    if (!(await startServer())) process.exit(1);
    await postAction(first);
    return;
  }

  // --- Action subcommands ---
  if (!(await startServer())) process.exit(1);

  const args = [...rawArgs];
  const action = args.shift()!;

  switch (action) {
    case 'activate': {
      const goal = args.join(' ');
      await postAction(JSON.stringify({ action: 'activate', goal: goal || undefined }));
      break;
    }

    case 'init': {
      const name = extractFlag(args, 'name');
      const metricName = extractFlag(args, 'metric-name');
      const metricUnit = extractFlag(args, 'metric-unit');
      const direction = extractFlag(args, 'direction');
      const targetValue = extractFlag(args, 'target-value');
      const maxExperiments = extractFlag(args, 'max-experiments');

      if (!name || !metricName) {
        process.stderr.write('Error: init requires --name and --metric-name.\n');
        process.exit(1);
      }

      await postAction(
        JSON.stringify({
          action: 'init',
          name,
          metric_name: metricName,
          metric_unit: metricUnit || undefined,
          direction: direction || undefined,
          target_value: targetValue ? Number(targetValue) : undefined,
          max_experiments: maxExperiments ? Number(maxExperiments) : undefined,
        })
      );
      break;
    }

    case 'run': {
      const command = args.join(' ');
      const timeout = extractFlag(args, 'timeout');
      const checksTimeout = extractFlag(args, 'checks-timeout');

      if (!command) {
        process.stderr.write('Error: run requires a command.\n');
        process.exit(1);
      }

      await postAction(
        JSON.stringify({
          action: 'run',
          command,
          timeout_seconds: timeout ? Number(timeout) : undefined,
          checks_timeout_seconds: checksTimeout ? Number(checksTimeout) : undefined,
        })
      );
      break;
    }

    case 'log': {
      const metric = extractFlag(args, 'metric');
      const status = extractFlag(args, 'status');
      const description = extractFlag(args, 'description');
      const metricsRaw = extractFlag(args, 'metrics');
      const asiRaw = extractFlag(args, 'asi');
      const force = extractFlagBool(args, 'force');

      if (!metric || !status || !description) {
        process.stderr.write('Error: log requires --metric, --status, and --description.\n');
        process.exit(1);
      }

      const validStatuses = ['keep', 'discard', 'crash', 'checks_failed'];
      if (!validStatuses.includes(status)) {
        process.stderr.write(`Error: --status must be one of: ${validStatuses.join(', ')}\n`);
        process.exit(1);
      }

      let metrics: Record<string, number> | undefined;
      if (metricsRaw) {
        try {
          metrics = JSON.parse(metricsRaw);
        } catch {
          process.stderr.write('Error: --metrics must be valid JSON.\n');
          process.exit(1);
        }
      }

      let asi: Record<string, unknown> | undefined;
      if (asiRaw) {
        try {
          asi = JSON.parse(asiRaw);
        } catch {
          process.stderr.write('Error: --asi must be valid JSON.\n');
          process.exit(1);
        }
      }

      await postAction(
        JSON.stringify({
          action: 'log',
          metric: Number(metric),
          status,
          description,
          metrics,
          asi,
          force: force || undefined,
        })
      );
      break;
    }

    case 'status': {
      await postAction(JSON.stringify({ action: 'status' }));
      break;
    }

    case 'list': {
      await postAction(JSON.stringify({ action: 'list' }));
      break;
    }

    case 'deactivate': {
      await postAction(JSON.stringify({ action: 'deactivate' }));
      break;
    }

    case 'clear': {
      await postAction(JSON.stringify({ action: 'clear' }));
      break;
    }

    default: {
      process.stderr.write(`Unknown command: ${action}. Use --help for usage.\n`);
      process.exit(1);
    }
  }
}

main().catch((err) => {
  process.stderr.write(`pi-autoresearch: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
