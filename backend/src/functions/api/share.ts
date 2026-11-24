// Public report pages: /r/<run-id>/<key>[/pdf|/html|/view]. No login; the key is the secret.
import { timingSafeEqual } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { BUCKET, exists, getRun, runPrefix, s3 } from '../../lib/store.ts';
import { FINISHED } from '../../lib/types.ts';
import { loadDetails } from '../../lib/report/details.ts';
import { notFoundPage, renderPage } from '../../lib/report/page.ts';
import { buildPdf } from '../../lib/report/pdf.ts';
import { host, html, type Event, type Result } from './http.ts';

const FILE_PREFIX = 'load-testing-k6';

export async function sharePage(event: Event): Promise<Result> {
  const m = event.rawPath.match(/^\/r\/(r-[a-f0-9]+)\/([a-f0-9]{32})(?:\/(pdf|html|view))?\/?$/);
  if (!m) return html(404, notFoundPage());
  const [, id, key, action] = m;
  const run = await getRun(id);
  if (!run?.shareKey || !timingSafeEqual(Buffer.from(run.shareKey), Buffer.from(key))) return html(404, notFoundPage());

  const base = `/r/${id}/${key}`;
  const n = run.mode === 'cloud' ? run.runners ?? 1 : 1;
  const reportKey = (r: number) => `${runPrefix(id)}/runner-${r}/report.html`;
  const redirect = async (Key: string, type: string, download?: string): Promise<Result> => ({
    statusCode: 302,
    headers: {
      'cache-control': 'no-store',
      location: await getSignedUrl(s3, new GetObjectCommand({
        Bucket: BUCKET, Key, ResponseContentType: type,
        ResponseContentDisposition: download ? `attachment; filename="${download}"` : undefined,
      }), { expiresIn: 600 }),
    },
  });
  const runner = Math.min(Math.max(Number(event.queryStringParameters?.runner) || 1, 1), n);

  if (action === 'view' || action === 'html') {
    if (!(await exists(reportKey(runner)))) return html(404, notFoundPage());
    return redirect(reportKey(runner), 'text/html; charset=utf-8',
      action === 'html' ? `${FILE_PREFIX}-${id}${n > 1 ? `-machine${runner}` : ''}.html` : undefined);
  }

  if (action === 'pdf') {
    const pdfKey = `${runPrefix(id)}/report.pdf`;
    // Built the first time it is asked for, then served from S3.
    if (!FINISHED.includes(run.status) || !(await exists(pdfKey))) {
      const pdf = await buildPdf(run, await loadDetails(run), `https://${host(event)}${base}`);
      await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: pdfKey, Body: pdf, ContentType: 'application/pdf' }));
    }
    return redirect(pdfKey, 'application/pdf', `${FILE_PREFIX}-${id}.pdf`);
  }

  const reports: number[] = [];
  for (let i = 1; i <= n; i++) if (await exists(reportKey(i))) reports.push(i);
  return html(200, renderPage(run, await loadDetails(run), base, reports));
}
