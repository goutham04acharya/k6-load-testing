// loadtest: run k6 tests on your laptop or on AWS (Load Testing k6). Needs Node 18+ and k6.
import { spawn, spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { homedir, platform, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { Progress, Run } from '../lib/types.ts';

const APP = 'Load Testing k6';
const CMD = 'loadtest';
const CONFIG_DIR = join(homedir(), '.load-testing-k6');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const TREND_STATS = 'avg,min,med,max,p(90),p(95),p(99)';
const DASHBOARD_PORT = 5665; // what the browser opens (our proxy)
const K6_DASHBOARD_PORT = 5667; // k6's own dashboard, behind the proxy
const K6_REST = '127.0.0.1:6575'; // not 6566: fetch() refuses that port

interface Config { api?: string; token?: string }
interface Args { _: string[]; env: string[]; [flag: string]: string | boolean | string[] }
type PublicRun = Omit<Run, 'pk' | 'gsi1pk' | 'gsi1sk' | 'executionArn' | 'shareKey'> & { progress?: (Progress | null)[] };

// ---------------- helpers ----------------
const tty = process.stdout.isTTY;
const paint = (code: number) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = { g: paint(32), r: paint(31), y: paint(33), d: paint(2), b: paint(1) };

function die(msg: string, code = 2): never {
  console.error(c.r(`error: ${msg}`));
  process.exit(code);
}

function loadConfig(): Config {
  const cfg: Config = existsSync(CONFIG_FILE) ? JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) : {};
  if (process.env.LOADTEST_API) cfg.api = process.env.LOADTEST_API;
  if (process.env.LOADTEST_TOKEN) cfg.token = process.env.LOADTEST_TOKEN;
  return cfg;
}

const VALUE_FLAGS = ['api', 'token', 'runners', 'runner', 'limit', 'file'];
function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], env: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-e' || a === '--env') out.env.push(argv[++i]);
    else if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) out[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('-') && VALUE_FLAGS.includes(k)) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}
const flag = (args: Args, k: string) => (typeof args[k] === 'string' ? (args[k] as string) : undefined);

async function api<T>(cfg: Config, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  if (!cfg.api || !cfg.token) die(`not logged in. Run: ${CMD} login --api <url> --token <token>`);
  let res: Response;
  try {
    res = await fetch(cfg.api.replace(/\/$/, '') + path, {
      method,
      headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    die(`cannot reach the API (${err.cause?.code ?? err.message})`);
  }
  const text = await res.text();
  let data: { error?: string };
  try { data = JSON.parse(text); } catch { data = { error: text }; }
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data as T;
}

async function upload(url: string, file: string) {
  const res = await fetch(url, { method: 'PUT', body: readFileSync(file) });
  if (!res.ok) throw new Error(`upload of ${basename(file)} failed: HTTP ${res.status} ${await res.text()}`);
}

function k6Bin(): string {
  const bin = process.env.K6_BIN ?? 'k6';
  if (spawnSync(bin, ['version'], { encoding: 'utf8' }).error) die('k6 is not installed (or set K6_BIN). See README.md, "Install k6".');
  return bin;
}

function k6(args: string[], opts: SpawnSyncOptions = {}): string {
  const r = spawnSync(k6Bin(), args, { encoding: 'utf8', ...opts });
  if (r.status !== 0) die(`k6 ${args[0]} failed:\n${r.stderr || r.stdout}`);
  return String(r.stdout);
}

/** Parse a Go duration like "1h2m3.5s", "50s", "500ms". */
export function parseGoDuration(s: string): number {
  const unit: Record<string, number> = { h: 3600, m: 60, s: 1, ms: 1e-3, us: 1e-6, 'µs': 1e-6, ns: 1e-9 };
  let total = 0;
  for (const [, n, u] of String(s).matchAll(/([\d.]+)(h|ms|m|s|us|µs|ns)/g)) total += Number(n) * unit[u];
  return Math.ceil(total);
}

const fmtMs = (v?: number | null) => (v == null ? '-' : v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${v.toFixed(0)}ms`);
const fmtPct = (v?: number | null) => (v == null ? '-' : `${(v * 100).toFixed(2)}%`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const statusColor = (s: string) => (s === 'passed' ? c.g(s) : s === 'failed' || s === 'error' ? c.r(s) : s === 'stopped' ? c.y(s) : s);
const FINISHED = ['passed', 'failed', 'error', 'stopped'];

function openInBrowser(url: string) {
  const cmd = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform() === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
  } catch { /* no browser available: the link is printed anyway */ }
}

/** Build a k6 archive (bundles imports, options and -e values) and read its users and duration. */
function buildArchive(script: string, env: string[], dir: string) {
  if (!existsSync(script)) die(`script not found: ${script}`);
  const archive = join(dir, 'archive.tar');
  k6(['archive', ...env.flatMap((kv) => ['-e', kv]), script, '-O', archive]);
  const req = JSON.parse(k6(['inspect', '--execution-requirements', archive])) as { maxVUs?: number; totalDuration?: string };
  return { archive, maxVUs: req.maxVUs || 1, durationSec: parseGoDuration(req.totalDuration ?? '0s') };
}

function printResult(run: PublicRun) {
  const r = run.result;
  console.log('');
  console.log(`  ${c.b('Result:')}     ${statusColor(run.status)}${run.error ? c.d(`  (${run.error})`) : ''}`);
  if (!r) return;
  console.log(`  Requests:   ${r.requests} (${(r.rps || 0).toFixed(1)}/s), failed ${fmtPct(r.errorRate)}`);
  console.log(`  Latency:    avg ${fmtMs(r.avgMs)}  p90 ${fmtMs(r.p90Ms)}  p95 ${fmtMs(r.p95Ms)}  p99 ${fmtMs(r.p99Ms)}  max ${fmtMs(r.maxMs)}`);
  if (r.checksPassed + r.checksFailed > 0) console.log(`  Checks:     ${fmtPct(r.checksRate)} passed (${r.checksFailed} failed)`);
  for (const e of r.endpoints ?? []) console.log(c.d(`  · ${e.name}: ${e.requests} req, p95 ${fmtMs(e.p95Ms)}, errors ${fmtPct(e.errorRate)}`));
  if ((r.runners ?? []).length > 1) {
    console.log(`  Machines:   ${r.runners!.map((x) => `#${x.runner} ${x.outcome}, p95 ${fmtMs(x.p95Ms)}`).join(' | ')}`);
    console.log(c.d('              (p90/p95/p99/max show the slowest machine)'));
  }
}

async function printReportLink(cfg: Config, id: string, args: Args) {
  try {
    const { shareUrl, runners } = await api<{ shareUrl: string; runners: number }>(cfg, 'GET', `/runs/${id}/link`);
    console.log(`  Report:     ${c.b(shareUrl)}`);
    console.log(c.d(`              permanent link, anyone with it can view${runners > 1 ? ` (add ?runner=1..${runners} for one machine)` : ''}. Open it any time: ${CMD} open ${id}`));
    if (args.open) openInBrowser(shareUrl);
  } catch (e) {
    console.log(c.d(`  Report:     ${(e as Error).message}`));
  }
}

// ---------------- local runs: live dashboard behind a small proxy ----------------

/**
 * k6 v2 keeps running after the test while a browser is connected to its dashboard and only
 * writes its summary on exit. Closing the proxied connections when the test ends lets k6 exit.
 */
function startDashboardProxy(): Promise<{ close(): void } | null> {
  const open = new Set<{ destroy(): void; on(e: 'close', f: () => void): unknown }>();
  const track = (x: { destroy(): void; on(e: 'close', f: () => void): unknown }) => { open.add(x); x.on('close', () => open.delete(x)); };
  const server = http.createServer((req, res) => {
    const up = http.request(
      { host: '127.0.0.1', port: K6_DASHBOARD_PORT, path: req.url, method: req.method, headers: req.headers },
      (ur) => { res.writeHead(ur.statusCode ?? 502, ur.headers); ur.pipe(res); },
    );
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    track(up);
    req.pipe(up);
  });
  server.on('connection', track);
  return new Promise((done) => {
    server.once('error', () => done(null)); // port busy: no proxy, dashboard still on K6_DASHBOARD_PORT
    server.listen(DASHBOARD_PORT, '127.0.0.1', () => done({ close() { for (const x of open) x.destroy(); server.close(); } }));
  });
}

/** Resolves when k6's test is over (status API says not running, or goes away after being up). */
async function waitForTestEnd(k6Exited: () => boolean) {
  let seenRunning = false;
  while (!k6Exited()) {
    await sleep(2000);
    try {
      const r = await fetch(`http://${K6_REST}/v1/status`, { signal: AbortSignal.timeout(1500) });
      const a = ((await r.json()) as { data?: { attributes?: { running?: boolean } } }).data?.attributes ?? {};
      if (a.running) seenRunning = true;
      else if (seenRunning) return;
    } catch {
      if (seenRunning) return;
    }
  }
}

async function runLocal(cfg: Config, id: string, archive: string, dir: string, args: Args): Promise<number> {
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
    K6_WEB_DASHBOARD_OPEN: 'false', // we open it ourselves, keeping browser log noise out of the terminal
  };
  if (!args['no-browser']) setTimeout(() => openInBrowser(dashUrl), 2000).unref();

  // Ctrl+C goes to k6 (it stops gracefully and still writes the summary); we keep going to save results.
  let interrupts = 0;
  const onSig = () => {
    interrupts += 1;
    if (interrupts === 1) console.log(c.y('\nStopping the test... results will still be saved.'));
    if (interrupts >= 3) process.exit(130);
  };
  process.on('SIGINT', onSig);

  let exited = false;
  const k6proc = spawn(k6Bin(), ['run', '--address', K6_REST, '--summary-trend-stats', TREND_STATS, '--summary-export', summary, archive], { stdio: 'inherit', env });
  const code = new Promise<number>((done) => k6proc.on('exit', (c2) => { exited = true; done(c2 ?? 1); }));
  void waitForTestEnd(() => exited).then(async () => {
    await sleep(3000); // let the dashboard send its final numbers
    proxy?.close();
  });
  const exitCode = await code;
  proxy?.close();

  console.log(c.d('Saving results...'));
  try {
    const urls = await api<{ summary: string; report: string }>(cfg, 'POST', `/runs/${id}/uploads`);
    if (existsSync(summary)) await upload(urls.summary, summary);
    if (existsSync(report)) await upload(urls.report, report);
    else console.log(c.d('(k6 skips the HTML report for runs shorter than ~30s)'));
    const run = await api<PublicRun>(cfg, 'POST', `/runs/${id}/finish`, { exitCode });
    printResult(run);
    await printReportLink(cfg, id, args);
    return run.status === 'passed' ? 0 : 1;
  } finally {
    process.off('SIGINT', onSig);
  }
}

async function runCloud(cfg: Config, id: string, args: Args): Promise<number> {
  await api(cfg, 'POST', `/runs/${id}/start`).catch((e: Error) => die(e.message));
  if (args['no-wait']) {
    console.log(`Started. Follow it with: ${CMD} status ${id}`);
    return 0;
  }
  let stopping = false;
  process.on('SIGINT', async () => {
    if (stopping) process.exit(130);
    stopping = true;
    console.log(c.y('\nStopping the run on AWS... (Ctrl+C again to leave it running)'));
    await api(cfg, 'POST', `/runs/${id}/stop`).catch(() => undefined);
  });

  const started = Date.now();
  let lastStatus = '';
  let prev: { reqs: number; t: number } | null = null;
  for (;;) {
    await sleep(lastStatus ? 10000 : 3000);
    let run: PublicRun;
    try { run = await api<PublicRun>(cfg, 'GET', `/runs/${id}`); } catch (e) { console.log(c.d(`  (poll failed: ${(e as Error).message})`)); continue; }
    const secs = Math.floor((Date.now() - started) / 1000);
    const el = `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, '0')}s`;
    if (run.status !== lastStatus) {
      console.log(`  ${c.d(el)}  ${statusColor(run.status)}${run.runners ? ` — ${run.runners} × ${run.runnerSize} machine(s)` : ''}`);
      lastStatus = run.status;
    }
    const prog = (run.progress ?? []).filter((p): p is Progress => p != null);
    const running = prog.filter((p) => p.phase === 'running');
    if (running.length) {
      const vus = running.reduce((a, p) => a + (p.vus ?? 0), 0);
      const reqs = running.reduce((a, p) => a + (p.requests ?? 0), 0);
      const p95 = Math.max(...running.map((p) => p.p95Ms ?? 0));
      const fails = running.reduce((a, p) => a + (p.failedRate ?? 0) * (p.requests ?? 0), 0);
      const t = Date.now();
      const rps = prev ? ((reqs - prev.reqs) / ((t - prev.t) / 1000)).toFixed(1) : '-';
      prev = { reqs, t };
      console.log(`  ${c.d(el)}  users ${vus}  req/s ${rps}  requests ${reqs}  p95 ${fmtMs(p95)}  errors ${fmtPct(reqs ? fails / reqs : 0)}  ${c.d(`(${running.length}/${run.runners} machines reporting)`)}`);
    } else {
      const ready = prog.filter((p) => p.phase === 'ready').length;
      if (ready) console.log(`  ${c.d(el)}  ${ready}/${run.runners} machine(s) ready${(run.runners ?? 1) > 1 ? ', waiting for the shared start' : ', starting k6'}`);
    }
    if (FINISHED.includes(run.status)) {
      printResult(run);
      if (run.result) await printReportLink(cfg, id, args);
      return run.status === 'passed' ? 0 : 1;
    }
  }
}

// ---------------- commands ----------------
async function cmdLogin(args: Args) {
  const apiUrl = flag(args, 'api') ?? process.env.LOADTEST_API;
  const token = flag(args, 'token') ?? process.env.LOADTEST_TOKEN;
  if (!apiUrl || !token) die(`usage: ${CMD} login --api <url> --token <token>`);
  const me = await api<{ token: string; project: { name: string; maxVus: number; maxMinutes: number; maxConcurrent: number; maxVuHoursMonth?: number } }>(
    { api: apiUrl, token }, 'GET', '/whoami',
  ).catch((e: Error) => die(e.message));
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_FILE, JSON.stringify({ api: apiUrl, token }, null, 2), { mode: 0o600 });
  const p = me.project;
  console.log(c.g(`Logged in to project "${p.name}" as token "${me.token}".`));
  console.log(c.d(`Limits: ${p.maxVus} users, ${p.maxMinutes} min/test, ${p.maxConcurrent} cloud runs at once, ${p.maxVuHoursMonth ?? '∞'} VU-hours/month`));
}

async function cmdRun(args: Args) {
  const cfg = loadConfig();
  const script = args._[1];
  if (!script) die(`usage: ${CMD} run <script.js> [--local | --cloud] [-e KEY=VALUE] [--spot] [--runners N]`);
  const mode = args.local ? 'local' : 'cloud';
  const dir = mkdtempSync(join(tmpdir(), 'load-testing-k6-'));
  try {
    const { archive, maxVUs, durationSec } = buildArchive(resolve(script), args.env, dir);
    const created = await api<{ runId: string; uploads: { archive: string } }>(cfg, 'POST', '/runs', {
      mode, scriptName: basename(script), maxVUs, durationSec,
      spot: Boolean(args.spot), runners: flag(args, 'runners') ? Number(flag(args, 'runners')) : undefined,
    }).catch((e: Error) => die(e.message));
    const id = created.runId;
    await upload(created.uploads.archive, archive);
    console.log(`${c.b('Run')} ${id}  ${basename(script)}  ${maxVUs} users, up to ${Math.ceil(durationSec / 60)} min  [${mode}${args.spot ? ', spot' : ''}]`);
    process.exitCode = mode === 'local' ? await runLocal(cfg, id, archive, dir, args) : await runCloud(cfg, id, args);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function cmdList(args: Args) {
  const cfg = loadConfig();
  const { runs } = await api<{ runs: PublicRun[] }>(cfg, 'GET', `/runs?limit=${flag(args, 'limit') ?? 20}`).catch((e: Error) => die(e.message));
  if (!runs.length) return console.log('No runs yet.');
  const rows = runs.map((r) => [
    r.id, (r.createdAt ?? '').replace('T', ' ').slice(0, 16), r.mode, r.scriptName, String(r.maxVUs),
    r.result ? fmtMs(r.result.p95Ms) : '-', r.result ? fmtPct(r.result.errorRate) : '-', r.status,
  ]);
  const head = ['RUN', 'CREATED (UTC)', 'MODE', 'TEST', 'USERS', 'P95', 'ERRORS', 'STATUS'];
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  console.log(c.b(head.map((h, i) => h.padEnd(w[i])).join('  ')));
  for (const r of rows) console.log(r.map((v, i) => (i === 7 ? statusColor(v) : v.padEnd(w[i]))).join('  '));
}

async function cmdStatus(args: Args) {
  const cfg = loadConfig();
  const id = args._[1] ?? die(`usage: ${CMD} status <run-id>`);
  const run = await api<PublicRun>(cfg, 'GET', `/runs/${id}`).catch((e: Error) => die(e.message));
  console.log(`${c.b('Run')} ${run.id}  ${run.scriptName}  ${run.maxVUs} users  [${run.mode}]  by ${run.createdBy}  ${run.createdAt}`);
  if (run.runners) console.log(`  Machines:   ${run.runners} × ${run.runnerSize}${run.spot ? ' (spot)' : ''}`);
  if (run.progress) console.log(`  Progress:   ${JSON.stringify(run.progress)}`);
  printResult(run);
  if (args.json) console.log(JSON.stringify(run, null, 2));
}

/** Run id from the command line, or the newest run when none is given. */
async function runIdOrLatest(cfg: Config, args: Args): Promise<string> {
  if (args._[1]) return args._[1];
  const { runs } = await api<{ runs: PublicRun[] }>(cfg, 'GET', '/runs?limit=1').catch((e: Error) => die(e.message));
  if (!runs.length) die('no runs yet');
  console.log(c.d(`latest run: ${runs[0].id} (${runs[0].scriptName}, ${runs[0].status})`));
  return runs[0].id;
}

async function cmdOpen(args: Args) {
  const cfg = loadConfig();
  const id = await runIdOrLatest(cfg, args);
  const file = flag(args, 'file');
  if (file && file !== 'report') {
    const q = new URLSearchParams({ runner: flag(args, 'runner') ?? '1', file });
    const { url } = await api<{ url: string }>(cfg, 'GET', `/runs/${id}/report?${q}`).catch((e: Error) => die(e.message));
    console.log(url);
    return openInBrowser(url);
  }
  const { shareUrl } = await api<{ shareUrl: string }>(cfg, 'GET', `/runs/${id}/link`).catch((e: Error) => die(e.message));
  const url = flag(args, 'runner') ? `${shareUrl}?runner=${flag(args, 'runner')}` : shareUrl;
  console.log(url);
  openInBrowser(url);
}

async function cmdLink(args: Args) {
  const cfg = loadConfig();
  const id = await runIdOrLatest(cfg, args);
  const { shareUrl } = await api<{ shareUrl: string }>(cfg, 'GET', `/runs/${id}/link`).catch((e: Error) => die(e.message));
  console.log(shareUrl);
}

async function cmdStop(args: Args) {
  const cfg = loadConfig();
  const id = args._[1] ?? die(`usage: ${CMD} stop <run-id>`);
  const run = await api<PublicRun>(cfg, 'POST', `/runs/${id}/stop`).catch((e: Error) => die(e.message));
  console.log(`${run.id}: ${statusColor(run.status)}`);
}

const HELP = `${CMD} — ${APP}: run k6 load tests on your laptop or on AWS

  ${CMD} login --api <url> --token <token>     save your API address and token
  ${CMD} run <test.js> --local                 run on this machine (live dashboard), save results centrally
  ${CMD} run <test.js> --cloud                 run on AWS machines and follow progress
        -e KEY=VALUE                           value for __ENV.KEY (repeatable)
        --spot                                 use Fargate Spot (cheaper, may be interrupted)
        --runners N                            split the test across N machines
        --no-wait                              start and return immediately
        --open                                 open the report in your browser when the run ends
  ${CMD} list [--limit N]                      recent runs
  ${CMD} status <run-id> [--json]              status and result of one run
  ${CMD} open [run-id] [--runner N]            open the report (newest run if no id)
  ${CMD} link [run-id]                         print the permanent share link (newest run if no id)
  ${CMD} stop <run-id>                         stop a run

Exit code: 0 when the run passed, 1 when it failed (thresholds, errors), 2 on usage errors.
Env: LOADTEST_API / LOADTEST_TOKEN override the saved login (useful in CI). K6_BIN = path to k6.`;

const commands: Record<string, (a: Args) => Promise<unknown>> = {
  login: cmdLogin, run: cmdRun, list: cmdList, ls: cmdList, status: cmdStatus, open: cmdOpen, link: cmdLink, stop: cmdStop,
};

const args = parseArgs(process.argv.slice(2));
const fn: ((a: Args) => Promise<unknown>) | undefined = commands[args._[0]];
if (!fn || args.help) {
  console.log(HELP);
  process.exit(args.help ? 0 : 2);
}
fn(args).catch((e: Error) => die(e.message));
