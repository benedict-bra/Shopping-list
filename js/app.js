// =============================================================================
// MAIN APP — Phase 2 (Firebase)
// =============================================================================
import * as data from './data.js';
import { observeAuth, signInWithGoogle, signOutUser, getCurrentUid, getDisplayName, handleRedirectResult } from './auth.js';
import { importRecipeFromUrl } from './recipe-import.js';
import { parseIngredient, isRealIngredient, sentenceCase } from './ingredient-parser.js';
import { compressImage } from './photo.js';
import {
  AVAILABLE_ICONS, COLOUR_RAMPS,
  getCategoryStyle, categoryBadgeHtml, hydrateBadges, loadIcon,
} from './categories.js';
import { UNITS, UNIT_KEYS, unitGroup, unitLabel, formatQty, estimateCost, convert } from './units.js';
import { guessCategoryId } from './category-guesser.js';

// -----------------------------------------------------------------------------
// State
// -----------------------------------------------------------------------------
const state = {
  view: 'list',
  currentUid: null,         // set after sign-in
  currentDisplayName: '',   // Google display name
  activeStoreIds: [],
  activeListId: null,       // set after lists load
  items: [],
  stores: [],
  categories: [],
  recipes: [],
  lists: [],
  displaySettings: { showPrice: true, showStore: true, showCategory: true, showAddedBy: false, theme: 'auto' },
  checkedExpanded: true,
  searchQuery: '',
  filterAddedBy: null,
  // Real-time listener unsubscribe functions
  _unsubLists: null,
  _unsubItems: null,
  _unsubCats: null,
  _unsubStores: null,
  _unsubRecipes: null,
};

// -----------------------------------------------------------------------------
// Utility
// -----------------------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// Normalise an item name for loose-match comparison. Used to detect duplicates
// when adding from recipes ('flour' should match 'Plain flour'; 'apple' should
// match 'apples'). Strategy:
//  - lowercase, trim, collapse whitespace
//  - drop trailing 's' for crude pluralisation handling
//  - if multiple words, also keep just the last word as a fallback so common
//    qualifiers ('plain flour' → 'flour') match the bare ingredient
function normaliseName(name) {
  if (!name) return { full: '', tokens: [] };
  const lower = String(name).toLowerCase().trim().replace(/\s+/g, ' ');
  const stripPlural = (s) => s.endsWith('s') && s.length > 3 ? s.slice(0, -1) : s;
  const words = lower.split(' ').map(stripPlural);
  return {
    full: words.join(' '),         // e.g. "plain flour"
    tokens: words,                  // e.g. ["plain", "flour"]
    last: words[words.length - 1],  // e.g. "flour"
  };
}

// True if a and b look like the same ingredient.
// Match if either name's normalised form contains the other's last word
// (so "flour" matches "plain flour", "apple" matches "green apples").
// Words that are too generic to use as a lone match signal.
// "pepper" alone shouldn't match "Espelette pepper" vs "pepper (ingredient)".
// "oil" alone shouldn't match "olive oil" vs "coconut oil".
const GENERIC_INGREDIENT_WORDS = new Set([
  'pepper', 'salt', 'oil', 'sauce', 'stock', 'broth', 'cream', 'milk',
  'butter', 'flour', 'sugar', 'water', 'vinegar', 'paste', 'powder',
  'flake', 'flakes', 'seed', 'seeds', 'leaf', 'leaves', 'herb', 'spice',
  'juice', 'zest', 'extract', 'essence', 'syrup', 'honey', 'jam',
]);

function looselyMatch(nameA, nameB) {
  const a = normaliseName(nameA);
  const b = normaliseName(nameB);
  if (!a.full || !b.full) return false;
  if (a.full === b.full) return true;
  // Single-word query matches if found inside the other name's tokens,
  // but only if the word isn't a generic term that would match too broadly.
  if (a.tokens.length === 1 && !GENERIC_INGREDIENT_WORDS.has(a.last) && b.tokens.includes(a.last)) return true;
  if (b.tokens.length === 1 && !GENERIC_INGREDIENT_WORDS.has(b.last) && a.tokens.includes(b.last)) return true;
  // Both multi-word: only match on shared last/head noun if it's specific enough
  if (a.last && b.last && a.last === b.last && !GENERIC_INGREDIENT_WORDS.has(a.last)) return true;
  return false;
}

// -----------------------------------------------------------------------------
// Toast — small ephemeral message at bottom of screen
// -----------------------------------------------------------------------------
let toastTimeout = null;
function toast(message, options = {}) {
  let el = document.getElementById('toast-container');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast-container';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.className = `toast-show ${options.type || 'info'}`;
  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    el.className = '';
  }, options.duration || 2200);
}

function categoryName(id) {
  return state.categories.find(c => c.id === id)?.name || 'Other';
}

// -----------------------------------------------------------------------------
// Cost estimation
//
// Single price per item (not per store). If the item has no structured
// quantity, we assume "1 each" — so a price recorded as "$2/each" produces
// "~$2.00" without needing an explicit quantity. Weight or volume prices
// ($/kg, $/L) only apply if the user sets a structured qty in those units.
// -----------------------------------------------------------------------------
async function estimateItemCost(item) {
  const price = await data.getPrice(state.currentUid, item.name);
  if (!price) return null;

  const effectiveAmount = item.qtyAmount || 1;
  const effectiveUnit = item.qtyUnit || 'each';

  // Units must be in the same group (e.g. weight ↔ weight) to estimate
  if (unitGroup(price.unit) !== unitGroup(effectiveUnit)) return null;

  const cost = estimateCost(effectiveAmount, effectiveUnit, price.price, price.unit);
  return cost === null ? null : { cost, priceRecord: price };
}

function categoryById(id) {
  return state.categories.find(c => c.id === id) || { id, name: 'Other' };
}

function categoryBadgeFor(id, size = 28) {
  return categoryBadgeHtml(categoryById(id), { size });
}

// Compact icon-only category indicator for slim list rows.
// Tappable: opens the category picker.
function categoryIconFor(id, options = {}) {
  const cat = categoryById(id);
  const style = getCategoryStyle(cat);
  const ramp = COLOUR_RAMPS[style.colour] || COLOUR_RAMPS.gray;
  const action = options.action ? `data-action="${options.action}"` : '';
  return `
    <button class="cat-icon-btn"
      ${action}
      data-icon="${style.icon}"
      title="${escapeHtml(cat.name)}"
      aria-label="Category: ${escapeHtml(cat.name)}"
      style="--cat-bg: ${ramp.bg}; --cat-text: ${ramp.text}; --cat-bg-dark: ${ramp.dark_bg}; --cat-text-dark: ${ramp.dark_text};">
      <span class="cat-pill-icon"></span>
    </button>`;
}

// Pill version: coloured rounded pill containing icon + name, used inline on items.
// Tappable when given an action (e.g. opens category picker).
// `options.tag` lets the caller use 'span' instead of 'button' (e.g. when the
// pill itself is wrapped in another <button>).
function categoryPillFor(id, options = {}) {
  const cat = categoryById(id);
  const style = getCategoryStyle(cat);
  const ramp = COLOUR_RAMPS[style.colour] || COLOUR_RAMPS.gray;
  const action = options.action ? `data-action="${options.action}"` : '';
  const tag = options.tag || 'button';
  return `
    <${tag} class="cat-pill"
      ${action}
      data-icon="${style.icon}"
      style="--cat-bg: ${ramp.bg}; --cat-text: ${ramp.text}; --cat-bg-dark: ${ramp.dark_bg}; --cat-text-dark: ${ramp.dark_text};">
      <span class="cat-pill-icon"></span>
      <span class="cat-pill-name">${escapeHtml(cat.name)}</span>
    </${tag}>`;
}

function storeName(id) {
  return state.stores.find(s => s.id === id)?.name || '';
}

// -----------------------------------------------------------------------------
// Auth & initialisation
// -----------------------------------------------------------------------------

// Called by observeAuth when user signs in
// Guards — these must only run once
let _globalEventsBound = false;
let _omnibarSetup = false;

async function onSignedIn(user) {
  console.log('onSignedIn fired for:', user.email);
  state.currentUid = user.uid;
  state.currentDisplayName = user.displayName || 'You';

  // Show app, hide sign-in
  document.getElementById('signin-screen').hidden = true;
  document.getElementById('app-shell').hidden = false;

  teardownListeners();

  // Start real-time listeners
  state._unsubCats = data.listenToCategories(user.uid, (cats) => {
    state.categories = cats;
    if (state.view === 'list' || state.view === 'settings') render();
  });

  state._unsubStores = data.listenToStores(user.uid, (stores) => {
    state.stores = stores;
    if (state.view === 'list' || state.view === 'settings') render();
  });

  // Recipes listener
  state._unsubRecipes = data.listenToRecipes(user.uid, (recipes) => {
    state.recipes = recipes;
    if (state.view === 'recipes') render();
  });

  state._unsubLists = data.listenToLists(user.uid, async (lists) => {
    state.lists = lists;

    // Validate activeListId
    if (!lists.find(l => l.id === state.activeListId)) {
      state.activeListId = lists[0]?.id || null;
    }

    // If no lists at all, seed a default one
    if (lists.length === 0) {
      const newList = await data.createList(user.uid, {
        name: 'Shopping list',
        icon: 'shopping-cart',
        colour: 'teal',
        displayName: user.displayName,
      });
      state.activeListId = newList.id;
      return; // listener will fire again with the new list
    }

    // Subscribe to items for the active list
    subscribeToActiveListItems();
    render();
  });

  // Load display settings
  state.displaySettings = await data.getDisplaySettings(user.uid);
  applyTheme(state.displaySettings.theme);
  console.log('onSignedIn: display settings loaded, binding events');

  try {
    if (!_globalEventsBound) {
      bindGlobalEvents();
      _globalEventsBound = true;
      console.log('bindGlobalEvents: OK');
    }
  } catch(e) { console.error('bindGlobalEvents failed:', e); }

  try {
    if (!_omnibarSetup) {
      setupOmnibar();
      setupAddSheet();
      _omnibarSetup = true;
      console.log('setupOmnibar: OK');
    }
  } catch(e) { console.error('setupOmnibar failed:', e); }

  try {
    render();
    console.log('render: OK');
  } catch(e) { console.error('render failed:', e); }
}

function onSignedOut() {
  console.log('onSignedOut fired');
  teardownListeners();
  state.currentUid = null;
  state.lists = [];
  state.items = [];
  document.getElementById('signin-screen').hidden = false;
  document.getElementById('app-shell').hidden = true;
}

function teardownListeners() {
  ['_unsubLists', '_unsubItems', '_unsubCats', '_unsubStores', '_unsubRecipes'].forEach(k => {
    if (state[k]) { state[k](); state[k] = null; }
  });
}

function subscribeToActiveListItems() {
  if (state._unsubItems) { state._unsubItems(); state._unsubItems = null; }
  if (!state.activeListId) return;
  // Clear immediately so old list items don't flash while new list loads
  state.items = [];
  state._unsubItems = data.listenToItems(state.activeListId, (items) => {
    state.items = items;
    if (state.view === 'list') renderItemList();
  });
}

async function reloadAll() {
  // With real-time listeners, reloadAll is mostly a no-op —
  // listeners keep state fresh automatically.
  // Used for operations that need to await completion before re-rendering.
  if (!state.currentUid) return;
  state.displaySettings = await data.getDisplaySettings(state.currentUid);
}

async function init() {
  const loadingEl = document.getElementById('loading-screen');
  const signinEl  = document.getElementById('signin-screen');
  const appEl     = document.getElementById('app-shell');

  // Show spinner while auth resolves
  if (loadingEl) { loadingEl.hidden = false; loadingEl.style.display = 'flex'; }
  if (signinEl)  signinEl.hidden = true;
  if (appEl)     appEl.hidden = true;

  const redirectUser = await handleRedirectResult();
  if (redirectUser) {
    console.log('init: redirect user found');
    if (loadingEl) { loadingEl.hidden = true; loadingEl.style.display = 'none'; }
    await onSignedIn(redirectUser);
    observeAuth(() => {}, onSignedOut);
    return;
  }

  observeAuth(
    async (user) => {
      if (loadingEl) { loadingEl.hidden = true; loadingEl.style.display = 'none'; }
      await onSignedIn(user);
    },
    () => {
      if (loadingEl) { loadingEl.hidden = true; loadingEl.style.display = 'none'; }
      onSignedOut();
    }
  );
}

// -----------------------------------------------------------------------------
// Global events (top-level navigation, user toggle)
// -----------------------------------------------------------------------------
function bindGlobalEvents() {
  // Tabs
  $$('[data-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.view = btn.dataset.view;
      render();
    });
  });



  // Backup / restore
  $('#export-btn').addEventListener('click', exportData);
  $('#import-btn').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', importData);
}

async function exportData() {
  const all = await data.exportAll(state.currentUid, state.lists);
  const blob = new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `shopping-list-backup-${new Date().toISOString().split('T')[0]}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function importData(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const json = JSON.parse(text);
    if (!confirm('This will replace all current data. Continue?')) return;
    await data.importAll(json);
    await reloadAll();
    render();
  } catch (err) {
    alert('Import failed: ' + err.message);
  }
  e.target.value = '';
}

// -----------------------------------------------------------------------------
// Render dispatcher
// -----------------------------------------------------------------------------
async function render() {
  // Sync UI for tabs and user
  $$('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === state.view));


  const activeList = state.lists.find(l => l.id === state.activeListId);
  const listLabel = state.lists.length > 1 && activeList ? ` — ${activeList.name}` : '';
  $('#list-count').textContent = state.items.length > 0
    ? `(${state.items.length}${listLabel})`
    : listLabel ? `(${listLabel.slice(3)})` : '';

  $('#view-list').style.display = state.view === 'list' ? 'block' : 'none';
  $('#view-stores').style.display = 'none';
  $('#view-recipes').style.display = state.view === 'recipes' ? 'block' : 'none';
  $('#view-settings').style.display = state.view === 'settings' ? 'block' : 'none';

  // FAB — show on list view, hide on others (use class not hidden attr so CSS media query works)
  const fab = document.getElementById('fab-add');
  if (fab) fab.classList.toggle('fab--hidden', state.view !== 'list');

  if (state.view === 'list') await renderListView();
  if (state.view === 'recipes') renderRecipesView();
  if (state.view === 'settings') renderSettingsView();

  // Populate any newly-rendered category badges with their SVG icons
  hydrateBadges(document.body);
}

// =============================================================================
// LIST VIEW
// =============================================================================
async function renderListView() {
  renderListSelector();
  renderOmnibarFilter();
  await renderItemList();
  renderListFooter();
}

// Horizontal scrolling pill tabs — one per list, + New at the end
function renderListSelector() {
  let el = document.getElementById('list-selector');
  if (!el) return;

  el.hidden = false;

  el.innerHTML = state.lists.map(list => {
    const ramp = COLOUR_RAMPS[list.colour] || COLOUR_RAMPS.teal;
    return `
      <button class="list-tab ${list.id === state.activeListId ? 'active' : ''}"
        data-list-id="${list.id}"
        style="--list-col: ${ramp.text}; --list-bg: ${ramp.bg};">
        <span class="list-tab-icon" data-load-icon="${list.icon || 'shopping-cart'}"></span>
        <span class="list-tab-name">${escapeHtml(list.name)}</span>
      </button>`;
  }).join('') +
  `<button class="list-tab list-tab-add" id="list-tab-add" title="New list">＋</button>
   <button class="list-tab list-tab-join" id="list-tab-join" title="Join a shared list">
     <svg viewBox="0 0 24 24" style="width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>
   </button>`;

  hydrateBadges(el);

  el.querySelectorAll('[data-list-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      state.activeListId = btn.dataset.listId;
      state.searchQuery = '';
      state.activeStoreIds = [];
      subscribeToActiveListItems();
      // Collapse the omnibar so lastAddedName and input state reset cleanly
      const omniInput = document.getElementById('omnibar-input');
      const omniPanel = document.getElementById('omnibar-panel');
      const omniAdd = document.getElementById('omnibar-add');
      const omniClear = document.getElementById('omnibar-clear');
      if (omniInput) omniInput.value = '';
      if (omniPanel) omniPanel.hidden = true;
      if (omniAdd) omniAdd.disabled = true;
      if (omniClear) omniClear.hidden = true;
      render();
    });
  });

  el.querySelector('#list-tab-add')?.addEventListener('click', () => openNewListModal());
  el.querySelector('#list-tab-join')?.addEventListener('click', () => openJoinModal());
  el.querySelectorAll('[data-share-list]')?.forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); openShareModal(btn.dataset.shareList); });
  });
}

function openNewListModal() {
  openListIconModal(null);
}

// Shared modal for creating a new list OR editing an existing one.
// Pass null for `existingList` when creating.
function openListIconModal(existingList) {
  const isEdit = !!existingList;
  let chosenIcon = existingList?.icon || 'shopping-cart';
  let chosenColour = existingList?.colour || 'teal';

  const modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.innerHTML = `
    <div class="modal list-icon-modal" role="dialog" aria-label="${isEdit ? 'Edit list' : 'New list'}">
      <h3>${isEdit ? 'Edit list' : 'New list'}</h3>

      ${!isEdit ? `
      <div class="modal-row">
        <label>Name</label>
        <input id="nl-name" placeholder="e.g. Bunnings run, Work shop" autocomplete="off" />
      </div>` : `
      <div class="modal-row">
        <label>Name</label>
        <input id="nl-name" value="${escapeHtml(existingList.name)}" autocomplete="off" />
      </div>`}

      <div class="modal-row list-preview-row">
        <span id="nl-preview-badge"></span>
        <span id="nl-preview-name" class="list-preview-name">${escapeHtml(existingList?.name || 'New list')}</span>
      </div>

      <div class="modal-row">
        <label>Colour</label>
        <div class="colour-grid">
          ${Object.entries(COLOUR_RAMPS).map(([key, ramp]) => `
            <button type="button"
              class="colour-swatch ${key === chosenColour ? 'selected' : ''}"
              data-colour="${key}"
              style="background: ${ramp.bg}; --swatch-accent: ${ramp.text};"
              title="${ramp.label}">
              <span class="colour-swatch-dot" style="background: ${ramp.text};"></span>
            </button>`).join('')}
        </div>
      </div>

      <div class="modal-row">
        <label>Icon</label>
        <div class="icon-search-wrap">
          <input id="nl-icon-search" placeholder="Search icons…" autocomplete="off" />
        </div>
        <div class="icon-grid icon-grid--fixed" id="nl-icon-grid"></div>
      </div>

      <div class="modal-actions ${isEdit && state.lists.length > 1 ? 'modal-actions-with-delete' : ''}">
        ${isEdit && state.lists.length > 1 ? `
          <button class="btn-icon btn-icon-danger" id="nl-delete" title="Delete list">
            <svg class="icon" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
          </button>
          <span class="modal-actions-spacer"></span>` : ''}
        ${isEdit ? `<button class="btn-secondary" id="nl-share">Share</button>` : ''}
        <button class="btn-secondary" id="nl-cancel">Cancel</button>
        <button class="btn-primary" id="nl-save">${isEdit ? 'Save' : 'Create'}</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  // Live preview helper
  function updatePreview() {
    const ramp = COLOUR_RAMPS[chosenColour] || COLOUR_RAMPS.teal;
    const preview = document.getElementById('nl-preview-badge');
    if (preview) {
      preview.innerHTML = '';
      const dot = document.createElement('span');
      dot.className = 'list-preview-dot';
      dot.style.cssText = `background:${ramp.text};`;
      dot.setAttribute('data-load-icon', chosenIcon);
      preview.appendChild(dot);
      hydrateBadges(preview);
    }
  }
  updatePreview();

  // Icon grid with fixed height — always same size regardless of search results
  function renderIconGrid(filter = '') {
    const grid = document.getElementById('nl-icon-grid');
    const icons = filter.trim()
      ? AVAILABLE_ICONS.filter(n => n.includes(filter.toLowerCase().trim()))
      : AVAILABLE_ICONS;
    grid.innerHTML = icons.length
      ? icons.map(name => `
          <button type="button" class="icon-grid-cell ${name === chosenIcon ? 'selected' : ''}"
            data-icon-name="${name}" title="${name}">
            <span data-load-icon="${name}"></span>
          </button>`).join('')
      : `<p style="grid-column:1/-1;text-align:center;color:var(--text-muted);font-size:12px;padding:1rem 0;">No icons match</p>`;
    hydrateBadges(grid);
    grid.querySelectorAll('.icon-grid-cell').forEach(btn => {
      btn.addEventListener('click', () => {
        chosenIcon = btn.dataset.iconName;
        grid.querySelectorAll('.icon-grid-cell').forEach(b => b.classList.toggle('selected', b === btn));
        updatePreview();
      });
    });
  }
  renderIconGrid();

  document.getElementById('nl-icon-search').addEventListener('input', e => renderIconGrid(e.target.value));

  // Colour picker
  modal.querySelectorAll('.colour-swatch').forEach(btn => {
    btn.addEventListener('click', () => {
      chosenColour = btn.dataset.colour;
      modal.querySelectorAll('.colour-swatch').forEach(b => b.classList.toggle('selected', b === btn));
      updatePreview();
    });
  });

  const nameInput = document.getElementById('nl-name');
  if (nameInput) {
    nameInput.addEventListener('input', () => {
      const el = document.getElementById('nl-preview-name');
      if (el) el.textContent = nameInput.value.trim() || (isEdit ? existingList.name : 'New list');
    });
  }

  document.getElementById('nl-cancel').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

  // Share button (edit mode only)
  document.getElementById('nl-share')?.addEventListener('click', () => {
    modal.remove();
    openShareModal(existingList.id);
  });

  // Delete (edit mode only, only if more than 1 list)
  document.getElementById('nl-delete')?.addEventListener('click', async () => {
    const list = existingList;
    const count = list.id === state.activeListId ? state.items.length : 0;
    const msg = count > 0
      ? `Delete "${list.name}"? ${count} item${count === 1 ? '' : 's'} will move to the first list.`
      : `Delete "${list.name}"?`;
    if (!confirm(msg)) return;
    modal.remove();
    if (state.activeListId === list.id) {
      state.activeListId = state.lists.find(l => l.id !== list.id)?.id || 'default';
      await data.setActiveListId(state.activeListId);
    }
    await data.deleteList(state.currentUid, list.id);
    await reloadAll();
    render();
  });

  document.getElementById('nl-save').addEventListener('click', async () => {
    const nameInput = document.getElementById('nl-name');
    const name = nameInput?.value.trim();
    if (!name) { nameInput?.focus(); return; }

    if (isEdit) {
      await data.updateList(existingList.id, { name, icon: chosenIcon, colour: chosenColour });
      modal.remove();
      await reloadAll();
      render();
    } else {
      const newList = await data.createList(state.currentUid, { name, icon: chosenIcon, colour: chosenColour, displayName: state.currentDisplayName });
      modal.remove();
      await reloadAll();
      state.activeListId = newList.id;
      await data.setActiveListId(newList.id);
      render();
    }
  });
}


// Default: just the funnel icon; when filtered to a store: shows the store name.
function renderOmnibarFilter() {
  const btn = $('#omnibar-filter');
  const label = $('#omnibar-filter-label');
  if (!btn || !label) return;
  if (state.activeStoreIds.length > 0) {
    const names = state.activeStoreIds.map(id => storeName(id)).filter(Boolean);
    btn.classList.add('active');
    label.hidden = false;
    label.textContent = names.length === 1 ? names[0] : `${names.length} stores`;
  } else {
    btn.classList.remove('active');
    label.hidden = true;
    label.textContent = '';
  }
}

async function renderItemList() {
  const container = $('#items-container');

  // Filter items by active list (items without listId belong to 'default')
  // Items are already scoped to the active list via Firestore subcollection
  let visible = [...state.items];
  if (state.activeStoreIds.length > 0) {
    visible = visible.filter(i => i.storeIds && state.activeStoreIds.some(sid => i.storeIds.includes(sid)));
  if (state.filterAddedBy) {
    visible = visible.filter(i => i.addedBy === state.filterAddedBy);
  }
  }

  // Filter by search query (name only, case-insensitive)
  const q = (state.searchQuery || '').trim().toLowerCase();
  if (q) {
    visible = visible.filter(i => (i.name || '').toLowerCase().includes(q));
  }

  if (visible.length === 0) {
    let emptyMessage;
    if (q) {
      emptyMessage = `<p>No items match "${escapeHtml(state.searchQuery)}".</p>
        <p style="font-size: 12px;">Press Enter or tap the suggestion above to add it.</p>`;
    } else if (state.activeStoreIds.length > 0) {
      emptyMessage = `<p>No items tagged for all selected stores.</p>
        <p style="font-size: 12px;">Tap the store chip on any item to assign one.</p>`;
    } else {
      emptyMessage = `<p>Your list is empty.</p>
        <p style="font-size: 12px;">Type above to add items.</p>`;
    }
    container.innerHTML = `<div class="empty">${emptyMessage}</div>`;
    return;
  }

  // Sort by global category order (the order defined in Settings → Categories).
  // This IS the aisle order — one consistent order across all stores.
  const catOrder = state.categories.map(c => c.id);

  function sortKey(a, b) {
    const aIdx = catOrder.indexOf(a.categoryId);
    const bIdx = catOrder.indexOf(b.categoryId);
    const ai = aIdx === -1 ? 999 : aIdx;
    const bi = bIdx === -1 ? 999 : bIdx;
    if (ai !== bi) return ai - bi;
    return itemSortKey(a, b);
  }

  const active = visible.filter(i => !i.checked).sort(sortKey);
  const checked = visible.filter(i => i.checked).sort(sortKey);

  // Render active items + their estimates in parallel
  const activeHtml = await Promise.all(active.map(async item => {
    const estimate = await estimateItemCost(item);
    return renderItem(item, { estimate: estimate?.cost });
  }));

  // Compute total (active items only)
  let total = 0;
  let pricedCount = 0;
  for (const item of active) {
    const est = await estimateItemCost(item);
    if (est && est.cost) {
      total += est.cost;
      pricedCount++;
    }
  }

  // Checked items — render but don't compute estimates (they're greyed regardless)
  const checkedHtml = checked.map(item => renderItem(item, { estimate: null }));

  // Build the layout
  let html = '';

  // Active list
  if (active.length === 0) {
    html += `<div class="empty" style="padding: 1.5rem 1rem;">
      <p>All checked off!</p>
      <p style="font-size: 12px;">${checked.length} item${checked.length === 1 ? '' : 's'} ready to clear below.</p>
    </div>`;
  } else {
    html += activeHtml.join('');
  }

  // Estimated total — subtle line under active items
  if (active.length > 0) {
    if (pricedCount > 0) {
      html += `<div class="estimated-total">Estimated total: <strong>$${total.toFixed(2)}</strong></div>`;
    } else {
      html += `<div class="estimated-total estimated-total-empty">No prices recorded yet — tap the pencil on an item to add one</div>`;
    }
  }

  // Checked items section
  if (checked.length > 0) {
    html += `
      <div class="checked-section ${state.checkedExpanded ? 'expanded' : ''}">
        <button class="checked-toggle" id="checked-toggle">
          <svg class="icon checked-chevron" viewBox="0 0 24 24"><path d="M9 18l6-6-6-6"/></svg>
          <span>${checked.length} checked item${checked.length === 1 ? '' : 's'}</span>
        </button>
        <div class="checked-items">${checkedHtml.join('')}</div>
      </div>`;
  }

  container.innerHTML = html;
  bindItemEvents(container);

  $('#checked-toggle')?.addEventListener('click', () => {
    state.checkedExpanded = !state.checkedExpanded;
    render();
  });
}

function renderItem(item, options = {}) {
  const ds = state.displaySettings;

  let qtyDisplay = '';
  if (item.qtyAmount && item.qtyUnit) {
    qtyDisplay = formatQty(item.qtyAmount, item.qtyUnit, { short: false });
  } else if (item.qty) {
    qtyDisplay = item.qty;
  }

  // Price tag — only shown if displaySettings.showPrice
  let priceHtml = '';
  if (ds.showPrice) {
    if (options.estimate != null) {
      priceHtml = `<span class="item-price-tag item-price-tag--set">$${options.estimate.toFixed(2)}</span>`;
    }
    // No price = show nothing (blank, as previously agreed)
  }

  // Store pills — only shown if displaySettings.showStore
  let storePills = '';
  if (ds.showStore && item.storeIds?.length > 0) {
    storePills = item.storeIds.map(sid => {
      const name = storeName(sid);
      return name ? `<span class="item-store-pill">${escapeHtml(name)}</span>` : '';
    }).join('');
  }

  // Category icon — only shown if displaySettings.showCategory
  const categoryIcon = ds.showCategory
    ? categoryIconFor(item.categoryId, { action: 'open-cat-picker' })
    : '';

  return `
    <div class="item ${item.checked ? 'checked' : ''}" data-id="${item.id}" data-cat-id="${item.categoryId}">
      <button class="checkbox ${item.checked ? 'checked' : ''}" data-action="toggle"></button>
      <div class="item-content" data-action="edit">
        <span class="item-name">${escapeHtml(item.name)}</span>
        ${ds.showAddedBy && item.addedByName ? `<span class="item-added-by">${escapeHtml(item.addedByName)}</span>` : ''}
        ${qtyDisplay ? `<span class="item-qty">${escapeHtml(qtyDisplay)}</span>` : ''}
        ${storePills ? `<div class="item-store-pills">${storePills}</div>` : ''}
      </div>
      ${priceHtml}
      ${categoryIcon}
      <span class="item-drag-handle" aria-label="Drag to reorder" title="Drag to reorder">
        <svg viewBox="0 0 24 24"><line x1="8" y1="6" x2="16" y2="6"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="18" x2="16" y2="18"/></svg>
      </span>
    </div>`;
}

function bindItemEvents(container) {
  container.querySelectorAll('.item').forEach(el => {
    const id = el.dataset.id;
    el.querySelector('[data-action="toggle"]').addEventListener('click', () => toggleItem(id));
    // Tap on the item content area opens the edit modal
    const content = el.querySelector('[data-action="edit"]');
    if (content) {
      content.addEventListener('click', () => openEditModal(id));
    }
    // Category icon — opens category picker
    el.querySelectorAll('[data-action="open-cat-picker"]').forEach(pill => {
      pill.addEventListener('click', (e) => {
        e.stopPropagation();
        openCategoryPicker(pill, id);
      });
    });
    // Drag handle — only the handle starts drags (mouse + touch)
    const handle = el.querySelector('.item-drag-handle');
    if (handle) {
      // Mouse: enable draggable on mousedown, disable on mouseup
      handle.addEventListener('mousedown', () => { el.setAttribute('draggable', 'true'); });
      handle.addEventListener('mouseup', () => { el.removeAttribute('draggable'); });

      // Touch: long-press on handle starts a simulated drag
      let touchDragTimeout = null;
      let touchStartY = 0;
      handle.addEventListener('touchstart', (e) => {
        touchStartY = e.touches[0].clientY;
        touchDragTimeout = setTimeout(() => {
          el.setAttribute('draggable', 'true');
        }, 200);
      }, { passive: true });
      handle.addEventListener('touchend', () => {
        clearTimeout(touchDragTimeout);
        el.removeAttribute('draggable');
      });
      handle.addEventListener('touchmove', () => {
        clearTimeout(touchDragTimeout);
      }, { passive: true });
    }
  });

  // Drag-and-drop wiring for items
  bindItemDragAndDrop(container);
  // Touch reordering (mobile — HTML5 drag API doesn't fire on touch)
  bindItemTouchReorder(container);
}

// -----------------------------------------------------------------------------
// Drag-and-drop reordering for items within a category
// Only allows reordering inside a category. Crossing the boundary into
// another category snaps to the top/bottom of the dragged item's category.
// -----------------------------------------------------------------------------
function bindItemDragAndDrop(container) {
  let draggedRow = null;

  container.querySelectorAll('.item[data-cat-id]').forEach(row => {
    row.addEventListener('dragstart', (e) => {
      // Only allow drag if our handle was used (we set draggable=true on mousedown)
      if (!row.hasAttribute('draggable')) {
        e.preventDefault();
        return;
      }
      draggedRow = row;
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', row.dataset.id);
    });

    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      row.removeAttribute('draggable');
      container.querySelectorAll('.drag-over-top, .drag-over-bottom').forEach(el => {
        el.classList.remove('drag-over-top', 'drag-over-bottom');
      });
      draggedRow = null;
    });

    row.addEventListener('dragover', (e) => {
      if (!draggedRow || draggedRow === row) return;
      // Only show indicator for same-category drops
      if (row.dataset.catId !== draggedRow.dataset.catId) {
        // Clear any indicator on this row
        row.classList.remove('drag-over-top', 'drag-over-bottom');
        return;
      }
      e.preventDefault();
      const rect = row.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      row.classList.toggle('drag-over-top', before);
      row.classList.toggle('drag-over-bottom', !before);
    });

    row.addEventListener('dragleave', () => {
      row.classList.remove('drag-over-top', 'drag-over-bottom');
    });

    row.addEventListener('drop', async (e) => {
      e.preventDefault();
      row.classList.remove('drag-over-top', 'drag-over-bottom');
      if (!draggedRow || draggedRow === row) return;

      const fromId = draggedRow.dataset.id;
      const fromCatId = draggedRow.dataset.catId;
      const toId = row.dataset.id;
      const toCatId = row.dataset.catId;

      const rect = row.getBoundingClientRect();
      const dropBefore = (e.clientY - rect.top) < rect.height / 2;

      if (fromCatId !== toCatId) {
        // Crossing categories: snap to top or bottom of source category instead.
        // If dragging upward (target above), snap to top of source category.
        // If dragging downward (target below), snap to bottom of source category.
        const draggedY = draggedRow.getBoundingClientRect().top;
        const targetY = rect.top;
        const draggedDownward = targetY > draggedY;
        await reorderItemWithinCategory(fromId, fromCatId, draggedDownward ? 'bottom' : 'top');
      } else {
        await reorderItemRelativeTo(fromId, toId, dropBefore);
      }
    });
  });
}

// -----------------------------------------------------------------------------
// Touch reordering — pointer-event based, works on mobile browsers
// Hold the drag handle, then drag the row up/down to reorder within category.
// -----------------------------------------------------------------------------
function bindItemTouchReorder(container) {
  let draggingEl = null;
  let placeholder = null;
  let startY = 0;
  let offsetY = 0;
  let originalIndex = 0;

  container.querySelectorAll('.item').forEach(row => {
    const handle = row.querySelector('.item-drag-handle');
    if (!handle) return;

    handle.addEventListener('pointerdown', (e) => {
      // Only trigger on touch (pointerId > 0 is touch/stylus on most browsers)
      // but also allow if it's explicitly touch type
      if (e.pointerType === 'mouse') return; // mouse handled by HTML5 DnD

      e.preventDefault();
      handle.setPointerCapture(e.pointerId);

      draggingEl = row;
      startY = e.clientY;
      offsetY = e.clientY - row.getBoundingClientRect().top;

      // Clone the row as a floating ghost
      const rect = row.getBoundingClientRect();
      draggingEl._ghost = row.cloneNode(true);
      draggingEl._ghost.style.cssText = `
        position: fixed;
        left: ${rect.left}px;
        top: ${rect.top}px;
        width: ${rect.width}px;
        z-index: 9999;
        opacity: 0.9;
        pointer-events: none;
        box-shadow: 0 4px 16px rgba(0,0,0,0.18);
        border-radius: 6px;
        background: var(--bg);
      `;
      document.body.appendChild(draggingEl._ghost);

      // Add a placeholder to fill the row's original space
      placeholder = document.createElement('div');
      placeholder.style.cssText = `height: ${rect.height}px; background: var(--bg-alt); border-radius: 4px; margin: 2px 0;`;
      row.parentNode.insertBefore(placeholder, row);
      row.style.display = 'none';
    });

    handle.addEventListener('pointermove', (e) => {
      if (!draggingEl || draggingEl !== row) return;
      e.preventDefault();

      const ghost = draggingEl._ghost;
      if (ghost) {
        ghost.style.top = `${e.clientY - offsetY}px`;
      }

      // Find what row we're hovering over
      ghost && (ghost.style.display = 'none');
      const elBelow = document.elementFromPoint(e.clientX, e.clientY);
      ghost && (ghost.style.display = '');

      const targetRow = elBelow?.closest('.item');
      if (targetRow && targetRow !== draggingEl &&
          targetRow.dataset.catId === draggingEl.dataset.catId &&
          targetRow.parentNode === placeholder.parentNode) {
        const rect = targetRow.getBoundingClientRect();
        const before = (e.clientY - rect.top) < rect.height / 2;
        if (before) {
          targetRow.parentNode.insertBefore(placeholder, targetRow);
        } else {
          targetRow.parentNode.insertBefore(placeholder, targetRow.nextSibling);
        }
      }
    });

    handle.addEventListener('pointerup', async (e) => {
      if (!draggingEl || draggingEl !== row) return;

      // Remove ghost
      draggingEl._ghost?.remove();
      draggingEl._ghost = null;
      draggingEl.style.display = '';

      // Where did the placeholder end up?
      if (placeholder && placeholder.parentNode) {
        placeholder.parentNode.insertBefore(draggingEl, placeholder);
        placeholder.remove();
      }
      placeholder = null;

      // Re-derive order from the current DOM
      const catId = draggingEl.dataset.catId;
      const allInCat = [...container.querySelectorAll(`.item[data-cat-id="${catId}"]`)];
      for (let i = 0; i < allInCat.length; i++) {
        const id = allInCat[i].dataset.id;
        const item = state.items.find(it => it.id === id);
        if (item && item.orderInCategory !== i) {
          await data.updateItem(state.activeListId, id, { orderInCategory: i });
        }
      }
      await reloadAll();
      render();
      draggingEl = null;
    });

    handle.addEventListener('pointercancel', () => {
      if (draggingEl?._ghost) draggingEl._ghost.remove();
      if (draggingEl) draggingEl.style.display = '';
      placeholder?.remove();
      draggingEl = null;
      placeholder = null;
    });
  });
}


// Maintains a tight contiguous order index across the category.
async function reorderItemRelativeTo(fromId, toId, before) {
  const fromItem = state.items.find(i => i.id === fromId);
  const toItem = state.items.find(i => i.id === toId);
  if (!fromItem || !toItem) return;
  if (fromItem.categoryId !== toItem.categoryId) return;

  // Get all items in this category in current display order
  const inCat = state.items
    .filter(i => i.categoryId === fromItem.categoryId)
    .sort(itemSortKey);

  // Remove and reinsert
  const without = inCat.filter(i => i.id !== fromId);
  const targetIdx = without.findIndex(i => i.id === toId);
  if (targetIdx === -1) return;
  const insertAt = before ? targetIdx : targetIdx + 1;
  without.splice(insertAt, 0, fromItem);

  // Persist the new order via orderInCategory
  for (let i = 0; i < without.length; i++) {
    if (without[i].orderInCategory !== i) {
      await data.updateItem(state.activeListId, without[i].id, { orderInCategory: i });
    }
  }
  await reloadAll();
  render();
}

// Snap an item to the top or bottom of its own category.
async function reorderItemWithinCategory(itemId, categoryId, position) {
  const item = state.items.find(i => i.id === itemId);
  if (!item) return;
  const inCat = state.items
    .filter(i => i.categoryId === categoryId && i.id !== itemId)
    .sort(itemSortKey);

  if (position === 'top') {
    inCat.unshift(item);
  } else {
    inCat.push(item);
  }
  for (let i = 0; i < inCat.length; i++) {
    if (inCat[i].orderInCategory !== i) {
      await data.updateItem(state.activeListId, inCat[i].id, { orderInCategory: i });
    }
  }
  await reloadAll();
  render();
}

// Sort key used everywhere we order items within a category.
// Manual orderInCategory wins; falls back to addedAt for items that were
// never explicitly reordered.
function itemSortKey(a, b) {
  const ao = (typeof a.orderInCategory === 'number') ? a.orderInCategory : Number.MAX_SAFE_INTEGER;
  const bo = (typeof b.orderInCategory === 'number') ? b.orderInCategory : Number.MAX_SAFE_INTEGER;
  if (ao !== bo) return ao - bo;
  return a.addedAt - b.addedAt;
}

// -----------------------------------------------------------------------------
// CATEGORY PICKER POPOVER — opened by tapping the category pill on an item
// -----------------------------------------------------------------------------
// Generic category picker. Pass:
//   anchorEl     — element to position the popover under
//   currentCatId — currently-selected category ID (for the ✓ marker)
//   onChange     — async (newCatId) => void; called when user picks a new category
function openCategoryPickerGeneric(anchorEl, currentCatId, onChange) {
  // Close any other pickers
  document.querySelectorAll('.store-picker').forEach(p => p.remove());

  const popover = document.createElement('div');
  popover.className = 'store-picker';
  popover.setAttribute('role', 'menu');

  popover.innerHTML = state.categories.map(cat => {
    const isActive = cat.id === currentCatId;
    return `
      <div class="store-picker-row cat-picker-row" data-cat-id="${cat.id}" ${isActive ? 'data-active="true"' : ''}>
        ${categoryBadgeFor(cat.id, 22)}
        <span style="flex:1;">${escapeHtml(cat.name)}</span>
        ${isActive ? '<span style="color: var(--text); font-weight: 500;">✓</span>' : ''}
      </div>`;
  }).join('');

  document.body.appendChild(popover);
  hydrateBadges(popover);

  // Position near anchor
  const rect = anchorEl.getBoundingClientRect();
  const popRect = popover.getBoundingClientRect();
  let top = rect.bottom + window.scrollY + 4;
  let left = rect.left + window.scrollX;
  if (left + popRect.width > window.innerWidth - 8) {
    left = window.innerWidth - popRect.width - 8;
  }
  if (top + popRect.height > window.innerHeight + window.scrollY - 8) {
    top = rect.top + window.scrollY - popRect.height - 4;
  }
  popover.style.top = `${top}px`;
  popover.style.left = `${left}px`;

  popover.querySelectorAll('[data-cat-id]').forEach(row => {
    row.addEventListener('click', async (e) => {
      e.stopPropagation();
      const newCatId = row.dataset.catId;
      popover.remove();
      if (newCatId !== currentCatId) {
        await onChange(newCatId);
      }
    });
  });

  setTimeout(() => {
    const closeOnOutside = (e) => {
      if (!popover.contains(e.target)) {
        popover.remove();
        document.removeEventListener('click', closeOnOutside);
      }
    };
    document.addEventListener('click', closeOnOutside);
  }, 0);
}

// List-item version — wraps the generic picker with the data.updateItem call
function openCategoryPicker(anchorEl, itemId) {
  const item = state.items.find(i => i.id === itemId);
  if (!item) return;
  openCategoryPickerGeneric(anchorEl, item.categoryId, async (newCatId) => {
    await data.updateItem(state.activeListId, itemId, { categoryId: newCatId });
    await reloadAll();
    render();
  });
}

// -----------------------------------------------------------------------------
// STORE PICKER POPOVER — opened by tapping a chip on an item
// -----------------------------------------------------------------------------
function openStorePicker(anchorEl, itemId) {
  // Close any existing picker first
  document.querySelectorAll('.store-picker').forEach(p => p.remove());

  const item = state.items.find(i => i.id === itemId);
  if (!item) return;

  const popover = document.createElement('div');
  popover.className = 'store-picker';
  popover.setAttribute('role', 'menu');

  if (state.stores.length === 0) {
    popover.innerHTML = `<div class="store-picker-empty">No stores yet. Add one in the Stores tab.</div>`;
  } else {
    const currentStores = new Set(item.storeIds || []);
    popover.innerHTML = state.stores.map(s => {
      const checked = currentStores.has(s.id);
      return `
        <div class="store-picker-row" data-store-id="${s.id}">
          <span class="store-picker-check ${checked ? 'checked' : ''}"></span>
          <span>${escapeHtml(s.name)}</span>
        </div>`;
    }).join('');
  }

  document.body.appendChild(popover);

  // Position popover near the anchor
  const rect = anchorEl.getBoundingClientRect();
  const popRect = popover.getBoundingClientRect();
  let top = rect.bottom + window.scrollY + 4;
  let left = rect.left + window.scrollX;
  // Keep on screen
  if (left + popRect.width > window.innerWidth - 8) {
    left = window.innerWidth - popRect.width - 8;
  }
  if (top + popRect.height > window.innerHeight + window.scrollY - 8) {
    top = rect.top + window.scrollY - popRect.height - 4;
  }
  popover.style.top = `${top}px`;
  popover.style.left = `${left}px`;

  // Toggle store on click
  popover.querySelectorAll('[data-store-id]').forEach(row => {
    row.addEventListener('click', async (e) => {
      e.stopPropagation();
      const storeId = row.dataset.storeId;
      const current = state.items.find(i => i.id === itemId);
      if (!current) return;
      const set = new Set(current.storeIds || []);
      if (set.has(storeId)) set.delete(storeId);
      else set.add(storeId);
      await data.updateItem(state.activeListId, itemId, { storeIds: [...set] });
      await reloadAll();
      // Update picker check states without re-opening
      row.querySelector('.store-picker-check').classList.toggle('checked');
      // Re-render the list so chips update
      render();
      // Re-anchor: the list re-rendered, so the chip we clicked may have moved.
      // Easiest: close the popover after toggle.
      popover.remove();
    });
  });

  // Click outside closes
  setTimeout(() => {
    const closeOnOutside = (e) => {
      if (!popover.contains(e.target)) {
        popover.remove();
        document.removeEventListener('click', closeOnOutside);
      }
    };
    document.addEventListener('click', closeOnOutside);
  }, 0);
}

async function toggleItem(id) {
  const item = state.items.find(i => i.id === id);
  if (!item) return;
  await data.updateItem(state.activeListId, id, { checked: !item.checked });
  await reloadAll();
  render();
}

async function deleteItemConfirmed(id) {
  await data.deleteItem(state.activeListId, id);
  await reloadAll();
  render();
}

function renderListFooter() {
  const total = state.items.length;
  const checked = state.items.filter(i => i.checked).length;
  $('#stats').textContent = total === 0 ? '' : `${total} item${total === 1 ? '' : 's'}`;
  $('#clear-checked').style.display = checked > 0 ? 'inline-block' : 'none';
}

// -----------------------------------------------------------------------------
// Add item form
// -----------------------------------------------------------------------------
// =============================================================================
// OMNIBAR — combined add / find input
// =============================================================================
// Behaviour:
//   - At rest: just an icon and the placeholder.
//   - On focus: panel slides down with optional details (qty/unit/category)
//   - As user types: list filters by name (case-insensitive). Add suggestion
//     appears at top of panel ("+ Add 'milk'") if no exact match exists.
//   - Enter: adds the item, clears input, keeps focus (so you can add another).
//   - Escape or outside click: collapses panel, clears search.

// Populate the dropdowns. Safe to call multiple times (e.g. after categories change).
function populateOmnibarDropdowns() {
  const catSelect = $('#new-cat');
  if (catSelect) {
    const previous = catSelect.value;
    catSelect.innerHTML = state.categories.map(c =>
      `<option value="${c.id}">${escapeHtml(c.name)}</option>`
    ).join('');
    if (previous && state.categories.find(c => c.id === previous)) {
      catSelect.value = previous;
    }
  }
}

function setupOmnibar() {
  populateOmnibarDropdowns();

  const catSelect = $('#new-cat');
  const input = $('#omnibar-input');
  const panel = $('#omnibar-panel');
  const addBtn = $('#omnibar-add');
  const clearBtn = $('#omnibar-clear');
  const filterBtn = $('#omnibar-filter');

  // Track the last-added item name while the omnibar is open, so repeated
  // taps on + increment its quantity instead of adding a duplicate.
  let lastAddedName = null;

  // Track whether the user has manually picked a category for the next add.
  let userPickedCategory = false;

  // Live update as user types: search filter, button states, category guess
  function updateOmnibarState() {
    const value = input.value;
    state.searchQuery = value;
    clearBtn.hidden = !value;
    addBtn.disabled = !value.trim();

    // Reset last-added when input changes (they're typing something new)
    if (value.trim().toLowerCase() !== (lastAddedName || '').toLowerCase()) {
      lastAddedName = null;
    }

    // Auto-guess category as user types (unless they overrode it)
    if (!userPickedCategory && value.trim()) {
      const guessed = guessCategoryId(value.trim());
      if (state.categories.find(c => c.id === guessed)) {
        catSelect.value = guessed;
      }
    }

    renderItemList();
  }

  input.addEventListener('focus', () => {
    panel.hidden = false;
    lastAddedName = null;
    updateOmnibarState();
  });

  input.addEventListener('input', updateOmnibarState);

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addOrIncrement(); }
    else if (e.key === 'Escape') { e.preventDefault(); collapseOmnibar(); }
  });

  addBtn.addEventListener('click', () => addOrIncrement());

  clearBtn.addEventListener('click', () => {
    input.value = '';
    lastAddedName = null;
    updateOmnibarState();
    input.focus();
  });

  filterBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openStoreFilterMenu(filterBtn);
  });

  document.addEventListener('mousedown', (e) => {
    if (!panel.hidden) {
      // If the user has typed a search query, don't collapse when they tap
      // an item row — they may want to edit it while still seeing the filtered list.
      if (state.searchQuery) return;
      if (!panel.contains(e.target) && !e.target.closest('.omnibar')) {
        collapseOmnibar();
      }
    }
  });

  $('#clear-checked').addEventListener('click', async () => {
    await data.clearCheckedItems(state.activeListId);
    await reloadAll();
    render();
  });

  // Listonic-style: if the last-added item matches what's in the input,
  // increment its quantity instead of adding again.
  async function addOrIncrement() {
    const name = input.value.trim();
    if (!name) return;

    // state.items is already scoped to the active list via Firestore subcollection
    const activeItems = state.items;

    const matchName = lastAddedName || name;
    const existingItem = activeItems.find(i =>
      !i.checked &&
      (i.name || '').toLowerCase() === matchName.toLowerCase()
    );

    if (existingItem && lastAddedName) {
      const currentAmt = existingItem.qtyAmount || 1;
      const currentUnit = existingItem.qtyUnit || 'each';
      await data.updateItem(state.activeListId, existingItem.id, {
        qtyAmount: currentAmt + 1,
        qtyUnit: currentUnit,
      });
      await reloadAll();
      toast(`${existingItem.name}: ${currentAmt + 1}`, { duration: 1400 });
      render();
      return;
    }

    // Exact-name duplicate on this list — increment instead of double-adding
    const exact = activeItems.find(i =>
      !i.checked && (i.name || '').toLowerCase() === name.toLowerCase()
    );
    if (exact) {
      lastAddedName = exact.name;
      const currentAmt = exact.qtyAmount || 1;
      const currentUnit = exact.qtyUnit || 'each';
      await data.updateItem(state.activeListId, exact.id, {
        qtyAmount: currentAmt + 1,
        qtyUnit: currentUnit,
      });
      await reloadAll();
      toast(`${exact.name}: ${currentAmt + 1}`, { duration: 1400 });
      render();
      return;
    }

    const categoryId = catSelect.value;
    const storeIds = state.activeStoreIds.length > 0 ? [...state.activeStoreIds] : [];

    await data.addItem(state.activeListId, {
      name: sentenceCase(name),
      qtyAmount: null,
      qtyUnit: null,
      qty: '',
      categoryId,
      storeIds,
      addedBy: state.currentUid,
      addedByName: state.currentDisplayName,
    });
    await reloadAll();

    // Keep the input showing what was typed so the user can tap + again to increment.
    // Don't clear — just remember the name and keep focus.
    lastAddedName = sentenceCase(name);
    userPickedCategory = false;
    addBtn.disabled = false; // stays enabled for increment taps
    clearBtn.hidden = false;
    input.focus();
    render();
  }

  function collapseOmnibar() {
    panel.hidden = true;
    input.value = '';
    state.searchQuery = '';
    clearBtn.hidden = true;
    addBtn.disabled = true;
    lastAddedName = null;
    userPickedCategory = false;
    render();
  }
}

// Filter menu — popover anchored to the funnel button
function openStoreFilterMenu(anchorEl) {
  document.querySelectorAll('.store-picker').forEach(p => p.remove());

  if (state.stores.length === 0) return;

  // Working copy — toggled without committing until Apply
  let selected = new Set(state.activeStoreIds);

  const popover = document.createElement('div');
  popover.className = 'store-picker store-picker--multi';
  popover.setAttribute('role', 'menu');

  function renderRows() {
    const rows = state.stores.map(s => `
      <div class="store-picker-row store-picker-row--check" data-store-id="${s.id}">
        <span class="store-picker-check ${selected.has(s.id) ? 'checked' : ''}"></span>
        <span>${escapeHtml(s.name)}</span>
      </div>`).join('');

    const clearRow = selected.size > 0
      ? `<div class="store-picker-row store-picker-row--clear" id="sp-clear">Clear filter</div>`
      : '';

    popover.innerHTML = rows + clearRow;

    popover.querySelectorAll('[data-store-id]').forEach(row => {
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        const sid = row.dataset.storeId;
        if (selected.has(sid)) selected.delete(sid);
        else selected.add(sid);
        state.activeStoreIds = [...selected];
        renderRows();
        render();
      });
    });

    popover.querySelector('#sp-clear')?.addEventListener('click', (e) => {
      e.stopPropagation();
      selected.clear();
      state.activeStoreIds = [];
      popover.remove();
      render();
    });
  }
  renderRows();

  document.body.appendChild(popover);

  const rect = anchorEl.getBoundingClientRect();
  let top = rect.bottom + window.scrollY + 4;
  let left = rect.right + window.scrollX - popover.getBoundingClientRect().width;
  if (left < 8) left = 8;
  popover.style.top = `${top}px`;
  popover.style.left = `${left}px`;

  setTimeout(() => {
    const closeOnOutside = (e) => {
      if (!popover.contains(e.target) && e.target !== anchorEl) {
        popover.remove();
        document.removeEventListener('click', closeOnOutside);
      }
    };
    document.addEventListener('click', closeOnOutside);
  }, 0);
}

// =============================================================================
// EDIT MODAL — full item editor with photo + price + stores
// =============================================================================
function openEditModal(id) {
  const item = state.items.find(i => i.id === id);
  if (!item) return;

  const storeCheckboxes = state.stores.map(s => {
    const checked = (item.storeIds || []).includes(s.id);
    return `
      <label class="${checked ? 'checked' : ''}">
        <input type="checkbox" value="${s.id}" ${checked ? 'checked' : ''} />
        ${escapeHtml(s.name)}
      </label>`;
  }).join('');

  const catOptions = state.categories.map(c =>
    `<option value="${c.id}" ${c.id === item.categoryId ? 'selected' : ''}>${escapeHtml(c.name)}</option>`
  ).join('');

  // Quantity unit options — default to 'each' when item has no unit set
  const itemUnit = item.qtyUnit || 'each';
  const unitOptions = UNIT_KEYS.map(k =>
    `<option value="${k}" ${k === itemUnit ? 'selected' : ''}>${escapeHtml(unitLabel(k))}</option>`
  ).join('');

  const photoHtml = item.photo
    ? `<img class="photo-preview" src="${item.photo}" id="photo-preview" alt="" />`
    : `<div id="photo-preview"></div>`;

  // Price section: single price-per-unit, with last recorded shown for reference
  const priceSection = `
    <div class="modal-row">
      <label>Price <span style="color: var(--text-faint); font-weight: 400;">— optional</span></label>
      <p style="font-size: 11px; color: var(--text-muted); margin: 0 0 8px;" id="last-price-hint"></p>
      <div class="price-row-input">
        <span class="price-currency">$</span>
        <input type="number" step="0.01" min="0" placeholder="0.00" id="edit-price" />
        <span class="price-per">per</span>
        <select id="edit-price-unit">
          ${UNIT_KEYS.map(k => `<option value="${k}" ${k === 'each' ? 'selected' : ''}>${escapeHtml(unitLabel(k))}</option>`).join('')}
        </select>
      </div>
    </div>`;

  const modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.innerHTML = `
    <div class="modal" role="dialog" aria-label="Edit item">
      <h3>Edit item</h3>
      <div class="modal-row">
        <label>Name</label>
        <input id="edit-name" value="${escapeHtml(item.name)}" />
      </div>
      <div class="modal-row">
        <label>Quantity</label>
        <div class="qty-grid">
          <input type="number" id="edit-qty-amount" step="any" min="0" placeholder="Amount"
            value="${item.qtyAmount ?? ''}" />
          <select id="edit-qty-unit">${unitOptions}</select>
        </div>
      </div>
      <div class="modal-row">
        <label>Category</label>
        <select id="edit-cat">${catOptions}</select>
      </div>
      ${state.stores.length > 0 ? `
        <div class="modal-row">
          <label>Available at</label>
          <div class="checkbox-group" id="edit-stores">${storeCheckboxes}</div>
        </div>` : ''}
      ${priceSection}
      <div class="modal-row">
        <label>Note</label>
        <textarea id="edit-note" placeholder="e.g. unsalted, organic, etc.">${escapeHtml(item.note || '')}</textarea>
      </div>
      <div class="modal-row">
        <label>Photo</label>
        ${photoHtml}
        <div class="photo-controls">
          <input type="file" accept="image/*" id="edit-photo-input" style="display:none;" />
          <button type="button" class="btn-secondary" id="add-photo-btn">${item.photo ? 'Change photo' : 'Add photo'}</button>
          ${item.photo ? '<button type="button" class="btn-secondary btn-danger" id="remove-photo-btn">Remove</button>' : ''}
        </div>
      </div>
      <div class="modal-actions modal-actions-with-delete">
        <button type="button" class="btn-icon btn-icon-danger" id="delete-btn" title="Delete item" aria-label="Delete item">
          <svg class="icon" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
        </button>
        <div class="modal-actions-spacer"></div>
        <button type="button" class="btn-secondary" id="cancel-btn">Cancel</button>
        <button type="button" class="btn-primary" id="save-btn">Save</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  // Populate last-recorded price — pre-fill both value and unit
  (async () => {
    const last = await data.getPrice(state.currentUid, item.name);
    if (last) {
      $('#last-price-hint', modal).textContent =
        `Last recorded: $${last.price.toFixed(2)} per ${unitLabel(last.unit)}`;
      $('#edit-price', modal).value = last.price.toFixed(2);
      $('#edit-price-unit', modal).value = last.unit;
    } else {
      $('#last-price-hint', modal).textContent = 'Stored as $/unit so the estimate updates with your quantity.';
    }
  })();

  // Photo handling
  let pendingPhoto = item.photo || null;
  let photoRemoved = false;

  $('#add-photo-btn', modal).addEventListener('click', () => $('#edit-photo-input', modal).click());
  $('#edit-photo-input', modal).addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      pendingPhoto = await compressImage(file);
      photoRemoved = false;
      $('#photo-preview', modal).outerHTML = `<img class="photo-preview" src="${pendingPhoto}" id="photo-preview" alt="" />`;
    } catch (err) {
      alert('Could not process image: ' + err.message);
    }
  });

  const removeBtn = $('#remove-photo-btn', modal);
  if (removeBtn) {
    removeBtn.addEventListener('click', () => {
      pendingPhoto = null;
      photoRemoved = true;
      $('#photo-preview', modal).outerHTML = `<div id="photo-preview"></div>`;
      removeBtn.remove();
    });
  }

  // Store-tag checkbox visual state
  $('#edit-stores', modal)?.querySelectorAll('label').forEach(label => {
    const input = label.querySelector('input');
    input.addEventListener('change', () => {
      label.classList.toggle('checked', input.checked);
    });
  });

  $('#cancel-btn', modal).addEventListener('click', () => modal.remove());
  $('#delete-btn', modal).addEventListener('click', async () => {
    if (!confirm(`Delete "${item.name}"?`)) return;
    modal.remove();
    await data.deleteItem(state.activeListId, item.id);
    await reloadAll();
    render();
  });
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });

  $('#save-btn', modal).addEventListener('click', async () => {
    const newName = $('#edit-name', modal).value.trim();
    if (!newName) return;
    const qtyAmountRaw = $('#edit-qty-amount', modal).value.trim();
    const newQtyAmount = qtyAmountRaw ? parseFloat(qtyAmountRaw) : null;
    const newQtyUnit = $('#edit-qty-unit', modal).value || null;
    const newCat = $('#edit-cat', modal).value;
    const newNote = $('#edit-note', modal).value.trim();
    const newStores = [...modal.querySelectorAll('#edit-stores input:checked')].map(cb => cb.value);

    // Record the new price if entered
    const priceVal = $('#edit-price', modal).value.trim();
    const priceUnit = $('#edit-price-unit', modal).value;
    if (priceVal) {
      await data.setPrice(state.currentUid, newName, priceVal, priceUnit);
    }

    await data.updateItem(state.activeListId, item.id, {
      name: sentenceCase(newName),
      qtyAmount: newQtyAmount,
      qtyUnit: newQtyAmount ? (newQtyUnit || 'each') : null,
      qty: '', // clear legacy text qty when structured fields are set
      categoryId: newCat,
      note: newNote,
      storeIds: newStores,
      photo: photoRemoved ? null : pendingPhoto,
    });
    modal.remove();
    await reloadAll();
    render();
  });
}

// =============================================================================
// STORES VIEW — manage stores and their aisle ordering
// Rendered into a configurable container (default #view-stores; embedded in
// the Settings page via #settings-stores-container).
// =============================================================================
// =============================================================================
// SETTINGS — Categories + Stores
// =============================================================================
// Categories: global list, drag to reorder (order = aisle order everywhere),
//   add/rename/restyle/delete. No per-store ordering — one order rules all.
// Stores: lightweight tags only — add/rename/delete.

function renderStoresView(targetContainer) {
  const container = targetContainer || $('#view-stores');
  if (!container) return;

  let html = '';

  // ── CATEGORIES ──────────────────────────────────────────────────────────────
  html += `
    <div class="settings-section-label" style="margin-bottom: 8px;">
      Categories
    </div>
    <p class="settings-hint">
      Drag to set your aisle order — this order is used on all lists and stores.
      Tap the colour dot to restyle, tap the name to rename.
    </p>
    <div class="store-card" style="margin-bottom: 1.5rem;">
      <ul class="aisle-list" id="cat-order-list">
        ${state.categories.map(c => `
          <li class="aisle-row" draggable="true" data-cat-id="${c.id}">
            <span class="drag-handle" aria-label="Drag to reorder">
              <svg viewBox="0 0 24 24"><line x1="8" y1="6" x2="16" y2="6"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="18" x2="16" y2="18"/></svg>
            </span>
            ${categoryBadgeFor(c.id, 28)}
            <div class="aisle-name">
              <input class="aisle-name-input" data-cat-id="${c.id}" value="${escapeHtml(c.name)}" />
            </div>
            <div class="aisle-controls">
              <button class="btn-icon" data-cat-style="${c.id}" title="Edit icon &amp; colour">
                <svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
              </button>
              <button class="btn-icon btn-danger" data-delete-cat="${c.id}" title="Delete category">
                <svg class="icon" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
              </button>
            </div>
          </li>`).join('')}
      </ul>
      <div style="padding: 10px 14px; border-top: 0.5px solid var(--border);">
        <button class="btn-secondary" id="add-cat-btn" style="width: 100%;">+ Add category</button>
      </div>
    </div>

    <div class="settings-section-label" style="margin-bottom: 8px;">Stores</div>
    <p class="settings-hint">
      Stores are tags on items — use the filter to see only items from one store,
      sorted by the aisle order above.
    </p>
    <div class="store-card" style="margin-bottom: 0.75rem;">
      <ul class="aisle-list" id="store-list">
        ${state.stores.length === 0
          ? '<li style="padding: 12px 14px; color: var(--text-muted); font-size: 13px;">No stores yet — add one below.</li>'
          : state.stores.map(s => `
          <li class="aisle-row" data-store-id="${s.id}">
            <svg class="icon" viewBox="0 0 24 24" style="flex-shrink:0; color: var(--text-muted);"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
            <div class="aisle-name">
              <input class="store-name-input" data-store-id="${s.id}" value="${escapeHtml(s.name)}" />
            </div>
            <div class="aisle-controls">
              <button class="btn-icon btn-danger" data-delete-store="${s.id}" title="Delete store">
                <svg class="icon" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
              </button>
            </div>
          </li>`).join('')}
      </ul>
      <div style="padding: 10px 14px; border-top: 0.5px solid var(--border);">
        <button class="btn-secondary" id="add-store-btn" style="width: 100%;">+ Add store</button>
      </div>
    </div>`;

  container.innerHTML = html;

  // Hydrate category badges
  hydrateBadges(container);

  // ── Category events ─────────────────────────────────────────────────────────
  $('#add-cat-btn', container)?.addEventListener('click', promptAddCategory);

  container.querySelectorAll('[data-cat-style]').forEach(btn => {
    btn.addEventListener('click', () => openCategoryStyleModal(btn.dataset.catStyle));
  });

  container.querySelectorAll('[data-delete-cat]').forEach(btn => {
    btn.addEventListener('click', () => deleteCategoryConfirm(btn.dataset.deleteCat));
  });

  container.querySelectorAll('.aisle-name-input[data-cat-id]').forEach(input => {
    input.addEventListener('blur', async () => {
      const newName = input.value.trim();
      const cat = categoryById(input.dataset.catId);
      if (newName && newName !== cat?.name) {
        await data.updateCategory(state.currentUid, input.dataset.catId, { name: newName });
        await reloadAll();
        render();
      }
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') { input.value = categoryName(input.dataset.catId); input.blur(); }
    });
  });

  // Category drag-to-reorder (persists as the new global sort order)
  bindCategoryDragAndDrop(container);

  // ── Store events ─────────────────────────────────────────────────────────────
  $('#add-store-btn', container)?.addEventListener('click', promptAddStore);

  container.querySelectorAll('[data-delete-store]').forEach(btn => {
    btn.addEventListener('click', () => deleteStoreConfirm(btn.dataset.deleteStore));
  });

  container.querySelectorAll('.store-name-input[data-store-id]').forEach(input => {
    input.addEventListener('blur', async () => {
      const newName = input.value.trim();
      const store = state.stores.find(s => s.id === input.dataset.storeId);
      if (newName && newName !== store?.name) {
        await data.updateStore(state.currentUid, input.dataset.storeId, { name: newName });
        await reloadAll();
        render();
      }
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') input.blur();
    });
  });
}

// -----------------------------------------------------------------------------
// Category drag-to-reorder — reorders the GLOBAL category list
// -----------------------------------------------------------------------------
function bindCategoryDragAndDrop(container) {
  let draggedRow = null;
  const list = container.querySelector('#cat-order-list');
  if (!list) return;

  list.querySelectorAll('.aisle-row[draggable="true"]').forEach(row => {
    row.addEventListener('dragstart', e => {
      draggedRow = row;
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', row.dataset.catId);
    });

    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      list.querySelectorAll('.drag-over-top, .drag-over-bottom').forEach(el => {
        el.classList.remove('drag-over-top', 'drag-over-bottom');
      });
      draggedRow = null;
    });

    row.addEventListener('dragover', e => {
      e.preventDefault();
      if (!draggedRow || draggedRow === row) return;
      const rect = row.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      row.classList.toggle('drag-over-top', before);
      row.classList.toggle('drag-over-bottom', !before);
    });

    row.addEventListener('dragleave', () => {
      row.classList.remove('drag-over-top', 'drag-over-bottom');
    });

    row.addEventListener('drop', async e => {
      e.preventDefault();
      row.classList.remove('drag-over-top', 'drag-over-bottom');
      if (!draggedRow || draggedRow === row) return;

      const fromCatId = draggedRow.dataset.catId;
      const toCatId = row.dataset.catId;
      const rect = row.getBoundingClientRect();
      const dropBefore = (e.clientY - rect.top) < rect.height / 2;

      // Build new order from current DOM rows
      const allRows = [...list.querySelectorAll('.aisle-row')];
      const order = allRows.map(r => r.dataset.catId).filter(id => id !== fromCatId);
      const toIdx = order.indexOf(toCatId);
      const insertAt = dropBefore ? toIdx : toIdx + 1;
      order.splice(insertAt, 0, fromCatId);

      await data.reorderCategories(state.currentUid, order);
      await reloadAll();
      render();
    });
  });
}

async function promptAddCategory() {
  const name = prompt('New category name:');
  if (!name?.trim()) return;
  const guessed = getCategoryStyle({ name: name.trim() });
  await data.addCategory(state.currentUid, { name: name.trim(), icon: guessed.icon, colour: guessed.colour });
  await reloadAll();
  render();
  const newCat = state.categories[state.categories.length - 1];
  if (newCat) openCategoryStyleModal(newCat.id);
}

async function promptAddStore() {
  const name = prompt('Store name (e.g. Aldi, Coles, Bunnings):');
  if (!name?.trim()) return;
  await data.addStore(state.currentUid, name.trim());
  await reloadAll();
  render();
}

async function deleteStoreConfirm(id) {
  const store = state.stores.find(s => s.id === id);
  if (!store) return;
  const count = state.items.filter(i => i.storeIds?.includes(id)).length;
  const msg = count > 0
    ? `Delete "${store.name}"? ${count} item${count === 1 ? '' : 's'} will be untagged from this store.`
    : `Delete "${store.name}"?`;
  if (!confirm(msg)) return;
  state.activeStoreIds = state.activeStoreIds.filter(sid => sid !== id);
  await data.deleteStore(state.currentUid, id);
  await reloadAll();
  render();
}

async function deleteCategoryConfirm(id) {
  const cat = categoryById(id);
  if (!cat) return;
  const protectedIds = ['other'];
  if (protectedIds.includes(id)) {
    alert('"Other" is the fallback category and cannot be deleted.');
    return;
  }
  const count = state.items.filter(i => i.categoryId === id).length;
  const msg = count > 0
    ? `Delete "${cat.name}"? ${count} item${count === 1 ? '' : 's'} will move to Other.`
    : `Delete "${cat.name}"?`;
  if (!confirm(msg)) return;
  await data.deleteCategory(state.currentUid, id);
  await reloadAll();
  render();
}


async function openCategoryStyleModal(catId) {
  const cat = categoryById(catId);
  const currentStyle = getCategoryStyle(cat);

  let selectedIcon = currentStyle.icon;
  let selectedColour = currentStyle.colour;

  const modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.innerHTML = `
    <div class="modal" role="dialog" aria-label="Edit category style">
      <h3>${escapeHtml(cat.name)}</h3>

      <div class="modal-row" style="display: flex; align-items: center; gap: 12px; margin-bottom: 1.25rem;">
        <span style="font-size: 12px; color: var(--text-muted);">Preview</span>
        <span id="cat-style-preview"></span>
        <span id="cat-style-preview-name" style="font-size: 14px; font-weight: 500;">${escapeHtml(cat.name)}</span>
      </div>

      <div class="modal-row">
        <label>Colour</label>
        <div class="colour-grid">
          ${Object.entries(COLOUR_RAMPS).map(([key, ramp]) => `
            <button type="button"
              class="colour-swatch ${key === selectedColour ? 'selected' : ''}"
              data-colour="${key}"
              style="background: ${ramp.bg}; --swatch-accent: ${ramp.text};"
              title="${ramp.label}">
              <span class="colour-swatch-dot" style="background: ${ramp.text};"></span>
            </button>
          `).join('')}
        </div>
      </div>

      <div class="modal-row">
        <label>Icon</label>
        <div class="icon-search-wrap">
          <input id="cs-icon-search" placeholder="Search icons…" autocomplete="off" />
        </div>
        <div class="icon-grid" id="icon-grid"></div>
      </div>

      <div class="modal-actions">
        <button type="button" class="btn-secondary" id="cs-cancel">Cancel</button>
        <button type="button" class="btn-primary" id="cs-save">Save</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  // Populate icon grid with optional filter
  const grid = $('#icon-grid', modal);

  function renderCatIconGrid(filter = '') {
    const icons = filter.trim()
      ? AVAILABLE_ICONS.filter(n => n.includes(filter.toLowerCase().trim()))
      : AVAILABLE_ICONS;
    grid.innerHTML = icons.map(name => `
      <button type="button" class="icon-grid-cell ${name === selectedIcon ? 'selected' : ''}" data-icon="${name}">
        <span data-load-icon="${name}"></span>
      </button>`).join('');
    hydrateBadges(grid);
    grid.querySelectorAll('[data-icon]').forEach(btn => {
      btn.addEventListener('click', () => {
        selectedIcon = btn.dataset.icon;
        grid.querySelectorAll('[data-icon]').forEach(b => b.classList.toggle('selected', b === btn));
        updatePreview();
      });
    });
  }
  renderCatIconGrid();

  $('#cs-icon-search', modal).addEventListener('input', e => renderCatIconGrid(e.target.value));

  // Update preview
  function updatePreview() {
    const previewBadge = categoryBadgeHtml({
      ...cat,
      icon: selectedIcon,
      colour: selectedColour,
    }, { size: 28 });
    $('#cat-style-preview', modal).innerHTML = previewBadge;
    hydrateBadges($('#cat-style-preview', modal));
  }
  updatePreview();

  // Bind colour swatches
  modal.querySelectorAll('[data-colour]').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedColour = btn.dataset.colour;
      modal.querySelectorAll('[data-colour]').forEach(b => b.classList.toggle('selected', b === btn));
      updatePreview();
    });
  });

  // Update preview
  updatePreview();

  $('#cs-cancel', modal).addEventListener('click', () => modal.remove());
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

  $('#cs-save', modal).addEventListener('click', async () => {
    await data.updateCategory(state.currentUid, catId, { icon: selectedIcon, colour: selectedColour });
    modal.remove();
    await reloadAll();
    render();
  });
}

// =============================================================================
// RECIPES VIEW
// =============================================================================
// =============================================================================
// SETTINGS VIEW — embedded stores section + backup + coming-soon list
// =============================================================================
function renderSettingsView() {
  renderUserSection();
  const container = $('#settings-stores-container');
  if (container) renderStoresView(container);
  renderListsSettings();
  renderDisplaySettings();
}

function renderUserSection() {
  const container = document.getElementById('settings-user-container');
  if (!container) return;
  container.innerHTML = `
    <div class="store-card" style="margin-bottom:1.5rem;">
      <div class="store-card-header">
        <div>
          <div class="store-card-name">${escapeHtml(state.currentDisplayName)}</div>
          <div style="font-size:12px;color:var(--text-muted);">Signed in with Google</div>
        </div>
        <button class="btn-secondary" id="sign-out-btn">Sign out</button>
      </div>
    </div>`;
  document.getElementById('sign-out-btn')?.addEventListener('click', handleSignOut);
}

function renderListsSettings() {
  const container = document.getElementById('settings-lists-container');
  if (!container) return;

  container.innerHTML = `
    <div class="store-card" style="margin-bottom: 1.5rem;">
      <div class="store-card-header">
        <div class="store-card-name">Shopping lists</div>
        <button class="btn-secondary" id="sl-add-list">+ New list</button>
      </div>
      <ul class="aisle-list" id="list-settings-list">
        ${state.lists.map(list => {
          const ramp = COLOUR_RAMPS[list.colour] || COLOUR_RAMPS.teal;
          return `
          <li class="aisle-row list-settings-row" style="gap: 10px; align-items: center;">
            <span class="list-settings-icon" data-load-icon="${list.icon || 'shopping-cart'}"
              style="width:22px;height:22px;display:flex;align-items:center;justify-content:center;flex-shrink:0;color:${ramp.text};"></span>
            <span style="flex:1; font-size:14px;">${escapeHtml(list.name)}</span>
            <button class="btn-secondary btn-sm" data-edit-list-icon="${list.id}">Edit</button>
          </li>`;
        }).join('')}
      </ul>
    </div>`;

  $('#sl-add-list', container)?.addEventListener('click', () => openNewListModal());
  hydrateBadges(container);

  container.querySelectorAll('[data-edit-list-icon]').forEach(btn => {
    btn.addEventListener('click', () => {
      const list = state.lists.find(l => l.id === btn.dataset.editListIcon);
      if (list) openListIconModal(list);
    });
  });
}

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light') root.setAttribute('data-theme', 'light');
  else if (theme === 'dark') root.setAttribute('data-theme', 'dark');
  else root.removeAttribute('data-theme'); // auto — follows system
}

function renderDisplaySettings() {
  const container = document.getElementById('settings-display-container');
  if (!container) return;
  const ds = state.displaySettings;

  container.innerHTML = `
    <div class="store-card" style="margin-bottom:1.5rem;">
      <div class="store-card-header">
        <div class="store-card-name">Item display</div>
      </div>
      <ul class="aisle-list">
        ${[
          { key: 'showCategory', label: 'Category icon',  hint: 'Coloured icon on each row' },
          { key: 'showPrice',    label: 'Price',          hint: 'Estimated cost next to item' },
          { key: 'showStore',    label: 'Store tags',     hint: 'Which stores stock this item' },
          { key: 'showAddedBy',  label: 'Added by',       hint: 'Who added each item' },
        ].map(({ key, label, hint }) => `
          <li class="aisle-row" style="justify-content:space-between;">
            <div>
              <div style="font-size:14px;">${label}</div>
              <div style="font-size:11px;color:var(--text-muted);">${hint}</div>
            </div>
            <label class="toggle-switch">
              <input type="checkbox" data-display-key="${key}" ${ds[key] ? 'checked' : ''} />
              <span class="toggle-track"></span>
            </label>
          </li>`).join('')}
        <li class="aisle-row" style="justify-content:space-between;">
          <div>
            <div style="font-size:14px;">Theme</div>
            <div style="font-size:11px;color:var(--text-muted);">Appearance override</div>
          </div>
          <div class="theme-toggle">
            <button class="theme-btn ${ds.theme === 'light' ? 'active' : ''}" data-theme-val="light">Light</button>
            <button class="theme-btn ${ds.theme === 'auto' || !ds.theme ? 'active' : ''}" data-theme-val="auto">Auto</button>
            <button class="theme-btn ${ds.theme === 'dark' ? 'active' : ''}" data-theme-val="dark">Dark</button>
          </div>
        </li>
      </ul>
    </div>`;

  container.querySelectorAll('[data-theme-val]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const theme = btn.dataset.themeVal;
      await data.setDisplaySettings(state.currentUid, { theme });
      state.displaySettings.theme = theme;
      applyTheme(theme);
      renderDisplaySettings();
    });
  });

  container.querySelectorAll('[data-display-key]').forEach(input => {
    input.addEventListener('change', async () => {
      await data.setDisplaySettings(state.currentUid, { [input.dataset.displayKey]: input.checked });
      await reloadAll();
      render();
    });
  });
}

function renderRecipesView() {
  const container = $('#view-recipes');

  let html = `
    <div class="import-form">
      <input type="url" id="recipe-url" placeholder="Paste a recipe URL..." />
      <button class="btn-primary" id="import-btn-recipe">Import</button>
    </div>
    <div id="import-status"></div>
    <button class="btn-secondary" id="add-manual-recipe" style="margin-bottom: 1rem;">+ Add manually</button>
  `;

  if (state.recipes.length === 0) {
    html += `
      <div class="empty">
        <p>No recipes saved yet.</p>
        <p style="font-size: 12px;">Paste a URL from RecipeTin Eats, Taste, BBC Good Food, or any major recipe site.</p>
      </div>`;
  } else {
    state.recipes.forEach(recipe => {
      let cardDomain = '';
      if (recipe.sourceUrl) {
        try {
          cardDomain = new URL(recipe.sourceUrl).hostname.replace(/^www\./, '');
        } catch (e) { /* skip */ }
      }
      const thumbHtml = recipe.thumbnailUrl
        ? `<div class="recipe-thumb" style="background-image: url('${escapeHtml(recipe.thumbnailUrl)}')"></div>`
        : `<div class="recipe-thumb recipe-thumb--placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6l9-3 9 3v6c0 5.25-3.75 9.75-9 11.25C6.75 21.75 3 17.25 3 12V6z"/><path d="M9 12l2 2 4-4"/></svg></div>`;
      html += `
        <div class="recipe-card" data-recipe-id="${recipe.id}">
          <div class="recipe-card-inner">
            ${thumbHtml}
            <div class="recipe-card-body">
              <div class="recipe-header">
                <div style="flex:1; min-width:0;">
                  <div class="recipe-name">${escapeHtml(recipe.name)}</div>
                  ${recipe.sourceUrl ? `<span class="recipe-source">${escapeHtml(cardDomain || recipe.sourceUrl)}</span>` : ''}
                </div>
                <button class="btn-icon btn-danger" data-delete-recipe="${recipe.id}" title="Delete">
                  <svg class="icon" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
                </button>
              </div>
              <div class="recipe-ingredients">
                ${recipe.ingredients.length} ingredient${recipe.ingredients.length === 1 ? '' : 's'}:
                ${recipe.ingredients.slice(0, 3).map(i => escapeHtml(i.name)).join(', ')}${recipe.ingredients.length > 3 ? '…' : ''}
              </div>
              <div class="recipe-actions">
                <button class="btn-primary" data-view-recipe="${recipe.id}">Open &amp; add to list</button>
              </div>
            </div>
          </div>
        </div>`;
    });
  }

  container.innerHTML = html;

  $('#import-btn-recipe').addEventListener('click', handleRecipeImport);
  $('#add-manual-recipe').addEventListener('click', openManualRecipeModal);

  container.querySelectorAll('[data-delete-recipe]').forEach(btn => {
    btn.addEventListener('click', () => deleteRecipeConfirm(btn.dataset.deleteRecipe));
  });
  container.querySelectorAll('[data-view-recipe]').forEach(btn => {
    btn.addEventListener('click', () => viewRecipeIngredients(btn.dataset.viewRecipe));
  });
}

async function handleRecipeImport() {
  const url = $('#recipe-url').value.trim();
  if (!url) return;
  const status = $('#import-status');
  status.innerHTML = `<div class="import-status loading">Fetching recipe…</div>`;
  try {
    const recipe = await importRecipeFromUrl(url);
    if (!recipe.ingredients.length) {
      status.innerHTML = `<div class="import-status error">Could not find ingredients on that page.</div>`;
      return;
    }
    status.innerHTML = '';
    $('#recipe-url').value = '';
    // Open picker so the user can review, edit, and choose what to save
    openImportPickerModal(recipe);
  } catch (err) {
    status.innerHTML = `<div class="import-status error">${escapeHtml(err.message)}</div>`;
  }
}

// -----------------------------------------------------------------------------
// Import editor — shown after a successful URL import. Lets the user:
//   - Edit name, qty, note for each parsed ingredient (fix parser mistakes)
//   - Delete non-ingredients (e.g. section headers the parser didn't catch)
//   - Confirm to save the recipe
// This is for CLEANUP only. Selection of what to actually shop for happens
// later in the recipe view.
// -----------------------------------------------------------------------------
function openImportPickerModal(recipe) {
  // Clone ingredients — edits don't affect anything until saved
  const working = recipe.ingredients.map(ing => ({ ...ing }));

  const modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.innerHTML = `
    <div class="modal" role="dialog" aria-label="Review imported recipe">
      <h3>Review &amp; clean up</h3>
      <p style="font-size: 12px; color: var(--text-muted); margin: 0 0 12px;">
        Categories are auto-guessed — tap any pill to change it. Fix parser mistakes too, then save.
      </p>
      <div class="modal-row">
        <label>Recipe name</label>
        <input id="picker-recipe-name" value="${escapeHtml(recipe.name)}" />
      </div>
      <div class="modal-row">
        <label>Source URL</label>
        <input id="picker-recipe-url" type="url" value="${escapeHtml(recipe.sourceUrl || '')}" />
      </div>
      <div class="picker-toolbar">
        <span class="picker-count" id="picker-count"></span>
      </div>
      <div class="picker-list" id="picker-list"></div>
      <div class="modal-actions">
        <button type="button" class="btn-secondary" id="picker-cancel">Cancel</button>
        <button type="button" class="btn-primary" id="picker-save">Save recipe</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  function renderEditor() {
    const list = $('#picker-list', modal);
    list.innerHTML = working.map((ing, idx) => `
      <div class="editor-row" data-idx="${idx}">
        <div class="editor-fields">
          <div class="editor-name-row">
            ${categoryPillFor(ing.categoryId || 'other', { action: `editor-cat-pick-${idx}` })}
            <input class="editor-name" data-idx="${idx}" data-field="name"
              value="${escapeHtml(ing.name)}" placeholder="Ingredient name" />
          </div>
          <div class="editor-meta-row">
            <input class="editor-qty" data-idx="${idx}" data-field="qty"
              value="${escapeHtml(ing.qty || '')}" placeholder="Qty" />
            <input class="editor-note" data-idx="${idx}" data-field="note"
              value="${escapeHtml(ing.note || '')}" placeholder="Note (e.g. unsalted)" />
          </div>
          ${ing.original && ing.original !== ing.name
            ? `<div class="picker-original">From: ${escapeHtml(ing.original)}</div>` : ''}
        </div>
        <button type="button" class="btn-icon btn-danger" data-delete-idx="${idx}" title="Remove">
          <svg class="icon" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
        </button>
      </div>
    `).join('');

    // Sync edits into working[]
    list.querySelectorAll('input[data-field]').forEach(input => {
      input.addEventListener('input', () => {
        const i = parseInt(input.dataset.idx, 10);
        working[i][input.dataset.field] = input.value;
      });
    });

    // Delete buttons
    list.querySelectorAll('[data-delete-idx]').forEach(btn => {
      btn.addEventListener('click', () => {
        const i = parseInt(btn.dataset.deleteIdx, 10);
        working.splice(i, 1);
        renderEditor();
      });
    });

    // Category pill — opens picker, updates working[idx].categoryId
    list.querySelectorAll('.cat-pill[data-action^="editor-cat-pick-"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const i = parseInt(btn.dataset.action.replace('editor-cat-pick-', ''), 10);
        openCategoryPickerGeneric(btn, working[i].categoryId, async (newCatId) => {
          working[i].categoryId = newCatId;
          renderEditor();
        });
      });
    });

    // Hydrate the new pill icons
    hydrateBadges(list);

    $('#picker-count', modal).textContent =
      `${working.length} ingredient${working.length === 1 ? '' : 's'}`;
  }

  $('#picker-cancel', modal).addEventListener('click', () => modal.remove());
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

  $('#picker-save', modal).addEventListener('click', async () => {
    const name = $('#picker-recipe-name', modal).value.trim() || 'Imported recipe';
    const sourceUrl = $('#picker-recipe-url', modal).value.trim();
    const ingredients = working
      .filter(w => w.name && w.name.trim())
      .map(w => ({
        name: w.name.trim(),
        qty: (w.qty || '').trim(),
        note: (w.note || '').trim(),
        // Use the category the user reviewed/confirmed in the editor.
        // If somehow missing, fall back to a fresh guess.
        categoryId: w.categoryId || guessCategoryId(w.name.trim()),
      }));
    if (ingredients.length === 0) {
      alert('At least one ingredient is required to save the recipe.');
      return;
    }
    await data.addRecipe(state.currentUid, {
      name,
      sourceUrl,
      thumbnailUrl: recipe.thumbnailUrl || null,
      ingredients,
    });
    modal.remove();
    await reloadAll();
    render();
  });

  renderEditor();
}

function openManualRecipeModal() {
  const modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.innerHTML = `
    <div class="modal">
      <h3>Add recipe</h3>
      <div class="modal-row">
        <label>Recipe name</label>
        <input id="m-name" placeholder="e.g. Spaghetti bolognese" />
      </div>
      <div class="modal-row">
        <label>Source URL <span style="color: var(--text-faint); font-weight: 400;">— optional, for jumping back to the recipe when cooking</span></label>
        <input id="m-url" type="url" placeholder="https://..." />
      </div>
      <div class="modal-row">
        <label>Ingredients (one per line)</label>
        <textarea id="m-ingredients" rows="8" placeholder="500g beef mince&#10;1 onion&#10;2 cloves garlic&#10;..."></textarea>
      </div>
      <div class="modal-actions">
        <button class="btn-secondary" id="m-cancel">Cancel</button>
        <button class="btn-primary" id="m-save">Save</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  $('#m-cancel', modal).addEventListener('click', () => modal.remove());
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  $('#m-save', modal).addEventListener('click', async () => {
    const name = $('#m-name', modal).value.trim();
    const sourceUrl = $('#m-url', modal).value.trim();
    const ingredientsText = $('#m-ingredients', modal).value.trim();
    if (!name || !ingredientsText) return;
    // Parse each line so manual entries also get qty and note separated
    const ingredients = ingredientsText
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => parseIngredient(line))
      .filter(parsed => isRealIngredient(parsed))
      .map(parsed => ({
        name: parsed.name,
        qty: parsed.qty,
        note: parsed.note,
        categoryId: guessCategoryId(parsed.name),
      }));
    if (ingredients.length === 0) {
      alert('No valid ingredients found.');
      return;
    }
    await data.addRecipe(state.currentUid, { name, sourceUrl, ingredients });
    modal.remove();
    await reloadAll();
    render();
  });
}

async function deleteRecipeConfirm(id) {
  const recipe = state.recipes.find(r => r.id === id);
  if (!recipe) return;
  if (!confirm(`Delete recipe "${recipe.name}"?`)) return;
  await data.deleteRecipe(state.currentUid, id);
  await reloadAll();
  render();
}

function viewRecipeIngredients(id) {
  const recipe = state.recipes.find(r => r.id === id);
  if (!recipe) return;

  // Extract a friendly domain name from the URL for the link label
  let sourceDomain = '';
  if (recipe.sourceUrl) {
    try {
      sourceDomain = new URL(recipe.sourceUrl).hostname.replace(/^www\./, '');
    } catch (e) { /* invalid URL, skip */ }
  }

  const sourceBlock = recipe.sourceUrl ? `
    <a href="${escapeHtml(recipe.sourceUrl)}" target="_blank" rel="noopener noreferrer" class="recipe-source-banner">
      <div>
        <div class="recipe-source-label">Original recipe</div>
        <div class="recipe-source-domain">${escapeHtml(sourceDomain || recipe.sourceUrl)}</div>
      </div>
      <svg class="icon" viewBox="0 0 24 24" style="width:16px; height:16px;"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
    </a>` : '';

  const modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.innerHTML = `
    <div class="modal" role="dialog" aria-label="${escapeHtml(recipe.name)}">
      <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 1rem;">
        <h3 style="margin: 0;">${escapeHtml(recipe.name)}</h3>
        <button class="btn-icon" id="vr-edit" title="Edit recipe details">
          <svg class="icon" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
      </div>
      ${sourceBlock}
      <p style="font-size: 12px; color: var(--text-muted); margin: 0 0 12px;">
        Tap <strong style="font-weight: 500;">+ Add</strong> next to each ingredient you need. Greyed out means it's already on your list.
      </p>
      <div id="recipe-ingredients-list"></div>
      <div class="modal-actions">
        <button class="btn-secondary" id="vr-close">Close</button>
        <button class="btn-secondary" id="vr-add-remaining">Add all remaining</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  // Edit button — open simple name+URL edit modal
  $('#vr-edit', modal).addEventListener('click', () => {
    modal.remove();
    openEditRecipeMetadataModal(recipe);
  });

  function isAlreadyAdded(ingredientIdx) {
    const ing = recipe.ingredients[ingredientIdx];
    if (!ing) return false;
    // Loose-match against the active list (not checked items)
    return state.items.some(item =>
      !item.checked && looselyMatch(item.name, ing.name)
    );
  }

  function renderIngredients() {
    const container = $('#recipe-ingredients-list', modal);
    container.innerHTML = recipe.ingredients.map((ing, idx) => {
      const added = isAlreadyAdded(idx);
      return `
        <div class="recipe-ingredient-row ${added ? 'added' : ''}">
          <div class="recipe-ingredient-content">
            <div class="recipe-ingredient-name">${escapeHtml(ing.name)}</div>
            ${(ing.qty || ing.note) ? `
              <div class="recipe-ingredient-meta">
                ${ing.qty ? `<span class="picker-meta-tag qty">${escapeHtml(ing.qty)}</span>` : ''}
                ${ing.note ? `<span style="color: var(--text-muted);">${escapeHtml(ing.note)}</span>` : ''}
              </div>` : ''}
          </div>
          ${added
            ? `<span class="recipe-added-label">✓ Added</span>`
            : `<button class="btn-secondary btn-add-ingredient" data-add-idx="${idx}">+ Add</button>`}
        </div>`;
    }).join('');

    container.querySelectorAll('[data-add-idx]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const idx = parseInt(btn.dataset.addIdx, 10);
        await addSingleRecipeIngredient(recipe, idx);
        renderIngredients();
      });
    });

    // Hide "Add all remaining" if everything's added
    const remaining = recipe.ingredients.filter((_, idx) => !isAlreadyAdded(idx)).length;
    const addAllBtn = $('#vr-add-remaining', modal);
    if (remaining === 0) {
      addAllBtn.style.display = 'none';
    } else {
      addAllBtn.style.display = 'inline-block';
      addAllBtn.textContent = `Add all remaining (${remaining})`;
    }
  }

  $('#vr-close', modal).addEventListener('click', () => modal.remove());
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  $('#vr-add-remaining', modal).addEventListener('click', async () => {
    let added = 0;
    for (let idx = 0; idx < recipe.ingredients.length; idx++) {
      if (!isAlreadyAdded(idx)) {
        const result = await addSingleRecipeIngredient(recipe, idx);
        if (result?.added) added++;
      }
    }
    renderIngredients();
    if (added > 0) {
      toast(`Added ${added} item${added === 1 ? '' : 's'} to your list`);
    }
  });

  renderIngredients();
}

function openEditRecipeMetadataModal(recipe) {
  const modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.innerHTML = `
    <div class="modal" role="dialog" aria-label="Edit recipe">
      <h3>Edit recipe details</h3>
      <div class="modal-row">
        <label>Recipe name</label>
        <input id="erm-name" value="${escapeHtml(recipe.name)}" />
      </div>
      <div class="modal-row">
        <label>Source URL</label>
        <input id="erm-url" type="url" value="${escapeHtml(recipe.sourceUrl || '')}" placeholder="https://..." />
      </div>
      <div class="modal-row">
        <label>Image URL <span style="font-size:11px;color:var(--text-muted);font-weight:400;">— paste any image link</span></label>
        <input id="erm-image" type="url" value="${escapeHtml(recipe.thumbnailUrl || '')}" placeholder="https://example.com/image.jpg" />
        ${recipe.thumbnailUrl ? `
          <div style="margin-top:8px;border-radius:8px;overflow:hidden;max-height:120px;">
            <img src="${escapeHtml(recipe.thumbnailUrl)}" style="width:100%;height:120px;object-fit:cover;" />
          </div>` : ''}
      </div>
      <div class="modal-actions">
        <button class="btn-secondary" id="erm-cancel">Cancel</button>
        <button class="btn-primary" id="erm-save">Save</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  // Live preview as URL is typed
  $('#erm-image', modal).addEventListener('input', (e) => {
    const url = e.target.value.trim();
    let preview = modal.querySelector('.erm-img-preview');
    if (url) {
      if (!preview) {
        preview = document.createElement('div');
        preview.className = 'erm-img-preview';
        preview.style.cssText = 'margin-top:8px;border-radius:8px;overflow:hidden;max-height:120px;';
        preview.innerHTML = `<img src="${escapeHtml(url)}" style="width:100%;height:120px;object-fit:cover;" onerror="this.parentNode.style.display='none'" />`;
        e.target.parentNode.appendChild(preview);
      } else {
        preview.style.display = '';
        preview.querySelector('img').src = url;
      }
    } else if (preview) {
      preview.style.display = 'none';
    }
  });

  $('#erm-cancel', modal).addEventListener('click', () => {
    modal.remove();
    viewRecipeIngredients(recipe.id);
  });
  modal.addEventListener('click', e => {
    if (e.target === modal) {
      modal.remove();
      viewRecipeIngredients(recipe.id);
    }
  });
  $('#erm-save', modal).addEventListener('click', async () => {
    const name = $('#erm-name', modal).value.trim();
    const sourceUrl = $('#erm-url', modal).value.trim();
    const thumbnailUrl = $('#erm-image', modal).value.trim() || null;
    if (!name) return;
    await data.updateRecipe(state.currentUid, recipe.id, { name, sourceUrl, thumbnailUrl });
    modal.remove();
    await reloadAll();
    render();
    viewRecipeIngredients(recipe.id);
  });
}

async function addSingleRecipeIngredient(recipe, idx) {
  const ing = recipe.ingredients[idx];
  if (!ing) return;

  // Loose-match: is this ingredient already on the ACTIVE list?
  const activeItems = state.items.filter(i =>
    !i.checked && (i.listId || 'default') === state.activeListId
  );
  const existing = activeItems.find(i => looselyMatch(i.name, ing.name));

  if (existing) {
    toast(`${ing.name} is already on your list`);
    return { added: false, reason: 'duplicate' };
  }

  await data.addItem(state.activeListId, {
    name: ing.name,
    qty: '',
    qtyAmount: null,
    qtyUnit: null,
    categoryId: ing.categoryId || 'other',
    addedBy: state.currentUid,
      addedByName: state.currentDisplayName,
    note: '',
  });
  await reloadAll();
  render();
  return { added: true };
}

// =============================================================================
// BOOT
// =============================================================================

// =============================================================================
// SHARING — invite codes
// =============================================================================

async function openShareModal(listId) {
  const list = state.lists.find(l => l.id === listId);
  if (!list) return;

  const modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.innerHTML = `
    <div class="modal" role="dialog" aria-label="Share list">
      <h3>Share "${escapeHtml(list.name)}"</h3>
      <p style="font-size:13px;color:var(--text-muted);margin-bottom:1rem;">
        Share this list with someone. They'll need to sign in and enter the code.
      </p>
      <div id="invite-area">
        <button class="btn-primary" id="gen-invite" style="width:100%;">Generate invite code</button>
      </div>
      <div style="margin-top:1.25rem;">
        <div class="settings-section-label" style="margin-bottom:6px;">Members</div>
        <ul class="aisle-list">
          ${Object.entries(list.memberNames || {}).map(([uid, name]) => `
            <li class="aisle-row" style="justify-content:space-between;">
              <span style="font-size:14px;">${escapeHtml(name)}</span>
              ${uid !== list.ownerId && uid !== state.currentUid && list.ownerId === state.currentUid ? `
                <button class="btn-secondary btn-sm" data-remove-member="${uid}">Remove</button>` : `
                <span style="font-size:11px;color:var(--text-muted);">${uid === list.ownerId ? 'owner' : 'member'}</span>`}
            </li>`).join('')}
        </ul>
      </div>
      <div class="modal-actions" style="margin-top:1rem;">
        <button class="btn-secondary" id="share-close">Close</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  document.getElementById('gen-invite').addEventListener('click', async () => {
    const code = await data.createInvite(listId, state.currentUid);
    document.getElementById('invite-area').innerHTML = `
      <div style="text-align:center;">
        <div style="font-size:32px;font-weight:700;letter-spacing:6px;padding:16px;
          background:var(--bg-alt);border-radius:var(--radius);border:0.5px solid var(--border);">
          ${code}
        </div>
        <p style="font-size:12px;color:var(--text-muted);margin-top:8px;">
          Valid for 48 hours. Share this code with the person you want to invite.
        </p>
      </div>`;
  });

  modal.querySelectorAll('[data-remove-member]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Remove this member from the list?')) return;
      await data.removeMember(listId, state.currentUid, btn.dataset.removeMember);
      modal.remove();
    });
  });

  document.getElementById('share-close').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

async function openJoinModal() {
  const modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.innerHTML = `
    <div class="modal" role="dialog" aria-label="Join a list">
      <h3>Join a shared list</h3>
      <p style="font-size:13px;color:var(--text-muted);margin-bottom:1rem;">
        Enter the 6-character code from the person who shared a list with you.
      </p>
      <div class="modal-row">
        <input id="invite-code" placeholder="e.g. ABC123" autocomplete="off"
          style="text-transform:uppercase;letter-spacing:3px;font-size:20px;text-align:center;" maxlength="6" />
      </div>
      <div id="join-error" style="color:#c0392b;font-size:13px;display:none;margin-top:4px;"></div>
      <div class="modal-actions">
        <button class="btn-secondary" id="join-cancel">Cancel</button>
        <button class="btn-primary" id="join-confirm">Join</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  document.getElementById('invite-code').addEventListener('input', e => {
    e.target.value = e.target.value.toUpperCase();
  });

  document.getElementById('join-cancel').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

  document.getElementById('join-confirm').addEventListener('click', async () => {
    const code = document.getElementById('invite-code').value.trim();
    const errEl = document.getElementById('join-error');
    if (code.length < 4) { errEl.textContent = 'Enter a valid code.'; errEl.style.display = ''; return; }
    try {
      const listId = await data.acceptInvite(code, {
        uid: state.currentUid,
        displayName: state.currentDisplayName,
      });
      modal.remove();
      state.activeListId = listId;
      subscribeToActiveListItems();
      toast('Joined list!');
    } catch (err) {
      errEl.textContent = err.message;
      errEl.style.display = '';
    }
  });
}

// Added-by filter
function filterByAddedBy(uid) {
  if (state.filterAddedBy === uid) {
    state.filterAddedBy = null;
  } else {
    state.filterAddedBy = uid;
  }
  render();
}

// Sign out
async function handleSignOut() {
  if (!confirm('Sign out?')) return;
  await signOutUser();
}



// =============================================================================
// BOTTOM SHEET — mobile add/search experience
// =============================================================================

let _sheetHistory = {};      // cached item history
let _sheetRecentlyAdded = []; // items added in this session

async function openAddSheet() {
  // Load history if not cached
  if (Object.keys(_sheetHistory).length === 0) {
    _sheetHistory = await data.getItemHistory(state.currentUid);
  }
  _sheetRecentlyAdded = [];

  const backdrop = document.getElementById('add-sheet-backdrop');
  const sheet = document.getElementById('add-sheet');
  const input = document.getElementById('add-sheet-input');

  backdrop.hidden = false;
  sheet.hidden = false;

  // Trigger animation on next frame
  requestAnimationFrame(() => {
    backdrop.classList.add('open');
    sheet.classList.add('open');
    updateSheetPosition();
  });

  renderSheetSuggestions('');
  renderSheetRecent();

  // Auto-focus after animation
  setTimeout(() => input?.focus(), 320);
}

function closeAddSheet() {
  const backdrop = document.getElementById('add-sheet-backdrop');
  const sheet = document.getElementById('add-sheet');
  const input = document.getElementById('add-sheet-input');

  backdrop.classList.remove('open');
  sheet.classList.remove('open');

  setTimeout(() => {
    backdrop.hidden = true;
    sheet.hidden = true;
    if (input) input.value = '';
    document.getElementById('add-sheet-clear').hidden = true;
    renderSheetSuggestions('');
  }, 300);
}

function renderSheetSuggestions(query) {
  const container = document.getElementById('add-sheet-suggestions');
  if (!container) return;

  const q = query.trim().toLowerCase();

  // When query is empty: show recent history only (not the full current list)
  // When searching: merge current list items + history for complete results
  let candidates;
  if (!q) {
    candidates = Object.values(_sheetHistory)
      .sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0))
      .slice(0, 12);
  } else {
    // Merge current list items + history, deduplicated by name
    const currentItemNames = new Set(state.items.map(i => i.name.toLowerCase()));
    const currentItemCandidates = state.items.map(i => ({
      name: i.name,
      categoryId: i.categoryId,
      lastUsed: i.addedAt?.seconds ? i.addedAt.seconds * 1000 : Date.now(),
    }));
    const merged = [...currentItemCandidates];
    Object.values(_sheetHistory).forEach(h => {
      if (!currentItemNames.has(h.name.toLowerCase())) merged.push(h);
    });
    candidates = merged
      .filter(c => c.name.toLowerCase().includes(q))
      .sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0))
      .slice(0, 20);
  }

  let html = '';

  // No matches — show "Add X" option
  if (candidates.length === 0 && !q) {
    html += `<p style="padding:20px 16px;color:var(--text-muted);font-size:13px;">
      Start typing to add an item.</p>`;
  } else if (candidates.length === 0 && q) {
    html += `
      <div class="add-sheet-row" data-action="add-new" data-name="${escapeHtml(query)}">
        <div class="add-sheet-row-icon">
          <svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </div>
        <div class="add-sheet-row-body">
          <div class="add-sheet-row-name">Add "<strong>${escapeHtml(query)}</strong>"</div>
        </div>
      </div>`;
  }

  if (candidates.length > 0) {
    // Show "Add X" at top only if typed something with no exact match
    const exactMatch = q && candidates.find(c => c.name.toLowerCase() === q);
    if (q && !exactMatch) {
      html += `
        <div class="add-sheet-row" data-action="add-new" data-name="${escapeHtml(query)}">
          <div class="add-sheet-row-icon">
            <svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </div>
          <div class="add-sheet-row-body">
            <div class="add-sheet-row-name">Add "<strong>${escapeHtml(query)}</strong>"</div>
          </div>
        </div>`;
    }
    html += `<div class="add-sheet-section-label">${q ? 'Matches' : 'Recent'}</div>`;
    candidates.forEach(item => {
      // Check status on current list
      const onList = state.items.find(i =>
        !i.checked && i.name.toLowerCase() === item.name.toLowerCase()
      );
      const inTrolley = state.items.find(i =>
        i.checked && i.name.toLowerCase() === item.name.toLowerCase()
      );
      // Skip if item name matches nothing real in state (stale history entry)
      // but still show it as an addable suggestion

      let qty = '';
      let rowStyle = inTrolley ? 'opacity:0.5;' : '';
      if (onList) {
        const amt = onList.qtyAmount || 1;
        qty = `
          <div class="add-sheet-qty" data-item-id="${onList.id}">
            <button class="add-sheet-qty-btn" data-qty-action="dec" data-item-id="${onList.id}" data-current="${amt}">−</button>
            <span class="add-sheet-qty-val">${amt}</span>
            <button class="add-sheet-qty-btn" data-qty-action="inc" data-item-id="${onList.id}" data-current="${amt}">+</button>
          </div>`;
      }

      const catIcon = categoryIconFor(item.categoryId, {});
      const nameStyle = inTrolley ? 'text-decoration:line-through;' : '';

      html += `
        <div class="add-sheet-row" style="${rowStyle}" data-action="${onList ? 'on-list' : inTrolley ? 'uncheck' : 'add'}"
          data-name="${escapeHtml(item.name)}"
          data-cat="${escapeHtml(item.categoryId || 'other')}"
          data-item-id="${onList?.id || inTrolley?.id || ''}">
          <div class="add-sheet-row-icon" style="background:transparent;">
            ${catIcon}
          </div>
          <div class="add-sheet-row-body">
            <div class="add-sheet-row-name" style="${nameStyle}">${escapeHtml(item.name)}</div>
            ${qty}
          </div>
        </div>`;
    });
  }

  container.innerHTML = html;

  // Bind row actions
  container.querySelectorAll('[data-action="add-new"]').forEach(row => {
    row.addEventListener('click', () => sheetAddNew(row.dataset.name));
  });

  container.querySelectorAll('[data-action="add"]').forEach(row => {
    row.addEventListener('click', () => sheetAddItem(row.dataset.name, row.dataset.cat));
  });

  container.querySelectorAll('[data-action="uncheck"]').forEach(row => {
    row.addEventListener('click', () => sheetUncheckItem(row.dataset.itemId, row.dataset.name));
  });

  container.querySelectorAll('[data-action="on-list"]').forEach(row => {
    // Tap the row body to highlight in list — qty buttons handle quantity
    row.addEventListener('click', (e) => {
      if (e.target.closest('.add-sheet-qty')) return;
      highlightItemInList(row.dataset.itemId);
    });
  });

  // Qty buttons
  container.querySelectorAll('[data-qty-action]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const itemId = btn.dataset.itemId;
      const current = parseInt(btn.dataset.current) || 1;
      const newAmt = btn.dataset.qtyAction === 'inc' ? current + 1 : Math.max(1, current - 1);
      await data.updateItem(state.activeListId, itemId, { qtyAmount: newAmt, qtyUnit: 'each' });
      // Refresh suggestions
      renderSheetSuggestions(document.getElementById('add-sheet-input')?.value || '');
    });
  });
}

function renderSheetRecent() {
  const container = document.getElementById('add-sheet-recent');
  if (!container || _sheetRecentlyAdded.length === 0) {
    if (container) container.innerHTML = '';
    return;
  }
  container.innerHTML = `
    <div class="add-sheet-section-label">Just added</div>
    ${_sheetRecentlyAdded.map(name => `
      <div class="add-sheet-row" style="padding:8px 16px;">
        <div class="add-sheet-row-body">
          <div class="add-sheet-row-name" style="font-size:13px;">${escapeHtml(name)}</div>
        </div>
        <span class="add-sheet-row-badge add-sheet-row-badge--on-list">✓</span>
      </div>`).join('')}`;
}

async function sheetAddNew(name) {
  await sheetAddItem(name, guessCategoryId(name));
}

async function sheetAddItem(name, categoryId) {
  const trimmed = sentenceCase(name.trim());
  if (!trimmed) return;
  const catId = categoryId || guessCategoryId(trimmed);

  await data.addItem(state.activeListId, {
    name: trimmed,
    categoryId: catId,
    storeIds: state.activeStoreIds.length > 0 ? [...state.activeStoreIds] : [],
    addedBy: state.currentUid,
    addedByName: state.currentDisplayName,
  });

  // Record in history
  await data.recordItemHistory(state.currentUid, { name: trimmed, categoryId: catId });
  _sheetHistory[trimmed.toLowerCase()] = { name: trimmed, categoryId: catId, lastUsed: Date.now() };

  // Track recently added
  _sheetRecentlyAdded.unshift(trimmed);

  // Clear input, refresh suggestions
  const input = document.getElementById('add-sheet-input');
  if (input) input.value = '';
  document.getElementById('add-sheet-clear').hidden = true;
  renderSheetSuggestions('');
  renderSheetRecent();
}

async function sheetUncheckItem(itemId, name) {
  await data.updateItem(state.activeListId, itemId, { checked: false });
  _sheetRecentlyAdded.unshift(name);
  renderSheetSuggestions(document.getElementById('add-sheet-input')?.value || '');
  renderSheetRecent();
}

function highlightItemInList(itemId) {
  const el = document.querySelector(`.item[data-id="${itemId}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('item-highlight');
  setTimeout(() => el.classList.remove('item-highlight'), 1500);
}

function setupAddSheet() {
  const fab = document.getElementById('fab-add');
  const input = document.getElementById('add-sheet-input');
  const clearBtn = document.getElementById('add-sheet-clear');
  const doneBtn = document.getElementById('add-sheet-done');
  const backdrop = document.getElementById('add-sheet-backdrop');
  const sheet = document.getElementById('add-sheet');

  if (!fab) return;

  // Keep sheet pinned above keyboard using visualViewport
  function updateSheetPosition() {
    if (!sheet || sheet.hidden) return;
    if (window.visualViewport) {
      const vv = window.visualViewport;
      const offsetFromBottom = window.innerHeight - (vv.offsetTop + vv.height);
      sheet.style.bottom = `${Math.max(0, offsetFromBottom)}px`;
    } else {
      sheet.style.bottom = '0px';
    }
  }

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', updateSheetPosition);
    window.visualViewport.addEventListener('scroll', updateSheetPosition);
  }

  fab.addEventListener('click', openAddSheet);
  doneBtn?.addEventListener('click', closeAddSheet);
  backdrop?.addEventListener('click', closeAddSheet);

  input?.addEventListener('input', () => {
    const val = input.value;
    clearBtn.hidden = !val;
    renderSheetSuggestions(val);
  });

  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && input.value.trim()) {
      e.preventDefault();
      sheetAddNew(input.value.trim());
    }
    if (e.key === 'Escape') closeAddSheet();
  });

  clearBtn?.addEventListener('click', () => {
    input.value = '';
    clearBtn.hidden = true;
    renderSheetSuggestions('');
    input.focus();
  });
}

init();

// Sign-in button (outside app shell, always available)
document.getElementById('google-signin-btn')?.addEventListener('click', async () => {
  const btn = document.getElementById('google-signin-btn');
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  try {
    await signInWithGoogle();
  } catch (err) {
    btn.disabled = false;
    btn.innerHTML = `<svg viewBox="0 0 24 24" style="width:18px;height:18px;" xmlns="http://www.w3.org/2000/svg"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg> Sign in with Google`;
    console.error('Sign-in failed:', err);
  }
});
