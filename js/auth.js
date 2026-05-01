// =============================================================================
// AUTH — Google sign-in (redirect flow for GitHub Pages compatibility)
// =============================================================================
import { auth, db } from './firebase.js';
import {
  GoogleAuthProvider,
  signInWithRedirect,
  getRedirectResult,
  signOut,
  onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
  doc, getDoc, setDoc, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ─── Sign in — redirect flow (works on GitHub Pages) ─────────────────────────
export async function signInWithGoogle() {
  const provider = new GoogleAuthProvider();
  await signInWithRedirect(auth, provider);
  // Page redirects to Google and back — onAuthStateChanged fires on return
}

// Call once on page load to process the redirect return
export async function handleRedirectResult() {
  try {
    console.log('handleRedirectResult: checking for redirect result...');
    const result = await getRedirectResult(auth);
    if (result?.user) {
      console.log('handleRedirectResult: got user', result.user.email);
      await ensureUserProfile(result.user);
      return result.user;
    } else {
      console.log('handleRedirectResult: no redirect result');
      return null;
    }
  } catch (err) {
    console.error('Redirect sign-in error:', err.code, err.message);
    return null;
  }
}

export async function signOutUser() {
  await signOut(auth);
}

// ─── Auth state observer ──────────────────────────────────────────────────────
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

export function getCurrentUser() {
  return auth.currentUser;
}

export function getCurrentUid() {
  return auth.currentUser?.uid || null;
}

export function getDisplayName() {
  return auth.currentUser?.displayName || 'You';
}
