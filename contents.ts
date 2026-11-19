// contents.ts — the REST contents API: reading a file or a directory, writing and deleting.
//
// The contents routes are the only REST surface that reads trees, so they are the only
// place that has to know how a path maps onto nested tree objects. Keeping them apart
// from the routing table means the path walk, the directory listing and the write path
// can be read as one piece.

import {
  objects, parseCommit, parseTree, flattenTree, setPathInTree, deletePathInTree,
  storeObject, buildCommit, b64decode,
} from './gitcore.ts';
import { subtreeAt, type Repo } from './store.ts';

/** One entry of a directory listing, as the contents API renders it. */
export interface ContentEntry {
  type: 'file' | 'dir';
  name: string;
  path: string;
  sha: string;
  size: number;
}

/** One file's contents, base64 encoded as the API returns it. */
export interface ContentFile {
  type: 'file';
  encoding: 'base64';
  content: string;
  sha: string;
  size: number;
  name: string;
  path: string;
}

function sizeOf(oid: string): number {
  return objects.get(oid)?.data.length ?? 0;
}

/**
 * List one directory of a commit.
 *
 * An empty path lists the root tree; any other path is walked one component at a time
 * so a request never has to flatten the whole tree just to answer.
 */
export function listDirectory(treeOid: string, path: string): ContentEntry[] {
  if (path === '') {
    const entries = parseTree(treeOid) ?? [];
    return entries.map((entry) => ({
      type: entry.mode === '40000' ? 'dir' : 'file',
      name: entry.name,
      path: entry.name,
      sha: entry.oid,
      size: entry.mode === '40000' ? 0 : sizeOf(entry.oid),
    }));
  }
  const tree = subtreeAt(treeOid, path.split('/'));
  const entries = parseTree(tree) ?? [];
  return entries.map((entry) => ({
    type: entry.mode === '40000' ? 'dir' : 'file',
    name: entry.name,
    path: `${path}/${entry.name}`,
    sha: entry.oid,
    size: entry.mode === '40000' ? 0 : sizeOf(entry.oid),
  }));
}

/** The file a path names in a commit, or null when the path is a directory. */
export function readFile(treeOid: string, path: string): ContentFile | null {
  const entry = flattenTree(treeOid).get(path);
  if (entry === undefined) return null;
  const data = objects.get(entry.oid)?.data ?? Buffer.alloc(0);
  return {
    type: 'file',
    encoding: 'base64',
    content: data.toString('base64'),
    sha: entry.oid,
    size: data.length,
    name: path.split('/').pop() ?? path,
    path,
  };
}

/**
 * A directory reached by a partial path, rendered as the entries below it.
 *
 * A client that asks for `src` when the tree holds `src/a.ts` and `src/lib/b.ts` expects
 * two entries: the file and the nested directory, with the directory's own tree id.
 */
export function readSubdirectory(treeOid: string, path: string): ContentEntry[] {
  const prefix = `${path}/`;
  const flat = flattenTree(treeOid);
  const seen = new Map<string, ContentEntry>();
  for (const [filePath, info] of flat) {
    if (!filePath.startsWith(prefix)) continue;
    const rest = filePath.slice(prefix.length);
    const slash = rest.indexOf('/');
    const name = slash < 0 ? rest : rest.slice(0, slash);
    if (seen.has(name)) continue;
    if (slash < 0) {
      seen.set(name, { type: 'file', name, path: `${path}/${name}`, sha: info.oid, size: sizeOf(info.oid) });
    } else {
      const tree = subtreeAt(treeOid, `${path}/${name}`.split('/'));
      seen.set(name, { type: 'dir', name, path: `${path}/${name}`, sha: tree, size: 0 });
    }
  }
  return [...seen.values()];
}

/** Whether a commit already holds a path, used to tell 201 from 200 on a write. */
export function hasPath(treeOid: string | null, path: string): boolean {
  if (treeOid === null) return false;
  return flattenTree(treeOid).has(path);
}

/**
 * Write one file into a tree, returning the new tree id.
 *
 * A `sha` in the request body is the file's expected current blob: when the caller
 * passes one and it no longer matches, the write is stale and must not land.
 */
export function writeFile(
  treeOid: string | null,
  path: string,
  base64: string,
  expectedSha: string | null,
): { tree: string } | { stale: true } {
  if (expectedSha !== null && treeOid !== null) {
    const current = flattenTree(treeOid).get(path);
    if (current !== undefined && current.oid !== expectedSha) return { stale: true };
  }
  const blob = storeObject('blob', b64decode(base64));
  return { tree: setPathInTree(treeOid, path.split('/'), blob) };
}

/** Remove one file from a tree, or null when the path was not there. */
export function removeFile(treeOid: string, path: string): string | null {
  if (!flattenTree(treeOid).has(path)) return null;
  return deletePathInTree(treeOid, path.split('/'));
}

/** The tree a branch currently points at, or null while the branch is unborn. */
export function branchTree(repo: Repo, branch: string): string | null {
  const tip = repo.refs.get(branch);
  if (tip === undefined) return null;
  return parseCommit(tip)?.tree ?? null;
}

/** Commit a new tree onto a branch, returning the commit id. */
export function commitTree(
  repo: Repo,
  branch: string,
  tree: string,
  message: string,
  timestamp: number,
): string {
  const tip = repo.refs.get(branch);
  const parents = tip === undefined ? [] : [tip];
  const commit = buildCommit(tree, parents, message, timestamp);
  repo.refs.set(branch, commit);
  repo.invalidate();
  return commit;
}
