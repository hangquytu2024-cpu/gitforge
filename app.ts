// The forge's HTTP server: routes a request to the surface that owns its path. The surfaces are
// separate modules (rest.ts, git.ts, graphql.ts, mcp.ts), each exporting handle(req, res) that returns
// true once it has answered. main.ts is the entry <-> env lifecycle and stays as the starter ships it.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { pathOf, sendError, sendJson } from './http.ts';
import { handle as handleGit } from './git.ts';
import { handle as handleGraphql } from './graphql.ts';
import { handle as handleMcp } from './mcp.ts';
import { handle as handleRest } from './rest.ts';

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = pathOf(req);
  if (req.method === 'GET' && path === '/healthz') return void sendJson(res, 200, { ok: true });
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (await handleRest(req, res)) return;
  } else if (path === '/api/graphql') {
    if (await handleGraphql(req, res)) return;
  } else if (path === '/mcp') {
    if (await handleMcp(req, res)) return;
  } else if (await handleGit(req, res)) return;
  sendError(res, 404, 'Not Found');
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req, res) => {
    route(req, res).catch((err: unknown) => {
      if (!res.headersSent) sendError(res, 500, `Server Error: ${err instanceof Error ? err.message : String(err)}`);
      else res.end();
    });
  });
}
