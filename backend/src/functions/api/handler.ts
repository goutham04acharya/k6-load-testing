// HTTP API used by the web app and the loadtest CLI.
// Auth: "Authorization: Bearer <token>"; tokens are stored as SHA-256 hashes in DynamoDB.
import { HttpError, json, type Ctx, type Event, type Result } from './http.ts';
import {
  authenticate, createRun, finishRun, getRunStatus, linkInfo, listRuns, reportLink, scriptLink, startRun, stopRun, uploadUrls, whoami,
} from './runs.ts';
import { sharePage } from './share.ts';

type Route = [method: string, path: RegExp, run: (ctx: Ctx, event: Event, id: string) => Result | Promise<Result>];

const RUN = '(r-[a-f0-9]+)';
const routes: Route[] = [
  ['GET', /^\/whoami$/, (c) => whoami(c)],
  ['POST', /^\/runs$/, (c, e) => createRun(c, e)],
  ['GET', /^\/runs$/, (c, e) => listRuns(c, e)],
  ['GET', new RegExp(`^/runs/${RUN}$`), (c, _e, id) => getRunStatus(c, id)],
  ['POST', new RegExp(`^/runs/${RUN}/start$`), (c, _e, id) => startRun(c, id)],
  ['POST', new RegExp(`^/runs/${RUN}/stop$`), (c, _e, id) => stopRun(c, id)],
  ['POST', new RegExp(`^/runs/${RUN}/uploads$`), (c, _e, id) => uploadUrls(c, id)],
  ['POST', new RegExp(`^/runs/${RUN}/finish$`), (c, e, id) => finishRun(c, id, e)],
  ['GET', new RegExp(`^/runs/${RUN}/report$`), (c, e, id) => reportLink(c, id, e)],
  ['GET', new RegExp(`^/runs/${RUN}/script$`), (c, _e, id) => scriptLink(c, id)],
  ['GET', new RegExp(`^/runs/${RUN}/link$`), (c, e, id) => linkInfo(c, id, e)],
];

export async function handler(event: Event): Promise<Result> {
  const method = event.requestContext?.http?.method;
  const path = (event.rawPath || '/').replace(/\/+$/, '') || '/';
  try {
    if (method === 'OPTIONS') return { statusCode: 204 };
    if (method === 'GET' && path === '/health') return json(200, { ok: true });
    if (method === 'GET' && path.startsWith('/r/')) return await sharePage(event);
    const route = routes.find(([m, re]) => m === method && re.test(path));
    if (!route) throw new HttpError(404, `no route ${method} ${path}`);
    const ctx = await authenticate(event);
    return await route[2](ctx, event, path.match(route[1])?.[1] ?? '');
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.message });
    if ((e as { name?: string }).name === 'ConditionalCheckFailedException') return json(409, { error: 'run changed state, try again' });
    console.error(e);
    return json(500, { error: 'internal error' });
  }
}
