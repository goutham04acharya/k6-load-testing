// HTTP API for the k6kt CLI (and the web app later).
// Auth: "Authorization: Bearer <token>". Tokens are stored as SHA-256 hashes in DynamoDB.
import { createHash, randomBytes } from 'node:crypto';
import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { SFNClient, StartExecutionCommand, StopExecutionCommand } from '@aws-sdk/client-sfn';
import { ECSClient, ListTasksCommand, DescribeTasksCommand, StopTaskCommand } from '@aws-sdk/client-ecs';
import {
  TABLE, BUCKET, ddb, s3, getItem, getRun, updateRun, readJson, deleteKey,
  runKey, runPrefix, summarize, mergeSummaries, statusFromExitCodes, ACTIVE,
} from './lib.mjs';

const sfn = new SFNClient({});
const ecs = new ECSClient({});

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const json = (status, body) => ({
  statusCode: status,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const newRunId = () => 'r-' + randomBytes(5).toString('hex');

const LINK_TTL = 3600; // presigned links live 1 hour; `k6kt open` always makes a fresh one

async function auth(event) {
  const h = event.headers?.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!token) throw new HttpError(401, 'missing token (Authorization: Bearer <token>)');
  const t = await getItem(`TOKEN#${sha256(token)}`);
  if (!t || t.revoked) throw new HttpError(401, 'invalid or revoked token');
  const project = await getItem(`PROJECT#${t.project}`);
  if (!project) throw new HttpError(403, `project ${t.project} does not exist`);
  return { tokenName: t.name, project };
}

function body(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body;
  try { return JSON.parse(raw); } catch { throw new HttpError(400, 'body must be JSON'); }
}

async function loadOwnRun(ctx, id) {
  const run = await getRun(id);
  if (!run || run.project !== ctx.project.name) throw new HttpError(404, 'run not found');
  return run;
}

const presignPut = (key) => getSignedUrl(s3, new PutObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: 900 });

async function projectRuns(project, { sinceIso, limit = 50 } = {}) {
  const params = {
    TableName: TABLE,
    IndexName: 'byProject',
    KeyConditionExpression: sinceIso ? 'gsi1pk = :p AND gsi1sk >= :s' : 'gsi1pk = :p',
    ExpressionAttributeValues: { ':p': `PROJECT#${project}`, ...(sinceIso ? { ':s': sinceIso } : {}) },
    ScanIndexForward: false,
  };
  if (!sinceIso) params.Limit = limit;
  const items = [];
  let last;
  do {
    const r = await ddb.send(new QueryCommand({ ...params, ExclusiveStartKey: last }));
    items.push(...(r.Items || []));
    last = r.LastEvaluatedKey;
  } while (last && (sinceIso || items.length < limit));
  return items;
}

async function checkCloudLimits(project, vus, durationSec) {
  const monthStart = new Date().toISOString().slice(0, 7) + '-01';
  const runs = await projectRuns(project.name, { sinceIso: monthStart });
  const cloud = runs.filter((r) => r.mode === 'cloud');
  const active = cloud.filter((r) => ACTIVE.includes(r.status)).length;
  if (active >= (project.maxConcurrent ?? 2)) {
    throw new HttpError(429, `project already has ${active} cloud run(s) in progress (limit ${project.maxConcurrent ?? 2})`);
  }
  const usedVuh = cloud.filter((r) => r.status !== 'created').reduce((a, r) => a + (r.vuHours || 0), 0);
  const thisVuh = (vus * durationSec) / 3600;
  if (project.maxVuHoursMonth && usedVuh + thisVuh > project.maxVuHoursMonth) {
    throw new HttpError(429, `monthly budget: ${usedVuh.toFixed(1)} of ${project.maxVuHoursMonth} VU-hours used, this run needs ${thisVuh.toFixed(1)}`);
  }
}

// ---------------- handlers ----------------

async function whoami(ctx) {
  const { name, maxVus, maxMinutes, maxConcurrent, maxRunners, maxVuHoursMonth } = ctx.project;
  return json(200, { token: ctx.tokenName, project: { name, maxVus, maxMinutes, maxConcurrent, maxRunners, maxVuHoursMonth } });
}

async function createRun(ctx, event) {
  const b = body(event);
  const p = ctx.project;
  const mode = b.mode;
  if (!['cloud', 'local'].includes(mode)) throw new HttpError(400, 'mode must be "cloud" or "local"');
  const vus = Math.ceil(Number(b.maxVUs));
  const durationSec = Math.ceil(Number(b.durationSec));
  if (!(vus >= 1)) throw new HttpError(400, 'maxVUs must be >= 1');
  if (!(durationSec >= 1)) throw new HttpError(400, 'durationSec must be >= 1');
  let runners;
  if (mode === 'cloud') {
    if (vus > (p.maxVus ?? 1000)) throw new HttpError(403, `script needs ${vus} VUs, project limit is ${p.maxVus ?? 1000}`);
    if (durationSec > (p.maxMinutes ?? 60) * 60) {
      throw new HttpError(403, `script runs ${Math.round(durationSec / 60)} min (incl. graceful stop), project limit is ${p.maxMinutes ?? 60} min`);
    }
    if (b.runners != null) {
      runners = Math.floor(Number(b.runners));
      if (!(runners >= 1 && runners <= (p.maxRunners ?? 10))) throw new HttpError(400, `runners must be 1..${p.maxRunners ?? 10}`);
      if (runners > vus) throw new HttpError(400, 'runners cannot exceed VUs');
    }
    await checkCloudLimits(p, vus, durationSec);
  }

  const id = newRunId();
  const now = new Date().toISOString();
  const run = {
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
    createdBy: ctx.tokenName,
    createdAt: now,
  };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: run }));
  return json(201, { runId: id, uploads: { archive: await presignPut(`${runPrefix(id)}/archive.tar`) } });
}

async function startRun(ctx, id) {
  const run = await loadOwnRun(ctx, id);
  if (run.mode !== 'cloud') throw new HttpError(400, 'only cloud runs are started on AWS');
  if (run.status !== 'created') throw new HttpError(409, `run is already ${run.status}`);
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: `${runPrefix(id)}/archive.tar` }));
  } catch {
    throw new HttpError(409, 'upload the test archive first');
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

async function uploadUrls(ctx, id) {
  const run = await loadOwnRun(ctx, id);
  if (run.mode !== 'local') throw new HttpError(400, 'only local runs upload their own results');
  const base = `${runPrefix(id)}/runner-1`;
  return json(200, {
    summary: await presignPut(`${base}/summary.json`),
    report: await presignPut(`${base}/report.html`),
  });
}

async function finishRun(ctx, id, event) {
  const run = await loadOwnRun(ctx, id);
  if (run.mode !== 'local') throw new HttpError(400, 'only local runs are finished by the client');
  if (run.status !== 'created' && run.status !== 'running') throw new HttpError(409, `run is already ${run.status}`);
  const exitCode = Number(body(event).exitCode);
  const summary = await readJson(`${runPrefix(id)}/runner-1/summary.json`);
  const part = summarize(summary);
  const result = { ...mergeSummaries([part]), runners: [{ runner: 1, exitCode, ...part }] };
  const status = summary ? statusFromExitCodes([exitCode]) : 'error';
  const updated = await updateRun(id, { status, result, finishedAt: new Date().toISOString(), error: summary ? undefined : 'no summary uploaded' });
  return json(200, publicRun(updated));
}

/** Running ECS tasks whose RUN_ID override matches this run. */
async function runTasks(id) {
  const cluster = process.env.CLUSTER;
  const out = [];
  let nextToken;
  do {
    const page = await ecs.send(new ListTasksCommand({ cluster, desiredStatus: 'RUNNING', nextToken })).catch(() => ({}));
    const arns = page.taskArns || [];
    if (arns.length) {
      const d = await ecs.send(new DescribeTasksCommand({ cluster, tasks: arns })).catch(() => ({ tasks: [] }));
      for (const t of d.tasks || []) {
        const env = t.overrides?.containerOverrides?.flatMap((o) => o.environment || []) || [];
        if (env.some((e) => e.name === 'RUN_ID' && e.value === id)) out.push(t.taskArn);
      }
    }
    nextToken = page.nextToken;
  } while (nextToken);
  return out;
}

async function stopRun(ctx, id) {
  const run = await loadOwnRun(ctx, id);
  if (!['created', ...ACTIVE].includes(run.status)) return json(200, publicRun(run));
  if (run.executionArn) {
    await sfn.send(new StopExecutionCommand({ executionArn: run.executionArn, cause: `stopped by ${ctx.tokenName}` })).catch(() => {});
  }
  if (run.mode === 'cloud') {
    // Step Functions stops its runTask.sync tasks when the execution stops; this is a safety net.
    for (const t of await runTasks(id)) {
      await ecs.send(new StopTaskCommand({ cluster: process.env.CLUSTER, task: t, reason: 'k6kt stop' })).catch(() => {});
    }
    await deleteKey(`${runPrefix(id)}/env.json`);
  }
  const updated = await updateRun(id, { status: 'stopped', finishedAt: new Date().toISOString(), stoppedBy: ctx.tokenName });
  return json(200, publicRun(updated));
}

async function getRunHandler(ctx, id) {
  const run = await loadOwnRun(ctx, id);
  const out = publicRun(run);
  if (run.mode === 'cloud' && ACTIVE.includes(run.status) && run.runners) {
    out.progress = await Promise.all(
      Array.from({ length: run.runners }, (_, i) => readJson(`${runPrefix(id)}/runner-${i + 1}/progress.json`)),
    );
  }
  return json(200, out);
}

async function listRuns(ctx, event) {
  const limit = Math.min(Number(event.queryStringParameters?.limit) || 20, 100);
  const runs = await projectRuns(ctx.project.name, { limit });
  return json(200, { runs: runs.slice(0, limit).map(publicRun) });
}

async function reportLink(ctx, id, event) {
  const run = await loadOwnRun(ctx, id);
  const q = event.queryStringParameters || {};
  const file = q.file || 'report';
  const runner = Number(q.runner || 1);
  const n = run.mode === 'cloud' ? run.runners || 1 : 1;
  if (!(runner >= 1 && runner <= n)) throw new HttpError(400, `runner must be 1..${n}`);
  const keys = {
    report: [`${runPrefix(id)}/runner-${runner}/report.html`, 'text/html; charset=utf-8'],
    summary: [`${runPrefix(id)}/runner-${runner}/summary.json`, 'application/json'],
    result: [`${runPrefix(id)}/result.json`, 'application/json'],
  };
  if (!keys[file]) throw new HttpError(400, 'file must be report, summary or result');
  const [Key, type] = keys[file];
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key }));
  } catch {
    throw new HttpError(404, `${file} not available for this run${file === 'report' ? ' (k6 skips the HTML report for runs under ~30s)' : ''}`);
  }
  const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key, ResponseContentType: type }), { expiresIn: LINK_TTL });
  return json(200, { url, expiresInSeconds: LINK_TTL, runners: n });
}

function publicRun(r) {
  if (!r) return r;
  const { pk, gsi1pk, gsi1sk, executionArn, ...rest } = r;
  return rest;
}

const routes = [
  ['GET', /^\/whoami$/, (c) => whoami(c)],
  ['POST', /^\/runs$/, (c, e) => createRun(c, e)],
  ['GET', /^\/runs$/, (c, e) => listRuns(c, e)],
  ['GET', /^\/runs\/(r-[a-f0-9]+)$/, (c, e, m) => getRunHandler(c, m[1])],
  ['POST', /^\/runs\/(r-[a-f0-9]+)\/start$/, (c, e, m) => startRun(c, m[1])],
  ['POST', /^\/runs\/(r-[a-f0-9]+)\/uploads$/, (c, e, m) => uploadUrls(c, m[1])],
  ['POST', /^\/runs\/(r-[a-f0-9]+)\/finish$/, (c, e, m) => finishRun(c, m[1], e)],
  ['POST', /^\/runs\/(r-[a-f0-9]+)\/stop$/, (c, e, m) => stopRun(c, m[1])],
  ['GET', /^\/runs\/(r-[a-f0-9]+)\/report$/, (c, e, m) => reportLink(c, m[1], e)],
];

export async function handler(event) {
  const method = event.requestContext?.http?.method;
  const path = (event.rawPath || '/').replace(/\/+$/, '') || '/';
  try {
    if (method === 'GET' && path === '/health') return json(200, { ok: true });
    const route = routes.find(([m, re]) => m === method && re.test(path));
    if (!route) throw new HttpError(404, `no route ${method} ${path}`);
    const ctx = await auth(event);
    return await route[2](ctx, event, path.match(route[1]));
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.message });
    if (e.name === 'ConditionalCheckFailedException') return json(409, { error: 'run changed state, try again' });
    console.error(e);
    return json(500, { error: 'internal error' });
  }
}
