// Printable PDF summary of one run.
import PDFDocument from 'pdfkit';
import type { Run } from '../types.ts';
import { APP_NAME, fmt, headline, runFacts, type Details } from './details.ts';

type Cell = string | { text: string; color?: string; bold?: boolean };

export function buildPdf(run: Run, d: Details, pageUrl: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `${APP_NAME} report ${run.id}`, Author: APP_NAME } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = doc.page.width - 96;
    const C = { fg: '#0e1e25', muted: '#66757b', line: '#e1e5e6', ok: '#067647', bad: '#c0332f', warn: '#9a5b00', accent: '#04807b', head: '#f1f3f3' };
    const statusColor = ({ passed: C.ok, failed: C.bad, error: C.bad, stopped: C.warn } as Record<string, string>)[run.status] ?? C.muted;

    const ensure = (h: number) => { if (doc.y + h > doc.page.height - 60) doc.addPage(); };
    const heading = (t: string) => { ensure(60); doc.moveDown(0.8).font('Helvetica-Bold').fontSize(13).fillColor(C.fg).text(t, 48); doc.moveDown(0.3); };
    const note = (t: string) => doc.font('Helvetica').fontSize(9).fillColor(C.muted).text(t, 48, doc.y, { width: W });

    function table(cols: string[], rows: Cell[][], widths: number[], align: ('left' | 'right')[] = []) {
      const rowH = 20;
      const draw = (cells: Cell[], y: number, head = false) => {
        let x = 48;
        cells.forEach((cell, i) => {
          const c = typeof cell === 'string' ? { text: cell } : cell;
          doc.font(head || c.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5).fillColor(head ? C.muted : c.color ?? C.fg)
            .text(c.text, x + 6, y + 6, { width: widths[i] - 12, align: align[i] ?? 'left', lineBreak: false, ellipsis: true });
          x += widths[i];
        });
      };
      ensure(rowH * 2);
      let y = doc.y;
      doc.rect(48, y, W, rowH).fill(C.head);
      draw(cols, y, true);
      y += rowH;
      for (const r of rows) {
        if (y + rowH > doc.page.height - 60) { doc.addPage(); y = doc.y; }
        doc.moveTo(48, y).lineTo(48 + W, y).strokeColor(C.line).lineWidth(0.5).stroke();
        draw(r, y);
        y += rowH;
      }
      doc.y = y + 4;
      doc.x = 48;
    }

    // Title block
    doc.font('Helvetica').fontSize(10).fillColor(C.accent).text(APP_NAME.toUpperCase(), 48, 48, { characterSpacing: 1 });
    doc.font('Helvetica-Bold').fontSize(20).fillColor(C.fg).text('Load test report');
    doc.font('Helvetica').fontSize(11).fillColor(C.muted).text(`${run.scriptName}  ·  ${run.id}  ·  ${fmt.date(run.createdAt)}`);
    doc.moveDown(0.5);
    const st = run.status.toUpperCase();
    const bw = doc.font('Helvetica-Bold').fontSize(11).widthOfString(st) + 20;
    const by = doc.y;
    doc.roundedRect(48, by, bw, 20, 10).fill(statusColor);
    doc.fillColor('#fff').text(st, 58, by + 5);
    doc.y = by + 28;
    if (run.error) doc.font('Helvetica').fontSize(10).fillColor(C.bad).text(run.error, 48, doc.y, { width: W });

    // Headline numbers as a 3 × 2 grid
    doc.moveDown(0.6);
    const cw = W / 3;
    const gy = doc.y;
    headline(run).forEach(([k, v, sub], i) => {
      const x = 48 + (i % 3) * cw;
      const y = gy + Math.floor(i / 3) * 62;
      doc.roundedRect(x + 2, y, cw - 4, 56, 6).strokeColor(C.line).lineWidth(0.8).stroke();
      doc.font('Helvetica').fontSize(9).fillColor(C.muted).text(k, x + 12, y + 8, { width: cw - 24 });
      doc.font('Helvetica-Bold').fontSize(16).fillColor(C.fg).text(v, x + 12, y + 20, { width: cw - 24 });
      doc.font('Helvetica').fontSize(8.5).fillColor(C.muted).text(sub, x + 12, y + 40, { width: cw - 24 });
    });
    doc.y = gy + 130;
    doc.x = 48;

    heading('Pass rules');
    if (d.thresholds.length) {
      table(['Metric', 'Rule', 'Result'], d.thresholds.map((t) => [t.metric, t.expr, { text: t.ok ? 'Passed' : 'Failed', color: t.ok ? C.ok : C.bad, bold: true }]),
        [W * 0.42, W * 0.38, W * 0.2]);
    } else note('This test has no pass/fail rules.');

    heading('Checks');
    if (d.checks.length) {
      table(['Check', 'Passed', 'Failed', 'Rate'], d.checks.map((c) => [
        c.group ? `${c.group} › ${c.name}` : c.name, fmt.num(c.passes),
        { text: fmt.num(c.fails), color: c.fails ? C.bad : C.fg }, fmt.pct(c.passes / ((c.passes + c.fails) || 1)),
      ]), [W * 0.55, W * 0.15, W * 0.15, W * 0.15], ['left', 'right', 'right', 'right']);
    } else note('No checks in this test.');

    const eps = run.result?.endpoints ?? [];
    if (eps.length) {
      heading('Per API');
      table(['API', 'Requests', 'Errors', 'Average', 'p95', 'Max'], eps.map((e) => [
        e.name, fmt.num(e.requests), { text: fmt.pct(e.errorRate), color: e.failed ? C.bad : C.fg }, fmt.ms(e.avgMs), fmt.ms(e.p95Ms), fmt.ms(e.maxMs),
      ]), [W * 0.35, W * 0.13, W * 0.13, W * 0.13, W * 0.13, W * 0.13], ['left', 'right', 'right', 'right', 'right', 'right']);
    }

    if (d.timings.length) {
      heading('Where the time goes');
      table(['Phase', 'Average', 'p95', 'Max'], d.timings.map((t) => [t.label, fmt.ms(t.avgMs), fmt.ms(t.p95Ms), fmt.ms(t.maxMs)]),
        [W * 0.46, W * 0.18, W * 0.18, W * 0.18], ['left', 'right', 'right', 'right']);
    }

    const rs = run.result?.runners ?? [];
    if (rs.length > 1) {
      heading('Machines');
      table(['Machine', 'Outcome', 'Requests', 'p95'], rs.map((x) => [`#${x.runner}`, x.outcome, fmt.num(x.requests), fmt.ms(x.p95Ms)]),
        [W * 0.15, W * 0.45, W * 0.2, W * 0.2], ['left', 'left', 'right', 'right']);
      note('Counts are added up across machines; p95/p99/max show the slowest machine.');
    }

    heading('Run details');
    table(['Item', 'Value'], runFacts(run).map(([k, v]) => [k, v ?? '-']), [W * 0.3, W * 0.7]);

    doc.moveDown(1);
    doc.font('Helvetica').fontSize(8.5).fillColor(C.muted)
      .text(`Generated ${fmt.date(new Date().toISOString())} by ${APP_NAME}. Interactive charts: `, 48, doc.y, { continued: true, width: W })
      .fillColor(C.accent).text(pageUrl, { link: pageUrl, underline: true });
    doc.end();
  });
}
