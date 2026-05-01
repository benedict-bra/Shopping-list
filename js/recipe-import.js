// =============================================================================
// RECIPE URL IMPORTER
// =============================================================================
// Most major recipe sites publish structured data using schema.org's "Recipe"
// type. This is the same markup Google uses to show recipe cards in search.
//
// We use CORS proxies to fetch the page (browsers can't fetch arbitrary URLs
// directly due to same-origin policy). Try multiple in sequence — if one
// fails or is blocked, fall back to the next.
// =============================================================================
import { parseIngredient, isRealIngredient } from './ingredient-parser.js';
import { guessCategoryId } from './category-guesser.js';

// Ordered list of CORS proxies to try. Each is a function that takes a URL and
// returns the proxy URL. We try them in order until one succeeds.
const PROXIES = [
  {
    name: 'corsproxy.io',
    wrap: (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
  },
  {
    name: 'allorigins',
    // allorigins returns JSON with the page contents inside a `contents` field
    wrap: (url) => `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`,
    extract: async (response) => {
      const json = await response.json();
      return json.contents || '';
    },
  },
  {
    name: 'codetabs',
    wrap: (url) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(url)}`,
  },
];

export async function importRecipeFromUrl(url) {
  if (!url || !url.startsWith('http')) {
    throw new Error('Please provide a valid URL starting with http');
  }

  let html = null;
  const errors = [];

  // Try each proxy in turn until one works
  for (const proxy of PROXIES) {
    try {
      const response = await fetch(proxy.wrap(url));
      if (!response.ok) {
        errors.push(`${proxy.name}: ${response.status}`);
        continue;
      }
      html = proxy.extract ? await proxy.extract(response) : await response.text();
      if (html && html.length > 500) {
        // Looks like real content — break and try to parse
        break;
      }
      errors.push(`${proxy.name}: empty response`);
      html = null;
    } catch (e) {
      errors.push(`${proxy.name}: ${e.message}`);
    }
  }

  if (!html) {
    throw new Error(
      `Could not fetch the recipe page. The site may be blocking automated access. ` +
      `Tried: ${errors.join(' · ')}. ` +
      `You can paste the ingredients manually using "+ Add manually".`
    );
  }

  const recipe = parseRecipeFromHtml(html);
  if (!recipe) {
    throw new Error(
      'Page loaded, but no standard recipe markup was found. ' +
      'This site may not use schema.org Recipe data. ' +
      'Try "+ Add manually" to paste the ingredients yourself.'
    );
  }

  // Parse each raw ingredient line into qty/name/note, then filter non-ingredients
  const ingredients = (recipe.recipeIngredient || [])
    .map(line => parseIngredient(line))
    .filter(parsed => isRealIngredient(parsed))
    .map(parsed => ({
      name: parsed.name,
      qty: parsed.qty,
      note: parsed.note,
      original: parsed.original,
      categoryId: guessCategoryId(parsed.name),
    }));

  // Extract thumbnail image from schema.org image field.
  // Can be a string URL, an ImageObject, or an array of either.
  function extractImageUrl(img) {
    if (!img) return null;
    if (typeof img === 'string') return img;
    if (Array.isArray(img)) {
      for (const item of img) {
        const u = extractImageUrl(item);
        if (u) return u;
      }
      return null;
    }
    if (typeof img === 'object') return img.url || img.contentUrl || null;
    return null;
  }
  const thumbnailUrl = extractImageUrl(recipe.image || recipe.thumbnailUrl) || null;

  return {
    name: recipe.name || 'Imported recipe',
    sourceUrl: url,
    thumbnailUrl,
    ingredients,
  };
}

function parseRecipeFromHtml(html) {
  const scriptRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const matches = [...html.matchAll(scriptRegex)];

  for (const match of matches) {
    try {
      const json = JSON.parse(match[1].trim());
      const recipe = findRecipeInJsonLd(json);
      if (recipe) return recipe;
    } catch (e) {
      continue;
    }
  }
  return null;
}

function findRecipeInJsonLd(data) {
  if (!data) return null;

  if (Array.isArray(data)) {
    for (const item of data) {
      const found = findRecipeInJsonLd(item);
      if (found) return found;
    }
    return null;
  }

  if (typeof data === 'object') {
    const type = data['@type'];
    if (type === 'Recipe' || (Array.isArray(type) && type.includes('Recipe'))) {
      return data;
    }
    if (data['@graph']) {
      return findRecipeInJsonLd(data['@graph']);
    }
  }

  return null;
}
