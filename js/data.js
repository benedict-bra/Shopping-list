// =============================================================================
// DATA LAYER — Firestore v1.4.0
// =============================================================================
// Data structure:
//   /users/{uid}                          — user profiles + display settings
//   /users/{uid}/prefs/display            — display settings
//   /users/{uid}/prefs/history            — item add history
//   /lists/{listId}                       — list metadata
//   /lists/{listId}/items/{itemId}        — shopping items
//   /lists/{listId}/categories/{catId}    — per-list categories (NEW)
//   /lists/{listId}/stores/{storeId}      — per-list stores (NEW)
//   /lists/{listId}/prices/{key}          — shared prices per list (NEW)
//   /users/{uid}/recipes/{recipeId}       — recipes (private per user)
//   /invites/{code}                       — invite codes
// =============================================================================

import { db } from './firebase.js';
import {
  collection, doc, getDoc, getDocs, setDoc, addDoc,
  updateDoc, deleteDoc, query, where, orderBy,
  onSnapshot, serverTimestamp, writeBatch, arrayUnion, arrayRemove, deleteField,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ─── Collection refs ──────────────────────────────────────────────────────────
const listRef      = (listId)              => doc(db, 'lists', listId);
const itemsRef     = (listId)              => collection(db, 'lists', listId, 'items');
const itemRef      = (listId, itemId)      => doc(db, 'lists', listId, 'items', itemId);
const listCatsRef  = (listId)              => collection(db, 'lists', listId, 'categories');
const listCatRef   = (listId, catId)       => doc(db, 'lists', listId, 'categories', catId);
const listStrsRef  = (listId)              => collection(db, 'lists', listId, 'stores');
const listStrRef   = (listId, storeId)     => doc(db, 'lists', listId, 'stores', storeId);
const listPriceRef = (listId, key)         => doc(db, 'lists', listId, 'prices', key);
const listPricesRef= (listId)              => collection(db, 'lists', listId, 'prices');
const displayRef   = (uid)                 => doc(db, 'users', uid, 'prefs', 'display');

// Legacy refs — used only during migration
const legacyCatsRef  = (uid) => collection(db, 'categories', uid, 'cats');
const legacyStrsRef  = (uid) => collection(db, 'stores', uid, 'stores');

// =============================================================================
// DEFAULT CATEGORIES
// =============================================================================

export const DEFAULT_CATEGORIES = [
  { id: 'produce',   name: 'Produce',      icon: 'carrot',       colour: 'green',  orderIndex: 0 },
  { id: 'bakery',    name: 'Bakery',       icon: 'croissant',    colour: 'amber',  orderIndex: 1 },
  { id: 'dairy',     name: 'Dairy & eggs', icon: 'milk',         colour: 'blue',   orderIndex: 2 },
  { id: 'meat',      name: 'Meat & fish',  icon: 'beef',         colour: 'red',    orderIndex: 3 },
  { id: 'frozen',    name: 'Frozen',       icon: 'snowflake',    colour: 'teal',   orderIndex: 4 },
  { id: 'pantry',    name: 'Pantry',       icon: 'soup',         colour: 'coral',  orderIndex: 5 },
  { id: 'household', name: 'Household',    icon: 'spray-can',    colour: 'purple', orderIndex: 6 },
  { id: 'other',     name: 'Other',        icon: 'shopping-bag', colour: 'gray',   orderIndex: 7 },
];

// =============================================================================
// MIGRATION — run once to move categories/stores to per-list
// =============================================================================

export async function migrateToPerListData(uid) {
  const migrationRef = doc(db, 'users', uid, 'prefs', 'migrated_v14');
  const migSnap = await getDoc(migrationRef);
  if (migSnap.exists()) return; // already migrated

  console.log('Running v1.4.0 migration...');

  // Get existing global categories and stores
  const legacyCatsSnap = await getDocs(legacyCatsRef(uid));
  const legacyStrsSnap = await getDocs(legacyStrsRef(uid));

  const legacyCats = legacyCatsSnap.empty
    ? DEFAULT_CATEGORIES
    : legacyCatsSnap.docs.map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (a.orderIndex ?? 999) - (b.orderIndex ?? 999));

  const legacyStores = legacyStrsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  // Get all lists this user owns/is member of
  const lists = await getLists(uid);

  for (const list of lists) {
    // Check if list already has categories (e.g. already migrated from another member)
    const existingCatsSnap = await getDocs(listCatsRef(list.id));
    if (existingCatsSnap.empty) {
      // Seed with user's existing categories
      const batch = writeBatch(db);
      legacyCats.forEach(cat => {
        batch.set(listCatRef(list.id, cat.id), {
          name: cat.name,
          icon: cat.icon || null,
          colour: cat.colour || 'gray',
          orderIndex: cat.orderIndex ?? 0,
          active: true,
        });
      });
      await batch.commit();
    }

    const existingStrsSnap = await getDocs(listStrsRef(list.id));
    if (existingStrsSnap.empty && legacyStores.length > 0) {
      const batch = writeBatch(db);
      legacyStores.forEach(store => {
        batch.set(listStrRef(list.id, store.id), { name: store.name });
      });
      await batch.commit();
    }
  }

  // Mark migration complete
  await setDoc(migrationRef, { migratedAt: serverTimestamp() });
  console.log('v1.4.0 migration complete');
}

// =============================================================================
// REAL-TIME LISTENERS
// =============================================================================

export function listenToLists(uid, callback) {
  const orderedQuery = query(
    collection(db, 'lists'),
    where('memberIds', 'array-contains', uid),
    orderBy('orderIndex')
  );
  const fallbackQuery = query(
    collection(db, 'lists'),
    where('memberIds', 'array-contains', uid)
  );
  let unsub = onSnapshot(orderedQuery, (snap) => {
    callback(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  }, (err) => {
    console.warn('listenToLists ordered query failed, falling back:', err.message);
    unsub = onSnapshot(fallbackQuery, (snap) => {
      callback(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    });
  });
  return () => unsub();
}

export function listenToItems(listId, callback) {
  return onSnapshot(itemsRef(listId), (snap) => {
    callback(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  });
}

export function listenToListCategories(listId, callback) {
  return onSnapshot(listCatsRef(listId), async (snap) => {
    if (snap.empty) {
      await seedListCategories(listId);
      return;
    }
    const cats = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(c => c.active !== false)
      .sort((a, b) => (a.orderIndex ?? 999) - (b.orderIndex ?? 999));
    callback(cats);
  });
}

export function listenToListStores(listId, callback) {
  return onSnapshot(listStrsRef(listId), (snap) => {
    callback(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  });
}

// =============================================================================
// LISTS
// =============================================================================

export async function getLists(uid) {
  try {
    const q = query(
      collection(db, 'lists'),
      where('memberIds', 'array-contains', uid),
      orderBy('orderIndex')
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.warn('getLists index not ready, falling back:', err.message);
    const q = query(collection(db, 'lists'), where('memberIds', 'array-contains', uid));
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }
}

export async function createList(uid, { name, icon = 'shopping-cart', colour = 'teal', displayName = '' }) {
  const lists = await getLists(uid);
  const newList = {
    name: name.trim(),
    icon,
    colour,
    ownerId: uid,
    memberIds: [uid],
    memberNames: { [uid]: displayName },
    orderIndex: lists.length,
    customOrder: true,
    createdAt: serverTimestamp(),
  };
  const ref = await addDoc(collection(db, 'lists'), newList);
  const listId = ref.id;
  // Seed categories for the new list
  await seedListCategories(listId);
  return { id: listId, ...newList };
}

export async function updateList(listId, changes) {
  await updateDoc(listRef(listId), changes);
}

export async function deleteList(uid, listId) {
  const lists = await getLists(uid);
  const remaining = lists.filter(l => l.id !== listId);
  if (remaining.length === 0) throw new Error('Cannot delete the last list');
  const itemsSnap = await getDocs(itemsRef(listId));
  if (itemsSnap.size > 0) {
    const fallbackId = remaining[0].id;
    const batch = writeBatch(db);
    itemsSnap.docs.forEach(d => {
      batch.set(itemRef(fallbackId, d.id), d.data());
      batch.delete(d.ref);
    });
    await batch.commit();
  }
  await deleteDoc(listRef(listId));
}

export async function reorderLists(orderedIds) {
  const batch = writeBatch(db);
  orderedIds.forEach((id, i) => batch.update(listRef(id), { orderIndex: i }));
  await batch.commit();
}

// =============================================================================
// LIST SHARING
// =============================================================================

export async function createInvite(listId, createdByUid) {
  const code = Math.random().toString(36).slice(2, 8).toUpperCase();
  await setDoc(doc(db, 'invites', code), {
    listId,
    createdBy: createdByUid,
    createdAt: serverTimestamp(),
    expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
  });
  return code;
}

export async function acceptInvite(code, joiningUser) {
  const snap = await getDoc(doc(db, 'invites', code.toUpperCase()));
  if (!snap.exists()) throw new Error('Invite code not found.');
  const { listId, expiresAt } = snap.data();
  if (expiresAt.toDate() < new Date()) throw new Error('Invite code has expired.');
  await updateDoc(listRef(listId), {
    memberIds: arrayUnion(joiningUser.uid),
    [`memberNames.${joiningUser.uid}`]: joiningUser.displayName || joiningUser.email,
  });
  await deleteDoc(doc(db, 'invites', code.toUpperCase()));
  return listId;
}

export async function removeMember(listId, ownerId, memberUid) {
  const snap = await getDoc(listRef(listId));
  if (!snap.exists() || snap.data().ownerId !== ownerId) return;
  await updateDoc(listRef(listId), {
    memberIds: arrayRemove(memberUid),
    [`memberNames.${memberUid}`]: deleteField(),
  });
}

// =============================================================================
// ITEMS
// =============================================================================

export async function getItems(listId) {
  const snap = await getDocs(itemsRef(listId));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function addItem(listId, item) {
  const newItem = {
    name: item.name,
    qty: item.qty || '',
    qtyAmount: typeof item.qtyAmount === 'number' ? item.qtyAmount : null,
    qtyUnit: item.qtyUnit || null,
    categoryId: item.categoryId || 'other',
    storeIds: item.storeIds || [],
    note: item.note || '',
    checked: false,
    addedBy: item.addedBy || '',
    addedByName: item.addedByName || '',
    addedAt: serverTimestamp(),
    orderInCategory: item.orderInCategory ?? Date.now(),
  };
  const ref = await addDoc(itemsRef(listId), newItem);
  return { id: ref.id, ...newItem };
}

export async function updateItem(listId, itemId, changes) {
  await updateDoc(itemRef(listId, itemId), changes);
}

export async function deleteItem(listId, itemId) {
  await deleteDoc(itemRef(listId, itemId));
}

export async function clearCheckedItems(listId) {
  const snap = await getDocs(itemsRef(listId));
  const batch = writeBatch(db);
  snap.docs.forEach(d => { if (d.data().checked) batch.delete(d.ref); });
  await batch.commit();
}

// =============================================================================
// CATEGORIES — now per-list
// =============================================================================

async function seedListCategories(listId) {
  const batch = writeBatch(db);
  DEFAULT_CATEGORIES.forEach(cat => {
    batch.set(listCatRef(listId, cat.id), {
      name: cat.name,
      icon: cat.icon || null,
      colour: cat.colour || 'gray',
      orderIndex: cat.orderIndex ?? 0,
      active: true,
    });
  });
  await batch.commit();
}

export async function getCategories(listId) {
  const snap = await getDocs(listCatsRef(listId));
  if (snap.empty) {
    await seedListCategories(listId);
    return DEFAULT_CATEGORIES.map(c => ({ ...c, active: true }));
  }
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(c => c.active !== false)
    .sort((a, b) => (a.orderIndex ?? 999) - (b.orderIndex ?? 999));
}

export async function getAllCategories(listId) {
  // Returns all including inactive — for settings management
  const snap = await getDocs(listCatsRef(listId));
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.orderIndex ?? 999) - (b.orderIndex ?? 999));
}

export async function addCategory(listId, input) {
  const catData = typeof input === 'string' ? { name: input } : input;
  const cats = await getAllCategories(listId);
  const newCat = {
    name: (catData.name || '').trim(),
    icon: catData.icon || null,
    colour: catData.colour || 'gray',
    orderIndex: cats.length,
    active: true,
  };
  const ref = await addDoc(listCatsRef(listId), newCat);
  return { id: ref.id, ...newCat };
}

export async function updateCategory(listId, catId, changes) {
  await updateDoc(listCatRef(listId, catId), changes);
}

export async function deleteCategory(listId, catId) {
  // Soft delete — mark inactive so items aren't orphaned
  await updateDoc(listCatRef(listId, catId), { active: false });
  // Reassign items using this category to 'other'
  const snap = await getDocs(itemsRef(listId));
  const batch = writeBatch(db);
  snap.docs.forEach(d => {
    if (d.data().categoryId === catId) batch.update(d.ref, { categoryId: 'other' });
  });
  if (batch._mutations?.length > 0) await batch.commit();
}

export async function reorderCategories(listId, orderedIds) {
  const batch = writeBatch(db);
  orderedIds.forEach((id, i) => batch.update(listCatRef(listId, id), { orderIndex: i }));
  await batch.commit();
}

// =============================================================================
// STORES — now per-list
// =============================================================================

export async function getStores(listId) {
  const snap = await getDocs(listStrsRef(listId));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function addStore(listId, name) {
  const ref = await addDoc(listStrsRef(listId), { name: name.trim() });
  return { id: ref.id, name: name.trim() };
}

export async function updateStore(listId, storeId, changes) {
  await updateDoc(listStrRef(listId, storeId), changes);
}

export async function deleteStore(listId, storeId) {
  await deleteDoc(listStrRef(listId, storeId));
  const snap = await getDocs(itemsRef(listId));
  const batch = writeBatch(db);
  snap.docs.forEach(d => {
    const sids = d.data().storeIds || [];
    if (sids.includes(storeId)) batch.update(d.ref, { storeIds: sids.filter(s => s !== storeId) });
  });
  if (snap.docs.length > 0) await batch.commit();
}

// =============================================================================
// PRICES — now per-list (shared between all members)
// =============================================================================

export async function getPrice(listId, itemName) {
  const key = itemName.toLowerCase().trim().replace(/[^a-z0-9]/g, '_');
  const snap = await getDoc(listPriceRef(listId, key));
  return snap.exists() ? snap.data() : null;
}

export async function setPrice(listId, itemName, price, unit) {
  if (!itemName || !price || !unit) return null;
  const key = itemName.toLowerCase().trim().replace(/[^a-z0-9]/g, '_');
  const record = { price: parseFloat(price), unit, date: Date.now(), itemName };
  await setDoc(listPriceRef(listId, key), record);
  return record;
}

export async function getAllPrices(listId) {
  const snap = await getDocs(listPricesRef(listId));
  const result = {};
  snap.docs.forEach(d => { result[d.id] = d.data(); });
  return result;
}

// =============================================================================
// DISPLAY SETTINGS — private per user
// =============================================================================

const DEFAULT_DISPLAY = {
  showPrice:    true,
  showStore:    true,
  showCategory: true,
  showAddedBy:  false,
  theme:        'auto',
};

export async function getDisplaySettings(uid) {
  const snap = await getDoc(displayRef(uid));
  return { ...DEFAULT_DISPLAY, ...(snap.exists() ? snap.data() : {}) };
}

export async function setDisplaySettings(uid, changes) {
  await setDoc(displayRef(uid), changes, { merge: true });
}

// =============================================================================
// ITEM HISTORY — private per user
// =============================================================================

export async function getItemHistory(uid) {
  const snap = await getDoc(doc(db, 'users', uid, 'prefs', 'history'));
  return snap.exists() ? snap.data() : {};
}

export async function recordItemHistory(uid, item) {
  if (!item?.name) return;
  const key = item.name.toLowerCase().trim();
  const ref = doc(db, 'users', uid, 'prefs', 'history');
  await setDoc(ref, {
    [key]: {
      name: item.name,
      categoryId: item.categoryId || 'other',
      lastUsed: Date.now(),
    }
  }, { merge: true });
}

// =============================================================================
// RECIPES — private per user
// =============================================================================

const recipesRef = (uid) => collection(db, 'users', uid, 'recipes');
const recipeRef  = (uid, recipeId) => doc(db, 'users', uid, 'recipes', recipeId);

export async function getRecipes(uid) {
  const snap = await getDocs(recipesRef(uid));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.addedAt?.seconds || 0) - (a.addedAt?.seconds || 0));
}

export function listenToRecipes(uid, callback) {
  return onSnapshot(recipesRef(uid), (snap) => {
    const recipes = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.addedAt?.seconds || 0) - (a.addedAt?.seconds || 0));
    callback(recipes);
  });
}

export async function addRecipe(uid, recipe) {
  const newRecipe = {
    name: recipe.name || 'Imported recipe',
    sourceUrl: recipe.sourceUrl || '',
    thumbnailUrl: recipe.thumbnailUrl || null,
    ingredients: recipe.ingredients || [],
    addedAt: serverTimestamp(),
  };
  const ref = await addDoc(recipesRef(uid), newRecipe);
  return { id: ref.id, ...newRecipe };
}

export async function updateRecipe(uid, recipeId, changes) {
  await updateDoc(recipeRef(uid, recipeId), changes);
}

export async function deleteRecipe(uid, recipeId) {
  await deleteDoc(recipeRef(uid, recipeId));
}

// =============================================================================
// EXPORT
// =============================================================================

export async function exportAll(uid, lists) {
  const result = { version: 2, exportedAt: Date.now(), lists: [] };
  for (const list of lists) {
    const items = await getItems(list.id);
    const categories = await getAllCategories(list.id);
    const stores = await getStores(list.id);
    result.lists.push({ ...list, items, categories, stores });
  }
  return result;
}
