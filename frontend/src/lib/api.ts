// Talks to the Load Testing k6 API (the same one the loadtest CLI uses).

export type RunStatus = 'created' | 'queued' | 'running' | 'passed' | 'failed' | 'error' | 'stopped';

export interface RunnerResult {
  runner: number;
  exitCode: number | null;
  outcome: string;
  error?: string;
  requests: number;
  p95Ms: number | null;
}

export interface EndpointResult {
  name: string;
  requests: number;
  failed: number;
  errorRate: number;
  avgMs: number | null;
  p95Ms: number | null;
  maxMs: number | null;
}

export interface RunResult {
  requests: number;
  rps: number;
  failedRequests: number;
  errorRate: number;
  avgMs: number | null;
  p90Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
  checksPassed: number;
  checksFailed: number;
  checksRate: number | null;
  iterations: number;
  vusMax: number;
  dataSentBytes: number;
  dataReceivedBytes: number;
  endpoints?: EndpointResult[];
  runners?: RunnerResult[];
}

export interface Progress {
  phase: 'ready' | 'running' | 'finished';
  t: number;
  runner: number;
  vus?: number;
  requests?: number;
  failedRate?: number;
  p95Ms?: number | null;
  iterations?: number;
}

export interface Run {
  id: string;
  project: string;
  mode: 'cloud' | 'local';
  status: RunStatus;
  scriptName: string;
  maxVUs: number;
  durationSec: number;
  runners?: number;
  runnerSize?: string;
  spot?: boolean;
  format?: 'js' | 'tar';
  source?: 'web' | 'cli';
  createdBy: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: RunResult;
  error?: string;
  progress?: (Progress | null)[];
}

export interface Project {
  name: string;
  maxVus: number;
  maxMinutes: number;
  maxConcurrent: number;
  maxRunners: number;
  maxVuHoursMonth?: number;
}

export interface Me {
  token: string;
  project: Project;
}

export const FINISHED: RunStatus[] = ['passed', 'failed', 'error', 'stopped'];
export const isActive = (s: RunStatus) => s === 'queued' || s === 'running';

let apiUrl = '';
const TOKEN_KEY = 'load-testing-k6.token';
let memoryToken: string | null = null;

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** API address: VITE_API_URL at dev time, otherwise /config.json written by the deploy script. */
export async function loadConfig(): Promise<void> {
  const fromEnv = import.meta.env.VITE_API_URL as string | undefined;
  if (fromEnv) {
    apiUrl = fromEnv.replace(/\/$/, '');
    return;
  }
  const r = await fetch('/config.json', { cache: 'no-store' });
  if (!r.ok) throw new Error('config.json is missing; deploy with frontend/scripts/deploy.sh');
  apiUrl = String((await r.json()).apiUrl || '').replace(/\/$/, '');
}

export const getApiUrl = () => apiUrl;

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? memoryToken;
  } catch {
    return memoryToken;
  }
}

export function setToken(token: string | null) {
  memoryToken = token;
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private window: keep it in memory only */
  }
}

export async function api<T>(method: 'GET' | 'POST', path: string, body?: unknown, token = getToken()): Promise<T> {
  let res: Response;
  try {
    res = await fetch(apiUrl + path, {
      method,
      headers: { authorization: `Bearer ${token ?? ''}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the API. Check your connection.');
  }
  const text = await res.text();
  let data: unknown = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error || `HTTP ${res.status}`);
  return data as T;
}

export async function uploadText(url: string, text: string) {
  const res = await fetch(url, { method: 'PUT', body: new Blob([text], { type: 'application/javascript' }) });
  if (!res.ok) throw new ApiError(res.status, `Upload failed (HTTP ${res.status})`);
}

export interface CreateRunInput {
  scriptName: string;
  script: string;
  maxVUs: number;
  durationSec: number;
  env: Record<string, string>;
  spot: boolean;
  runners?: number;
  config?: unknown;
}

/** Create a cloud run, upload the script, start it. Returns the run id. */
export async function startCloudRun(input: CreateRunInput): Promise<string> {
  const created = await api<{ runId: string; uploads: { script: string } }>('POST', '/runs', {
    mode: 'cloud',
    format: 'js',
    source: 'web',
    scriptName: input.scriptName,
    maxVUs: input.maxVUs,
    durationSec: input.durationSec,
    env: input.env,
    spot: input.spot,
    runners: input.runners,
    config: input.config,
  });
  await uploadText(created.uploads.script, input.script);
  await api('POST', `/runs/${created.runId}/start`);
  return created.runId;
}
