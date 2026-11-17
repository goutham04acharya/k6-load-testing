// Step Functions "Merge" (action=merge) and "MarkFailed" (action=fail).
import {
  getRun, updateRun, readJson, writeJson, deleteKey, runPrefix,
  summarize, mergeSummaries, statusFromExitCodes, describeExit,
} from './lib.mjs';

export async function handler({ action, runId, error }) {
  const run = await getRun(runId);
  if (!run) throw new Error(`run ${runId} not found`);
  await deleteKey(`${runPrefix(runId)}/env.json`);

  if (action === 'fail') {
    if (run.status === 'stopped') return { status: 'stopped' };
    let message = error?.Error || 'workflow error';
    if (error?.Cause) {
      try {
        const c = JSON.parse(error.Cause);
        message += `: ${c.errorMessage || c.StoppedReason || c.Message || error.Cause}`;
      } catch {
        message += `: ${String(error.Cause)}`;
      }
    }
    message = message.slice(0, 1000);
    await updateRun(runId, { status: 'error', error: message, finishedAt: new Date().toISOString() });
    return { status: 'error' };
  }

  const n = run.runners || 1;
  const runners = await Promise.all(Array.from({ length: n }, async (_, i) => {
    const base = `${runPrefix(runId)}/runner-${i + 1}`;
    const [exit, summary] = await Promise.all([readJson(`${base}/exit.json`), readJson(`${base}/summary.json`)]);
    const exitCode = exit?.exitCode ?? null;
    return {
      runner: i + 1,
      exitCode,
      outcome: exitCode == null ? 'no result uploaded' : describeExit(exitCode),
      error: exit?.error || undefined,
      startedLate: exit?.startedLate || undefined,
      ...summarize(summary),
      hasSummary: Boolean(summary),
    };
  }));

  const merged = mergeSummaries(runners.filter((r) => r.hasSummary));
  const status = statusFromExitCodes(runners.map((r) => r.exitCode));
  const result = { ...merged, runners };
  await writeJson(`${runPrefix(runId)}/result.json`, { runId, status, ...result });

  const failedRunners = runners.filter((r) => r.exitCode !== 0 && r.exitCode !== 99);
  await updateRun(runId, {
    status: run.status === 'stopped' ? 'stopped' : status,
    result,
    error: failedRunners.length ? failedRunners.map((r) => `runner ${r.runner}: ${r.error || r.outcome}`).join('; ') : undefined,
    finishedAt: new Date().toISOString(),
  });
  return { status };
}
