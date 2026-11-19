// A small GraphQL document parser (queries, mutations, fragments, variables, directives, literals).
export type Val =
  | { k: 'var'; name: string }
  | { k: 'lit'; v: unknown }
  | { k: 'list'; items: Val[] }
  | { k: 'obj'; fields: Record<string, Val> };
export interface Dir { name: string; args: Record<string, Val> }
export interface FieldSel { k: 'f'; alias: string | null; name: string; args: Record<string, Val>; dirs: Dir[]; sel: Sel[] | null; pos: number }
export interface SpreadSel { k: 's'; name: string; dirs: Dir[] }
export interface InlineSel { k: 'i'; cond: string | null; dirs: Dir[]; sel: Sel[] }
export type Sel = FieldSel | SpreadSel | InlineSel;
export interface VarDef { name: string; def: Val | null }
export interface Op { type: string; name: string | null; vars: VarDef[]; sel: Sel[] }
export interface Fragment { name: string; cond: string; sel: Sel[] }
export interface Doc { ops: Op[]; frags: Map<string, Fragment> }

export class GqlSyntaxError extends Error {
  pos: number;
  constructor(message: string, pos: number) { super(message); this.pos = pos; }
}

interface Tok { t: string; v: string; pos: number }

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') { i++; continue; }
    if (c === '#') { while (i < n && src[i] !== '\n' && src[i] !== '\r') i++; continue; }
    if (c === '.') {
      if (src.startsWith('...', i)) { out.push({ t: 'p', v: '...', pos: i }); i += 3; continue; }
      throw new GqlSyntaxError('Unexpected "."', i);
    }
    if ('!$&()[]{}:=@|'.includes(c)) { out.push({ t: 'p', v: c, pos: i }); i++; continue; }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
      out.push({ t: 'name', v: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      let j = i + 1;
      let float = false;
      while (j < n && /[0-9]/.test(src[j])) j++;
      if (src[j] === '.') { float = true; j++; while (j < n && /[0-9]/.test(src[j])) j++; }
      if (src[j] === 'e' || src[j] === 'E') {
        float = true; j++;
        if (src[j] === '+' || src[j] === '-') j++;
        while (j < n && /[0-9]/.test(src[j])) j++;
      }
      const text = src.slice(i, j);
      if (text === '-') throw new GqlSyntaxError('Unexpected "-"', i);
      out.push({ t: float ? 'float' : 'int', v: text, pos: i });
      i = j;
      continue;
    }
    if (c === '"') {
      if (src.startsWith('"""', i)) {
        const end = src.indexOf('"""', i + 3);
        if (end < 0) throw new GqlSyntaxError('Unterminated string', i);
        out.push({ t: 'str', v: src.slice(i + 3, end).replace(/\\"""/g, '"""'), pos: i });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let s = '';
      for (;;) {
        if (j >= n || src[j] === '\n') throw new GqlSyntaxError('Unterminated string', i);
        const d = src[j];
        if (d === '"') { j++; break; }
        if (d === '\\') {
          const e = src[j + 1];
          j += 2;
          if (e === 'n') s += '\n';
          else if (e === 't') s += '\t';
          else if (e === 'r') s += '\r';
          else if (e === 'b') s += '\b';
          else if (e === 'f') s += '\f';
          else if (e === 'u') { s += String.fromCharCode(parseInt(src.slice(j, j + 4), 16)); j += 4; }
          else s += e;
          continue;
        }
        s += d;
        j++;
      }
      out.push({ t: 'str', v: s, pos: i });
      i = j;
      continue;
    }
    throw new GqlSyntaxError(`Unexpected character "${c}"`, i);
  }
  out.push({ t: 'eof', v: '<EOF>', pos: n });
  return out;
}

export function parse(src: string): Doc {
  const toks = lex(src);
  let p = 0;
  const peek = (): Tok => toks[p];
  const bad = (what?: string): never => {
    const t = toks[p];
    throw new GqlSyntaxError(`Parse error on "${t.v}"${what ? ` (expected ${what})` : ''}`, t.pos);
  };
  const isP = (v: string): boolean => toks[p].t === 'p' && toks[p].v === v;
  const eatP = (v: string): boolean => { if (isP(v)) { p++; return true; } return false; };
  const needP = (v: string): void => { if (!eatP(v)) bad(`"${v}"`); };
  const name = (): string => { if (toks[p].t !== 'name') bad('name'); return toks[p++].v; };

  function value(isConst: boolean): Val {
    const t = peek();
    if (t.t === 'p') {
      if (t.v === '$') { if (isConst) bad(); p++; return { k: 'var', name: name() }; }
      if (t.v === '[') {
        p++;
        const items: Val[] = [];
        while (!eatP(']')) items.push(value(isConst));
        return { k: 'list', items };
      }
      if (t.v === '{') {
        p++;
        const fields: Record<string, Val> = {};
        while (!eatP('}')) { const k = name(); needP(':'); fields[k] = value(isConst); }
        return { k: 'obj', fields };
      }
      return bad('value');
    }
    p++;
    if (t.t === 'int') return { k: 'lit', v: parseInt(t.v, 10) };
    if (t.t === 'float') return { k: 'lit', v: parseFloat(t.v) };
    if (t.t === 'str') return { k: 'lit', v: t.v };
    if (t.t === 'name') {
      if (t.v === 'true') return { k: 'lit', v: true };
      if (t.v === 'false') return { k: 'lit', v: false };
      if (t.v === 'null') return { k: 'lit', v: null };
      return { k: 'lit', v: t.v };
    }
    p--;
    return bad('value');
  }

  function args(): Record<string, Val> {
    const out: Record<string, Val> = {};
    if (eatP('(')) {
      while (!eatP(')')) { const k = name(); needP(':'); out[k] = value(false); }
    }
    return out;
  }

  function dirs(): Dir[] {
    const out: Dir[] = [];
    while (eatP('@')) out.push({ name: name(), args: args() });
    return out;
  }

  function selSet(): Sel[] {
    needP('{');
    const out: Sel[] = [];
    while (!eatP('}')) {
      if (peek().t === 'eof') bad('"}"');
      if (eatP('...')) {
        const t = peek();
        if (t.t === 'name' && t.v !== 'on') { p++; out.push({ k: 's', name: t.v, dirs: dirs() }); continue; }
        let cond: string | null = null;
        if (t.t === 'name' && t.v === 'on') { p++; cond = name(); }
        const d = dirs();
        out.push({ k: 'i', cond, dirs: d, sel: selSet() });
        continue;
      }
      const pos = peek().pos;
      let alias: string | null = null;
      let nm = name();
      if (eatP(':')) { alias = nm; nm = name(); }
      const a = args();
      const d = dirs();
      out.push({ k: 'f', alias, name: nm, args: a, dirs: d, sel: isP('{') ? selSet() : null, pos });
    }
    if (out.length === 0) bad('selection');
    return out;
  }

  function skipType(): void {
    if (eatP('[')) { skipType(); needP(']'); } else name();
    eatP('!');
  }

  const ops: Op[] = [];
  const frags = new Map<string, Fragment>();
  if (peek().t === 'eof') bad('definition');
  while (peek().t !== 'eof') {
    if (isP('{')) { ops.push({ type: 'query', name: null, vars: [], sel: selSet() }); continue; }
    const kw = name();
    if (kw === 'fragment') {
      const fname = name();
      if (name() !== 'on') bad('"on"');
      const cond = name();
      dirs();
      frags.set(fname, { name: fname, cond, sel: selSet() });
    } else if (kw === 'query' || kw === 'mutation' || kw === 'subscription') {
      const opName = peek().t === 'name' ? name() : null;
      const vars: VarDef[] = [];
      if (eatP('(')) {
        while (!eatP(')')) {
          needP('$');
          const vn = name();
          needP(':');
          skipType();
          let def: Val | null = null;
          if (eatP('=')) def = value(true);
          dirs();
          vars.push({ name: vn, def });
        }
      }
      dirs();
      ops.push({ type: kw, name: opName, vars, sel: selSet() });
    } else {
      p--;
      bad('query, mutation or fragment');
    }
  }
  return { ops, frags };
}
