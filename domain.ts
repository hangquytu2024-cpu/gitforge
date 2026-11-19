// Business logic for the forge, as plain functions over store.ts and gitops.ts. They take and return plain
// data (GitHub-shaped JSON objects) and report failures as {error:{status,message}}; no HTTP types, so the
// REST, MCP and GraphQL surfaces all call the same code.
import {
  createRepo, deleteRepo, findRepo, getObject, listRepos, nextNumber, state, tick, viewerLogin,
  type Issue, type Pull, type Repo,
} from './store.ts';
import { commitFiles, diffFlat, flatOfCommit, log, lookupPath, mergeBase, mergeBranches, readCommit, refOf, type CommitInfo } from './gitops.ts';

export type Json = Record<string, unknown>;
export interface Failure { error: { status: number; message: string } }
export interface Page<T> { items: T[]; total: number }
export interface PageOpts { page: number; perPage: number }

export const fail = (status: number, message: string): Failure => ({ error: { status, message } });
export const isFailure = (v: unknown): v is Failure => typeof v === 'object' && v !== null && 'error' in v;

let origin = 'http://localhost';
/** The scheme://host[:port] the current request arrived on, used to build url fields. */
export const setOrigin = (o: string): void => { origin = o; };
const api = (): string => `${origin}/api/v3`;

export function paginate<T>(all: T[], opts: PageOpts): Page<T> {
  const start = (opts.page - 1) * opts.perPage;
  return { items: all.slice(start, start + opts.perPage), total: all.length };
}

const nodeId = (kind: string, id: number): string => Buffer.from(`${kind}:${id}`).toString('base64');
const iso = (unix: number): string => new Date(unix * 1000).toISOString().replace('.000Z', 'Z');
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

// ---------------------------------------------------------------------------------------------
// Users, repositories

const userIds = new Map<string, number>();
function userId(login: string): number {
  const k = login.toLowerCase();
  let id = userIds.get(k);
  if (id === undefined) { id = userIds.size + 1000; userIds.set(k, id); }
  return id;
}

export function userJson(login: string): Json {
  const id = userId(login);
  const u = `${api()}/users/${login}`;
  return {
    login, id, node_id: nodeId('User', id), avatar_url: `${origin}/avatars/${id}`, gravatar_id: '', url: u, html_url: `${origin}/${login}`,
    followers_url: `${u}/followers`, following_url: `${u}/following{/other_user}`, gists_url: `${u}/gists{/gist_id}`, starred_url: `${u}/starred{/owner}{/repo}`,
    subscriptions_url: `${u}/subscriptions`, organizations_url: `${u}/orgs`, repos_url: `${u}/repos`, events_url: `${u}/events{/privacy}`,
    received_events_url: `${u}/received_events`, type: 'User', site_admin: false,
  };
}

export function repoJson(r: Repo): Json {
  const url = `${api()}/repos/${r.owner}/${r.name}`;
  const web = `${origin}/${r.owner}/${r.name}`;
  let open = 0;
  for (const i of r.issues) if (i.state === 'open') open++;
  return {
    id: r.id, node_id: nodeId('Repository', r.id), name: r.name, full_name: `${r.owner}/${r.name}`, private: r.private, owner: userJson(r.owner),
    html_url: web, description: r.description, fork: false, url, default_branch: r.defaultBranch,
    created_at: r.createdAt, updated_at: r.updatedAt, pushed_at: r.pushedAt, git_url: `git://${origin.replace(/^https?:\/\//, '')}/${r.owner}/${r.name}.git`,
    clone_url: `${web}.git`, ssh_url: `git@${origin.replace(/^https?:\/\//, '')}:${r.owner}/${r.name}.git`, svn_url: web, homepage: null, size: 0,
    stargazers_count: 0, watchers_count: 0, forks_count: 0, open_issues_count: open, language: null, archived: false, disabled: false,
    visibility: r.private ? 'private' : 'public', has_issues: true, has_wiki: false, has_projects: false, topics: [],
    branches_url: `${url}/branches{/branch}`, commits_url: `${url}/commits{/sha}`, contents_url: `${url}/contents/{+path}`, issues_url: `${url}/issues{/number}`,
    pulls_url: `${url}/pulls{/number}`, labels_url: `${url}/labels{/name}`, git_refs_url: `${url}/git/refs{/sha}`,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function repoOf(owner: string, name: string): Repo | Failure {
  const r = findRepo(owner, name);
  return r === null ? fail(404, 'Not Found') : r;
}

const VALID_NAME = /^[A-Za-z0-9._-]{1,100}$/;

export function createRepository(input: Json): Json | Failure {
  const name = str(input.name);
  if (name === undefined || !VALID_NAME.test(name) || name === '.' || name === '..') return fail(422, 'Repository creation failed: name is missing or invalid');
  const repo = createRepo(name, { private: input.private === true, description: str(input.description) ?? null });
  if (repo === null) return fail(422, 'Repository creation failed: name already exists on this account');
  if (input.auto_init === true) {
    commitFiles(repo, repo.defaultBranch, [{ path: 'README.md', content: Buffer.from(`# ${name}\n`) }], 'Initial commit');
    repo.pushedAt = repo.updatedAt;
  }
  return repoJson(repo);
}

export function getRepository(owner: string, name: string): Json | Failure {
  const r = repoOf(owner, name);
  return isFailure(r) ? r : repoJson(r);
}

export function patchRepository(owner: string, name: string, input: Json): Json | Failure {
  const r = repoOf(owner, name);
  if (isFailure(r)) return r;
  if ('description' in input) {
    if (input.description !== null && typeof input.description !== 'string') return fail(422, 'Validation Failed: description must be a string');
    r.description = input.description as string | null;
  }
  if (typeof input.private === 'boolean') r.private = input.private;
  if (typeof input.default_branch === 'string' && input.default_branch !== '') {
    if (r.refs.size > 0 && !r.refs.has(refOf(input.default_branch))) return fail(422, 'Validation Failed: default_branch does not exist');
    r.defaultBranch = input.default_branch;
  }
  r.updatedAt = tick();
  return repoJson(r);
}

export function deleteRepository(owner: string, name: string): { deleted: true } | Failure {
  const r = repoOf(owner, name);
  if (isFailure(r)) return r;
  deleteRepo(r);
  return { deleted: true };
}

export function listRepositories(opts: PageOpts): Page<Json> {
  const p = paginate(listRepos(), opts);
  return { items: p.items.map(repoJson), total: p.total };
}

// ---------------------------------------------------------------------------------------------
// Branches, commits, refs

function resolveRef(repo: Repo, ref: string): string | null {
  for (const key of [`refs/heads/${ref}`, `refs/tags/${ref}`, ref]) {
    const sha = repo.refs.get(key);
    if (sha !== undefined) return sha;
  }
  if (/^[0-9a-f]{40}$/i.test(ref)) {
    const o = getObject(repo, ref.toLowerCase());
    if (o !== undefined && o.type === 'commit') return ref.toLowerCase();
  }
  return null;
}

export function listBranches(owner: string, name: string, opts: PageOpts): Page<Json> | Failure {
  const r = repoOf(owner, name);
  if (isFailure(r)) return r;
  const all: Json[] = [];
  for (const [ref, sha] of r.refs) {
    if (!ref.startsWith('refs/heads/')) continue;
    all.push({ name: ref.slice(11), commit: { sha, url: `${api()}/repos/${owner}/${name}/commits/${sha}` }, protected: false });
  }
  all.sort((a, b) => ((a.name as string) < (b.name as string) ? -1 : 1));
  return paginate(all, opts);
}

function ident(line: string): { name: string; email: string; date: string } {
  const m = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
  return m === null ? { name: line, email: '', date: iso(0) } : { name: m[1] as string, email: m[2] as string, date: iso(Number(m[3])) };
}

export function commitJson(repo: Repo, c: CommitInfo): Json {
  const url = `${api()}/repos/${repo.owner}/${repo.name}/commits/${c.sha}`;
  const a = ident(c.author);
  const k = ident(c.committer);
  return {
    sha: c.sha, node_id: nodeId('Commit', 0) + c.sha.slice(0, 8),
    commit: {
      author: a, committer: k, message: c.message, tree: { sha: c.tree, url: `${api()}/repos/${repo.owner}/${repo.name}/git/trees/${c.tree}` },
      url: `${api()}/repos/${repo.owner}/${repo.name}/git/commits/${c.sha}`, comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url, html_url: `${origin}/${repo.owner}/${repo.name}/commit/${c.sha}`, comments_url: `${url}/comments`,
    author: userJson(a.name), committer: userJson(k.name),
    parents: c.parents.map((p) => ({ sha: p, url: `${api()}/repos/${repo.owner}/${repo.name}/commits/${p}`, html_url: `${origin}/${repo.owner}/${repo.name}/commit/${p}` })),
  };
}

export function listCommits(owner: string, name: string, opts: PageOpts & { sha?: string }): Page<Json> | Failure {
  const r = repoOf(owner, name);
  if (isFailure(r)) return r;
  let start: string | null | undefined;
  if (opts.sha !== undefined && opts.sha !== '') {
    start = resolveRef(r, opts.sha);
    if (start === null) return fail(404, `No commit found for SHA: ${opts.sha}`);
  } else start = r.refs.get(refOf(r.defaultBranch));
  if (start === undefined) return { items: [], total: 0 };
  const p = paginate(log(r, start), opts);
  return { items: p.items.map((c) => commitJson(r, c)), total: p.total };
}

export function createRef(owner: string, name: string, input: Json): Json | Failure {
  const r = repoOf(owner, name);
  if (isFailure(r)) return r;
  const ref = str(input.ref);
  const sha = str(input.sha);
  if (ref === undefined || !ref.startsWith('refs/') || ref.length < 6) return fail(422, 'Validation Failed: ref must start with refs/');
  if (sha === undefined || readCommit(r, sha.toLowerCase()) === null) return fail(422, 'Validation Failed: Object does not exist');
  if (r.refs.has(ref)) return fail(422, 'Reference already exists');
  r.refs.set(ref, sha.toLowerCase());
  r.updatedAt = tick();
  const url = `${api()}/repos/${owner}/${name}`;
  return { ref, node_id: nodeId('Ref', 0) + ref, url: `${url}/git/${ref}`, object: { sha: sha.toLowerCase(), type: 'commit', url: `${url}/git/commits/${sha.toLowerCase()}` } };
}

// ---------------------------------------------------------------------------------------------
// Contents

function cleanPath(p: string): string | null {
  const parts = p.split('/').filter((s) => s !== '');
  return parts.some((s) => s === '.' || s === '..') ? null : parts.join('/');
}

function fileJson(repo: Repo, path: string, sha: string, ref: string, withContent: boolean): Json {
  const blob = getObject(repo, sha);
  const base = `${api()}/repos/${repo.owner}/${repo.name}`;
  const out: Json = {
    type: 'file', name: path.slice(path.lastIndexOf('/') + 1), path, sha, size: blob === undefined ? 0 : blob.data.length,
    url: `${base}/contents/${path}?ref=${ref}`, html_url: `${origin}/${repo.owner}/${repo.name}/blob/${ref}/${path}`,
    git_url: `${base}/git/blobs/${sha}`, download_url: `${origin}/${repo.owner}/${repo.name}/raw/${ref}/${path}`,
  };
  if (withContent) { out.encoding = 'base64'; out.content = blob === undefined ? '' : blob.data.toString('base64'); }
  return out;
}

export function getContents(owner: string, name: string, path: string, ref?: string): Json | Json[] | Failure {
  const r = repoOf(owner, name);
  if (isFailure(r)) return r;
  const p = cleanPath(path);
  if (p === null) return fail(404, 'Not Found');
  const refName = ref === undefined || ref === '' ? r.defaultBranch : ref;
  const tip = ref === undefined || ref === '' ? r.refs.get(refOf(r.defaultBranch)) : resolveRef(r, ref);
  const commit = tip === undefined || tip === null ? null : readCommit(r, tip);
  if (commit === null) return fail(404, 'Not Found');
  const hit = lookupPath(r, commit.tree, p);
  if (hit === null) return fail(404, 'Not Found');
  if (hit.kind === 'file') return fileJson(r, p, hit.sha, refName, true);
  return hit.entries.map((e) => {
    const sub = p === '' ? e.name : `${p}/${e.name}`;
    if (e.mode === '40000') {
      const base = `${api()}/repos/${owner}/${name}`;
      return { type: 'dir', name: e.name, path: sub, sha: e.sha, size: 0, url: `${base}/contents/${sub}?ref=${refName}`, html_url: `${origin}/${owner}/${name}/tree/${refName}/${sub}`, git_url: `${base}/git/trees/${e.sha}`, download_url: null };
    }
    return fileJson(r, sub, e.sha, refName, false);
  });
}

export function putContents(owner: string, name: string, path: string, input: Json): { created: boolean; body: Json } | Failure {
  const r = repoOf(owner, name);
  if (isFailure(r)) return r;
  const p = cleanPath(path);
  if (p === null || p === '') return fail(422, 'Invalid request: path is invalid');
  const message = str(input.message);
  if (message === undefined || message === '') return fail(422, 'Invalid request.\n\n"message" wasn\'t supplied.');
  const content = str(input.content);
  if (content === undefined) return fail(422, 'Invalid request.\n\n"content" wasn\'t supplied.');
  const branch = str(input.branch) !== undefined && input.branch !== '' ? (input.branch as string) : r.defaultBranch;
  const tip = r.refs.get(refOf(branch));
  if (tip === undefined && r.refs.size > 0) return fail(404, `Branch ${branch} not found`);
  const parent = tip === undefined ? null : readCommit(r, tip);
  const existing = parent === null ? null : lookupPath(r, parent.tree, p);
  if (existing !== null && existing.kind === 'dir') return fail(422, 'Invalid request: path is a directory');
  if (existing !== null) {
    const sha = str(input.sha);
    if (sha === undefined) return fail(422, 'Invalid request.\n\n"sha" wasn\'t supplied.');
    if (sha !== existing.sha) return fail(409, `${p} does not match ${sha}`);
  }
  const res = commitFiles(r, branch, [{ path: p, content: Buffer.from(content, 'base64') }], message);
  r.pushedAt = r.updatedAt;
  const blobSha = res.blobs.get(p) as string;
  return { created: existing === null, body: { content: { ...fileJson(r, p, blobSha, branch, false), encoding: 'base64' }, commit: commitJson(r, readCommit(r, res.commitSha) as CommitInfo) } };
}

export function deleteContents(owner: string, name: string, path: string, input: Json): Json | Failure {
  const r = repoOf(owner, name);
  if (isFailure(r)) return r;
  const p = cleanPath(path);
  if (p === null || p === '') return fail(404, 'Not Found');
  const message = str(input.message);
  if (message === undefined || message === '') return fail(422, 'Invalid request.\n\n"message" wasn\'t supplied.');
  const branch = str(input.branch) !== undefined && input.branch !== '' ? (input.branch as string) : r.defaultBranch;
  const tip = r.refs.get(refOf(branch));
  const parent = tip === undefined ? null : readCommit(r, tip);
  const existing = parent === null ? null : lookupPath(r, parent.tree, p);
  if (existing === null || existing.kind !== 'file') return fail(404, 'Not Found');
  const sha = str(input.sha);
  if (sha === undefined) return fail(422, 'Invalid request.\n\n"sha" wasn\'t supplied.');
  if (sha !== existing.sha) return fail(409, `${p} does not match ${sha}`);
  const res = commitFiles(r, branch, [{ path: p, content: null }], message);
  r.pushedAt = r.updatedAt;
  return { content: null, commit: commitJson(r, readCommit(r, res.commitSha) as CommitInfo) };
}

// ---------------------------------------------------------------------------------------------
// Labels

const labelIds = new Map<string, number>();
function labelJson(repo: Repo, l: { name: string; color: string; description: string | null }): Json {
  const key = `${repo.id}:${l.name}`;
  let id = labelIds.get(key);
  if (id === undefined) { id = labelIds.size + 1; labelIds.set(key, id); }
  return { id, node_id: nodeId('Label', id), url: `${api()}/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(l.name)}`, name: l.name, description: l.description, color: l.color, default: false };
}

function findLabel(repo: Repo, name: string): string | null {
  if (repo.labels.has(name)) return name;
  const lc = name.toLowerCase();
  for (const k of repo.labels.keys()) if (k.toLowerCase() === lc) return k;
  return null;
}

export function createLabel(owner: string, name: string, input: Json): Json | Failure {
  const r = repoOf(owner, name);
  if (isFailure(r)) return r;
  const n = str(input.name);
  if (n === undefined || n.trim() === '') return fail(422, 'Validation Failed: name is required');
  if (findLabel(r, n) !== null) return fail(422, 'Validation Failed: label already_exists');
  const label = { name: n, color: (str(input.color) ?? 'ededed').replace(/^#/, ''), description: str(input.description) ?? null };
  r.labels.set(n, label);
  return labelJson(r, label);
}

export function listLabels(owner: string, name: string, opts: PageOpts): Page<Json> | Failure {
  const r = repoOf(owner, name);
  if (isFailure(r)) return r;
  const p = paginate([...r.labels.values()], opts);
  return { items: p.items.map((l) => labelJson(r, l)), total: p.total };
}

// ---------------------------------------------------------------------------------------------
// Issues

interface Index<T> { map: Map<number, T>; n: number }
const issueIdx = new WeakMap<Repo, Index<Issue>>();
const pullIdx = new WeakMap<Repo, Index<Pull>>();

function lookup<T extends { number: number }>(idx: WeakMap<Repo, Index<T>>, repo: Repo, list: T[], number: number): T | undefined {
  let ix = idx.get(repo);
  if (ix === undefined || ix.n !== list.length) {
    ix = { map: new Map(list.map((x) => [x.number, x])), n: list.length };
    idx.set(repo, ix);
  }
  return ix.map.get(number);
}

function track<T extends { number: number }>(idx: WeakMap<Repo, Index<T>>, repo: Repo, list: T[], item: T): void {
  list.push(item);
  const ix = idx.get(repo);
  if (ix !== undefined && ix.n === list.length - 1) { ix.map.set(item.number, item); ix.n++; }
}

export function issueJson(repo: Repo, i: Issue): Json {
  const url = `${api()}/repos/${repo.owner}/${repo.name}/issues/${i.number}`;
  return {
    id: i.id, node_id: nodeId('Issue', i.id), url, repository_url: `${api()}/repos/${repo.owner}/${repo.name}`, labels_url: `${url}/labels{/name}`,
    comments_url: `${url}/comments`, events_url: `${url}/events`, html_url: `${origin}/${repo.owner}/${repo.name}/issues/${i.number}`,
    number: i.number, state: i.state, state_reason: i.state === 'closed' ? 'completed' : null, title: i.title, body: i.body, user: userJson(i.user),
    labels: i.labels.map((n) => labelJson(repo, repo.labels.get(n) ?? { name: n, color: 'ededed', description: null })),
    assignee: null, assignees: [], milestone: null, locked: false, comments: i.comments.length,
    created_at: i.createdAt, updated_at: i.updatedAt, closed_at: i.closedAt, author_association: 'OWNER', active_lock_reason: null,
  };
}

function commentJson(repo: Repo, issueNumber: number, c: { id: number; body: string; user: string; createdAt: string; updatedAt: string }, kind: string): Json {
  return {
    id: c.id, node_id: nodeId('IssueComment', c.id), url: `${api()}/repos/${repo.owner}/${repo.name}/issues/comments/${c.id}`,
    html_url: `${origin}/${repo.owner}/${repo.name}/${kind}/${issueNumber}#issuecomment-${c.id}`, body: c.body, user: userJson(c.user),
    created_at: c.createdAt, updated_at: c.updatedAt, issue_url: `${api()}/repos/${repo.owner}/${repo.name}/issues/${issueNumber}`, author_association: 'OWNER',
  };
}

/** Resolve a labels input (names or {name}) to existing label names; null when the input is malformed or a label is unknown. */
function resolveLabels(repo: Repo, input: unknown): string[] | Failure {
  if (!Array.isArray(input)) return fail(422, 'Validation Failed: labels must be an array');
  const out: string[] = [];
  for (const item of input) {
    const n = typeof item === 'string' ? item : typeof item === 'object' && item !== null ? str((item as Json).name) : undefined;
    if (n === undefined) return fail(422, 'Validation Failed: label is invalid');
    const found = findLabel(repo, n);
    if (found === null) return fail(422, `Validation Failed: label "${n}" does not exist`);
    if (!out.includes(found)) out.push(found);
  }
  return out;
}

export function createIssue(owner: string, name: string, input: Json): Json | Failure {
  const r = repoOf(owner, name);
  if (isFailure(r)) return r;
  const title = str(input.title);
  if (title === undefined || title.trim() === '') return fail(422, 'Validation Failed: title is required');
  if (input.body !== undefined && input.body !== null && typeof input.body !== 'string') return fail(422, 'Validation Failed: body must be a string');
  let labels: string[] = [];
  if (input.labels !== undefined && input.labels !== null) {
    const l = resolveLabels(r, input.labels);
    if (isFailure(l)) return l;
    labels = l;
  }
  const now = tick();
  const issue: Issue = {
    number: nextNumber(r), id: state.seq.issue++, title, body: (input.body as string | null | undefined) ?? null, state: 'open', labels,
    user: viewerLogin(), createdAt: now, updatedAt: now, closedAt: null, comments: [],
  };
  track(issueIdx, r, r.issues, issue);
  return issueJson(r, issue);
}

export function getIssue(owner: string, name: string, number: number): Json | Failure {
  const r = repoOf(owner, name);
  if (isFailure(r)) return r;
  const i = lookup(issueIdx, r, r.issues, number);
  return i === undefined ? fail(404, 'Not Found') : issueJson(r, i);
}

export function listIssues(owner: string, name: string, opts: PageOpts & { state?: string; sort?: string; direction?: string; labels?: string }): Page<Json> | Failure {
  const r = repoOf(owner, name);
  if (isFailure(r)) return r;
  const want = opts.state === 'closed' || opts.state === 'all' ? opts.state : 'open';
  const labels = opts.labels === undefined || opts.labels === '' ? [] : opts.labels.split(',');
  let all = r.issues.filter((i) => (want === 'all' || i.state === want) && labels.every((l) => i.labels.includes(l)));
  const sort = opts.sort === 'updated' || opts.sort === 'comments' ? opts.sort : 'created';
  if (sort !== 'created') {
    all = all.slice().sort((a, b) => (sort === 'updated' ? (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0) : a.comments.length - b.comments.length) || a.number - b.number);
  }
  if (opts.direction !== 'asc') all = all.slice().reverse();
  const p = paginate(all, opts);
  return { items: p.items.map((i) => issueJson(r, i)), total: p.total };
}

export function updateIssue(owner: string, name: string, number: number, input: Json): Json | Failure {
  const r = repoOf(owner, name);
  if (isFailure(r)) return r;
  const i = lookup(issueIdx, r, r.issues, number);
  if (i === undefined) return fail(404, 'Not Found');
  if ('title' in input) {
    const t = str(input.title);
    if (t === undefined || t.trim() === '') return fail(422, 'Validation Failed: title is invalid');
    i.title = t;
  }
  if ('body' in input) {
    if (input.body !== null && typeof input.body !== 'string') return fail(422, 'Validation Failed: body must be a string');
    i.body = input.body as string | null;
  }
  if ('labels' in input) {
    const l = resolveLabels(r, input.labels);
    if (isFailure(l)) return l;
    i.labels = l;
  }
  const now = tick();
  if ('state' in input) {
    if (input.state !== 'open' && input.state !== 'closed') return fail(422, 'Validation Failed: state must be open or closed');
    if (input.state !== i.state) { i.state = input.state; i.closedAt = input.state === 'closed' ? now : null; }
  }
  i.updatedAt = now;
  return issueJson(r, i);
}

export function createComment(owner: string, name: string, number: number, input: Json): Json | Failure {
  const r = repoOf(owner, name);
  if (isFailure(r)) return r;
  const target = lookup(issueIdx, r, r.issues, number) ?? lookup(pullIdx, r, r.pulls, number);
  if (target === undefined) return fail(404, 'Not Found');
  const body = str(input.body);
  if (body === undefined || body.trim() === '') return fail(422, 'Validation Failed: body is required');
  const now = tick();
  const c = { id: state.seq.comment++, body, user: viewerLogin(), createdAt: now, updatedAt: now };
  target.comments.push(c);
  target.updatedAt = now;
  return commentJson(r, number, c, 'issues');
}

export function listComments(owner: string, name: string, number: number, opts: PageOpts): Page<Json> | Failure {
  const r = repoOf(owner, name);
  if (isFailure(r)) return r;
  const target = lookup(issueIdx, r, r.issues, number) ?? lookup(pullIdx, r, r.pulls, number);
  if (target === undefined) return fail(404, 'Not Found');
  const p = paginate(target.comments, opts);
  return { items: p.items.map((c) => commentJson(r, number, c, 'issues')), total: p.total };
}

// ---------------------------------------------------------------------------------------------
// Pull requests

function tips(repo: Repo, p: Pull): { head: string; base: string } {
  if (p.state !== 'open') return { head: p.head.sha, base: p.base.sha };
  return { head: repo.refs.get(refOf(p.head.ref)) ?? p.head.sha, base: repo.refs.get(refOf(p.base.ref)) ?? p.base.sha };
}

export function pullJson(repo: Repo, p: Pull): Json {
  const t = tips(repo, p);
  const url = `${api()}/repos/${repo.owner}/${repo.name}/pulls/${p.number}`;
  const web = `${origin}/${repo.owner}/${repo.name}/pull/${p.number}`;
  const side = (ref: string, sha: string): Json => ({ label: `${repo.owner}:${ref}`, ref, sha, user: userJson(repo.owner), repo: repoJson(repo) });
  return {
    url, id: p.id, node_id: nodeId('PullRequest', p.id), html_url: web, diff_url: `${web}.diff`, patch_url: `${web}.patch`,
    issue_url: `${api()}/repos/${repo.owner}/${repo.name}/issues/${p.number}`, commits_url: `${url}/commits`, comments_url: `${api()}/repos/${repo.owner}/${repo.name}/issues/${p.number}/comments`,
    number: p.number, state: p.state, locked: false, title: p.title, user: userJson(p.user), body: p.body, labels: [], milestone: null, active_lock_reason: null,
    created_at: p.createdAt, updated_at: p.updatedAt, closed_at: p.closedAt, merged_at: p.mergedAt, merge_commit_sha: p.mergeCommitSha,
    assignee: null, assignees: [], requested_reviewers: [], requested_teams: [], draft: p.draft,
    head: side(p.head.ref, t.head), base: side(p.base.ref, t.base),
    _links: { self: { href: url }, html: { href: web }, issue: { href: `${api()}/repos/${repo.owner}/${repo.name}/issues/${p.number}` } },
    author_association: 'OWNER', auto_merge: null, merged: p.merged, mergeable: p.state === 'open' ? true : null, mergeable_state: p.state === 'open' ? 'clean' : 'unknown',
    merged_by: p.merged ? userJson(viewerLogin()) : null, comments: p.comments.length, review_comments: 0, maintainer_can_modify: false,
  };
}

const branchArg = (v: unknown): string | undefined => {
  const s = str(v);
  if (s === undefined || s === '') return undefined;
  return s.includes(':') ? s.slice(s.indexOf(':') + 1) : s;
};

export function createPull(owner: string, name: string, input: Json): Json | Failure {
  const r = repoOf(owner, name);
  if (isFailure(r)) return r;
  const title = str(input.title);
  if (title === undefined || title.trim() === '') return fail(422, 'Validation Failed: title is required');
  const head = branchArg(input.head);
  const base = branchArg(input.base);
  if (head === undefined || base === undefined) return fail(422, 'Validation Failed: head and base are required');
  const headSha = r.refs.get(refOf(head));
  const baseSha = r.refs.get(refOf(base));
  if (headSha === undefined) return fail(422, `Validation Failed: head branch "${head}" does not exist`);
  if (baseSha === undefined) return fail(422, `Validation Failed: base branch "${base}" does not exist`);
  if (input.body !== undefined && input.body !== null && typeof input.body !== 'string') return fail(422, 'Validation Failed: body must be a string');
  const now = tick();
  const pull: Pull = {
    number: nextNumber(r), id: state.seq.pull++, title, body: (input.body as string | null | undefined) ?? null, state: 'open', draft: input.draft === true,
    head: { ref: head, sha: headSha }, base: { ref: base, sha: baseSha }, user: viewerLogin(), createdAt: now, updatedAt: now,
    closedAt: null, mergedAt: null, mergeCommitSha: null, merged: false, comments: [],
  };
  track(pullIdx, r, r.pulls, pull);
  return pullJson(r, pull);
}

export function getPull(owner: string, name: string, number: number): Json | Failure {
  const r = repoOf(owner, name);
  if (isFailure(r)) return r;
  const p = lookup(pullIdx, r, r.pulls, number);
  return p === undefined ? fail(404, 'Not Found') : pullJson(r, p);
}

export function listPulls(owner: string, name: string, opts: PageOpts & { state?: string; head?: string; base?: string; direction?: string }): Page<Json> | Failure {
  const r = repoOf(owner, name);
  if (isFailure(r)) return r;
  const want = opts.state === 'closed' || opts.state === 'all' ? opts.state : 'open';
  const head = branchArg(opts.head);
  let all = r.pulls.filter((p) => (want === 'all' || p.state === want) && (head === undefined || p.head.ref === head) && (opts.base === undefined || opts.base === '' || p.base.ref === opts.base));
  if (opts.direction !== 'asc') all = all.slice().reverse();
  const p = paginate(all, opts);
  return { items: p.items.map((x) => pullJson(r, x)), total: p.total };
}

export function updatePull(owner: string, name: string, number: number, input: Json): Json | Failure {
  const r = repoOf(owner, name);
  if (isFailure(r)) return r;
  const p = lookup(pullIdx, r, r.pulls, number);
  if (p === undefined) return fail(404, 'Not Found');
  if ('title' in input) {
    const t = str(input.title);
    if (t === undefined || t.trim() === '') return fail(422, 'Validation Failed: title is invalid');
    p.title = t;
  }
  if ('body' in input) {
    if (input.body !== null && typeof input.body !== 'string') return fail(422, 'Validation Failed: body must be a string');
    p.body = input.body as string | null;
  }
  const base = branchArg(input.base);
  if (base !== undefined) {
    const sha = r.refs.get(refOf(base));
    if (sha === undefined) return fail(422, `Validation Failed: base branch "${base}" does not exist`);
    p.base = { ref: base, sha };
  }
  const now = tick();
  if ('state' in input) {
    if (input.state !== 'open' && input.state !== 'closed') return fail(422, 'Validation Failed: state must be open or closed');
    if (p.merged && input.state === 'open') return fail(422, 'Validation Failed: a merged pull request cannot be reopened');
    if (input.state !== p.state) { p.state = input.state; p.closedAt = input.state === 'closed' ? now : null; }
  }
  p.updatedAt = now;
  return pullJson(r, p);
}

function lineDiff(repo: Repo, oldSha: string | null, newSha: string | null): { additions: number; deletions: number } {
  const lines = (sha: string | null): string[] => {
    if (sha === null) return [];
    const o = getObject(repo, sha);
    if (o === undefined || o.data.length === 0) return [];
    const a = o.data.toString('utf8').split('\n');
    if (a[a.length - 1] === '') a.pop();
    return a;
  };
  const oldL = lines(oldSha);
  const newL = lines(newSha);
  const bag = new Map<string, number>();
  for (const l of oldL) bag.set(l, (bag.get(l) ?? 0) + 1);
  let common = 0;
  for (const l of newL) {
    const c = bag.get(l) ?? 0;
    if (c > 0) { bag.set(l, c - 1); common++; }
  }
  return { additions: newL.length - common, deletions: oldL.length - common };
}

export function listPullFiles(owner: string, name: string, number: number, opts: PageOpts): Page<Json> | Failure {
  const r = repoOf(owner, name);
  if (isFailure(r)) return r;
  const p = lookup(pullIdx, r, r.pulls, number);
  if (p === undefined) return fail(404, 'Not Found');
  const t = tips(r, p);
  const changes = diffFlat(flatOfCommit(r, mergeBase(r, t.base, t.head)), flatOfCommit(r, t.head));
  const all = changes.map((c): Json => {
    const d = lineDiff(r, c.oldSha, c.newSha);
    const sha = (c.newSha ?? c.oldSha) as string;
    const base = `${api()}/repos/${owner}/${name}`;
    return {
      sha, filename: c.path, status: c.status, additions: d.additions, deletions: d.deletions, changes: d.additions + d.deletions,
      blob_url: `${origin}/${owner}/${name}/blob/${t.head}/${c.path}`, raw_url: `${origin}/${owner}/${name}/raw/${t.head}/${c.path}`, contents_url: `${base}/contents/${c.path}?ref=${t.head}`,
    };
  });
  return paginate(all, opts);
}

export function mergePull(owner: string, name: string, number: number, input: Json): Json | Failure {
  const r = repoOf(owner, name);
  if (isFailure(r)) return r;
  const p = lookup(pullIdx, r, r.pulls, number);
  if (p === undefined) return fail(404, 'Not Found');
  if (p.merged || p.state !== 'open') return fail(405, 'Pull Request is not mergeable');
  const headTip = r.refs.get(refOf(p.head.ref)) ?? p.head.sha;
  const baseTip = r.refs.get(refOf(p.base.ref));
  if (baseTip === undefined) return fail(405, 'Pull Request is not mergeable');
  const expected = str(input.sha);
  if (expected !== undefined && expected !== headTip) return fail(409, 'Head branch was modified. Review and try the merge again.');
  const method = str(input.merge_method) ?? 'merge';
  if (method !== 'merge' && method !== 'squash' && method !== 'rebase') return fail(422, 'Validation Failed: merge_method is invalid');
  const squash = method !== 'merge';
  let message = str(input.commit_title) ?? (squash ? `${p.title} (#${p.number})` : `Merge pull request #${p.number} from ${owner}/${p.head.ref}`);
  const extra = str(input.commit_message);
  if (extra !== undefined && extra !== '') message += `\n\n${extra}`;
  const res = mergeBranches(r, p.base.ref, headTip, message, squash);
  if ('conflict' in res) return fail(405, 'Pull Request is not mergeable');
  const now = tick();
  p.head.sha = headTip;
  p.base.sha = baseTip;
  p.state = 'closed';
  p.merged = true;
  p.mergedAt = now;
  p.closedAt = now;
  p.updatedAt = now;
  p.mergeCommitSha = res.sha;
  r.pushedAt = r.updatedAt;
  return { sha: res.sha, merged: true, message: 'Pull Request successfully merged' };
}
