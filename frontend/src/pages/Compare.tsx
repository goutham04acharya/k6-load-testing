import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, FINISHED, type Run } from '../lib/api';
import { fmtDate, fmtMs, fmtNum, fmtPct } from '../lib/format';
import { Spinner, StatusBadge } from '../components/ui';

type Better = 'lower' | 'higher';
interface Row { label: string; a: number | null | undefined; b: number | null | undefined; fmt: (v?: number | null) => string; better: Better }

/** Change from A (before) to B (after), judged for this metric. */
function Delta({ a, b, better }: { a?: number | null; b?: number | null; better: Better }) {
  if (a == null || b == null) return <span className="delta same">–</span>;
  if (a === 0 && b === 0) return <span className="delta same">no change</span>;
  const pct = a === 0 ? Infinity : ((b - a) / Math.abs(a)) * 100;
  if (Math.abs(pct) < 2) return <span className="delta same">≈ same</span>;
  const good = better === 'lower' ? b < a : b > a;
  const arrow = b > a ? '▲' : '▼';
  const text = Number.isFinite(pct) ? `${Math.abs(pct).toFixed(pct > 99 ? 0 : 1)}%` : 'new';
  return <span className={`delta ${good ? 'better' : 'worse'}`}>{arrow} {text} {good ? 'better' : 'worse'}</span>;
}

export function Compare() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [pair, setPair] = useState<[Run | null, Run | null]>([null, null]);
  const [error, setError] = useState('');
  const a = params.get('a') ?? '';
  const b = params.get('b') ?? '';

  useEffect(() => {
    api<{ runs: Run[] }>('GET', '/runs?limit=200').then((r) => setRuns(r.runs.filter((x) => FINISHED.includes(x.status) && x.result))).catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!a || !b) return setPair([null, null]);
    Promise.all([api<Run>('GET', `/runs/${a}`), api<Run>('GET', `/runs/${b}`)]).then(([x, y]) => setPair([x, y])).catch((e) => setError(e.message));
  }, [a, b]);

  const pick = (which: 'a' | 'b', id: string) => {
    const next = new URLSearchParams(params);
    next.set(which, id);
    nav(`/compare?${next}`);
  };

  const [ra, rb] = pair;
  const rows: Row[] = ra?.result && rb?.result ? [
    { label: 'p95 response time', a: ra.result.p95Ms, b: rb.result.p95Ms, fmt: fmtMs, better: 'lower' },
    { label: 'p99 response time', a: ra.result.p99Ms, b: rb.result.p99Ms, fmt: fmtMs, better: 'lower' },
    { label: 'Average response time', a: ra.result.avgMs, b: rb.result.avgMs, fmt: fmtMs, better: 'lower' },
    { label: 'Slowest request', a: ra.result.maxMs, b: rb.result.maxMs, fmt: fmtMs, better: 'lower' },
    { label: 'Error rate', a: ra.result.errorRate, b: rb.result.errorRate, fmt: (v) => fmtPct(v), better: 'lower' },
    { label: 'Checks passed', a: ra.result.checksRate, b: rb.result.checksRate, fmt: (v) => fmtPct(v), better: 'higher' },
    { label: 'Requests per second', a: ra.result.rps, b: rb.result.rps, fmt: (v) => (v == null ? '–' : v.toFixed(1)), better: 'higher' },
    { label: 'Total requests', a: ra.result.requests, b: rb.result.requests, fmt: fmtNum, better: 'higher' },
  ] : [];

  const endpointNames = [...new Set([...(ra?.result?.endpoints ?? []), ...(rb?.result?.endpoints ?? [])].map((e) => e.name))];

  const options = (runs ?? []).map((r) => <option key={r.id} value={r.id}>{r.scriptName} · {r.id} · {fmtDate(r.createdAt)}</option>);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Compare runs</h1>
          <p>Did this release make it slower? Pick a run before (A) and after (B).</p>
        </div>
      </div>
      {error && <div className="alert alert-error" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="compare-head" style={{ marginBottom: 20 }}>
        {(['a', 'b'] as const).map((w, i) => {
          const r = pair[i];
          return (
            <div key={w} className="card run-chip">
              <span className="label">{w === 'a' ? 'A · before' : 'B · after'}</span>
              {runs ? (
                <select className="input" aria-label={`Run ${w.toUpperCase()}`} value={w === 'a' ? a : b} onChange={(e) => pick(w, e.target.value)}>
                  <option value="">Choose a finished run…</option>
                  {options}
                </select>
              ) : <Spinner />}
              {r && (
                <div className="row small" style={{ gap: 8 }}>
                  <StatusBadge status={r.status} />
                  <span className="muted">{fmtNum(r.maxVUs)} users · {fmtDate(r.createdAt)}</span>
                  <Link to={`/runs/${r.id}`} className="small">Open</Link>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {!a || !b ? (
        <div className="card empty">
          <h2>Choose two runs</h2>
          <p>Tip: on the Runs page, tick two finished runs and press Compare.</p>
        </div>
      ) : !ra || !rb ? (
        <div style={{ display: 'grid', placeItems: 'center', padding: 60 }}><Spinner /></div>
      ) : (
        <div className="stack" style={{ gap: 20 }}>
          {ra.maxVUs !== rb.maxVUs && (
            <div className="alert alert-info">These runs used different loads ({fmtNum(ra.maxVUs)} vs {fmtNum(rb.maxVUs)} users), so differences may come from the load, not the app.</div>
          )}
          <div className="card">
            <div className="card-head"><div><h2>Overall</h2><p>Green means B is better than A; red means worse. Changes under 2% count as the same.</p></div></div>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Metric</th><th className="n">A · before</th><th className="n">B · after</th><th>Change</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.label}><td>{r.label}</td><td className="n">{r.fmt(r.a)}</td><td className="n">{r.fmt(r.b)}</td><td><Delta a={r.a} b={r.b} better={r.better} /></td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          {endpointNames.length > 0 && (
            <div className="card">
              <div className="card-head"><div><h2>Per API · p95 response time</h2><p>Only for tests built with Pick APIs.</p></div></div>
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>API</th><th className="n">A · before</th><th className="n">B · after</th><th>Change</th><th className="n">Errors A → B</th></tr></thead>
                  <tbody>
                    {endpointNames.map((n) => {
                      const ea = ra.result?.endpoints?.find((e) => e.name === n);
                      const eb = rb.result?.endpoints?.find((e) => e.name === n);
                      return (
                        <tr key={n}>
                          <td>{n}</td>
                          <td className="n">{fmtMs(ea?.p95Ms)}</td>
                          <td className="n">{fmtMs(eb?.p95Ms)}</td>
                          <td><Delta a={ea?.p95Ms} b={eb?.p95Ms} better="lower" /></td>
                          <td className="n">{fmtPct(ea?.errorRate)} → {fmtPct(eb?.errorRate)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
