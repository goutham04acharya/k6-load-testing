// Shared data shapes stored in DynamoDB / S3 and returned by the API.

export type RunStatus = 'created' | 'queued' | 'running' | 'passed' | 'failed' | 'error' | 'stopped';
export type RunMode = 'cloud' | 'local';
export type ScriptFormat = 'js' | 'tar';

export const ACTIVE: RunStatus[] = ['queued', 'running'];
export const FINISHED: RunStatus[] = ['passed', 'failed', 'error', 'stopped'];

export interface Project {
  pk: string;
  name: string;
  maxVus?: number;
  maxMinutes?: number;
  maxConcurrent?: number;
  maxRunners?: number;
  maxVuHoursMonth?: number;
}

export interface Token {
  pk: string;
  project: string;
  name: string;
  revoked?: boolean;
}

/** Per-API numbers, from k6 sub-metrics tagged with the request name. */
export interface EndpointStats {
  name: string;
  requests: number;
  failed: number;
  avgMs: number | null;
  p95Ms: number | null;
  maxMs: number | null;
}

export interface Summary {
  requests: number;
  rps: number;
  failedRequests: number;
  avgMs: number | null;
  p90Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
  checksPassed: number;
  checksFailed: number;
  iterations: number;
  vusMax: number;
  dataSentBytes: number;
  dataReceivedBytes: number;
  endpoints: EndpointStats[];
}

export interface RunnerResult extends Summary {
  runner: number;
  exitCode: number | null;
  outcome: string;
  error?: string;
  startedLate?: boolean;
  hasSummary?: boolean;
}

export interface RunResult extends Omit<Summary, 'endpoints'> {
  errorRate: number;
  checksRate: number | null;
  endpoints: (EndpointStats & { errorRate: number })[];
  percentilesNote?: string;
  runners?: RunnerResult[];
}

export interface Run {
  pk: string;
  gsi1pk: string;
  gsi1sk: string;
  id: string;
  project: string;
  mode: RunMode;
  status: RunStatus;
  scriptName: string;
  maxVUs: number;
  durationSec: number;
  vuHours: number;
  runnersRequested?: number;
  runners?: number;
  runnerSize?: string;
  spot?: boolean;
  format?: ScriptFormat;
  env?: Record<string, string>;
  config?: unknown;
  source?: 'web' | 'cli';
  createdBy: string;
  createdAt: string;
  startedAt?: string;
  plannedAt?: string;
  finishedAt?: string;
  executionArn?: string;
  shareKey?: string;
  stoppedBy?: string;
  result?: RunResult;
  error?: string;
}

/** Written by each runner every 10 s while the test runs. */
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

/** Subset of k6's --summary-export JSON that we read. */
export interface K6Summary {
  metrics?: Record<string, Record<string, unknown> & { thresholds?: Record<string, boolean> }>;
  root_group?: K6Group;
}

export interface K6Group {
  name?: string;
  checks?: Record<string, { name: string; path?: string; passes?: number; fails?: number }>;
  groups?: Record<string, K6Group>;
}
