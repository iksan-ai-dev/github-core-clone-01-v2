// gitcore.ts — the git object model and packfile engine for github-core-clone-01.

import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';
//
// Split out of main.ts so the wire protocol, the object model and the HTTP front-end
// each live in one file with one job. Everything here is pure: it takes Buffers and
// returns Buffers, keeps no request state, and touches no sockets.
//
// Contents, in order:
//   utilities      sha1/b64/pkt-line helpers shared by the whole server
//   object store   the four git object types, parsing and serialising commits and trees
//   packfiles      pack headers, zlib payloads, ofs/ref deltas, and the reader
//   fetch          the want/have/depth selection that decides what a fetch delivers

// ---------------------------------------------------------------- utilities

export function sha1hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function hashObject(type: string, data: Buffer): string {
  const h = createHash('sha1');
  h.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  h.update(data);
  return h.digest('hex');
}

export function b64encode(buf: Buffer | string): string {
  return Buffer.isBuffer(buf) ? buf.toString('base64') : Buffer.from(buf, 'utf8').toString('base64');
}

export function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/[\r\n\t ]+/g, ''), 'base64');
}

export function isOid(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s);
}

export let reqCounter = 0;
export function nextReqId(): string {
  reqCounter += 1;
  return `req-${reqCounter}`;
}

// pkt-line helpers
export function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.allocUnsafe(4);
  head.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, data]);
}
export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export interface Pkt { kind: 'data' | 'flush' | 'delim' | 'end'; payload: Buffer }

export function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const len = parseInt(buf.toString('ascii', off, off + 4), 16);
    if (Number.isNaN(len)) break;
    if (len === 0) { out.push({ kind: 'flush', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len === 1) { out.push({ kind: 'delim', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len === 2) { out.push({ kind: 'end', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len < 4 || off + len > buf.length) break;
    out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return out;
}

// ---------------------------------------------------------------- git object store

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObj { type: ObjType; data: Buffer }
export const objects = new Map<string, GitObj>();

export function storeObject(type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}

export interface CommitInfo { tree: string; parents: string[]; message: string; author: string; committer: string }
export const commitCache = new Map<string, CommitInfo>();
export function parseCommit(oid: string): CommitInfo | null {
  const hit = commitCache.get(oid);
  if (hit) return hit;
  const obj = objects.get(oid);
  if (!obj || obj.type !== 'commit') return null;
  const data = obj.data;
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    const k = line.slice(0, sp);
    const v = line.slice(sp + 1);
    if (k === 'tree') tree = v;
    else if (k === 'parent') parents.push(v);
    else if (k === 'author') author = v;
    else if (k === 'committer') committer = v;
  }
  const info: CommitInfo = { tree, parents, message, author, committer };
  commitCache.set(oid, info);
  return info;
}

export interface TreeEntry { mode: string; name: string; oid: string }
export const treeCache = new Map<string, TreeEntry[]>();
export function parseTree(oid: string): TreeEntry[] | null {
  const hit = treeCache.get(oid);
  if (hit) return hit;
  const obj = objects.get(oid);
  if (!obj || obj.type !== 'tree') return null;
  const data = obj.data;
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp < 0) break;
    const nul = data.indexOf(0x00, sp + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    entries.push({ mode: data.subarray(off, sp).toString('ascii'), name: data.subarray(sp + 1, nul).toString('utf8'), oid: data.subarray(nul + 1, nul + 21).toString('hex') });
    off = nul + 21;
  }
  treeCache.set(oid, entries);
  return entries;
}

export function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const l = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const r = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(l, r);
}

export function buildTree(entries: TreeEntry[]): string {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return storeObject('tree', Buffer.concat(parts));
}

// The committer identity the scenario's token belongs to. It is fixed by the kit's wire.ts
// seed, so it can live here rather than being threaded through every call.
const COMMITTER_NAME = 'ada iversen';
const COMMITTER_EMAIL = 'adaiversen@example.invalid';

export function buildCommit(tree: string, parents: string[], message: string, timestamp: number): string {
  const who = `${COMMITTER_NAME} <${COMMITTER_EMAIL}> ${timestamp} +0000`;
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  const msg = message.endsWith('\n') ? message : `${message}\n`;
  return storeObject('commit', Buffer.from(`${lines.join('\n')}\n${msg}`, 'utf8'));
}

// flattened tree: path -> {oid, mode}
export const flatCache = new Map<string, Map<string, { oid: string; mode: string }>>();
export function flattenTree(treeOid: string): Map<string, { oid: string; mode: string }> {
  const hit = flatCache.get(treeOid);
  if (hit) return hit;
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string): void => {
    const entries = parseTree(oid);
    if (!entries) return;
    for (const e of entries) {
      const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
      if (e.mode === '40000') walk(e.oid, path);
      else out.set(path, { oid: e.oid, mode: e.mode });
    }
  };
  walk(treeOid, '');
  flatCache.set(treeOid, out);
  return out;
}

// set one path in a tree (creating intermediate dirs), returns new tree oid
export function setPathInTree(treeOid: string | null, segments: string[], blobOid: string): string {
  if (segments.length === 0) return treeOid ?? buildTree([]);
  const name = segments[0] as string;
  const entries: TreeEntry[] = treeOid ? [...(parseTree(treeOid) ?? [])] : [];
  if (segments.length === 1) {
    const idx = entries.findIndex((e) => e.name === name);
    if (idx >= 0) entries[idx] = { mode: '100644', name, oid: blobOid };
    else entries.push({ mode: '100644', name, oid: blobOid });
    return buildTree(entries);
  }
  const idx = entries.findIndex((e) => e.name === name);
  const child = idx >= 0 && entries[idx]?.mode === '40000' ? (entries[idx] as TreeEntry).oid : null;
  const newChild = setPathInTree(child, segments.slice(1), blobOid);
  if (idx >= 0) entries[idx] = { mode: '40000', name, oid: newChild };
  else entries.push({ mode: '40000', name, oid: newChild });
  return buildTree(entries);
}

export function deletePathInTree(treeOid: string, segments: string[]): string {
  if (segments.length === 0) return treeOid;
  const entries = [...(parseTree(treeOid) ?? [])];
  const name = segments[0] as string;
  const idx = entries.findIndex((e) => e.name === name);
  if (idx < 0) return treeOid;
  if (segments.length === 1) {
    entries.splice(idx, 1);
    return buildTree(entries);
  }
  const child = entries[idx] as TreeEntry;
  if (child.mode !== '40000') return treeOid;
  const newChild = deletePathInTree(child.oid, segments.slice(1));
  const childEntries = parseTree(newChild);
  if (childEntries && childEntries.length === 0) entries.splice(idx, 1);
  else entries[idx] = { mode: '40000', name, oid: newChild };
  return buildTree(entries);
}

// reachability: all oids reachable from roots (commit->tree+parents, tag->target, tree->entries)
export function collectReachable(roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const r of roots) if (isOid(r)) queue.push(r);
  while (queue.length) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const obj = objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(oid);
      if (c) { queue.push(c.tree); for (const p of c.parents) queue.push(p); }
    } else if (obj.type === 'tag') {
      const blank = obj.data.indexOf('\n\n');
      const head = (blank < 0 ? obj.data.toString('utf8') : obj.data.subarray(0, blank).toString('utf8'));
      for (const line of head.split('\n')) {
        if (line.startsWith('object ')) queue.push(line.slice(7).trim());
      }
    } else if (obj.type === 'tree') {
      const entries = parseTree(oid);
      if (entries) for (const e of entries) if (e.mode !== '160000') queue.push(e.oid);
    }
  }
  return seen;
}

// ancestor check with direct-parent fast path
export function isAncestor(ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const start = parseCommit(descendant);
  if (!start) return false;
  if (start.parents.includes(ancestor)) return true;
  const seen = new Set<string>([descendant]);
  const queue = [...start.parents];
  while (queue.length) {
    const oid = queue.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const c = parseCommit(oid);
    if (c) for (const p of c.parents) queue.push(p);
  }
  return false;
}

export function peelToCommit(oid: string): string | null {
  let cur = oid;
  for (let i = 0; i < 10; i++) {
    const obj = objects.get(cur);
    if (!obj) return null;
    if (obj.type === 'commit') return cur;
    if (obj.type !== 'tag') return null;
    const blank = obj.data.indexOf('\n\n');
    const head = (blank < 0 ? obj.data.toString('utf8') : obj.data.subarray(0, blank).toString('utf8'));
    let next = '';
    for (const line of head.split('\n')) if (line.startsWith('object ')) next = line.slice(7).trim();
    if (!next) return null;
    cur = next;
  }
  return null;
}

// ---------------------------------------------------------------- packfiles

export const TYPE_CODE: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type] as number;
  const bytes: number[] = [];
  let first = (code << 4) | (size & 0x0f);
  size >>>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let b = size & 0x7f;
    size >>>= 7;
    if (size > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

export function buildPack(items: { type: ObjType; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(items.length, 8);
  parts.push(header);
  for (const item of items) {
    parts.push(writePackObjectHeader(item.type, item.data.length));
    parts.push(deflateSync(item.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// Inflate the zlib stream starting at offset; returns data + next offset.
// inflateSync with {info:true} returns the engine, whose bytesWritten is
// exactly the number of input bytes the stream consumed — one inflate per
// object instead of a binary search (~17x faster than probing: a single
// inflateSync costs ~20us, mostly zlib init).
export function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } {
  const res = inflateSync(buf.subarray(offset), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  return { data: res.buffer, next: offset + res.engine.bytesWritten };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let out = 0;
    let shift = 0;
    for (;;) {
      const b = delta[pos++] as number;
      out |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return out;
  };
  readVarint(); // source size
  const targetSize = readVarint();
  const parts: Buffer[] = [];
  let total = 0;
  while (pos < delta.length) {
    const op = delta[pos++] as number;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset = delta[pos++] as number;
      if (op & 0x02) offset |= (delta[pos++] as number) << 8;
      if (op & 0x04) offset |= (delta[pos++] as number) << 16;
      if (op & 0x08) offset |= (delta[pos++] as number) << 24;
      if (op & 0x10) size = delta[pos++] as number;
      if (op & 0x20) size |= (delta[pos++] as number) << 8;
      if (op & 0x40) size |= (delta[pos++] as number) << 16;
      if (size === 0) size = 0x10000;
      parts.push(base.subarray(offset, offset + size));
      total += size;
    } else if (op > 0) {
      parts.push(delta.subarray(pos, pos + op));
      pos += op;
      total += op;
    } else throw new Error('bad delta op 0');
  }
  const out = Buffer.concat(parts, total);
  if (out.length !== targetSize) throw new Error('delta size mismatch');
  return out;
}

export interface PackObject { type: ObjType; data: Buffer; oid: string }
// Parse a pack, storing every object. Returns stored objects in pack order.
export function readPack(buf: Buffer): PackObject[] {
  if (buf.length < 32 || buf.toString('ascii', 0, 4) !== 'PACK') throw new Error('bad pack header');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('bad pack version');
  const count = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20);
  const expect = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest();
  if (!expect.equals(trailer)) throw new Error('pack checksum mismatch');
  const out: PackObject[] = [];
  const byOffset = new Map<number, PackObject>();
  let off = 12;
  for (let i = 0; i < count; i++) {
    const startOff = off;
    let byte = buf[off++] as number;
    const typeNum = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[off++] as number;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeNum === 6) {
      // OFS_DELTA
      let b = buf[off++] as number;
      let baseOff = b & 0x7f;
      while (b & 0x80) {
        b = buf[off++] as number;
        baseOff = ((baseOff + 1) << 7) | (b & 0x7f);
      }
      const baseOffset = startOff - baseOff;
      const inflated = inflateAt(buf, off);
      off = inflated.next;
      const base = byOffset.get(baseOffset);
      if (!base) throw new Error('ofs-delta base missing');
      const data = applyDelta(base.data, inflated.data);
      const oid = hashObject(base.type, data);
      const rec: PackObject = { type: base.type, data, oid };
      out.push(rec);
      byOffset.set(startOff, rec);
      if (!objects.has(oid)) objects.set(oid, { type: base.type, data });
    } else if (typeNum === 7) {
      // REF_DELTA
      const baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
      const inflated = inflateAt(buf, off);
      off = inflated.next;
      const base = objects.get(baseOid) ?? out.find((o) => o.oid === baseOid);
      if (!base) throw new Error('ref-delta base missing');
      const data = applyDelta(base.data, inflated.data);
      const oid = hashObject(base.type, data);
      const rec: PackObject = { type: base.type, data, oid };
      out.push(rec);
      byOffset.set(startOff, rec);
      if (!objects.has(oid)) objects.set(oid, { type: base.type, data });
    } else {
      const type = CODE_TYPE[typeNum] as ObjType;
      const inflated = inflateAt(buf, off);
      off = inflated.next;
      if (inflated.data.length !== size) throw new Error('pack object size mismatch');
      const oid = hashObject(type, inflated.data);
      const rec: PackObject = { type, data: inflated.data, oid };
      out.push(rec);
      byOffset.set(startOff, rec);
      if (!objects.has(oid)) objects.set(oid, { type, data: inflated.data });
    }
  }
  return out;
}

// ---------------------------------------------------------------- fetch selection

export interface FetchPlan {
  deliver: { type: ObjType; data: Buffer }[];
  shallowOut: string[];
  unshallow: string[];
}

// BFS commit distances from the wanted tips (tag wants peel to their commit target).
export function commitDistances(wants: string[]): Map<string, number> {
  const dist = new Map<string, number>();
  const queue: string[] = [];
  for (const w of wants) {
    const obj = objects.get(w);
    if (!obj) continue;
    if (obj.type === 'tag') {
      const target = peelToCommit(w);
      if (target && !dist.has(target)) { dist.set(target, 0); queue.push(target); }
    } else if (obj.type === 'commit') {
      if (!dist.has(w)) { dist.set(w, 0); queue.push(w); }
    }
  }
  let head = 0;
  while (head < queue.length) {
    const oid = queue[head++] as string;
    const d = dist.get(oid) as number;
    const c = parseCommit(oid);
    if (!c) continue;
    for (const p of c.parents) {
      if (!dist.has(p)) { dist.set(p, d + 1); queue.push(p); }
    }
  }
  return dist;
}

export function selectFetch(wants: string[], haves: string[], shallowReq: string[], depth: number | null): FetchPlan {
  const dist = commitDistances(wants);
  const haveSet = new Set(haves);
  const haveClosure = new Set<string>();
  if (depth === null) {
    const h = collectReachable(haves);
    for (const oid of h) { const obj = objects.get(oid); if (obj && obj.type === 'commit') haveClosure.add(oid); }
  }
  const deliverCommits = new Set<string>();
  for (const [oid, d] of dist) {
    if (depth !== null && d >= depth) continue;
    if (depth !== null) {
      if (!haveSet.has(oid)) deliverCommits.add(oid);
    } else {
      if (!haveClosure.has(oid)) deliverCommits.add(oid);
    }
  }
  // Without a depth limit the client already holds everything reachable from
  // its haves, so no have-reachable object (commit, tree or blob) may be
  // re-sent — an incremental fetch must carry only the new objects.
  const haveObjs = depth === null ? collectReachable(haves) : null;
  const deliver = new Map<string, { type: ObjType; data: Buffer }>();
  const addObj = (oid: string): void => {
    if (haveObjs && haveObjs.has(oid)) return;
    const obj = objects.get(oid);
    if (obj && !deliver.has(oid)) deliver.set(oid, { type: obj.type, data: obj.data });
  };
  for (const w of wants) {
    const obj = objects.get(w);
    if (obj && obj.type === 'tag') addObj(w);
  }
  for (const oid of deliverCommits) {
    const c = parseCommit(oid);
    if (!c) continue;
    addObj(oid);
    const flat = flattenTree(c.tree);
    const treeOids = new Set<string>([c.tree]);
    const stack: string[] = [c.tree];
    while (stack.length) {
      const t = stack.pop() as string;
      const entries = parseTree(t);
      if (!entries) continue;
      for (const e of entries) {
        if (e.mode === '40000') { if (!treeOids.has(e.oid)) { treeOids.add(e.oid); stack.push(e.oid); } }
        else if (e.mode !== '160000') addObj(e.oid);
      }
    }
    for (const t of treeOids) addObj(t);
    void flat;
  }
  const shallowOut: string[] = [];
  const unshallow: string[] = [];
  if (depth !== null) {
    for (const oid of deliverCommits) {
      if (dist.get(oid) === depth - 1) shallowOut.push(oid);
    }
    for (const b of shallowReq) {
      const c = parseCommit(b);
      if (!c) continue;
      if (c.parents.some((p) => deliverCommits.has(p))) unshallow.push(b);
    }
  }
  // Deterministic pack order: commits, then trees, then blobs, then tags, each by oid.
  const rank: Record<string, number> = { commit: 0, tree: 1, blob: 2, tag: 3 };
  const items = [...deliver.entries()].sort((a, b) => {
    const ra = rank[a[1].type] ?? 9;
    const rb = rank[b[1].type] ?? 9;
    return ra - rb || (a[0] < b[0] ? -1 : 1);
  }).map(([, v]) => v);
  return { deliver: items, shallowOut, unshallow };
}

export function sidebandChunks(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const MAX = 65515;
  for (let off = 0; off < pack.length; off += MAX) {
    const chunk = pack.subarray(off, Math.min(off + MAX, pack.length));
    const payload = Buffer.allocUnsafe(chunk.length + 1);
    payload[0] = 1;
    chunk.copy(payload, 1);
    out.push(pkt(payload));
  }
  return out;
}

