"""
Compare the shipped JSON-Schema-derived Python API against the prototype
generated straight from the TypeScript source.

Two questions:
  1. Correctness. Does the prototype expose the same parameters per mark?
     A prettier API that changes the surface is not a drop-in improvement.
  2. Fidelity. How much type and documentation information does each carry?

Run: .venv/bin/python experiments/api-gen/compare.py
"""

from __future__ import annotations

import ast
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SHIPPED = ROOT / "packages/vgplot/vgplot-python/vgplot/_generated/marks.py"
PROTO_DIR = Path(__file__).resolve().parent / "out/all"


def params_of(tree: ast.Module) -> dict[str, dict[str, str]]:
    """mark name -> {param name: annotation source}

    A mark may be declared as several @overload signatures plus an
    implementation; the exposed surface is the union across them.
    """
    out: dict[str, dict[str, str]] = {}
    for node in tree.body:
        if not isinstance(node, ast.FunctionDef) or node.name.startswith("_"):
            continue
        args = out.setdefault(node.name, {})
        for a in node.args.kwonlyargs:
            ann = ast.unparse(a.annotation) if a.annotation else ""
            # keep the most informative annotation seen for this name
            if a.arg not in args or len(ann) > len(args[a.arg]):
                args[a.arg] = ann
    return out


def docs_of(tree: ast.Module) -> dict[str, str]:
    return {
        n.name: (ast.get_docstring(n) or "")
        for n in tree.body
        if isinstance(n, ast.FunctionDef) and not n.name.startswith("_")
    }


shipped_tree = ast.parse(SHIPPED.read_text())
shipped = params_of(shipped_tree)
shipped_docs = docs_of(shipped_tree)

proto: dict[str, dict[str, str]] = {}
proto_docs: dict[str, str] = {}
for f in sorted(PROTO_DIR.glob("*.py")):
    t = ast.parse(f.read_text())
    proto.update(params_of(t))
    proto_docs.update(docs_of(t))

print(f"shipped marks:   {len(shipped)}")
print(f"prototype marks: {len(proto)}")

only_shipped = sorted(set(shipped) - set(proto))
only_proto = sorted(set(proto) - set(shipped))
print(f"only in shipped: {only_shipped or 'none'}")
print(f"only in proto:   {only_proto or 'none'}")
print()

# --- 1. correctness: same parameter names? ---------------------------------
print("=" * 68)
print("1. PARAMETER-SET EQUIVALENCE")
print("=" * 68)
identical = 0
diffs = []
for m in sorted(set(shipped) & set(proto)):
    s, p = set(shipped[m]), set(proto[m])
    if s == p:
        identical += 1
    else:
        diffs.append((m, sorted(s - p), sorted(p - s)))

total = len(set(shipped) & set(proto))
print(f"identical parameter sets: {identical}/{total}")
for m, missing, extra in diffs:
    print(f"  {m}:")
    if missing:
        print(f"     in shipped only: {missing}")
    if extra:
        print(f"     in proto only:   {extra}")
print()

# --- 2. fidelity ------------------------------------------------------------
print("=" * 68)
print("2. INFORMATION CARRIED")
print("=" * 68)


def measure(table: dict[str, dict[str, str]], docs: dict[str, str], label: str):
    n_params = sum(len(v) for v in table.values())
    opaque = sum(
        1
        for v in table.values()
        for a in v.values()
        if a.replace(" ", "") in ("ChannelValue|UNSET", "Any|UNSET", "Any")
    )
    literal = sum(1 for v in table.values() for a in v.values() if "Literal[" in a)
    # a parameter is "documented" if its name appears in a numpydoc
    # Parameters block of its function docstring
    documented = 0
    for m, v in table.values.__self__.items() if False else table.items():
        body = docs.get(m, "")
        block = body.split("Parameters")[-1] if "Parameters" in body else ""
        for name in v:
            if re.search(rf"^\s*{re.escape(name)} : ", block, re.M):
                documented += 1
    print(f"{label}")
    print(f"   parameters:                {n_params}")
    print(f"   opaque (ChannelValue/Any): {opaque:5d}  ({100*opaque/n_params:.1f}%)")
    print(f"   carrying Literal[...]:     {literal:5d}  ({100*literal/n_params:.1f}%)")
    print(f"   documented per-parameter:  {documented:5d}  ({100*documented/n_params:.1f}%)")
    return dict(n=n_params, opaque=opaque, literal=literal, documented=documented)


a = measure(shipped, shipped_docs, "SHIPPED  (TS -> JSON Schema -> Python)")
print()
b = measure(proto, proto_docs, "PROTOTYPE (TS -> Python, direct)")

print()
print("=" * 68)
print("3. INHERITANCE")
print("=" * 68)
schema = json.loads((ROOT / "packages/vgplot/spec/dist/mosaic-schema.json").read_text())


def count_key(o, key):
    if isinstance(o, dict):
        return (key in o) + sum(count_key(v, key) for v in o.values())
    if isinstance(o, list):
        return sum(count_key(v, key) for v in o)
    return 0


print(f"   allOf nodes in the JSON schema:      {count_key(schema, 'allOf')}")
n_classes = sum(
    len([n for n in ast.parse(f.read_text()).body if isinstance(n, ast.ClassDef)])
    for f in PROTO_DIR.glob("*.py")
)
n_inheriting = sum(
    len(
        [
            n
            for n in ast.parse(f.read_text()).body
            if isinstance(n, ast.ClassDef)
            and [b for b in n.bases if getattr(b, "id", "") != "TypedDict"]
        ]
    )
    for f in PROTO_DIR.glob("*.py")
)
print(f"   TypedDict classes emitted by proto:  {n_classes}")
print(f"   ...that inherit from another:        {n_inheriting}")
