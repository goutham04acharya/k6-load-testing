// Run endpoints: create, start, status, list, stop, local-run uploads, links.
import { createHash, randomBytes } from 'node:crypto';
import { PutCommand, QueryCommand, type QueryCommandInput } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { SFNClient, StartExecutionCommand, StopExecutionCommand } from '@aws-sdk/client-sfn';
import { ECSClient, ListTasksCommand, DescribeTasksCommand, StopTaskCommand } from '@aws-sdk/client-ecs';
import {
  BUCKET, TABLE, ddb, s3, deleteKey, getItem, getRun, readJson, runKey, runPrefix, scriptFile, updateRun, exists,
} from '../../lib/store.ts';
import { mergeSummaries, statusFromExitCodes, summarize } from '../../lib/results.ts';
import { ACTIVE, type K6Summary, type Progress, type Project, type Run, type Token } from '../../lib/types.ts';
import { HttpError, host, json, readBody, type Ctx, type Event, type Result } from './http.ts';

const sfn = new SFNClient({});
const ecs = new ECSClient({});

const LINK_TTL = 3600; // presigned report links live 1 hour; clients ask for a fresh one each time
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const newRunId = () => 'r-' + randomBytes(5).toString('hex');
const presignPut = (key: string) => getSignedUrl(s3, new PutObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: 900 });

export async function authenticate(event: Event): Promise<Ctx> {
  const h = event.headers?.authorization ?? '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!token) throw new HttpError(401, 'missing token (Authorization: Bearer <token>)');
  const t = await getItem<Token>(`TOKEN#${sha256(token)}`);
  if (!t || t.revoked) throw new HttpError(401, 'invalid or revoked token');
  const project = await getItem<Project>(`PROJECT#${t.project}`);
  if (!project) throw new HttpError(403, `project ${t.project} does not exist`);
  return { tokenName: t.name, project };
}

/** What clients see: internal keys and secrets left out. */
export function publicRun(r: Run) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { pk, gsi1pk, gsi1sk, executionArn, shareKey, ...rest } = r;
  return rest;
}

async function loadOwnRun(ctx: Ctx, id: string): Promise<Run> {
  const run = await getRun(id);
  if (!run || run.project !== ctx.project.name) throw new HttpError(404, 'run not found');
  return run;
}

async function projectRuns(project: string, opts: { sinceIso?: string; limit?: number } = {}): Promise<Run[]> {
  const { sinceIso, limit = 50 } = opts;
  const params: QueryCommandInput = {
    TableName: TABLE,
    IndexName: 'byProject',
    KeyConditionExpression: sinceIso ? 'gsi1pk = :p AND gsi1sk >= :s' : 'gsi1pk = :p',
    ExpressionAttributeValues: { ':p': `PROJECT#${project}`, ...(sinceIso ? { ':s': sinceIso } : {}) },
    ScanIndexForward: false,
    Limit: sinceIso ? undefined : limit,
  };
  const items: Run[] = [];
  let last: Record<string, unknown> | undefined;
  do {
    const r = await ddb.send(new QueryCommand({ ...params, ExclusiveStartKey: last }));
    items.push(...((r.Items ?? []) as Run[]));
    last = r.LastEvaluatedKey;
  } while (last && (sinceIso || items.length < limit));
  return items;
}

async function checkCloudLimits(project: Project, vus: number, durationSec: number) {
  const monthStart = new Date().toISOString().slice(0, 7) + '-01';
  const cloud = (await projectRuns(project.name, { sinceIso: monthStart })).filter((r) => r.mode === 'cloud');
  const active = cloud.filter((r) => ACTIVE.includes(r.status)).length;
  const maxConcurrent = project.maxConcurrent ?? 2;
  if (active >= maxConcurrent) throw new HttpError(429, `project already has ${active} cloud run(s) in progress (limit ${maxConcurrent})`);
  const usedVuh = cloud.filter((r) => r.status !== 'created').reduce((a, r) => a + (r.vuHours || 0), 0);
  const thisVuh = (vus * durationSec) / 3600;
  if (project.maxVuHoursMonth && usedVuh + thisVuh > project.maxVuHoursMonth) {
    throw new HttpError(429, `monthly budget: ${usedVuh.toFixed(1)} of ${project.maxVuHoursMonth} VU-hours used, this run needs ${thisVuh.toFixed(1)}`);
  }
}

// ---------------- handlers ----------------

export function whoami(ctx: Ctx): Result {
  const { name, maxVus, maxMinutes, maxConcurrent, maxRunners, maxVuHoursMonth } = ctx.project;
  return json(200, { token: ctx.tokenName, project: { name, maxVus, maxMinutes, maxConcurrent, maxRunners, maxVuHoursMonth } });
}

interface CreateBody {
  mode?: string;
  format?: string;
  source?: string;
  scriptName?: string;
  maxVUs?: number;
  durationSec?: number;
  env?: Record<string, unknown>;
  config?: unknown;
  spot?: boolean;
  runners?: number;
}

export async function createRun(ctx: Ctx, event: Event): Promise<Result> {
  const b = readBody<CreateBody>(event);
  const p = ctx.project;
  const mode = b.mode;
  if (mode !== 'cloud' && mode !== 'local') throw new HttpError(400, 'mode must be "cloud" or "local"');
  const vus = Math.ceil(Number(b.maxVUs));
  const durationSec = Math.ceil(Number(b.durationSec));
  if (!(vus >= 1)) throw new HttpError(400, 'maxVUs must be >= 1');
  if (!(durationSec >= 1)) throw new HttpError(400, 'durationSec must be >= 1');
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(b.env ?? {})) {
    if (!ENV_NAME.test(k)) throw new HttpError(400, `invalid env name "${k}"`);
    env[k] = String(v).slice(0, 4000);
  }
  const config = b.config && JSON.stringify(b.config).length <= 30000 ? b.config : undefined;

  let runners: number | undefined;
  if (mode === 'cloud') {
    const maxVus = p.maxVus ?? 1000;
    const maxMinutes = p.maxMinutes ?? 60;
    const maxRunners = p.maxRunners ?? 10;
    if (vus > maxVus) throw new HttpError(403, `test needs ${vus} users, project limit is ${maxVus}`);
    if (durationSec > maxMinutes * 60) throw new HttpError(403, `test runs ${Math.round(durationSec / 60)} min (incl. graceful stop), project limit is ${maxMinutes} min`);
    if (b.runners != null) {
      runners = Math.floor(Number(b.runners));
      if (!(runners >= 1 && runners <= maxRunners)) throw new HttpError(400, `runners must be 1..${maxRunners}`);
      if (runners > vus) throw new HttpError(400, 'runners cannot exceed users');
    }
    await checkCloudLimits(p, vus, durationSec);
  }

  const id = newRunId();
  const now = new Date().toISOString();
  const run: Run = {
    pk: runKey(id),
    gsi1pk: `PROJECT#${p.name}`,
    gsi1sk: `${now}#${id}`,
    id,
    project: p.name,
    mode,
    status: 'created',
    scriptName: String(b.scriptName || 'script.js').slice(0, 200),
    maxVUs: vus,
    durationSec,
    vuHours: (vus * durationSec) / 3600,
    runnersRequested: runners,
    spot: mode === 'cloud' ? Boolean(b.spot) : undefined,
    format: b.format === 'js' ? 'js' : 'tar',
    env: Object.keys(env).length ? env : undefined,
    config,
    source: b.source === 'web' ? 'web' : 'cli',
    createdBy: ctx.tokenName,
    createdAt: now,
  };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: run }));
  const upload = await presignPut(`${runPrefix(id)}/${scriptFile(run)}`);
  return json(201, { runId: id, uploads: { archive: upload, script: upload } });
}

export async function startRun(ctx: Ctx, id: string): Promise<Result> {
  const run = await loadOwnRun(ctx, id);
  if (run.mode !== 'cloud') throw new HttpError(400, 'only cloud runs are started on AWS');
  if (run.status !== 'created') throw new HttpError(409, `run is already ${run.status}`);
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: `${runPrefix(id)}/${scriptFile(run)}` }));
  } catch {
    throw new HttpError(409, 'upload the test script first');
  }
  await checkCloudLimits(ctx.project, run.maxVUs, run.durationSec);
  const updated = await updateRun(id, { status: 'queued', startedAt: new Date().toISOString() }, { onlyIfStatus: ['created'] });
  const r = await sfn.send(new StartExecutionCommand({
    stateMachineArn: process.env.STATE_MACHINE_ARN,
    name: id,
    input: JSON.stringify({ runId: id }),
  }));
  await updateRun(id, { executionArn: r.executionArn });
  return json(202, { runId: id, status: updated.status });
}

export async function uploadUrls(ctx: Ctx, id: string): Promise<Result> {
  const run = await loadOwnRun(ctx, id);
  if (run.mode !== 'local') throw new HttpError(400, 'only local runs upload their own results');
  const base = `${runPrefix(id)}/runner-1`;
  return json(200, { summary: await presignPut(`${base}/summary.json`), report: await presignPut(`${base}/report.html`) });
}

export async function finishRun(ctx: Ctx, id: string, event: Event): Promise<Result> {
  const run = await loadOwnRun(ctx, id);
  if (run.mode !== 'local') throw new HttpError(400, 'only local runs are finished by the client');
  if (run.status !== 'created' && run.status !== 'running') throw new HttpError(409, `run is already ${run.status}`);
  const exitCode = Number(readBody<{ exitCode?: number }>(event).exitCode);
  const summary = await readJson<K6Summary>(`${runPrefix(id)}/runner-1/summary.json`);
  const part = summarize(summary);
  const result = { ...mergeSummaries([part]), runners: [{ runner: 1, exitCode, outcome: exitCode === 0 ? 'ok' : `exit ${exitCode}`, ...part }] };
  const updated = await updateRun(id, {
    status: summary ? statusFromExitCodes([exitCode]) : 'error',
    result,
    finishedAt: new Date().toISOString(),
    error: summary ? undefined : 'no summary uploaded',
  });
  return json(200, publicRun(updated));
}

/** Running ECS tasks whose RUN_ID override matches this run. */
async function runTasks(id: string): Promise<string[]> {
  const cluster = process.env.CLUSTER;
  const out: string[] = [];
  let nextToken: string | undefined;
  do {
    const page = await ecs.send(new ListTasksCommand({ cluster, desiredStatus: 'RUNNING', nextToken })).catch(() => ({ taskArns: [], nextToken: undefined }));
    const arns = page.taskArns ?? [];
    if (arns.length) {
      const d = await ecs.send(new DescribeTasksCommand({ cluster, tasks: arns })).catch(() => ({ tasks: [] }));
      for (const t of d.tasks ?? []) {
        const env = t.overrides?.containerOverrides?.flatMap((o) => o.environment ?? []) ?? [];
        if (t.taskArn && env.some((e) => e.name === 'RUN_ID' && e.value === id)) out.push(t.taskArn);
      }
    }
    nextToken = page.nextToken;
  } while (nextToken);
  return out;
}

export async function stopRun(ctx: Ctx, id: string): Promise<Result> {
  const run = await loadOwnRun(ctx, id);
  if (!['created', ...ACTIVE].includes(run.status)) return json(200, publicRun(run));
  if (run.executionArn) {
    await sfn.send(new StopExecutionCommand({ executionArn: run.executionArn, cause: `stopped by ${ctx.tokenName}` })).catch(() => undefined);
  }
  if (run.mode === 'cloud') {
    // Step Functions stops its runTask.sync tasks when the execution stops; this is a safety net.
    for (const t of await runTasks(id)) {
      await ecs.send(new StopTaskCommand({ cluster: process.env.CLUSTER, task: t, reason: 'stopped by user' })).catch(() => undefined);
    }
    await deleteKey(`${runPrefix(id)}/env.json`);
  }
  const updated = await updateRun(id, { status: 'stopped', finishedAt: new Date().toISOString(), stoppedBy: ctx.tokenName });
  return json(200, publicRun(updated));
}

export async function getRunStatus(ctx: Ctx, id: string): Promise<Result> {
  const run = await loadOwnRun(ctx, id);
  const out: ReturnType<typeof publicRun> & { progress?: (Progress | null)[] } = publicRun(run);
  if (run.mode === 'cloud' && ACTIVE.includes(run.status) && run.runners) {
    out.progress = await Promise.all(
      Array.from({ length: run.runners }, (_, i) => readJson<Progress>(`${runPrefix(id)}/runner-${i + 1}/progress.json`)),
    );
  }
  return json(200, out);
}

export async function listRuns(ctx: Ctx, event: Event): Promise<Result> {
  const limit = Math.min(Number(event.queryStringParameters?.limit) || 20, 200);
  const runs = await projectRuns(ctx.project.name, { limit });
  return json(200, { runs: runs.slice(0, limit).map(publicRun) });
}

export async function scriptLink(ctx: Ctx, id: string): Promise<Result> {
  const run = await loadOwnRun(ctx, id);
  const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: `${runPrefix(id)}/${scriptFile(run)}` }), { expiresIn: 600 });
  return json(200, {
    url, format: run.format ?? 'tar', config: run.config, env: run.env, scriptName: run.scriptName,
    maxVUs: run.maxVUs, durationSec: run.durationSec, spot: run.spot, runners: run.runnersRequested,
  });
}

export async function reportLink(ctx: Ctx, id: string, event: Event): Promise<Result> {
  const run = await loadOwnRun(ctx, id);
  const q = event.queryStringParameters ?? {};
  const file = q.file ?? 'report';
  const runner = Number(q.runner ?? 1);
  const n = run.mode === 'cloud' ? run.runners ?? 1 : 1;
  if (!(runner >= 1 && runner <= n)) throw new HttpError(400, `runner must be 1..${n}`);
  const keys: Record<string, [string, string]> = {
    report: [`${runPrefix(id)}/runner-${runner}/report.html`, 'text/html; charset=utf-8'],
    summary: [`${runPrefix(id)}/runner-${runner}/summary.json`, 'application/json'],
    result: [`${runPrefix(id)}/result.json`, 'application/json'],
  };
  if (!keys[file]) throw new HttpError(400, 'file must be report, summary or result');
  const [Key, type] = keys[file];
  if (!(await exists(Key))) throw new HttpError(404, `${file} not available for this run${file === 'report' ? ' (k6 skips the HTML report for runs under ~30s)' : ''}`);
  const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key, ResponseContentType: type }), { expiresIn: LINK_TTL });
  return json(200, { url, expiresInSeconds: LINK_TTL, runners: n, shareUrl: await shareUrl(event, run) });
}

export async function linkInfo(ctx: Ctx, id: string, event: Event): Promise<Result> {
  const run = await loadOwnRun(ctx, id);
  return json(200, { shareUrl: await shareUrl(event, run), runners: run.mode === 'cloud' ? run.runners ?? 1 : 1 });
}

// Permanent share links: /r/<run-id>/<key>. The 32-hex-char key is random per run.
async function ensureShareKey(run: Run): Promise<string> {
  if (run.shareKey) return run.shareKey;
  const key = randomBytes(16).toString('hex');
  await updateRun(run.id, { shareKey: key });
  return key;
}

export async function shareUrl(event: Event, run: Run): Promise<string> {
  return `https://${host(event)}/r/${run.id}/${await ensureShareKey(run)}`;
}
