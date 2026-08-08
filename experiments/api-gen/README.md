# Generating the vgplot Python API from TypeScript directly

A research prototype exploring the question Dominik Moritz raised in
[#1075](https://github.com/uwdata/mosaic/issues/1075) and
[#395](https://github.com/uwdata/mosaic/issues/395#issuecomment-3634061011):

> Going `TS/pydantic/msgspec/or something else -> JSON Schema -> Python API`
> seems not ideal since JSON schema doesn't support a lot of things like
> inheritance so I'd like to cut it out of the equation if possible.

This is **not** a proposed replacement for `bin/generate-python-api.js`. It is a
measurement: how much of what the current pipeline discards is still available
if you read the TypeScript source directly?

## Running it

```bash
node experiments/api-gen/extract.mjs AreaY      # one mark -> out/area_y_generated.py
node experiments/api-gen/extract.mjs --all      # metrics table for every mark
node experiments/api-gen/extract.mjs --all --emit   # write all 65 modules

.venv/bin/python experiments/api-gen/compare.py     # shipped vs prototype
.venv/bin/ty check experiments/api-gen/out/all/     # generated code type-checks
.venv/bin/ty check --extra-search-path experiments/api-gen/out/all \
                   experiments/api-gen/checks/      # 2 expected errors
```

No new dependencies. It uses the `typescript` already in `node_modules`
(6.0.3) and reuses `camelCaseToSnake` and `PYTHON_KEYWORDS` from
`packages/vgplot/spec/src/` so the Python surface matches what ships.

## What the current pipeline loses

Measured on `main` @ `b3eca5aa`.

**Stage 1, TypeScript to JSON Schema.**

| | |
| --- | --- |
| interfaces in `packages/vgplot/spec/src/spec` | 238 |
| ...that extend another interface | 181 (76%) |
| ...with multiple inheritance | 111 (47%), up to 5 parents |
| `allOf` nodes in `dist/mosaic-schema.json` | **0** |
| property slots after flattening | 17,553 |
| schema size | 8.5 MB |

`allOf` is JSON Schema's only way to express inheritance. There are none, so
all 181 inheritance relationships are gone and 238 interfaces expand into
17,553 flattened property slots.

**Stage 2, JSON Schema to Python.** The schema still carries 12,422 property
descriptions. None of them reach the generated Python.

## Result

Same API surface, far more information carried.

| | shipped | prototype |
| --- | --- | --- |
| marks | 65 | 65 |
| **parameter sets identical** | | **65 / 65** |
| parameters | 3,454 | 3,454 |
| opaque (`ChannelValue`/`Any`) | 3,454 (100%) | 462 (13.4%) |
| carrying `Literal[...]` | 0 | 359 (10.4%) |
| documented per parameter | 0 | **3,454 (100%)** |
| inheriting classes emitted | 0 | 147 of 341 |

All 65 generated modules pass `ty check` with no errors.

Parameter-set equivalence is the important row. The prototype is not a
different API that happens to look nicer; it accepts exactly the same
arguments for every one of the 65 marks.

### Before and after

```python
# shipped
def area_y(data=None, *, curve: ChannelValue | UNSET = UNSET, ...): ...

# prototype
def area_y(
    data: MarkData = None,
    *,
    curve: Curve | ParamRef | UNSET = UNSET,
    clip: Literal["frame", "sphere"] | bool | None | ParamRef | UNSET = UNSET,
    facet: Literal["auto", "include", "exclude", "super"] | bool | None | ParamRef | UNSET = UNSET,
    ...
) -> Mark:
    """
    A horizontally-oriented area mark, where the baseline and topline share
    **x** values, as in a time-series area chart where time goes right.

    Parameters
    ----------
    curve : Curve | ParamRef
        The curve (interpolation) method for connecting adjacent points. ...
    """
```

with `Curve = Literal["basis", "basis-closed", ..., "step-before"]`, all 20
values recovered. Nine such enums are recovered in total.

## Two findings that are not about type annotations

### 1. `Exclude` where `Omit` was meant

`packages/vgplot/spec/src/spec/marks/Dot.ts:143,149`

```ts
export interface Circle extends MarkData, Exclude<DotOptions, 'symbol'> { ... }
export interface Hexagon extends MarkData, Exclude<DotOptions, 'symbol'> { ... }
```

`Exclude<T, U>` filters members of a *union*. `DotOptions` is an object type,
so `Exclude<DotOptions, 'symbol'>` is just `DotOptions` and the exclusion never
happens. Both marks still accept `symbol`, which the author clearly intended to
remove. Confirmed in the shipped schema: `Circle` and `Hexagon` both have a
`symbol` property. The fix is `Omit`.

### 2. Flattening a discriminated union widens the API

`DensityX` is declared as

```ts
export type DensityX = DensityXBase & (
  DensityAreaXOptions | DensityLineXOptions | DensityDotXOptions | DensityTextXOptions
);
```

with a `type: 'areaX' | 'lineX' | 'dotX' | 'textX'` discriminator.

The JSON schema *does* preserve this. `DensityX` is emitted as four `anyOf`
branches, each carrying a `type` const and its own property set (the `areaX`
branch has `curve` and no `symbol`; the `dotX` branch has `symbol` and no
`curve`). The correlation survives the schema step.

It is lost one step later, in `bin/generate-python-api.js`. `markInfo()` merges
the branches:

```js
for (const b of branches) {
  const c = b.properties?.mark?.const;
  if (c) { consts.add(c); Object.assign(props, b.properties); }  // <- merge
}
```

so the four option sets collapse into one signature. The result accepts specs
the TypeScript API rejects:

```python
density_x(type_="dotX", curve="linear")     # curve is an areaX/lineX option
density_x(type_="areaX", symbol="circle")   # symbol is a dotX option
```

The shipped `density_x` accepts both. Python expresses this correctly with
`@overload` keyed on the discriminator, and both calls are then rejected. See
`checks/check_overloads.py`.

Unlike the inheritance loss, this one does not need a new pipeline: the
information is present in the schema and could be recovered by emitting
overloads from the `anyOf` branches in the existing generator.

## Where the approach needed target-specific rules

Two places where faithfully preserving the source structure produced Python
that is wrong or illegal. These are the interesting cases, because they are
where a generic "preserve everything" strategy is not sufficient and a
target-language rule has to intervene.

- **MRO.** `AxisOptions extends GridOptions, MarkOptions, TextOptions`, but
  `TextOptions` already extends `MarkOptions`. TypeScript interfaces merge
  structurally with no ordering constraint; Python linearizes bases with C3 and
  rejects that base list outright. `linearize()` drops bases reachable through
  another base and orders the rest most-derived first.
- **Type aliases are not classes.** `type GridScaleOptions = Pick<ScaleOptions, ...>`
  can appear in an `extends` clause in TypeScript but has no Python class to
  inherit from, so it has to be inlined.

## Limits

- Python only. The claim that idiom rules are separable is not tested until a
  second, structurally different target exists.
- 462 parameters (13.4%) still fall back to `ChannelValue`/`Any`. Most are
  genuinely open channel types; 20 are prototype gaps.
- Marks only. Plot attributes, interactors, inputs, legends, and transforms are
  untouched.
- The type mapping is hand-written for Python. Turning it into declared data
  rather than code is the actual research step, and is not done here.
