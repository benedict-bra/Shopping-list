// =============================================================================
// INGREDIENT CATEGORY GUESSER
// =============================================================================
// Given an ingredient name, suggest which seeded category ID it belongs to:
//   produce | bakery | dairy | meat | frozen | pantry | household | other
//
// Approach: keyword matching with priority. Each rule is a regex (whole-word
// match where possible) → category. Rules are checked in order, first match
// wins. Order matters — more specific rules first.
//
// Usage: guessCategory("plain flour") → "pantry"
//        guessCategory("beef mince")  → "meat"
//        guessCategory("apple")       → "produce"
// =============================================================================

// Helper: build a regex that matches any of the words as whole words (case-insensitive)
function wordsRe(...words) {
  const escaped = words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`\\b(${escaped.join('|')})\\b`, 'i');
}

// Priority-ordered rules. First match wins, so put more specific rules first.
const RULES = [
  // Specific compound terms (must come before broader matches)
  // "Garlic powder" / "onion powder" / "lemon juice" → pantry, not produce
  { match: /\b(garlic|onion)\s+powder\b/i,                                  cat: 'pantry' },
  { match: /\b(lemon|lime|orange)\s+juice\b/i,                              cat: 'pantry' },
  { match: /\b(coconut)\s+(milk|cream|water|oil)\b/i,                       cat: 'pantry' },
  { match: /\b(tomato)\s+(sauce|paste|puree|passata)\b/i,                   cat: 'pantry' },
  { match: /\b(apple|orange|fruit)\s+juice\b/i,                             cat: 'pantry' },

  // Frozen — usually marked explicitly
  { match: /\bfrozen\b/i,                                                   cat: 'frozen' },
  { match: /\bice\s*(cream|cubes|blocks)\b/i,                               cat: 'frozen' },

  // Bakery — bread, pastries, baked goods (whole)
  { match: wordsRe('bread', 'bun', 'buns', 'roll', 'rolls', 'baguette',
                   'sourdough', 'ciabatta', 'focaccia', 'tortilla', 'tortillas',
                   'wrap', 'wraps', 'pita', 'naan', 'bagel', 'bagels',
                   'croissant', 'croissants', 'muffin', 'muffins', 'donut',
                   'doughnut', 'cake', 'pastry', 'pastries', 'biscuit',
                   'biscuits', 'cookie', 'cookies', 'scone', 'scones'),    cat: 'bakery' },

  // Dairy & eggs
  { match: wordsRe('milk', 'cream', 'butter', 'cheese', 'yogurt', 'yoghurt',
                   'sourcream', 'parmesan', 'mozzarella', 'cheddar', 'feta',
                   'ricotta', 'haloumi', 'halloumi', 'camembert', 'brie',
                   'cottage', 'mascarpone', 'eggs', 'egg', 'buttermilk',
                   'kefir', 'custard'),                                    cat: 'dairy' },

  // Meat & fish
  { match: wordsRe('beef', 'pork', 'lamb', 'chicken', 'turkey', 'duck',
                   'mince', 'sausage', 'sausages', 'bacon', 'ham',
                   'prosciutto', 'salami', 'pepperoni', 'chorizo',
                   'meatballs', 'steak', 'steaks', 'chop', 'chops',
                   'rib', 'ribs', 'fillet', 'fillets', 'breast', 'breasts',
                   'thigh', 'thighs', 'wing', 'wings', 'drumstick',
                   'drumsticks', 'roast', 'fish', 'salmon', 'tuna', 'cod',
                   'snapper', 'barramundi', 'prawn', 'prawns', 'shrimp',
                   'squid', 'calamari', 'mussel', 'mussels', 'clam', 'clams',
                   'oyster', 'oysters', 'crab', 'lobster'),                cat: 'meat' },

  // Produce — fruit & veg
  { match: wordsRe('apple', 'apples', 'banana', 'bananas', 'orange', 'oranges',
                   'lemon', 'lemons', 'lime', 'limes', 'grape', 'grapes',
                   'strawberry', 'strawberries', 'blueberry', 'blueberries',
                   'raspberry', 'raspberries', 'blackberry', 'mango',
                   'mangoes', 'pineapple', 'watermelon', 'rockmelon',
                   'cantaloupe', 'kiwi', 'pear', 'pears', 'peach', 'peaches',
                   'plum', 'plums', 'apricot', 'apricots', 'nectarine',
                   'cherry', 'cherries', 'avocado', 'avocados',
                   // Veg
                   'carrot', 'carrots', 'potato', 'potatoes', 'onion', 'onions',
                   'tomato', 'tomatoes', 'cucumber', 'cucumbers', 'lettuce',
                   'spinach', 'kale', 'rocket', 'arugula', 'silverbeet',
                   'cabbage', 'broccoli', 'cauliflower', 'capsicum', 'pepper',
                   'peppers', 'chilli', 'chillies', 'chili', 'chilies',
                   'celery', 'leek', 'leeks', 'spring onion', 'shallot',
                   'shallots', 'scallion', 'scallions', 'garlic', 'ginger',
                   'mushroom', 'mushrooms', 'zucchini', 'eggplant',
                   'aubergine', 'pumpkin', 'sweet potato', 'beetroot',
                   'radish', 'radishes', 'turnip', 'parsnip', 'parsnips',
                   'corn', 'cob', 'peas', 'bean', 'beans', 'snow pea',
                   'snowpeas', 'asparagus', 'artichoke', 'fennel',
                   // Herbs (fresh)
                   'parsley', 'coriander', 'cilantro', 'basil', 'mint',
                   'rosemary', 'thyme', 'oregano', 'sage', 'dill', 'chives'),
                                                                            cat: 'produce' },

  // Pantry — dry goods, condiments, oils, baking, sauces, spices
  { match: wordsRe('flour', 'sugar', 'salt', 'rice', 'pasta', 'spaghetti',
                   'penne', 'fettuccine', 'macaroni', 'noodle', 'noodles',
                   'oats', 'oatmeal', 'cereal', 'muesli', 'granola',
                   'oil', 'vinegar', 'soy', 'sauce', 'ketchup', 'mustard',
                   'mayo', 'mayonnaise', 'honey', 'syrup', 'jam', 'jelly',
                   'peanut', 'nutella', 'spread', 'tea', 'coffee', 'cocoa',
                   'chocolate', 'baking', 'soda', 'powder', 'yeast',
                   'cornflour', 'cornstarch', 'breadcrumbs', 'crumbs',
                   'stock', 'broth', 'bouillon', 'gravy',
                   'cinnamon', 'cumin', 'paprika', 'turmeric', 'curry',
                   'coriander seed', 'cardamom', 'cloves', 'nutmeg',
                   'allspice', 'bay', 'vanilla', 'pepper',
                   'tin', 'tins', 'can', 'cans', 'tuna', 'tinned',
                   'chickpeas', 'lentils', 'kidney beans', 'cannellini',
                   'borlotti', 'soup', 'crackers', 'chips', 'pretzels',
                   'nuts', 'almonds', 'cashews', 'walnuts', 'pecans',
                   'pistachios', 'raisins', 'sultanas', 'currants',
                   'apricots dried', 'dates', 'figs', 'prunes',
                   'olive', 'olives', 'capers', 'pickles', 'gherkins',
                   'coconut', 'desiccated', 'shredded',
                   'cous cous', 'couscous', 'quinoa', 'polenta', 'semolina',
                   'water', 'juice', 'cordial', 'soft drink', 'soda water',
                   'wine', 'beer', 'spirit', 'liqueur'),                  cat: 'pantry' },

  // Household — cleaning, paper, personal care
  { match: wordsRe('detergent', 'laundry', 'fabric softener', 'bleach',
                   'dishwasher', 'dishwashing', 'sponge', 'sponges',
                   'cloth', 'cloths', 'wipes', 'spray', 'cleaner',
                   'toilet paper', 'tissue', 'tissues', 'paper towel',
                   'kitchen paper', 'foil', 'cling wrap', 'baking paper',
                   'rubbish bag', 'rubbish bags', 'bin liner', 'bin liners',
                   'shampoo', 'conditioner', 'soap', 'toothpaste',
                   'toothbrush', 'deodorant', 'sunscreen', 'lotion',
                   'razor', 'tampons', 'pads', 'nappies', 'nappy', 'diaper',
                   'diapers'),                                              cat: 'household' },
];

// Returns one of the seeded category IDs, or 'other' as fallback.
export function guessCategoryId(ingredientName) {
  if (!ingredientName) return 'other';
  for (const rule of RULES) {
    if (rule.match.test(ingredientName)) return rule.cat;
  }
  return 'other';
}

// Returns the actual category ID to use for this user's category set —
// resolves the seeded ID to the user's category, falling back to 'other' if
// the seeded category was deleted.
export function guessCategoryFor(ingredientName, userCategories) {
  const seededId = guessCategoryId(ingredientName);
  // The seeded categories use the same IDs as our keys (produce, dairy, etc.)
  // If the user still has that category, use it. Otherwise fall back.
  const found = userCategories.find(c => c.id === seededId);
  if (found) return seededId;
  // Fallback to 'other' if it exists, else first available
  if (userCategories.find(c => c.id === 'other')) return 'other';
  return userCategories[0]?.id || 'other';
}
