/**
 * Prototype: generate a Python API for Mosaic marks directly from the
 * TypeScript source, without going through JSON Schema.
 *
 * The point is to show that the information the current pipeline discards
 * (inheritance, string-literal unions, per-property documentation) is still
 * present in the TypeScript AST and can be carried into Python.
 *
 * This is a research prototype, not a replacement for bin/generate-python-api.js.
 *
 * Run: node experiments/api-gen/extract.mjs [markName]
 */
import ts from 'typescript';
import { readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const SPEC_DIR = resolve(ROOT, 'packages/vgplot/spec/src/spec');

function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (f.endsWith('.ts')) out.push(p);
  }
  return out;
}

const files = walk(SPEC_DIR);
const program = ts.createProgram(files, {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  noEmit: true,
  skipLibCheck: true
});
const checker = program.getTypeChecker();

// ---------------------------------------------------------------------------
// Collect declarations
// ---------------------------------------------------------------------------

/** name -> { kind, node, sourceFile } */
const decls = new Map();

for (const sf of program.getSourceFiles()) {
  if (!sf.fileName.startsWith(SPEC_DIR)) continue;
  ts.forEachChild(sf, node => {
    if (ts.isInterfaceDeclaration(node)) {
      decls.set(node.name.text, { kind: 'interface', node, sf });
    } else if (ts.isTypeAliasDeclaration(node)) {
      decls.set(node.name.text, { kind: 'alias', node, sf });
    }
  });
}

/** Extract the TSDoc comment text attached to a node. */
function docOf(node) {
  const parts = ts.getJSDocCommentsAndTags(node);
  const texts = [];
  for (const p of parts) {
    if (ts.isJSDoc(p) && p.comment) {
      texts.push(typeof p.comment === 'string'
        ? p.comment
        : p.comment.map(c => c.text ?? '').join(''));
    }
  }
  return texts.join('\n\n').trim();
}

/** Direct `extends` parent names for an interface (declared, not resolved). */
function parentsOf(node) {
  const out = [];
  for (const h of node.heritageClauses ?? []) {
    if (h.token !== ts.SyntaxKind.ExtendsKeyword) continue;
    for (const t of h.types) {
      out.push({ text: t.getText(), expr: t.expression.getText(), node: t });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// TypeScript type -> Python type
// ---------------------------------------------------------------------------

const PRIMITIVES = {
  string: 'str', number: 'float', boolean: 'bool',
  null: 'None', undefined: 'None', any: 'Any', unknown: 'Any',
  never: 'Any', object: 'Any', Date: 'datetime', symbol: 'Any', void: 'None'
};

/** Flatten a union type node into its member type nodes. */
function unionMembers(t) {
  return ts.isUnionTypeNode(t) ? t.types.flatMap(unionMembers) : [t];
}

/** Resolve a type alias chain down to the node that actually defines it. */
function resolveAlias(name, seen = new Set()) {
  if (seen.has(name)) return null;
  seen.add(name);
  const d = decls.get(name);
  if (!d || d.kind !== 'alias') return null;
  const t = d.node.type;
  if (ts.isTypeReferenceNode(t) && ts.isIdentifier(t.typeName)) {
    const next = resolveAlias(t.typeName.text, seen);
    if (next) return next;
  }
  return { name, node: t };
}

/**
 * If a name resolves (possibly through alias chains) to a union of string
 * literals, return those literal values. This is the information the JSON
 * Schema path turns into an untyped `anyOf` blob.
 */
function literalValuesOf(name) {
  const r = resolveAlias(name);
  if (!r) return null;
  const members = unionMembers(r.node);
  const vals = [];
  for (const m of members) {
    if (ts.isLiteralTypeNode(m) && ts.isStringLiteral(m.literal)) {
      vals.push(m.literal.text);
    } else {
      return null; // not a pure string-literal union
    }
  }
  return vals.length ? vals : null;
}

const usedLiteralAliases = new Map(); // name -> string[]
const referencedNames = new Set();    // named types we emit but do not define

function pyType(t, depth = 0) {
  if (depth > 6) return 'Any';

  if (ts.isUnionTypeNode(t)) {
    // Collect string-literal members into a single Literal[...] and keep the
    // rest as-is. A mixed union like `'frame' | 'sphere' | boolean` becomes
    // `Literal["frame", "sphere"] | bool`, not three separate Literals.
    const lits = [];
    const others = [];
    for (const m of unionMembers(t)) {
      if (ts.isLiteralTypeNode(m) && ts.isStringLiteral(m.literal)) lits.push(m.literal.text);
      else others.push(pyType(m, depth + 1));
    }
    const parts = [];
    if (lits.length) parts.push(`Literal[${lits.map(v => JSON.stringify(v)).join(', ')}]`);
    parts.push(...others);
    return [...new Set(parts)].join(' | ');
  }

  if (ts.isParenthesizedTypeNode(t)) return pyType(t.type, depth + 1);
  if (ts.isArrayTypeNode(t)) return `list[${pyType(t.elementType, depth + 1)}]`;

  if (ts.isLiteralTypeNode(t)) {
    const l = t.literal;
    if (ts.isStringLiteral(l)) return `Literal[${JSON.stringify(l.text)}]`;
    if (l.kind === ts.SyntaxKind.NullKeyword) return 'None';
    if (l.kind === ts.SyntaxKind.TrueKeyword) return 'Literal[True]';
    if (l.kind === ts.SyntaxKind.FalseKeyword) return 'Literal[False]';
    if (ts.isNumericLiteral(l)) return `Literal[${l.text}]`;
  }

  switch (t.kind) {
    case ts.SyntaxKind.StringKeyword: return 'str';
    case ts.SyntaxKind.NumberKeyword: return 'float';
    case ts.SyntaxKind.BooleanKeyword: return 'bool';
    case ts.SyntaxKind.AnyKeyword:
    case ts.SyntaxKind.UnknownKeyword: return 'Any';
    case ts.SyntaxKind.NullKeyword: return 'None';
    case ts.SyntaxKind.UndefinedKeyword: return 'None';
    case ts.SyntaxKind.VoidKeyword: return 'None';
  }

  if (ts.isTypeReferenceNode(t)) {
    const name = t.typeName.getText();
    if (PRIMITIVES[name]) return PRIMITIVES[name];
    if (name === 'Array' && t.typeArguments?.length) {
      return `list[${pyType(t.typeArguments[0], depth + 1)}]`;
    }
    if (name === 'Record' && t.typeArguments?.length === 2) {
      return `dict[${pyType(t.typeArguments[0], depth + 1)}, ${pyType(t.typeArguments[1], depth + 1)}]`;
    }
    const lits = literalValuesOf(name);
    if (lits) {
      usedLiteralAliases.set(name, lits);
      return name; // emitted as `Name = Literal[...]`
    }
    if (decls.has(name)) { referencedNames.add(name); return name; }
    return 'Any';
  }

  if (ts.isFunctionTypeNode(t)) return 'Callable[..., Any]';
  if (ts.isTypeLiteralNode(t)) return 'dict[str, Any]';
  if (ts.isIndexedAccessTypeNode(t) || ts.isTypeOperatorNode(t)) return 'Any';

  return 'Any';
}

// ---------------------------------------------------------------------------
// Property collection, preserving the inheritance graph
// ---------------------------------------------------------------------------

/** Own (directly declared) properties of an interface. */
function ownProps(node) {
  const out = [];
  for (const m of node.members) {
    if (!ts.isPropertySignature(m) || !m.name) continue;
    out.push({
      name: m.name.getText().replace(/^['"]|['"]$/g, ''),
      optional: !!m.questionToken,
      type: m.type ? pyType(m.type) : 'Any',
      tsType: m.type ? m.type.getText().replace(/\s+/g, ' ') : 'any',
      doc: docOf(m)
    });
  }
  return out;
}

/**
 * Resolve the declared parents of an interface into base names we can emit as
 * Python base classes, plus any properties that a mapped type (Omit/Pick)
 * forces us to inline. Returns { bases, inlined, mapped }.
 */
function resolveParents(node) {
  const bases = [];
  const inlined = [];
  const mapped = [];
  for (const p of parentsOf(node)) {
    const expr = p.expr;
    // Only a plain interface can become a Python base class. A type alias
    // (including non-exported ones like `type GridScaleOptions = Pick<...>`)
    // has no runtime class to inherit from, so it gets inlined instead.
    if (decls.get(expr)?.kind === 'interface' && !p.node.typeArguments?.length) {
      bases.push(expr);
    } else {
      // Anything else in an `extends` clause is type-level computation
      // (Omit, Pick, Exclude, ...). JSON Schema cannot express these at all;
      // resolve with the checker and inline the resulting properties.
      const type = checker.getTypeAtLocation(p.node);
      const props = checker.getPropertiesOfType(type);
      mapped.push({ op: expr, text: p.text, count: props.length });
      for (const sym of props) {
        const d = sym.declarations?.[0];
        if (!d || !ts.isPropertySignature(d)) continue;
        inlined.push({
          name: sym.getName(),
          optional: !!d.questionToken,
          type: d.type ? pyType(d.type) : 'Any',
          tsType: d.type ? d.type.getText().replace(/\s+/g, ' ') : 'any',
          doc: docOf(d),
          from: expr
        });
      }
    }
  }
  return { bases, inlined, mapped };
}

/** Transitive closure of the inheritance graph for one interface. */
function ancestry(name, seen = new Set()) {
  if (seen.has(name) || !decls.has(name)) return seen;
  seen.add(name);
  const d = decls.get(name);
  if (d.kind !== 'interface') return seen;
  for (const b of resolveParents(d.node).bases) ancestry(b, seen);
  return seen;
}

/** All properties visible on an interface, with the source interface recorded. */
function allProps(name, acc = new Map(), seen = new Set()) {
  if (seen.has(name) || !decls.has(name)) return acc;
  seen.add(name);
  const d = decls.get(name);
  if (d.kind !== 'interface') return acc;
  const { bases, inlined } = resolveParents(d.node);
  for (const b of bases) allProps(b, acc, seen);
  for (const p of inlined) acc.set(p.name, { ...p, owner: name });
  for (const p of ownProps(d.node)) acc.set(p.name, { ...p, owner: name });
  return acc;
}

// ---------------------------------------------------------------------------
// Python emission
// ---------------------------------------------------------------------------

// Reuse Mosaic's own naming conventions so the prototype's Python surface
// matches what the project already ships.
const { camelCaseToSnake } = await import(
  resolve(ROOT, 'packages/vgplot/spec/src/util.js'));
const { PYTHON_KEYWORDS } = await import(
  resolve(ROOT, 'packages/vgplot/spec/src/python-codegen.js'));

const ident = n => {
  const s = camelCaseToSnake(n);
  return PYTHON_KEYWORDS.has(s) ? s + '_' : s;
};

/** Wrap a doc string to a width, indented, for a numpydoc Parameters block. */
function wrapDoc(text, indent, width = 79) {
  if (!text) return [];
  const lines = [];
  for (const para of text.split(/\n\s*\n/)) {
    const isList = /^\s*[-*]\s/.test(para);
    if (isList) {
      for (const l of para.split('\n')) {
        lines.push(indent + l.trim());
      }
      continue;
    }
    let cur = indent;
    for (const w of para.replace(/\s+/g, ' ').trim().split(' ')) {
      if (cur.length + w.length + 1 > width && cur.trim()) {
        lines.push(cur.trimEnd());
        cur = indent + w + ' ';
      } else {
        cur += w + ' ';
      }
    }
    if (cur.trim()) lines.push(cur.trimEnd());
    lines.push('');
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Make a TypeScript `extends A, B, C` list legal as Python base classes.
 *
 * TypeScript interfaces merge structurally and impose no ordering constraint,
 * so `extends GridOptions, MarkOptions, TextOptions` is fine even when
 * TextOptions itself extends MarkOptions. Python linearizes bases with C3 and
 * rejects that list outright. This is a concrete case where preserving the
 * source structure faithfully produces code the target language will not
 * accept, and where a target-specific rule has to intervene.
 *
 * Rule: drop bases already reachable through another base (redundant), then
 * order the survivors most-derived first.
 */
function linearize(bases) {
  const anc = new Map(bases.map(b => [b, ancestry(b)]));
  const kept = bases.filter(b =>
    !bases.some(o => o !== b && anc.get(o).has(b)));
  return kept.sort((a, b) => anc.get(b).size - anc.get(a).size);
}

/** Emit the mark's option interfaces as inheriting TypedDicts. */
function emitTypedDicts(roots) {
  // Post-order DFS: a base class must be emitted before anything that
  // inherits from it. A plain reverse of the visit order is not a
  // topological sort once multiple inheritance is involved.
  const chain = [];
  const seen = new Set();
  const visit = name => {
    if (seen.has(name)) return;
    seen.add(name);
    const d = decls.get(name);
    if (!d || d.kind !== 'interface') return;
    for (const b of resolveParents(d.node).bases) visit(b);
    chain.push(name);
  };
  for (const r of [roots].flat()) visit(r);

  const out = [];
  for (const name of chain) {
    const d = decls.get(name);
    if (!d || d.kind !== 'interface') continue;
    const { bases, inlined, mapped } = resolveParents(d.node);
    const own = ownProps(d.node);
    const baseList = linearize(bases).join(', ') || 'TypedDict';
    out.push(`class ${name}(${baseList}, total=False):`);
    const doc = docOf(d.node);
    if (doc) out.push(`    """${doc.split('\n')[0]}"""`);
    if (mapped.length) {
      for (const m of mapped) {
        out.push(`    # inlined from ${m.text} (${m.count} properties);`);
        out.push(`    # TypeScript type-level computation, no JSON Schema equivalent`);
      }
    }
    const props = [...inlined, ...own];
    if (!props.length && !mapped.length) out.push('    pass');
    for (const p of props) {
      if (p.doc) {
        const first = p.doc.replace(/\s+/g, ' ').trim();
        out.push(...wrapDoc(first, '    # ').map(l => l));
      }
      out.push(`    ${p.name}: ${p.type}`);
    }
    out.push('');
  }
  return out;
}

/** Sorted parameter list for a props map, excluding mark/data. */
function paramsFrom(props) {
  return [...props.values()]
    .filter(p => p.name !== 'mark' && p.name !== 'data')
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** numpydoc Parameters block for a parameter list. */
function docBlock(summary, params) {
  const lines = ['    """', ...wrapDoc(summary, '    '), '',
    '    Parameters', '    ----------',
    '    data : MarkData', '        The data source for the mark.'];
  for (const p of params) {
    lines.push(`    ${ident(p.name)} : ${p.type}`);
    lines.push(...(p.doc ? wrapDoc(p.doc, '        ') : ['        (undocumented)']));
  }
  lines.push('    """');
  return lines;
}

/** Emit the mark constructor with precise types and full docs. */
function emitFunction(markName, variants) {
  const rootName = variants ? variants.base : markName;
  const d = decls.get(rootName);
  const props = allProps(rootName);
  const markProp = props.get('mark');
  const markConst = markProp?.type?.match(/Literal\["(.+?)"\]/)?.[1] ?? markName.toLowerCase();
  const fnName = ident(markConst);
  const summary = markProp?.doc || docOf(d.node) || `The ${markConst} mark.`;

  const lines = [];

  if (variants) {
    // A discriminated union. Each branch gets its own @overload keyed on the
    // `type` literal, so a checker rejects options that belong to a different
    // branch. Flattening the branches into one signature, as the JSON Schema
    // path must, accepts specs the TypeScript API rejects.
    const seen = new Set();
    const union = new Map(props);
    for (const b of variants.branches) {
      const bp = allProps(b);
      const bparams = paramsFrom(new Map([...props, ...bp]));
      for (const [k, v] of bp) if (!union.has(k)) union.set(k, v);
      const disc = bp.get('type');
      const discLit = disc?.type?.match(/Literal\["(.+?)"\]/)?.[1];
      if (!discLit || seen.has(discLit)) continue;
      seen.add(discLit);
      lines.push('@overload');
      lines.push(`def ${fnName}(`);
      lines.push('    data: MarkData = None,');
      lines.push('    *,');
      lines.push(`    ${ident('type')}: Literal[${JSON.stringify(discLit)}],`);
      for (const p of bparams) {
        if (p.name === 'type') continue;
        lines.push(`    ${ident(p.name)}: ${p.type} | UNSET = UNSET,`);
      }
      lines.push(') -> Mark: ...');
      lines.push('');
    }
    const allParams = paramsFrom(union);
    lines.push(`def ${fnName}(data: MarkData = None, **options: Any) -> Mark:`);
    lines.push(...docBlock(summary, allParams));
    lines.push(`    return _mark(${JSON.stringify(markConst)}, {"data": data, **options})`);
    lines.push('');
    return { lines, params: allParams, props: union };
  }

  const params = paramsFrom(props);
  lines.push(`def ${fnName}(`);
  lines.push('    data: MarkData = None,');
  lines.push('    *,');
  for (const p of params) {
    lines.push(`    ${ident(p.name)}: ${p.type} | UNSET = UNSET,`);
  }
  lines.push(') -> Mark:');
  lines.push(...docBlock(summary, params));
  lines.push(`    return _mark(${JSON.stringify(markConst)}, locals())`);
  lines.push('');
  return { lines, params, props };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * A mark declared as `type X = Base & (A | B | C)` is a discriminated union:
 * each branch carries a distinct `type` literal and its own option set.
 * Returns { base, branches } or null.
 */
function variantsOf(name) {
  const d = decls.get(name);
  if (!d || d.kind !== 'alias') return null;
  const t = d.node.type;
  if (!ts.isIntersectionTypeNode(t)) return null;
  let base = null;
  let branches = null;
  for (const part of t.types) {
    const inner = ts.isParenthesizedTypeNode(part) ? part.type : part;
    if (ts.isTypeReferenceNode(inner) && decls.has(inner.typeName.getText())) {
      base = inner.typeName.getText();
    } else if (ts.isUnionTypeNode(inner)) {
      branches = unionMembers(inner)
        .filter(m => ts.isTypeReferenceNode(m))
        .map(m => m.typeName.getText())
        .filter(n => decls.has(n));
    }
  }
  return base && branches?.length ? { base, branches } : null;
}

/** Every declaration that yields a `mark: '<name>'` literal. */
function allMarkInterfaces() {
  const out = [];
  const covered = new Set();
  // discriminated-union marks first, so their base interface is not
  // reported separately
  for (const [name] of decls) {
    const v = variantsOf(name);
    if (!v) continue;
    const m = allProps(v.base).get('mark');
    const c = m?.type.match(/^Literal\["(.+?)"\]$/);
    if (c) { out.push({ iface: name, mark: c[1], variants: v }); covered.add(v.base); }
  }
  for (const [name, d] of decls) {
    if (d.kind !== 'interface' || covered.has(name)) continue;
    const m = allProps(name).get('mark');
    const c = m?.type.match(/^Literal\["(.+?)"\]$/);
    if (c) out.push({ iface: name, mark: c[1], variants: null });
  }
  return out.sort((a, b) => a.mark.localeCompare(b.mark));
}

/** True if the param carries recovered enum information. */
function hasLiteralInfo(type) {
  if (/Literal\[/.test(type)) return true;
  return type.split(' | ').some(p => usedLiteralAliases.has(p.trim()));
}

/** Build the full Python module for one mark interface. */
function buildModule(target, variants = variantsOf(target)) {
  usedLiteralAliases.clear();
  referencedNames.clear();
  const roots = variants ? [variants.base, ...variants.branches] : [target];
  const tds = emitTypedDicts(roots);
  const fn = emitFunction(target, variants);

  const defined = new Set([
    ...roots.flatMap(r => [...ancestry(r)]),
    ...usedLiteralAliases.keys()
  ]);
  const stubs = [...referencedNames].filter(n => !defined.has(n)).sort();

  const aliasLines = [];
  for (const [name, vals] of [...usedLiteralAliases].sort()) {
    aliasLines.push(`${name} = Literal[`);
    for (const v of vals) aliasLines.push(`    ${JSON.stringify(v)},`);
    aliasLines.push(']');
  }

  const lines = [
    '# Prototype output: generated directly from the TypeScript source,',
    '# bypassing JSON Schema.  experiments/api-gen/extract.mjs',
    '',
    'from __future__ import annotations',
    '',
    'from datetime import datetime',
    'from typing import Any, Callable, Literal, TypedDict, overload',
    '',
    'from vgplot._types import UNSET, MarkData',
    'from vgplot.plot import Mark',
    '',
    '',
    '# --- referenced spec types, stubbed so this module type-checks alone -----',
    '',
    ...stubs.map(n => `${n} = Any`),
    '',
    '',
    '# --- string-literal unions recovered from the TS source ------------------',
    '',
    ...aliasLines,
    '',
    '',
    '# --- option interfaces, inheritance preserved ----------------------------',
    '',
    ...tds,
    '',
    '# --- generated constructor ----------------------------------------------',
    '',
    'def _mark(name: str, args: dict[str, Any]) -> Mark:',
    '    """Build a Mark, dropping UNSET arguments (same contract as the',
    '    shipped generator in bin/generate-python-api.js)."""',
    '    data = args.pop("data", None)',
    '    opts = {k: v for k, v in args.items() if v is not UNSET}',
    '    return Mark(name, data, **opts)',
    '',
    '',
    ...fn.lines
  ];
  return { text: lines.join('\n'), fn, stubs };
}

const argv = process.argv.slice(2);
mkdirSync(resolve(__dirname, 'out'), { recursive: true });

if (argv[0] === '--all') {
  // ---- Step 2: does the approach generalize across every mark? ----
  const marks = allMarkInterfaces();
  const rows = [];
  let totalParams = 0, totalDoc = 0, totalLit = 0, totalAny = 0, totalMapped = 0;
  const aliasUnion = new Set();

  const emit = argv.includes('--emit');
  if (emit) mkdirSync(resolve(__dirname, 'out/all'), { recursive: true });
  for (const { iface, mark, variants } of marks) {
    const { fn, text } = buildModule(iface, variants);
    if (emit) writeFileSync(resolve(__dirname, `out/all/${ident(mark)}_generated.py`), text);
    const doc = fn.params.filter(p => p.doc).length;
    const lit = fn.params.filter(p => hasLiteralInfo(p.type)).length;
    const anyT = fn.params.filter(p => p.type === 'Any').length;
    const chain = ancestry(iface).size;
    for (const k of usedLiteralAliases.keys()) aliasUnion.add(k);
    totalParams += fn.params.length; totalDoc += doc; totalLit += lit; totalAny += anyT;
    rows.push({ mark, iface, chain, params: fn.params.length, doc, lit, anyT });
  }

  const pad = (s, n) => String(s).padEnd(n);
  const rpad = (s, n) => String(s).padStart(n);
  console.log(`${pad('mark', 16)}${rpad('chain', 6)}${rpad('params', 8)}${rpad('doc', 6)}${rpad('literal', 9)}${rpad('Any', 6)}`);
  console.log('-'.repeat(51));
  for (const r of rows) {
    console.log(`${pad(r.mark, 16)}${rpad(r.chain, 6)}${rpad(r.params, 8)}${rpad(r.doc, 6)}${rpad(r.lit, 9)}${rpad(r.anyT, 6)}`);
  }
  console.log('-'.repeat(51));
  console.log(`${pad('TOTAL ' + rows.length + ' marks', 16)}${rpad('', 6)}${rpad(totalParams, 8)}${rpad(totalDoc, 6)}${rpad(totalLit, 9)}${rpad(totalAny, 6)}`);
  console.log();
  console.log(`documented:            ${totalDoc}/${totalParams}  (${(100 * totalDoc / totalParams).toFixed(1)}%)`);
  console.log(`carrying enum values:  ${totalLit}/${totalParams}  (${(100 * totalLit / totalParams).toFixed(1)}%)`);
  console.log(`fell back to Any:      ${totalAny}/${totalParams}  (${(100 * totalAny / totalParams).toFixed(1)}%)`);
  console.log(`distinct literal enums recovered: ${aliasUnion.size}`);

  writeFileSync(resolve(__dirname, 'out/metrics.json'),
    JSON.stringify({ rows, totalParams, totalDoc, totalLit, totalAny, aliases: [...aliasUnion].sort() }, null, 2));
} else {
  const target = argv[0] || 'AreaY';
  if (!decls.has(target)) {
    console.error(`No declaration named ${target}`);
    process.exit(1);
  }
  const { text, fn, stubs } = buildModule(target);
  const outPath = resolve(__dirname, `out/${ident(target)}_generated.py`);
  writeFileSync(outPath, text);

  const chain = [...ancestry(target)];
  console.log(`target:              ${target}`);
  console.log(`inheritance chain:   ${chain.length} interfaces  [${chain.join(' <- ')}]`);
  console.log(`parameters:          ${fn.params.length}`);
  console.log(`with documentation:  ${fn.params.filter(p => p.doc).length}`);
  console.log(`carrying enum info:  ${fn.params.filter(p => hasLiteralInfo(p.type)).length}`);
  console.log(`literal enums:       ${usedLiteralAliases.size}`);
  console.log(`stubbed refs:        ${stubs.length}`);
  console.log(`written:             ${outPath}`);
}
