// =============================================================================
// CATEGORY ICONS & COLOURS
// =============================================================================
// Each category has an icon (from Lucide) and a colour ramp. Defaults are
// keyed by category ID for the seeded categories, plus keyword detection for
// new categories the user creates.
//
// Lucide icons are loaded as inline SVG via the lucide CDN. We use the static
// SVG approach — fetch once, render via innerHTML.
// =============================================================================

// 9 colour ramps, matching the design system. Each entry has the bg/text
// pair we use for the rounded-square category badge.
export const COLOUR_RAMPS = {
  // Greens
  green:      { bg: '#EAF3DE', text: '#3B6D11', dark_bg: '#27500A', dark_text: '#C0DD97', label: 'Green' },
  lime:       { bg: '#EEF5D6', text: '#4A6C00', dark_bg: '#344D00', dark_text: '#C8DE85', label: 'Lime' },
  teal:       { bg: '#E1F5EE', text: '#0F6E56', dark_bg: '#085041', dark_text: '#9FE1CB', label: 'Teal' },
  // Blues
  blue:       { bg: '#E6F1FB', text: '#185FA5', dark_bg: '#0C447C', dark_text: '#B5D4F4', label: 'Blue' },
  sky:        { bg: '#E0F4FC', text: '#0B6E8E', dark_bg: '#075269', dark_text: '#95DAEF', label: 'Sky' },
  indigo:     { bg: '#EAF0FD', text: '#2D4FAA', dark_bg: '#1E3880', dark_text: '#BACAF8', label: 'Indigo' },
  // Purples & Pinks
  purple:     { bg: '#EEEDFE', text: '#534AB7', dark_bg: '#3C3489', dark_text: '#CECBF6', label: 'Purple' },
  violet:     { bg: '#F4EFFE', text: '#6B35B8', dark_bg: '#4E238A', dark_text: '#D4B8F5', label: 'Violet' },
  pink:       { bg: '#FBEAF0', text: '#993556', dark_bg: '#72243E', dark_text: '#F4C0D1', label: 'Pink' },
  rose:       { bg: '#FDECEC', text: '#AC2A2A', dark_bg: '#821E1E', dark_text: '#F5B8B8', label: 'Rose' },
  // Reds & Oranges
  red:        { bg: '#FCEBEB', text: '#A32D2D', dark_bg: '#791F1F', dark_text: '#F7C1C1', label: 'Red' },
  coral:      { bg: '#FAECE7', text: '#993C1D', dark_bg: '#712B13', dark_text: '#F5C4B3', label: 'Coral' },
  orange:     { bg: '#FDF0E3', text: '#8F4A0A', dark_bg: '#6A3507', dark_text: '#F8C88D', label: 'Orange' },
  // Yellows & Ambers
  amber:      { bg: '#FAEEDA', text: '#854F0B', dark_bg: '#633806', dark_text: '#FAC775', label: 'Amber' },
  yellow:     { bg: '#FBF5D5', text: '#7A6200', dark_bg: '#5A4700', dark_text: '#F5DC72', label: 'Yellow' },
  // Neutrals
  gray:       { bg: '#F1EFE8', text: '#5F5E5A', dark_bg: '#444441', dark_text: '#D3D1C7', label: 'Gray' },
  slate:      { bg: '#EEF1F3', text: '#4A5568', dark_bg: '#343E4E', dark_text: '#C4CDD9', label: 'Slate' },
  brown:      { bg: '#F2EBE3', text: '#6B4423', dark_bg: '#4E3018', dark_text: '#D9BDA5', label: 'Brown' },
};

// Lucide icon names we'll offer. Names match Lucide's catalog at lucide.dev/icons.
// The picker in the UI shows these in a grid.
// Icon names verified to exist in lucide-static@0.363.0.
// When adding new icons, check https://lucide.dev/icons first.
export const AVAILABLE_ICONS = [
  // Produce & fresh
  'apple', 'carrot', 'cherry', 'leaf', 'salad',
  // Meat & seafood
  'beef', 'fish', 'ham', 'drumstick', 'egg',
  // Dairy & bakery
  'milk', 'wheat', 'cookie', 'croissant', 'cake-slice',
  // Pantry & drinks
  'soup', 'utensils', 'coffee', 'wine', 'beer',
  // Frozen
  'snowflake', 'thermometer',
  // Household & cleaning
  'spray-can', 'trash-2', 'shirt', 'sparkles',
  // Health & personal
  'pill', 'heart', 'heart-pulse', 'activity', 'baby',
  // Hardware & tools
  'wrench', 'hammer', 'zap', 'settings',
  'droplets', 'flame', 'shield',
  'layers', 'paintbrush', 'pen-tool',
  'spade', 'tree-pine', 'sun',
  'lock', 'key',
  // Home
  'home', 'armchair', 'lamp', 'tv',
  'package', 'box', 'archive', 'briefcase',
  // Transport & outdoors
  'car', 'bike', 'map-pin', 'compass',
  // Generic / fallback
  'shopping-bag', 'shopping-cart', 'tag', 'list', 'grid',
  'building', 'wallet', 'file-text', 'camera',
  // Pets & kids
  'paw-print', 'star', 'gift',
];

// Defaults for the seeded categories (matches DEFAULT_CATEGORIES in data.js).
// New categories get gray + shopping-bag, but the user can edit.
const DEFAULT_CATEGORY_STYLE = {
  produce:   { icon: 'carrot',     colour: 'green'  },
  bakery:    { icon: 'croissant',  colour: 'amber'  },
  dairy:     { icon: 'milk',       colour: 'blue'   },
  meat:      { icon: 'beef',       colour: 'red'    },
  frozen:    { icon: 'snowflake',  colour: 'teal'   },
  pantry:    { icon: 'soup',       colour: 'coral'  },
  household: { icon: 'spray-can',  colour: 'purple' },
  other:     { icon: 'shopping-bag', colour: 'gray' },
};

// Keyword detection for guessing icon/colour on user-created categories.
// Order matters — first match wins.
const KEYWORD_GUESSES = [
  { match: /produce|fruit|veg|vegetable/i,          icon: 'carrot',      colour: 'green'  },
  { match: /bakery|bread|baking|baked/i,            icon: 'croissant',   colour: 'amber'  },
  { match: /dairy|milk|cheese|yog/i,                icon: 'milk',        colour: 'blue'   },
  { match: /meat|fish|seafood|deli|butcher/i,       icon: 'beef',        colour: 'red'    },
  { match: /frozen|freezer|ice/i,                   icon: 'snowflake',   colour: 'teal'   },
  { match: /pantry|dry|canned|tinned|sauce|spice/i, icon: 'soup',        colour: 'coral'  },
  { match: /household|clean|laundry|cleaning/i,     icon: 'spray-can',   colour: 'purple' },
  { match: /drink|beverage|alcohol|wine|beer/i,     icon: 'wine',        colour: 'pink'   },
  { match: /coffee|tea/i,                           icon: 'coffee',      colour: 'coral'  },
  { match: /baby|infant/i,                          icon: 'baby',        colour: 'pink'   },
  { match: /pet|dog|cat/i,                          icon: 'paw-print',   colour: 'amber'  },
  { match: /pharmacy|medicine|health|chemist/i,     icon: 'pill',        colour: 'red'    },
  { match: /snack|sweet|candy|chocolate|cookie/i,   icon: 'cookie',      colour: 'pink'   },
  { match: /timber|wood|lumber|building|frame/i,    icon: 'layers',      colour: 'amber'  },
  { match: /paint|colour|finish|primer/i,           icon: 'paintbrush',  colour: 'coral'  },
  { match: /electrical|electric|wiring|cable/i,     icon: 'zap',         colour: 'yellow' },
  { match: /plumbing|pipe|tap|water|fitting/i,      icon: 'droplets',    colour: 'sky'    },
  { match: /garden|plant|outdoor|lawn|soil/i,       icon: 'spade',       colour: 'green'  },
  { match: /tool|hardware|equipment/i,              icon: 'wrench',      colour: 'slate'  },
  { match: /safety|workwear|ppe|glove/i,            icon: 'shield',      colour: 'orange' },
  { match: /furniture|home|house|living/i,          icon: 'armchair',    colour: 'indigo' },
  { match: /lighting|light|lamp|bulb/i,             icon: 'lamp',        colour: 'yellow' },
  { match: /lock|security|key|door/i,               icon: 'lock',        colour: 'slate'  },
];

export function getCategoryStyle(category) {
  // Already has explicit style → use it
  if (category.icon && category.colour) {
    return { icon: category.icon, colour: category.colour };
  }
  // Known seeded ID → use default
  if (DEFAULT_CATEGORY_STYLE[category.id]) {
    return { ...DEFAULT_CATEGORY_STYLE[category.id] };
  }
  // Try keyword match against name
  for (const guess of KEYWORD_GUESSES) {
    if (guess.match.test(category.name)) {
      return { icon: guess.icon, colour: guess.colour };
    }
  }
  // Fallback
  return { icon: 'shopping-bag', colour: 'gray' };
}

// =============================================================================
// LUCIDE ICON LOADING
// =============================================================================
// Fetch icon SVG markup once and cache. We pull from the unpkg CDN which mirrors
// the Lucide repo. This keeps the app self-contained without a build step.
// =============================================================================

const ICON_CACHE = new Map();
const PENDING = new Map();

const ICON_BASE = 'https://unpkg.com/lucide-static@0.363.0/icons/';

export async function loadIcon(name) {
  if (ICON_CACHE.has(name)) return ICON_CACHE.get(name);
  if (PENDING.has(name)) return PENDING.get(name);

  const promise = (async () => {
    try {
      const response = await fetch(`${ICON_BASE}${name}.svg`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      let svg = await response.text();
      // Strip XML preamble if present, force currentColor for theming
      svg = svg.replace(/<\?xml[^>]*\?>/g, '').trim();
      ICON_CACHE.set(name, svg);
      return svg;
    } catch (e) {
      // Fallback to a simple square
      const fallback = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>';
      ICON_CACHE.set(name, fallback);
      return fallback;
    }
  })();

  PENDING.set(name, promise);
  return promise;
}

// Render an icon into a category badge. Returns the HTML for the badge.
export function categoryBadgeHtml(category, options = {}) {
  const style = getCategoryStyle(category);
  const ramp = COLOUR_RAMPS[style.colour] || COLOUR_RAMPS.gray;
  const size = options.size || 28;
  const iconSize = Math.round(size * 0.6);
  return `
    <span class="cat-badge"
      data-icon="${style.icon}"
      style="--cat-bg: ${ramp.bg}; --cat-text: ${ramp.text}; --cat-bg-dark: ${ramp.dark_bg}; --cat-text-dark: ${ramp.dark_text}; width: ${size}px; height: ${size}px;">
      <span class="cat-badge-icon" style="width: ${iconSize}px; height: ${iconSize}px;"></span>
    </span>`;
}

// After HTML is in the DOM, populate any `.cat-badge[data-icon]` and
// `.cat-pill[data-icon]` elements with their actual SVG. Call this whenever
// you've rendered new badges or pills.
export async function hydrateBadges(root = document) {
  const targets = [...root.querySelectorAll(
    '.cat-badge[data-icon], .cat-pill[data-icon], .cat-icon-btn[data-icon], .list-tab-icon[data-load-icon], [data-load-icon]'
  )];
  await Promise.all(targets.map(async el => {
    const iconName = el.dataset.icon || el.dataset.loadIcon;
    if (!iconName) return;
    const svg = await loadIcon(iconName);
    // cat-badge/pill/icon-btn have a child slot; data-load-icon targets ARE the slot
    const slot = el.querySelector('.cat-badge-icon, .cat-pill-icon');
    if (slot) {
      slot.innerHTML = svg;
    } else {
      el.innerHTML = svg;
    }
    delete el.dataset.icon;
    delete el.dataset.loadIcon;
  }));
}
