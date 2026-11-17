// Step Functions "Prepare": decide runner count/size, split the load into k6
// execution segments, stage secrets, and return one item per runner for the Map state.
import { SSMClient, GetParametersByPathCommand } from '@aws-sdk/client-ssm';
import { getRun, updateRun, writeJson, runPrefix } from './lib.mjs';

const ssm = new SSMClient({});

// VUs per runner by size. Starting estimates for simple HTTP scripts.
const SIZES = [
  { name: 'small', maxVus: 100, taskDef: process.env.TASK_DEF_SMALL },
  { name: 'medium', maxVus: 250, taskDef: process.env.TASK_DEF_MEDIUM },
  { name: 'large', maxVus: 500, taskDef: process.env.TASK_DEF_LARGE },
];
const LARGE = SIZES[2];

export function plan(vus, runnersRequested) {
  const runners = runnersRequested || Math.max(1, Math.ceil(vus / LARGE.maxVus));
  const perRunner = Math.ceil(vus / runners);
  const size = SIZES.find((s) => perRunner <= s.maxVus) || LARGE;
  return { runners, size };
}

export function segments(n) {
  if (n === 1) return { sequence: '', list: [''] };
  const points = Array.from({ length: n + 1 }, (_, i) => (i === 0 ? '0' : i === n ? '1' : `${i}/${n}`));
  return {
    sequence: points.join(','),
    list: Array.from({ length: n }, (_, i) => `${points[i]}:${points[i + 1]}`),
  };
}

async function projectSecrets(project) {
  const out = {};
  let NextToken;
  do {
    const r = await ssm.send(new GetParametersByPathCommand({
      Path: `${process.env.SECRETS_PATH_PREFIX}${project}/`,
      WithDecryption: true,
      Recursive: false,
      NextToken,
    }));
    for (const p of r.Parameters || []) out[p.Name.split('/').pop()] = p.Value;
    NextToken = r.NextToken;
  } while (NextToken);
  return out;
}

export async function handler({ runId }) {
  const run = await getRun(runId);
  if (!run) throw new Error(`run ${runId} not found`);
  if (run.status !== 'queued') throw new Error(`run ${runId} is ${run.status}, expected queued`);

  const { runners, size } = plan(run.maxVUs, run.runnersRequested);
  const seg = segments(runners);
  // Multi-runner tests share a start time so the load begins together.
  const startAt = runners > 1 ? Math.floor(Date.now() / 1000) + 60 : 0;
  const maxSeconds = run.durationSec + 60; // k6's own duration (incl. graceful stop) + slack

  // Secrets go to S3 (never into Step Functions history); the runner reads and deletes its copy.
  await writeJson(`${runPrefix(runId)}/env.json`, await projectSecrets(run.project));

  await updateRun(runId, { status: 'running', runners, runnerSize: size.name, plannedAt: new Date().toISOString() }, { onlyIfStatus: ['queued'] });

  return {
    runners: seg.list.map((segment, i) => ({
      runNo: i + 1,
      taskDef: size.taskDef,
      capacityProvider: run.spot ? 'FARGATE_SPOT' : 'FARGATE',
      // Hard limit for the whole task: image pull + start wait + test + upload.
      timeoutSeconds: maxSeconds + 900,
      env: [
        { Name: 'RUN_ID', Value: runId },
        { Name: 'RUNNER_NO', Value: String(i + 1) },
        { Name: 'RUNNERS', Value: String(runners) },
        { Name: 'SEGMENT', Value: segment },
        { Name: 'SEQUENCE', Value: seg.sequence },
        { Name: 'START_AT', Value: String(startAt) },
        { Name: 'MAX_SECONDS', Value: String(maxSeconds) },
        { Name: 'MAX_VUS', Value: String(run.maxVUs) },
      ],
    })),
  };
}
