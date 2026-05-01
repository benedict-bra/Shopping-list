// =============================================================================
// AUTH — Google sign-in and user profile management
// =============================================================================
import { auth, db } from './firebase.js';
import {
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
  doc, getDoc, setDoc, updateDoc, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ─── Sign in / out ────────────────────────────────────────────────────────────

export async function signInWithGoogle() {
  const provider = new GoogleAuthProvider();
  const result = await signInWithPopup(auth, provider);
  await ensureUserProfile(result.user);
  return result.user;
}

export async function signOutUser() {
  await signOut(auth);
}

// ─── Auth state observer ──────────────────────────────────────────────────────
// Calls onSignedIn(user) or onSignedOut() as auth state changes.
export function observeAuth(onSignedIn, onSignedOut) {
  return onAuthStateChanged(auth, async (user) => {
    if (user) {
      await ensureUserProfile(user);
      onSignedIn(user);
    } else {
      onSignedOut();
    }
  });
}

// ─── User profile ─────────────────────────────────────────────────────────────
// Stored at /users/{uid} — created on first sign-in, never overwritten.
export async function ensureUserProfile(user) {
  const ref = doc(db, 'users', user.uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, {
      uid: user.uid,
      displayName: user.displayName || 'Unknown',
      email: user.email,
      photoURL: user.photoURL || null,
      createdAt: serverTimestamp(),
    });
  }
  return snap.data() || {};
}

export async function getUserProfile(uid) {
  const snap = await getDoc(doc(db, 'users', uid));
  return snap.exists() ? snap.data() : null;
}

// ─── Current user helpers ─────────────────────────────────────────────────────
export function getCurrentUser() {
  return auth.currentUser;
}

export function getCurrentUid() {
  return auth.currentUser?.uid || null;
}

export function getDisplayName() {
  return auth.currentUser?.displayName || 'You';
}
