// Step Functions "Merge" (action=merge) and "MarkFailed" (action=fail).
import { deleteKey, getRun, readJson, runPrefix, updateRun, writeJson } from '../../lib/store.ts';
import { describeExit, mergeSummaries, statusFromExitCodes, summarize } from '../../lib/results.ts';
import type { K6Summary, RunnerResult } from '../../lib/types.ts';

interface Input {
  action: 'merge' | 'fail';
  runId: string;
  error?: { Error?: string; Cause?: string };
}

function errorMessage(error: Input['error']): string {
  let message = error?.Error ?? 'workflow error';
  if (error?.Cause) {
    try {
      const c = JSON.parse(error.Cause) as Record<string, string>;
      message += `: ${c.errorMessage ?? c.StoppedReason ?? c.Message ?? error.Cause}`;
    } catch {
      message += `: ${error.Cause}`;
    }
  }
  return message.slice(0, 1000);
}

export async function handler({ action, runId, error }: Input) {
  const run = await getRun(runId);
  if (!run) throw new Error(`run ${runId} not found`);
  await deleteKey(`${runPrefix(runId)}/env.json`);

  if (action === 'fail') {
    if (run.status === 'stopped') return { status: 'stopped' };
    await updateRun(runId, { status: 'error', error: errorMessage(error), finishedAt: new Date().toISOString() });
    return { status: 'error' };
  }

  const n = run.runners ?? 1;
  const runners: RunnerResult[] = await Promise.all(Array.from({ length: n }, async (_, i) => {
    const base = `${runPrefix(runId)}/runner-${i + 1}`;
    const [exit, summary] = await Promise.all([
      readJson<{ exitCode?: number; error?: string | null; startedLate?: boolean }>(`${base}/exit.json`),
      readJson<K6Summary>(`${base}/summary.json`),
    ]);
    const exitCode = exit?.exitCode ?? null;
    return {
      runner: i + 1,
      exitCode,
      outcome: exitCode == null ? 'no result uploaded' : describeExit(exitCode),
      error: exit?.error ?? undefined,
      startedLate: exit?.startedLate || undefined,
      ...summarize(summary),
      hasSummary: Boolean(summary),
    };
  }));

  const status = statusFromExitCodes(runners.map((r) => r.exitCode));
  const result = { ...mergeSummaries(runners.filter((r) => r.hasSummary)), runners };
  await writeJson(`${runPrefix(runId)}/result.json`, { runId, status, ...result });

  const broken = runners.filter((r) => r.exitCode !== 0 && r.exitCode !== 99);
  await updateRun(runId, {
    status: run.status === 'stopped' ? 'stopped' : status,
    result,
    error: broken.length ? broken.map((r) => `machine ${r.runner}: ${r.error ?? r.outcome}`).join('; ') : undefined,
    finishedAt: new Date().toISOString(),
  });
  return { status };
}
