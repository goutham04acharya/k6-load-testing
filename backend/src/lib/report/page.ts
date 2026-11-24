// The public report page for one run (/r/<run-id>/<key>).
import { FINISHED, type Run } from '../types.ts';
import { APP_NAME, fmt, headline, runFacts, type Details } from './details.ts';

const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

const table = (head: string[], rows: string[][], numeric: number[] = []) =>
  `<table><tr>${head.map((h, i) => `<th${numeric.includes(i) ? ' class="n"' : ''}>${h}</th>`).join('')}</tr>${rows
    .map((r) => `<tr>${r.map((c, i) => `<td${numeric.includes(i) ? ' class="n"' : ''}>${c}</td>`).join('')}</tr>`)
    .join('')}</table>`;

export function renderPage(run: Run, d: Details, base: string, reports: number[]): string {
  const r = run.result;
  const statusClass = ({ passed: 'ok', failed: 'bad', error: 'bad', stopped: 'warn' } as Record<string, string>)[run.status] ?? 'muted';
  const finished = FINISHED.includes(run.status);
  const cards = headline(run)
    .map(([k, v, sub]) => `<div class="card"><div class="k">${k}</div><div class="v">${esc(v)}</div><div class="s">${esc(sub)}</div></div>`)
    .join('');

  const thr = d.thresholds.length
    ? table(['Metric', 'Rule', 'Result'], d.thresholds.map((t) => [esc(t.metric), `<code>${esc(t.expr)}</code>`, `<span class="${t.ok ? 'ok' : 'bad'}">${t.ok ? '✓ Passed' : '✕ Failed'}</span>`]))
    : '<p class="muted">This test has no pass/fail rules, so the result only reflects errors.</p>';
  const chk = d.checks.length
    ? table(['Check', 'Passed', 'Failed', 'Rate'], d.checks.map((c) => [
        `${c.group ? `<span class="muted">${esc(c.group)} › </span>` : ''}${esc(c.name)}`,
        fmt.num(c.passes), `<span class="${c.fails ? 'bad' : ''}">${fmt.num(c.fails)}</span>`, fmt.pct(c.passes / ((c.passes + c.fails) || 1)),
      ]), [1, 2, 3])
    : '<p class="muted">No checks in this test.</p>';
  const endpoints = r?.endpoints?.length
    ? `<h2>Per API</h2>${table(['API', 'Requests', 'Errors', 'Average', 'p95', 'Max'], r.endpoints.map((e) => [
        esc(e.name), fmt.num(e.requests), `<span class="${e.failed ? 'bad' : ''}">${fmt.pct(e.errorRate)}</span>`, fmt.ms(e.avgMs), fmt.ms(e.p95Ms), fmt.ms(e.maxMs),
      ]), [1, 2, 3, 4, 5])}`
    : '';
  const tim = d.timings.length
    ? `<h2>Where the time goes</h2>${table(['Phase', 'Average', 'p95', 'Max'], d.timings.map((t) => [esc(t.label), fmt.ms(t.avgMs), fmt.ms(t.p95Ms), fmt.ms(t.maxMs)]), [1, 2, 3])}`
    : '';
  const runners = (r?.runners?.length ?? 0) > 1
    ? `<h2>Machines</h2>${table(['Machine', 'Outcome', 'Requests', 'p95'], r!.runners!.map((x) => [`#${x.runner}`, esc(x.outcome), fmt.num(x.requests), fmt.ms(x.p95Ms)]), [2, 3])}<p class="muted">Counts are added up across machines; p95/p99/max show the slowest machine.</p>`
    : '';
  const tabs = reports.length > 1 ? reports.map((n) => `<a class="tab" href="#" data-runner="${n}">Machine ${n}</a>`).join('') : '';
  const full = reports.length
    ? `<h2 class="noprint">Full k6 report ${tabs}</h2><iframe class="noprint" id="k6" src="${base}/view?runner=${reports[0]}" title="k6 report"></iframe>`
    : '<p class="muted noprint">No interactive k6 report for this run (k6 skips it for runs under ~30 s).</p>';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(run.scriptName)} · ${esc(run.id)} · ${APP_NAME}</title><style>
:root{--bg:#f7f8f8;--fg:#0e1e25;--muted:#66757b;--card:#fff;--line:#e1e5e6;--ok:#067647;--okbg:#e7f7ee;--bad:#c0332f;--badbg:#fdeeed;--warn:#9a5b00;--warnbg:#fff4dc;--accent:#04807b;--accent-ink:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0b171c;--fg:#e8f1f2;--muted:#8fa3a8;--card:#10232a;--line:#213940;--ok:#47cd89;--okbg:#0d2b1d;--bad:#f97066;--badbg:#2e1513;--warn:#fdb022;--warnbg:#2b2210;--accent:#32e6e2;--accent-ink:#062126}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 Inter,system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px 48px}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;margin-bottom:16px}
.brand{font-size:13px;color:var(--muted);margin-bottom:4px}
h1{font-size:22px;margin:0}h2{font-size:17px;margin:28px 0 10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.badge{display:inline-block;padding:2px 10px;border-radius:999px;font-size:13px;font-weight:600;margin-left:8px;vertical-align:middle}
.badge.ok{color:var(--ok);background:var(--okbg)}.badge.bad{color:var(--bad);background:var(--badbg)}.badge.warn{color:var(--warn);background:var(--warnbg)}.badge.muted{color:var(--muted);background:var(--line)}
.actions{display:flex;gap:8px;flex-wrap:wrap}
.btn{display:inline-block;padding:8px 14px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;border:1px solid var(--line);color:var(--fg);background:var(--card)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.card .k{color:var(--muted);font-size:13px}.card .v{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums}.card .s{color:var(--muted);font-size:12px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
th,td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--line);vertical-align:top}tr:last-child td{border-bottom:0}
th{color:var(--muted);font-weight:500;font-size:13px}.n{text-align:right;font-variant-numeric:tabular-nums}
.facts th{width:160px}.ok{color:var(--ok);font-weight:600}.bad{color:var(--bad);font-weight:600}.muted{color:var(--muted)}
code{font-size:13px}.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media (max-width:760px){.grid2{grid-template-columns:1fr}}
.tab{font-size:13px;font-weight:500;padding:3px 10px;border:1px solid var(--line);border-radius:6px;color:var(--fg);text-decoration:none}.tab.on{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
iframe{width:100%;height:80vh;border:1px solid var(--line);border-radius:10px;background:#fff}
.err{background:var(--badbg);color:var(--bad);padding:10px 14px;border-radius:8px;margin-top:12px}
@media print{.noprint,.actions{display:none!important}body{background:#fff}}
</style></head><body><main>
<header><div><div class="brand">${APP_NAME}</div><h1>${esc(run.scriptName)}<span class="badge ${statusClass}">${esc(run.status)}</span></h1><div class="muted">${esc(run.id)} · ${fmt.date(run.createdAt)}</div></div>
<div class="actions">${finished ? `<a class="btn primary" href="${base}/pdf">Download PDF</a>` : ''}${reports.length ? `<a class="btn" href="${base}/html?runner=${reports[0]}">Download HTML report</a>` : ''}</div></header>
${run.error ? `<div class="err">${esc(run.error)}</div>` : ''}
${finished ? '' : '<p class="muted">This run is still in progress. Refresh the page when it finishes.</p>'}
<div class="cards">${cards}</div>
<div class="grid2"><div><h2>Pass rules</h2>${thr}</div><div><h2>Checks</h2>${chk}</div></div>
${endpoints}${tim}${runners}
<h2>Run details</h2><table class="facts">${runFacts(run).map(([k, v]) => `<tr><th>${k}</th><td>${esc(v)}</td></tr>`).join('')}</table>
${full}
</main><script>
document.querySelectorAll('.tab').forEach((t,i)=>{if(i===0)t.classList.add('on');t.addEventListener('click',e=>{e.preventDefault();document.querySelectorAll('.tab').forEach(x=>x.classList.remove('on'));t.classList.add('on');document.getElementById('k6').src='${base}/view?runner='+t.dataset.runner;document.querySelector('.actions a[href*="/html"]')?.setAttribute('href','${base}/html?runner='+t.dataset.runner);});});
</script></body></html>`;
}

export function notFoundPage(): string {
  return `<!doctype html><meta charset="utf-8"><title>Not found · ${APP_NAME}</title><p style="font:15px system-ui;margin:40px">This report link is not valid.</p>`;
}
