// Git plumbing over store.ts: parse and build trees and commits, flatten a tree to paths, commit a set of
// file changes to a branch, walk history, diff two trees, and merge a pull request. Pure functions over
// a Repo's object map: no I/O and no clock (timestamps come from store.tick()).
import { getObject, putObject, tick, type Repo, viewerEmail, viewerLogin } from './store.ts';

export interface TreeEntry { mode: string; name: string; sha: string }
export interface CommitInfo { sha: string; tree: string; parents: string[]; author: string; committer: string; message: string; time: number }
export interface FlatEntry { mode: string; sha: string }
export interface Identity { name: string; email: string }

export const refOf = (branch: string): string => (branch.startsWith('refs/') ? branch : `refs/heads/${branch}`);
export const branchOf = (ref: string): string => ref.replace(/^refs\/heads\//, '');

// ---------------------------------------------------------------------------------------------
// Trees

export function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    const nul = data.indexOf(0, space);
    out.push({ mode: data.toString('latin1', i, space), name: data.toString('utf8', space + 1, nul), sha: data.subarray(nul + 1, nul + 21).toString('hex') });
    i = nul + 21;
  }
  return out;
}

/** Git sorts tree entries by name, comparing a directory as if its name ended in '/'. */
function treeSortKey(e: TreeEntry): Buffer {
  return Buffer.from(e.mode === '40000' ? `${e.name}/` : e.name, 'utf8');
}

export function serializeTree(entries: TreeEntry[]): Buffer {
  const sorted = entries.slice().sort((a, b) => Buffer.compare(treeSortKey(a), treeSortKey(b)));
  return Buffer.concat(sorted.map((e) => Buffer.concat([Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'), Buffer.from(e.sha, 'hex')])));
}

export const writeTree = (repo: Repo, entries: TreeEntry[]): string => putObject(repo, 'tree', serializeTree(entries));

/** Every file under `treeSha` as path -> {mode, sha}; submodule entries are kept as files. */
export function flattenTree(repo: Repo, treeSha: string | null, prefix = '', out = new Map<string, FlatEntry>()): Map<string, FlatEntry> {
  if (treeSha === null) return out;
  const tree = getObject(repo, treeSha);
  if (tree === undefined || tree.type !== 'tree') return out;
  for (const e of parseTree(tree.data)) {
    if (e.mode === '40000') flattenTree(repo, e.sha, `${prefix}${e.name}/`, out);
    else out.set(`${prefix}${e.name}`, { mode: e.mode, sha: e.sha });
  }
  return out;
}

/** Build the nested trees for a flat path map and return the root tree's sha (an empty map gives the empty tree). */
export function treeFromFlat(repo: Repo, flat: Map<string, FlatEntry>): string {
  interface Dir { files: Map<string, FlatEntry>; dirs: Map<string, Dir> }
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of flat) {
    const parts = path.split('/');
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      let next = dir.dirs.get(part);
      if (next === undefined) { next = { files: new Map(), dirs: new Map() }; dir.dirs.set(part, next); }
      dir = next;
    }
    dir.files.set(parts[parts.length - 1] as string, entry);
  }
  const write = (dir: Dir): string => {
    const entries: TreeEntry[] = [];
    for (const [name, e] of dir.files) entries.push({ mode: e.mode, name, sha: e.sha });
    for (const [name, child] of dir.dirs) entries.push({ mode: '40000', name, sha: write(child) });
    return writeTree(repo, entries);
  };
  return write(root);
}

/** The entry at `path` in a tree: a file, a directory listing, or null. */
export function lookupPath(repo: Repo, treeSha: string, path: string): { kind: 'file'; mode: string; sha: string } | { kind: 'dir'; sha: string; entries: TreeEntry[] } | null {
  let sha = treeSha;
  const parts = path.split('/').filter((p) => p !== '');
  for (let i = 0; i < parts.length; i++) {
    const tree = getObject(repo, sha);
    if (tree === undefined || tree.type !== 'tree') return null;
    const hit = parseTree(tree.data).find((e) => e.name === parts[i]);
    if (hit === undefined) return null;
    if (i === parts.length - 1) {
      if (hit.mode === '40000') {
        const dir = getObject(repo, hit.sha);
        return dir === undefined ? null : { kind: 'dir', sha: hit.sha, entries: parseTree(dir.data) };
      }
      return { kind: 'file', mode: hit.mode, sha: hit.sha };
    }
    if (hit.mode !== '40000') return null;
    sha = hit.sha;
  }
  const root = getObject(repo, sha);
  return root === undefined ? null : { kind: 'dir', sha, entries: parseTree(root.data) };
}

// ---------------------------------------------------------------------------------------------
// Commits

export function parseCommit(sha: string, data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const cut = text.indexOf('\n\n');
  const header = cut === -1 ? text : text.slice(0, cut);
  const message = cut === -1 ? '' : text.slice(cut + 2);
  const info: CommitInfo = { sha, tree: '', parents: [], author: '', committer: '', message, time: 0 };
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5);
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7));
    else if (line.startsWith('author ')) info.author = line.slice(7);
    else if (line.startsWith('committer ')) info.committer = line.slice(10);
  }
  const m = /> (\d+) [+-]\d{4}$/.exec(info.committer);
  info.time = m === null ? 0 : Number(m[1]);
  return info;
}

export function readCommit(repo: Repo, sha: string): CommitInfo | null {
  const o = getObject(repo, sha);
  return o === undefined || o.type !== 'commit' ? null : parseCommit(sha, o.data);
}

export const defaultIdentity = (): Identity => ({ name: viewerLogin(), email: viewerEmail() });
const stamp = (id: Identity, unix: number): string => `${id.name} <${id.email}> ${unix} +0000`;

export function writeCommit(repo: Repo, opts: { tree: string; parents: string[]; message: string; author?: Identity; committer?: Identity }): string {
  const unix = Math.floor(Date.parse(tick()) / 1000);
  const author = opts.author ?? defaultIdentity();
  const committer = opts.committer ?? author;
  const lines = [`tree ${opts.tree}`, ...opts.parents.map((p) => `parent ${p}`), `author ${stamp(author, unix)}`, `committer ${stamp(committer, unix)}`, '', opts.message];
  return putObject(repo, 'commit', Buffer.from(lines.join('\n'), 'utf8'));
}

/** Apply file changes (content null deletes) on top of `branch` and move the branch; an unborn branch starts from nothing. */
export function commitFiles(repo: Repo, branch: string, changes: { path: string; content: Buffer | null; mode?: string }[], message: string, identity?: Identity): { commitSha: string; blobs: Map<string, string> } {
  const ref = refOf(branch);
  const parentSha = repo.refs.get(ref) ?? null;
  const parent = parentSha === null ? null : readCommit(repo, parentSha);
  const flat = flattenTree(repo, parent === null ? null : parent.tree);
  const blobs = new Map<string, string>();
  for (const c of changes) {
    if (c.content === null) flat.delete(c.path);
    else {
      const sha = putObject(repo, 'blob', c.content);
      blobs.set(c.path, sha);
      flat.set(c.path, { mode: c.mode ?? '100644', sha });
    }
  }
  const tree = treeFromFlat(repo, flat);
  const commitSha = writeCommit(repo, { tree, parents: parentSha === null ? [] : [parentSha], message, author: identity });
  repo.refs.set(ref, commitSha);
  repo.updatedAt = tick();
  return { commitSha, blobs };
}

/** Commits reachable from `start`, newest first (by committer time, ties by discovery order). */
export function log(repo: Repo, start: string, limit = Infinity): CommitInfo[] {
  const seen = new Map<string, CommitInfo>();
  const order: string[] = [];
  const stack = [start];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    const c = readCommit(repo, sha);
    if (c === null) continue;
    seen.set(sha, c);
    order.push(sha);
    for (let i = c.parents.length - 1; i >= 0; i--) stack.push(c.parents[i] as string);
  }
  const rank = new Map(order.map((sha, i) => [sha, i]));
  return [...seen.values()].sort((a, b) => b.time - a.time || (rank.get(a.sha) as number) - (rank.get(b.sha) as number)).slice(0, limit);
}

export const ancestors = (repo: Repo, sha: string): Set<string> => new Set(log(repo, sha).map((c) => c.sha));

export function isAncestor(repo: Repo, maybeAncestor: string, descendant: string): boolean {
  return ancestors(repo, descendant).has(maybeAncestor);
}

/** The newest commit both sides share, or null. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ofA = ancestors(repo, a);
  for (const c of log(repo, b)) if (ofA.has(c.sha)) return c.sha;
  return null;
}

// ---------------------------------------------------------------------------------------------
// Diff and merge

export interface FileChange { path: string; status: 'added' | 'removed' | 'modified'; oldSha: string | null; newSha: string | null; oldMode: string | null; newMode: string | null }

export function diffFlat(a: Map<string, FlatEntry>, b: Map<string, FlatEntry>): FileChange[] {
  const out: FileChange[] = [];
  for (const path of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const x = a.get(path);
    const y = b.get(path);
    if (x === undefined && y !== undefined) out.push({ path, status: 'added', oldSha: null, newSha: y.sha, oldMode: null, newMode: y.mode });
    else if (x !== undefined && y === undefined) out.push({ path, status: 'removed', oldSha: x.sha, newSha: null, oldMode: x.mode, newMode: null });
    else if (x !== undefined && y !== undefined && (x.sha !== y.sha || x.mode !== y.mode)) out.push({ path, status: 'modified', oldSha: x.sha, newSha: y.sha, oldMode: x.mode, newMode: y.mode });
  }
  return out;
}

export const flatOfCommit = (repo: Repo, sha: string | null): Map<string, FlatEntry> => {
  const c = sha === null ? null : readCommit(repo, sha);
  return flattenTree(repo, c === null ? null : c.tree);
};

/** Count the lines of a blob (for additions and deletions on a pull request's files). */
export function lineCount(repo: Repo, sha: string | null): number {
  if (sha === null) return 0;
  const o = getObject(repo, sha);
  if (o === undefined || o.data.length === 0) return 0;
  const text = o.data.toString('utf8');
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
}

/**
 * Three-way merge of `headSha` into `baseSha` at file level. A path changed on one side only takes that
 * side; changed identically on both is fine; changed differently on both is a conflict. With `squash` the
 * result commit has the base tip as its only parent, otherwise both tips.
 */
export function mergeBranches(repo: Repo, baseRef: string, headSha: string, message: string, squash: boolean): { sha: string } | { conflict: true } {
  const baseSha = repo.refs.get(refOf(baseRef));
  if (baseSha === undefined) return { conflict: true };
  const mb = mergeBase(repo, baseSha, headSha);
  const B = flatOfCommit(repo, mb);
  const H = flatOfCommit(repo, headSha);
  const M = flatOfCommit(repo, baseSha);
  const merged = new Map<string, FlatEntry>();
  for (const path of new Set([...B.keys(), ...H.keys(), ...M.keys()])) {
    const b = B.get(path);
    const h = H.get(path);
    const m = M.get(path);
    const same = (x?: FlatEntry, y?: FlatEntry): boolean => (x === undefined && y === undefined) || (x !== undefined && y !== undefined && x.sha === y.sha && x.mode === y.mode);
    let pick: FlatEntry | undefined;
    if (same(h, b)) pick = m;
    else if (same(m, b) || same(h, m)) pick = h;
    else return { conflict: true };
    if (pick !== undefined) merged.set(path, pick);
  }
  const tree = treeFromFlat(repo, merged);
  const sha = writeCommit(repo, { tree, parents: squash ? [baseSha] : [baseSha, headSha], message });
  repo.refs.set(refOf(baseRef), sha);
  repo.updatedAt = tick();
  return { sha };
}
