// Packfile reading (incl. OFS_DELTA / REF_DELTA) and writing (whole objects only).
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { getObject, hashObject, putObject, type ObjType, type Repo } from './store.ts';

const TYPE_NAMES: (ObjType | null)[] = [null, 'commit', 'tree', 'blob', 'tag'];
const TYPE_IDS: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let p = 0;
  const varint = (): number => {
    let v = 0; let shift = 0; let b: number;
    do { b = delta[p++] as number; v += (b & 0x7f) * 2 ** shift; shift += 7; } while ((b & 0x80) !== 0);
    return v;
  };
  const srcSize = varint();
  const dstSize = varint();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(dstSize);
  let o = 0;
  while (p < delta.length) {
    const op = delta[p++] as number;
    if ((op & 0x80) !== 0) {
      let off = 0; let size = 0;
      if (op & 1) off |= (delta[p++] as number);
      if (op & 2) off |= (delta[p++] as number) << 8;
      if (op & 4) off |= (delta[p++] as number) << 16;
      if (op & 8) off += (delta[p++] as number) * 2 ** 24;
      if (op & 16) size |= (delta[p++] as number);
      if (op & 32) size |= (delta[p++] as number) << 8;
      if (op & 64) size |= (delta[p++] as number) << 16;
      if (size === 0) size = 0x10000;
      if (off + size > base.length || o + size > dstSize) throw new Error('bad delta copy');
      base.copy(out, o, off, off + size);
      o += size;
    } else if (op !== 0) {
      if (p + op > delta.length || o + op > dstSize) throw new Error('bad delta insert');
      delta.copy(out, o, p, p + op);
      p += op; o += op;
    } else throw new Error('bad delta opcode');
  }
  if (o !== dstSize) throw new Error('delta result size mismatch');
  return out;
}

interface Entry { offset: number; kind: number; data: Buffer; baseOffset: number; baseSha: string }

/** Parse a pack starting at `buf` and store every object in the repo. Returns the number of objects. Throws on a bad pack. */
export function ingestPack(repo: Repo, buf: Buffer): number {
  if (buf.length < 32 || buf.toString('latin1', 0, 4) !== 'PACK') throw new Error('bad pack header');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('bad pack version');
  const count = buf.readUInt32BE(8);
  const end = buf.length - 20;
  if (createHash('sha1').update(buf.subarray(0, end)).digest('hex') !== buf.subarray(end).toString('hex')) throw new Error('pack checksum mismatch');
  const body = buf.subarray(0, end);
  const entries: Entry[] = [];
  let p = 12;
  for (let n = 0; n < count; n++) {
    const offset = p;
    let b = body[p++] as number;
    const kind = (b >> 4) & 7;
    let size = b & 15; let shift = 4;
    while ((b & 0x80) !== 0) { b = body[p++] as number; size += (b & 0x7f) * 2 ** shift; shift += 7; }
    let baseOffset = -1; let baseSha = '';
    if (kind === 6) {
      b = body[p++] as number;
      let off = b & 0x7f;
      while ((b & 0x80) !== 0) { b = body[p++] as number; off = ((off + 1) * 128) + (b & 0x7f); }
      baseOffset = offset - off;
    } else if (kind === 7) {
      baseSha = body.toString('hex', p, p + 20);
      p += 20;
    } else if (kind < 1 || kind > 4) throw new Error('bad pack entry type');
    const r = inflateSync(body.subarray(p), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    if (r.buffer.length !== size) throw new Error('pack entry size mismatch');
    p += r.engine.bytesWritten;
    entries.push({ offset, kind, data: r.buffer, baseOffset, baseSha });
  }
  const byOffset = new Map<number, { type: ObjType; data: Buffer }>();
  const bySha = new Map<string, { type: ObjType; data: Buffer }>();
  const resolve = (e: Entry): boolean => {
    let res: { type: ObjType; data: Buffer } | undefined;
    if (e.kind <= 4) res = { type: TYPE_NAMES[e.kind] as ObjType, data: e.data };
    else {
      const base = e.kind === 6 ? byOffset.get(e.baseOffset) : (bySha.get(e.baseSha) ?? getObject(repo, e.baseSha));
      if (base === undefined) return false;
      res = { type: base.type, data: applyDelta(base.data, e.data) };
    }
    byOffset.set(e.offset, res);
    bySha.set(hashObject(res.type, res.data), res);
    return true;
  };
  let pending = entries;
  while (pending.length > 0) {
    const next = pending.filter((e) => !resolve(e));
    if (next.length === pending.length) throw new Error('unresolved delta base');
    pending = next;
  }
  for (const o of byOffset.values()) putObject(repo, o.type, o.data);
  return entries.length;
}

/** A pack of whole (undeltified) objects. */
export function writePack(objs: { type: ObjType; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'latin1');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objs.length, 8);
  parts.push(head);
  for (const o of objs) {
    let size = o.data.length;
    let b = (TYPE_IDS[o.type] << 4) | (size & 15);
    size = Math.floor(size / 16);
    const hdr: number[] = [];
    while (size > 0) { hdr.push(b | 0x80); b = size & 0x7f; size = Math.floor(size / 128); }
    hdr.push(b);
    parts.push(Buffer.from(hdr), deflateSync(o.data, { level: 1 }));
  }
  const all = Buffer.concat(parts);
  return Buffer.concat([all, createHash('sha1').update(all).digest()]);
}
