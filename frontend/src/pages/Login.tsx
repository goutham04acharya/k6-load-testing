import { useState, type FormEvent } from 'react';
import { api, ApiError, setToken, type Me } from '../lib/api';
import { Logo, Spinner } from '../components/ui';
import { LineChart } from '../components/LineChart';

const demo = Array.from({ length: 40 }, (_, i) => ({ x: i * 6, y: Math.round(180 + 40 * Math.sin(i / 4) + (i > 20 ? 60 : i * 3)) }));

export function Login({ onSignedIn }: { onSignedIn: (me: Me) => void }) {
  const [token, setTok] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const me = await api<Me>('GET', '/whoami', undefined, token.trim());
      setToken(token.trim());
      onSignedIn(me);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? 'That token is not valid or was revoked.' : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="hero" data-theme="dark">
      <div className="hero-copy">
        <div className="row" style={{ gap: 10 }}>
          <Logo size={34} />
          <strong style={{ fontSize: 18 }}>Load Testing k6</strong>
        </div>
        <h1>Load test any API. <em>From one page.</em></h1>
        <p>Pick your endpoints, choose how many users, press Run. Tests run on AWS machines in Mumbai and every result is saved with a shareable report.</p>
        <ul className="hero-points">
          <li>From 1 to thousands of virtual users</li>
          <li>Live charts while the test runs</li>
          <li>PDF and HTML reports for every run</li>
        </ul>
        <form className="hero-card" onSubmit={submit}>
          <div>
            <h2 style={{ fontSize: 18 }}>Sign in</h2>
            <p className="muted small" style={{ margin: '4px 0 0' }}>Use your API token (the same one the loadtest CLI uses).</p>
          </div>
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            placeholder="ltk6_…"
            aria-label="API token"
            value={token}
            onChange={(e) => setTok(e.target.value)}
            required
          />
          {error && <div className="alert alert-error">{error}</div>}
          <button className="btn btn-primary btn-lg" disabled={busy || !token.trim()}>
            {busy ? <Spinner /> : 'Sign in'}
          </button>
          <p className="muted small" style={{ margin: 0 }}>No token? Ask an admin to run <code>backend/scripts/create-token.sh &lt;project&gt; &lt;your-name&gt;</code>.</p>
        </form>
      </div>
      <div className="hero-art" aria-hidden="true">
        <div style={{ width: '80%', maxWidth: 520, background: '#10232a', border: '1px solid #213940', borderRadius: 14, padding: 20, color: '#e8f1f2', ['--series' as string]: '#32e6e2', ['--grid' as string]: '#1b3138', ['--muted' as string]: '#8fa3a8', ['--surface' as string]: '#10232a', ['--line-strong' as string]: '#2d4a52' }}>
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ color: '#8fa3a8', fontSize: 13 }}>p95 response time</span>
            <strong style={{ fontSize: 22 }}>214 ms</strong>
          </div>
          <LineChart points={demo} format={(v) => `${Math.round(v)} ms`} label="Example chart" height={220} />
        </div>
      </div>
    </div>
  );
}
