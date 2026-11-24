import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, FINISHED, isActive, type Progress, type Run } from '../lib/api';
import { fmtDate, fmtDuration, fmtMs, fmtNum, fmtPct } from '../lib/format';
import { LineChart, type Point } from '../components/LineChart';
import { Spinner, StatusBadge } from '../components/ui';
import { ConfirmDialog, useToast } from '../components/feedback';

interface Sample { x: number; t: number; vus: number; requests: number; rps: number; p95: number; err: number }

const PHASES = ['Queued', 'Starting machines', 'Synchronised start', 'Running', 'Results'];

function phaseIndex(run: Run): number {
  if (FINISHED.includes(run.status)) return 5;
  if (run.status === 'queued' || run.status === 'created') return 0;
  const prog = (run.progress ?? []).filter(Boolean) as Progress[];
  const n = run.runners ?? 1;
  if (prog.length === n && prog.every((p) => p.phase === 'finished')) return 4;
  if (prog.some((p) => p.phase === 'running')) return 3;
  if (prog.some((p) => p.phase === 'ready')) return 2;
  return 1;
}

const storeKey = (id: string) => `load-testing-k6.samples.${id}`;
function loadSamples(id: string): Sample[] {
  try { return JSON.parse(sessionStorage.getItem(storeKey(id)) || '[]'); } catch { return []; }
}
function saveSamples(id: string, s: Sample[]) {
  try { sessionStorage.setItem(storeKey(id), JSON.stringify(s)); } catch { /* storage unavailable: keep in memory */ }
}

export function RunDetail() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState('');
  const [samples, setSamples] = useState<Sample[]>(() => loadSamples(id));
  const [shareUrl, setShareUrl] = useState('');
  const [stopping, setStopping] = useState(false);
  const [askStop, setAskStop] = useState(false);
  const toast = useToast();
  const startT = useRef<number | null>(samples[0]?.t ?? null);

  const poll = useCallback(async () => {
    try {
      const r = await api<Run>('GET', `/runs/${id}`);
      setRun(r);
      setError('');
      const running = ((r.progress ?? []).filter(Boolean) as Progress[]).filter((p) => p.phase === 'running');
      if (running.length) {
        const t = Math.max(...running.map((p) => p.t));
        if (startT.current == null) startT.current = t - 10;
        const requests = running.reduce((a, p) => a + (p.requests ?? 0), 0);
        const failed = running.reduce((a, p) => a + (p.failedRate ?? 0) * (p.requests ?? 0), 0);
        setSamples((prev) => {
          if (prev.length && prev[prev.length - 1].t >= t) return prev;
          const last = prev[prev.length - 1];
          const s: Sample = {
            t,
            x: t - startT.current!,
            vus: running.reduce((a, p) => a + (p.vus ?? 0), 0),
            requests,
            rps: last ? Math.max(0, (requests - last.requests) / Math.max(1, t - last.t)) : requests / 10,
            p95: Math.max(...running.map((p) => p.p95Ms ?? 0)),
            err: requests ? failed / requests : 0,
          };
          const next = [...prev, s];
          saveSamples(id, next);
          return next;
        });
      }
      return r;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  }, [id]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let alive = true;
    const tick = async () => {
      const r = await poll();
      if (alive && (!r || isActive(r.status))) timer = setTimeout(tick, 4000);
    };
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [poll]);

  const finished = run ? FINISHED.includes(run.status) : false;
  useEffect(() => {
    if (!finished) return;
    api<{ shareUrl: string }>('GET', `/runs/${id}/link`).then((r) => setShareUrl(r.shareUrl)).catch(() => {});
  }, [finished, id]);

  const stop = async () => {
    setAskStop(false);
    setStopping(true);
    try {
      setRun(await api<Run>('POST', `/runs/${id}/stop`));
      toast('Test stopped');
    } catch (e) {
      setError((e as Error).message);
      toast('Could not stop the test', 'error');
    } finally {
      setStopping(false);
    }
  };

  if (!run) {
    return error ? <div className="alert alert-error">{error}</div> : <div style={{ display: 'grid', placeItems: 'center', padding: 80 }}><Spinner /></div>;
  }

  const phase = phaseIndex(run);
  const loadLen = Math.max(1, run.durationSec - 30);
  const last = samples[samples.length - 1];
  const elapsed = last?.x ?? 0;
  const pct = finished ? 100 : Math.min(100, (elapsed / loadLen) * 100);
  const r = run.result;
  const pts = (k: keyof Sample): Point[] => samples.map((s) => ({ x: s.x, y: s[k] as number }));

  return (
    <>
      <div className="page-head">
        <div>
          <div className="crumbs"><Link to="/">Runs</Link> / {run.id}</div>
          <div className="row" style={{ gap: 12 }}>
            <h1>{run.scriptName}</h1>
            <StatusBadge status={run.status} />
          </div>
          <p>
            {fmtNum(run.maxVUs)} users · {fmtDuration(loadLen)} · {run.mode === 'cloud' ? `AWS Mumbai${run.runners ? `, ${run.runners} × ${run.runnerSize} machine${run.runners > 1 ? 's' : ''}` : ''}${run.spot ? ' (Spot)' : ''}` : 'laptop'} · started {fmtDate(run.createdAt)} by {run.createdBy}
          </p>
        </div>
        <div className="row">
          {isActive(run.status) && <button className="btn btn-danger" onClick={() => setAskStop(true)} disabled={stopping}>{stopping ? <Spinner /> : 'Stop test'}</button>}
          {finished && run.format === 'js' && <button className="btn" onClick={() => nav(`/new?from=${run.id}`)}>Run again</button>}
          {finished && shareUrl && <a className="btn" href={`${shareUrl}/pdf`}>Download PDF</a>}
          {finished && shareUrl && <a className="btn btn-primary" href={shareUrl} target="_blank" rel="noreferrer">Open report ↗</a>}
        </div>
      </div>

      {error && <div className="alert alert-error" style={{ marginBottom: 16 }}>{error}</div>}
      {run.error && <div className="alert alert-error" style={{ marginBottom: 16 }}>{run.error}</div>}

      {!finished && (
        <div className="card card-pad stack" style={{ marginBottom: 20 }}>
          <div className="phase-track" aria-label="Progress">
            {PHASES.map((name, i) => (
              <div key={name} className={`phase ${i < phase ? 'done' : i === phase ? 'now' : ''}`}>
                <div className="bar" />
                {name}
              </div>
            ))}
          </div>
          <div className="row small" style={{ justifyContent: 'space-between' }}>
            <span className="muted">
              {phase <= 1 && 'AWS is starting the machines. This takes about 30–60 seconds.'}
              {phase === 2 && 'Machines are ready and waiting so they all start at the same moment.'}
              {phase === 3 && `Running: ${fmtDuration(elapsed)} of about ${fmtDuration(loadLen)}`}
              {phase === 4 && 'Test finished. Combining results from all machines…'}
            </span>
            {phase === 3 && <strong>{Math.round(pct)}%</strong>}
          </div>
          {phase >= 3 && <div className="progress"><div style={{ width: `${pct}%` }} /></div>}
        </div>
      )}

      {finished && r && (
        <div className="stats" style={{ marginBottom: 20 }}>
          <div className="stat"><div className="k">Requests</div><div className="v">{fmtNum(r.requests)}</div><div className="s">{r.rps.toFixed(1)} per second</div></div>
          <div className="stat"><div className="k">p95 response time</div><div className="v">{fmtMs(r.p95Ms)}</div><div className="s">avg {fmtMs(r.avgMs)} · max {fmtMs(r.maxMs)}</div></div>
          <div className="stat"><div className="k">Error rate</div><div className="v">{fmtPct(r.errorRate)}</div><div className="s">{fmtNum(r.failedRequests)} failed</div></div>
          <div className="stat"><div className="k">Checks passed</div><div className="v">{fmtPct(r.checksRate)}</div><div className="s">{fmtNum(r.checksFailed)} failed</div></div>
        </div>
      )}

      {(samples.length > 0 || isActive(run.status)) && (
        <div className="charts" style={{ marginBottom: 20 }}>
          <ChartCard title="Active users" value={last ? fmtNum(last.vus) : '–'} points={pts('vus')} format={(v) => fmtNum(v)} xMax={loadLen} />
          <ChartCard title="Requests per second" value={last ? last.rps.toFixed(1) : '–'} points={pts('rps')} format={(v) => (v >= 100 ? fmtNum(v) : v.toFixed(1))} xMax={loadLen} />
          <ChartCard title="p95 response time" value={last ? fmtMs(last.p95) : '–'} points={pts('p95')} format={(v) => fmtMs(v)} xMax={loadLen} />
          <ChartCard title="Error rate" value={last ? fmtPct(last.err) : '–'} points={pts('err')} format={(v) => fmtPct(v, 1)} xMax={loadLen} />
        </div>
      )}
      {finished && samples.length === 0 && (
        <p className="muted small">Live charts are shown only while you watch a run. The full report below has charts for the whole test.</p>
      )}

      {finished && (r?.endpoints?.length ?? 0) > 0 && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="card-head"><div><h2>Per API</h2><p>Each API you picked, measured separately. Slowest p95 first.</p></div></div>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>API</th><th className="n">Requests</th><th className="n">Errors</th><th className="n">Average</th><th className="n">p95</th><th className="n">Slowest</th></tr></thead>
              <tbody>
                {[...(r?.endpoints ?? [])].sort((x, y) => (y.p95Ms ?? 0) - (x.p95Ms ?? 0)).map((e) => (
                  <tr key={e.name}>
                    <td className="script">{e.name}</td>
                    <td className="n">{fmtNum(e.requests)}</td>
                    <td className="n" style={{ color: e.failed ? 'var(--bad)' : undefined }}>{fmtPct(e.errorRate)}</td>
                    <td className="n">{fmtMs(e.avgMs)}</td>
                    <td className="n"><strong>{fmtMs(e.p95Ms)}</strong></td>
                    <td className="n">{fmtMs(e.maxMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {finished && (
        <div className="card">
          <div className="card-head">
            <div><h2>Report</h2><p>Thresholds, checks, timing breakdown and the full k6 report. Share the link with anyone.</p></div>
            {shareUrl && <button className="btn btn-sm" onClick={() => navigator.clipboard?.writeText(shareUrl).then(() => toast('Share link copied'), () => toast('Could not copy', 'error'))}>Copy share link</button>}
          </div>
          {shareUrl ? <iframe className="report-frame" src={shareUrl} title="Run report" /> : <div className="card-pad"><Spinner /></div>}
        </div>
      )}

      <ConfirmDialog
        open={askStop}
        title="Stop this test?"
        text="The machines shut down now. Results collected so far are kept, and the run is marked Stopped."
        confirmLabel="Stop test"
        danger
        onConfirm={stop}
        onCancel={() => setAskStop(false)}
      />
    </>
  );
}

function ChartCard({ title, value, points, format, xMax }: { title: string; value: string; points: Point[]; format: (v: number) => string; xMax: number }) {
  return (
    <div className="card chart-card">
      <div className="title"><strong>{title}</strong><span>{value}</span></div>
      <LineChart points={points} format={format} label={title} xMax={xMax} emptyText="Waiting for the first numbers (every 10 s)…" />
    </div>
  );
}
