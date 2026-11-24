import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import CodeMirror from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { api, startCloudRun, type Me } from '../lib/api';
import {
  buildScript, defaultQuickConfig, defaultStep, guessFromScript, loadSeconds, METHODS, newId, parseCurl, peakVus, shape,
  GRACEFUL_STOP, SAMPLE_SCRIPT, TEMPLATES, type KV, type Method, type ProfileKind, type QuickConfig, type Step,
} from '../lib/script';
import { useIsDark, useToast } from '../components/feedback';
import { estimate, fmtCost, fmtDuration, fmtNum } from '../lib/format';
import { Field, KeyValueEditor, NumberInput, Spinner } from '../components/ui';
import { LineChart } from '../components/LineChart';

type Mode = 'quick' | 'script';
type SavedConfig = { kind: 'quick'; quick: QuickConfig } | { kind: 'script'; vus: number; minutes: number };

const PROFILES: { kind: ProfileKind; title: string; text: string; path: string }[] = [
  { kind: 'ramp', title: 'Ramp up & down', text: 'Normal load test', path: 'M2 20 L12 6 L26 6 L34 20' },
  { kind: 'constant', title: 'Steady users', text: 'Same users all the time', path: 'M2 9 L34 9' },
  { kind: 'rate', title: 'Requests per second', text: 'Fixed rate, e.g. 200 req/s', path: 'M2 14 L34 14 M2 9 L34 9 M2 19 L34 19' },
  { kind: 'spike', title: 'Spike', text: 'Sudden burst of users', path: 'M2 17 L12 17 L16 4 L22 4 L26 17 L34 17' },
];

export function NewTest({ me }: { me: Me }) {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const dark = useIsDark();
  const toast = useToast();
  const [curl, setCurl] = useState('');
  const [showCurl, setShowCurl] = useState(false);
  const limits = me.project;

  const [mode, setMode] = useState<Mode>('quick');
  const [quick, setQuick] = useState<QuickConfig>(defaultQuickConfig);
  const [script, setScript] = useState(SAMPLE_SCRIPT);
  const [scriptName, setScriptName] = useState('my-test.js');
  const [declaredVus, setDeclaredVus] = useState<number | null>(20);
  const [declaredMin, setDeclaredMin] = useState<number | null>(2);
  const [env, setEnv] = useState<KV[]>([]);
  const [spot, setSpot] = useState(false);
  const [runners, setRunners] = useState<number | null>(null);
  const [showScript, setShowScript] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loadingFrom, setLoadingFrom] = useState(false);

  // "Run again": load the earlier run's settings and script.
  const from = params.get('from');
  useEffect(() => {
    if (!from) return;
    setLoadingFrom(true);
    (async () => {
      try {
        const s = await api<{ url: string; format: string; config?: SavedConfig; env?: Record<string, string>; scriptName: string; spot?: boolean; runners?: number }>('GET', `/runs/${from}/script`);
        if (s.format !== 'js') throw new Error('That run came from the loadtest CLI. Run it again from the command line.');
        setEnv(Object.entries(s.env ?? {}).map(([key, value]) => ({ key, value })));
        setSpot(Boolean(s.spot));
        setRunners(s.runners ?? null);
        if (s.config?.kind === 'quick') {
          setQuick(s.config.quick);
          setMode('quick');
        } else {
          const text = await (await fetch(s.url)).text();
          setScript(text);
          setScriptName(s.scriptName);
          if (s.config?.kind === 'script') { setDeclaredVus(s.config.vus); setDeclaredMin(s.config.minutes); }
          setMode('script');
        }
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoadingFrom(false);
      }
    })();
  }, [from]);

  const generated = useMemo(() => buildScript(quick), [quick]);
  const vus = mode === 'quick' ? peakVus(quick.profile) : declaredVus ?? 0;
  const loadSec = mode === 'quick' ? loadSeconds(quick.profile) : (declaredMin ?? 0) * 60;
  const est = estimate(Math.max(1, vus), loadSec, runners ?? undefined, spot);

  const problems: string[] = [];
  if (mode === 'quick') {
    quick.steps.forEach((s, i) => {
      if (!/^(https?:\/\/|\{\{)/i.test(s.url.trim())) problems.push(`Request ${i + 1}: enter a full URL starting with https://`);
    });
    if (!quick.steps.length) problems.push('Add at least one request.');
  } else {
    if (!script.trim()) problems.push('The script is empty.');
    if (!declaredVus || declaredVus < 1) problems.push('Enter the most users your script uses.');
    if (!declaredMin || declaredMin <= 0) problems.push('Enter how long the script runs.');
  }
  if (vus > limits.maxVus) problems.push(`This test needs ${fmtNum(vus)} users; your project allows ${fmtNum(limits.maxVus)}.`);
  if (loadSec + GRACEFUL_STOP > limits.maxMinutes * 60) problems.push(`Tests can run up to ${limits.maxMinutes} minutes in this project.`);
  if (runners != null && (runners < 1 || runners > limits.maxRunners)) problems.push(`Runners must be between 1 and ${limits.maxRunners}.`);

  const setProfile = (patch: Partial<QuickConfig['profile']>) => setQuick((q) => ({ ...q, profile: { ...q.profile, ...patch } }));
  const setStep = (id: string, patch: Partial<Step>) => setQuick((q) => ({ ...q, steps: q.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)) }));

  const run = async () => {
    setBusy(true);
    setError('');
    try {
      const envObj = Object.fromEntries(env.filter((e) => e.key.trim()).map((e) => [e.key.trim(), e.value]));
      const config: SavedConfig = mode === 'quick' ? { kind: 'quick', quick } : { kind: 'script', vus: declaredVus!, minutes: declaredMin! };
      const id = await startCloudRun({
        scriptName: mode === 'quick' ? `${quick.name.replace(/[^\w.-]+/g, '-') || 'quick-test'}.js` : scriptName || 'script.js',
        script: mode === 'quick' ? generated : script,
        maxVUs: vus,
        durationSec: Math.ceil(loadSec) + GRACEFUL_STOP,
        env: envObj,
        spot,
        runners: runners ?? undefined,
        config,
      });
      nav(`/runs/${id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const applyTemplate = (id: string) => {
    const t = TEMPLATES.find((x) => x.id === id);
    if (!t) return;
    setQuick((q) => ({ ...q, profile: { ...q.profile, ...t.profile }, thresholds: t.thresholds }));
    toast(`${t.title} template applied`, 'info');
  };

  const importCurl = () => {
    const parsed = parseCurl(curl);
    if (!parsed) {
      toast('That does not look like a curl command with a URL', 'error');
      return;
    }
    setQuick((q) => {
      const d = defaultStep(1);
      const s0 = q.steps[0];
      const onlyDefault = q.steps.length === 1 && s0.url === d.url && s0.name === d.name && s0.method === d.method && !s0.headers.length && !s0.body;
      const step: Step = { ...defaultStep(q.steps.length + 1), ...parsed, id: newId() };
      return { ...q, steps: onlyDefault ? [step] : [...q.steps, step] };
    });
    setCurl('');
    setShowCurl(false);
    toast('API call imported from curl');
  };

  const useAsScript = () => {
    setScript(generated);
    setScriptName(`${quick.name || 'quick-test'}.js`);
    setDeclaredVus(peakVus(quick.profile));
    setDeclaredMin(Math.ceil(loadSeconds(quick.profile) / 6) / 10);
    setMode('script');
  };

  const onFile = async (f?: File) => {
    if (!f) return;
    const text = await f.text();
    setScript(text);
    setScriptName(f.name);
    const g = guessFromScript(text);
    if (g.vus) setDeclaredVus(g.vus);
    if (g.durationSec) setDeclaredMin(Math.ceil(g.durationSec / 6) / 10);
  };

  if (loadingFrom) return <div style={{ display: 'grid', placeItems: 'center', padding: 80 }}><Spinner /></div>;

  const p = quick.profile;
  return (
    <>
      <div className="page-head">
        <div>
          <div className="crumbs">Runs / New test</div>
          <h1>New load test</h1>
          <p>Pick the APIs to call, how many users, and the pass rules. Press Run and it starts on AWS.</p>
        </div>
        <div className="tabs" role="tablist" aria-label="How to build the test">
          <button role="tab" aria-selected={mode === 'quick'} className={mode === 'quick' ? 'on' : ''} onClick={() => setMode('quick')}>Pick APIs</button>
          <button role="tab" aria-selected={mode === 'script'} className={mode === 'script' ? 'on' : ''} onClick={() => setMode('script')}>Write or upload script</button>
        </div>
      </div>

      <div className="two-col">
        <div className="stack" style={{ gap: 20 }}>
          {mode === 'quick' ? (
            <>
              <Section n={1} title="APIs to call" text="Each user calls these in order, then waits the think time, then repeats. Use {{NAME}} for values from step 4.">
                <Field label="Test name">
                  <input className="input" value={quick.name} onChange={(e) => setQuick({ ...quick, name: e.target.value })} />
                </Field>
                {quick.steps.map((s, i) => (
                  <StepEditor
                    key={s.id}
                    n={i + 1}
                    step={s}
                    onChange={(patch) => setStep(s.id, patch)}
                    onRemove={quick.steps.length > 1 ? () => setQuick({ ...quick, steps: quick.steps.filter((x) => x.id !== s.id) }) : undefined}
                    onDuplicate={() => setQuick({ ...quick, steps: [...quick.steps.slice(0, i + 1), { ...s, id: newId(), name: `${s.name} (copy)` }, ...quick.steps.slice(i + 1)] })}
                  />
                ))}
                <div className="row">
                  <button className="btn" onClick={() => setQuick({ ...quick, steps: [...quick.steps, defaultStep(quick.steps.length + 1)] })}>+ Add API call</button>
                  <button className="btn btn-ghost" onClick={() => setShowCurl(!showCurl)} aria-expanded={showCurl}>Import from cURL</button>
                </div>
                {showCurl && (
                  <div className="curl-box stack" style={{ gap: 8 }}>
                    <Field label="Paste a curl command" hint="e.g. Copy as cURL from browser dev tools or Postman">
                      <textarea className="input" placeholder={"curl -X POST https://api.example.com/login -H 'Content-Type: application/json' -d '{\"email\":\"a@b.com\"}'"} value={curl} onChange={(e) => setCurl(e.target.value)} />
                    </Field>
                    <div><button className="btn btn-primary btn-sm" disabled={!curl.trim()} onClick={importCurl}>Import</button></div>
                  </div>
                )}
                <Field label="Think time" hint="pause after each round, like a real user reading">
                  <NumberInput value={quick.thinkTimeSec} min={0} step={0.5} suffix="seconds" onChange={(v) => setQuick({ ...quick, thinkTimeSec: v ?? 0 })} />
                </Field>
              </Section>

              <Section n={2} title="Load" text="How many virtual users, and how they arrive. Start from a template or set it yourself.">
                <div className="templates" aria-label="Templates">
                  {TEMPLATES.map((t) => (
                    <button key={t.id} className="template" onClick={() => applyTemplate(t.id)}>
                      <strong>{t.title}</strong>
                      <span>{t.text}</span>
                    </button>
                  ))}
                </div>
                <div className="options" role="radiogroup" aria-label="Load shape">
                  {PROFILES.map((o) => (
                    <button key={o.kind} role="radio" aria-checked={p.kind === o.kind} className={`option ${p.kind === o.kind ? 'on' : ''}`} onClick={() => setProfile({ kind: o.kind })}>
                      <svg width="36" height="24" viewBox="0 0 36 24" aria-hidden="true"><path d={o.path} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                      <strong>{o.title}</strong>
                      <span>{o.text}</span>
                    </button>
                  ))}
                </div>
                {p.kind === 'ramp' && (
                  <div className="grid-4">
                    <Field label="Users at peak"><NumberInput value={p.vus} min={1} onChange={(v) => setProfile({ vus: v ?? 1 })} /></Field>
                    <Field label="Ramp up"><NumberInput value={p.rampUpSec} suffix="s" onChange={(v) => setProfile({ rampUpSec: v ?? 0 })} /></Field>
                    <Field label="Hold"><NumberInput value={p.holdSec} suffix="s" onChange={(v) => setProfile({ holdSec: v ?? 0 })} /></Field>
                    <Field label="Ramp down"><NumberInput value={p.rampDownSec} suffix="s" onChange={(v) => setProfile({ rampDownSec: v ?? 0 })} /></Field>
                  </div>
                )}
                {p.kind === 'constant' && (
                  <div className="grid-2">
                    <Field label="Users"><NumberInput value={p.vus} min={1} onChange={(v) => setProfile({ vus: v ?? 1 })} /></Field>
                    <Field label="Duration"><NumberInput value={p.durationSec} suffix="s" min={1} onChange={(v) => setProfile({ durationSec: v ?? 1 })} /></Field>
                  </div>
                )}
                {p.kind === 'rate' && (
                  <div className="grid-3">
                    <Field label="Rounds per second" hint="each round runs all APIs once"><NumberInput value={p.rate} min={1} onChange={(v) => setProfile({ rate: v ?? 1 })} /></Field>
                    <Field label="Duration"><NumberInput value={p.durationSec} suffix="s" min={1} onChange={(v) => setProfile({ durationSec: v ?? 1 })} /></Field>
                    <Field label="Max users" hint="if the API slows down"><NumberInput value={p.maxVus} min={1} onChange={(v) => setProfile({ maxVus: v ?? 1 })} /></Field>
                  </div>
                )}
                {p.kind === 'spike' && (
                  <div className="grid-3">
                    <Field label="Normal users"><NumberInput value={p.baseVus} min={0} onChange={(v) => setProfile({ baseVus: v ?? 0 })} /></Field>
                    <Field label="Users at spike"><NumberInput value={p.spikeVus} min={1} onChange={(v) => setProfile({ spikeVus: v ?? 1 })} /></Field>
                    <Field label="Spike length"><NumberInput value={p.holdSec} suffix="s" onChange={(v) => setProfile({ holdSec: v ?? 0 })} /></Field>
                  </div>
                )}
                <div className="card" style={{ padding: '12px 14px 6px', boxShadow: 'none' }}>
                  <div className="row small" style={{ justifyContent: 'space-between' }}>
                    <strong>Load shape</strong>
                    <span className="muted">{p.kind === 'rate' ? 'rounds per second' : 'users'} over {fmtDuration(loadSeconds(p))}</span>
                  </div>
                  <LineChart points={shape(p).map(([x, y]) => ({ x, y }))} format={(v) => fmtNum(v)} label="Load shape" height={140} />
                </div>
              </Section>

              <Section n={3} title="Pass rules" text="The run fails if any rule is broken. Leave a box empty to skip that rule.">
                <div className="grid-3">
                  <Field label="95% of requests faster than"><NumberInput value={quick.thresholds.p95Ms} suffix="ms" onChange={(v) => setQuick({ ...quick, thresholds: { ...quick.thresholds, p95Ms: v } })} /></Field>
                  <Field label="Errors below"><NumberInput value={quick.thresholds.errorPct} step={0.1} suffix="%" onChange={(v) => setQuick({ ...quick, thresholds: { ...quick.thresholds, errorPct: v } })} /></Field>
                  <Field label="Status checks passing above"><NumberInput value={quick.thresholds.checksPct} step={0.1} suffix="%" onChange={(v) => setQuick({ ...quick, thresholds: { ...quick.thresholds, checksPct: v } })} /></Field>
                </div>
              </Section>
            </>
          ) : (
            <Section n={1} title="Script" text="A normal k6 script. Imports of other local files are not supported here; use the loadtest CLI for those.">
              <div className="row">
                <Field label="File name"><input className="input" value={scriptName} onChange={(e) => setScriptName(e.target.value)} /></Field>
                <div className="spacer" />
                <label className="btn" style={{ alignSelf: 'end' }}>
                  Upload .js file
                  <input type="file" accept=".js,.mjs,text/javascript" hidden onChange={(e) => onFile(e.target.files?.[0])} />
                </label>
              </div>
              <CodeMirror value={script} height="460px" theme={dark ? 'dark' : 'light'} extensions={[javascript()]} onChange={setScript} aria-label="k6 script" />
              <div className="grid-2">
                <Field label="Most users the script uses" hint="checked on the runner">
                  <NumberInput value={declaredVus} min={1} onChange={setDeclaredVus} />
                </Field>
                <Field label="How long it runs" hint="hard stop after this">
                  <NumberInput value={declaredMin} min={0.1} step={0.5} suffix="minutes" onChange={setDeclaredMin} />
                </Field>
              </div>
              <div><button className="btn btn-sm btn-ghost" onClick={() => { const g = guessFromScript(script); if (g.vus) setDeclaredVus(g.vus); if (g.durationSec) setDeclaredMin(Math.ceil(g.durationSec / 6) / 10); }}>Detect from script</button></div>
            </Section>
          )}

          <Section n={mode === 'quick' ? 4 : 2} title="Environment values" text="Available in the test as {{NAME}} (Pick APIs) or __ENV.NAME (script). Passwords: store them as project secrets instead.">
            <KeyValueEditor rows={env} onChange={setEnv} keyPlaceholder="NAME, e.g. BASE_URL" valuePlaceholder="value" addLabel="Add value" />
          </Section>

          <Section n={mode === 'quick' ? 5 : 3} title="Machines" text="Leave the defaults unless you know you need something else.">
            <div className="grid-2">
              <Field label="Runners" hint={`auto = ${est.runners}`}>
                <NumberInput value={runners} min={1} max={limits.maxRunners} onChange={setRunners} ariaLabel="Runners (empty = automatic)" />
              </Field>
              <div style={{ alignSelf: 'end', paddingBottom: 8 }}>
                <label className="check">
                  <input type="checkbox" checked={spot} onChange={(e) => setSpot(e.target.checked)} />
                  Use Spot machines (about 70% cheaper; AWS may interrupt them)
                </label>
              </div>
            </div>
          </Section>

          {mode === 'quick' && (
            <div className="card">
              <div className="card-head">
                <div><h3>Generated k6 script</h3><p>This is exactly what runs on the machines.</p></div>
                <div className="row">
                  <button className="btn btn-sm" onClick={() => setShowScript(!showScript)}>{showScript ? 'Hide' : 'Show'}</button>
                  <button className="btn btn-sm" onClick={useAsScript}>Edit as script</button>
                </div>
              </div>
              {showScript && <div className="card-pad"><pre className="code">{generated}</pre></div>}
            </div>
          )}
        </div>

        <aside className="sticky-side">
          <div className="card card-pad stack">
            <h2>Summary</h2>
            <dl className="summary-list">
              <div><dt>Peak users</dt><dd>{fmtNum(vus)}</dd></div>
              <div><dt>Test length</dt><dd>{fmtDuration(loadSec)}</dd></div>
              {mode === 'quick' && <div><dt>APIs per round</dt><dd>{quick.steps.length}</dd></div>}
              <div><dt>Machines</dt><dd>{est.runners} × {est.vcpu} vCPU</dd></div>
              <div><dt>Where</dt><dd>AWS Mumbai</dd></div>
              <div><dt>Estimated AWS cost</dt><dd>{fmtCost(est.cost)}</dd></div>
            </dl>
            <p className="muted small" style={{ margin: 0 }}>Cost covers the machines only; outbound traffic is free up to 100 GB a month.</p>
            <div className="divider" style={{ margin: 0 }} />
            {problems.length > 0 && (
              <div className="alert alert-error small">
                {problems.map((x) => <div key={x}>{x}</div>)}
              </div>
            )}
            {error && <div className="alert alert-error small">{error}</div>}
            <button className="btn btn-primary btn-lg" disabled={busy || problems.length > 0} onClick={run}>
              {busy ? <><Spinner /> Starting…</> : 'Run test'}
            </button>
            <p className="muted small" style={{ margin: 0 }}>Machines take about 30–60 seconds to start. You can watch live on the next page.</p>
          </div>
        </aside>
      </div>
    </>
  );
}

function Section({ n, title, text, children }: { n: number; title: string; text: string; children: ReactNode }) {
  return (
    <section className="card">
      <div className="card-head" style={{ justifyContent: 'flex-start' }}>
        <span className="step-num" aria-hidden="true">{n}</span>
        <div><h2>{title}</h2><p>{text}</p></div>
      </div>
      <div className="card-pad stack">{children}</div>
    </section>
  );
}

function StepEditor({ n, step, onChange, onRemove, onDuplicate }: {
  n: number;
  step: Step;
  onChange: (patch: Partial<Step>) => void;
  onRemove?: () => void;
  onDuplicate: () => void;
}) {
  const [open, setOpen] = useState(step.headers.length > 0 || step.body !== '');
  const canBody = step.method !== 'GET';
  return (
    <div className="step">
      <div className="step-head">
        <span className="step-num">{n}</span>
        <input className="input" style={{ height: 32, border: 0, padding: 0, fontWeight: 600, background: 'transparent' }} aria-label={`Name of request ${n}`} value={step.name} onChange={(e) => onChange({ name: e.target.value })} />
        <button className="btn btn-sm btn-ghost" onClick={onDuplicate}>Duplicate</button>
        {onRemove && <button className="btn btn-sm btn-ghost" onClick={onRemove}>Remove</button>}
      </div>
      <div className="step-body">
        <div className="method-url">
          <select className="input" aria-label="Method" value={step.method} onChange={(e) => onChange({ method: e.target.value as Method })}>
            {METHODS.map((m) => <option key={m}>{m}</option>)}
          </select>
          <input className="input" placeholder="https://api.example.com/products" aria-label="URL" value={step.url} onChange={(e) => onChange({ url: e.target.value })} />
        </div>
        <div className="row">
          <Field label="Expected status">
            <input className="input" type="number" style={{ width: 110 }} value={step.expectStatus} onChange={(e) => onChange({ expectStatus: Number(e.target.value) || 200 })} />
          </Field>
          <div className="spacer" />
          <button className="btn btn-sm btn-ghost" style={{ alignSelf: 'end' }} onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? 'Hide' : 'Add'} headers{canBody ? ' & body' : ''}
          </button>
        </div>
        {open && (
          <>
            <Field label="Headers">
              <KeyValueEditor
                rows={step.headers}
                onChange={(headers) => onChange({ headers })}
                keyPlaceholder="Header, e.g. Authorization"
                valuePlaceholder="Value, e.g. Bearer {{TOKEN}}"
                addLabel="Add header"
              />
            </Field>
            {canBody && (
              <Field label="Body" hint="JSON or text">
                <textarea
                  className="input"
                  placeholder={'{"email": "{{TEST_USER}}", "password": "{{TEST_PASS}}"}'}
                  value={step.body}
                  onChange={(e) => onChange({ body: e.target.value })}
                />
              </Field>
            )}
          </>
        )}
      </div>
    </div>
  );
}
