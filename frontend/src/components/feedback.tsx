import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

// ---------------- toasts ----------------
type Tone = 'ok' | 'error' | 'info';
interface Toast { id: number; text: string; tone: Tone }

const ToastContext = createContext<(text: string, tone?: Tone) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const show = useCallback((text: string, tone: Tone = 'ok') => {
    const id = next.current++;
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`}>
            <span className="toast-dot" aria-hidden="true" />
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

// ---------------- confirm dialog ----------------
export function ConfirmDialog({ open, title, text, confirmLabel, danger, onConfirm, onCancel }: {
  open: boolean;
  title: string;
  text: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="dialog" onCancel={(e) => { e.preventDefault(); onCancel(); }} aria-labelledby="dialog-title">
      <h2 id="dialog-title">{title}</h2>
      <p>{text}</p>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onCancel}>Cancel</button>
        <button className={`btn ${danger ? 'btn-danger-solid' : 'btn-primary'}`} onClick={onConfirm} autoFocus>{confirmLabel}</button>
      </div>
    </dialog>
  );
}

// ---------------- theme ----------------
export type Theme = 'system' | 'light' | 'dark';
const THEME_KEY = 'load-testing-k6.theme';

export function readTheme(): Theme {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(t: Theme) {
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  try {
    if (t === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, t);
  } catch { /* storage unavailable: theme lasts for this visit */ }
  window.dispatchEvent(new Event('themechange'));
}

/** True when the page is currently dark (explicit choice or system setting). */
export function useIsDark(): boolean {
  const compute = () => {
    const t = document.documentElement.getAttribute('data-theme');
    if (t) return t === 'dark';
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  };
  const [dark, setDark] = useState(compute);
  useEffect(() => {
    const m = window.matchMedia?.('(prefers-color-scheme: dark)');
    const f = () => setDark(compute());
    m?.addEventListener('change', f);
    window.addEventListener('themechange', f);
    return () => { m?.removeEventListener('change', f); window.removeEventListener('themechange', f); };
  }, []);
  return dark;
}

export function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  const set = (t: Theme) => { setTheme(t); applyTheme(t); };
  const icons: Record<Theme, ReactNode> = {
    system: <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M5.5 14h5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>,
    light: <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6 13 13M3 13l1.4-1.4M11.6 4.4 13 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>,
    dark: <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /></svg>,
  };
  return (
    <div className="theme-switch" role="radiogroup" aria-label="Theme">
      {(['system', 'light', 'dark'] as Theme[]).map((t) => (
        <button key={t} role="radio" aria-checked={theme === t} title={`${t[0].toUpperCase()}${t.slice(1)} theme`} className={theme === t ? 'on' : ''} onClick={() => set(t)}>
          {icons[t]}
        </button>
      ))}
    </div>
  );
}
