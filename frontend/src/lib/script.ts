// Builds a k6 script from the "Pick APIs" form.

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export const METHODS: Method[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

export interface KV {
  key: string;
  value: string;
}

export interface Step {
  id: string;
  name: string;
  method: Method;
  url: string;
  headers: KV[];
  body: string;
  expectStatus: number;
}

export type ProfileKind = 'constant' | 'ramp' | 'rate' | 'spike';

export interface Profile {
  kind: ProfileKind;
  vus: number; // constant, ramp: users at peak
  durationSec: number; // constant, rate: test length
  rampUpSec: number; // ramp
  holdSec: number; // ramp, spike: time at peak
  rampDownSec: number; // ramp
  rate: number; // rate: iterations per second
  maxVus: number; // rate: VU pool ceiling
  baseVus: number; // spike: normal load
  spikeVus: number; // spike: peak load
}

export interface Thresholds {
  p95Ms: number | null;
  errorPct: number | null;
  checksPct: number | null;
}

export interface QuickConfig {
  name: string;
  steps: Step[];
  thinkTimeSec: number;
  profile: Profile;
  thresholds: Thresholds;
}

export const newId = () => Math.random().toString(36).slice(2, 9);

export const defaultStep = (n = 1): Step => ({
  id: newId(),
  name: n === 1 ? 'Home page' : `Request ${n}`,
  method: 'GET',
  url: n === 1 ? 'https://quickpizza.grafana.com/' : '',
  headers: [],
  body: '',
  expectStatus: 200,
});

export const defaultQuickConfig = (): QuickConfig => ({
  name: 'quick-test',
  steps: [defaultStep(1)],
  thinkTimeSec: 1,
  profile: {
    kind: 'ramp',
    vus: 20,
    durationSec: 60,
    rampUpSec: 30,
    holdSec: 60,
    rampDownSec: 15,
    rate: 20,
    maxVus: 50,
    baseVus: 10,
    spikeVus: 100,
  },
  thresholds: { p95Ms: 1000, errorPct: 1, checksPct: 99 },
});

/** Peak VUs the profile needs (what the API checks against project limits). */
export function peakVus(p: Profile): number {
  switch (p.kind) {
    case 'constant':
    case 'ramp':
      return p.vus;
    case 'rate':
      return p.maxVus;
    case 'spike':
      return Math.max(p.baseVus, p.spikeVus);
  }
}

const SPIKE_RAMP = 10;
const SPIKE_WARM = 30;

/** Test length in seconds, without k6's 30 s graceful stop. */
export function loadSeconds(p: Profile): number {
  switch (p.kind) {
    case 'constant':
    case 'rate':
      return p.durationSec;
    case 'ramp':
      return p.rampUpSec + p.holdSec + p.rampDownSec;
    case 'spike':
      return SPIKE_WARM + SPIKE_RAMP + p.holdSec + SPIKE_RAMP + SPIKE_WARM;
  }
}

export const GRACEFUL_STOP = 30;

/** Points for the load-shape preview: [seconds, users or rate]. */
export function shape(p: Profile): [number, number][] {
  switch (p.kind) {
    case 'constant':
      return [[0, p.vus], [p.durationSec, p.vus]];
    case 'rate':
      return [[0, p.rate], [p.durationSec, p.rate]];
    case 'ramp':
      return [[0, 0], [p.rampUpSec, p.vus], [p.rampUpSec + p.holdSec, p.vus], [loadSeconds(p), 0]];
    case 'spike': {
      const a = SPIKE_WARM, b = a + SPIKE_RAMP, c = b + p.holdSec, d = c + SPIKE_RAMP;
      return [[0, p.baseVus], [a, p.baseVus], [b, p.spikeVus], [c, p.spikeVus], [d, p.baseVus], [d + SPIKE_WARM, p.baseVus]];
    }
  }
}

/**
 * Text -> JS template literal. {{NAME}} becomes ${__ENV.NAME}, so values typed in the
 * "Environment values" table (or project secrets) are used at run time.
 */
function tpl(text: string): string {
  const escaped = text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  return '`' + escaped.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, '${__ENV.$1}') + '`';
}

const s = (n: number) => `'${Math.max(1, Math.round(n))}s'`;

function scenario(p: Profile): string {
  switch (p.kind) {
    case 'constant':
      return `{\n      executor: 'constant-vus',\n      vus: ${p.vus},\n      duration: ${s(p.durationSec)},\n    }`;
    case 'ramp':
      return `{\n      executor: 'ramping-vus',\n      startVUs: 0,\n      stages: [\n        { duration: ${s(p.rampUpSec)}, target: ${p.vus} },\n        { duration: ${s(p.holdSec)}, target: ${p.vus} },\n        { duration: ${s(p.rampDownSec)}, target: 0 },\n      ],\n    }`;
    case 'rate':
      return `{\n      executor: 'constant-arrival-rate',\n      rate: ${p.rate},\n      timeUnit: '1s',\n      duration: ${s(p.durationSec)},\n      preAllocatedVUs: ${Math.min(p.maxVus, Math.max(1, Math.ceil(p.rate)))},\n      maxVUs: ${p.maxVus},\n    }`;
    case 'spike':
      return `{\n      executor: 'ramping-vus',\n      startVUs: ${p.baseVus},\n      stages: [\n        { duration: ${s(SPIKE_WARM)}, target: ${p.baseVus} },\n        { duration: ${s(SPIKE_RAMP)}, target: ${p.spikeVus} },\n        { duration: ${s(p.holdSec)}, target: ${p.spikeVus} },\n        { duration: ${s(SPIKE_RAMP)}, target: ${p.baseVus} },\n        { duration: ${s(SPIKE_WARM)}, target: ${p.baseVus} },\n      ],\n    }`;
  }
}

/** Request label as used in the k6 `name` tag (braces and quotes would break tag syntax). */
export const stepLabel = (st: Step, i: number) => `${i + 1}. ${st.name || st.method + ' ' + st.url}`.replace(/[{}"'`]/g, '').trim();

export function buildScript(c: QuickConfig): string {
  const t: string[] = [];
  if (c.thresholds.p95Ms != null) t.push(`    http_req_duration: ['p(95)<${c.thresholds.p95Ms}'],`);
  if (c.thresholds.errorPct != null) t.push(`    http_req_failed: ['rate<${+(c.thresholds.errorPct / 100).toFixed(4)}'],`);
  if (c.thresholds.checksPct != null) t.push(`    checks: ['rate>${+(c.thresholds.checksPct / 100).toFixed(4)}'],`);

  // Always-true rules so k6 reports numbers for each API separately (shown as "Per API" in results).
  const tracking = c.steps.flatMap((st, i) => {
    const l = stepLabel(st, i);
    return [
      `    ${JSON.stringify(`http_reqs{name:${l}}`)}: ['count>=0'],`,
      `    ${JSON.stringify(`http_req_failed{name:${l}}`)}: ['rate>=0'],`,
      `    ${JSON.stringify(`http_req_duration{name:${l}}`)}: ['max>=0'],`,
    ];
  });

  const steps = c.steps.map((st, i) => {
    const label = stepLabel(st, i);
    const headers = st.headers.filter((h) => h.key.trim());
    const hasBody = st.body.trim() && st.method !== 'GET';
    const looksJson = /^[[{]/.test(st.body.trim());
    if (hasBody && looksJson && !headers.some((h) => h.key.trim().toLowerCase() === 'content-type')) {
      headers.push({ key: 'Content-Type', value: 'application/json' });
    }
    const params = [
      headers.length ? `headers: { ${headers.map((h) => `${JSON.stringify(h.key.trim())}: ${tpl(h.value)}`).join(', ')} }` : '',
      `tags: { name: ${JSON.stringify(label)} }`,
    ].filter(Boolean).join(', ');
    return [
      `  group(${JSON.stringify(label)}, () => {`,
      `    const res = http.request(${JSON.stringify(st.method)}, ${tpl(st.url)}, ${hasBody ? tpl(st.body) : 'null'}, { ${params} });`,
      `    check(res, { ${JSON.stringify(`status is ${st.expectStatus}`)}: (r) => r.status === ${st.expectStatus} });`,
      `  });`,
    ].join('\n');
  });

  return `// Generated by Load Testing k6 (Pick APIs: ${c.name}).
// {{NAME}} in the form became \${__ENV.NAME}: values come from "Environment values" or project secrets.
import http from 'k6/http';
import { check, group, sleep } from 'k6';

export const options = {
  scenarios: {
    main: ${scenario(c.profile)},
  },
  thresholds: {
${t.join('\n') || '    // no pass/fail rules'}
    // per-API numbers (always pass)
${tracking.join('\n')}
  },
};

export default function () {
${steps.join('\n\n')}
${c.thinkTimeSec > 0 ? `\n  sleep(${c.thinkTimeSec}); // think time between iterations\n` : ''}}
`;
}

/** Best-effort guess of VUs and duration from a hand-written script, to prefill the form. */
export function guessFromScript(src: string): { vus?: number; durationSec?: number } {
  const toSec = (n: number, u: string) => n * ({ s: 1, m: 60, h: 3600 }[u] ?? 1);
  const vusAll = [...src.matchAll(/(?:\bvus|\btarget|maxVUs)\s*:\s*(\d+)/g)].map((m) => +m[1]);
  const durs = [...src.matchAll(/duration\s*:\s*['"`](\d+(?:\.\d+)?)([smh])['"`]/g)].map((m) => toSec(+m[1], m[2]));
  return {
    vus: vusAll.length ? Math.max(...vusAll) : undefined,
    durationSec: durs.length ? Math.ceil(durs.reduce((a, b) => a + b, 0)) : undefined,
  };
}

export const SAMPLE_SCRIPT = `import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = __ENV.BASE_URL || 'https://quickpizza.grafana.com';

export const options = {
  stages: [
    { duration: '30s', target: 20 },
    { duration: '1m', target: 20 },
    { duration: '15s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<1000'],
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  const res = http.get(\`\${BASE}/\`, { tags: { name: 'home' } });
  check(res, { 'status is 200': (r) => r.status === 200 });
  sleep(1);
}
`;

// ---------------- templates ----------------
export interface Template {
  id: string;
  title: string;
  text: string;
  profile: Partial<Profile> & { kind: ProfileKind };
  thresholds: Thresholds;
}

export const TEMPLATES: Template[] = [
  { id: 'smoke', title: 'Smoke', text: '2 users for 1 min: does it work at all?', profile: { kind: 'constant', vus: 2, durationSec: 60 }, thresholds: { p95Ms: 1000, errorPct: 1, checksPct: 99 } },
  { id: 'load', title: 'Load', text: 'Normal day: ramp to 50 users, hold 5 min', profile: { kind: 'ramp', vus: 50, rampUpSec: 120, holdSec: 300, rampDownSec: 60 }, thresholds: { p95Ms: 800, errorPct: 1, checksPct: 99 } },
  { id: 'stress', title: 'Stress', text: 'Find the limit: ramp to 300 users', profile: { kind: 'ramp', vus: 300, rampUpSec: 300, holdSec: 300, rampDownSec: 60 }, thresholds: { p95Ms: 2000, errorPct: 5, checksPct: 95 } },
  { id: 'spike', title: 'Spike', text: '10 users, sudden jump to 200', profile: { kind: 'spike', baseVus: 10, spikeVus: 200, holdSec: 60 }, thresholds: { p95Ms: 2000, errorPct: 5, checksPct: 95 } },
  { id: 'soak', title: 'Soak', text: '30 users for 30 min: leaks, slowdowns', profile: { kind: 'constant', vus: 30, durationSec: 1800 }, thresholds: { p95Ms: 1000, errorPct: 1, checksPct: 99 } },
];

// ---------------- cURL import ----------------
function shellWords(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  const src = cmd.replace(/\\\r?\n/g, ' ');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < src.length) cur += src[++i];
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (ch === '\\' && i + 1 < src.length) {
      cur += src[++i];
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

/** Turn a pasted `curl ...` command into a request step. Returns null if it is not a curl command. */
export function parseCurl(cmd: string): Partial<Step> | null {
  const w = shellWords(cmd.trim());
  if (!w.length || !/^curl(\.exe)?$/i.test(w[0])) return null;
  let method: string | undefined;
  let url = '';
  const headers: KV[] = [];
  const data: string[] = [];
  for (let i = 1; i < w.length; i++) {
    const a = w[i];
    const next = () => w[++i] ?? '';
    if (a === '-X' || a === '--request') method = next().toUpperCase();
    else if (a === '-H' || a === '--header') {
      const h = next();
      const j = h.indexOf(':');
      if (j > 0) headers.push({ key: h.slice(0, j).trim(), value: h.slice(j + 1).trim() });
    } else if (['-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--data-urlencode'].includes(a)) data.push(next());
    else if (a === '--json') {
      data.push(next());
      if (!headers.some((h) => h.key.toLowerCase() === 'content-type')) headers.push({ key: 'Content-Type', value: 'application/json' });
    } else if (a === '-u' || a === '--user') headers.push({ key: 'Authorization', value: `Basic ${btoa(next())}` });
    else if (a === '-A' || a === '--user-agent') headers.push({ key: 'User-Agent', value: next() });
    else if (a === '-b' || a === '--cookie') headers.push({ key: 'Cookie', value: next() });
    else if (a === '--url') url = next();
    else if (['-o', '--output', '-w', '--write-out', '-m', '--max-time', '--connect-timeout', '-e', '--referer'].includes(a)) next();
    else if (!a.startsWith('-') && !url) url = a;
  }
  if (!url) return null;
  const m = (method ?? (data.length ? 'POST' : 'GET')) as Method;
  let name = 'Imported request';
  try {
    name = `${m} ${new URL(url).pathname}`;
  } catch { /* keep default */ }
  return { method: METHODS.includes(m) ? m : 'GET', url, headers, body: data.join('&'), name };
}
