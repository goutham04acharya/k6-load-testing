import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, FINISHED, isActive, type Me, type Run, type RunStatus } from '../lib/api';
import { fmtDuration, fmtMs, fmtNum, fmtPct, fmtWhen } from '../lib/format';
import { Spinner, StatusBadge } from '../components/ui';

type Filter = 'all' | 'active' | 'passed' | 'failed';
const FILTERS: [Filter, string][] = [['all', 'All'], ['active', 'Running'], ['passed', 'Passed'], ['failed', 'Failed']];

const matches = (s: RunStatus, f: Filter) =>
  f === 'all' || (f === 'active' && isActive(s)) || (f === 'passed' && s === 'passed') || (f === 'failed' && (s === 'failed' || s === 'error'));

export function Runs({ me }: { me: Me }) {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const nav = useNavigate();

  const load = useCallback(async () => {
    try {
      setRuns((await api<{ runs: Run[] }>('GET', '/runs?limit=200')).runs);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  const anyActive = runs?.some((r) => isActive(r.status));
  useEffect(() => {
    if (!anyActive) return;
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [anyActive, load]);

  const stats = useMemo(() => {
    const list = (runs ?? []).filter((r) => r.status !== 'created');
    const month = new Date().toISOString().slice(0, 7);
    const thisMonth = list.filter((r) => r.createdAt.startsWith(month));
    const done = list.filter((r) => ['passed', 'failed', 'error'].includes(r.status));
    return {
      month: thisMonth.length,
      passRate: done.length ? done.filter((r) => r.status === 'passed').length / done.length : null,
      active: list.filter((r) => isActive(r.status)).length,
      vuh: thisMonth.filter((r) => r.mode === 'cloud').reduce((a, r) => a + (r.maxVUs * r.durationSec) / 3600, 0),
    };
  }, [runs]);

  const q = query.trim().toLowerCase();
  const shown = (runs ?? []).filter((r) =>
    r.status !== 'created' && matches(r.status, filter) &&
    (!q || r.scriptName.toLowerCase().includes(q) || r.id.includes(q) || r.createdBy.toLowerCase().includes(q)));

  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p.slice(-1), id]));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Load tests</h1>
          <p>Every run in project <strong>{me.project.name}</strong>, newest first.</p>
        </div>
        <Link to="/new" className="btn btn-primary btn-lg">+ New test</Link>
      </div>

      <div className="stats" style={{ marginBottom: 20 }}>
        <div className="stat"><div className="k">Runs this month</div><div className="v">{fmtNum(stats.month)}</div></div>
        <div className="stat"><div className="k">Pass rate</div><div className="v">{fmtPct(stats.passRate, 0)}</div><div className="s">of finished runs</div></div>
        <div className="stat"><div className="k">Running now</div><div className="v">{stats.active}</div><div className="s">limit {me.project.maxConcurrent} at once</div></div>
        <div className="stat"><div className="k">VU-hours this month</div><div className="v">{stats.vuh.toFixed(1)}</div><div className="s">of {me.project.maxVuHoursMonth ?? '∞'} budget</div></div>
      </div>

      <div className="card">
        <div className="card-head" style={{ flexWrap: 'wrap' }}>
          <div className="tabs" role="tablist" aria-label="Filter runs">
            {FILTERS.map(([k, l]) => (
              <button key={k} role="tab" aria-selected={filter === k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{l}</button>
            ))}
          </div>
          <div className="row">
            <div className="search">
              <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="m11 11 3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
              <input className="input" placeholder="Search test, run id or person" aria-label="Search runs" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <button className="btn btn-sm btn-ghost" onClick={load}>Refresh</button>
          </div>
        </div>
        {error && <div className="card-pad"><div className="alert alert-error">{error}</div></div>}
        {!runs && !error && <div className="card-pad" style={{ display: 'grid', placeItems: 'center', padding: 48 }}><Spinner /></div>}
        {runs && shown.length === 0 && (
          <div className="empty">
            <h2>{runs.length === 0 ? 'No tests yet' : 'Nothing here'}</h2>
            <p>{runs.length === 0 ? 'Pick the APIs you want to test, choose how many users, and press Run.' : 'No runs match this filter or search.'}</p>
            {runs.length === 0 && <Link to="/new" className="btn btn-primary">Create your first test</Link>}
          </div>
        )}
        {shown.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th className="sel"><span className="sr-only">Compare</span></th>
                  <th>Status</th>
                  <th>Test</th>
                  <th className="n">Users</th>
                  <th className="n">Length</th>
                  <th className="n">p95</th>
                  <th className="n">Errors</th>
                  <th>Started</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id} className="click" onClick={() => nav(`/runs/${r.id}`)}>
                    <td className="sel" onClick={(e) => e.stopPropagation()}>
                      {FINISHED.includes(r.status) && r.result && (
                        <input type="checkbox" aria-label={`Compare ${r.id}`} checked={picked.includes(r.id)} onChange={() => toggle(r.id)} />
                      )}
                    </td>
                    <td><StatusBadge status={r.status} /></td>
                    <td>
                      <Link to={`/runs/${r.id}`} className="script" style={{ textDecoration: 'none' }} onClick={(e) => e.stopPropagation()}>{r.scriptName}</Link>
                      <div className="sub">{r.id} · {r.mode === 'cloud' ? `AWS${r.runners ? `, ${r.runners} machine${r.runners > 1 ? 's' : ''}` : ''}` : 'laptop'} · {r.source === 'web' ? 'web' : 'CLI'}</div>
                    </td>
                    <td className="n">{fmtNum(r.maxVUs)}</td>
                    <td className="n">{fmtDuration(Math.max(0, r.durationSec - 30))}</td>
                    <td className="n">{fmtMs(r.result?.p95Ms)}</td>
                    <td className="n">{r.result ? fmtPct(r.result.errorRate) : '–'}</td>
                    <td><span title={r.createdAt}>{fmtWhen(r.createdAt)}</span><div className="sub">{r.createdBy}</div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {picked.length > 0 && (
        <div className="compare-bar" role="region" aria-label="Compare runs">
          {picked.length === 1 ? 'Pick one more finished run to compare' : '2 runs selected'}
          <button className="btn btn-sm btn-primary" disabled={picked.length < 2} onClick={() => nav(`/compare?a=${picked[0]}&b=${picked[1]}`)}>Compare</button>
          <button className="btn btn-sm btn-ghost" style={{ color: 'inherit' }} onClick={() => setPicked([])}>Clear</button>
        </div>
      )}
    </>
  );
}
