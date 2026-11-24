// Small HTTP helpers for the API Gateway (HTTP API, payload v2) handler.
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { Project } from '../../lib/types.ts';

export type Event = APIGatewayProxyEventV2;
export type Result = APIGatewayProxyStructuredResultV2;

export interface Ctx {
  tokenName: string;
  project: Project;
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const json = (status: number, body: unknown): Result => ({
  statusCode: status,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const html = (status: number, body: string): Result => ({
  statusCode: status,
  headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  body,
});

export function readBody<T = Record<string, unknown>>(event: Event): T {
  if (!event.body) return {} as T;
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new HttpError(400, 'body must be JSON');
  }
}

export const host = (event: Event) => event.requestContext?.domainName ?? event.headers?.host ?? '';
