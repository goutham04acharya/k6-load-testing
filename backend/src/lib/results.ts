// Turning k6 summaries into run results, and merging results from several runners.
import type { EndpointStats, K6Summary, RunResult, RunStatus, Summary } from './types.ts';

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const n0 = (x: unknown): number => num(x) ?? 0;

/** Per-API sub-metrics look like `http_req_duration{name:1. Login}` in k6's summary export. */
const SUB = /^(http_req_duration|http_req_failed|http_reqs)\{name:(.+)\}$/;

export function endpointsOf(summary: K6Summary | null): EndpointStats[] {
  const map = new Map<string, EndpointStats>();
  for (const [key, m] of Object.entries(summary?.metrics ?? {})) {
    const hit = key.match(SUB);
    if (!hit) continue;
    const [, metric, name] = hit;
    const e = map.get(name) ?? { name, requests: 0, failed: 0, avgMs: null, p95Ms: null, maxMs: null };
    if (metric === 'http_reqs') e.requests = n0(m.count);
    if (metric === 'http_req_failed') e.failed = n0(m.passes);
    if (metric === 'http_req_duration') {
      e.avgMs = num(m.avg);
      e.p95Ms = num(m['p(95)']);
      e.maxMs = num(m.max);
    }
    map.set(name, e);
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** Pull the numbers we care about out of one k6 --summary-export file. */
export function summarize(summary: K6Summary | null): Summary {
  const m = summary?.metrics ?? {};
  const d = m.http_req_duration ?? {};
  return {
    requests: n0(m.http_reqs?.count),
    rps: n0(m.http_reqs?.rate),
    // http_req_failed is a Rate metric: "passes" = requests that failed.
    failedRequests: n0(m.http_req_failed?.passes),
    avgMs: num(d.avg),
    p90Ms: num(d['p(90)']),
    p95Ms: num(d['p(95)']),
    p99Ms: num(d['p(99)']),
    maxMs: num(d.max),
    checksPassed: n0(m.checks?.passes),
    checksFailed: n0(m.checks?.fails),
    iterations: n0(m.iterations?.count),
    vusMax: n0(m.vus_max?.value ?? m.vus_max?.max),
    dataSentBytes: n0(m.data_sent?.count),
    dataReceivedBytes: n0(m.data_received?.count),
    endpoints: endpointsOf(summary),
  };
}

const worst = (vals: (number | null)[]) => {
  const v = vals.filter((x): x is number => x != null);
  return v.length ? Math.max(...v) : null;
};

/**
 * Merge per-runner summaries:
 * counts and rates are added (exact), averages are weighted by request count (exact),
 * percentiles and max take the worst runner (a safe upper bound).
 */
export function mergeSummaries(parts: Summary[]): RunResult {
  const sum = (k: keyof Summary) => parts.reduce((a, p) => a + (p[k] as number || 0), 0);
  const requests = sum('requests');
  const weighted = parts.reduce((a, p) => a + (p.avgMs != null ? p.avgMs * p.requests : 0), 0);
  const checksPassed = sum('checksPassed');
  const checksFailed = sum('checksFailed');
  const failedRequests = sum('failedRequests');

  const byName = new Map<string, EndpointStats[]>();
  for (const p of parts) for (const e of p.endpoints ?? []) byName.set(e.name, [...(byName.get(e.name) ?? []), e]);
  const endpoints = [...byName.entries()].map(([name, list]) => {
    const req = list.reduce((a, e) => a + e.requests, 0);
    const failed = list.reduce((a, e) => a + e.failed, 0);
    const w = list.reduce((a, e) => a + (e.avgMs != null ? e.avgMs * e.requests : 0), 0);
    return {
      name,
      requests: req,
      failed,
      errorRate: req ? failed / req : 0,
      avgMs: req ? w / req : null,
      p95Ms: worst(list.map((e) => e.p95Ms)),
      maxMs: worst(list.map((e) => e.maxMs)),
    };
  }).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  return {
    requests,
    rps: sum('rps'),
    failedRequests,
    errorRate: requests ? failedRequests / requests : 0,
    avgMs: requests ? weighted / requests : null,
    p90Ms: worst(parts.map((p) => p.p90Ms)),
    p95Ms: worst(parts.map((p) => p.p95Ms)),
    p99Ms: worst(parts.map((p) => p.p99Ms)),
    maxMs: worst(parts.map((p) => p.maxMs)),
    checksPassed,
    checksFailed,
    checksRate: checksPassed + checksFailed ? checksPassed / (checksPassed + checksFailed) : null,
    iterations: sum('iterations'),
    vusMax: sum('vusMax'),
    dataSentBytes: sum('dataSentBytes'),
    dataReceivedBytes: sum('dataReceivedBytes'),
    endpoints,
    percentilesNote: parts.length > 1 ? 'p90/p95/p99/max = worst runner' : undefined,
  };
}

/** k6 exit codes -> run status. 0 = passed, 99 = thresholds failed, anything else = error. */
export function statusFromExitCodes(codes: (number | null)[]): RunStatus {
  if (codes.some((c) => c == null || (c !== 0 && c !== 99))) return 'error';
  if (codes.some((c) => c === 99)) return 'failed';
  return 'passed';
}

const EXIT: Record<number, string> = {
  0: 'ok',
  2: 'runner could not download the test',
  3: 'script asks for more VUs than the run was approved for',
  97: 'k6 configuration error',
  98: 'k6 setup() failed',
  99: 'thresholds failed',
  100: 'k6 teardown() failed',
  103: 'invalid k6 config',
  104: 'k6 cannot read the script',
  105: 'external abort',
  107: 'script exception',
  108: 'test aborted by script',
  124: 'hit the time limit',
  137: 'killed (out of memory?)',
  143: 'stopped',
};

export const describeExit = (code: number) => EXIT[code] ?? `k6 exit code ${code}`;
