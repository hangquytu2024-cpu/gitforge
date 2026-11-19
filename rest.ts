// The REST v3 surface: routing, JSON bodies, pagination headers. All logic lives in domain.ts.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { authorized, epoch, JSON_TYPE, nextRequestId, readBody, sendError, sendJson } from './http.ts';
import * as d from './domain.ts';
import { viewerLogin } from './store.ts';

const PREFIX = '/api/v3';
const notFound = (res: ServerResponse): true => { sendError(res, 404, 'Not Found'); return true; };

function parseBody(raw: Buffer): d.Json | null {
  const text = raw.toString('utf8').trim();
  if (text === '') return {};
  try {
    const v = JSON.parse(text);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as d.Json) : null;
  } catch { return null; }
}

function paging(q: URLSearchParams): d.PageOpts {
  const pp = parseInt(q.get('per_page') ?? '', 10);
  const pg = parseInt(q.get('page') ?? '', 10);
  return { page: pg >= 1 ? pg : 1, perPage: pp >= 1 ? Math.min(pp, 100) : 30 };
}

function linkHeader(origin: string, url: URL, o: d.PageOpts, total: number): Record<string, string> {
  const last = Math.max(1, Math.ceil(total / o.perPage));
  const make = (page: number, rel: string): string => {
    const u = new URL(url.pathname, origin);
    for (const [k, v] of url.searchParams) if (k !== 'page') u.searchParams.set(k, v);
    u.searchParams.set('page', String(page));
    return `<${u.toString()}>; rel="${rel}"`;
  };
  const parts: string[] = [];
  if (o.page < last) parts.push(make(o.page + 1, 'next'), make(last, 'last'));
  if (o.page > 1) parts.push(make(o.page - 1, 'prev'), make(1, 'first'));
  return parts.length === 0 ? {} : { link: parts.join(', ') };
}

function send(res: ServerResponse, result: unknown, status = 200): true {
  if (d.isFailure(result)) sendError(res, result.error.status, result.error.message);
  else sendJson(res, status, result);
  return true;
}

function sendPage(res: ServerResponse, origin: string, url: URL, o: d.PageOpts, result: d.Page<d.Json> | d.Failure): true {
  if (d.isFailure(result)) return send(res, result);
  sendJson(res, 200, result.items, linkHeader(origin, url, o, result.total));
  return true;
}

const issueCache = new Map<string, { epoch: number; text: string; len: number }>();

export async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const method = req.method ?? 'GET';
  const host = req.headers.host ?? 'localhost';
  const origin = `http://${host}`;
  let url: URL;
  try { url = new URL(req.url ?? '/', origin); } catch { return notFound(res); }
  d.setOrigin(origin);
  const segs = url.pathname.slice(PREFIX.length).split('/').filter((s) => s !== '');

  if (segs.length === 0) {
    if (method !== 'GET') return notFound(res);
    sendJson(res, 200, { current_user_url: `${origin}${PREFIX}/user`, repository_url: `${origin}${PREFIX}/repos/{owner}/{repo}`, rate_limit_url: `${origin}${PREFIX}/rate_limit` }, { 'x-oauth-scopes': 'repo, read:org, user' });
    return true;
  }
  if (segs[0] === 'meta' && segs.length === 1 && method === 'GET') { sendJson(res, 200, { installed_version: '3.14.0', verifiable_password_authentication: false }); return true; }
  if (!authorized(req)) { sendError(res, 401, 'Requires authentication'); return true; }

  let body: d.Json = {};
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    const parsed = parseBody(await readBody(req));
    if (parsed === null) { sendError(res, 400, 'Problems parsing JSON'); return true; }
    body = parsed;
    d.setOrigin(origin);
  }
  const q = url.searchParams;
  const o = paging(q);
  const cacheKey = method === 'GET' ? `${origin}${url.pathname}` : '';
  if (cacheKey !== '') {
    const hit = issueCache.get(cacheKey);
    if (hit !== undefined && hit.epoch === epoch) {
      res.writeHead(200, { 'content-type': JSON_TYPE, 'content-length': hit.len, 'x-github-request-id': nextRequestId() });
      res.end(hit.text);
      return true;
    }
  }

  if (segs[0] === 'user') {
    if (segs.length === 1 && method === 'GET') return send(res, d.userJson(viewerLogin()));
    if (segs.length === 2 && segs[1] === 'repos') {
      if (method === 'GET') return sendPage(res, origin, url, o, d.listRepositories(o));
      if (method === 'POST') return send(res, d.createRepository(body), 201);
    }
    return notFound(res);
  }
  if (segs[0] === 'rate_limit' && segs.length === 1 && method === 'GET') {
    const r = { limit: 5000, remaining: 5000, reset: 0, used: 0 };
    sendJson(res, 200, { resources: { core: r }, rate: r });
    return true;
  }
  if (segs[0] !== 'repos' || segs.length < 3) return notFound(res);

  let owner: string;
  let name: string;
  let tail: string[];
  try {
    owner = decodeURIComponent(segs[1] as string);
    name = decodeURIComponent(segs[2] as string);
    tail = segs.slice(3).map((s) => decodeURIComponent(s));
  } catch { return notFound(res); }
  const num = (s: string | undefined): number | null => (s !== undefined && /^\d{1,15}$/.test(s) ? Number(s) : null);

  if (tail.length === 0) {
    if (method === 'GET') return send(res, d.getRepository(owner, name));
    if (method === 'PATCH') return send(res, d.patchRepository(owner, name, body));
    if (method === 'DELETE') {
      const r = d.deleteRepository(owner, name);
      if (d.isFailure(r)) return send(res, r);
      res.writeHead(204, { 'x-github-request-id': nextRequestId() });
      res.end();
      return true;
    }
    return notFound(res);
  }
  const head = tail[0];
  if (head === 'branches' && tail.length === 1 && method === 'GET') return sendPage(res, origin, url, o, d.listBranches(owner, name, o));
  if (head === 'commits' && tail.length === 1 && method === 'GET') return sendPage(res, origin, url, o, d.listCommits(owner, name, { ...o, sha: q.get('sha') ?? undefined }));
  if (head === 'contents') {
    const path = tail.slice(1).join('/');
    if (method === 'GET') return send(res, d.getContents(owner, name, path, q.get('ref') ?? undefined));
    if (method === 'PUT') {
      const r = d.putContents(owner, name, path, body);
      return d.isFailure(r) ? send(res, r) : send(res, r.body, r.created ? 201 : 200);
    }
    if (method === 'DELETE') return send(res, d.deleteContents(owner, name, path, body));
    return notFound(res);
  }
  if (head === 'git' && tail[1] === 'refs' && tail.length === 2 && method === 'POST') return send(res, d.createRef(owner, name, body), 201);
  if (head === 'labels' && tail.length === 1) {
    if (method === 'GET') return sendPage(res, origin, url, o, d.listLabels(owner, name, o));
    if (method === 'POST') return send(res, d.createLabel(owner, name, body), 201);
    return notFound(res);
  }
  if (head === 'issues') {
    if (tail.length === 1) {
      if (method === 'GET') return sendPage(res, origin, url, o, d.listIssues(owner, name, { ...o, state: q.get('state') ?? undefined, sort: q.get('sort') ?? undefined, direction: q.get('direction') ?? undefined, labels: q.get('labels') ?? undefined }));
      if (method === 'POST') return send(res, d.createIssue(owner, name, body), 201);
      return notFound(res);
    }
    const n = num(tail[1]);
    if (n === null) return notFound(res);
    if (tail.length === 2) {
      if (method === 'GET') {
        const r = d.getIssue(owner, name, n);
        if (d.isFailure(r)) return send(res, r);
        const text = `${JSON.stringify(r)}
`;
        const len = Buffer.byteLength(text);
        issueCache.set(cacheKey, { epoch, text, len });
        res.writeHead(200, { 'content-type': JSON_TYPE, 'content-length': len, 'x-github-request-id': nextRequestId() });
        res.end(text);
        return true;
      }
      if (method === 'PATCH') return send(res, d.updateIssue(owner, name, n, body));
      return notFound(res);
    }
    if (tail.length === 3 && tail[2] === 'comments') {
      if (method === 'GET') return sendPage(res, origin, url, o, d.listComments(owner, name, n, o));
      if (method === 'POST') return send(res, d.createComment(owner, name, n, body), 201);
    }
    return notFound(res);
  }
  if (head === 'pulls') {
    if (tail.length === 1) {
      if (method === 'GET') return sendPage(res, origin, url, o, d.listPulls(owner, name, { ...o, state: q.get('state') ?? undefined, head: q.get('head') ?? undefined, base: q.get('base') ?? undefined, direction: q.get('direction') ?? undefined }));
      if (method === 'POST') return send(res, d.createPull(owner, name, body), 201);
      return notFound(res);
    }
    const n = num(tail[1]);
    if (n === null) return notFound(res);
    if (tail.length === 2) {
      if (method === 'GET') return send(res, d.getPull(owner, name, n));
      if (method === 'PATCH') return send(res, d.updatePull(owner, name, n, body));
      return notFound(res);
    }
    if (tail.length === 3 && tail[2] === 'files' && method === 'GET') return sendPage(res, origin, url, o, d.listPullFiles(owner, name, n, o));
    if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') return send(res, d.mergePull(owner, name, n, body));
    if (tail.length === 3 && tail[2] === 'comments') {
      if (method === 'GET') return sendPage(res, origin, url, o, d.listComments(owner, name, n, o));
      if (method === 'POST') return send(res, d.createComment(owner, name, n, body), 201);
    }
  }
  return notFound(res);
}
