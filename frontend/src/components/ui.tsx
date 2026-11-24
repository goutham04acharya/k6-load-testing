import type { ReactNode } from 'react';
import type { RunStatus } from '../lib/api';
import type { KV } from '../lib/script';

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="#0e1e25" />
      <path d="M6 22 L11 14 L15 18 L20 9 L26 22" fill="none" stroke="#32e6e2" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="20" cy="9" r="2.2" fill="#32e6e2" />
    </svg>
  );
}

const STATUS_LABEL: Record<RunStatus, string> = {
  created: 'Draft',
  queued: 'Starting',
  running: 'Running',
  passed: 'Passed',
  failed: 'Failed',
  error: 'Error',
  stopped: 'Stopped',
};

export function StatusBadge({ status }: { status: RunStatus }) {
  const icon =
    status === 'passed' ? (
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.2 5 8.6 9.5 3.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
    ) : status === 'failed' || status === 'error' ? (
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
    ) : status === 'stopped' ? (
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="3" y="3" width="6" height="6" rx="1" fill="currentColor" /></svg>
    ) : status === 'queued' || status === 'running' ? (
      <span className="pulse" />
    ) : null;
  return (
    <span className={`badge ${status}`}>
      {icon}
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

export function Spinner() {
  return <span className="spinner" role="status" aria-label="Loading" />;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>
        {label} {hint && <span className="hint">· {hint}</span>}
      </span>
      {children}
    </label>
  );
}

export function NumberInput({ value, onChange, min = 0, max, suffix, step = 1, ariaLabel }: {
  value: number | null;
  onChange: (v: number | null) => void;
  min?: number;
  max?: number;
  suffix?: string;
  step?: number;
  ariaLabel?: string;
}) {
  const input = (
    <input
      className="input"
      type="number"
      inputMode="decimal"
      aria-label={ariaLabel}
      min={min}
      max={max}
      step={step}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
    />
  );
  return suffix ? <div className="input-group">{input}<span className="addon">{suffix}</span></div> : input;
}

export function KeyValueEditor({ rows, onChange, keyPlaceholder = 'Name', valuePlaceholder = 'Value', addLabel = 'Add' }: {
  rows: KV[];
  onChange: (rows: KV[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  addLabel?: string;
}) {
  const set = (i: number, patch: Partial<KV>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="stack" style={{ gap: 8 }}>
      {rows.map((r, i) => (
        <div className="kv" key={i}>
          <input className="input" placeholder={keyPlaceholder} aria-label={keyPlaceholder} value={r.key} onChange={(e) => set(i, { key: e.target.value })} />
          <input className="input" placeholder={valuePlaceholder} aria-label={valuePlaceholder} value={r.value} onChange={(e) => set(i, { value: e.target.value })} />
          <button type="button" className="btn btn-ghost icon-btn" aria-label="Remove" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          </button>
        </div>
      ))}
      <div>
        <button type="button" className="btn btn-sm" onClick={() => onChange([...rows, { key: '', value: '' }])}>+ {addLabel}</button>
      </div>
    </div>
  );
}
