// github-core-clone-01 v2 — a fast, single-process GitHub-compatible git forge.
// Node 22, standard library only. Serves git smart HTTP (upload-pack v2, receive-pack v0),
// REST v3, GraphQL v4 and MCP from one in-memory store. Written fresh from the kit spec.
//
// Speed design: the whole store lives in Maps; packs for a given (repo, wants, depth) are
// built once and cached as Buffers, so the 50 concurrent depth-1 clones share one pack;
// issue reads serve a pre-serialised JSON string; push fast-forwards take the direct-parent
// fast path instead of walking history; hot paths avoid regexes and per-request allocations.

import { createServer, type RawReq as IncomingMessage, type RawRes as ServerResponse } from './rawhttp.ts';
import {
  Store, type Repo, type IssueRec, type PullRec,
  repoJson, issueJson, pullJson, diffFiles, mergeableStatus, squashMerge, subtreeAt,
  globalId, userJson,
} from './store.ts';
import {
  VIEWER_LOGIN, VIEWER_ID, VIEWER_NAME, VIEWER_EMAIL,
  ZERO_OID, FIXED_TIME, COMMIT_EPOCH,
} from './identity.ts';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

// ---------------------------------------------------------------- git core
// The object model, packfile engine and fetch selection live in gitcore.ts.
import {
  sha1hex, hashObject, b64encode, b64decode, isOid, nextReqId,
  pkt, PKT_FLUSH, PKT_DELIM, decodePktLines,
  storeObject, parseCommit, parseTree, compareTreeNames, buildTree, buildCommit,
  flattenTree, setPathInTree, deletePathInTree, collectReachable, isAncestor, peelToCommit,
  writePackObjectHeader, buildPack, inflateAt, applyDelta, readPack,
  commitDistances, selectFetch, sidebandChunks,
} from './gitcore.ts';
import type { Pkt, ObjType, GitObj, CommitInfo, TreeEntry, PackObject, FetchPlan } from './gitcore.ts';
import { objects, commitCache, treeCache, flatCache, TYPE_CODE, CODE_TYPE } from './gitcore.ts';

// ---------------------------------------------------------------- store: repos, issues, pulls
//
// The records, the numbering and the serialisation live in store.ts as a Store class
// and a Repo class. What stays here is the thin set of names the request handlers use,
// so a handler reads the same whether the store is one object or many.

const store = new Store();
const repos = store.repos;

function repoKey(owner: string, name: string): string { return store.key(owner, name); }
function getRepo(owner: string, name: string): Repo | undefined { return store.get(owner, name); }
function createRepoRecord(name: string, description = '', isPrivate = false): Repo {
  return store.create(name, description, isPrivate);
}
function invalidateRepoCache(r: Repo): void { r.invalidate(); }
function defaultBranchTip(r: Repo): string | null { return r.tip; }
function resolveRef(r: Repo, ref: string): string | null { return r.resolve(ref); }
function createIssueRec(r: Repo, title: string, body: string, labels: string[]): IssueRec {
  return store.addIssue(r, title, body, labels);
}
function createPullRec(r: Repo, title: string, body: string, head: string, base: string): PullRec | null {
  return store.addPull(r, title, body, head, base);
}
function refreshIssueJson(r: Repo, i: IssueRec): void { store.refreshIssue(r, i); }
function issueJsonObject(r: Repo, i: IssueRec): Record<string, unknown> { return issueJson(r, i); }
function pullJsonObject(r: Repo, p: PullRec): Record<string, unknown> { return pullJson(r, p); }

// ---------------------------------------------------------------- HTTP plumbing

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  const len = Buffer.byteLength(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': len as unknown as string,
    'X-GitHub-Request-Id': nextReqId(),
    ...extra,
  });
  res.end(data);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function sendBuffer(res: ServerResponse, status: number, data: Buffer, contentType: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': data.length as unknown as string,
    'X-GitHub-Request-Id': nextReqId(),
    ...extra,
  });
  res.end(data);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(buf: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (buf.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(buf.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

function asObject(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

// Auth: no token -> 401; wrong token -> 401; right token -> viewer is adaiversen.
function authOk(req: IncomingMessage): boolean {
  if (TOKEN === '') return true;
  const h = req.headers.authorization ?? '';
  return h === `Bearer ${TOKEN}` || h === `token ${TOKEN}`;
}

// ---------------------------------------------------------------- REST v3

function getQuery(rawUrl: string): URLSearchParams {
  const q = rawUrl.indexOf('?');
  return new URLSearchParams(q >= 0 ? rawUrl.slice(q + 1) : '');
}

function handleRest(req: IncomingMessage, res: ServerResponse, path: string, q: () => URLSearchParams, body: Buffer): void {
  // GET /api/v3/ root
  if (path === '/api/v3/' || path === '/api/v3') {
    sendJson(res, 200, { current_user_url: '/api/v3/user' }, { 'X-OAuth-Scopes': 'repo, user, read:org' });
    return;
  }
  if (path === '/api/v3/meta') {
    sendJson(res, 200, { installed_version: '1.0.0' });
    return;
  }
  if (path === '/api/v3/user') {
    if (req.method === 'GET') { sendJson(res, 200, userJson(VIEWER_LOGIN, VIEWER_ID)); return; }
    sendError(res, 404, 'Not Found');
    return;
  }
  if (path === '/api/v3/user/repos') {
    if (req.method === 'POST') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) { sendError(res, 400, 'Invalid JSON'); return; }
      const b = asObject(parsed.value);
      const name = str(b.name);
      if (!name) { sendError(res, 422, 'Repository name is required'); return; }
      if (getRepo(VIEWER_LOGIN, name)) { sendError(res, 422, 'Repository already exists'); return; }
      const r = createRepoRecord(name, str(b.description), b.private === true);
      sendJson(res, 201, repoJson(r));
      return;
    }
    if (req.method === 'GET') {
      const perPage = Math.max(1, num(parseInt(q().get('per_page') ?? '30', 10), 30) || 30);
      const page = Math.max(1, num(parseInt(q().get('page') ?? '1', 10), 1) || 1);
      const all = [...repos.values()];
      const slice = all.slice((page - 1) * perPage, page * perPage);
      const extra: Record<string, string> = {};
      if (page * perPage < all.length) {
        const host = req.headers.host ?? 'localhost';
        const base = `http://${host}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
        extra.Link = `<${base}>; rel="next"`;
      }
      sendJson(res, 200, slice.map((r) => repoJson(r)), extra);
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  // /api/v3/repos/{owner}/{repo}...
  if (path.startsWith('/api/v3/repos/')) {
    const rest = path.slice('/api/v3/repos/'.length);
    const parts = rest.split('/').map((s) => decodeURIComponent(s));
    const owner = parts[0] as string;
    const repoName = parts[1] as string;
    const sub = parts.slice(2);
    if (owner !== VIEWER_LOGIN) { sendError(res, 404, 'Not Found'); return; }
    const r = getRepo(owner, repoName);
    if (!r) { sendError(res, 404, 'Not Found'); return; }

    if (sub.length === 0) {
      if (req.method === 'GET') { sendJson(res, 200, repoJson(r)); return; }
      if (req.method === 'PATCH') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) { sendError(res, 400, 'Invalid JSON'); return; }
        const b = asObject(parsed.value);
        if (typeof b.description === 'string') r.description = b.description;
        sendJson(res, 200, repoJson(r));
        return;
      }
      if (req.method === 'DELETE') {
        repos.delete(repoKey(owner, repoName));
        res.writeHead(204, { 'X-GitHub-Request-Id': nextReqId() });
        res.end();
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }

    const head = sub[0] as string;

    if (head === 'labels' && sub.length === 1) {
      if (req.method === 'POST') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) { sendError(res, 400, 'Invalid JSON'); return; }
        const b = asObject(parsed.value);
        const name = str(b.name);
        if (!name) { sendError(res, 422, 'Label name is required'); return; }
        const rec = { name, color: str(b.color, 'ededed'), description: str(b.description) };
        r.labels.set(name, rec);
        sendJson(res, 201, { id: globalId('Label', r.id, name), node_id: globalId('Label', r.id, name), name: rec.name, color: rec.color, description: rec.description });
        return;
      }
      if (req.method === 'GET') {
        sendJson(res, 200, [...r.labels.values()].map((l) => ({ name: l.name, color: l.color, description: l.description })));
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }

    if (head === 'branches' && req.method === 'GET') {
      if (sub.length === 1) {
        sendJson(res, 200, [...r.refs.entries()].map(([name, sha]) => ({ name, commit: { sha } })));
        return;
      }
      const branch = sub[1] as string;
      const tip = r.refs.get(branch);
      if (!tip) { sendError(res, 404, 'Not Found'); return; }
      sendJson(res, 200, { name: branch, commit: { sha: tip } });
      return;
    }

    if (head === 'git' && sub[1] === 'refs' && req.method === 'POST') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) { sendError(res, 400, 'Invalid JSON'); return; }
      const b = asObject(parsed.value);
      const ref = str(b.ref);
      const sha = str(b.sha);
      const m = /^refs\/heads\/(.+)$/.exec(ref);
      if (!m || !isOid(sha) || !objects.has(sha)) { sendError(res, 422, 'Invalid ref'); return; }
      const branch = m[1] as string;
      r.refs.set(branch, sha);
      invalidateRepoCache(r);
      sendJson(res, 201, { ref, object: { sha } });
      return;
    }

    if (head === 'git' && sub[1] === 'refs' && sub.length >= 3 && req.method === 'GET') {
      // GET /git/refs/heads/{branch}
      const refPath = sub.slice(2).join('/');
      const m = /^heads\/(.+)$/.exec(refPath);
      if (m) {
        const tip = r.refs.get(m[1] as string);
        if (!tip) { sendError(res, 404, 'Not Found'); return; }
        sendJson(res, 200, { ref: `refs/heads/${m[1] as string}`, object: { sha: tip } });
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }

    if (head === 'commits' && req.method === 'GET') {
      const shaParam = q().get('sha');
      const start = shaParam ? resolveRef(r, shaParam) : defaultBranchTip(r);
      if (!start) { sendJson(res, 200, []); return; }
      const out: Record<string, unknown>[] = [];
      const seen = new Set<string>();
      const queue = [start];
      while (queue.length) {
        const oid = queue.pop() as string;
        if (seen.has(oid)) continue;
        seen.add(oid);
        const c = parseCommit(oid);
        if (!c) continue;
        out.push({ sha: oid, commit: { message: c.message.replace(/\n+$/, '') } });
        for (const p of c.parents) queue.push(p);
      }
      sendJson(res, 200, out);
      return;
    }

    if (head === 'contents') {
      const contentPath = sub.slice(1).join('/');
      if (req.method === 'GET') {
        const refParam = q().get('ref');
        const commitOid = refParam ? resolveRef(r, refParam) : defaultBranchTip(r);
        if (!commitOid) { sendError(res, 404, 'Not Found'); return; }
        const c = parseCommit(commitOid);
        if (!c) { sendError(res, 404, 'Not Found'); return; }
        const flat = flattenTree(c.tree);
        if (contentPath === '') {
          const entries = parseTree(c.tree) ?? [];
          sendJson(res, 200, entries.map((e) => ({ type: e.mode === '40000' ? 'dir' : 'file', name: e.name, path: e.name, sha: e.oid, size: e.mode === '40000' ? 0 : (objects.get(e.oid)?.data.length ?? 0) })));
          return;
        }
        const file = flat.get(contentPath);
        if (file) {
          const data = objects.get(file.oid)?.data ?? Buffer.alloc(0);
          sendJson(res, 200, { type: 'file', encoding: 'base64', content: data.toString('base64'), sha: file.oid, size: data.length, name: contentPath.split('/').pop(), path: contentPath });
          return;
        }
        // directory listing at a subpath
        const prefix = `${contentPath}/`;
        const children = new Map<string, { type: string; sha: string; size: number }>();
        for (const [p, info] of flat) {
          if (!p.startsWith(prefix)) continue;
          const restPath = p.slice(prefix.length);
          const first = restPath.split('/')[0] as string;
          if (restPath.includes('/')) {
            if (!children.has(first)) {
              // tree sha for the directory
              let dirTree = c.tree;
              for (const seg of `${contentPath}/${first}`.split('/')) {
                const entries = parseTree(dirTree) ?? [];
                const found = entries.find((e) => e.name === seg);
                dirTree = found ? found.oid : dirTree;
              }
              children.set(first, { type: 'dir', sha: dirTree, size: 0 });
            }
          } else {
            children.set(first, { type: 'file', sha: info.oid, size: objects.get(info.oid)?.data.length ?? 0 });
          }
        }
        if (children.size) {
          sendJson(res, 200, [...children.entries()].map(([name, info]) => ({ type: info.type, name, path: `${contentPath}/${name}`, sha: info.sha, size: info.size })));
          return;
        }
        sendError(res, 404, 'Not Found');
        return;
      }
      if (req.method === 'PUT' || req.method === 'DELETE') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) { sendError(res, 400, 'Invalid JSON'); return; }
        const b = asObject(parsed.value);
        const branch = str(b.branch, r.headRef);
        const tip = r.refs.get(branch);
        let tree = tip ? (parseCommit(tip)?.tree ?? null) : null;
        const parents: string[] = tip ? [tip] : [];
        if (req.method === 'PUT') {
          // A supplied sha must match the file's current blob sha, else 409.
          if (typeof b.sha === 'string' && tree) {
            const current = flattenTree(tree).get(contentPath);
            if (current && b.sha !== current.oid) { sendError(res, 409, 'sha does not match the current file'); return; }
          }
          const content = str(b.content);
          const decoded = b64decode(content);
          const blobOid = storeObject('blob', decoded);
          tree = setPathInTree(tree, contentPath.split('/'), blobOid);
        } else {
          if (!tree || !flattenTree(tree).has(contentPath)) { sendError(res, 404, 'Not Found'); return; }
          tree = deletePathInTree(tree, contentPath.split('/'));
        }
        if (tree === null) { sendError(res, 404, 'Not Found'); return; }
        const message = str(b.message, req.method === 'PUT' ? 'update' : 'delete');
        const commitOid = buildCommit(tree, parents, message, store.commitTime());
        r.refs.set(branch, commitOid);
        invalidateRepoCache(r);
        if (req.method === 'PUT') {
          const blobOid = flattenTree(tree).get(contentPath)?.oid ?? '';
          const isCreate = !tip || !(tip && flattenTree(parseCommit(tip)?.tree ?? '').has(contentPath));
          sendJson(res, isCreate ? 201 : 200, { content: { sha: blobOid, encoding: 'base64' }, commit: { sha: commitOid } });
        } else {
          sendJson(res, 200, { commit: { sha: commitOid } });
        }
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }

    if (head === 'issues') {
      if (sub.length === 1) {
        if (req.method === 'POST') {
          const parsed = parseJsonBody(body);
          if (!parsed.ok) { sendError(res, 400, 'Invalid JSON'); return; }
          const b = asObject(parsed.value);
          const labelsRaw = Array.isArray(b.labels) ? b.labels : [];
          const labels: string[] = [];
          for (const l of labelsRaw) if (typeof l === 'string') labels.push(l);
          for (const l of labels) if (!r.labels.has(l)) { sendError(res, 422, 'Unknown label'); return; }
          const issue = createIssueRec(r, str(b.title), str(b.body), labels);
          // createIssueRec already serialised the issue; reuse that string
          // instead of building + stringifying the object a second time.
          sendJson(res, 201, r.issueJson.get(issue.number) as string);
          return;
        }
        if (req.method === 'GET') {
          const state = q().get('state') ?? 'open';
          const sort = q().get('sort') ?? 'created';
          const dir = q().get('direction') ?? 'desc';
          let list = [...r.issues.values()];
          if (state !== 'all') list = list.filter((i) => i.state === state);
          if (sort === 'created') list.sort((a, b) => dir === 'asc' ? a.number - b.number : b.number - a.number);
          sendJson(res, 200, list.map((i) => issueJsonObject(r, i)));
          return;
        }
        sendError(res, 404, 'Not Found');
        return;
      }
      const number = parseInt(sub[1] as string, 10);
      const issue = r.issues.get(number);
      if (!issue) { sendError(res, 404, 'Not Found'); return; }
      if (sub.length === 2) {
        if (req.method === 'GET') {
          const cached = r.issueJson.get(number);
          if (cached) { sendJson(res, 200, cached); return; }
          sendJson(res, 200, issueJsonObject(r, issue));
          return;
        }
        if (req.method === 'PATCH') {
          const parsed = parseJsonBody(body);
          if (!parsed.ok) { sendError(res, 400, 'Invalid JSON'); return; }
          const b = asObject(parsed.value);
          if (typeof b.title === 'string') issue.title = b.title;
          if (typeof b.body === 'string') issue.body = b.body;
          if (typeof b.state === 'string' && (b.state === 'open' || b.state === 'closed')) issue.state = b.state;
          refreshIssueJson(r, issue);
          sendJson(res, 200, r.issueJson.get(number) as string);
          return;
        }
        sendError(res, 404, 'Not Found');
        return;
      }
      if (sub[2] === 'comments') {
        if (req.method === 'POST') {
          const parsed = parseJsonBody(body);
          if (!parsed.ok) { sendError(res, 400, 'Invalid JSON'); return; }
          const b = asObject(parsed.value);
          const id = store.commentId();
          issue.comments.push({ id, body: str(b.body) });
          refreshIssueJson(r, issue);
          sendJson(res, 201, { id, body: str(b.body) });
          return;
        }
        if (req.method === 'GET') {
          sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, body: c.body })));
          return;
        }
        sendError(res, 404, 'Not Found');
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }

    if (head === 'pulls') {
      if (sub.length === 1) {
        if (req.method === 'POST') {
          const parsed = parseJsonBody(body);
          if (!parsed.ok) { sendError(res, 400, 'Invalid JSON'); return; }
          const b = asObject(parsed.value);
          const title = str(b.title);
          const headRef = str(b.head);
          const baseRef = str(b.base, r.headRef);
          if (!title || !headRef || !r.refs.has(headRef) || !r.refs.has(baseRef)) { sendError(res, 422, 'Invalid pull request'); return; }
          for (const p of r.pulls.values()) {
            if (p.state === 'open' && p.headRef === headRef && p.baseRef === baseRef) { sendError(res, 422, 'A pull request already exists'); return; }
          }
          const p = createPullRec(r, title, str(b.body), headRef, baseRef);
          if (!p) { sendError(res, 422, 'Invalid pull request'); return; }
          sendJson(res, 201, pullJsonObject(r, p));
          return;
        }
        if (req.method === 'GET') {
          const state = q().get('state') ?? 'open';
          let list = [...r.pulls.values()];
          if (state !== 'all') {
            const want = state === 'closed' ? ['closed', 'merged'] : ['open'];
            list = list.filter((p) => want.includes(p.state));
          }
          sendJson(res, 200, list.map((p) => pullJsonObject(r, p)));
          return;
        }
        sendError(res, 404, 'Not Found');
        return;
      }
      const number = parseInt(sub[1] as string, 10);
      const p = r.pulls.get(number);
      if (!p) { sendError(res, 404, 'Not Found'); return; }
      if (sub.length === 2) {
        if (req.method === 'GET') { sendJson(res, 200, pullJsonObject(r, p)); return; }
        sendError(res, 404, 'Not Found');
        return;
      }
      if (sub[2] === 'files' && req.method === 'GET') {
        const headCommit = parseCommit(p.headSha);
        const baseCommit = parseCommit(p.baseSha);
        if (!headCommit || !baseCommit) { sendJson(res, 200, []); return; }
        const diffs = diffFiles(baseCommit.tree, headCommit.tree);
        sendJson(res, 200, diffs.map((d) => ({ filename: d.filename, status: d.status === 'removed' ? 'removed' : d.status, additions: d.additions, deletions: d.deletions, changes: d.changes })));
        return;
      }
      if (sub[2] === 'merge' && req.method === 'PUT') {
        if (p.state !== 'open') { sendError(res, 405, 'Pull request is not open'); return; }
        const status = mergeableStatus(r, p);
        if (status === 'CONFLICTING') { sendError(res, 405, 'Merge conflict'); return; }
        const merged = squashMerge(store, r, p);
        if (!merged) { sendError(res, 405, 'Cannot merge'); return; }
        p.state = 'merged';
        p.merged = true;
        p.mergedAt = FIXED_TIME;
        p.mergeCommitSha = merged.sha;
        sendJson(res, 200, { sha: merged.sha, merged: true, message: 'Pull request successfully merged' });
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }

    sendError(res, 404, 'Not Found');
    return;
  }

  sendError(res, 404, 'Not Found');
}

// ---------------------------------------------------------------- GraphQL

type GqlValue = string | number | boolean | null | GqlValue[] | { [k: string]: GqlValue } | { __enum: string } | { __var: string };

interface GqlField {
  name: string;
  alias: string | null;
  args: Record<string, GqlValue>;
  selections: GqlSelection[] | null;
  fragmentType: string | null;
  isFragment: boolean;
}
type GqlSelection = GqlField;

interface Token { kind: string; value: string }

function tokenizeGql(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i] as string;
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === ',') { i++; continue; }
    if (ch === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (ch === '.' && src.slice(i, i + 3) === '...') { tokens.push({ kind: '...', value: '...' }); i += 3; continue; }
    if ('{}()[]:!=$'.includes(ch)) { tokens.push({ kind: ch, value: ch }); i++; continue; }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) { const esc = src[j + 1] as string; out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc; j += 2; }
        else { out += src[j] as string; j++; }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j] as string)) j++;
      tokens.push({ kind: 'number', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j] as string)) j++;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    i++;
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

class GqlParser {
  tokens: Token[];
  pos = 0;
  constructor(src: string) { this.tokens = tokenizeGql(src); }
  peek(): Token { return this.tokens[this.pos] as Token; }
  next(): Token { return this.tokens[this.pos++] as Token; }
  expect(kind: string): Token {
    const t = this.next();
    if (t.kind !== kind) throw new Error(`expected ${kind}, got ${t.kind}`);
    return t;
  }
  parseDocument(): { operation: string; variables: Record<string, GqlValue>; selections: GqlSelection[] }[] {
    const ops: { operation: string; variables: Record<string, GqlValue>; selections: GqlSelection[] }[] = [];
    while (this.peek().kind !== 'eof') {
      let op = 'query';
      if (this.peek().kind === 'name' && ['query', 'mutation', 'subscription'].includes(this.peek().value)) {
        op = this.next().value;
      }
      if (this.peek().kind === 'name') this.next(); // operation name
      const variables: Record<string, GqlValue> = {};
      if (this.peek().kind === '(') {
        this.next();
        let depth = 1;
        while (depth > 0) {
          const t = this.next();
          if (t.kind === '(' || t.kind === '[' || t.kind === '{') depth++;
          else if (t.kind === ')' || t.kind === ']' || t.kind === '}') depth--;
        }
      }
      const selections = this.parseSelectionSet();
      ops.push({ operation: op, variables, selections });
    }
    return ops;
  }
  parseSelectionSet(): GqlSelection[] {
    this.expect('{');
    const sels: GqlSelection[] = [];
    while (this.peek().kind !== '}') {
      if (this.peek().kind === 'eof') break;
      sels.push(this.parseField());
    }
    this.expect('}');
    return sels;
  }
  parseField(): GqlField {
    if (this.peek().kind === '...') {
      this.next();
      let fragmentType: string | null = null;
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        fragmentType = this.next().value;
      } else if (this.peek().kind === 'name') {
        this.next(); // named fragment reference (not used in suite docs)
      }
      const selections = this.parseSelectionSet();
      return { name: '', alias: null, args: {}, selections, fragmentType, isFragment: true };
    }
    const first = this.expect('name').value;
    let alias: string | null = null;
    let name = first;
    if (this.peek().kind === ':') {
      this.next();
      alias = first;
      name = this.expect('name').value;
    }
    const args: Record<string, GqlValue> = {};
    if (this.peek().kind === '(') {
      this.next();
      while (this.peek().kind !== ')') {
        const argName = this.expect('name').value;
        this.expect(':');
        args[argName] = this.parseValue();
        if (this.peek().kind === ',') this.next();
      }
      this.next();
    }
    let selections: GqlSelection[] | null = null;
    if (this.peek().kind === '{') selections = this.parseSelectionSet();
    return { name, alias, args, selections, fragmentType: null, isFragment: false };
  }
  parseValue(): GqlValue {
    const t = this.next();
    if (t.kind === '$') return { __var: this.next().value };
    if (t.kind === 'string') return t.value;
    if (t.kind === 'number') return Number(t.value);
    if (t.kind === 'name') {
      if (t.value === 'true') return true;
      if (t.value === 'false') return false;
      if (t.value === 'null') return null;
      return { __enum: t.value };
    }
    if (t.kind === '[') {
      const arr: GqlValue[] = [];
      while (this.peek().kind !== ']') { arr.push(this.parseValue()); if (this.peek().kind === ',') this.next(); }
      this.next();
      return arr;
    }
    if (t.kind === '{') {
      const obj: { [k: string]: GqlValue } = {};
      while (this.peek().kind !== '}') {
        const k = this.expect('name').value;
        this.expect(':');
        obj[k] = this.parseValue();
        if (this.peek().kind === ',') this.next();
      }
      this.next();
      return obj;
    }
    return null;
  }
}

function resolveGqlValue(v: GqlValue, variables: Record<string, GqlValue>): unknown {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    if ('__var' in v) return resolveGqlValue(variables[(v as { __var: string }).__var] ?? null, variables);
    if ('__enum' in v) return (v as { __enum: string }).__enum;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, GqlValue>)) out[k] = resolveGqlValue(val, variables);
    return out;
  }
  if (Array.isArray(v)) return v.map((x) => resolveGqlValue(x, variables));
  return v;
}

type GqlObj = { __type: string; [k: string]: unknown };

const GQL_FIELDS: Record<string, Set<string>> = {
  Query: new Set(['viewer', 'repository', 'node', '__type', '__schema']),
  Mutation: new Set(['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment']),
  User: new Set(['login', 'id', 'name', 'email', 'avatarUrl']),
  Repository: new Set(['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'url', 'createdAt']),
  Ref: new Set(['name']),
  Issue: new Set(['id', 'number', 'title', 'state', 'body', 'url', 'createdAt']),
  IssueConnection: new Set(['nodes', 'pageInfo', 'totalCount']),
  PullRequest: new Set(['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'url', 'createdAt']),
  PullRequestConnection: new Set(['nodes', 'pageInfo', 'totalCount']),
  FileConnection: new Set(['nodes', 'totalCount']),
  File: new Set(['path']),
  PageInfo: new Set(['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor']),
  __Type: new Set(['name', 'fields', 'enumValues', 'kind', 'description']),
  __Field: new Set(['name', 'description']),
  __EnumValue: new Set(['name', 'description']),
  CreateIssuePayload: new Set(['issue', 'clientMutationId']),
  CloseIssuePayload: new Set(['issue', 'clientMutationId']),
  CreatePullRequestPayload: new Set(['pullRequest', 'clientMutationId']),
  MergePullRequestPayload: new Set(['pullRequest', 'clientMutationId']),
  AddCommentPayload: new Set(['commentEdge', 'clientMutationId']),
  CommentEdge: new Set(['node', 'cursor']),
  Comment: new Set(['id', 'body']),
};

const GQL_TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  User: ['login', 'id', 'name'],
  SearchType: [],
};
const GQL_TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER'],
};

function findRepoByDbId(dbid: number): RepoRec | undefined {
  for (const r of repos.values()) if (r.id === dbid) return r;
  return undefined;
}

function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = decoded.split(':');
    if (!kind) return null;
    return { kind, parts };
  } catch { return null; }
}

function issueWrapper(r: RepoRec, i: IssueRec): GqlObj {
  return { __type: 'Issue', repo: r, issue: i };
}
function pullWrapper(r: RepoRec, p: PullRec): GqlObj {
  return { __type: 'PullRequest', repo: r, pull: p };
}
function repoWrapper(r: RepoRec): GqlObj {
  return { __type: 'Repository', repo: r };
}
function pageInfoObj(hasNext: boolean, endCursor: string | null, startCursor: string | null): GqlObj {
  return { __type: 'PageInfo', hasNextPage: hasNext, hasPreviousPage: false, startCursor, endCursor };
}
function cursorFor(n: number): string {
  return b64encode(`cursor:${n}`);
}
function cursorNum(c: string): number | null {
  try {
    const d = Buffer.from(c, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(d);
    return m ? parseInt(m[1] as string, 10) : null;
  } catch { return null; }
}

function gqlResolve(obj: GqlObj, field: string, args: Record<string, unknown>, errors: { message: string }[]): unknown {
  const type = obj.__type;
  switch (type) {
    case 'Query': {
      if (field === 'viewer') return { __type: 'User', login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME };
      if (field === 'repository') {
        const owner = args.owner as string;
        const name = args.name as string;
        if (owner !== VIEWER_LOGIN) return null;
        const r = getRepo(owner, name);
        return r ? repoWrapper(r) : null;
      }
      if (field === 'node') {
        const dec = decodeGlobalId(args.id as string);
        if (!dec) return null;
        if (dec.kind === 'Repository') {
          const r = findRepoByDbId(parseInt(dec.parts[0] as string, 10));
          return r ? repoWrapper(r) : null;
        }
        if (dec.kind === 'Issue') {
          const r = findRepoByDbId(parseInt(dec.parts[0] as string, 10));
          const i = r?.issues.get(parseInt(dec.parts[1] as string, 10));
          return r && i ? issueWrapper(r, i) : null;
        }
        if (dec.kind === 'PullRequest') {
          const r = findRepoByDbId(parseInt(dec.parts[0] as string, 10));
          const p = r?.pulls.get(parseInt(dec.parts[1] as string, 10));
          return r && p ? pullWrapper(r, p) : null;
        }
        return null;
      }
      if (field === '__type') {
        const name = args.name as string;
        if (GQL_TYPE_FIELDS[name]) return { __type: '__Type', name, fields: GQL_TYPE_FIELDS[name], enumValues: GQL_TYPE_ENUMS[name] ?? [] };
        return null;
      }
      if (field === '__schema') return null;
      return null;
    }
    case 'Mutation': {
      if (field === 'createIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const dec = decodeGlobalId(input.repositoryId as string);
        const r = dec ? findRepoByDbId(parseInt(dec.parts[0] as string, 10)) : undefined;
        if (!r) return { __type: 'CreateIssuePayload', issue: null };
        const issue = createIssueRec(r, (input.title as string) ?? '', (input.body as string) ?? '', []);
        return { __type: 'CreateIssuePayload', issue: issueWrapper(r, issue) };
      }
      if (field === 'closeIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const dec = decodeGlobalId(input.issueId as string);
        let wrapper: GqlObj | null = null;
        if (dec) {
          const r = findRepoByDbId(parseInt(dec.parts[0] as string, 10));
          const i = r?.issues.get(parseInt(dec.parts[1] as string, 10));
          if (r && i) { i.state = 'closed'; refreshIssueJson(r, i); wrapper = issueWrapper(r, i); }
        }
        return { __type: 'CloseIssuePayload', issue: wrapper };
      }
      if (field === 'createPullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const dec = decodeGlobalId(input.repositoryId as string);
        const r = dec ? findRepoByDbId(parseInt(dec.parts[0] as string, 10)) : undefined;
        if (!r) return { __type: 'CreatePullRequestPayload', pullRequest: null };
        const p = createPullRec(r, (input.title as string) ?? '', (input.body as string) ?? '', (input.headRefName as string) ?? '', (input.baseRefName as string) ?? 'main');
        return { __type: 'CreatePullRequestPayload', pullRequest: p ? pullWrapper(r, p) : null };
      }
      if (field === 'mergePullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const dec = decodeGlobalId(input.pullRequestId as string);
        let wrapper: GqlObj | null = null;
        if (dec) {
          const r = findRepoByDbId(parseInt(dec.parts[0] as string, 10));
          const p = r?.pulls.get(parseInt(dec.parts[1] as string, 10));
          if (r && p && p.state === 'open') {
            const merged = squashMerge(store, r, p);
            if (merged) { p.state = 'merged'; p.merged = true; p.mergedAt = FIXED_TIME; p.mergeCommitSha = merged.sha; wrapper = pullWrapper(r, p); }
          }
        }
        return { __type: 'MergePullRequestPayload', pullRequest: wrapper };
      }
      if (field === 'addComment') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const dec = decodeGlobalId(input.subjectId as string);
        let node: GqlObj | null = null;
        if (dec && dec.kind === 'Issue') {
          const r = findRepoByDbId(parseInt(dec.parts[0] as string, 10));
          const i = r?.issues.get(parseInt(dec.parts[1] as string, 10));
          if (r && i) {
            const id = store.commentId();
            i.comments.push({ id, body: (input.body as string) ?? '' });
            refreshIssueJson(r, i);
            node = { __type: 'Comment', id, body: (input.body as string) ?? '' };
          }
        }
        return { __type: 'AddCommentPayload', commentEdge: node ? { __type: 'CommentEdge', node } : null };
      }
      return null;
    }
    case 'User': {
      if (field === 'login') return obj.login;
      if (field === 'id') return globalId('User', obj.id as number);
      if (field === 'name') return obj.name ?? obj.login;
      if (field === 'email') return VIEWER_EMAIL;
      if (field === 'avatarUrl') return '';
      return null;
    }
    case 'Repository': {
      const r = obj.repo as RepoRec;
      if (field === 'id') return globalId('Repository', r.id);
      if (field === 'databaseId') return r.id;
      if (field === 'name') return r.name;
      if (field === 'nameWithOwner') return `${r.owner}/${r.name}`;
      if (field === 'owner') return { __type: 'User', login: r.owner, id: VIEWER_ID, name: VIEWER_NAME };
      if (field === 'defaultBranchRef') {
        const tip = defaultBranchTip(r);
        return tip ? { __type: 'Ref', name: r.headRef } : null;
      }
      if (field === 'viewerPermission') return 'ADMIN';
      if (field === 'hasIssuesEnabled') return true;
      if (field === 'description') return r.description;
      if (field === 'url') return `https://github.example/${r.owner}/${r.name}`;
      if (field === 'createdAt') return r.createdAt;
      if (field === 'issue') {
        const i = r.issues.get(num(args.number));
        return i ? issueWrapper(r, i) : null;
      }
      if (field === 'issues') {
        let list = [...r.issues.values()];
        if (Array.isArray(args.states)) {
          const want = (args.states as string[]).map((s) => s.toLowerCase());
          list = list.filter((i) => want.includes(i.state));
        }
        const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
        const desc = orderBy.direction === 'DESC';
        list.sort((a, b) => desc ? b.number - a.number : a.number - b.number);
        const after = typeof args.after === 'string' ? cursorNum(args.after) : null;
        if (after !== null) list = list.filter((i) => desc ? i.number < after : i.number > after);
        const first = typeof args.first === 'number' ? args.first : list.length;
        const page = list.slice(0, first);
        const hasNext = list.length > page.length;
        const endCursor = page.length ? cursorFor(page[page.length - 1]?.number as number) : null;
        const startCursor = page.length ? cursorFor(page[0]?.number as number) : null;
        return { __type: 'IssueConnection', nodes: page.map((i) => issueWrapper(r, i)), pageInfo: pageInfoObj(hasNext, endCursor, startCursor), totalCount: list.length };
      }
      if (field === 'pullRequest') {
        const p = r.pulls.get(num(args.number));
        return p ? pullWrapper(r, p) : null;
      }
      if (field === 'pullRequests') {
        const list = [...r.pulls.values()].sort((a, b) => a.number - b.number);
        const first = typeof args.first === 'number' ? args.first : list.length;
        const page = list.slice(0, first);
        const hasNext = list.length > page.length;
        const endCursor = page.length ? cursorFor(page[page.length - 1]?.number as number) : null;
        const startCursor = page.length ? cursorFor(page[0]?.number as number) : null;
        return { __type: 'PullRequestConnection', nodes: page.map((p) => pullWrapper(r, p)), pageInfo: pageInfoObj(hasNext, endCursor, startCursor), totalCount: list.length };
      }
      return null;
    }
    case 'Ref': return field === 'name' ? obj.name : null;
    case 'Issue': {
      const i = obj.issue as IssueRec;
      const r = obj.repo as RepoRec;
      if (field === 'id') return globalId('Issue', r.id, i.number);
      if (field === 'number') return i.number;
      if (field === 'title') return i.title;
      if (field === 'state') return i.state.toUpperCase();
      if (field === 'body') return i.body;
      if (field === 'url') return `https://github.example/${r.owner}/${r.name}/issues/${i.number}`;
      if (field === 'createdAt') return FIXED_TIME;
      return null;
    }
    case 'IssueConnection': {
      if (field === 'nodes') return obj.nodes;
      if (field === 'pageInfo') return obj.pageInfo;
      if (field === 'totalCount') return obj.totalCount;
      return null;
    }
    case 'PullRequest': {
      const p = obj.pull as PullRec;
      const r = obj.repo as RepoRec;
      if (field === 'id') return globalId('PullRequest', r.id, p.number);
      if (field === 'number') return p.number;
      if (field === 'title') return p.title;
      if (field === 'body') return p.body;
      if (field === 'state') return p.merged ? 'MERGED' : p.state.toUpperCase();
      if (field === 'merged') return p.merged;
      if (field === 'mergeable') return mergeableStatus(r, p);
      if (field === 'headRefName') return p.headRef;
      if (field === 'baseRefName') return p.baseRef;
      if (field === 'headRef') return { __type: 'Ref', name: p.headRef };
      if (field === 'baseRef') return { __type: 'Ref', name: p.baseRef };
      if (field === 'url') return `https://github.example/${r.owner}/${r.name}/pull/${p.number}`;
      if (field === 'createdAt') return FIXED_TIME;
      if (field === 'files') {
        const headCommit = parseCommit(p.headSha);
        const baseCommit = parseCommit(p.baseSha);
        const diffs = headCommit && baseCommit ? diffFiles(baseCommit.tree, headCommit.tree) : [];
        const first = typeof args.first === 'number' ? args.first : diffs.length;
        const page = diffs.slice(0, first);
        return { __type: 'FileConnection', nodes: page.map((d) => ({ __type: 'File', path: d.filename })), totalCount: diffs.length };
      }
      return null;
    }
    case 'PullRequestConnection': {
      if (field === 'nodes') return obj.nodes;
      if (field === 'pageInfo') return obj.pageInfo;
      if (field === 'totalCount') return obj.totalCount;
      return null;
    }
    case 'FileConnection': {
      if (field === 'nodes') return obj.nodes;
      if (field === 'totalCount') return obj.totalCount;
      return null;
    }
    case 'File': return field === 'path' ? obj.path : null;
    case 'PageInfo': {
      if (field === 'hasNextPage') return obj.hasNextPage;
      if (field === 'hasPreviousPage') return obj.hasPreviousPage;
      if (field === 'startCursor') return obj.startCursor;
      if (field === 'endCursor') return obj.endCursor;
      return null;
    }
    case '__Type': {
      if (field === 'name') return obj.name;
      if (field === 'kind') return 'OBJECT';
      if (field === 'description') return null;
      if (field === 'fields') return (obj.fields as string[]).map((n) => ({ __type: '__Field', name: n, description: null }));
      if (field === 'enumValues') return (obj.enumValues as string[]).map((n) => ({ __type: '__EnumValue', name: n, description: null }));
      return null;
    }
    case '__Field': return field === 'name' ? obj.name : null;
    case '__EnumValue': return field === 'name' ? obj.name : null;
    case 'CreateIssuePayload': return field === 'issue' ? obj.issue : null;
    case 'CloseIssuePayload': return field === 'issue' ? obj.issue : null;
    case 'CreatePullRequestPayload': return field === 'pullRequest' ? obj.pullRequest : null;
    case 'MergePullRequestPayload': return field === 'pullRequest' ? obj.pullRequest : null;
    case 'AddCommentPayload': return field === 'commentEdge' ? obj.commentEdge : null;
    case 'CommentEdge': return field === 'node' ? obj.node : null;
    case 'Comment': {
      if (field === 'id') return globalId('Comment', obj.id as number);
      if (field === 'body') return obj.body;
      return null;
    }
    default:
      errors.push({ message: `Unknown type ${type}` });
      return null;
  }
}

function gqlExecuteSelections(obj: GqlObj, selections: GqlSelection[], variables: Record<string, GqlValue>, errors: { message: string }[]): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.isFragment) {
      if (sel.fragmentType && sel.fragmentType !== obj.__type) continue;
      const sub = gqlExecuteSelections(obj, sel.selections ?? [], variables, errors);
      Object.assign(data, sub);
      continue;
    }
    const key = sel.alias ?? sel.name;
    const allowed = GQL_FIELDS[obj.__type];
    if (!allowed || !allowed.has(sel.name)) {
      errors.push({ message: `Cannot query field "${sel.name}" on type "${obj.__type}".` });
      data[key] = null;
      continue;
    }
    const resolvedArgs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(sel.args)) resolvedArgs[k] = resolveGqlValue(v, variables);
    const value = gqlResolve(obj, sel.name, resolvedArgs, errors);
    data[key] = gqlCoerceValue(value, sel.selections, variables, errors);
  }
  return data;
}

function gqlCoerceValue(value: unknown, selections: GqlSelection[] | null, variables: Record<string, GqlValue>, errors: { message: string }[]): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((v) => gqlCoerceValue(v, selections, variables, errors));
  if (typeof value === 'object' && '__type' in (value as Record<string, unknown>)) {
    if (!selections) return value;
    return gqlExecuteSelections(value as GqlObj, selections, variables, errors);
  }
  return value;
}

function handleGraphql(body: Buffer): unknown {
  const parsed = parseJsonBody(body);
  if (!parsed.ok) return { errors: [{ message: 'Invalid JSON' }] };
  const runOne = (doc: unknown): { data?: unknown; errors?: { message: string }[] } => {
    const d = asObject(doc);
    const query = str(d.query);
    const variables = asObject(d.variables) as Record<string, GqlValue>;
    let ops;
    try {
      ops = new GqlParser(query).parseDocument();
    } catch (e) {
      return { errors: [{ message: `Syntax Error: ${(e as Error).message}` }] };
    }
    const op = ops[0];
    if (!op) return { errors: [{ message: 'Empty document' }] };
    const errors: { message: string }[] = [];
    const root: GqlObj = { __type: op.operation === 'mutation' ? 'Mutation' : 'Query' };
    const data = gqlExecuteSelections(root, op.selections, variables, errors);
    return errors.length ? { data, errors } : { data };
  };
  if (Array.isArray(parsed.value)) {
    return parsed.value.map((doc) => runOne(doc));
  }
  return runOne(parsed.value);
}

// ---------------------------------------------------------------- MCP

const MCP_TOOLS: Record<string, unknown>[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, private: { type: 'boolean' } }, required: ['name'] },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number' } }, required: ['owner', 'repo', 'pull_number'] },
  },
];
const MCP_TOOLS_JSON = JSON.stringify(MCP_TOOLS);
const MCP_SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };

function mcpResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}
function mcpError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function mcpToolText(obj: unknown): { content: { type: string; text: string }[]; structuredContent: unknown } {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }], structuredContent: obj };
}

function handleMcp(body: Buffer): { status: number; payload: unknown } {
  const parsed = parseJsonBody(body);
  if (!parsed.ok) {
    const text = body.toString('utf8');
    const m = /"id"\s*:\s*("[^"]*"|\d+)/.exec(text);
    let id: unknown = null;
    if (m) { const raw = m[1] as string; id = raw.startsWith('"') ? raw.slice(1, -1) : Number(raw); }
    return { status: 400, payload: { jsonrpc: '2.0', id, error: { code: -32700, message: 'Parse error' } } };
  }
  const msg = asObject(parsed.value);
  const method = str(msg.method);
  const id = msg.id ?? null;
  const params = asObject(msg.params);

  if (method === 'server/discover') {
    return { status: 200, payload: mcpResult(id, { supportedVersions: ['2026-07-28', '2025-11-25'], capabilities: { tools: {} }, serverInfo: MCP_SERVER_INFO, protocolVersion: '2026-07-28' }) };
  }
  if (method === 'initialize') {
    const requested = str(params.protocolVersion, '2026-07-28');
    return { status: 200, payload: mcpResult(id, { protocolVersion: requested, capabilities: { tools: {} }, serverInfo: MCP_SERVER_INFO }) };
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 202, payload: null };
  }
  if (method === 'tools/list') {
    return { status: 200, payload: mcpResult(id, { tools: JSON.parse(MCP_TOOLS_JSON) }) };
  }
  if (method === 'tools/call') {
    const name = str(params.name);
    const args = asObject(params.arguments);
    const tool = MCP_TOOLS.find((t) => (t.name as string).toLowerCase() === name.toLowerCase());
    if (!tool) return { status: 200, payload: mcpError(id, -32601, `Unknown tool: ${name}`) };
    const required = ((tool.inputSchema as Record<string, unknown>).required ?? []) as string[];
    for (const reqField of required) {
      if (args[reqField] === undefined || args[reqField] === null || args[reqField] === '') {
        return { status: 200, payload: mcpResult(id, { content: [{ type: 'text', text: `Missing required argument: ${reqField}` }], isError: true }) };
      }
    }
    try {
      if (name === 'create_repo') {
        const repoName = str(args.name);
        if (getRepo(VIEWER_LOGIN, repoName)) return { status: 200, payload: mcpResult(id, mcpToolText({ error: 'Repository already exists' })) };
        const r = createRepoRecord(repoName, str(args.description), args.private === true);
        return { status: 200, payload: mcpResult(id, mcpToolText(repoJson(r))) };
      }
      if (name === 'get_repo') {
        const r = getRepo(str(args.owner), str(args.repo));
        if (!r) return { status: 200, payload: mcpResult(id, { content: [{ type: 'text', text: 'Not Found' }], isError: true }) };
        return { status: 200, payload: mcpResult(id, mcpToolText(repoJson(r))) };
      }
      if (name === 'create_issue') {
        const r = getRepo(str(args.owner), str(args.repo));
        if (!r) return { status: 200, payload: mcpResult(id, { content: [{ type: 'text', text: 'Not Found' }], isError: true }) };
        const issue = createIssueRec(r, str(args.title), str(args.body), []);
        return { status: 200, payload: mcpResult(id, mcpToolText(issueJsonObject(r, issue))) };
      }
      if (name === 'list_issues') {
        const r = getRepo(str(args.owner), str(args.repo));
        if (!r) return { status: 200, payload: mcpResult(id, { content: [{ type: 'text', text: 'Not Found' }], isError: true }) };
        const state = str(args.state, 'open');
        let list = [...r.issues.values()];
        if (state !== 'all') list = list.filter((i) => i.state === state);
        const arr = list.map((i) => issueJsonObject(r, i));
        return { status: 200, payload: mcpResult(id, mcpToolText(arr)) };
      }
      if (name === 'create_pull_request') {
        const r = getRepo(str(args.owner), str(args.repo));
        if (!r) return { status: 200, payload: mcpResult(id, { content: [{ type: 'text', text: 'Not Found' }], isError: true }) };
        const p = createPullRec(r, str(args.title), str(args.body), str(args.head), str(args.base, r.headRef));
        if (!p) return { status: 200, payload: mcpResult(id, { content: [{ type: 'text', text: 'Invalid pull request' }], isError: true }) };
        return { status: 200, payload: mcpResult(id, mcpToolText(pullJsonObject(r, p))) };
      }
      if (name === 'merge_pull_request') {
        const r = getRepo(str(args.owner), str(args.repo));
        const p = r?.pulls.get(num(args.pull_number));
        if (!r || !p) return { status: 200, payload: mcpResult(id, { content: [{ type: 'text', text: 'Not Found' }], isError: true }) };
        if (p.state !== 'open') return { status: 200, payload: mcpResult(id, { content: [{ type: 'text', text: 'Pull request is not open' }], isError: true }) };
        if (mergeableStatus(r, p) === 'CONFLICTING') return { status: 200, payload: mcpResult(id, { content: [{ type: 'text', text: 'Merge conflict' }], isError: true }) };
        const merged = squashMerge(store, r, p);
        if (!merged) return { status: 200, payload: mcpResult(id, { content: [{ type: 'text', text: 'Cannot merge' }], isError: true }) };
        p.state = 'merged';
        p.merged = true;
        p.mergedAt = FIXED_TIME;
        p.mergeCommitSha = merged.sha;
        return { status: 200, payload: mcpResult(id, mcpToolText({ sha: merged.sha, merged: true, number: p.number })) };
      }
    } catch (e) {
      return { status: 200, payload: mcpResult(id, { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true }) };
    }
    return { status: 200, payload: mcpError(id, -32602, `Unhandled tool: ${name}`) };
  }
  return { status: 200, payload: mcpError(id, -32601, `Method not found: ${method}`) };
}

// ---------------------------------------------------------------- git smart HTTP

const AGENT_CAP = 'github-core-clone/1.0';
const UPLOAD_CAPS = `multi_ack_detailed side-band-64k thin-pack no-progress shallow ofs-delta include-tag symref=HEAD:refs/heads/main object-format=sha1 agent=${AGENT_CAP}`;
const V2_CAPS = ['version 2\n', 'ls-refs=unborn\n', 'fetch=shallow thin-pack\n', `agent=${AGENT_CAP}\n`, 'object-format=sha1\n'];

function refLines(r: RepoRec, peeled: boolean): { ref: string; oid: string; peeledOid: string | null }[] {
  const out: { ref: string; oid: string; peeledOid: string | null }[] = [];
  const heads = [...r.refs.keys()].sort();
  for (const b of heads) out.push({ ref: `refs/heads/${b}`, oid: r.refs.get(b) as string, peeledOid: null });
  const tags = [...r.tags.keys()].sort();
  for (const t of tags) {
    const oid = r.tags.get(t) as string;
    const obj = objects.get(oid);
    const peeledOid = peeled && obj?.type === 'tag' ? peelToCommit(oid) : null;
    out.push({ ref: `refs/tags/${t}`, oid, peeledOid });
  }
  return out;
}

/** True when a git-upload-pack body is protocol v2 (it opens with `command=`). */
function bodyLooksV2(body: Buffer): boolean {
  if (body.length < 12) return false;
  for (let off = 0; off + 4 <= body.length; ) {
    const len = parseInt(body.toString('ascii', off, off + 4), 16);
    if (!Number.isFinite(len) || len < 4) return false;
    if (len === 0 || len === 1) return false;
    if (body.toString('latin1', off + 4, off + 12) === 'command=') return true;
    off += len;
  }
  return false;
}

function v2Advertisement(r: RepoRec): Buffer {
  if (r.v2Adv) return r.v2Adv;
  const parts: Buffer[] = [];
  for (const line of V2_CAPS) parts.push(pkt(line));
  parts.push(PKT_FLUSH);
  r.v2Adv = Buffer.concat(parts);
  return r.v2Adv;
}

function v0Advertisement(r: RepoRec, service: 'upload' | 'receive'): Buffer {
  const cached = service === 'upload' ? r.v0UpAdv : r.v0RecvAdv;
  if (cached) return cached;
  const isUpload = service === 'upload';
  const caps = isUpload ? UPLOAD_CAPS : `${UPLOAD_CAPS} report-status side-band-64k delete-refs ofs-delta`;
  const parts: Buffer[] = [pkt(`# service=git-${isUpload ? 'upload-pack' : 'receive-pack'}\n`), PKT_FLUSH];
  const lines = refLines(r, true);
  const tip = r.refs.get('main');
  if (lines.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pkt(`${tip ?? lines[0]?.oid} HEAD\0${caps}\n`));
    for (const l of lines) {
      parts.push(pkt(`${l.oid} ${l.ref}\n`));
      if (l.peeledOid) parts.push(pkt(`${l.peeledOid} ${l.ref}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  const buf = Buffer.concat(parts);
  if (isUpload) r.v0UpAdv = buf; else r.v0RecvAdv = buf;
  return buf;
}

function handleLsRefs(r: RepoRec, body: Buffer): Buffer {
  const lines = decodePktLines(body);
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  for (const p of lines) {
    if (p.kind !== 'data') continue;
    const s = p.payload.toString('utf8').trim();
    if (s.startsWith('ref-prefix ')) prefixes.push(s.slice('ref-prefix '.length));
    else if (s === 'peel') peel = true;
    else if (s === 'symrefs') symrefs = true;
  }
  const cacheKey = `${prefixes.join(',')}|${peel ? 1 : 0}|${symrefs ? 1 : 0}`;
  const cached = r.lsRefs.get(cacheKey);
  if (cached) return cached;
  const tip = r.refs.get('main');
  const out: Buffer[] = [];
  const matches = (ref: string): boolean => prefixes.length === 0 || prefixes.some((pre) => ref.startsWith(pre));
  if (matches('HEAD') && tip) out.push(pkt(`${tip} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
  if (!tip && matches('HEAD')) out.push(pkt('unborn HEAD symref-target:refs/heads/main\n'));
  for (const l of refLines(r, peel)) {
    if (!matches(l.ref)) continue;
    out.push(pkt(`${l.oid} ${l.ref}${l.peeledOid ? ` peeled:${l.peeledOid}` : ''}\n`));
  }
  out.push(PKT_FLUSH);
  const buf = Buffer.concat(out);
  r.lsRefs.set(cacheKey, buf);
  return buf;
}

function handleUploadPack(r: RepoRec, body: Buffer): Buffer {
  const lines = decodePktLines(body);
  let command = '';
  const wants: string[] = [];
  const haves: string[] = [];
  const shallows: string[] = [];
  let depth: number | null = null;
  let doneSeen = false;
  let section = '';
  for (const p of lines) {
    if (p.kind === 'delim') { section = ''; continue; }
    if (p.kind === 'flush') { section = ''; continue; }
    if (p.kind !== 'data') continue;
    const s = p.payload.toString('utf8');
    const line = s.endsWith('\n') ? s.slice(0, -1) : s;
    if (line.startsWith('command=')) { command = line.slice('command='.length); continue; }
    if (line === 'ls-refs') { command = 'ls-refs'; continue; }
    if (line.startsWith('want ')) { wants.push(line.slice(5).split(' ')[0] as string); continue; }
    if (line.startsWith('have ')) { haves.push(line.slice(5).split(' ')[0] as string); continue; }
    if (line.startsWith('shallow ')) { shallows.push(line.slice(8).trim()); continue; }
    if (line.startsWith('deepen ')) { depth = parseInt(line.slice(7), 10); continue; }
    if (line === 'done') { doneSeen = true; continue; }
    void section;
  }
  if (command === 'ls-refs') return handleLsRefs(r, body);
  if (command === 'fetch') {
    const cacheKey = `${doneSeen ? 'done' : 'neg'}|${wants.slice().sort().join(',')}|${haves.slice().sort().join(',')}|${shallows.join(',')}|${depth}`;
    const cached = r.fetchCache.get(cacheKey);
    if (cached) return cached;
    const plan = selectFetch(wants, haves, shallows, depth);
    const pack = buildPack(plan.deliver);
    // Protocol v2: sections are separated by delim (0001); only the final
    // section ends with flush (0000). When the client sent 'done' there is
    // no negotiation round, so the response starts at shallow-info/packfile
    // with NO acknowledgments section (git's fetch-pack expects exactly
    // that); without 'done' we answer the ack round first.
    const parts: Buffer[] = [];
    if (!doneSeen) {
      if (plan.deliver.length === 0) {
        return Buffer.concat([pkt('acknowledgments\n'), pkt('NAK\n'), PKT_FLUSH]);
      }
      parts.push(pkt('acknowledgments\n'), pkt('ready\n'), PKT_DELIM);
    }
    if (plan.shallowOut.length || plan.unshallow.length) {
      parts.push(pkt('shallow-info\n'));
      for (const s of plan.shallowOut) parts.push(pkt(`shallow ${s}\n`));
      for (const u of plan.unshallow) parts.push(pkt(`unshallow ${u}\n`));
      parts.push(PKT_DELIM);
    }
    parts.push(pkt('packfile\n'));
    for (const chunk of sidebandChunks(pack)) parts.push(chunk);
    parts.push(PKT_FLUSH);
    const buf = Buffer.concat(parts);
    r.fetchCache.set(cacheKey, buf);
    return buf;
  }
  return Buffer.concat([pkt('acknowledgments\n'), pkt('NAK\n'), PKT_FLUSH]);
}

function handleV0Fetch(r: RepoRec, body: Buffer): Buffer {
  const lines = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallows: string[] = [];
  let depth: number | null = null;
  let sawDone = false;
  for (const p of lines) {
    if (p.kind !== 'data') continue;
    const s = p.payload.toString('utf8');
    const line = s.endsWith('\n') ? s.slice(0, -1) : s;
    if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0] as string);
    else if (line.startsWith('have ')) haves.push(line.slice(5).split(' ')[0] as string);
    else if (line.startsWith('shallow ')) shallows.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = parseInt(line.slice(7), 10);
    else if (line === 'done') sawDone = true;
  }
  void sawDone;
  const plan = selectFetch(wants, haves, shallows, depth);
  const pack = buildPack(plan.deliver);
  const parts: Buffer[] = [pkt('NAK\n')];
  for (const s of plan.shallowOut) parts.push(pkt(`shallow ${s}\n`));
  for (const u of plan.unshallow) parts.push(pkt(`unshallow ${u}\n`));
  for (const chunk of sidebandChunks(pack)) parts.push(chunk);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function handleReceivePack(r: RepoRec, body: Buffer): Buffer {
  const lines = decodePktLines(body);
  const commands: { old: string; new: string; ref: string }[] = [];
  let packOffset = -1;
  let off = 0;
  // Walk raw bytes: command pkt-lines until flush, then the pack starts.
  while (off + 4 <= body.length) {
    const len = parseInt(body.toString('ascii', off, off + 4), 16);
    if (Number.isNaN(len) || len < 4) { packOffset = off + 4; break; }
    if (len === 0) { packOffset = off + 4; break; }
    if (len === 1) { off += 4; continue; }
    const payload = body.subarray(off + 4, off + len).toString('utf8');
    const line = payload.endsWith('\n') ? payload.slice(0, -1) : payload;
    const nul = line.indexOf('\0');
    const clean = nul >= 0 ? line.slice(0, nul) : line;
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/.exec(clean.trim());
    if (m) commands.push({ old: m[1] as string, new: m[2] as string, ref: m[3] as string });
    off += len;
  }
  void lines;
  const results: { ref: string; ok: boolean; reason: string }[] = [];
  if (packOffset >= 0 && packOffset < body.length) {
    const packBytes = body.subarray(packOffset);

    try {
      readPack(packBytes);
    } catch (e) {
      console.error(`receive-pack unpack error: ${(e as Error).message} (pack ${packBytes.length} bytes, ${commands.length} commands)`);
      for (const c of commands) results.push({ ref: c.ref, ok: false, reason: 'unpack error' });
      const payload = Buffer.concat([pkt('unpack error\n'), ...results.map((x) => pkt(`ng ${x.ref} ${x.reason}\n`)), PKT_FLUSH]);
      const framed = Buffer.concat([Buffer.from([1]), payload]);
      return Buffer.concat([pkt(framed), PKT_FLUSH]);
    }
  }
  for (const cmd of commands) {
    const m = /^refs\/(heads|tags)\/(.+)$/.exec(cmd.ref);
    if (!m) { results.push({ ref: cmd.ref, ok: false, reason: 'invalid ref' }); continue; }
    const kind = m[1] as string;
    const name = m[2] as string;
    if (kind === 'tags') {
      if (cmd.new === ZERO_OID) {
        r.tags.delete(name);
        invalidateRepoCache(r);
        results.push({ ref: cmd.ref, ok: true, reason: '' });
      } else if (!objects.has(cmd.new)) {
        results.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
      } else {
        r.tags.set(name, cmd.new);
        invalidateRepoCache(r);
        results.push({ ref: cmd.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (cmd.new === ZERO_OID) {
      // delete branch
      if (r.refs.has(name)) {
        if (cmd.old !== ZERO_OID && r.refs.get(name) !== cmd.old) { results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' }); continue; }
        r.refs.delete(name);
        invalidateRepoCache(r);
        results.push({ ref: cmd.ref, ok: true, reason: '' });
      } else results.push({ ref: cmd.ref, ok: false, reason: 'no such ref' });
      continue;
    }
    const oldTip = r.refs.get(name);
    if (cmd.old !== ZERO_OID && oldTip !== cmd.old) {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (!objects.has(cmd.new)) { results.push({ ref: cmd.ref, ok: false, reason: 'object not found' }); continue; }
    if (oldTip && oldTip !== ZERO_OID) {
      if (cmd.old === ZERO_OID) { results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' }); continue; }
      if (!isAncestor(oldTip, cmd.new)) { results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' }); continue; }
    }
    r.refs.set(name, cmd.new);
    invalidateRepoCache(r);
    results.push({ ref: cmd.ref, ok: true, reason: '' });
  }
  const lines2: Buffer[] = [pkt('unpack ok\n')];
  for (const x of results) lines2.push(x.ok ? pkt(`ok ${x.ref}\n`) : pkt(`ng ${x.ref} ${x.reason}\n`));
  lines2.push(PKT_FLUSH);
  const payload = Buffer.concat(lines2);
  const framed = Buffer.concat([Buffer.from([1]), payload]);
  return Buffer.concat([pkt(framed), PKT_FLUSH]);
}

// ---------------------------------------------------------------- server + lifecycle

const server = createServer((req, res) => {
  void (async () => {
    try {
      const rawUrl = req.url ?? '/';
      const qIdx = rawUrl.indexOf('?');
      const path = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl;
      let qLazy: URLSearchParams | null = null;
      const q = (): URLSearchParams => (qLazy ??= new URLSearchParams(qIdx >= 0 ? rawUrl.slice(qIdx + 1) : ''));
      const method = req.method ?? 'GET';

      if (path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // git smart HTTP: /{owner}/{repo}.git/...
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(path);
      if (gitMatch) {
        const owner = decodeURIComponent(gitMatch[1] as string);
        const repoName = decodeURIComponent(gitMatch[2] as string);
        const tail = gitMatch[3] as string;
        if (owner !== VIEWER_LOGIN) { sendError(res, 404, 'Not Found'); return; }
        const r = getRepo(owner, repoName);
        if (!r) { sendError(res, 404, 'Not Found'); return; }
        const body = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
        if (tail === 'info/refs') {
          const service = q().get('service') ?? '';
          if (service === 'git-upload-pack') {
            // Honour the client's dialect: v2 when it asks for it (the conformance
            // checks require a real v2 advertisement), v0 otherwise. Each dialect
            // keeps its own cached Buffer, so the choice costs nothing per request.
            if ((req.headers['git-protocol'] ?? '') === 'version=2') {
              sendBuffer(res, 200, v2Advertisement(r), 'application/x-git-upload-pack-advertisement');
            } else {
              sendBuffer(res, 200, v0Advertisement(r, 'upload'), 'application/x-git-upload-pack-advertisement');
            }
            return;
          }
          if (service === 'git-receive-pack') {
            sendBuffer(res, 200, v0Advertisement(r, 'receive'), 'application/x-git-receive-pack-advertisement');
            return;
          }
          sendError(res, 400, 'Unknown service');
          return;
        }
        if (tail === 'git-upload-pack' && method === 'POST') {
          // We advertised v0, so a conforming client speaks v0 here. Some clients
          // still send a v2 body: detect it from the first command so neither
          // dialect is ever mis-parsed.
          const out = bodyLooksV2(body) ? handleUploadPack(r, body) : handleV0Fetch(r, body);
          sendBuffer(res, 200, out, 'application/x-git-upload-pack-result');
          return;
        }
        if (tail === 'git-receive-pack' && method === 'POST') {
          const out = handleReceivePack(r, body);
          sendBuffer(res, 200, out, 'application/x-git-receive-pack-result');
          return;
        }
        sendError(res, 404, 'Not Found');
        return;
      }

      // REST + GraphQL + MCP need auth (except healthz above)
      if (!authOk(req)) {
        if (path === '/api/graphql') {
          sendJson(res, 401, { errors: [{ message: 'Requires authentication' }] });
          return;
        }
        sendError(res, 401, 'Requires authentication');
        return;
      }

      if (path === '/api/graphql' && method === 'POST') {
        const body = await readBody(req);
        const result = handleGraphql(body);
        sendJson(res, 200, result);
        return;
      }
      if (path === '/mcp' && method === 'POST') {
        const body = await readBody(req);
        const { status, payload } = handleMcp(body);
        if (payload === null) {
          res.writeHead(202, { 'X-GitHub-Request-Id': nextReqId() });
          res.end();
          return;
        }
        sendJson(res, status, payload);
        return;
      }
      if (path.startsWith('/api/v3/')) {
        const body = (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') ? await readBody(req) : Buffer.alloc(0);
        handleRest(req, res, path, q, body);
        return;
      }
      sendError(res, 404, 'Not Found');
    } catch (e) {
      try { sendError(res, 500, (e as Error).message ?? 'Internal error'); } catch { /* already closed */ }
    }
  })();
});

async function fetchJson(url: string, options: { method?: string; body?: string } = {}): Promise<unknown> {
  const res = await fetch(url, { method: options.method ?? 'GET', body: options.body, headers: options.body ? { 'Content-Type': 'application/json' } : {} });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

async function main(): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  if (ENV_URL) {
    await fetchJson(`${ENV_URL}/register`, { method: 'POST', body: JSON.stringify({ port }) });
    for (;;) {
      const done = await fetchJson(`${ENV_URL}/done`).catch(() => null);
      // /done answers {"done": true} — an object, not a bare boolean.
      if (done !== null && typeof done === 'object' && (done as { done?: unknown }).done === true) break;
      await new Promise((r) => setTimeout(r, 500));
    }
  } else {
    // No harness env: serve forever (useful for local smoke tests).
    await new Promise(() => undefined);
  }
  server.close();
  process.exit(0);
}

main().catch((e: Error) => {
  console.error(e);
  process.exit(1);
});
