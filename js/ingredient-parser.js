// =============================================================================
// INGREDIENT PARSER
// =============================================================================
// Splits a raw recipe line like:
//   "1 cup plain flour (all purpose flour)"
//   "150g / 5oz unsalted butter"
//   "3/4 cup white sugar , preferably caster / superfine"
// into structured pieces:
//   { qty: "1 cup", name: "plain flour", note: "all purpose flour" }
//
// Approach:
// 1. Strip recipe-internal noise (Note refs, "to taste", "or to taste")
// 2. Pull leading quantity (number + optional unit)
// 3. Pull parenthetical content into a note
// 4. Pull trailing comma-separated qualifier into a note
// =============================================================================

// Common units we recognise as part of the quantity.
// Order matters — longer phrases first.
const UNITS = [
  'tablespoons', 'tablespoon', 'tbsp', 'tbsps',
  'teaspoons', 'teaspoon', 'tsp', 'tsps',
  'cups', 'cup', 'c',
  'kilograms', 'kilogram', 'kgs', 'kg',
  'grams', 'gram', 'gms', 'gm', 'g',
  'pounds', 'pound', 'lbs', 'lb',
  'ounces', 'ounce', 'ozs', 'oz',
  'litres', 'litre', 'liters', 'liter', 'l',
  'millilitres', 'millilitre', 'milliliters', 'milliliter', 'mls', 'ml',
  'pints', 'pint', 'pt',
  'quarts', 'quart', 'qt',
  'fluid ounces', 'fluid ounce', 'fl oz', 'fl. oz.',
  'cloves', 'clove',
  'cans', 'can',
  'jars', 'jar',
  'packets', 'packet', 'pkt',
  'packs', 'pack',
  'pinches', 'pinch',
  'dashes', 'dash',
  'sprigs', 'sprig',
  'sticks', 'stick',
  'slices', 'slice',
  'bunches', 'bunch',
  'handfuls', 'handful',
  'pieces', 'piece',
];

// Patterns that should be stripped out entirely as recipe-internal noise.
const NOISE_PATTERNS = [
  /\(note[s]?\s*\d+\)/gi,            // (Note 1), (Notes 2)
  /\(see note[s]?\s*\d*\)/gi,        // (see note), (see notes 1)
  /,?\s*to taste\b/gi,                // ", to taste"
  /,?\s*or to taste\b/gi,             // ", or to taste"
  /,?\s*plus more for [^,()]+/gi,     // ", plus more for greasing"
  /,?\s*for serving\b/gi,
  /,?\s*for garnish\b/gi,
  /,?\s*for dusting\b/gi,
  /,?\s*divided\b/gi,
  /,?\s*optional\b/gi,
];

// Quantity prefix regex: matches numbers, fractions, ranges, and unicode fractions.
// Examples: "1", "1.5", "1/2", "1 1/2", "1-2", "½", "2 ½"
// Also matches common "150g / 5oz" dual-unit prefixes.
const QTY_REGEX = /^\s*(?:(?:\d+\s*\d*\/\d+|\d+(?:\.\d+)?|[¼½¾⅓⅔⅛⅜⅝⅞])\s*[-–]\s*)?(?:\d+\s*\d*\/\d+|\d+(?:\.\d+)?|[¼½¾⅓⅔⅛⅜⅝⅞])\s*(?:[a-zA-Z]+\.?)?(?:\s*\/\s*\d+(?:\.\d+)?\s*[a-zA-Z]+\.?)?\s*/;

export function parseIngredient(rawLine) {
  if (!rawLine || typeof rawLine !== 'string') {
    return { qty: '', name: '', note: '', original: String(rawLine || '') };
  }

  let line = rawLine.trim();
  // Strip leading bullet/decoration characters (▢, *, -, •, etc.)
  line = line.replace(/^[▢*•\-–—]\s*/, '').trim();

  const original = line;
  const noteParts = [];

  // 1. Extract parenthetical content into noteParts and remove from line.
  // Loop until no more matched pairs found, so nested/repeated parens both go.
  let prev;
  do {
    prev = line;
    line = line.replace(/\(([^()]*)\)/g, (_, inner) => {
      const trimmed = inner.trim();
      if (!trimmed) return ''; // empty parens, just drop
      // Skip noise like "Note 1"
      if (/^note[s]?\s*\d+$/i.test(trimmed)) return '';
      if (/^see note[s]?\s*\d*$/i.test(trimmed)) return '';
      noteParts.push(trimmed);
      return '';
    });
  } while (line !== prev);

  // Remove any orphan parentheses left over (unmatched opens/closes)
  line = line.replace(/[()]/g, '');

  // 2. Strip noise patterns
  NOISE_PATTERNS.forEach(pattern => {
    line = line.replace(pattern, '');
  });

  // 3. Pull off comma-separated qualifier (only if it looks descriptive, not a list)
  //    e.g. "white sugar, preferably caster" → name="white sugar", note="preferably caster"
  //    But "salt, pepper, garlic" should stay as-is — heuristic: only the FIRST comma
  //    and only if the chunk after looks like a descriptor (starts with preferably/at room
  //    temperature/finely chopped/etc., or is short).
  const commaIdx = line.indexOf(',');
  if (commaIdx > 0) {
    const before = line.slice(0, commaIdx).trim();
    const after = line.slice(commaIdx + 1).trim();
    if (looksLikeDescriptor(after)) {
      noteParts.push(after);
      line = before;
    }
  }

  // 4. Extract leading quantity
  let qty = '';
  const qtyMatch = line.match(QTY_REGEX);
  if (qtyMatch) {
    const candidate = qtyMatch[0].trim();
    // Verify the unit (or lack thereof) is sensible — if there's a unit-like word,
    // it should be in our UNITS list; otherwise just the number is fine.
    const unitMatch = candidate.match(/[a-zA-Z]+\.?$/);
    if (!unitMatch || isKnownUnit(unitMatch[0])) {
      qty = candidate;
      line = line.slice(qtyMatch[0].length).trim();
    } else {
      // Unit-like word that isn't a unit (e.g. "1 onion" — "onion" isn't a unit)
      // Just take the leading number(s) as quantity.
      const numMatch = candidate.match(/^[\d\s./¼½¾⅓⅔⅛⅜⅝⅞-]+/);
      if (numMatch) {
        qty = numMatch[0].trim();
        line = line.slice(numMatch[0].length).trim();
      }
    }
  }

  // 5. Clean up trailing/leading commas, semicolons, whitespace on the name
  let name = line.replace(/^[,;\s]+|[,;\s]+$/g, '').trim();

  // Title-case-ish cleanup: collapse multiple spaces
  name = name.replace(/\s+/g, ' ');

  // Sentence-case: capitalise first letter, leave rest as-is
  // (preserves brand names, proper nouns the user typed in correct case)
  name = sentenceCase(name);

  // Combine notes
  const note = noteParts
    .map(n => n.trim().replace(/^[,;\s]+|[,;\s]+$/g, ''))
    .filter(n => n.length > 0)
    .map(n => sentenceCase(n))
    .join('; ');

  return { qty, name, note, original };
}

export function sentenceCase(str) {
  if (!str) return '';
  // If the string is ALL CAPS (5+ chars), it's probably yelling — convert to lowercase first
  if (str.length >= 5 && str === str.toUpperCase() && /[A-Z]/.test(str)) {
    str = str.toLowerCase();
  }
  // Capitalise first letter, preserve the rest
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function looksLikeDescriptor(text) {
  if (!text) return false;
  // Multiple commas → probably a list, not a descriptor
  if (text.includes(',')) return false;
  // Starts with a descriptor keyword
  const descriptorStarts = /^(preferably|at room temperature|softened|melted|finely|coarsely|roughly|thinly|thickly|chopped|diced|minced|grated|sliced|crushed|peeled|deveined|trimmed|halved|quartered|cubed|julienned|shredded|drained|rinsed|cut into|cooled|warm|cold|hot|fresh|dried|toasted|raw|cooked|unsalted|salted|sweetened|unsweetened|optional|skin on|skin off|bone in|boneless|seedless|stemmed|deboned|cleaned|washed|whisked|beaten|optional|or)\b/i;
  if (descriptorStarts.test(text)) return true;
  // Short phrase (≤ 5 words) is likely descriptor
  if (text.split(/\s+/).length <= 5) return true;
  return false;
}

function isKnownUnit(word) {
  const lower = word.toLowerCase().replace(/\.$/, '');
  return UNITS.includes(lower);
}

// =============================================================================
// FILTER — decide whether a parsed ingredient should be kept
// =============================================================================
// Some lines aren't real ingredients — section headers like "For the sauce:",
// instructions disguised as ingredients, etc. Filter them out.

export function isRealIngredient(parsed) {
  if (!parsed.name) return false;
  const name = parsed.name.toLowerCase().trim();

  // Section headers
  if (/^(for|for the)\s/.test(name) && name.endsWith(':')) return false;
  if (name.endsWith(':') && name.split(/\s+/).length <= 4) return false;

  // Empty or numeric-only
  if (name.length < 2) return false;
  if (/^[\d\s.,]+$/.test(name)) return false;

  return true;
}
