// =============================================================================
// UNITS
// =============================================================================
// Grocery-essential units only. Each unit belongs to a "group" (count, weight,
// volume) and has a conversion factor to the group's base unit.
//
// Price calculation works only when an item's qty unit and the recorded price
// unit are in the same group.
// =============================================================================

export const UNITS = {
  // Count
  each:  { label: 'each',  group: 'count',  factor: 1,    base: 'each',  short: 'ea' },
  pack:  { label: 'pack',  group: 'count',  factor: 1,    base: 'pack',  short: 'pk' },
  dozen: { label: 'dozen', group: 'count',  factor: 12,   base: 'each',  short: 'dz' },
  // Weight (base = grams)
  kg:    { label: 'kg',    group: 'weight', factor: 1000, base: 'g',     short: 'kg' },
  g:     { label: 'g',     group: 'weight', factor: 1,    base: 'g',     short: 'g'  },
  // Volume (base = millilitres)
  L:     { label: 'L',     group: 'volume', factor: 1000, base: 'mL',    short: 'L'  },
  mL:    { label: 'mL',    group: 'volume', factor: 1,    base: 'mL',    short: 'mL' },
};

// Display order in dropdowns
export const UNIT_KEYS = ['each', 'pack', 'dozen', 'kg', 'g', 'L', 'mL'];

export function unitGroup(unitKey) {
  return UNITS[unitKey]?.group || null;
}

export function unitLabel(unitKey) {
  return UNITS[unitKey]?.label || unitKey || '';
}

// Convert a quantity from one unit to another (must be in same group).
// Returns null if conversion isn't possible.
export function convert(amount, fromUnit, toUnit) {
  const from = UNITS[fromUnit];
  const to = UNITS[toUnit];
  if (!from || !to) return null;
  if (from.group !== to.group) return null;
  // Special case: 'pack' is a unit on its own — can't convert pack <-> each meaningfully
  // (we treat pack and each as same group "count" but with no conversion factor between them).
  // For simplicity: if both are count but different units (other than dozen <-> each),
  // refuse the conversion.
  if (from.group === 'count') {
    if (from === to) return amount;
    // dozen <-> each is fine
    const validPair = (from === UNITS.dozen && to === UNITS.each)
                   || (from === UNITS.each && to === UNITS.dozen);
    if (!validPair) return null;
  }
  // Convert via the base unit
  const inBase = amount * from.factor;
  return inBase / to.factor;
}

// Calculate estimated cost for an item given:
//   - itemQtyAmount: number (e.g. 500)
//   - itemQtyUnit: unit key (e.g. 'g')
//   - priceAmount: number (e.g. 12)
//   - priceUnit: unit key (e.g. 'kg')
// Returns null if units aren't compatible.
export function estimateCost(itemQtyAmount, itemQtyUnit, priceAmount, priceUnit) {
  if (!itemQtyAmount || !priceAmount) return null;
  const convertedQty = convert(itemQtyAmount, itemQtyUnit, priceUnit);
  if (convertedQty === null) return null;
  return convertedQty * priceAmount;
}

// Format a quantity nicely: "500 g", "2 kg", "1 L", "3 each" → "3 ea" optional
export function formatQty(amount, unitKey, options = {}) {
  if (!amount && amount !== 0) return '';
  if (!unitKey) return String(amount);
  const unit = UNITS[unitKey];
  const label = options.short ? (unit?.short || unitKey) : (unit?.label || unitKey);
  // Whole numbers without trailing .0
  const num = Number.isInteger(amount) ? amount : amount.toFixed(2).replace(/\.?0+$/, '');
  // No space before "g", "kg", "mL", "L" — looks tighter
  const tight = ['g', 'kg', 'mL', 'L'].includes(unitKey);
  return tight ? `${num}${label}` : `${num} ${label}`;
}
