/**
 * HT Script: a tiny, side-effect-free indicator language (lexer + parser).
 *
 * Scripts are never evaluated with `eval` / `new Function` (the app's CSP forbids it, and it would
 * expose the host). They are parsed into an AST and interpreted by `compile.ts`, which only knows
 * the built-in names listed there — no globals, no member access, no loops, no network or DOM.
 *
 *   indicator("Delta oscillator", short="DOSC", pane="new")
 *   len = input.int("Length", 14, min=1, max=500)
 *   fast = ema(delta, len)
 *   plot.histogram("Fast - slow", fast - sma(delta, len * 2), color="#20C77A", color2="#F04A5D")
 */

export interface Pos {
  line: number;
  col: number;
}

export class ScriptError extends Error {
  constructor(
    message: string,
    readonly pos: Pos | null = null,
  ) {
    super(pos ? `${pos.line}:${pos.col} ${message}` : message);
    this.name = 'ScriptError';
  }
}

type TokKind = 'num' | 'str' | 'id' | 'op' | 'nl' | 'eof';
interface Tok {
  k: TokKind;
  v: string;
  pos: Pos;
}

const OPS = [':=', '==', '!=', '<=', '>=', '&&', '||', '+', '-', '*', '/', '%', '^', '(', ')'];
const OPS2 = ['[', ']', ',', '=', '<', '>', '!', '?', ':', '.', ';'];

export const MAX_SOURCE = 20_000;
export const MAX_NODES = 4_000;
/** Deepest expression nesting the parser accepts (keeps recursion far below the JS stack limit). */
export const MAX_DEPTH = 48;
/** Alternative spellings of bar series (Custom Formula names): name -> canonical built-in. */
export const NAME_ALIASES: Readonly<Record<string, string>> = { buyVol: 'buy', sellVol: 'sell' };

export function lex(src: string): Tok[] {
  if (src.length > MAX_SOURCE) throw new ScriptError(`Script is longer than ${MAX_SOURCE} chars`);
  const out: Tok[] = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const adv = (n: number) => {
    for (let k = 0; k < n; k++) {
      if (src[i] === '\n') {
        line++;
        col = 1;
      } else col++;
      i++;
    }
  };
  while (i < src.length) {
    const c = src[i]!;
    const pos = { line, col };
    if (c === '\n' || c === ';') {
      out.push({ k: 'nl', v: c, pos });
      adv(1);
    } else if (c === ' ' || c === '\t' || c === '\r') adv(1);
    else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') adv(1);
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i))!;
      out.push({ k: 'num', v: m[0], pos });
      adv(m[0].length);
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ k: 'id', v: m[0], pos });
      adv(m[0].length);
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== c && src[j] !== '\n') {
        if (src[j] === '\\' && j + 1 < src.length) {
          s += src[j + 1];
          j += 2;
        } else s += src[j++];
      }
      if (src[j] !== c) throw new ScriptError('Unterminated string', pos);
      out.push({ k: 'str', v: s, pos });
      adv(j + 1 - i);
    } else {
      const two = src.slice(i, i + 2);
      const op = OPS.includes(two) ? two : OPS.includes(c) || OPS2.includes(c) ? c : null;
      if (!op) throw new ScriptError(`Unexpected character '${c}'`, pos);
      out.push({ k: 'op', v: op, pos });
      adv(op.length);
    }
  }
  out.push({ k: 'eof', v: '', pos: { line, col } });
  return out;
}

// ------------------------------------------------------------------ AST

export type Expr =
  | { t: 'num'; v: number; pos: Pos; id: number }
  | { t: 'str'; v: string; pos: Pos; id: number }
  | { t: 'name'; name: string; pos: Pos; id: number }
  | { t: 'call'; name: string; args: Expr[]; named: Record<string, Expr>; pos: Pos; id: number }
  | { t: 'unary'; op: string; e: Expr; pos: Pos; id: number }
  | { t: 'bin'; op: string; a: Expr; b: Expr; pos: Pos; id: number }
  | { t: 'cond'; c: Expr; a: Expr; b: Expr; pos: Pos; id: number }
  | { t: 'index'; e: Expr; n: Expr; pos: Pos; id: number };

export type Stmt =
  | { t: 'assign'; name: string; persist: boolean; reassign: boolean; e: Expr; pos: Pos }
  | { t: 'expr'; e: Expr; pos: Pos };

/** Recursive-descent parser. Node ids are stable (source order) and name per-call-site buffers. */
class Parser {
  private p = 0;
  private nodes = 0;
  private depth = 0;
  constructor(private toks: Tok[]) {}

  private get cur(): Tok {
    return this.toks[this.p]!;
  }
  private kindAt(): TokKind {
    return this.toks[this.p]!.k;
  }
  private peek(k = 1): Tok {
    return this.toks[Math.min(this.toks.length - 1, this.p + k)]!;
  }
  private is(v: string): boolean {
    return this.cur.k === 'op' && this.cur.v === v;
  }
  private eat(v: string): Tok {
    if (!this.is(v)) throw new ScriptError(`Expected '${v}'`, this.cur.pos);
    return this.toks[this.p++]!;
  }
  private node<T extends Omit<Expr, 'id'>>(n: T): T & { id: number } {
    if (++this.nodes > MAX_NODES)
      throw new ScriptError(`Script is too large (max ${MAX_NODES} nodes)`, n.pos);
    return { ...n, id: this.nodes };
  }

  program(): Stmt[] {
    const out: Stmt[] = [];
    for (;;) {
      while (this.cur.k === 'nl') this.p++;
      if (this.cur.k === 'eof') return out;
      out.push(this.stmt());
      const k = this.kindAt();
      if (k !== 'nl' && k !== 'eof')
        throw new ScriptError(`Unexpected '${this.cur.v}'`, this.cur.pos);
    }
  }

  expressionOnly(): Expr {
    while (this.cur.k === 'nl') this.p++;
    const e = this.expr();
    while (this.kindAt() === 'nl') this.p++;
    if (this.kindAt() !== 'eof') throw new ScriptError(`Unexpected '${this.cur.v}'`, this.cur.pos);
    return e;
  }

  private stmt(): Stmt {
    const pos = this.cur.pos;
    let persist = false;
    // `let x = ...` is the same as `x = ...` (bindings are per-bar series, so x[1] is the previous bar).
    if (this.cur.k === 'id' && this.cur.v === 'let' && this.peek().k === 'id') this.p++;
    if (this.cur.k === 'id' && this.cur.v === 'var' && this.peek().k === 'id') {
      persist = true;
      this.p++;
    }
    if (
      this.cur.k === 'id' &&
      this.peek().k === 'op' &&
      (this.peek().v === '=' || this.peek().v === ':=')
    ) {
      const name = this.cur.v;
      this.p++;
      const reassign = this.cur.v === ':=';
      this.p++;
      return { t: 'assign', name, persist, reassign, e: this.expr(), pos };
    }
    if (persist) throw new ScriptError("Expected 'name = value' after var", pos);
    return { t: 'expr', e: this.expr(), pos };
  }

  private nest<T>(pos: Pos, f: () => T): T {
    if (++this.depth > MAX_DEPTH)
      throw new ScriptError(`Expression nested deeper than ${MAX_DEPTH} levels`, pos);
    try {
      return f();
    } finally {
      this.depth--;
    }
  }

  private expr(): Expr {
    return this.nest(this.cur.pos, () => this.exprInner());
  }

  private exprInner(): Expr {
    const c = this.or();
    if (!this.is('?')) return c;
    const pos = this.eat('?').pos;
    const a = this.expr();
    this.eat(':');
    const b = this.expr();
    return this.node({ t: 'cond', c, a, b, pos });
  }

  private kw(...names: string[]): boolean {
    return (this.cur.k === 'op' || this.cur.k === 'id') && names.includes(this.cur.v);
  }

  private or(): Expr {
    let a = this.and();
    while (this.kw('||', 'or')) {
      const pos = this.toks[this.p++]!.pos;
      a = this.node({ t: 'bin', op: '||', a, b: this.and(), pos });
    }
    return a;
  }
  private and(): Expr {
    let a = this.cmp();
    while (this.kw('&&', 'and')) {
      const pos = this.toks[this.p++]!.pos;
      a = this.node({ t: 'bin', op: '&&', a, b: this.cmp(), pos });
    }
    return a;
  }
  private cmp(): Expr {
    const a = this.add();
    if (this.cur.k === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(this.cur.v)) {
      const t = this.toks[this.p++]!;
      return this.node({ t: 'bin', op: t.v, a, b: this.add(), pos: t.pos });
    }
    return a;
  }
  private add(): Expr {
    let a = this.mul();
    while (this.is('+') || this.is('-')) {
      const t = this.toks[this.p++]!;
      a = this.node({ t: 'bin', op: t.v, a, b: this.mul(), pos: t.pos });
    }
    return a;
  }
  private mul(): Expr {
    let a = this.unary();
    while (this.is('*') || this.is('/') || this.is('%')) {
      const t = this.toks[this.p++]!;
      a = this.node({ t: 'bin', op: t.v, a, b: this.unary(), pos: t.pos });
    }
    return a;
  }
  private unary(): Expr {
    if (this.is('-') || this.is('+') || this.is('!') || this.kw('not')) {
      const t = this.toks[this.p++]!;
      const op = t.v === 'not' ? '!' : t.v;
      return this.node({ t: 'unary', op, e: this.nest(t.pos, () => this.unary()), pos: t.pos });
    }
    return this.pow();
  }
  private pow(): Expr {
    const a = this.postfix();
    if (this.is('^')) {
      const t = this.eat('^');
      return this.node({ t: 'bin', op: '^', a, b: this.unary(), pos: t.pos });
    }
    return a;
  }
  private postfix(): Expr {
    let e = this.primary();
    while (this.is('[')) {
      const pos = this.eat('[').pos;
      const n = this.expr();
      this.eat(']');
      e = this.node({ t: 'index', e, n, pos });
    }
    return e;
  }
  private primary(): Expr {
    const t = this.cur;
    if (t.k === 'num') {
      this.p++;
      return this.node({ t: 'num', v: Number(t.v), pos: t.pos });
    }
    if (t.k === 'str') {
      this.p++;
      return this.node({ t: 'str', v: t.v, pos: t.pos });
    }
    if (this.is('(')) {
      this.p++;
      const e = this.expr();
      this.eat(')');
      return e;
    }
    if (t.k === 'id') {
      this.p++;
      let name = t.v;
      // Only the declaration namespaces use dots (input.int, plot.line): no general member access.
      while (this.is('.')) {
        this.p++;
        if (this.cur.k !== 'id') throw new ScriptError('Expected a name after "."', this.cur.pos);
        name += `.${this.cur.v}`;
        this.p++;
      }
      if (this.is('(')) {
        this.p++;
        const args: Expr[] = [];
        const named: Record<string, Expr> = {};
        while (!this.is(')')) {
          if (this.cur.k === 'id' && this.peek().k === 'op' && this.peek().v === '=') {
            const key = this.cur.v;
            this.p += 2;
            named[key] = this.expr();
          } else {
            if (Object.keys(named).length)
              throw new ScriptError('Positional argument after a named one', this.cur.pos);
            args.push(this.expr());
          }
          if (!this.is(',')) break;
          this.p++;
        }
        this.eat(')');
        // iff(c, a, b) is the conditional; ref(x, n) is x[n] (the value n bars ago).
        const plain = !Object.keys(named).length;
        if (name === 'iff' && args.length === 3 && plain)
          return this.node({ t: 'cond', c: args[0]!, a: args[1]!, b: args[2]!, pos: t.pos });
        if (name === 'ref' && args.length === 2 && plain)
          return this.node({ t: 'index', e: args[0]!, n: args[1]!, pos: t.pos });
        if (name === 'iff' || name === 'ref')
          throw new ScriptError(`${name}() takes ${name === 'iff' ? 3 : 2} arguments`, t.pos);
        return this.node({ t: 'call', name, args, named, pos: t.pos });
      }
      return this.node({ t: 'name', name: NAME_ALIASES[name] ?? name, pos: t.pos });
    }
    throw new ScriptError(
      t.k === 'eof' ? 'Unexpected end of script' : `Unexpected '${t.v}'`,
      t.pos,
    );
  }
}

export function parseProgram(src: string): Stmt[] {
  return new Parser(lex(src)).program();
}

export function parseExpression(src: string): Expr {
  return new Parser(lex(src)).expressionOnly();
}
