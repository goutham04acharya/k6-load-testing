export const fmtMs = (v?: number | null) =>
  v == null ? '–' : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v < 10 ? v.toFixed(1) : Math.round(v)} ms`;

export const fmtPct = (v?: number | null, digits = 2) => (v == null ? '–' : `${(v * 100).toFixed(digits)}%`);

export const fmtNum = (v?: number | null) => (v == null ? '–' : Math.round(v).toLocaleString('en-US'));

export function fmtDuration(sec?: number | null): string {
  if (sec == null || !Number.isFinite(sec)) return '–';
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return s ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

export const fmtClock = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

export function fmtWhen(iso?: string): string {
  if (!iso) return '–';
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export const fmtDate = (iso?: string) =>
  iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '–';

// ---- Runner sizing and cost estimate (mirrors lambda/src/prepare.mjs) ----
const SIZES = [
  { name: 'small', maxVus: 100, vcpu: 0.5, gb: 1 },
  { name: 'medium', maxVus: 250, vcpu: 1, gb: 2 },
  { name: 'large', maxVus: 500, vcpu: 2, gb: 4 },
];

// Fargate Linux x86 in ap-south-1 (approximate list prices).
const VCPU_HOUR = 0.04256;
const GB_HOUR = 0.00467;
const IP_HOUR = 0.005;
const SPOT_DISCOUNT = 0.7;

export function estimate(vus: number, loadSec: number, runnersOverride?: number, spot = false) {
  const runners = runnersOverride || Math.max(1, Math.ceil(vus / 500));
  const per = Math.ceil(vus / runners);
  const size = SIZES.find((x) => per <= x.maxVus) ?? SIZES[2];
  const hours = (loadSec + 30 + 90) / 3600; // + graceful stop + start/upload
  const compute = runners * hours * (size.vcpu * VCPU_HOUR + size.gb * GB_HOUR);
  const cost = compute * (spot ? 1 - SPOT_DISCOUNT : 1) + runners * hours * IP_HOUR;
  return { runners, size: size.name, vcpu: size.vcpu, gb: size.gb, totalVcpu: runners * size.vcpu, cost };
}

export const fmtCost = (usd: number) => (usd < 0.01 ? '< $0.01' : `$${usd.toFixed(usd < 1 ? 3 : 2)}`);
