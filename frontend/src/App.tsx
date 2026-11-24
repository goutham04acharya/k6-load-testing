import { lazy, Suspense, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { api, ApiError, getToken, loadConfig, setToken, type Me } from './lib/api';
import { Layout } from './components/Layout';
import { Spinner } from './components/ui';
import { applyTheme, readTheme, ToastProvider } from './components/feedback';
import { Login } from './pages/Login';
import { Runs } from './pages/Runs';
import { RunDetail } from './pages/RunDetail';
import { Compare } from './pages/Compare';
import { Settings } from './pages/Settings';

// The script editor is large; load it only when someone opens New test.
const NewTest = lazy(() => import('./pages/NewTest').then((m) => ({ default: m.NewTest })));

const Loading = () => <div style={{ display: 'grid', placeItems: 'center', padding: 80 }}><Spinner /></div>;

applyTheme(readTheme());

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'signed-out' | 'broken'>('loading');
  const [problem, setProblem] = useState('');

  useEffect(() => {
    (async () => {
      try {
        await loadConfig();
      } catch (e) {
        setProblem((e as Error).message);
        setState('broken');
        return;
      }
      if (!getToken()) return setState('signed-out');
      try {
        setMe(await api<Me>('GET', '/whoami'));
        setState('ready');
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) setToken(null);
        setState('signed-out');
      }
    })();
  }, []);

  const signOut = () => {
    setToken(null);
    setMe(null);
    setState('signed-out');
  };

  if (state === 'loading') return <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}><Spinner /></div>;
  if (state === 'broken') return <div className="page"><div className="alert alert-error">{problem}</div></div>;
  if (state === 'signed-out' || !me) return <Login onSignedIn={(m) => { setMe(m); setState('ready'); }} />;

  return (
    <ToastProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout me={me} onSignOut={signOut} />}>
            <Route index element={<Runs me={me} />} />
            <Route path="new" element={<Suspense fallback={<Loading />}><NewTest me={me} /></Suspense>} />
            <Route path="runs/:id" element={<RunDetail />} />
            <Route path="compare" element={<Compare />} />
            <Route path="settings" element={<Settings me={me} onSignOut={signOut} />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ToastProvider>
  );
}
