// =============================================================================
// DATA LAYER — Firestore
// =============================================================================
// Same public API as the localStorage version so app.js changes are minimal.
// Phase 2 additions: real-time listeners, list sharing, per-user data.
//
// Data structure:
//   /users/{uid}                     — user profiles
//   /lists/{listId}                  — list metadata (name, icon, colour, members)
//   /lists/{listId}/items/{itemId}   — shopping items
//   /categories/{uid}/cats/{catId}   — per-user categories
//   /stores/{uid}/stores/{storeId}   — per-user stores
//   /invites/{code}                  — short-lived list invite codes
// =============================================================================

import { db } from './firebase.js';
import { getCurrentUid } from './auth.js';
import {
  collection, doc, getDoc, getDocs, setDoc, addDoc,
  updateDoc, deleteDoc, query, where, orderBy,
  onSnapshot, serverTimestamp, writeBatch, arrayUnion, arrayRemove, deleteField,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ─── Collection refs ──────────────────────────────────────────────────────────
const listRef    = (listId)         => doc(db, 'lists', listId);
const itemsRef   = (listId)         => collection(db, 'lists', listId, 'items');
const itemRef    = (listId, itemId) => doc(db, 'lists', listId, 'items', itemId);
const catsRef    = (uid)            => collection(db, 'categories', uid, 'cats');
const catRef     = (uid, catId)     => doc(db, 'categories', uid, 'cats', catId);
const storesRef  = (uid)            => collection(db, 'stores', uid, 'stores');
const storeRef   = (uid, storeId)   => doc(db, 'stores', uid, 'stores', storeId);
const displayRef = (uid)            => doc(db, 'users', uid, 'prefs', 'display');

// =============================================================================
// REAL-TIME LISTENERS
// =============================================================================

export function listenToLists(uid, callback) {
  // Query requires a composite index on (memberIds, orderIndex).
  // If the index isn't ready yet, fall back to unordered query.
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
    // Fall back to unordered — index is still building
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

export function listenToCategories(uid, callback) {
  return onSnapshot(catsRef(uid), async (snap) => {
    if (snap.empty) {
      // First run — seed defaults then the listener will fire again
      await seedCategories(uid);
      return;
    }
    const cats = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.orderIndex ?? 999) - (b.orderIndex ?? 999));
    callback(cats);
  });
}

export function listenToStores(uid, callback) {
  return onSnapshot(storesRef(uid), (snap) => {
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
    // Index still building — fall back to unordered
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
    createdAt: serverTimestamp(),
  };
  const ref = await addDoc(collection(db, 'lists'), newList);
  return { id: ref.id, ...newList };
}

export async function updateList(listId, changes) {
  await updateDoc(listRef(listId), changes);
}

export async function deleteList(uid, listId) {
  const lists = await getLists(uid);
  const remaining = lists.filter(l => l.id !== listId);
  if (remaining.length > 0) {
    const fallbackId = remaining[0].id;
    const itemsSnap = await getDocs(itemsRef(listId));
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
// CATEGORIES
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

export async function getCategories(uid) {
  const snap = await getDocs(catsRef(uid));
  if (snap.empty) {
    await seedCategories(uid);
    return DEFAULT_CATEGORIES;
  }
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.orderIndex ?? 999) - (b.orderIndex ?? 999));
}

async function seedCategories(uid) {
  const batch = writeBatch(db);
  DEFAULT_CATEGORIES.forEach(cat => batch.set(catRef(uid, cat.id), cat));
  await batch.commit();
}

export async function addCategory(uid, input) {
  const catData = typeof input === 'string' ? { name: input } : input;
  const cats = await getCategories(uid);
  const newCat = {
    name: (catData.name || '').trim(),
    icon: catData.icon || null,
    colour: catData.colour || 'gray',
    orderIndex: cats.length,
  };
  const ref = await addDoc(catsRef(uid), newCat);
  return { id: ref.id, ...newCat };
}

export async function updateCategory(uid, catId, changes) {
  await updateDoc(catRef(uid, catId), changes);
}

export async function deleteCategory(uid, catId) {
  await deleteDoc(catRef(uid, catId));
  const lists = await getLists(uid);
  for (const list of lists) {
    const snap = await getDocs(itemsRef(list.id));
    const batch = writeBatch(db);
    snap.docs.forEach(d => {
      if (d.data().categoryId === catId) batch.update(d.ref, { categoryId: 'other' });
    });
    await batch.commit();
  }
}

export async function reorderCategories(uid, orderedIds) {
  const batch = writeBatch(db);
  orderedIds.forEach((id, i) => batch.update(catRef(uid, id), { orderIndex: i }));
  await batch.commit();
}

// =============================================================================
// STORES
// =============================================================================

export async function getStores(uid) {
  const snap = await getDocs(storesRef(uid));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function addStore(uid, name) {
  const ref = await addDoc(storesRef(uid), { name: name.trim() });
  return { id: ref.id, name: name.trim() };
}

export async function updateStore(uid, storeId, changes) {
  await updateDoc(storeRef(uid, storeId), changes);
}

export async function deleteStore(uid, storeId) {
  await deleteDoc(storeRef(uid, storeId));
  const lists = await getLists(uid);
  for (const list of lists) {
    const snap = await getDocs(itemsRef(list.id));
    const batch = writeBatch(db);
    snap.docs.forEach(d => {
      const sids = d.data().storeIds || [];
      if (sids.includes(storeId)) batch.update(d.ref, { storeIds: sids.filter(s => s !== storeId) });
    });
    await batch.commit();
  }
}

// =============================================================================
// PRICES
// =============================================================================

export async function getPrices(uid) {
  const snap = await getDoc(doc(db, 'users', uid, 'prefs', 'prices'));
  return snap.exists() ? snap.data() : {};
}

export async function getPrice(uid, itemName) {
  const prices = await getPrices(uid);
  return prices[itemName.toLowerCase().trim()]?.current || null;
}

export async function setPrice(uid, itemName, price, unit) {
  if (!itemName || !price || !unit) return null;
  const key = itemName.toLowerCase().trim();
  const record = { price: parseFloat(price), unit, date: Date.now() };
  const ref = doc(db, 'users', uid, 'prefs', 'prices');
  const snap = await getDoc(ref);
  const prices = snap.exists() ? snap.data() : {};
  const existing = prices[key] || { history: [] };
  existing.current = record;
  existing.history = [...(existing.history || []), record].slice(-20);
  await setDoc(ref, { ...prices, [key]: existing }, { merge: true });
  return record;
}

// =============================================================================
// DISPLAY SETTINGS
// =============================================================================

const DEFAULT_DISPLAY = {
  showPrice:    true,
  showStore:    true,
  showCategory: true,
  showAddedBy:  false,
  theme:        'auto',  // 'auto' | 'light' | 'dark'
};

export async function getDisplaySettings(uid) {
  const snap = await getDoc(displayRef(uid));
  return { ...DEFAULT_DISPLAY, ...(snap.exists() ? snap.data() : {}) };
}

export async function setDisplaySettings(uid, changes) {
  await setDoc(displayRef(uid), changes, { merge: true });
}

// =============================================================================
// EXPORT
// =============================================================================

export async function exportAll(uid, lists) {
  const result = { version: 2, exportedAt: Date.now(), lists: [] };
  for (const list of lists) {
    const items = await getItems(list.id);
    result.lists.push({ ...list, items });
  }
  result.categories = await getCategories(uid);
  result.stores = await getStores(uid);
  return result;
}
