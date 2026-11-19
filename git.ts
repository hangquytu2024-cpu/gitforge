// The git smart HTTP surface: info/refs advertisement, upload-pack (protocol v2: ls-refs, fetch) and
// receive-pack (v0 push). A module answers a request and returns true, or returns false for "not mine".
import type { IncomingMessage, ServerResponse } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { authorized, pathOf, queryOf, readBody } from './http.ts';
import { parseCommit, parseTree } from './gitops.ts';
import { ingestPack, writePack } from './pack.ts';
import { DELIM, FLUSH, parsePkts, pkt, sideband } from './pktline.ts';
import { findRepo, getObject, tick, type GitObject, type Repo } from './store.ts';

const ZERO = '0'.repeat(40);
const AGENT = 'agent=forge/1';
const BAD_REF = /[\x00-\x20~^:?*[\\]|\.\.|\/\/|\.lock$|\/$/;

function send(res: ServerResponse, status: number, type: string, body: Buffer | string, extra: Record<string, string> = {}): void {
  const buf = typeof body === 'string' ? Buffer.from(body) : body;
  res.writeHead(status, { 'content-type': type, 'content-length': buf.length, 'cache-control': 'no-cache', ...extra });
  res.end(buf);
}

const text = (b: Buffer): string => b.toString('utf8').replace(/\n$/, '');

/** The tag chain's final non-tag target, or null if it is not a tag. */
function peel(repo: Repo, sha: string): string | null {
  let o = getObject(repo, sha);
  if (o === undefined || o.type !== 'tag') return null;
  let cur = sha;
  for (let i = 0; i < 20 && o !== undefined && o.type === 'tag'; i++) {
    const m = /^object ([0-9a-f]{40})/.exec(o.data.toString('latin1'));
    if (m === null) break;
    cur = m[1] as string;
    o = getObject(repo, cur);
  }
  return cur;
}

function sortedRefs(repo: Repo): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

const headTarget = (repo: Repo): string | null => {
  const t = `refs/heads/${repo.defaultBranch}`;
  return repo.refs.has(t) ? t : null;
};

// ---------------------------------------------------------------------------------------------
// info/refs

function advertise(repo: Repo, service: string, v2: boolean): Buffer {
  const parts: Buffer[] = [];
  if (service === 'git-upload-pack' && v2) {
    parts.push(pkt('version 2\n'), pkt(`${AGENT}\n`), pkt('ls-refs=unborn\n'), pkt('fetch=shallow\n'), pkt('server-option\n'), pkt('object-format=sha1\n'), FLUSH);
    return Buffer.concat(parts);
  }
  parts.push(pkt(`# service=${service}\n`), FLUSH);
  const caps = service === 'git-upload-pack'
    ? ['multi_ack_detailed', 'side-band-64k', 'thin-pack', 'ofs-delta', 'shallow', 'object-format=sha1', AGENT]
    : ['report-status', 'delete-refs', 'side-band-64k', 'quiet', 'ofs-delta', 'object-format=sha1', AGENT];
  const lines: string[] = [];
  const head = headTarget(repo);
  if (service === 'git-upload-pack' && head !== null) {
    caps.splice(caps.length - 1, 0, `symref=HEAD:${head}`);
    lines.push(`${repo.refs.get(head) as string} HEAD`);
  }
  for (const [name, sha] of sortedRefs(repo)) {
    lines.push(`${sha} ${name}`);
    const p = service === 'git-upload-pack' ? peel(repo, sha) : null;
    if (p !== null) lines.push(`${p} ${name}^{}`);
  }
  if (lines.length === 0) lines.push(`${ZERO} capabilities^{}`);
  parts.push(pkt(`${lines[0]}\0${caps.join(' ')}\n`));
  for (const l of lines.slice(1)) parts.push(pkt(`${l}\n`));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// upload-pack v2

function lsRefs(repo: Repo, args: string[]): Buffer {
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice(11));
  const wantPeel = args.includes('peel');
  const wantSym = args.includes('symrefs');
  const wantUnborn = args.includes('unborn');
  const keep = (n: string): boolean => prefixes.length === 0 || prefixes.some((p) => n.startsWith(p));
  const out: Buffer[] = [];
  const head = headTarget(repo);
  if (keep('HEAD')) {
    if (head !== null) out.push(pkt(`${repo.refs.get(head) as string} HEAD${wantSym ? ` symref-target:${head}` : ''}\n`));
    else if (wantUnborn) out.push(pkt(`unborn HEAD${wantSym ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`));
  }
  for (const [name, sha] of sortedRefs(repo)) {
    if (!keep(name)) continue;
    const p = wantPeel ? peel(repo, sha) : null;
    out.push(pkt(`${sha} ${name}${p !== null ? ` peeled:${p}` : ''}\n`));
  }
  out.push(FLUSH);
  return Buffer.concat(out);
}

interface Selection { objs: GitObject[]; shallow: string[]; unshallow: string[] }

function collectTree(repo: Repo, root: string, seen: Set<string>, out: GitObject[] | null): void {
  const stack = [root];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    const o = getObject(repo, sha);
    if (o === undefined) continue;
    seen.add(sha);
    if (out !== null) out.push(o);
    if (o.type === 'tree') for (const e of parseTree(o.data)) if (e.mode !== '160000') stack.push(e.sha);
  }
}

function select(repo: Repo, wants: string[], haves: string[], clientShallow: string[], depth: number | null, relative: boolean): Selection {
  const shallowSet = new Set(clientShallow);
  // Commits the client already has (stopping at its shallow boundary).
  const have = new Set<string>();
  const haveTips: string[] = [];
  {
    const q: string[] = [];
    for (const h0 of haves) {
      let h = h0;
      const pe = peel(repo, h);
      if (pe !== null) h = pe;
      if (getObject(repo, h)?.type === 'commit') { q.push(h); haveTips.push(h); }
    }
    while (q.length > 0) {
      const sha = q.pop() as string;
      if (have.has(sha)) continue;
      have.add(sha);
      if (shallowSet.has(sha)) continue;
      const o = getObject(repo, sha);
      if (o === undefined) continue;
      for (const p of parseCommit(sha, o.data).parents) q.push(p);
    }
  }
  const objs: GitObject[] = [];
  const seen = new Set<string>();
  const shallow: string[] = [];
  const unshallow: string[] = [];
  const treeRoots: string[] = [];
  const edge = new Set<string>(haveTips);
  const level = new Map<string, number>();
  let frontier: string[] = [];
  const extra: string[] = []; // non-commit wants
  for (const w of wants) {
    let sha = w;
    for (let i = 0; i < 20; i++) {
      const o = getObject(repo, sha);
      if (o === undefined) break;
      if (o.type === 'tag') {
        if (!seen.has(sha)) { seen.add(sha); objs.push(o); }
        const m = /^object ([0-9a-f]{40})/.exec(o.data.toString('latin1'));
        if (m === null) break;
        sha = m[1] as string;
        continue;
      }
      if (o.type === 'commit') { if (!level.has(sha)) { level.set(sha, 1); frontier.push(sha); } } else extra.push(sha);
      break;
    }
  }
  if (depth !== null && relative) {
    for (const s of clientShallow) if (!level.has(s) && getObject(repo, s) !== undefined) { level.set(s, 1); frontier.push(s); }
  }
  while (frontier.length > 0) {
    const nextFrontier: string[] = [];
    for (const sha of frontier) {
      const d = level.get(sha) as number;
      const o = getObject(repo, sha);
      if (o === undefined) continue;
      const inHave = have.has(sha);
      if (inHave && depth === null) continue;
      const c = parseCommit(sha, o.data);
      if (!inHave && !seen.has(sha)) { seen.add(sha); objs.push(o); treeRoots.push(c.tree); }
      if (depth !== null) {
        if (d >= depth) { if (c.parents.length > 0) shallow.push(sha); continue; }
        if (shallowSet.has(sha) && c.parents.length > 0) unshallow.push(sha);
      } else if (shallowSet.has(sha)) continue;
      for (const p of c.parents) {
        if (have.has(p) && depth === null) { edge.add(p); continue; }
        if (!level.has(p)) { level.set(p, d + 1); nextFrontier.push(p); }
      }
    }
    frontier = nextFrontier;
  }
  // Objects reachable from what the client has are skipped: the have tips and the edge commits' trees.
  for (const e of edge) {
    const o = getObject(repo, e);
    if (o !== undefined && o.type === 'commit') collectTree(repo, parseCommit(e, o.data).tree, seen, null);
  }
  for (const t of treeRoots) collectTree(repo, t, seen, objs);
  for (const x of extra) collectTree(repo, x, seen, objs);
  return { objs, shallow, unshallow };
}

function fetchV2(repo: Repo, args: string[]): Buffer {
  const wants: string[] = []; const haves: string[] = []; const shallows: string[] = [];
  let depth: number | null = null; let done = false; let relative = false;
  for (const a of args) {
    if (a.startsWith('want ')) wants.push(a.slice(5));
    else if (a.startsWith('have ')) haves.push(a.slice(5));
    else if (a.startsWith('shallow ')) shallows.push(a.slice(8));
    else if (a.startsWith('deepen ')) depth = Number(a.slice(7));
    else if (a === 'deepen-relative') relative = true;
    else if (a === 'done') done = true;
  }
  for (const w of wants) if (getObject(repo, w) === undefined) return pkt(`ERR upload-pack: not our ref ${w}\n`);
  if (depth !== null && !(depth >= 1)) return pkt('ERR Invalid deepen: depth must be positive\n');
  const out: Buffer[] = [];
  const common = haves.filter((h) => getObject(repo, h) !== undefined);
  if (!done) {
    out.push(pkt('acknowledgments\n'));
    if (common.length === 0) { out.push(pkt('NAK\n'), FLUSH); return Buffer.concat(out); }
    for (const h of common) out.push(pkt(`ACK ${h}\n`));
    out.push(pkt('ready\n'), DELIM);
  }
  const sel = select(repo, wants, haves, shallows, depth, relative);
  if (depth !== null) {
    out.push(pkt('shallow-info\n'));
    for (const s of sel.shallow) out.push(pkt(`shallow ${s}\n`));
    for (const s of sel.unshallow) out.push(pkt(`unshallow ${s}\n`));
    out.push(DELIM);
  }
  out.push(pkt('packfile\n'), ...sideband(1, writePack(sel.objs)), FLUSH);
  return Buffer.concat(out);
}

const fetchCache = new WeakMap<Repo, Map<string, Buffer>>();

function uploadPack(repo: Repo, body: Buffer): Buffer {
  const key = body.toString('latin1');
  const cacheable = key.includes('command=fetch') && !key.includes('have ');
  if (cacheable) {
    const hit = fetchCache.get(repo)?.get(key);
    if (hit !== undefined) return hit;
  }
  const out = uploadPackRaw(repo, body);
  if (cacheable && out.includes('packfile')) {
    let m = fetchCache.get(repo);
    if (m === undefined) { m = new Map(); fetchCache.set(repo, m); }
    if (m.size >= 32) m.clear();
    m.set(key, out);
  }
  return out;
}

function uploadPackRaw(repo: Repo, body: Buffer): Buffer {
  const { pkts } = parsePkts(body);
  const lines: string[] = [];
  let args: string[] = [];
  let seenDelim = false;
  for (const p of pkts) {
    if (p === 'flush') break;
    if (p === 'delim') { seenDelim = true; continue; }
    if (p === 'end') continue;
    (seenDelim ? args : lines).push(text(p));
  }
  const cmd = lines.find((l) => l.startsWith('command='));
  if (cmd === 'command=ls-refs') return lsRefs(repo, args);
  if (cmd === 'command=fetch') return fetchV2(repo, args);
  args = [];
  return pkt('ERR unknown command\n');
}

// ---------------------------------------------------------------------------------------------
// receive-pack v0

function isAncestor(repo: Repo, old: string, tip: string): boolean {
  const seen = new Set<string>();
  const q = [tip];
  while (q.length > 0) {
    const sha = q.pop() as string;
    if (sha === old) return true;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const o = getObject(repo, sha);
    if (o === undefined || o.type !== 'commit') continue;
    for (const p of parseCommit(sha, o.data).parents) q.push(p);
  }
  return false;
}

function receivePack(repo: Repo, body: Buffer): Buffer {
  const { pkts, next } = parsePkts(body, 0, true);
  const cmds: { old: string; neu: string; ref: string }[] = [];
  let caps = '';
  for (const p of pkts) {
    if (typeof p === 'string') continue;
    let line = text(p);
    if (cmds.length === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) { caps = line.slice(nul + 1); line = line.slice(0, nul); }
    }
    if (line.startsWith('shallow ')) continue;
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S.*)$/.exec(line);
    if (m === null) throw new Error('bad command');
    cmds.push({ old: m[1] as string, neu: m[2] as string, ref: m[3] as string });
  }
  const capSet = new Set(caps.split(' '));
  const lines: string[] = [];
  let unpackErr: string | null = null;
  if (next < body.length) {
    try { ingestPack(repo, body.subarray(next)); } catch (e) { unpackErr = e instanceof Error ? e.message : 'unpack error'; }
  }
  lines.push(unpackErr === null ? 'unpack ok' : `unpack ${unpackErr}`);
  let changed = false;
  for (const c of cmds) {
    const fail = (why: string): void => { lines.push(`ng ${c.ref} ${why}`); };
    if (unpackErr !== null) { fail('unpacker error'); continue; }
    if (!c.ref.startsWith('refs/') || BAD_REF.test(c.ref)) { fail('funny refname'); continue; }
    const cur = repo.refs.get(c.ref) ?? null;
    if (c.neu === ZERO) {
      if (cur === null) { fail('does not exist'); continue; }
      if (cur !== c.old) { fail('stale info'); continue; }
      repo.refs.delete(c.ref); changed = true; lines.push(`ok ${c.ref}`);
      continue;
    }
    const obj = getObject(repo, c.neu);
    if (obj === undefined) { fail('missing necessary objects'); continue; }
    if (c.ref.startsWith('refs/heads/') && obj.type !== 'commit') { fail('refusing non-commit'); continue; }
    if (c.old === ZERO) {
      if (cur !== null) { fail('already exists'); continue; }
    } else {
      if (cur !== c.old) { fail('stale info'); continue; }
      if (c.ref.startsWith('refs/heads/') && !isAncestor(repo, c.old, c.neu)) { fail('non-fast-forward'); continue; }
    }
    repo.refs.set(c.ref, c.neu); changed = true; lines.push(`ok ${c.ref}`);
  }
  if (changed) { const now = tick(); repo.pushedAt = now; repo.updatedAt = now; }
  if (!capSet.has('report-status')) return Buffer.alloc(0);
  const report = Buffer.concat([...lines.map((l) => pkt(`${l}\n`)), FLUSH]);
  return capSet.has('side-band-64k') ? Buffer.concat([...sideband(1, report), FLUSH]) : report;
}

// ---------------------------------------------------------------------------------------------

export async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const m = /^\/([^/]+)\/([^/]+)\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathOf(req));
  if (m === null) return false;
  const method = req.method ?? 'GET';
  const what = m[3] as string;
  if (what === 'info/refs' ? method !== 'GET' : method !== 'POST') return false;
  if (!authorized(req)) {
    send(res, 401, 'text/plain', 'Authentication required\n', { 'www-authenticate': 'Basic realm="forge"' });
    return true;
  }
  let owner: string; let name: string;
  try { owner = decodeURIComponent(m[1] as string); name = decodeURIComponent(m[2] as string); } catch { return false; }
  const repo = findRepo(owner, name);
  if (repo === null) { send(res, 404, 'text/plain', 'Not Found\n'); return true; }
  if (what === 'info/refs') {
    const service = queryOf(req).get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') { send(res, 403, 'text/plain', 'Dumb protocol not supported\n'); return true; }
    const v2 = /version=2/.test(String(req.headers['git-protocol'] ?? ''));
    send(res, 200, `application/x-${service}-advertisement`, advertise(repo, service, v2));
    return true;
  }
  let body = await readBody(req);
  try {
    if (String(req.headers['content-encoding'] ?? '').toLowerCase().includes('gzip')) body = gunzipSync(body);
    const out = what === 'git-upload-pack' ? uploadPack(repo, body) : receivePack(repo, body);
    send(res, 200, `application/x-${what}-result`, out);
  } catch (e) {
    send(res, 400, 'text/plain', `Bad Request: ${e instanceof Error ? e.message : 'malformed'}\n`);
  }
  return true;
}
