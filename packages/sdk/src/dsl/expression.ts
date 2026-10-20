// Expression language for declarative endpoints, workflows and collections. It is a small JavaScript-like
// subset: literals, dotted paths, arithmetic, comparison, logic, math functions, and array helpers with
// arrow lambdas. Templates `{{expr}}` embed expressions in strings. Evaluation is pure: no host access.

export class ExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpressionError";
  }
}

export type Scope = Readonly<Record<string, unknown>>;

type Token =
  | { kind: "num"; value: number }
  | { kind: "str"; value: string }
  | { kind: "id"; value: string }
  | { kind: "op"; value: string }
  | { kind: "eof" };

const OPERATORS = ["===", "!==", "==", "!=", "<=", ">=", "&&", "||", "=>", "+", "-", "*", "/", "%", "<", ">", "!", "(", ")", "[", "]", ",", ".", "?", ":"];

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(source[i + 1] ?? ""))) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(source.slice(i))!;
      tokens.push({ kind: "num", value: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(i))!;
      tokens.push({ kind: "id", value: m[0] });
      i += m[0].length;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let out = "";
      let j = i + 1;
      while (j < source.length && source[j] !== ch) {
        if (source[j] === "\\" && j + 1 < source.length) {
          const next = source[j + 1]!;
          out += next === "n" ? "\n" : next === "t" ? "\t" : next;
          j += 2;
        } else {
          out += source[j];
          j++;
        }
      }
      if (j >= source.length) throw new ExpressionError("unterminated string literal");
      tokens.push({ kind: "str", value: out });
      i = j + 1;
      continue;
    }
    const op = OPERATORS.find((candidate) => source.startsWith(candidate, i));
    if (!op) throw new ExpressionError(`unexpected character "${ch}"`);
    tokens.push({ kind: "op", value: op });
    i += op.length;
  }
  tokens.push({ kind: "eof" });
  return tokens;
}

// AST nodes. Kept as plain objects so compiled expressions can be inspected and cached.
type Node =
  | { t: "lit"; v: unknown }
  | { t: "path"; name: string }
  | { t: "member"; obj: Node; key: Node | string }
  | { t: "call"; name: string; args: Node[] }
  | { t: "unary"; op: string; arg: Node }
  | { t: "binary"; op: string; left: Node; right: Node }
  | { t: "lambda"; param: string; body: Node }
  | { t: "array"; items: Node[] }
  | { t: "cond"; test: Node; yes: Node; no: Node };

const MAX_DEPTH = 64;

class Parser {
  private pos = 0;
  private depth = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): Node {
    const node = this.ternary();
    if (this.peek().kind !== "eof") throw new ExpressionError("unexpected trailing input");
    return node;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    return this.tokens[this.pos++]!;
  }

  private isOp(value: string): boolean {
    const t = this.peek();
    return t.kind === "op" && t.value === value;
  }

  private expectOp(value: string): void {
    if (!this.isOp(value)) throw new ExpressionError(`expected "${value}"`);
    this.pos++;
  }

  private enter(): void {
    if (++this.depth > MAX_DEPTH) throw new ExpressionError("expression is nested too deeply");
  }

  private leave(): void {
    this.depth--;
  }

  private ternary(): Node {
    this.enter();
    const test = this.binary(0);
    let node = test;
    if (this.isOp("?")) {
      this.pos++;
      const yes = this.ternary();
      this.expectOp(":");
      const no = this.ternary();
      node = { t: "cond", test, yes, no };
    }
    this.leave();
    return node;
  }

  private static readonly LEVELS: readonly (readonly string[])[] = [
    ["||"],
    ["&&"],
    ["===", "!==", "==", "!="],
    ["<", "<=", ">", ">="],
    ["+", "-"],
    ["*", "/", "%"],
  ];

  private binary(level: number): Node {
    if (level >= Parser.LEVELS.length) return this.unary();
    let left = this.binary(level + 1);
    for (;;) {
      const t = this.peek();
      if (t.kind !== "op" || !Parser.LEVELS[level]!.includes(t.value)) return left;
      this.pos++;
      const right = this.binary(level + 1);
      left = { t: "binary", op: t.value, left, right };
    }
  }

  private unary(): Node {
    if (this.isOp("!") || this.isOp("-")) {
      const opToken = this.next();
      const op = opToken.kind === "op" ? opToken.value : "";
      return { t: "unary", op, arg: this.unary() };
    }
    return this.postfix(this.primary());
  }

  private postfix(start: Node): Node {
    let node = start;
    for (;;) {
      if (this.isOp(".")) {
        this.pos++;
        const id = this.next();
        if (id.kind !== "id") throw new ExpressionError("expected property name after '.'");
        node = { t: "member", obj: node, key: id.value };
      } else if (this.isOp("[")) {
        this.pos++;
        const prop = this.ternary();
        this.expectOp("]");
        node = { t: "member", obj: node, key: prop };
      } else {
        return node;
      }
    }
  }

  private primary(): Node {
    const t = this.next();
    if (t.kind === "num") return { t: "lit", v: t.value };
    if (t.kind === "str") return { t: "lit", v: t.value };
    if (t.kind === "op" && t.value === "(") {
      const inner = this.ternary();
      this.expectOp(")");
      return inner;
    }
    if (t.kind === "op" && t.value === "[") {
      const items: Node[] = [];
      while (!this.isOp("]")) {
        items.push(this.ternary());
        if (this.isOp(",")) this.pos++;
        else break;
      }
      this.expectOp("]");
      return { t: "array", items };
    }
    if (t.kind === "id") {
      if (t.value === "true") return { t: "lit", v: true };
      if (t.value === "false") return { t: "lit", v: false };
      if (t.value === "null") return { t: "lit", v: null };
      if (t.value === "undefined") return { t: "lit", v: undefined };
      if (this.isOp("=>")) {
        this.pos++;
        return { t: "lambda", param: t.value, body: this.ternary() };
      }
      if (this.isOp("(")) {
        this.pos++;
        const args: Node[] = [];
        while (!this.isOp(")")) {
          args.push(this.ternary());
          if (this.isOp(",")) this.pos++;
          else break;
        }
        this.expectOp(")");
        return { t: "call", name: t.value, args };
      }
      return { t: "path", name: t.value };
    }
    throw new ExpressionError("unexpected token in expression");
  }
}

const compiled = new Map<string, Node>();
const CACHE_LIMIT = 512;

function compile(source: string): Node {
  const hit = compiled.get(source);
  if (hit) return hit;
  const node = new Parser(tokenize(source)).parse();
  if (compiled.size >= CACHE_LIMIT) compiled.delete(compiled.keys().next().value as string);
  compiled.set(source, node);
  return node;
}

// JavaScript-compatible coercions for the operators the language exposes.
export function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === null) return 0;
  if (value === undefined) return Number.NaN;
  if (typeof value === "string") {
    if (value.trim() === "") return 0;
    return Number(value);
  }
  return Number.NaN;
}

export function toText(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function isTruthy(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "number") return value !== 0 && !Number.isNaN(value);
  if (typeof value === "string") return value !== "";
  return Boolean(value);
}

export function looseEquals(a: unknown, b: unknown): boolean {
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (typeof a === typeof b) return a === b;
  if (typeof a === "object" || typeof b === "object") return false;
  return toNumber(a) === toNumber(b);
}

function jsMin(values: number[]): number {
  return values.reduce((acc, v) => (Number.isNaN(v) || Number.isNaN(acc) ? Number.NaN : Math.min(acc, v)), Infinity);
}

function jsMax(values: number[]): number {
  return values.reduce((acc, v) => (Number.isNaN(v) || Number.isNaN(acc) ? Number.NaN : Math.max(acc, v)), -Infinity);
}

function requireArgs(name: string, args: unknown[], count: number): void {
  if (args.length !== count) throw new ExpressionError(`${name}() takes ${count} argument(s)`);
}

export interface EvalOptions {
  // Clock for now()/nowS()/hour()/dayOfWeek(). Injected so evaluation stays deterministic in tests.
  now?: () => number;
  // Throws `Unresolved variable` for an unknown name and `has no property` for a missing member instead of
  // yielding undefined. Compute steps use it to defer a value until the keys it reads have been computed.
  strict?: boolean;
}

class Evaluator {
  constructor(
    private readonly scope: Scope,
    private readonly options: EvalOptions,
  ) {}

  eval(node: Node, locals: Readonly<Record<string, unknown>>): unknown {
    switch (node.t) {
      case "lit":
        return node.v;
      case "path": {
        if (Object.prototype.hasOwnProperty.call(locals, node.name)) return locals[node.name];
        if (Object.prototype.hasOwnProperty.call(this.scope, node.name)) return this.scope[node.name];
        if (this.options.strict === true) throw new ExpressionError(`Unresolved variable "${node.name}"`);
        return undefined;
      }
      case "member": {
        const obj = this.eval(node.obj, locals);
        if (obj === null || obj === undefined) return undefined;
        const prop = typeof node.key === "string" ? node.key : this.eval(node.key, locals);
        if (Array.isArray(obj) && typeof prop === "number") return obj[prop];
        if (typeof obj === "object") {
          const key = String(prop);
          if (this.options.strict === true && !(key in obj)) throw new ExpressionError(`"${key}" has no property`);
          return Reflect.get(obj, key);
        }
        return undefined;
      }
      case "unary": {
        const v = this.eval(node.arg, locals);
        return node.op === "!" ? !isTruthy(v) : -toNumber(v);
      }
      case "binary":
        return this.binary(node, locals);
      case "cond":
        return isTruthy(this.eval(node.test, locals)) ? this.eval(node.yes, locals) : this.eval(node.no, locals);
      case "array":
        return node.items.map((item) => this.eval(item, locals));
      case "lambda":
        throw new ExpressionError("lambda used outside an array helper");
      case "call":
        return this.call(node.name, node.args, locals);
    }
  }

  private binary(node: Extract<Node, { t: "binary" }>, locals: Readonly<Record<string, unknown>>): unknown {
    if (node.op === "&&") return isTruthy(this.eval(node.left, locals)) ? this.eval(node.right, locals) : false;
    if (node.op === "||") {
      const left = this.eval(node.left, locals);
      return isTruthy(left) ? left : this.eval(node.right, locals);
    }
    const a = this.eval(node.left, locals);
    const b = this.eval(node.right, locals);
    switch (node.op) {
      case "+":
        if (typeof a === "string" || typeof b === "string") return toText(a) + toText(b);
        return toNumber(a) + toNumber(b);
      case "-":
        return toNumber(a) - toNumber(b);
      case "*":
        return toNumber(a) * toNumber(b);
      case "/":
        return toNumber(a) / toNumber(b);
      case "%":
        return toNumber(a) % toNumber(b);
      case "==":
        return looseEquals(a, b);
      case "!=":
        return !looseEquals(a, b);
      case "===":
        return a === b;
      case "!==":
        return a !== b;
      case "<":
        return compareOrdered(a, b) < 0;
      case "<=":
        return compareOrdered(a, b) <= 0;
      case ">":
        return compareOrdered(a, b) > 0;
      case ">=":
        return compareOrdered(a, b) >= 0;
      default:
        throw new ExpressionError(`unknown operator ${node.op}`);
    }
  }

  private lambdaOf(node: Node | undefined, name: string): { param: string; body: Node } {
    if (!node || node.t !== "lambda") throw new ExpressionError(`${name}() expects an arrow function`);
    return { param: node.param, body: node.body };
  }

  private arrayArg(node: Node | undefined, locals: Readonly<Record<string, unknown>>, name: string): unknown[] {
    const value = node ? this.eval(node, locals) : undefined;
    if (!Array.isArray(value)) throw new ExpressionError(`${name}() expects an array`);
    return value;
  }

  private call(name: string, args: Node[], locals: Readonly<Record<string, unknown>>): unknown {
    const now = this.options.now ?? (() => Date.now());
    switch (name) {
      case "floor":
      case "ceil":
      case "abs":
      case "log10": {
        requireArgs(name, args, 1);
        const v = toNumber(this.eval(args[0]!, locals));
        if (name === "floor") return Math.floor(v);
        if (name === "ceil") return Math.ceil(v);
        if (name === "abs") return Math.abs(v);
        return Math.log10(v);
      }
      case "round": {
        requireArgs(name, args, 1);
        return Math.floor(toNumber(this.eval(args[0]!, locals)) + 0.5);
      }
      case "pow": {
        requireArgs(name, args, 2);
        return Math.pow(toNumber(this.eval(args[0]!, locals)), toNumber(this.eval(args[1]!, locals)));
      }
      case "clamp": {
        requireArgs(name, args, 3);
        const [v, lo, hi] = args.map((a) => toNumber(this.eval(a, locals)));
        return Math.max(lo!, Math.min(hi!, v!));
      }
      case "min":
      case "max": {
        if (args.length === 1) {
          const arr = this.arrayArg(args[0], locals, name);
          return name === "min" ? jsMin(arr.map(toNumber)) : jsMax(arr.map(toNumber));
        }
        if (args.length < 2) throw new ExpressionError(`${name}() requires at least 2 arguments`);
        const values = args.map((a) => toNumber(this.eval(a, locals)));
        return name === "min" ? jsMin(values) : jsMax(values);
      }
      case "diffMs":
        requireArgs(name, args, 2);
        return toNumber(this.eval(args[0]!, locals)) - toNumber(this.eval(args[1]!, locals));
      case "diffS":
        requireArgs(name, args, 2);
        return (toNumber(this.eval(args[0]!, locals)) - toNumber(this.eval(args[1]!, locals))) / 1000;
      case "now":
        requireArgs(name, args, 0);
        return now();
      case "nowS":
        requireArgs(name, args, 0);
        return Math.floor(now() / 1000);
      case "hour":
        requireArgs(name, args, 0);
        return new Date(now()).getUTCHours();
      case "dayOfWeek":
        requireArgs(name, args, 0);
        return new Date(now()).getUTCDay();
      case "length": {
        requireArgs(name, args, 1);
        const v = this.eval(args[0]!, locals);
        if (typeof v === "string" || Array.isArray(v)) return v.length;
        if (v && typeof v === "object") return Object.keys(v).length;
        return 0;
      }
      case "values": {
        requireArgs(name, args, 1);
        const v = this.eval(args[0]!, locals);
        return v && typeof v === "object" && !Array.isArray(v) ? Object.values(v) : [];
      }
      case "count": {
        const arr = this.arrayArg(args[0], locals, name);
        if (args.length < 2) return arr.length;
        const { param, body } = this.lambdaOf(args[1], name);
        return arr.filter((item) => isTruthy(this.eval(body, { ...locals, [param]: item }))).length;
      }
      case "sum":
      case "avg": {
        const arr = this.arrayArg(args[0], locals, name);
        const selector = args[1] ? this.lambdaOf(args[1], name) : null;
        const values = arr.map((item) =>
          selector ? toNumber(this.eval(selector.body, { ...locals, [selector.param]: item })) : toNumber(item),
        );
        const total = values.reduce((acc, v) => acc + v, 0);
        return name === "sum" ? total : values.length === 0 ? 0 : total / values.length;
      }
      case "any":
      case "all": {
        const arr = this.arrayArg(args[0], locals, name);
        if (args.length < 2) return name === "any" ? arr.some(isTruthy) : arr.every(isTruthy);
        const { param, body } = this.lambdaOf(args[1], name);
        const test = (item: unknown) => isTruthy(this.eval(body, { ...locals, [param]: item }));
        return name === "any" ? arr.some(test) : arr.every(test);
      }
      case "first":
      case "find": {
        const arr = this.arrayArg(args[0], locals, name);
        if (args.length < 2) return arr[0] ?? null;
        const { param, body } = this.lambdaOf(args[1], name);
        return arr.find((item) => isTruthy(this.eval(body, { ...locals, [param]: item }))) ?? null;
      }
      case "filter": {
        const arr = this.arrayArg(args[0], locals, name);
        const { param, body } = this.lambdaOf(args[1], name);
        return arr.filter((item) => isTruthy(this.eval(body, { ...locals, [param]: item })));
      }
      case "pluck": {
        requireArgs(name, args, 2);
        const arr = this.arrayArg(args[0], locals, name);
        const key = toText(this.eval(args[1]!, locals));
        return arr.map((item) => (item && typeof item === "object" ? Reflect.get(item, key) : undefined));
      }
      default:
        throw new ExpressionError(`unknown function ${name}()`);
    }
  }
}

function compareOrdered(a: unknown, b: unknown): number {
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  const x = toNumber(a);
  const y = toNumber(b);
  if (Number.isNaN(x) || Number.isNaN(y)) return Number.NaN;
  return x < y ? -1 : x > y ? 1 : 0;
}

// Evaluates a bare expression such as `max(0, currentValue)` or `ores.stone + 1`.
export function evaluateExpression(source: string, scope: Scope, options: EvalOptions = {}): unknown {
  return new Evaluator(scope, options).eval(compile(source), {});
}

const SINGLE_TEMPLATE = /^\{\{([^{}]+)\}\}$/;
const TEMPLATE = /\{\{([^{}]+)\}\}/g;

// Resolves templates in any JSON-shaped value. A string that is exactly one `{{expr}}` keeps the expression's
// type; mixed text is interpolated as text. Non-template strings pass through unchanged.
export function resolveTemplate(value: unknown, scope: Scope, options: EvalOptions = {}): unknown {
  if (typeof value === "string") {
    const single = SINGLE_TEMPLATE.exec(value);
    if (single) return evaluateExpression(single[1]!.trim(), scope, options);
    if (!value.includes("{{")) return value;
    return value.replace(TEMPLATE, (_match, inner: string) => toText(evaluateExpression(inner.trim(), scope, options)));
  }
  if (Array.isArray(value)) return value.map((item) => resolveTemplate(item, scope, options));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = resolveTemplate(item, scope, options);
    return out;
  }
  return value;
}
// Substitutes each `{{expr}}` in an expression source with the value's source text (strings are quoted).
export function inlineTemplates(source: string, scope: Scope, options: EvalOptions = {}): string {
  return source.replace(TEMPLATE, (_match, inner: string) => {
    const value = evaluateExpression(inner.trim(), scope, options);
    return typeof value === "string" ? JSON.stringify(value) : toText(value);
  });
}

// Compares two already-resolved values with a declarative operator.
export function compareValues(left: unknown, op: string, right: unknown): boolean {
  switch (op) {
    case "==":
    case "===":
      return looseEquals(left, right);
    case "!=":
    case "!==":
      return !looseEquals(left, right);
    case ">":
      return compareOrdered(left, right) > 0;
    case ">=":
      return compareOrdered(left, right) >= 0;
    case "<":
      return compareOrdered(left, right) < 0;
    case "<=":
      return compareOrdered(left, right) <= 0;
    default:
      throw new ExpressionError(`unknown comparison operator "${op}"`);
  }
}

// Evaluates a declarative check `{ field, op, value }` where field and value may be templates.
export function evaluateCheck(check: { field: unknown; op: string; value: unknown }, scope: Scope, options: EvalOptions = {}): boolean {
  return compareValues(resolveTemplate(check.field, scope, options), check.op, resolveTemplate(check.value, scope, options));
}
