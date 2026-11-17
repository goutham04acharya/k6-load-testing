import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

export const TABLE = process.env.TABLE;
export const BUCKET = process.env.BUCKET;

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
export const s3 = new S3Client({});

export const ACTIVE = ['queued', 'running'];
export const FINAL = ['passed', 'failed', 'error', 'stopped'];

export const runKey = (id) => `RUN#${id}`;
export const runPrefix = (id) => `runs/${id}`;

export async function getItem(pk) {
  const r = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk } }));
  return r.Item || null;
}

export async function getRun(id) {
  return getItem(runKey(id));
}

/** SET the given fields on a run. `onlyIfStatus` guards against racing transitions. */
export async function updateRun(id, fields, { onlyIfStatus } = {}) {
  const names = {};
  const values = {};
  const sets = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v], i) => {
      names[`#k${i}`] = k;
      values[`:v${i}`] = v;
      return `#k${i} = :v${i}`;
    });
  const params = {
    TableName: TABLE,
    Key: { pk: runKey(id) },
    UpdateExpression: `SET ${sets.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    ReturnValues: 'ALL_NEW',
  };
  if (onlyIfStatus) {
    names['#status'] = 'status';
    const keys = onlyIfStatus.map((s, i) => {
      values[`:s${i}`] = s;
      return `:s${i}`;
    });
    params.ConditionExpression = `#status IN (${keys.join(', ')})`;
  }
  const r = await ddb.send(new UpdateCommand(params));
  return r.Attributes;
}

export async function readText(key) {
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    return await r.Body.transformToString();
  } catch (e) {
    if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404 || e.$metadata?.httpStatusCode === 403) return null;
    throw e;
  }
}

export async function readJson(key) {
  const t = await readText(key);
  if (t == null) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

export async function writeJson(key, obj) {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: key, Body: JSON.stringify(obj), ContentType: 'application/json',
  }));
}

export async function deleteKey(key) {
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key })).catch(() => {});
}

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** Pull the numbers we care about out of one k6 --summary-export file. */
export function summarize(summary) {
  const m = summary?.metrics || {};
  const d = m.http_req_duration || {};
  return {
    requests: m.http_reqs?.count || 0,
    rps: m.http_reqs?.rate || 0,
    // http_req_failed is a Rate metric: "passes" = requests that failed.
    failedRequests: m.http_req_failed?.passes || 0,
    avgMs: num(d.avg),
    p90Ms: num(d['p(90)']),
    p95Ms: num(d['p(95)']),
    p99Ms: num(d['p(99)']),
    maxMs: num(d.max),
    checksPassed: m.checks?.passes || 0,
    checksFailed: m.checks?.fails || 0,
    iterations: m.iterations?.count || 0,
    vusMax: m.vus_max?.value || m.vus_max?.max || 0,
    dataSentBytes: m.data_sent?.count || 0,
    dataReceivedBytes: m.data_received?.count || 0,
  };
}

const maxOf = (vals) => {
  const v = vals.filter((x) => x != null);
  return v.length ? Math.max(...v) : null;
};

/**
 * Merge per-runner summaries:
 *  counts and rates are added (exact), averages are weighted by request count (exact),
 *  percentiles and max take the worst runner (a safe upper bound).
 */
export function mergeSummaries(parts) {
  const sum = (k) => parts.reduce((a, p) => a + (p[k] || 0), 0);
  const requests = sum('requests');
  const weighted = parts.reduce((a, p) => a + (p.avgMs != null ? p.avgMs * p.requests : 0), 0);
  const checksPassed = sum('checksPassed');
  const checksFailed = sum('checksFailed');
  const failedRequests = sum('failedRequests');
  return {
    requests,
    rps: sum('rps'),
    failedRequests,
    errorRate: requests ? failedRequests / requests : 0,
    avgMs: requests ? weighted / requests : null,
    p90Ms: maxOf(parts.map((p) => p.p90Ms)),
    p95Ms: maxOf(parts.map((p) => p.p95Ms)),
    p99Ms: maxOf(parts.map((p) => p.p99Ms)),
    maxMs: maxOf(parts.map((p) => p.maxMs)),
    checksPassed,
    checksFailed,
    checksRate: checksPassed + checksFailed ? checksPassed / (checksPassed + checksFailed) : null,
    iterations: sum('iterations'),
    vusMax: sum('vusMax'),
    dataSentBytes: sum('dataSentBytes'),
    dataReceivedBytes: sum('dataReceivedBytes'),
    percentilesNote: parts.length > 1 ? 'p90/p95/p99/max = worst runner' : undefined,
  };
}

/** k6 exit codes -> run status. 0 = passed, 99 = thresholds failed, anything else = error. */
export function statusFromExitCodes(codes) {
  if (codes.some((c) => c == null || (c !== 0 && c !== 99))) return 'error';
  if (codes.some((c) => c === 99)) return 'failed';
  return 'passed';
}

export function describeExit(code) {
  const known = {
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
  return known[code] || `k6 exit code ${code}`;
}
