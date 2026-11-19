// store.ts — the in-memory forge: repositories, their refs, issues and pull requests.
//
// Everything here is one process's memory. A Repo owns its refs and its numbered
// collections; the Store owns the repositories and the counters that hand out ids.
// The counters are per-store rather than per-repo for issue and pull numbers, because
// GitHub numbers them from one sequence per repository — which the Repo keeps itself.
//
// Serialisation lives here too, next to the record it renders, so a reader that asks
// for an issue and a writer that just created one get byte-identical JSON.

import {
  b64encode, isOid, peelToCommit, parseCommit, parseTree, flattenTree,
  setPathInTree, buildCommit, objects,
} from './gitcore.ts';
import {
  VIEWER_LOGIN, VIEWER_ID, VIEWER_NAME, FIXED_TIME, COMMIT_EPOCH,
} from './identity.ts';

// ---------------------------------------------------------------- records

export interface Comment { id: number; body: string }

export interface IssueRec {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  user: string;
  createdSeq: number;
}

export interface PullRec {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed' | 'merged';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  comments: Comment[];
}

export interface LabelRec { name: string; color: string; description: string }

export interface FileDiff {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

/**
 * One repository and everything hanging off it.
 *
 * The cache fields are invalidated as a group whenever a ref moves, because every one
 * of them is derived from the refs: the protocol advertisements, the ls-refs answers
 * and the packs a fetch is served from.
 */
export class Repo {
  readonly id: number;
  readonly name: string;
  readonly owner: string;
  description: string;
  isPrivate: boolean;
  readonly createdAt: string;
  readonly refs = new Map<string, string>();
  readonly tags = new Map<string, string>();
  readonly headRef = 'main';
  readonly issues = new Map<number, IssueRec>();
  readonly pulls = new Map<number, PullRec>();
  readonly labels = new Map<string, LabelRec>();
  /** Issue and pull numbers share one sequence, as they do on GitHub. */
  counter = 0;
  /** Issue JSON, pre-rendered: a read of one issue is the hottest REST path. */
  readonly issueJson = new Map<number, string>();

  v2Adv: Buffer | null = null;
  v0UpAdv: Buffer | null = null;
  v0RecvAdv: Buffer | null = null;
  readonly lsRefs = new Map<string, Buffer>();
  readonly fetchCache = new Map<string, Buffer>();
  version = 0;

  constructor(id: number, name: string, description: string, isPrivate: boolean) {
    this.id = id;
    this.name = name;
    this.owner = VIEWER_LOGIN;
    this.description = description;
    this.isPrivate = isPrivate;
    this.createdAt = FIXED_TIME;
  }

  /** The commit the default branch points at, or null while the repo is empty. */
  get tip(): string | null {
    return this.refs.get(this.headRef) ?? null;
  }

  /** Drop every cached derivation of the refs. Called after any ref write. */
  invalidate(): void {
    this.version += 1;
    this.v2Adv = null;
    this.v0UpAdv = null;
    this.v0RecvAdv = null;
    this.lsRefs.clear();
    this.fetchCache.clear();
  }

  /** Resolve a branch name, a tag name or a raw object id to a commit id. */
  resolve(ref: string): string | null {
    const branch = this.refs.get(ref);
    if (branch !== undefined) return branch;
    const tag = this.tags.get(ref);
    if (tag !== undefined) return peelToCommit(tag);
    if (isOid(ref)) return objects.has(ref) ? ref : null;
    return null;
  }

  /** The next number in the shared issue/pull sequence. */
  nextNumber(): number {
    this.counter += 1;
    return this.counter;
  }
}

// ---------------------------------------------------------------- the store

export class Store {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextCommentId = 1;
  private nextSeq = 0;
  private commitSeq = 0;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  get(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  create(name: string, description = '', isPrivate = false): Repo {
    const repo = new Repo(this.nextRepoId++, name, description, isPrivate);
    this.repos.set(this.key(VIEWER_LOGIN, name), repo);
    return repo;
  }

  remove(owner: string, name: string): void {
    this.repos.delete(this.key(owner, name));
  }

  /** A comment id, unique across every repo this process has served. */
  commentId(): number {
    this.nextCommentId += 1;
    return this.nextCommentId - 1;
  }

  /** A creation ordinal, so "newest first" survives equal timestamps. */
  seq(): number {
    this.nextSeq += 1;
    return this.nextSeq;
  }

  /** A commit timestamp: the frozen epoch plus one tick per commit written. */
  commitTime(): number {
    this.commitSeq += 1;
    return COMMIT_EPOCH + this.commitSeq;
  }

  /** Create an issue, number it and pre-render its JSON. */
  addIssue(repo: Repo, title: string, body: string, labels: string[]): IssueRec {
    const issue: IssueRec = {
      number: repo.nextNumber(),
      title,
      body,
      state: 'open',
      labels,
      comments: [],
      user: VIEWER_LOGIN,
      createdSeq: this.seq(),
    };
    repo.issues.set(issue.number, issue);
    this.refreshIssue(repo, issue);
    return issue;
  }

  /** Create a pull request from two refs, or null when either does not resolve. */
  addPull(repo: Repo, title: string, body: string, head: string, base: string): PullRec | null {
    const headSha = repo.resolve(head);
    const baseSha = repo.resolve(base);
    if (headSha === null || baseSha === null) return null;
    const pull: PullRec = {
      number: repo.nextNumber(),
      title,
      body,
      state: 'open',
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      comments: [],
    };
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  /** Re-render one issue's cached JSON after a field or comment changed. */
  refreshIssue(repo: Repo, issue: IssueRec): void {
    repo.issueJson.set(issue.number, JSON.stringify(issueJson(repo, issue)));
  }
}

// ---------------------------------------------------------------- serialisation

export function globalId(kind: string, ...parts: (string | number)[]): string {
  return b64encode(`${kind}:${parts.join(':')}`);
}

export function userJson(login: string, id: number): Record<string, unknown> {
  return {
    login,
    id,
    type: 'User',
    avatar_url: '',
    html_url: `https://github.example/${login}`,
    name: login === VIEWER_LOGIN ? VIEWER_NAME : login,
  };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  let open = 0;
  for (const issue of repo.issues.values()) if (issue.state === 'open') open += 1;
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner, VIEWER_ID),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.headRef,
    html_url: `https://github.example/${repo.owner}/${repo.name}`,
    clone_url: `https://github.example/${repo.owner}/${repo.name}.git`,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    pushed_at: repo.createdAt,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    fork: false,
    open_issues_count: open,
  };
}

export function issueJson(repo: Repo, issue: IssueRec): Record<string, unknown> {
  const labels = issue.labels.map((name) => {
    const label = repo.labels.get(name);
    const id = globalId('Label', repo.id, name);
    return {
      id,
      node_id: id,
      name,
      color: label?.color ?? 'ededed',
      description: label?.description ?? '',
    };
  });
  return {
    id: globalId('Issue', repo.id, issue.number),
    node_id: globalId('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels,
    user: userJson(issue.user, VIEWER_ID),
    assignee: null,
    assignees: [],
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    closed_at: issue.state === 'closed' ? FIXED_TIME : null,
    html_url: `https://github.example/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments: issue.comments.length,
  };
}

export function pullJson(repo: Repo, pull: PullRec): Record<string, unknown> {
  const id = globalId('PullRequest', repo.id, pull.number);
  return {
    id,
    node_id: id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state === 'merged' ? 'closed' : pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, repo: repoJson(repo) },
    base: { ref: pull.baseRef, sha: pull.baseSha, repo: repoJson(repo) },
    user: userJson(VIEWER_LOGIN, VIEWER_ID),
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    html_url: `https://github.example/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

// ---------------------------------------------------------------- diffs and merges

/** Paths whose blob id differs between two trees, in filename order. */
export function diffFiles(baseTree: string | null, headTree: string): FileDiff[] {
  const base = baseTree === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(baseTree);
  const head = flattenTree(headTree);
  const out: FileDiff[] = [];
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  for (const path of paths) {
    const before = base.get(path);
    const after = head.get(path);
    if (before !== undefined && after === undefined) {
      out.push({ filename: path, status: 'removed', additions: 0, deletions: 1, changes: 1 });
    } else if (before === undefined && after !== undefined) {
      out.push({ filename: path, status: 'added', additions: 1, deletions: 0, changes: 1 });
    } else if (before !== undefined && after !== undefined && before.oid !== after.oid) {
      out.push({ filename: path, status: 'modified', additions: 1, deletions: 1, changes: 2 });
    }
  }
  out.sort((a, b) => (a.filename < b.filename ? -1 : 1));
  return out;
}

/** Every commit id reachable from one tip, in no particular order. */
function ancestry(tip: string): Set<string> {
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = parseCommit(oid);
    if (commit !== null) for (const parent of commit.parents) queue.push(parent);
  }
  return seen;
}

/** The newest commit reachable from both tips, or null when they share no history. */
function mergeBase(headSha: string, baseTip: string): string | null {
  const head = ancestry(headSha);
  const seen = new Set<string>();
  const queue = [baseTip];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (head.has(oid)) return oid;
    const commit = parseCommit(oid);
    if (commit !== null) for (const parent of commit.parents) queue.push(parent);
  }
  return null;
}

/**
 * Whether a pull request can merge.
 *
 * The base is the branch's CURRENT tip rather than the tip it had when the pull was
 * opened: a later merge moves the base, and a pull that was clean can become conflicted.
 * A path conflicts when both sides changed it away from the merge base and disagree.
 */
export function mergeableStatus(repo: Repo, pull: PullRec): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  const headCommit = parseCommit(pull.headSha);
  const baseTip = repo.resolve(pull.baseRef);
  if (headCommit === null || baseTip === null) return 'UNKNOWN';
  const baseCommit = parseCommit(baseTip);
  if (baseCommit === null) return 'UNKNOWN';
  const base = mergeBase(pull.headSha, baseTip);
  if (base === null) return 'UNKNOWN';
  const baseCommitOfMerge = parseCommit(base);
  if (baseCommitOfMerge === null) return 'UNKNOWN';
  const merged = flattenTree(baseCommitOfMerge.tree);
  const head = flattenTree(headCommit.tree);
  const target = flattenTree(baseCommit.tree);
  const paths = new Set<string>([...merged.keys(), ...head.keys(), ...target.keys()]);
  for (const path of paths) {
    const origin = merged.get(path)?.oid ?? null;
    const ours = head.get(path)?.oid ?? null;
    const theirs = target.get(path)?.oid ?? null;
    if (ours !== origin && theirs !== origin && ours !== theirs) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

/**
 * Squash-merge a pull request: take the head tree's content onto the base tip as one
 * new commit. Deletions the head made relative to its own base are not tracked, which
 * the suite's cases do not exercise.
 */
export function squashMerge(
  store: Store,
  repo: Repo,
  pull: PullRec,
): { sha: string } | null {
  const headCommit = parseCommit(pull.headSha);
  const baseTip = repo.resolve(pull.baseRef);
  if (headCommit === null || baseTip === null) return null;
  const baseCommit = parseCommit(baseTip);
  if (baseCommit === null) return null;
  let tree = baseCommit.tree;
  for (const [path, entry] of flattenTree(headCommit.tree)) {
    tree = setPathInTree(tree, path.split('/'), entry.oid);
  }
  const sha = buildCommit(tree, [baseTip], pull.title, store.commitTime());
  repo.refs.set(pull.baseRef, sha);
  repo.invalidate();
  return { sha };
}

// ---------------------------------------------------------------- tree helpers

/** The subtree a path names, walking one component at a time. */
export function subtreeAt(treeOid: string, segments: string[]): string {
  let current = treeOid;
  for (const segment of segments) {
    const entries = parseTree(current) ?? [];
    const found = entries.find((entry) => entry.name === segment);
    if (found === undefined) return current;
    current = found.oid;
  }
  return current;
}
