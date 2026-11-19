// pkt-line framing helpers for the git smart HTTP surface.
export const FLUSH = Buffer.from('0000');
export const DELIM = Buffer.from('0001');
export type Pkt = Buffer | 'flush' | 'delim' | 'end';

export function pkt(data: string | Buffer): Buffer {
  const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, '0')), body]);
}

/** Sideband-64k frames of `band` carrying `data` (at most 65515 payload bytes per frame). */
export function sideband(band: number, data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < data.length; i += 65515) {
    const chunk = data.subarray(i, Math.min(data.length, i + 65515));
    out.push(pkt(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return out;
}

/** Parse pkt-lines from `start`. With stopAtFlush, parsing ends after the first flush and `next` is the offset after it. */
export function parsePkts(buf: Buffer, start = 0, stopAtFlush = false): { pkts: Pkt[]; next: number } {
  const pkts: Pkt[] = [];
  let i = start;
  while (i < buf.length) {
    const hex = buf.toString('latin1', i, i + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('bad pkt-line length');
    const len = parseInt(hex, 16);
    if (len === 0) { pkts.push('flush'); i += 4; if (stopAtFlush) break; continue; }
    if (len === 1) { pkts.push('delim'); i += 4; continue; }
    if (len === 2) { pkts.push('end'); i += 4; continue; }
    if (len < 4 || i + len > buf.length) throw new Error('bad pkt-line length');
    pkts.push(buf.subarray(i + 4, i + len));
    i += len;
  }
  return { pkts, next: i };
}
