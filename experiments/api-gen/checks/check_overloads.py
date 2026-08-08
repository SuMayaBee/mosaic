# Does the discriminated-union overload actually reject a mismatched option?
#
# `curve` belongs to the areaX/lineX density variants. `symbol` belongs to the
# dotX variant. The TypeScript type rejects mixing them; the shipped Python API
# accepts both on every variant, because JSON Schema flattened the union.

from density_x_generated import density_x

# valid: curve goes with the areaX variant
density_x(type_="areaX", curve="linear")

# valid: symbol goes with the dotX variant
density_x(type_="dotX", symbol="circle")

# invalid: curve is not an option of the dotX variant
density_x(type_="dotX", curve="linear")

# invalid: symbol is not an option of the areaX variant
density_x(type_="areaX", symbol="circle")
