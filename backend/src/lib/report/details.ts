// Thresholds, checks and timing breakdown for one run, combined over all runners.
import { readJson, runPrefix } from '../store.ts';
import type { K6Group, K6Summary, Run } from '../types.ts';

export const TIMINGS: [string, string][] = [
  ['http_req_blocked', 'Waiting for a free connection'],
  ['http_req_connecting', 'TCP connect'],
  ['http_req_tls_handshaking', 'TLS handshake'],
  ['http_req_sending', 'Sending request'],
  ['http_req_waiting', 'Waiting for server (TTFB)'],
  ['http_req_receiving', 'Receiving response'],
  ['http_req_duration', 'Total request time'],
  ['iteration_duration', 'One full iteration'],
];

export interface Threshold { metric: string; expr: string; ok: boolean }
export interface Check { name: string; group: string; passes: number; fails: number }
export interface Timing { metric: string; label: string; avgMs: number | null; p95Ms: number | null; maxMs: number | null }
export interface Details { runnerCount: number; summariesFound: number; thresholds: Threshold[]; checks: Check[]; timings: Timing[] }

/** Always-true rules the web app adds only so k6 exports per-API numbers; not shown as pass/fail rules. */
const TRACKING_ONLY = /^(max>=0|rate>=0|count>=0)$/;

function collectChecks(group: K6Group | undefined, out: Map<string, Check>) {
  for (const ch of Object.values(group?.checks ?? {})) {
    const k = ch.path ?? ch.name;
    const cur = out.get(k) ?? { name: ch.name, group: (ch.path ?? '').split('::').slice(1, -1).join(' › '), passes: 0, fails: 0 };
    cur.passes += ch.passes ?? 0;
    cur.fails += ch.fails ?? 0;
    out.set(k, cur);
  }
  for (const g of Object.values(group?.groups ?? {})) collectChecks(g, out);
}

const present = (a: (unknown)[]) => a.filter((x): x is number => typeof x === 'number');
const worst = (a: unknown[]) => (present(a).length ? Math.max(...present(a)) : null);
const mean = (a: unknown[]) => (present(a).length ? present(a).reduce((x, y) => x + y, 0) / present(a).length : null);

export async function loadDetails(run: Run): Promise<Details> {
  const n = run.mode === 'cloud' ? run.runners ?? 1 : 1;
  const summaries = (await Promise.all(
    Array.from({ length: n }, (_, i) => readJson<K6Summary>(`${runPrefix(run.id)}/runner-${i + 1}/summary.json`)),
  )).filter((s): s is K6Summary => s != null);

  const thresholds = new Map<string, Threshold>();
  const checks = new Map<string, Check>();
  const timings = new Map<string, { avg: unknown[]; p95: unknown[]; max: unknown[] }>();
  for (const s of summaries) {
    for (const [metric, m] of Object.entries(s.metrics ?? {})) {
      // In k6's summary export, a threshold value of true means it FAILED.
      for (const [expr, failed] of Object.entries(m.thresholds ?? {})) {
        if (TRACKING_ONLY.test(expr.replace(/\s/g, ''))) continue;
        const k = `${metric} ${expr}`;
        const t = thresholds.get(k) ?? { metric, expr, ok: true };
        if (failed) t.ok = false;
        thresholds.set(k, t);
      }
    }
    collectChecks(s.root_group, checks);
    for (const [metric] of TIMINGS) {
      const m = s.metrics?.[metric];
      if (!m) continue;
      const t = timings.get(metric) ?? { avg: [], p95: [], max: [] };
      t.avg.push(m.avg);
      t.p95.push(m['p(95)']);
      t.max.push(m.max);
      timings.set(metric, t);
    }
  }
  return {
    runnerCount: n,
    summariesFound: summaries.length,
    thresholds: [...thresholds.values()],
    checks: [...checks.values()],
    timings: TIMINGS.filter(([k]) => timings.has(k)).map(([k, label]) => ({
      metric: k, label, avgMs: mean(timings.get(k)!.avg), p95Ms: worst(timings.get(k)!.p95), maxMs: worst(timings.get(k)!.max),
    })),
  };
}

// ---------------- formatting shared by the page and the PDF ----------------
export const fmt = {
  ms: (v: number | null | undefined) => (v == null ? '-' : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v < 10 ? v.toFixed(2) : Math.round(v)} ms`),
  pct: (v: number | null | undefined) => (v == null ? '-' : `${(v * 100).toFixed(2)}%`),
  num: (v: number | null | undefined) => (v == null ? '-' : Number(v).toLocaleString('en-US')),
  bytes: (v: number | null | undefined) => (v == null ? '-' : v > 1e9 ? `${(v / 1e9).toFixed(2)} GB` : v > 1e6 ? `${(v / 1e6).toFixed(1)} MB` : `${(v / 1e3).toFixed(1)} kB`),
  date: (iso?: string) => (iso ? iso.replace('T', ' ').slice(0, 19) + ' UTC' : '-'),
  dur: (s: number | null) => (s == null ? '-' : s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`),
};

export function runFacts(run: Run): [string, string][] {
  const elapsed = run.finishedAt && run.createdAt ? Math.round((Date.parse(run.finishedAt) - Date.parse(run.createdAt)) / 1000) : null;
  return [
    ['Run', run.id],
    ['Test', run.scriptName],
    ['Project', run.project],
    ['Where', run.mode === 'cloud' ? `AWS Mumbai, ${run.runners ?? 1} × ${run.runnerSize ?? '-'} machine(s)${run.spot ? ', Spot' : ''}` : 'Local machine'],
    ['Started', fmt.date(run.createdAt)],
    ['Wall time', fmt.dur(elapsed)],
    ['Max users', fmt.num(run.maxVUs)],
    ['Started by', run.createdBy],
  ];
}

export function headline(run: Run): [string, string, string][] {
  const r = run.result;
  return [
    ['Requests', fmt.num(r?.requests), `${(r?.rps ?? 0).toFixed(1)} per second`],
    ['Error rate', fmt.pct(r?.errorRate), `${fmt.num(r?.failedRequests)} failed`],
    ['p95 response', fmt.ms(r?.p95Ms), `avg ${fmt.ms(r?.avgMs)}`],
    ['p99 response', fmt.ms(r?.p99Ms), `max ${fmt.ms(r?.maxMs)}`],
    ['Checks passed', r?.checksRate == null ? '-' : fmt.pct(r.checksRate), `${fmt.num(r?.checksFailed)} failed`],
    ['Iterations', fmt.num(r?.iterations), `${fmt.bytes(r?.dataSentBytes)} sent`],
  ];
}

export const APP_NAME = 'Load Testing k6';
