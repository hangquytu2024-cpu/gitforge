// Small HTTP helpers every surface shares: read a body, answer JSON, the request id, and the bearer check.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { state } from './store.ts';

export const JSON_TYPE = 'application/json; charset=utf-8';
let requestCounter = 0;

/** A request id that is stable per process run and never random: a counter in hex. */
export const nextRequestId = (): string => `FORGE-${(++requestCounter).toString(16).padStart(8, '0')}`;

/** The whole request body as a buffer (gzip is not handled here: git surfaces inflate it themselves). */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': nextRequestId(), ...headers });
  res.end(text);
}

export const sendError = (res: ServerResponse, status: number, message: string, extra: Record<string, unknown> = {}): void => sendJson(res, status, { message, documentation_url: 'https://docs.github.com/rest', ...extra });

/** Whether the request carries the bearer token (or a Basic password equal to it, as git clients send). */
export function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (state.token === '') return header !== '';
  if (header === `Bearer ${state.token}` || header === `token ${state.token}`) return true;
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    return decoded.endsWith(`:${state.token}`) || decoded === state.token;
  }
  return false;
}

export function pathOf(req: IncomingMessage): string {
  try { return new URL(req.url ?? '/', 'http://entry').pathname; } catch { return '/'; }
}

export function queryOf(req: IncomingMessage): URLSearchParams {
  try { return new URL(req.url ?? '/', 'http://entry').searchParams; } catch { return new URLSearchParams(); }
}
