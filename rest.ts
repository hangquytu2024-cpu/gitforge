// The REST v3 surface (minimal seed: the REST agent grows it). Answers /api/v3 requests.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { authorized, pathOf, readBody, sendError, sendJson } from './http.ts';
import { createRepo, findRepo, viewerLogin, type Repo } from './store.ts';

const repoJson = (r: Repo) => ({
  id: r.id, name: r.name, full_name: `${r.owner}/${r.name}`, private: r.private, description: r.description,
  default_branch: r.defaultBranch, owner: { login: r.owner }, created_at: r.createdAt, updated_at: r.updatedAt, pushed_at: r.pushedAt,
});

export async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = pathOf(req).replace(/\/+$/, '');
  const method = req.method ?? 'GET';
  if (method === 'GET' && path === '/api/v3') {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (!authorized(req)) { sendError(res, 401, 'Requires authentication'); return true; }
  if (method === 'POST' && path === '/api/v3/user/repos') {
    let body: { name?: string; private?: boolean; description?: string };
    try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch { sendError(res, 400, 'Problems parsing JSON'); return true; }
    if (typeof body.name !== 'string' || body.name === '') { sendError(res, 422, 'Validation Failed'); return true; }
    const repo = createRepo(body.name, { private: body.private, description: body.description ?? null });
    if (repo === null) { sendError(res, 422, 'Validation Failed: name already exists on this account'); return true; }
    sendJson(res, 201, repoJson(repo));
    return true;
  }
  const m = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)$/.exec(path);
  if (method === 'GET' && m !== null) {
    const repo = findRepo(decodeURIComponent(m[1] as string), decodeURIComponent(m[2] as string));
    if (repo === null) sendError(res, 404, 'Not Found');
    else sendJson(res, 200, repoJson(repo));
    return true;
  }
  void viewerLogin;
  return false;
}
