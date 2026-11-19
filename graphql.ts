// The graphql surface (POST /api/graphql): a small executor over domain.ts so GraphQL and REST show one state.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { authorized, readBody, sendJson } from './http.ts';
import { findRepo, listRepos, viewerLogin, type Repo } from './store.ts';
import { refOf } from './gitops.ts';
import * as D from './domain.ts';
import { GqlSyntaxError, parse, type Doc, type FieldSel, type Sel, type Val } from './gql-parser.ts';

type Json = Record<string, any>;
interface Tag { __t: string; v: any }
interface Ctx { src: string; vars: Json; frags: Doc['frags']; errors: Json[]; invalid: boolean }
type Resolver = (src: any, args: Json, ctx: Ctx) => unknown;

class GqlError extends Error {}

const T = (t: string, v: any): Tag => ({ __t: t, v });
const isTag = (x: unknown): x is Tag => typeof x === 'object' && x !== null && '__t' in x;
const BIG = 1_000_000_000;
const ok = <X>(x: X | D.Failure): X => {
  if (D.isFailure(x)) throw new GqlError(x.error.message);
  return x;
};

// ---- global ids (the REST node_id: base64 "Kind:id") ----
function locate(id: unknown): { kind: string; repo: Repo; item?: any } | null {
  if (typeof id !== 'string') return null;
  const m = /^(\w+):(\d+)$/.exec(Buffer.from(id, 'base64').toString('utf8'));
  if (m === null) return null;
  const kind = m[1];
  const num = Number(m[2]);
  for (const r of listRepos()) {
    if (kind === 'Repository' && r.id === num) return { kind, repo: r };
    if (kind === 'Issue') { const i = r.issues.find((x) => x.id === num); if (i !== undefined) return { kind, repo: r, item: i }; }
    if (kind === 'PullRequest') { const p = r.pulls.find((x) => x.id === num); if (p !== undefined) return { kind, repo: r, item: p }; }
  }
  return null;
}
const need = (id: unknown, kind: string): { repo: Repo; item?: any } => {
  const loc = locate(id);
  if (loc === null || loc.kind !== kind) throw new GqlError(`Could not resolve to a ${kind} with the id of '${String(id)}'.`);
  return loc;
};

// ---- tags ----
const userTag = (j: Json): Tag => T('User', j);
const repoTag = (r: Repo): Tag => T('Repository', { raw: r, owner: r.owner, name: r.name, j: D.repoJson(r) });
const issueTag = (owner: string, name: string, j: Json): Tag => T('Issue', { owner, name, j });
const pullTag = (owner: string, name: string, j: Json): Tag => T('PullRequest', { owner, name, j });

// ---- connections ----
const cursorOf = (i: number): string => Buffer.from(`cursor:${i}`).toString('base64');
function cursorIndex(c: string): number {
  const m = /^cursor:(\d+)$/.exec(Buffer.from(c, 'base64').toString('utf8'));
  if (m === null) throw new GqlError(`Invalid cursor '${c}'`);
  return Number(m[1]);
}
function conn(type: string, items: any[], args: Json, wrap: (x: any) => Tag): Tag {
  const total = items.length;
  let start = 0;
  let end = total;
  if (typeof args.after === 'string') start = cursorIndex(args.after) + 1;
  if (typeof args.before === 'string') end = Math.min(end, cursorIndex(args.before));
  for (const k of ['first', 'last']) {
    if (args[k] !== undefined && args[k] !== null && (typeof args[k] !== 'number' || args[k] < 0)) throw new GqlError(`Argument '${k}' must be a non-negative integer`);
  }
  if (typeof args.first === 'number') end = Math.min(end, start + args.first);
  if (typeof args.last === 'number') start = Math.max(start, end - args.last);
  if (start > end) start = end;
  return T(type, { items, start, end, total, wrap });
}
function connTypes(node: string): Record<string, Record<string, Resolver>> {
  const slice = (s: any): Tag[] => s.items.slice(s.start, s.end).map((x: any, i: number) => ({ x, i: s.start + i }));
  return {
    [`${node}Connection`]: {
      totalCount: (s) => s.total,
      nodes: (s) => s.items.slice(s.start, s.end).map(s.wrap),
      edges: (s) => slice(s).map((e: any) => T(`${node}Edge`, { cursor: cursorOf(e.i), node: s.wrap(e.x) })),
      pageInfo: (s) => T('PageInfo', {
        hasNextPage: s.end < s.total, hasPreviousPage: s.start > 0,
        startCursor: s.end > s.start ? cursorOf(s.start) : null, endCursor: s.end > s.start ? cursorOf(s.end - 1) : null,
      }),
    },
    [`${node}Edge`]: { cursor: (s) => s.cursor, node: (s) => s.node },
  };
}

const prState = (j: Json): string => (j.merged === true ? 'MERGED' : String(j.state).toUpperCase());
const direction = (a: Json): 'asc' | 'desc' => (a.orderBy?.direction === 'DESC' ? 'desc' : 'asc');
const all = { page: 1, perPage: BIG };

function pullList(src: any, a: Json): Tag {
  const states: string[] | null = Array.isArray(a.states) && a.states.length > 0 ? a.states : null;
  const res = ok(D.listPulls(src.owner, src.name, { ...all, state: 'all', direction: direction(a), head: a.headRefName, base: a.baseRefName }));
  const items = res.items.filter((j) => states === null || states.includes(prState(j)));
  return conn('PullRequestConnection', items, a, (j) => pullTag(src.owner, src.name, j));
}
function issueList(src: any, a: Json): Tag {
  const st: string[] = Array.isArray(a.states) ? a.states : [];
  const state = st.length === 1 ? st[0].toLowerCase() : 'all';
  const sort = a.orderBy?.field === 'UPDATED_AT' ? 'updated' : a.orderBy?.field === 'COMMENTS' ? 'comments' : 'created';
  const labels = Array.isArray(a.labels) ? a.labels.join(',') : undefined;
  const res = ok(D.listIssues(src.owner, src.name, { ...all, state, sort, direction: direction(a), labels }));
  return conn('IssueConnection', res.items, a, (j) => issueTag(src.owner, src.name, j));
}
const commentsOf = (src: any, a: Json): Tag => {
  const res = ok(D.listComments(src.owner, src.name, src.j.number, all));
  return conn('IssueCommentConnection', res.items, a, (j) => T('IssueComment', j));
};
const labelsOf = (src: any, a: Json): Tag => conn('LabelConnection', src.j.labels ?? [], a, (j) => T('Label', j));
const body = (j: Json): string => (typeof j.body === 'string' ? j.body : '');

const payload = (...keys: string[]): Record<string, Resolver> => {
  const o: Record<string, Resolver> = { clientMutationId: () => null };
  for (const k of keys) o[k] = (s) => s[k];
  return o;
};

const ENUMS: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'], PullRequestState: ['OPEN', 'CLOSED', 'MERGED'], MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'], RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'], IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'], PatchStatus: ['ADDED', 'DELETED', 'RENAMED', 'COPIED', 'MODIFIED', 'CHANGED'],
};

const TYPES: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => userTag(D.userJson(viewerLogin())),
    user: (_s, a) => (typeof a.login === 'string' && a.login === viewerLogin() ? userTag(D.userJson(a.login)) : null),
    repository: (_s, a) => {
      const r = typeof a.owner === 'string' && typeof a.name === 'string' ? findRepo(a.owner, a.name) : null;
      return r === null ? null : repoTag(r);
    },
    node: (_s, a) => {
      const loc = locate(a.id);
      if (loc === null) return null;
      if (loc.kind === 'Repository') return repoTag(loc.repo);
      const j = loc.kind === 'Issue' ? D.getIssue(loc.repo.owner, loc.repo.name, loc.item.number) : D.getPull(loc.repo.owner, loc.repo.name, loc.item.number);
      if (D.isFailure(j)) return null;
      return loc.kind === 'Issue' ? issueTag(loc.repo.owner, loc.repo.name, j) : pullTag(loc.repo.owner, loc.repo.name, j);
    },
    rateLimit: () => T('RateLimit', {}),
    __type: (_s, a) => (typeof a.name === 'string' && (a.name in TYPES || a.name in ENUMS) ? T('__Type', a.name) : null),
  },
  RateLimit: { limit: () => 5000, remaining: () => 5000, used: () => 0, cost: () => 1, nodeCount: () => 0, resetAt: () => '2099-01-01T00:00:00Z' },
  __Type: {
    name: (s) => s,
    kind: (s) => (s in ENUMS ? 'ENUM' : 'OBJECT'),
    description: () => null,
    fields: (s) => (s in TYPES ? Object.keys(TYPES[s]).map((n) => T('__Field', n)) : null),
    enumValues: (s) => (s in ENUMS ? ENUMS[s].map((n) => T('__EnumValue', n)) : null),
  },
  __Field: { name: (s) => s, description: () => null, isDeprecated: () => false, deprecationReason: () => null },
  __EnumValue: { name: (s) => s, description: () => null, isDeprecated: () => false, deprecationReason: () => null },
  User: {
    login: (s) => s.login, id: (s) => s.node_id, databaseId: (s) => s.id, url: (s) => s.html_url, avatarUrl: (s) => s.avatar_url,
    name: () => null, __typename: () => 'User',
  },
  Ref: { name: (s) => s.name, prefix: () => 'refs/heads/', target: (s) => T('Commit', { oid: s.sha }) },
  Commit: { oid: (s) => s.oid },
  PageInfo: { hasNextPage: (s) => s.hasNextPage, hasPreviousPage: (s) => s.hasPreviousPage, startCursor: (s) => s.startCursor, endCursor: (s) => s.endCursor },
  Label: { id: (s) => s.node_id, name: (s) => s.name, color: (s) => s.color, description: (s) => s.description ?? null },
  Repository: {
    id: (s) => s.j.node_id, databaseId: (s) => s.j.id, name: (s) => s.name, nameWithOwner: (s) => `${s.owner}/${s.name}`,
    owner: (s) => userTag(s.j.owner), description: (s) => s.j.description, url: (s) => s.j.html_url, isPrivate: (s) => s.j.private,
    visibility: (s) => (s.j.private ? 'PRIVATE' : 'PUBLIC'), isArchived: () => false, isFork: () => false, isEmpty: (s) => s.raw.refs.size === 0,
    createdAt: (s) => s.j.created_at, updatedAt: (s) => s.j.updated_at, pushedAt: (s) => s.j.pushed_at,
    sshUrl: (s) => s.j.ssh_url, homepageUrl: () => null, stargazerCount: () => 0, forkCount: () => 0,
    defaultBranchRef: (s) => (s.raw.refs.has(refOf(s.raw.defaultBranch)) ? T('Ref', { name: s.raw.defaultBranch, sha: s.raw.refs.get(refOf(s.raw.defaultBranch)) }) : null),
    viewerPermission: () => 'ADMIN', viewerCanAdminister: () => true, hasIssuesEnabled: () => true, hasWikiEnabled: () => false,
    hasProjectsEnabled: () => false,
    issue: (s, a) => {
      const j = D.getIssue(s.owner, s.name, a.number);
      return D.isFailure(j) ? null : issueTag(s.owner, s.name, j);
    },
    issues: issueList,
    pullRequest: (s, a) => {
      const j = D.getPull(s.owner, s.name, a.number);
      return D.isFailure(j) ? null : pullTag(s.owner, s.name, j);
    },
    pullRequests: pullList,
  },
  Issue: {
    id: (s) => s.j.node_id, databaseId: (s) => s.j.id, number: (s) => s.j.number, title: (s) => s.j.title, body: (s) => body(s.j),
    state: (s) => String(s.j.state).toUpperCase(), stateReason: (s) => (s.j.state === 'closed' ? 'COMPLETED' : null), closed: (s) => s.j.state === 'closed',
    url: (s) => s.j.html_url, createdAt: (s) => s.j.created_at, updatedAt: (s) => s.j.updated_at, closedAt: (s) => s.j.closed_at,
    author: (s) => userTag(s.j.user), comments: commentsOf, labels: labelsOf,
    repository: (s) => { const r = findRepo(s.owner, s.name); return r === null ? null : repoTag(r); },
  },
  PullRequest: {
    id: (s) => s.j.node_id, databaseId: (s) => s.j.id, number: (s) => s.j.number, title: (s) => s.j.title, body: (s) => body(s.j),
    state: (s) => prState(s.j), merged: (s) => s.j.merged === true, closed: (s) => s.j.state === 'closed', isDraft: (s) => s.j.draft === true,
    headRefName: (s) => s.j.head.ref, baseRefName: (s) => s.j.base.ref, headRefOid: (s) => s.j.head.sha, baseRefOid: (s) => s.j.base.sha,
    mergeable: (s) => (s.j.mergeable === true ? 'MERGEABLE' : s.j.mergeable === false ? 'CONFLICTING' : 'UNKNOWN'),
    url: (s) => s.j.html_url, createdAt: (s) => s.j.created_at, updatedAt: (s) => s.j.updated_at, closedAt: (s) => s.j.closed_at, mergedAt: (s) => s.j.merged_at,
    author: (s) => userTag(s.j.user), comments: commentsOf, labels: labelsOf,
    files: (s, a) => {
      const res = ok(D.listPullFiles(s.owner, s.name, s.j.number, all));
      return conn('PullRequestChangedFileConnection', res.items, a, (j) => T('PullRequestChangedFile', j));
    },
    repository: (s) => { const r = findRepo(s.owner, s.name); return r === null ? null : repoTag(r); },
  },
  PullRequestChangedFile: {
    path: (s) => s.filename, additions: (s) => s.additions, deletions: (s) => s.deletions, changeType: (s) => String(s.status).toUpperCase(),
  },
  IssueComment: {
    id: (s) => s.node_id, databaseId: (s) => s.id, body: (s) => s.body, url: (s) => s.html_url, createdAt: (s) => s.created_at,
    updatedAt: (s) => s.updated_at, author: (s) => userTag(s.user),
  },
  ...connTypes('Issue'), ...connTypes('PullRequest'), ...connTypes('IssueComment'), ...connTypes('Label'), ...connTypes('PullRequestChangedFile'),
  Mutation: {
    createIssue: (_s, a) => {
      const { repo } = need(a.input?.repositoryId, 'Repository');
      const j = ok(D.createIssue(repo.owner, repo.name, { title: a.input.title, body: a.input.body ?? undefined }));
      return T('CreateIssuePayload', { issue: issueTag(repo.owner, repo.name, j) });
    },
    updateIssue: (_s, a) => {
      const { repo, item } = need(a.input?.id, 'Issue');
      const inp: Json = {};
      if (a.input.title != null) inp.title = a.input.title;
      if (a.input.body != null) inp.body = a.input.body;
      if (typeof a.input.state === 'string') inp.state = a.input.state.toLowerCase();
      return T('UpdateIssuePayload', { issue: issueTag(repo.owner, repo.name, ok(D.updateIssue(repo.owner, repo.name, item.number, inp))) });
    },
    closeIssue: (_s, a) => {
      const { repo, item } = need(a.input?.issueId, 'Issue');
      return T('CloseIssuePayload', { issue: issueTag(repo.owner, repo.name, ok(D.updateIssue(repo.owner, repo.name, item.number, { state: 'closed' }))) });
    },
    reopenIssue: (_s, a) => {
      const { repo, item } = need(a.input?.issueId, 'Issue');
      return T('ReopenIssuePayload', { issue: issueTag(repo.owner, repo.name, ok(D.updateIssue(repo.owner, repo.name, item.number, { state: 'open' }))) });
    },
    addComment: (_s, a) => {
      const loc = locate(a.input?.subjectId);
      if (loc === null || loc.item === undefined) throw new GqlError(`Could not resolve to a node with the id of '${String(a.input?.subjectId)}'.`);
      const { repo, item } = loc;
      const c = ok(D.createComment(repo.owner, repo.name, item.number, { body: a.input.body }));
      const subject = loc.kind === 'Issue' ? issueTag(repo.owner, repo.name, ok(D.getIssue(repo.owner, repo.name, item.number))) : pullTag(repo.owner, repo.name, ok(D.getPull(repo.owner, repo.name, item.number)));
      return T('AddCommentPayload', { commentEdge: T('IssueCommentEdge', { cursor: cursorOf(0), node: T('IssueComment', c) }), subject });
    },
    createPullRequest: (_s, a) => {
      const { repo } = need(a.input?.repositoryId, 'Repository');
      const j = ok(D.createPull(repo.owner, repo.name, {
        title: a.input.title, head: a.input.headRefName, base: a.input.baseRefName, body: a.input.body ?? undefined, draft: a.input.draft === true,
      }));
      return T('CreatePullRequestPayload', { pullRequest: pullTag(repo.owner, repo.name, j) });
    },
    mergePullRequest: (_s, a) => {
      const { repo, item } = need(a.input?.pullRequestId, 'PullRequest');
      const inp: Json = { merge_method: typeof a.input.mergeMethod === 'string' ? a.input.mergeMethod.toLowerCase() : 'merge' };
      if (a.input.commitHeadline != null) inp.commit_title = a.input.commitHeadline;
      if (a.input.commitBody != null) inp.commit_message = a.input.commitBody;
      if (a.input.expectedHeadOid != null) inp.sha = a.input.expectedHeadOid;
      ok(D.mergePull(repo.owner, repo.name, item.number, inp));
      return T('MergePullRequestPayload', { pullRequest: pullTag(repo.owner, repo.name, ok(D.getPull(repo.owner, repo.name, item.number))) });
    },
    closePullRequest: (_s, a) => {
      const { repo, item } = need(a.input?.pullRequestId, 'PullRequest');
      return T('ClosePullRequestPayload', { pullRequest: pullTag(repo.owner, repo.name, ok(D.updatePull(repo.owner, repo.name, item.number, { state: 'closed' }))) });
    },
    reopenPullRequest: (_s, a) => {
      const { repo, item } = need(a.input?.pullRequestId, 'PullRequest');
      return T('ReopenPullRequestPayload', { pullRequest: pullTag(repo.owner, repo.name, ok(D.updatePull(repo.owner, repo.name, item.number, { state: 'open' }))) });
    },
    createRepository: (_s, a) => {
      const j = ok(D.createRepository({ name: a.input?.name, description: a.input?.description ?? undefined, private: a.input?.visibility === 'PRIVATE' }));
      const r = findRepo(String((j.owner as Json).login), String(j.name));
      if (r === null) throw new GqlError('Repository creation failed');
      return T('CreateRepositoryPayload', { repository: repoTag(r) });
    },
  },
  CreateIssuePayload: payload('issue'), UpdateIssuePayload: payload('issue'), CloseIssuePayload: payload('issue'), ReopenIssuePayload: payload('issue'),
  AddCommentPayload: payload('commentEdge', 'subject'), CreatePullRequestPayload: payload('pullRequest'), MergePullRequestPayload: payload('pullRequest'),
  ClosePullRequestPayload: payload('pullRequest'), ReopenPullRequestPayload: payload('pullRequest'), CreateRepositoryPayload: payload('repository'),
};

// ---- executor ----
function evalVal(v: Val, vars: Json): unknown {
  if (v.k === 'lit') return v.v;
  if (v.k === 'var') return vars[v.name] ?? null;
  if (v.k === 'list') return v.items.map((x) => evalVal(x, vars));
  const o: Json = {};
  for (const [k, x] of Object.entries(v.fields)) o[k] = evalVal(x, vars);
  return o;
}
const evalArgs = (args: Record<string, Val>, vars: Json): Json => {
  const o: Json = {};
  for (const [k, v] of Object.entries(args)) o[k] = evalVal(v, vars);
  return o;
};
function included(dirs: { name: string; args: Record<string, Val> }[], vars: Json): boolean {
  for (const d of dirs) {
    if (d.name === 'skip' && evalArgs(d.args, vars).if === true) return false;
    if (d.name === 'include' && evalArgs(d.args, vars).if === false) return false;
  }
  return true;
}
function loc(src: string, pos: number): { line: number; column: number } {
  const before = src.slice(0, pos);
  const line = before.split('\n').length;
  return { line, column: pos - before.lastIndexOf('\n') };
}
function collect(typeName: string, sels: Sel[], ctx: Ctx, into: Map<string, FieldSel[]>): void {
  for (const s of sels) {
    if (s.k === 'f') {
      if (!included(s.dirs, ctx.vars)) continue;
      const key = s.alias ?? s.name;
      const list = into.get(key);
      if (list === undefined) into.set(key, [s]);
      else list.push(s);
    } else if (s.k === 's') {
      if (!included(s.dirs, ctx.vars)) continue;
      const f = ctx.frags.get(s.name);
      if (f === undefined) throw new GqlError(`Fragment ${s.name} was used, but not defined`);
      if (condMatches(f.cond, typeName)) collect(typeName, f.sel, ctx, into);
    } else if (included(s.dirs, ctx.vars) && (s.cond === null || condMatches(s.cond, typeName))) {
      collect(typeName, s.sel, ctx, into);
    }
  }
}
const condMatches = (cond: string, typeName: string): boolean => cond === typeName || !(cond in TYPES);

function execSel(typeName: string, src: any, sels: Sel[], ctx: Ctx, path: (string | number)[], serial: boolean): Json {
  const fields = new Map<string, FieldSel[]>();
  collect(typeName, sels, ctx, fields);
  const out: Json = {};
  for (const [key, list] of fields) {
    const f = list[0];
    const here = [...path, key];
    const where = loc(ctx.src, f.pos);
    if (f.name === '__typename') { out[key] = typeName; continue; }
    const resolver = TYPES[typeName]?.[f.name];
    if (resolver === undefined) {
      ctx.invalid = true;
      ctx.errors.push({ message: `Field '${f.name}' doesn't exist on type '${typeName}'`, locations: [where], path: here, extensions: { code: 'undefinedField', typeName, fieldName: f.name } });
      continue;
    }
    try {
      const value = resolver(src, evalArgs(f.args, ctx.vars), ctx);
      const subs = list.flatMap((x) => x.sel ?? []);
      out[key] = complete(value, subs, ctx, here);
    } catch (e) {
      out[key] = null;
      const message = e instanceof GqlError ? e.message : 'Internal error';
      ctx.errors.push({ message, locations: [where], path: here });
    }
  }
  void serial;
  return out;
}
function complete(value: unknown, subs: Sel[], ctx: Ctx, path: (string | number)[]): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((x, i) => complete(x, subs, ctx, [...path, i]));
  if (isTag(value)) return subs.length === 0 ? null : execSel(value.__t, value.v, subs, ctx, path, false);
  return value;
}

function runOperation(query: unknown, variables: unknown, opName: unknown): Json {
  if (typeof query !== 'string' || query.trim() === '') return { errors: [{ message: 'A query attribute must be specified and must be a string.' }] };
  let doc: Doc;
  try {
    doc = parse(query);
  } catch (e) {
    if (e instanceof GqlSyntaxError) return { errors: [{ message: e.message, locations: [loc(query, e.pos)] }] };
    return { errors: [{ message: 'Parse error' }] };
  }
  let op = doc.ops[0];
  if (typeof opName === 'string' && opName !== '') {
    op = doc.ops.find((o) => o.name === opName) as typeof op;
    if (op === undefined) return { errors: [{ message: `Unknown operation named "${opName}".` }] };
  } else if (doc.ops.length > 1) {
    return { errors: [{ message: 'An operation name is required when the document has more than one operation.' }] };
  }
  if (op === undefined) return { errors: [{ message: 'No operation found in the document.' }] };
  const given: Json = variables !== null && typeof variables === 'object' && !Array.isArray(variables) ? (variables as Json) : {};
  const vars: Json = {};
  const noCtx: Json = {};
  for (const d of op.vars) vars[d.name] = d.name in given ? given[d.name] : d.def === null ? null : evalVal(d.def, noCtx);
  const ctx: Ctx = { src: query, vars, frags: doc.frags, errors: [], invalid: false };
  const root = op.type === 'mutation' ? 'Mutation' : op.type === 'query' ? 'Query' : null;
  if (root === null) return { errors: [{ message: 'Subscriptions are not supported.' }] };
  const data = execSel(root, {}, op.sel, ctx, [], root === 'Mutation');
  if (ctx.invalid) return { errors: ctx.errors };
  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}

export async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method !== 'POST') return false;
  if (!authorized(req)) {
    sendJson(res, 401, { message: 'Bad credentials', documentation_url: 'https://docs.github.com/graphql' });
    return true;
  }
  D.setOrigin(`http://${req.headers.host ?? 'localhost'}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse((await readBody(req)).toString('utf8'));
  } catch {
    sendJson(res, 400, { message: 'Problems parsing JSON', documentation_url: 'https://docs.github.com/graphql' });
    return true;
  }
  const one = (b: unknown): Json => {
    const o: Json = b !== null && typeof b === 'object' && !Array.isArray(b) ? (b as Json) : {};
    return runOperation(o.query, o.variables, o.operationName);
  };
  sendJson(res, 200, Array.isArray(parsed) ? parsed.map(one) : one(parsed));
  return true;
}
