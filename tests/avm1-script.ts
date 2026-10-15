// A small compiler of ActionScript 1 source to AVM1 actions, for tests: the
// cases of the language's classes are hundreds of statements each, which
// read as source where the assembler's calls would not. It writes what
// Flash's own compiler writes for the same source, as far as a case can
// tell: DefineFunction for functions, DefineLocal for `var` in a function
// and SetVariable outside one, CallMethod for `o.m()`, Less2 and Greater
// for comparisons, and the short-circuit of `&&` and `||` by
// PushDuplicate and If.
//
//   script(`var a = [3, 1, 2]; trace(a.sort().join("-"));`)(new Avm1Assembler())
//
// The subset: statements `var`, assignments (`=`, `+=` and the other
// compound ones, `++` and `--` as statements), `if`/`else`, `while`, `do`,
// `for`, `for (k in o)`, `break` and `continue` (not out of a for..in),
// `return`, `function f() {}` and blocks; expressions with JavaScript's
// operators but assignment, literals of numbers, strings, arrays and
// objects, function expressions, `new`, `typeof`, `delete`, `instanceof`.
// `trace(e)` is the Trace action. A call of `__op("Name", ...values)`
// pushes the values and writes the action of that name, for the actions
// that no syntax writes (CastOp, ImplementsOp, Extends...).

import { Avm1Assembler, double, type SimpleAction } from "./avm1-assembler.ts";

type Token =
  | { kind: "num"; value: number }
  | { kind: "str"; value: string }
  | { kind: "id"; value: string }
  | { kind: "op"; value: string }
  | { kind: "end"; value: "" };

const PUNCTUATORS = [
  ">>>=",
  "===",
  "!==",
  ">>>",
  "<<=",
  ">>=",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "++",
  "--",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "&=",
  "|=",
  "^=",
  "<<",
  ">>",
];

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }

    if (source.startsWith("//", i)) {
      while (i < source.length && source[i] !== "\n") {
        i++;
      }
      continue;
    }

    if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? source.length : end + 2;
      continue;
    }

    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(source[i + 1] ?? ""))) {
      const m = /^(0[xX][0-9a-fA-F]+|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)/.exec(source.slice(i));
      if (!m) {
        throw new Error(`bad number at ${i}`);
      }

      tokens.push({ kind: "num", value: Number(m[0]) });
      i += m[0].length;
      continue;
    }

    if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(i)) as RegExpExecArray;
      tokens.push({ kind: "id", value: m[0] });
      i += m[0].length;
      continue;
    }

    if (c === '"' || c === "'") {
      let value = "";
      i++;
      while (source[i] !== c) {
        if (i >= source.length) {
          throw new Error("unterminated string");
        }

        if (source[i] === "\\") {
          const e = source[i + 1];
          i += 2;
          switch (e) {
            case "n":
              value += "\n";
              break;
            case "r":
              value += "\r";
              break;
            case "t":
              value += "\t";
              break;
            case "x":
              value += String.fromCharCode(Number.parseInt(source.slice(i, i + 2), 16));
              i += 2;
              break;
            case "u":
              value += String.fromCharCode(Number.parseInt(source.slice(i, i + 4), 16));
              i += 4;
              break;
            default:
              value += e;
          }
        } else {
          value += source[i++];
        }
      }

      i++;
      tokens.push({ kind: "str", value });
      continue;
    }

    const p = PUNCTUATORS.find((q) => source.startsWith(q, i)) ?? c;
    tokens.push({ kind: "op", value: p });
    i += p.length;
  }

  tokens.push({ kind: "end", value: "" });
  return tokens;
}

/** Binary operators by precedence, the loosest first, each with what it writes. */
const BINARY: Record<string, SimpleAction[]>[] = [
  { "|": ["BitOr"] },
  { "^": ["BitXor"] },
  { "&": ["BitAnd"] },
  {
    "==": ["Equals2"],
    "!=": ["Equals2", "Not"],
    "===": ["StrictEquals"],
    "!==": ["StrictEquals", "Not"],
  },
  {
    "<": ["Less2"],
    ">": ["Greater"],
    "<=": ["Greater", "Not"],
    ">=": ["Less2", "Not"],
    instanceof: ["InstanceOf"],
  },
  { "<<": ["BitLShift"], ">>": ["BitRShift"], ">>>": ["BitURShift"] },
  { "+": ["Add2"], "-": ["Subtract"] },
  { "*": ["Multiply"], "/": ["Divide"], "%": ["Modulo"] },
];

const COMPOUND: Record<string, SimpleAction> = {
  "+=": "Add2",
  "-=": "Subtract",
  "*=": "Multiply",
  "/=": "Divide",
  "%=": "Modulo",
  "&=": "BitAnd",
  "|=": "BitOr",
  "^=": "BitXor",
  "<<=": "BitLShift",
  ">>=": "BitRShift",
  ">>>=": "BitURShift",
};

/** Where an assignment stores: a variable, or a member of an object the code pushed. */
type Place = { kind: "var"; name: string } | { kind: "member"; object: Emit; key: Emit };

type Emit = (a: Avm1Assembler) => void;

interface Loop {
  breakLabel: string;
  continueLabel: string;
}

let labels = 0;
const fresh = (what: string) => `${what}${labels++}`;

class Parser {
  private i = 0;
  private loops: Loop[] = [];
  private inFunction = false;

  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  program(): Emit[] {
    const statements: Emit[] = [];
    while (this.peek().kind !== "end") {
      statements.push(this.statement());
    }

    return statements;
  }

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.i + offset, this.tokens.length - 1)];
  }

  private next(): Token {
    return this.tokens[this.i++];
  }

  private is(value: string): boolean {
    const t = this.peek();
    return (t.kind === "op" || t.kind === "id") && t.value === value;
  }

  private eat(value: string): boolean {
    if (this.is(value)) {
      this.i++;
      return true;
    }

    return false;
  }

  private expect(value: string): void {
    if (!this.eat(value)) {
      throw new Error(`expected ${value}, found ${this.peek().value} at token ${this.i}`);
    }
  }

  private identifier(): string {
    const t = this.next();
    if (t.kind !== "id") {
      throw new Error(`expected a name, found ${t.value}`);
    }

    return t.value;
  }

  private semicolon(): void {
    this.eat(";");
  }

  private statement(): Emit {
    if (this.eat("{")) {
      const body: Emit[] = [];
      while (!this.eat("}")) {
        body.push(this.statement());
      }

      return (a) => {
        for (const s of body) {
          s(a);
        }
      };
    }

    if (this.eat(";")) {
      return () => {};
    }

    if (this.is("var")) {
      this.next();
      const decls: Emit[] = [];
      do {
        const name = this.identifier();
        const value = this.eat("=") ? this.expression() : null;
        const local = this.inFunction;
        decls.push((a) => {
          a.push(name);
          if (value) {
            value(a);
            a.op(local ? "DefineLocal" : "SetVariable");
          } else if (local) {
            a.op("DefineLocal2");
          } else {
            a.push(undefined).op("SetVariable");
          }
        });
      } while (this.eat(","));
      this.semicolon();
      return (a) => {
        for (const d of decls) {
          d(a);
        }
      };
    }

    if (this.is("function") && this.peek(1).kind === "id") {
      this.next();
      const name = this.identifier();
      const fn = this.functionRest(name);
      return fn;
    }

    if (this.eat("if")) {
      this.expect("(");
      const cond = this.expression();
      this.expect(")");
      const then = this.statement();
      const otherwise = this.eat("else") ? this.statement() : null;
      return (a) => {
        const elseLabel = fresh("else");
        const endLabel = fresh("endif");
        cond(a);
        a.op("Not").if(elseLabel);
        then(a);
        if (otherwise) {
          a.jump(endLabel);
        }
        a.label(elseLabel);
        if (otherwise) {
          otherwise(a);
          a.label(endLabel);
        }
      };
    }

    if (this.eat("while")) {
      this.expect("(");
      const cond = this.expression();
      this.expect(")");
      const loop = { breakLabel: fresh("break"), continueLabel: fresh("continue") };
      const body = this.loopBody(loop);
      return (a) => {
        a.label(loop.continueLabel);
        cond(a);
        a.op("Not").if(loop.breakLabel);
        body(a);
        a.jump(loop.continueLabel).label(loop.breakLabel);
      };
    }

    if (this.eat("do")) {
      const loop = { breakLabel: fresh("break"), continueLabel: fresh("continue") };
      const body = this.loopBody(loop);
      this.expect("while");
      this.expect("(");
      const cond = this.expression();
      this.expect(")");
      this.semicolon();
      return (a) => {
        const top = fresh("do");
        a.label(top);
        body(a);
        a.label(loop.continueLabel);
        cond(a);
        a.if(top).label(loop.breakLabel);
      };
    }

    if (this.eat("for")) {
      this.expect("(");
      if (
        (this.peek().kind === "id" && this.peek(1).value === "in") ||
        (this.is("var") && this.peek(2).value === "in")
      ) {
        this.eat("var");
        const name = this.identifier();
        this.expect("in");
        const object = this.expression();
        this.expect(")");
        const loop = { breakLabel: "", continueLabel: fresh("in") };
        const body = this.loopBody(loop);
        return (a) => {
          const out = fresh("out");
          object(a);
          a.op("Enumerate2").label(loop.continueLabel);
          // The terminator, undefined, equals null: what is left of the names is popped there.
          a.op("PushDuplicate").push(null).op("Equals2").if(out);
          a.push(name).op("StackSwap").op("SetVariable");
          body(a);
          a.jump(loop.continueLabel).label(out).op("Pop");
        };
      }

      const init = this.is(";") ? null : this.simpleStatement(true);
      this.expect(";");
      const cond = this.is(";") ? null : this.expression();
      this.expect(";");
      const step = this.is(")") ? null : this.simpleStatement(false);
      this.expect(")");
      const loop = { breakLabel: fresh("break"), continueLabel: fresh("continue") };
      const body = this.loopBody(loop);
      return (a) => {
        const top = fresh("for");
        init?.(a);
        a.label(top);
        if (cond) {
          cond(a);
          a.op("Not").if(loop.breakLabel);
        }
        body(a);
        a.label(loop.continueLabel);
        step?.(a);
        a.jump(top).label(loop.breakLabel);
      };
    }

    if (this.eat("break")) {
      const loop = this.loops.at(-1);
      if (!loop?.breakLabel) {
        throw new Error("break outside a loop, or out of a for..in");
      }

      this.semicolon();
      return (a) => {
        a.jump(loop.breakLabel);
      };
    }

    if (this.eat("continue")) {
      const loop = this.loops.at(-1);
      if (!loop) {
        throw new Error("continue outside a loop");
      }

      this.semicolon();
      return (a) => {
        a.jump(loop.continueLabel);
      };
    }

    if (this.eat("return")) {
      const value = this.is(";") || this.is("}") ? null : this.expression();
      this.semicolon();
      return (a) => {
        if (value) {
          value(a);
        } else {
          a.push(undefined);
        }
        a.op("Return");
      };
    }

    const s = this.simpleStatement(false);
    this.semicolon();
    return s;
  }

  private loopBody(loop: Loop): Emit {
    this.loops.push(loop);
    try {
      return this.statement();
    } finally {
      this.loops.pop();
    }
  }

  /** An assignment, `++`, `--`, `trace(e)`, or an expression whose value is dropped. */
  private simpleStatement(allowVar: boolean): Emit {
    if (allowVar && this.is("var")) {
      this.next();
      const name = this.identifier();
      this.expect("=");
      const value = this.expression();
      const local = this.inFunction;
      return (a) => {
        a.push(name);
        value(a);
        a.op(local ? "DefineLocal" : "SetVariable");
      };
    }

    if (this.is("trace") && this.peek(1).value === "(") {
      this.next();
      this.expect("(");
      const value = this.expression();
      this.expect(")");
      return (a) => {
        value(a);
        a.trace();
      };
    }

    const start = this.i;
    this.postfix();
    const place = this.lastPlace;
    const t = this.peek();
    if (place && t.kind === "op" && (t.value === "=" || t.value in COMPOUND)) {
      this.next();
      const value = this.expression();
      const action = COMPOUND[t.value];
      return (a) =>
        this.store(a, place, (b) => {
          if (action) {
            this.load(b, place);
            value(b);
            b.op(action);
          } else {
            value(b);
          }
        });
    }

    if (place && t.kind === "op" && (t.value === "++" || t.value === "--")) {
      this.next();
      const action: SimpleAction = t.value === "++" ? "Increment" : "Decrement";
      return (a) =>
        this.store(a, place, (b) => {
          this.load(b, place);
          b.op(action);
        });
    }

    this.i = start;
    const value = this.expression();
    return (a) => {
      value(a);
      a.pop();
    };
  }

  /** Where the last postfix expression parsed stores, if it is a variable or a member. */
  private lastPlace: Place | null = null;

  private store(a: Avm1Assembler, place: Place, value: Emit): void {
    if (place.kind === "var") {
      a.push(place.name);
      value(a);
      a.op("SetVariable");
    } else {
      place.object(a);
      place.key(a);
      value(a);
      a.op("SetMember");
    }
  }

  private load(a: Avm1Assembler, place: Place): void {
    if (place.kind === "var") {
      a.push(place.name).op("GetVariable");
    } else {
      place.object(a);
      place.key(a);
      a.op("GetMember");
    }
  }

  private functionRest(name: string): Emit {
    this.expect("(");
    const params: string[] = [];
    while (!this.eat(")")) {
      params.push(this.identifier());
      this.eat(",");
    }

    this.expect("{");
    const outer = this.inFunction;
    const loops = this.loops;
    this.inFunction = true;
    this.loops = [];
    const body: Emit[] = [];
    while (!this.eat("}")) {
      body.push(this.statement());
    }

    this.inFunction = outer;
    this.loops = loops;
    return (a) => {
      const b = new Avm1Assembler();
      for (const s of body) {
        s(b);
      }
      a.defineFunction(name, params, b);
    };
  }

  expression(): Emit {
    const cond = this.logical(0);
    if (!this.eat("?")) {
      return cond;
    }

    const yes = this.expression();
    this.expect(":");
    const no = this.expression();
    return (a) => {
      const yesLabel = fresh("yes");
      const end = fresh("end");
      cond(a);
      a.if(yesLabel);
      no(a);
      a.jump(end).label(yesLabel);
      yes(a);
      a.label(end);
    };
  }

  /** `||` (level 0) and `&&` (level 1), short-circuiting as Flash writes them. */
  private logical(level: number): Emit {
    const op = level === 0 ? "||" : "&&";
    let left = level === 0 ? this.logical(1) : this.binary(0);
    while (this.eat(op)) {
      const l = left;
      const right = level === 0 ? this.logical(1) : this.binary(0);
      left = (a) => {
        const end = fresh("sc");
        l(a);
        a.op("PushDuplicate");
        if (op === "&&") {
          a.op("Not");
        }
        a.if(end).pop();
        right(a);
        a.label(end);
      };
    }

    return left;
  }

  private binary(level: number): Emit {
    if (level === BINARY.length) {
      return this.unary();
    }

    let left = this.binary(level + 1);
    for (;;) {
      const t = this.peek();
      const actions = (t.kind === "op" || t.kind === "id") && BINARY[level][t.value];
      if (!actions || !Object.hasOwn(BINARY[level], t.value)) {
        return left;
      }

      this.next();
      const l = left;
      const right = this.binary(level + 1);
      left = (a) => {
        l(a);
        right(a);
        for (const action of actions) {
          a.op(action);
        }
      };
    }
  }

  private unary(): Emit {
    if (this.eat("!")) {
      const e = this.unary();
      return (a) => {
        e(a);
        a.op("Not");
      };
    }

    if (this.eat("-")) {
      const t = this.peek();
      if (t.kind === "num") {
        this.next();
        return (a) => {
          pushNumber(a, -t.value);
        };
      }

      const e = this.unary();
      return (a) => {
        a.push(0);
        e(a);
        a.op("Subtract");
      };
    }

    if (this.eat("+")) {
      const e = this.unary();
      return (a) => {
        e(a);
        a.op("ToNumber");
      };
    }

    if (this.eat("~")) {
      const e = this.unary();
      return (a) => {
        e(a);
        a.push(double(4294967295)).op("BitXor");
      };
    }

    if (this.eat("typeof")) {
      const e = this.unary();
      return (a) => {
        e(a);
        a.op("TypeOf");
      };
    }

    if (this.eat("void")) {
      const e = this.unary();
      return (a) => {
        e(a);
        a.pop().push(undefined);
      };
    }

    if (this.eat("delete")) {
      this.postfix();
      const place = this.lastPlace;
      if (!place) {
        throw new Error("delete of no variable or member");
      }

      return (a) => {
        if (place.kind === "var") {
          a.push(place.name).op("Delete2");
        } else {
          place.object(a);
          place.key(a);
          a.op("Delete");
        }
      };
    }

    const e = this.postfix();
    this.lastPlace = null;
    return e;
  }

  private postfix(): Emit {
    let e: Emit;
    let place: Place | null = null;
    if (this.eat("new")) {
      // `new` of a name or a member, with its arguments.
      const t = this.next();
      if (t.kind !== "id") {
        throw new Error("new of no name");
      }

      let object: Emit | null = null;
      let key: Emit = (a) => {
        a.push(t.value);
      };
      while (this.is(".") || this.is("[")) {
        const o: Emit = object
          ? ((prev, k) => (a: Avm1Assembler) => {
              prev(a);
              k(a);
              a.op("GetMember");
            })(object, key)
          : ((name) => (a: Avm1Assembler) => {
              a.push(name).op("GetVariable");
            })(t.value);
        object = o;
        key = this.memberKey();
      }

      const args = this.is("(") ? this.arguments() : [];
      const obj = object;
      const k = key;
      e = (a) => {
        pushArgs(a, args);
        if (obj) {
          obj(a);
          k(a);
          a.op("NewMethod");
        } else {
          k(a);
          a.op("NewObject");
        }
      };
    } else {
      const primary = this.primary();
      e = primary.emit;
      place = primary.place;
    }

    for (;;) {
      if (this.is(".") || this.is("[")) {
        const object = e;
        const key = this.memberKey();
        place = { kind: "member", object, key };
        e = (a) => {
          object(a);
          key(a);
          a.op("GetMember");
        };
        continue;
      }

      if (this.is("(") && place?.kind === "var" && place.name === "__op") {
        this.expect("(");
        const name = this.next();
        if (name.kind !== "str") {
          throw new Error("__op takes an action's name first");
        }

        const values: Emit[] = [];
        while (this.eat(",")) {
          values.push(this.expression());
        }
        this.expect(")");
        e = (a) => {
          for (const v of values) {
            v(a);
          }
          a.op(name.value as SimpleAction);
        };
        place = null;
        continue;
      }

      if (this.is("(")) {
        const args = this.arguments();
        const callee = place;
        const fn = e;
        if (callee?.kind === "var") {
          e = (a) => {
            pushArgs(a, args);
            a.push(callee.name).op("CallFunction");
          };
        } else if (callee?.kind === "member") {
          e = (a) => {
            pushArgs(a, args);
            callee.object(a);
            callee.key(a);
            a.op("CallMethod");
          };
        } else {
          e = (a) => {
            pushArgs(a, args);
            fn(a);
            a.push(undefined).op("CallMethod");
          };
        }

        place = null;
        continue;
      }

      break;
    }

    this.lastPlace = place;
    return e;
  }

  private memberKey(): Emit {
    if (this.eat(".")) {
      const name = this.identifier();
      return (a) => {
        a.push(name);
      };
    }

    this.expect("[");
    const key = this.expression();
    this.expect("]");
    return key;
  }

  private arguments(): Emit[] {
    this.expect("(");
    const args: Emit[] = [];
    while (!this.eat(")")) {
      args.push(this.expression());
      this.eat(",");
    }

    return args;
  }

  private primary(): { emit: Emit; place: Place | null } {
    const t = this.next();
    switch (t.kind) {
      case "num":
        return { emit: (a) => pushNumber(a, t.value), place: null };
      case "str":
        return {
          emit: (a) => {
            a.push(t.value);
          },
          place: null,
        };
      case "id":
        switch (t.value) {
          case "true":
          case "false":
            return {
              emit: (a) => {
                a.push(t.value === "true");
              },
              place: null,
            };
          case "null":
            return {
              emit: (a) => {
                a.push(null);
              },
              place: null,
            };
          case "undefined":
            return {
              emit: (a) => {
                a.push(undefined);
              },
              place: null,
            };
          case "function":
            return { emit: this.functionRest(""), place: null };
        }

        return {
          emit: (a) => {
            a.push(t.value).op("GetVariable");
          },
          place: { kind: "var", name: t.value },
        };
      case "op":
        if (t.value === "(") {
          const e = this.expression();
          this.expect(")");
          return { emit: e, place: null };
        }

        if (t.value === "[") {
          const elements: Emit[] = [];
          while (!this.eat("]")) {
            elements.push(this.expression());
            this.eat(",");
          }

          return {
            emit: (a) => {
              pushArgs(a, elements);
              a.op("InitArray");
            },
            place: null,
          };
        }

        if (t.value === "{") {
          const pairs: [string, Emit][] = [];
          while (!this.eat("}")) {
            const k = this.next();
            if (k.kind === "end" || k.kind === "op") {
              throw new Error("bad object literal");
            }

            this.expect(":");
            pairs.push([String(k.value), this.expression()]);
            this.eat(",");
          }

          return {
            emit: (a) => {
              for (const [name, value] of pairs) {
                a.push(name);
                value(a);
              }
              a.push(pairs.length).op("InitObject");
            },
            place: null,
          };
        }
    }

    throw new Error(`unexpected ${t.value} at token ${this.i - 1}`);
  }
}

function pushNumber(a: Avm1Assembler, n: number): void {
  if (Object.is(n, -0) || (n | 0) !== n) {
    a.push(double(n));
  } else {
    a.push(n);
  }
}

/** Arguments as calls take them: the last first, then their count. */
function pushArgs(a: Avm1Assembler, args: Emit[]): void {
  for (let i = args.length - 1; i >= 0; i--) {
    args[i](a);
  }
  a.push(args.length);
}

/** The statements of `source`, written to the assembler they are given. */
export function script(source: string): (a: Avm1Assembler) => Avm1Assembler {
  const statements = new Parser(tokenize(source)).program();
  return (a) => {
    for (const s of statements) {
      s(a);
    }
    return a;
  };
}
