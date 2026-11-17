#!/usr/bin/env node
// k6kt — run k6 tests on your laptop or on AWS (K6-KT platform). No dependencies; needs Node 18+ and k6.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir, homedir, platform } from 'node:os';
import { join, basename, resolve } from 'node:path';
import http from 'node:http';

const CONFIG_DIR = join(homedir(), '.k6kt');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const TREND_STATS = 'avg,min,med,max,p(90),p(95),p(99)';

// ---------------- helpers ----------------
const c = process.stdout.isTTY
  ? { g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m` }
  : { g: String, r: String, y: String, d: String, b: String };

function die(msg, code = 2) {
  console.error(c.r(`error: ${msg}`));
  process.exit(code);
}

function loadConfig() {
  let cfg = {};
  if (existsSync(CONFIG_FILE)) cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  if (process.env.K6KT_API) cfg.api = process.env.K6KT_API;
  if (process.env.K6KT_TOKEN) cfg.token = process.env.K6KT_TOKEN;
  return cfg;
}

function parseArgs(argv) {
  const out = { _: [], env: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-e' || a === '--env') out.env.push(argv[++i]);
    else if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) out[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('-') && ['api', 'token', 'runners', 'runner', 'limit', 'file'].includes(k)) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

async function api(cfg, method, path, body) {
  if (!cfg.api || !cfg.token) die('not logged in. Run: k6kt login --api <url> --token <token>');
  let res;
  try {
    res = await fetch(cfg.api.replace(/\/$/, '') + path, {
      method,
      headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    die(`cannot reach the API (${e.cause?.code || e.message})`);
  }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: text }; }
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function upload(url, file, contentType) {
  const res = await fetch(url, { method: 'PUT', body: readFileSync(file), headers: contentType ? { 'content-type': contentType } : {} });
  if (!res.ok) throw new Error(`upload of ${basename(file)} failed: HTTP ${res.status} ${await res.text()}`);
}

function k6Bin() {
  const bin = process.env.K6_BIN || 'k6';
  const r = spawnSync(bin, ['version'], { encoding: 'utf8' });
  if (r.error) die('k6 is not installed (or set K6_BIN). See README.md, "Install k6".');
  return bin;
}

function k6(args, opts = {}) {
  const r = spawnSync(k6Bin(), args, { encoding: 'utf8', ...opts });
  if (r.status !== 0) die(`k6 ${args[0]} failed:\n${r.stderr || r.stdout}`);
  return r.stdout;
}

/** Parse a Go duration like "1h2m3.5s", "50s", "500ms". */
function parseGoDuration(s) {
  let total = 0;
  for (const [, n, u] of String(s).matchAll(/([\d.]+)(h|ms|m|s|us|µs|ns)/g)) {
    total += Number(n) * { h: 3600, m: 60, s: 1, ms: 1e-3, us: 1e-6, 'µs': 1e-6, ns: 1e-9 }[u];
  }
  return Math.ceil(total);
}

const fmtMs = (v) => (v == null ? '-' : v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${v.toFixed(0)}ms`);
const fmtPct = (v) => (v == null ? '-' : `${(v * 100).toFixed(2)}%`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const statusColor = (s) => (s === 'passed' ? c.g(s) : ['failed', 'error'].includes(s) ? c.r(s) : s === 'stopped' ? c.y(s) : s);

function openInBrowser(url) {
  const cmd = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform() === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch { /* no browser available: the link is printed anyway */ }
}

/** Build a k6 archive (bundles imports, options and -e values) and read its VUs and duration. */
function buildArchive(script, env, dir) {
  if (!existsSync(script)) die(`script not found: ${script}`);
  const archive = join(dir, 'archive.tar');
  const envArgs = env.flatMap((kv) => ['-e', kv]);
  k6(['archive', ...envArgs, script, '-O', archive]);
  const req = JSON.parse(k6(['inspect', '--execution-requirements', archive]));
  return { archive, maxVUs: req.maxVUs || 1, durationSec: parseGoDuration(req.totalDuration || '0s') };
}

function printResult(run) {
  const r = run.result || {};
  console.log('');
  console.log(`  ${c.b('Result:')}     ${statusColor(run.status)}${run.error ? c.d(`  (${run.error})`) : ''}`);
  if (run.result) {
    console.log(`  Requests:   ${r.requests} (${(r.rps || 0).toFixed(1)}/s), failed ${fmtPct(r.errorRate)}`);
    console.log(`  Latency:    avg ${fmtMs(r.avgMs)}  p90 ${fmtMs(r.p90Ms)}  p95 ${fmtMs(r.p95Ms)}  p99 ${fmtMs(r.p99Ms)}  max ${fmtMs(r.maxMs)}`);
    if (r.checksPassed + r.checksFailed > 0) console.log(`  Checks:     ${fmtPct(r.checksRate)} passed (${r.checksFailed} failed)`);
    if ((r.runners || []).length > 1) {
      console.log(`  Runners:    ${r.runners.map((x) => `#${x.runner} ${x.outcome}, p95 ${fmtMs(x.p95Ms)}`).join(' | ')}`);
      console.log(c.d('              (p90/p95/p99/max show the worst runner)'));
    }
  }
}

async function printReportLink(cfg, id) {
  try {
    const { url, runners } = await api(cfg, 'GET', `/runs/${id}/report`);
    console.log(`  Report:     ${url}`);
    console.log(c.d(`              link valid 1 hour; get a fresh one any time with: k6kt open ${id}${runners > 1 ? ` [--runner 1..${runners}]` : ''}`));
  } catch (e) {
    console.log(c.d(`  Report:     ${e.message}`));
  }
}

// ---------------- commands ----------------
async function cmdLogin(args) {
  const apiUrl = args.api || process.env.K6KT_API;
  const token = args.token || process.env.K6KT_TOKEN;
  if (!apiUrl || !token) die('usage: k6kt login --api <url> --token <token>');
  const me = await api({ api: apiUrl, token }, 'GET', '/whoami').catch((e) => die(e.message));
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_FILE, JSON.stringify({ api: apiUrl, token }, null, 2), { mode: 0o600 });
  const p = me.project;
  console.log(c.g(`Logged in to project "${p.name}" as token "${me.token}".`));
  console.log(c.d(`Limits: ${p.maxVus} VUs, ${p.maxMinutes} min/test, ${p.maxConcurrent} cloud runs at once, ${p.maxVuHoursMonth || '∞'} VU-hours/month`));
}

async function cmdRun(args) {
  const cfg = loadConfig();
  const script = args._[1];
  if (!script) die('usage: k6kt run <script.js> [--local | --cloud] [-e KEY=VALUE] [--spot] [--runners N]');
  const mode = args.local ? 'local' : 'cloud';
  const dir = mkdtempSync(join(tmpdir(), 'k6kt-'));
  try {
    const { archive, maxVUs, durationSec } = buildArchive(resolve(script), args.env, dir);
    const created = await api(cfg, 'POST', '/runs', {
      mode, scriptName: basename(script), maxVUs, durationSec,
      spot: Boolean(args.spot), runners: args.runners ? Number(args.runners) : undefined,
    }).catch((e) => die(e.message));
    const id = created.runId;
    await upload(created.uploads.archive, archive);
    console.log(`${c.b('Run')} ${id}  ${basename(script)}  ${maxVUs} VUs, up to ${Math.ceil(durationSec / 60)} min  [${mode}${args.spot ? ', spot' : ''}]`);
    const code = mode === 'local' ? await runLocal(cfg, id, archive, dir, args) : await runCloud(cfg, id, args);
    process.exitCode = code;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const DASHBOARD_PORT = 5665; // what the browser opens (our proxy)
const K6_DASHBOARD_PORT = 5667; // k6's own dashboard, behind the proxy
const K6_REST = '127.0.0.1:6575'; // not 6566: fetch() blocks that port
const debug = (...m) => process.env.K6KT_DEBUG && console.error('[k6kt debug]', ...m);

/**
 * Tiny proxy in front of k6's dashboard. k6 v2 keeps running after the test while a
 * browser is still connected to the dashboard, and only writes its summary on exit.
 * Closing the proxied connections when the test ends lets k6 exit on its own.
 */
function startDashboardProxy() {
  const open = new Set();
  const track = (x) => { open.add(x); x.on('close', () => open.delete(x)); };
  const server = http.createServer((req, res) => {
    const up = http.request(
      { host: '127.0.0.1', port: K6_DASHBOARD_PORT, path: req.url, method: req.method, headers: req.headers },
      (ur) => { res.writeHead(ur.statusCode, ur.headers); ur.pipe(res); },
    );
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    track(up);
    req.pipe(up);
  });
  server.on('connection', track);
  return new Promise((resolve) => {
    server.once('error', () => resolve(null)); // port busy: no proxy, dashboard still on K6_DASHBOARD_PORT
    server.listen(DASHBOARD_PORT, '127.0.0.1', () => resolve({
      close() { debug('proxy close, open conns:', open.size); for (const x of open) x.destroy(); server.close(); },
    }));
  });
}

/** Resolves when k6's test is over (REST API says not running, or goes away after being up). */
async function waitForTestEnd(k6Exited) {
  let seenRunning = false;
  while (!k6Exited()) {
    await sleep(2000);
    try {
      const r = await fetch(`http://${K6_REST}/v1/status`, { signal: AbortSignal.timeout(1500) });
      const a = (await r.json()).data?.attributes || {};
      debug('status', JSON.stringify(a));
      if (a.running) seenRunning = true;
      else if (seenRunning) return;
    } catch (e) {
      debug('status error', e.message, e.cause?.code, e.cause?.message);
      if (seenRunning) return;
    }
  }
}

async function runLocal(cfg, id, archive, dir, args) {
  const summary = join(dir, 'summary.json');
  const report = join(dir, 'report.html');
  const proxy = await startDashboardProxy();
  const dashUrl = `http://127.0.0.1:${proxy ? DASHBOARD_PORT : K6_DASHBOARD_PORT}`;
  console.log(c.d(`Live dashboard: ${dashUrl} (opens in your browser)`));
  const env = {
    ...process.env,
    K6_WEB_DASHBOARD: 'true',
    K6_WEB_DASHBOARD_HOST: '127.0.0.1',
    K6_WEB_DASHBOARD_PORT: String(K6_DASHBOARD_PORT),
    K6_WEB_DASHBOARD_EXPORT: report,
    // We open the browser ourselves so Chrome's own log noise stays out of the terminal.
    K6_WEB_DASHBOARD_OPEN: 'false',
  };
  if (!args['no-browser']) setTimeout(() => openInBrowser(dashUrl), 2000).unref();

  // Ctrl+C goes to k6 (it stops the test gracefully and still writes the summary).
  // We keep running until the results are saved.
  let interrupts = 0;
  const onSig = () => {
    interrupts += 1;
    if (interrupts === 1) console.log(c.y('\nStopping the test... results will still be saved.'));
    if (interrupts >= 3) process.exit(130);
  };
  process.on('SIGINT', onSig);

  let exited = false;
  const k6proc = spawn(k6Bin(), [
    'run', '--address', K6_REST, '--summary-trend-stats', TREND_STATS, '--summary-export', summary, archive,
  ], { stdio: 'inherit', env });
  const code = new Promise((res) => k6proc.on('exit', (c2) => { exited = true; res(c2 ?? 1); }));

  // When the test is over, disconnect the browser so k6 can finish and write its summary.
  waitForTestEnd(() => exited).then(async () => {
    await sleep(3000); // let the dashboard send its final numbers
    proxy?.close();
  });
  const exitCode = await code;
  proxy?.close();

  console.log(c.d('Saving results...'));
  try {
    const urls = await api(cfg, 'POST', `/runs/${id}/uploads`);
    if (existsSync(summary)) await upload(urls.summary, summary);
    if (existsSync(report)) await upload(urls.report, report);
    else console.log(c.d('(k6 skips the HTML report for runs shorter than ~30s)'));
    const run = await api(cfg, 'POST', `/runs/${id}/finish`, { exitCode });
    printResult(run);
    if (existsSync(report)) await printReportLink(cfg, id);
    return run.status === 'passed' ? 0 : 1;
  } finally {
    process.off('SIGINT', onSig);
  }
}

async function runCloud(cfg, id, args) {
  await api(cfg, 'POST', `/runs/${id}/start`).catch((e) => die(e.message));
  if (args['no-wait']) {
    console.log(`Started. Follow it with: k6kt status ${id}`);
    return 0;
  }
  let stopping = false;
  process.on('SIGINT', async () => {
    if (stopping) process.exit(130);
    stopping = true;
    console.log(c.y('\nStopping the run on AWS... (Ctrl+C again to leave it running)'));
    await api(cfg, 'POST', `/runs/${id}/stop`).catch(() => {});
  });

  const started = Date.now();
  let lastStatus = '';
  let prev = null;
  for (;;) {
    await sleep(lastStatus ? 10000 : 3000);
    let run;
    try { run = await api(cfg, 'GET', `/runs/${id}`); } catch (e) { console.log(c.d(`  (poll failed: ${e.message})`)); continue; }
    const el = `${Math.floor((Date.now() - started) / 60000)}m${String(Math.floor(((Date.now() - started) / 1000) % 60)).padStart(2, '0')}s`;
    if (run.status !== lastStatus) {
      const extra = run.runners ? ` — ${run.runners} × ${run.runnerSize} runner(s)` : '';
      console.log(`  ${c.d(el)}  ${statusColor(run.status)}${extra}`);
      lastStatus = run.status;
    }
    const prog = (run.progress || []).filter(Boolean);
    if (prog.length) {
      const running = prog.filter((p) => p.phase === 'running');
      if (running.length) {
        const vus = running.reduce((a, p) => a + (p.vus || 0), 0);
        const reqs = running.reduce((a, p) => a + (p.requests || 0), 0);
        const p95 = Math.max(...running.map((p) => p.p95Ms ?? 0));
        const fails = running.reduce((a, p) => a + (p.failedRate || 0) * (p.requests || 0), 0);
        const t = Date.now();
        const rps = prev ? ((reqs - prev.reqs) / ((t - prev.t) / 1000)).toFixed(1) : '-';
        prev = { reqs, t };
        console.log(`  ${c.d(el)}  VUs ${vus}  req/s ${rps}  requests ${reqs}  p95 ${fmtMs(p95)}  errors ${fmtPct(reqs ? fails / reqs : 0)}  ${c.d(`(${running.length}/${run.runners} runners reporting)`)}`);
      } else {
        const ready = prog.filter((p) => p.phase === 'ready').length;
        if (ready) console.log(`  ${c.d(el)}  ${ready}/${run.runners} runner(s) ready${run.runners > 1 ? ', waiting for the shared start' : ', starting k6'}`);
      }
    }
    if (['passed', 'failed', 'error', 'stopped'].includes(run.status)) {
      printResult(run);
      if (run.result) await printReportLink(cfg, id);
      return run.status === 'passed' ? 0 : 1;
    }
  }
}

async function cmdList(args) {
  const cfg = loadConfig();
  const { runs } = await api(cfg, 'GET', `/runs?limit=${args.limit || 20}`).catch((e) => die(e.message));
  if (!runs.length) return console.log('No runs yet.');
  const rows = runs.map((r) => [
    r.id, (r.createdAt || '').replace('T', ' ').slice(0, 16), r.mode, r.scriptName, String(r.maxVUs),
    r.result ? fmtMs(r.result.p95Ms) : '-', r.result ? fmtPct(r.result.errorRate) : '-', r.status,
  ]);
  const head = ['RUN', 'CREATED (UTC)', 'MODE', 'SCRIPT', 'VUS', 'P95', 'ERRORS', 'STATUS'];
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  console.log(c.b(head.map((h, i) => h.padEnd(w[i])).join('  ')));
  for (const r of rows) console.log(r.map((v, i) => (i === 7 ? statusColor(v) : v.padEnd(w[i]))).join('  '));
}

async function cmdStatus(args) {
  const cfg = loadConfig();
  const id = args._[1] || die('usage: k6kt status <run-id>');
  const run = await api(cfg, 'GET', `/runs/${id}`).catch((e) => die(e.message));
  console.log(`${c.b('Run')} ${run.id}  ${run.scriptName}  ${run.maxVUs} VUs  [${run.mode}]  by ${run.createdBy}  ${run.createdAt}`);
  if (run.runners) console.log(`  Runners:    ${run.runners} × ${run.runnerSize}${run.spot ? ' (spot)' : ''}`);
  if (run.progress) console.log(`  Progress:   ${JSON.stringify(run.progress)}`);
  printResult(run);
  if (args.json) console.log(JSON.stringify(run, null, 2));
}

async function cmdOpen(args) {
  const cfg = loadConfig();
  const id = args._[1] || die('usage: k6kt open <run-id> [--runner N] [--file report|summary|result]');
  const q = new URLSearchParams({ runner: args.runner || '1', file: args.file || 'report' });
  const { url } = await api(cfg, 'GET', `/runs/${id}/report?${q}`).catch((e) => die(e.message));
  console.log(url);
  openInBrowser(url);
}

async function cmdStop(args) {
  const cfg = loadConfig();
  const id = args._[1] || die('usage: k6kt stop <run-id>');
  const run = await api(cfg, 'POST', `/runs/${id}/stop`).catch((e) => die(e.message));
  console.log(`${run.id}: ${statusColor(run.status)}`);
}

const HELP = `k6kt — run k6 load tests on your laptop or on AWS

  k6kt login --api <url> --token <token>     save your API address and token
  k6kt run <test.js> --local                 run on this machine (live dashboard), save results centrally
  k6kt run <test.js> --cloud                 run on AWS runners and follow progress
        -e KEY=VALUE                         value for __ENV.KEY (repeatable)
        --spot                               use Fargate Spot (cheaper, may be interrupted)
        --runners N                          split the test across N runners
        --no-wait                            start and return immediately
  k6kt list [--limit N]                      recent runs
  k6kt status <run-id> [--json]              status and result of one run
  k6kt open <run-id> [--runner N]            open the HTML report (fresh 1-hour link)
  k6kt stop <run-id>                         stop a run

Exit code: 0 when the run passed, 1 when it failed (thresholds, errors), 2 on usage errors.
Env: K6KT_API / K6KT_TOKEN override the saved login (useful in CI). K6_BIN = path to k6.`;

const args = parseArgs(process.argv.slice(2));
const commands = { login: cmdLogin, run: cmdRun, list: cmdList, ls: cmdList, status: cmdStatus, open: cmdOpen, stop: cmdStop };
const fn = commands[args._[0]];
if (!fn || args.help) {
  console.log(HELP);
  process.exit(fn || args.help ? 0 : 2);
}
fn(args).catch((e) => die(e.message));
