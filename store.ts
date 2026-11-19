// The forge's one in-memory store: users, repositories (each with its own git object database and
// refs), labels, issues, comments and pull requests. Every surface (REST, git smart HTTP, GraphQL,
// MCP) reads and writes through this file and gitops.ts, so a change made through one is seen by all.
// Nothing here touches the network, the clock or Math.random: timestamps come from tick().
import { createHash } from 'node:crypto';

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';
export interface GitObject { type: ObjType; data: Buffer }
export interface Label { name: string; color: string; description: string | null }
export interface Comment { id: number; body: string; user: string; createdAt: string; updatedAt: string }
export interface Issue {
  number: number; id: number; title: string; body: string | null; state: 'open' | 'closed'; labels: string[];
  user: string; createdAt: string; updatedAt: string; closedAt: string | null; comments: Comment[];
}
export interface Pull {
  number: number; id: number; title: string; body: string | null; state: 'open' | 'closed'; draft: boolean;
  head: { ref: string; sha: string }; base: { ref: string; sha: string };
  user: string; createdAt: string; updatedAt: string; closedAt: string | null; mergedAt: string | null; mergeCommitSha: string | null;
  merged: boolean; comments: Comment[];
}
export interface Repo {
  id: number; owner: string; name: string; private: boolean; description: string | null; defaultBranch: string;
  createdAt: string; updatedAt: string; pushedAt: string | null;
  objects: Map<string, GitObject>; refs: Map<string, string>; labels: Map<string, Label>;
  issues: Issue[]; pulls: Pull[]; nextNumber: number;
  /** Commits a shallow client has told us it already holds, keyed by nothing: kept only per request. */
}

export const state = {
  /** The login the bearer token names. The server is never told it, so it is the first owner an authenticated request names. */
  viewer: null as string | null,
  repos: new Map<string, Repo>(),
  token: process.env.MAKEFUN_SHOP_TOKEN ?? '',
  seq: { repo: 1, issue: 1, comment: 1, pull: 1, tick: 0 },
};

const EPOCH_MS = Date.parse(process.env.MAKEFUN_TRIAL_NOW ?? '2026-01-01T00:00:00Z') || Date.parse('2026-01-01T00:00:00Z');

/** An ISO timestamp that moves forward one second per call: deterministic, never the wall clock. */
export function tick(): string {
  state.seq.tick += 1;
  return new Date(EPOCH_MS + state.seq.tick * 1000).toISOString().replace('.000Z', 'Z');
}

/** The viewer's login, or a placeholder until a request names it. */
export const viewerLogin = (): string => state.viewer ?? 'viewer';
export const viewerEmail = (): string => `${viewerLogin()}@example.invalid`;

/** Whether `owner` is the token's login. The first owner an authenticated request names becomes the viewer. */
export function isViewer(owner: string): boolean {
  if (state.viewer === null) {
    state.viewer = owner;
    for (const repo of state.repos.values()) repo.owner = owner;
    rekey();
  }
  return state.viewer.toLowerCase() === owner.toLowerCase();
}

const keyOf = (owner: string, name: string): string => `${owner.toLowerCase()}/${name.toLowerCase()}`;

function rekey(): void {
  const all = [...state.repos.values()];
  state.repos.clear();
  for (const repo of all) state.repos.set(keyOf(repo.owner, repo.name), repo);
}

/** The repository `owner/name` if it belongs to the viewer, else null (another owner's repository is a 404). */
export function findRepo(owner: string, name: string): Repo | null {
  if (!isViewer(owner)) return null;
  return state.repos.get(keyOf(owner, name.replace(/\.git$/, ''))) ?? null;
}

export function listRepos(): Repo[] {
  return [...state.repos.values()].sort((a, b) => a.id - b.id);
}

export function createRepo(name: string, opts: { private?: boolean; description?: string | null; defaultBranch?: string } = {}): Repo | null {
  const owner = viewerLogin();
  if (state.repos.has(keyOf(owner, name))) return null;
  const now = tick();
  const repo: Repo = {
    id: state.seq.repo++, owner, name, private: opts.private ?? false, description: opts.description ?? null,
    defaultBranch: opts.defaultBranch ?? 'main', createdAt: now, updatedAt: now, pushedAt: null,
    objects: new Map(), refs: new Map(), labels: new Map(), issues: [], pulls: [], nextNumber: 1,
  };
  state.repos.set(keyOf(owner, name), repo);
  return repo;
}

export function deleteRepo(repo: Repo): void {
  state.repos.delete(keyOf(repo.owner, repo.name));
}

// ---------------------------------------------------------------------------------------------
// The git object database

/** The SHA-1 a git object of `type` and `data` has. */
export function hashObject(type: ObjType, data: Buffer): string {
  return createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex');
}

export function putObject(repo: Repo, type: ObjType, data: Buffer): string {
  const sha = hashObject(type, data);
  if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data });
  return sha;
}

export const getObject = (repo: Repo, sha: string): GitObject | undefined => repo.objects.get(sha);

/** The next issue/pull number: issues and pull requests share one sequence per repository, as on GitHub. */
export const nextNumber = (repo: Repo): number => repo.nextNumber++;
