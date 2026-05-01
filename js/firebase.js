// =============================================================================
// FIREBASE INITIALISATION
// =============================================================================
// Exports: db (Firestore), auth (Firebase Auth)
// All other modules import from here — never initialise Firebase elsewhere.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

const firebaseConfig = {
  apiKey: "AIzaSyDVBWn6ts3Wj4hvlOBLuADd7M6oYk4RAaE",
  authDomain: "shopping-list-dfd13.firebaseapp.com",
  projectId: "shopping-list-dfd13",
  storageBucket: "shopping-list-dfd13.firebasestorage.app",
  messagingSenderId: "1022797992585",
  appId: "1:1022797992585:web:f7f23785ff9368a482ec58"
};

const app = initializeApp(firebaseConfig);

export const db   = getFirestore(app);
export const auth = getAuth(app);
