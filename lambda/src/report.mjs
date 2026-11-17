// Run page (HTML) and downloadable PDF for one run, built from the saved k6 summaries.
import PDFDocument from 'pdfkit';
import { readJson, runPrefix } from './lib.mjs';

const TIMINGS = [
  ['http_req_blocked', 'Waiting for a free connection'],
  ['http_req_connecting', 'TCP connect'],
  ['http_req_tls_handshaking', 'TLS handshake'],
  ['http_req_sending', 'Sending request'],
  ['http_req_waiting', 'Waiting for server (TTFB)'],
  ['http_req_receiving', 'Receiving response'],
  ['http_req_duration', 'Total request time'],
  ['iteration_duration', 'One full iteration'],
];

function collectChecks(group, out) {
  for (const ch of Object.values(group?.checks || {})) {
    const k = ch.path || ch.name;
    const cur = out.get(k) || { name: ch.name, group: (ch.path || '').split('::').slice(1, -1).join(' › '), passes: 0, fails: 0 };
    cur.passes += ch.passes || 0;
    cur.fails += ch.fails || 0;
    out.set(k, cur);
  }
  for (const g of Object.values(group?.groups || {})) collectChecks(g, out);
}

/** Thresholds, checks and timing breakdown, combined over all runners. */
export async function loadDetails(run) {
  const n = run.mode === 'cloud' ? run.runners || 1 : 1;
  const summaries = (await Promise.all(
    Array.from({ length: n }, (_, i) => readJson(`${runPrefix(run.id)}/runner-${i + 1}/summary.json`)),
  )).filter(Boolean);

  const thresholds = new Map();
  const checks = new Map();
  const timings = new Map();
  for (const s of summaries) {
    for (const [metric, m] of Object.entries(s.metrics || {})) {
      // In k6's summary export, a threshold value of true means it FAILED.
      for (const [expr, failed] of Object.entries(m.thresholds || {})) {
        const k = `${metric} ${expr}`;
        const t = thresholds.get(k) || { metric, expr, ok: true };
        if (failed) t.ok = false;
        thresholds.set(k, t);
      }
    }
    collectChecks(s.root_group, checks);
    for (const [metric] of TIMINGS) {
      const m = s.metrics?.[metric];
      if (!m) continue;
      const t = timings.get(metric) || { avg: [], p95: [], max: [] };
      t.avg.push(m.avg);
      t.p95.push(m['p(95)']);
      t.max.push(m.max);
      timings.set(metric, t);
    }
  }
  const worst = (a) => (a.filter((x) => x != null).length ? Math.max(...a.filter((x) => x != null)) : null);
  const mean = (a) => (a.filter((x) => x != null).length ? a.filter((x) => x != null).reduce((x, y) => x + y, 0) / a.filter((x) => x != null).length : null);
  return {
    runnerCount: n,
    summariesFound: summaries.length,
    thresholds: [...thresholds.values()],
    checks: [...checks.values()],
    timings: TIMINGS.filter(([k]) => timings.has(k)).map(([k, label]) => ({
      metric: k, label, avgMs: mean(timings.get(k).avg), p95Ms: worst(timings.get(k).p95), maxMs: worst(timings.get(k).max),
    })),
  };
}

// ---------------- formatting ----------------
export const fmt = {
  ms: (v) => (v == null ? '-' : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v < 10 ? v.toFixed(2) : Math.round(v)} ms`),
  pct: (v) => (v == null ? '-' : `${(v * 100).toFixed(2)}%`),
  num: (v) => (v == null ? '-' : Number(v).toLocaleString('en-US')),
  bytes: (v) => (v == null ? '-' : v > 1e9 ? `${(v / 1e9).toFixed(2)} GB` : v > 1e6 ? `${(v / 1e6).toFixed(1)} MB` : `${(v / 1e3).toFixed(1)} kB`),
  date: (iso) => (iso ? iso.replace('T', ' ').slice(0, 19) + ' UTC' : '-'),
  dur: (s) => (s == null ? '-' : s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`),
};

function runFacts(run) {
  const elapsed = run.finishedAt && run.createdAt ? Math.round((Date.parse(run.finishedAt) - Date.parse(run.createdAt)) / 1000) : null;
  return [
    ['Run', run.id],
    ['Script', run.scriptName],
    ['Project', run.project],
    ['Where', run.mode === 'cloud' ? `AWS, ${run.runners || 1} × ${run.runnerSize || '-'} runner(s)${run.spot ? ', Spot' : ''}` : 'Local machine'],
    ['Started', fmt.date(run.createdAt)],
    ['Wall time', fmt.dur(elapsed)],
    ['Max VUs', fmt.num(run.maxVUs)],
    ['Started by', run.createdBy],
  ];
}

function headline(run) {
  const r = run.result || {};
  return [
    ['Requests', fmt.num(r.requests), `${(r.rps || 0).toFixed(1)} per second`],
    ['Error rate', fmt.pct(r.errorRate), `${fmt.num(r.failedRequests)} failed`],
    ['p95 response', fmt.ms(r.p95Ms), `avg ${fmt.ms(r.avgMs)}`],
    ['p99 response', fmt.ms(r.p99Ms), `max ${fmt.ms(r.maxMs)}`],
    ['Checks passed', r.checksRate == null ? '-' : fmt.pct(r.checksRate), `${fmt.num(r.checksFailed)} failed`],
    ['Iterations', fmt.num(r.iterations), `${fmt.bytes(r.dataSentBytes)} sent`],
  ];
}

// ---------------- HTML page ----------------
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

export function renderPage(run, d, base, reports) {
  const r = run.result || {};
  const statusClass = { passed: 'ok', failed: 'bad', error: 'bad', stopped: 'warn' }[run.status] || 'muted';
  const finished = ['passed', 'failed', 'error', 'stopped'].includes(run.status);
  const cards = headline(run).map(([k, v, sub]) => `<div class="card"><div class="k">${k}</div><div class="v">${esc(v)}</div><div class="s">${esc(sub)}</div></div>`).join('');
  const facts = runFacts(run).map(([k, v]) => `<tr><th>${k}</th><td>${esc(v)}</td></tr>`).join('');
  const thr = d.thresholds.length
    ? `<table><tr><th>Metric</th><th>Rule</th><th>Result</th></tr>${d.thresholds.map((t) => `<tr><td>${esc(t.metric)}</td><td><code>${esc(t.expr)}</code></td><td class="${t.ok ? 'ok' : 'bad'}">${t.ok ? 'Passed' : 'Failed'}</td></tr>`).join('')}</table>`
    : '<p class="muted">This script has no thresholds, so pass/fail only reflects errors.</p>';
  const chk = d.checks.length
    ? `<table><tr><th>Check</th><th class="n">Passed</th><th class="n">Failed</th><th class="n">Rate</th></tr>${d.checks.map((c) => `<tr><td>${c.group ? `<span class="muted">${esc(c.group)} › </span>` : ''}${esc(c.name)}</td><td class="n">${fmt.num(c.passes)}</td><td class="n ${c.fails ? 'bad' : ''}">${fmt.num(c.fails)}</td><td class="n">${fmt.pct(c.passes / ((c.passes + c.fails) || 1))}</td></tr>`).join('')}</table>`
    : '<p class="muted">No checks in this script.</p>';
  const tim = d.timings.length
    ? `<table><tr><th>Phase</th><th class="n">Average</th><th class="n">p95</th><th class="n">Max</th></tr>${d.timings.map((t) => `<tr><td>${esc(t.label)}</td><td class="n">${fmt.ms(t.avgMs)}</td><td class="n">${fmt.ms(t.p95Ms)}</td><td class="n">${fmt.ms(t.maxMs)}</td></tr>`).join('')}</table>`
    : '';
  const runners = (r.runners || []).length > 1
    ? `<h2>Runners</h2><table><tr><th>Runner</th><th>Outcome</th><th class="n">Requests</th><th class="n">p95</th></tr>${r.runners.map((x) => `<tr><td>#${x.runner}</td><td>${esc(x.outcome)}</td><td class="n">${fmt.num(x.requests)}</td><td class="n">${fmt.ms(x.p95Ms)}</td></tr>`).join('')}</table><p class="muted">Counts are added up across runners; p95/p99/max show the worst runner.</p>`
    : '';
  const reportTabs = reports.length > 1 ? reports.map((n) => `<a class="tab" href="#" data-runner="${n}">Runner ${n}</a>`).join('') : '';
  const fullReport = reports.length
    ? `<h2 class="noprint">Full k6 report ${reportTabs}</h2><iframe class="noprint" id="k6" src="${base}/view?runner=${reports[0]}" title="k6 report"></iframe>`
    : '<p class="muted noprint">No interactive k6 report for this run (k6 skips it for runs under ~30 s).</p>';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(run.scriptName)} · ${esc(run.id)} · k6kt</title><style>
:root{--bg:#f6f7f9;--fg:#16181d;--muted:#667085;--card:#fff;--line:#e4e7ec;--ok:#067647;--okbg:#ecfdf3;--bad:#b42318;--badbg:#fef3f2;--warn:#b54708;--warnbg:#fffaeb;--accent:#5b3cc4}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--fg:#e8eaed;--muted:#98a2b3;--card:#181b21;--line:#2a2f37;--ok:#47cd89;--okbg:#0d2b1d;--bad:#f97066;--badbg:#2e1513;--warn:#fdb022;--warnbg:#2b2210;--accent:#9e8cff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px 48px}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;margin-bottom:16px}
h1{font-size:22px;margin:0}h2{font-size:17px;margin:28px 0 10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.badge{display:inline-block;padding:2px 10px;border-radius:999px;font-size:13px;font-weight:600;margin-left:8px;vertical-align:middle}
.badge.ok{color:var(--ok);background:var(--okbg)}.badge.bad{color:var(--bad);background:var(--badbg)}.badge.warn{color:var(--warn);background:var(--warnbg)}.badge.muted{color:var(--muted);background:var(--line)}
.actions{display:flex;gap:8px;flex-wrap:wrap}
.btn{display:inline-block;padding:8px 14px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;border:1px solid var(--line);color:var(--fg);background:var(--card)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.card .k{color:var(--muted);font-size:13px}.card .v{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums}.card .s{color:var(--muted);font-size:12px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
th,td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--line);vertical-align:top}tr:last-child td{border-bottom:0}
th{color:var(--muted);font-weight:500;font-size:13px}.n{text-align:right;font-variant-numeric:tabular-nums}
.facts th{width:160px}.ok{color:var(--ok);font-weight:600}.bad{color:var(--bad);font-weight:600}.muted{color:var(--muted)}
code{font-size:13px}.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media (max-width:760px){.grid2{grid-template-columns:1fr}}
.tab{font-size:13px;font-weight:500;padding:3px 10px;border:1px solid var(--line);border-radius:6px;color:var(--fg);text-decoration:none}.tab.on{background:var(--accent);color:#fff;border-color:var(--accent)}
iframe{width:100%;height:80vh;border:1px solid var(--line);border-radius:10px;background:#fff}
.err{background:var(--badbg);color:var(--bad);padding:10px 14px;border-radius:8px;margin-top:12px}
@media print{.noprint,.actions{display:none!important}body{background:#fff}}
</style></head><body><main>
<header><div><h1>${esc(run.scriptName)}<span class="badge ${statusClass}">${esc(run.status)}</span></h1><div class="muted">${esc(run.id)} · ${fmt.date(run.createdAt)}</div></div>
<div class="actions">${finished ? `<a class="btn primary" href="${base}/pdf">Download PDF</a>` : ''}${reports.length ? `<a class="btn" href="${base}/html?runner=${reports[0]}">Download HTML report</a>` : ''}</div></header>
${run.error ? `<div class="err">${esc(run.error)}</div>` : ''}
${finished ? '' : '<p class="muted">This run is still in progress. Refresh the page when it finishes.</p>'}
<div class="cards">${cards}</div>
<div class="grid2"><div><h2>Thresholds (pass/fail rules)</h2>${thr}</div><div><h2>Checks</h2>${chk}</div></div>
${tim ? `<h2>Where the time goes</h2>${tim}` : ''}
${runners}
<h2>Run details</h2><table class="facts">${facts}</table>
${fullReport}
</main><script>
document.querySelectorAll('.tab').forEach((t,i)=>{if(i===0)t.classList.add('on');t.addEventListener('click',e=>{e.preventDefault();document.querySelectorAll('.tab').forEach(x=>x.classList.remove('on'));t.classList.add('on');document.getElementById('k6').src='${base}/view?runner='+t.dataset.runner;document.querySelector('.actions a[href*="/html"]')?.setAttribute('href','${base}/html?runner='+t.dataset.runner);});});
</script></body></html>`;
}

// ---------------- PDF ----------------
export function buildPdf(run, d, pageUrl) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `k6 load test report ${run.id}`, Author: 'k6kt' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = doc.page.width - 96;
    const C = { fg: '#16181d', muted: '#667085', line: '#e4e7ec', ok: '#067647', bad: '#b42318', warn: '#b54708', accent: '#5b3cc4', head: '#f2f4f7' };
    const statusColor = { passed: C.ok, failed: C.bad, error: C.bad, stopped: C.warn }[run.status] || C.muted;

    const ensure = (h) => { if (doc.y + h > doc.page.height - 60) doc.addPage(); };
    const heading = (t) => { ensure(60); doc.moveDown(0.8).font('Helvetica-Bold').fontSize(13).fillColor(C.fg).text(t, 48); doc.moveDown(0.3); };

    function table(cols, rows, { widths, align = [] } = {}) {
      const ws = widths || cols.map(() => W / cols.length);
      const rowH = 20;
      const draw = (cells, y, opts = {}) => {
        let x = 48;
        cells.forEach((cell, i) => {
          const txt = typeof cell === 'object' && cell !== null ? cell.text : String(cell ?? '');
          const color = (typeof cell === 'object' && cell?.color) || opts.color || C.fg;
          doc.font(opts.bold || cell?.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5).fillColor(color)
            .text(txt, x + 6, y + 6, { width: ws[i] - 12, align: align[i] || 'left', lineBreak: false, ellipsis: true });
          x += ws[i];
        });
      };
      ensure(rowH * 2);
      let y = doc.y;
      doc.rect(48, y, W, rowH).fill(C.head);
      draw(cols, y, { color: C.muted, bold: true });
      y += rowH;
      for (const r of rows) {
        if (y + rowH > doc.page.height - 60) { doc.addPage(); y = doc.y; }
        doc.moveTo(48, y).lineTo(48 + W, y).strokeColor(C.line).lineWidth(0.5).stroke();
        draw(r, y);
        y += rowH;
      }
      doc.rect(48, doc.y === y ? y : doc.y, 0, 0);
      doc.y = y + 4;
      doc.x = 48;
    }

    // Title block
    doc.font('Helvetica-Bold').fontSize(20).fillColor(C.fg).text('Load test report', 48, 48);
    doc.font('Helvetica').fontSize(11).fillColor(C.muted).text(`${run.scriptName}  ·  ${run.id}  ·  ${fmt.date(run.createdAt)}`);
    doc.moveDown(0.5);
    const st = String(run.status || '').toUpperCase();
    const bw = doc.font('Helvetica-Bold').fontSize(11).widthOfString(st) + 20;
    const by = doc.y;
    doc.roundedRect(48, by, bw, 20, 10).fill(statusColor);
    doc.fillColor('#fff').text(st, 58, by + 5);
    doc.y = by + 28;
    if (run.error) doc.font('Helvetica').fontSize(10).fillColor(C.bad).text(run.error, 48, doc.y, { width: W });

    // Headline numbers as a 3×2 grid
    doc.moveDown(0.6);
    const items = headline(run);
    const cw = W / 3;
    const gy = doc.y;
    items.forEach(([k, v, sub], i) => {
      const x = 48 + (i % 3) * cw;
      const y = gy + Math.floor(i / 3) * 62;
      doc.roundedRect(x + 2, y, cw - 4, 56, 6).strokeColor(C.line).lineWidth(0.8).stroke();
      doc.font('Helvetica').fontSize(9).fillColor(C.muted).text(k, x + 12, y + 8, { width: cw - 24 });
      doc.font('Helvetica-Bold').fontSize(16).fillColor(C.fg).text(v, x + 12, y + 20, { width: cw - 24 });
      doc.font('Helvetica').fontSize(8.5).fillColor(C.muted).text(sub, x + 12, y + 40, { width: cw - 24 });
    });
    doc.y = gy + 130;
    doc.x = 48;

    heading('Thresholds (pass/fail rules)');
    if (d.thresholds.length) {
      table(['Metric', 'Rule', 'Result'], d.thresholds.map((t) => [t.metric, t.expr, { text: t.ok ? 'Passed' : 'Failed', color: t.ok ? C.ok : C.bad, bold: true }]),
        { widths: [W * 0.4, W * 0.4, W * 0.2] });
    } else doc.font('Helvetica').fontSize(10).fillColor(C.muted).text('This script has no thresholds.');

    heading('Checks');
    if (d.checks.length) {
      table(['Check', 'Passed', 'Failed', 'Rate'], d.checks.map((c) => [
        c.group ? `${c.group} › ${c.name}` : c.name, fmt.num(c.passes),
        { text: fmt.num(c.fails), color: c.fails ? C.bad : C.fg }, fmt.pct(c.passes / ((c.passes + c.fails) || 1)),
      ]), { widths: [W * 0.55, W * 0.15, W * 0.15, W * 0.15], align: ['left', 'right', 'right', 'right'] });
    } else doc.font('Helvetica').fontSize(10).fillColor(C.muted).text('No checks in this script.');

    if (d.timings.length) {
      heading('Where the time goes');
      table(['Phase', 'Average', 'p95', 'Max'], d.timings.map((t) => [t.label, fmt.ms(t.avgMs), fmt.ms(t.p95Ms), fmt.ms(t.maxMs)]),
        { widths: [W * 0.46, W * 0.18, W * 0.18, W * 0.18], align: ['left', 'right', 'right', 'right'] });
    }

    const rs = run.result?.runners || [];
    if (rs.length > 1) {
      heading('Runners');
      table(['Runner', 'Outcome', 'Requests', 'p95'], rs.map((x) => [`#${x.runner}`, x.outcome, fmt.num(x.requests), fmt.ms(x.p95Ms)]),
        { widths: [W * 0.15, W * 0.45, W * 0.2, W * 0.2], align: ['left', 'left', 'right', 'right'] });
      doc.font('Helvetica').fontSize(8.5).fillColor(C.muted).text('Counts are added up across runners; p95/p99/max show the worst runner.');
    }

    heading('Run details');
    table(['Item', 'Value'], runFacts(run).map(([k, v]) => [k, v ?? '-']), { widths: [W * 0.3, W * 0.7] });

    doc.moveDown(1);
    doc.font('Helvetica').fontSize(8.5).fillColor(C.muted)
      .text(`Generated ${fmt.date(new Date().toISOString())} by k6kt. Interactive charts: `, 48, doc.y, { continued: true, width: W })
      .fillColor(C.accent).text(pageUrl, { link: pageUrl, underline: true });
    doc.end();
  });
}
