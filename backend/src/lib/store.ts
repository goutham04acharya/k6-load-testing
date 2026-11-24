// DynamoDB and S3 helpers shared by all functions.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand, type UpdateCommandInput } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import type { Run, RunStatus } from './types.ts';

export const TABLE = process.env.TABLE ?? '';
export const BUCKET = process.env.BUCKET ?? '';

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
export const s3 = new S3Client({});

export const runKey = (id: string) => `RUN#${id}`;
export const runPrefix = (id: string) => `runs/${id}`;
export const scriptFile = (run: Pick<Run, 'format'>) => (run.format === 'js' ? 'script.js' : 'archive.tar');

export async function getItem<T>(pk: string): Promise<T | null> {
  const r = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk } }));
  return (r.Item as T) ?? null;
}

export const getRun = (id: string) => getItem<Run>(runKey(id));

/** SET the given fields on a run. `onlyIfStatus` guards against racing status changes. */
export async function updateRun(id: string, fields: Partial<Run>, opts: { onlyIfStatus?: RunStatus[] } = {}): Promise<Run> {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const sets = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v], i) => {
      names[`#k${i}`] = k;
      values[`:v${i}`] = v;
      return `#k${i} = :v${i}`;
    });
  const params: UpdateCommandInput = {
    TableName: TABLE,
    Key: { pk: runKey(id) },
    UpdateExpression: `SET ${sets.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    ReturnValues: 'ALL_NEW',
  };
  if (opts.onlyIfStatus) {
    names['#status'] = 'status';
    const keys = opts.onlyIfStatus.map((s, i) => {
      values[`:s${i}`] = s;
      return `:s${i}`;
    });
    params.ConditionExpression = `#status IN (${keys.join(', ')})`;
  }
  const r = await ddb.send(new UpdateCommand(params));
  return r.Attributes as Run;
}

export async function readText(key: string): Promise<string | null> {
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    return (await r.Body?.transformToString()) ?? null;
  } catch (e) {
    const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404 || err.$metadata?.httpStatusCode === 403) return null;
    throw e;
  }
}

export async function readJson<T>(key: string): Promise<T | null> {
  const t = await readText(key);
  if (t == null) return null;
  try {
    return JSON.parse(t) as T;
  } catch {
    return null;
  }
}

export async function writeJson(key: string, obj: unknown): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: JSON.stringify(obj), ContentType: 'application/json' }));
}

export async function deleteKey(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key })).catch(() => undefined);
}

export async function exists(key: string): Promise<boolean> {
  return s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key })).then(() => true, () => false);
}
