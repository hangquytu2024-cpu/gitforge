// The mcp surface: Model Context Protocol over streamable HTTP, POST /mcp, JSON-RPC 2.0. Tools call domain.ts.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { authorized, readBody, sendError, sendJson } from './http.ts';
import * as d from './domain.ts';
import { viewerLogin } from './store.ts';

type Args = Record<string, unknown>;
interface Tool { name: string; description: string; props: Record<string, Record<string, unknown>>; required: string[]; run: (a: Args) => unknown }

const SUPPORTED = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const S = { type: 'string' };
const N = { type: 'number' };
const OWNER = { owner: { ...S, description: 'Repository owner' }, repo: { ...S, description: 'Repository name' } };
const PAGE = { page: { ...N, description: 'Page number' }, perPage: { ...N, description: 'Results per page' } };

class ArgError extends Error {}
const need = (a: Args, k: string): string => {
  const v = a[k];
  if (typeof v !== 'string' || v === '') throw new ArgError(`missing required argument: ${k}`);
  return v;
};
const needNum = (a: Args, k: string): number => {
  const v = a[k];
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n)) throw new ArgError(`missing or invalid required argument: ${k}`);
  return n;
};
const opt = (a: Args, k: string): string | undefined => (typeof a[k] === 'string' ? (a[k] as string) : undefined);
const pg = (a: Args): d.PageOpts => ({
  page: typeof a.page === 'number' && a.page >= 1 ? Math.trunc(a.page) : 1,
  perPage: typeof a.perPage === 'number' && a.perPage >= 1 ? Math.min(100, Math.trunc(a.perPage)) : 30,
});
const unwrapPage = (p: unknown): unknown => (d.isFailure(p) ? p : (p as d.Page<unknown>).items);
const or = (a: Args, ...ks: string[]): Args => { const o: Args = {}; for (const k of ks) if (a[k] !== undefined) o[k] = a[k]; return o; };

const TOOLS: Tool[] = [
  { name: 'create_repo', description: 'Create a new repository for the authenticated user', props: { name: { ...S, description: 'Repository name' }, description: { ...S, description: 'Repository description' }, private: { type: 'boolean', description: 'Whether the repository is private' }, autoInit: { type: 'boolean', description: 'Initialize with a README' } }, required: ['name'],
    run: (a) => d.createRepository({ name: need(a, 'name'), description: opt(a, 'description'), private: a.private === true, auto_init: a.autoInit === true }) },
  { name: 'get_repo', description: 'Get details of a repository', props: OWNER, required: ['owner', 'repo'], run: (a) => d.getRepository(need(a, 'owner'), need(a, 'repo')) },
  { name: 'list_branches', description: 'List branches of a repository', props: { ...OWNER, ...PAGE }, required: ['owner', 'repo'], run: (a) => unwrapPage(d.listBranches(need(a, 'owner'), need(a, 'repo'), pg(a))) },
  { name: 'list_commits', description: 'List commits of a branch or sha in a repository', props: { ...OWNER, sha: { ...S, description: 'Branch name or commit sha' }, ...PAGE }, required: ['owner', 'repo'], run: (a) => unwrapPage(d.listCommits(need(a, 'owner'), need(a, 'repo'), { ...pg(a), sha: opt(a, 'sha') })) },
  { name: 'get_file_contents', description: 'Get the contents of a file or directory in a repository', props: { ...OWNER, path: { ...S, description: 'Path to the file or directory' }, ref: { ...S, description: 'Branch, tag or commit sha' } }, required: ['owner', 'repo'], run: (a) => d.getContents(need(a, 'owner'), need(a, 'repo'), opt(a, 'path') ?? '', opt(a, 'ref') ?? opt(a, 'branch')) },
  { name: 'create_or_update_file', description: 'Create or update a single file in a repository; content is plain text', props: { ...OWNER, path: { ...S, description: 'Path of the file' }, content: { ...S, description: 'File content' }, message: { ...S, description: 'Commit message' }, branch: { ...S, description: 'Branch name' }, sha: { ...S, description: 'Blob sha of the file being replaced' } }, required: ['owner', 'repo', 'path', 'content', 'message'],
    run: (a) => {
      const r = d.putContents(need(a, 'owner'), need(a, 'repo'), need(a, 'path'), { message: need(a, 'message'), content: Buffer.from(typeof a.content === 'string' ? a.content : need(a, 'content'), 'utf8').toString('base64'), ...or(a, 'branch', 'sha') });
      return d.isFailure(r) ? r : r.body;
    } },
  { name: 'create_branch', description: 'Create a branch from an existing branch or sha', props: { ...OWNER, branch: { ...S, description: 'New branch name' }, from_branch: { ...S, description: 'Source branch (default branch when omitted)' } }, required: ['owner', 'repo', 'branch'],
    run: (a) => {
      const owner = need(a, 'owner'); const repo = need(a, 'repo');
      const info = d.getRepository(owner, repo);
      if (d.isFailure(info)) return info;
      const from = opt(a, 'from_branch') ?? (info.default_branch as string);
      const commits = d.listCommits(owner, repo, { page: 1, perPage: 1, sha: from });
      if (d.isFailure(commits)) return commits;
      const sha = commits.items[0]?.sha;
      if (typeof sha !== 'string') return d.fail(422, 'Validation Failed: source branch has no commits');
      return d.createRef(owner, repo, { ref: `refs/heads/${need(a, 'branch')}`, sha });
    } },
  { name: 'create_issue', description: 'Create an issue in a repository', props: { ...OWNER, title: { ...S, description: 'Issue title' }, body: { ...S, description: 'Issue body' }, labels: { type: 'array', items: S, description: 'Label names' } }, required: ['owner', 'repo', 'title'], run: (a) => d.createIssue(need(a, 'owner'), need(a, 'repo'), { title: need(a, 'title'), ...or(a, 'body', 'labels') }) },
  { name: 'get_issue', description: 'Get an issue by number', props: { ...OWNER, issue_number: { ...N, description: 'Issue number' } }, required: ['owner', 'repo', 'issue_number'], run: (a) => d.getIssue(need(a, 'owner'), need(a, 'repo'), needNum(a, 'issue_number')) },
  { name: 'list_issues', description: 'List issues of a repository', props: { ...OWNER, state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Issue state' }, labels: { type: 'array', items: S, description: 'Label names' }, ...PAGE }, required: ['owner', 'repo'],
    run: (a) => unwrapPage(d.listIssues(need(a, 'owner'), need(a, 'repo'), { ...pg(a), state: opt(a, 'state'), labels: Array.isArray(a.labels) ? a.labels.join(',') : opt(a, 'labels') })) },
  { name: 'update_issue', description: 'Update the title, body, state or labels of an issue', props: { ...OWNER, issue_number: { ...N, description: 'Issue number' }, title: S, body: S, state: { type: 'string', enum: ['open', 'closed'] }, labels: { type: 'array', items: S } }, required: ['owner', 'repo', 'issue_number'], run: (a) => d.updateIssue(need(a, 'owner'), need(a, 'repo'), needNum(a, 'issue_number'), or(a, 'title', 'body', 'state', 'labels')) },
  { name: 'add_issue_comment', description: 'Add a comment to an issue or pull request', props: { ...OWNER, issue_number: { ...N, description: 'Issue or pull request number' }, body: { ...S, description: 'Comment text' } }, required: ['owner', 'repo', 'issue_number', 'body'], run: (a) => d.createComment(need(a, 'owner'), need(a, 'repo'), needNum(a, 'issue_number'), { body: need(a, 'body') }) },
  { name: 'get_issue_comments', description: 'List comments of an issue or pull request', props: { ...OWNER, issue_number: N, ...PAGE }, required: ['owner', 'repo', 'issue_number'], run: (a) => unwrapPage(d.listComments(need(a, 'owner'), need(a, 'repo'), needNum(a, 'issue_number'), pg(a))) },
  { name: 'create_label', description: 'Create a label in a repository', props: { ...OWNER, name: S, color: S, description: S }, required: ['owner', 'repo', 'name'], run: (a) => d.createLabel(need(a, 'owner'), need(a, 'repo'), or(a, 'name', 'color', 'description')) },
  { name: 'create_pull_request', description: 'Create a pull request', props: { ...OWNER, title: { ...S, description: 'Pull request title' }, body: { ...S, description: 'Pull request body' }, head: { ...S, description: 'Head branch' }, base: { ...S, description: 'Base branch' }, draft: { type: 'boolean' } }, required: ['owner', 'repo', 'title', 'head', 'base'], run: (a) => d.createPull(need(a, 'owner'), need(a, 'repo'), { title: need(a, 'title'), head: need(a, 'head'), base: need(a, 'base'), ...or(a, 'body', 'draft') }) },
  { name: 'get_pull_request', description: 'Get a pull request by number', props: { ...OWNER, pull_number: { ...N, description: 'Pull request number' } }, required: ['owner', 'repo', 'pull_number'], run: (a) => d.getPull(need(a, 'owner'), need(a, 'repo'), needNum(a, 'pull_number')) },
  { name: 'list_pull_requests', description: 'List pull requests of a repository', props: { ...OWNER, state: { type: 'string', enum: ['open', 'closed', 'all'] }, head: S, base: S, ...PAGE }, required: ['owner', 'repo'], run: (a) => unwrapPage(d.listPulls(need(a, 'owner'), need(a, 'repo'), { ...pg(a), state: opt(a, 'state'), head: opt(a, 'head'), base: opt(a, 'base') })) },
  { name: 'get_pull_request_files', description: 'List the files changed in a pull request', props: { ...OWNER, pull_number: N, ...PAGE }, required: ['owner', 'repo', 'pull_number'], run: (a) => unwrapPage(d.listPullFiles(need(a, 'owner'), need(a, 'repo'), needNum(a, 'pull_number'), pg(a))) },
  { name: 'merge_pull_request', description: 'Merge a pull request', props: { ...OWNER, pull_number: { ...N, description: 'Pull request number' }, merge_method: { type: 'string', enum: ['merge', 'squash', 'rebase'] }, commit_title: S, commit_message: S }, required: ['owner', 'repo', 'pull_number'], run: (a) => d.mergePull(need(a, 'owner'), need(a, 'repo'), needNum(a, 'pull_number'), or(a, 'merge_method', 'commit_title', 'commit_message')) },
];

const LISTING = TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: { type: 'object', properties: t.props, required: t.required } }));
const byName = new Map(TOOLS.map((t) => [t.name, t]));

const rpcError = (id: unknown, code: number, message: string): unknown => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const ok = (id: unknown, result: unknown): unknown => ({ jsonrpc: '2.0', id, result });
const toolText = (text: string, isError: boolean): unknown => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });

function callTool(params: Args): { error: [number, string] } | { result: unknown } {
  const tool = typeof params.name === 'string' ? byName.get(params.name) : undefined;
  if (tool === undefined) return { error: [-32602, `Unknown tool: ${String(params.name)}`] };
  const args = typeof params.arguments === 'object' && params.arguments !== null && !Array.isArray(params.arguments) ? (params.arguments as Args) : {};
  try {
    const out = tool.run(args);
    if (d.isFailure(out)) return { result: toolText(`${out.error.message} (HTTP ${out.error.status})`, true) };
    return { result: toolText(JSON.stringify(out), false) };
  } catch (e) {
    return { result: toolText(e instanceof Error ? e.message : String(e), true) };
  }
}

function dispatch(msg: unknown): unknown | null {
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) return rpcError(null, -32600, 'Invalid Request');
  const m = msg as Args;
  const isNote = !('id' in m);
  const id = m.id;
  if (typeof m.method !== 'string') return isNote ? null : rpcError(id, -32600, 'Invalid Request');
  if (isNote) return null;
  const params = typeof m.params === 'object' && m.params !== null && !Array.isArray(m.params) ? (m.params as Args) : {};
  switch (m.method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return ok(id, {
        protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'gitforge', version: '1.0.0' },
        instructions: 'GitHub-compatible forge. Use the tools to manage repositories, issues and pull requests.',
      });
    }
    case 'ping': return ok(id, {});
    case 'tools/list': return ok(id, { tools: LISTING });
    case 'tools/call': {
      const r = callTool(params);
      return 'error' in r ? rpcError(id, r.error[0], r.error[1]) : ok(id, r.result);
    }
    default: return rpcError(id, -32601, `Method not found: ${m.method}`);
  }
}

export async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const sessionHeaders: Record<string, string> = { 'mcp-session-id': 'forge-session' };
  if (req.method === 'DELETE') { res.writeHead(200, { 'content-length': 0 }); res.end(); return true; }
  if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST, DELETE', 'content-length': 0 }); res.end(); return true; }
  if (!authorized(req)) { sendError(res, 401, 'Requires authentication', {}); return true; }
  d.setOrigin(`http://${req.headers.host ?? 'localhost'}`);
  void viewerLogin;
  const raw = (await readBody(req)).toString('utf8');
  let body: unknown;
  try { body = JSON.parse(raw); } catch { sendJson(res, 400, rpcError(null, -32700, 'Parse error'), sessionHeaders); return true; }
  if (Array.isArray(body)) {
    if (body.length === 0) { sendJson(res, 200, rpcError(null, -32600, 'Invalid Request'), sessionHeaders); return true; }
    const out = body.map(dispatch).filter((x) => x !== null);
    if (out.length === 0) { res.writeHead(202, { 'content-length': 0 }); res.end(); return true; }
    sendJson(res, 200, out, sessionHeaders);
    return true;
  }
  const out = dispatch(body);
  if (out === null) { res.writeHead(202, { ...sessionHeaders, 'content-length': 0 }); res.end(); return true; }
  sendJson(res, 200, out, sessionHeaders);
  return true;
}
