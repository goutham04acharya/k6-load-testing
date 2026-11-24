import { getApiUrl, type Me } from '../lib/api';
import { fmtNum } from '../lib/format';
import { useToast } from '../components/feedback';

export function Settings({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  const p = me.project;
  const toast = useToast();
  const copy = (text: string) => navigator.clipboard?.writeText(text).then(() => toast('Copied'), () => toast('Could not copy', 'error'));
  const cli = `loadtest login --api ${getApiUrl()} --token <your-token>
loadtest run test.js --cloud
loadtest open`;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p>Your project, its limits, and how to run the same tests from the command line.</p>
        </div>
      </div>
      <div className="stack" style={{ gap: 20, maxWidth: 820 }}>
        <section className="card">
          <div className="card-head"><div><h2>Project limits</h2><p>Set by an admin with <code>backend/scripts/create-project.sh</code>.</p></div></div>
          <div className="card-pad">
            <dl className="summary-list">
              <div><dt>Project</dt><dd>{p.name}</dd></div>
              <div><dt>Max users per test</dt><dd>{fmtNum(p.maxVus)}</dd></div>
              <div><dt>Max test length</dt><dd>{p.maxMinutes} minutes</dd></div>
              <div><dt>Tests running at once</dt><dd>{p.maxConcurrent}</dd></div>
              <div><dt>Max machines per test</dt><dd>{p.maxRunners}</dd></div>
              <div><dt>Monthly budget</dt><dd>{p.maxVuHoursMonth ? `${fmtNum(p.maxVuHoursMonth)} VU-hours` : 'No limit'}</dd></div>
            </dl>
          </div>
        </section>

        <section className="card">
          <div className="card-head"><div><h2>Secrets</h2><p>Passwords and API keys used by tests.</p></div></div>
          <div className="card-pad stack">
            <p style={{ margin: 0 }}>Don't type passwords into tests. An admin stores them once per project, and they reach your test as <code>{'{{NAME}}'}</code> or <code>__ENV.NAME</code>:</p>
            <pre className="code">backend/scripts/set-secret.sh {p.name} TEST_PASS</pre>
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <div><h2>Command line (loadtest)</h2><p>Same runs, same reports. Useful in CI pipelines.</p></div>
            <button className="btn btn-sm" onClick={() => copy(cli)}>Copy</button>
          </div>
          <div className="card-pad"><pre className="code">{cli}</pre></div>
        </section>

        <section className="card">
          <div className="card-head"><div><h2>Session</h2><p>Signed in with token “{me.token}”.</p></div></div>
          <div className="card-pad"><button className="btn btn-danger" onClick={onSignOut}>Sign out</button></div>
        </section>
      </div>
    </>
  );
}
