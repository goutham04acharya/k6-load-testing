// Step Functions "Prepare": decide machine count/size, split the load into k6
// execution segments, stage env values + secrets, and return one item per machine.
import { SSMClient, GetParametersByPathCommand } from '@aws-sdk/client-ssm';
import { getRun, runPrefix, scriptFile, updateRun, writeJson } from '../../lib/store.ts';

const ssm = new SSMClient({});

interface Size { name: string; maxVus: number; taskDef: string }

// Users per machine by size. Starting estimates for simple HTTP scripts.
const SIZES: Size[] = [
  { name: 'small', maxVus: 100, taskDef: process.env.TASK_DEF_SMALL ?? '' },
  { name: 'medium', maxVus: 250, taskDef: process.env.TASK_DEF_MEDIUM ?? '' },
  { name: 'large', maxVus: 500, taskDef: process.env.TASK_DEF_LARGE ?? '' },
];
const LARGE = SIZES[2];

export function plan(vus: number, runnersRequested?: number): { runners: number; size: Size } {
  const runners = runnersRequested || Math.max(1, Math.ceil(vus / LARGE.maxVus));
  const perRunner = Math.ceil(vus / runners);
  return { runners, size: SIZES.find((s) => perRunner <= s.maxVus) ?? LARGE };
}

export function segments(n: number): { sequence: string; list: string[] } {
  if (n === 1) return { sequence: '', list: [''] };
  const points = Array.from({ length: n + 1 }, (_, i) => (i === 0 ? '0' : i === n ? '1' : `${i}/${n}`));
  return { sequence: points.join(','), list: Array.from({ length: n }, (_, i) => `${points[i]}:${points[i + 1]}`) };
}

/** Machines start within ~60 s; big tests get extra time because Fargate launches ~20 tasks per second. */
export const startDelaySec = (runners: number) => (runners > 1 ? 60 + Math.ceil(runners / 20) * 5 : 0);

async function projectSecrets(project: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let NextToken: string | undefined;
  do {
    const r = await ssm.send(new GetParametersByPathCommand({
      Path: `${process.env.SECRETS_PATH_PREFIX}${project}/`,
      WithDecryption: true,
      Recursive: false,
      NextToken,
    }));
    for (const p of r.Parameters ?? []) if (p.Name && p.Value != null) out[p.Name.split('/').pop()!] = p.Value;
    NextToken = r.NextToken;
  } while (NextToken);
  return out;
}

export async function handler({ runId }: { runId: string }) {
  const run = await getRun(runId);
  if (!run) throw new Error(`run ${runId} not found`);
  if (run.status !== 'queued') throw new Error(`run ${runId} is ${run.status}, expected queued`);

  const { runners, size } = plan(run.maxVUs, run.runnersRequested);
  const seg = segments(runners);
  const delay = startDelaySec(runners);
  const startAt = delay ? Math.floor(Date.now() / 1000) + delay : 0;
  const maxSeconds = run.durationSec + 60; // the test's own length (incl. graceful stop) + slack

  // Values from the web app / CLI, then project secrets (secrets win). Kept out of Step Functions history.
  await writeJson(`${runPrefix(runId)}/env.json`, { ...(run.env ?? {}), ...(await projectSecrets(run.project)) });

  await updateRun(runId, { status: 'running', runners, runnerSize: size.name, plannedAt: new Date().toISOString() }, { onlyIfStatus: ['queued'] });

  return {
    runners: seg.list.map((segment, i) => ({
      runNo: i + 1,
      taskDef: size.taskDef,
      capacityProvider: run.spot ? 'FARGATE_SPOT' : 'FARGATE',
      // Hard limit for the whole task: image pull + start wait + test + upload.
      timeoutSeconds: maxSeconds + delay + 900,
      env: [
        { Name: 'RUN_ID', Value: runId },
        { Name: 'RUNNER_NO', Value: String(i + 1) },
        { Name: 'RUNNERS', Value: String(runners) },
        { Name: 'SEGMENT', Value: segment },
        { Name: 'SEQUENCE', Value: seg.sequence },
        { Name: 'START_AT', Value: String(startAt) },
        { Name: 'MAX_SECONDS', Value: String(maxSeconds) },
        { Name: 'MAX_VUS', Value: String(run.maxVUs) },
        { Name: 'SCRIPT_FILE', Value: scriptFile(run) },
      ],
    })),
  };
}
