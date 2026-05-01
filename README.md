# Shopping List — Local Prototype

**Version 0.11.0** — Phase 1 local prototype.
See `version.json` for the full changelog.

A shared shopping list app for two people, with store-aisle ordering, multi-store tagging, recipes, URL imports, photos, and price tracking.

This is **Phase 1** — a local-only prototype. Phase 2 (v1.0.0) swaps the data layer for Firebase to enable real sharing across devices.

## Running it locally

The simplest way: a tiny local web server. The app uses ES modules (`import`/`export`), which most browsers won't load from a `file://` URL, so we need to serve it.

### Option A: Python (already on most computers)

```bash
cd shopping-list
python3 -m http.server 8000
```

Then open [http://localhost:8000](http://localhost:8000) in your browser.

### Option B: Node.js (if you've installed Node)

```bash
cd shopping-list
npx serve
```

Then open the URL it prints (usually [http://localhost:3000](http://localhost:3000)).

### Option C: VS Code Live Server

If you use VS Code, install the "Live Server" extension, right-click `index.html` → "Open with Live Server".

## Using it

1. **Adding as: You / Wife** — toggle at the top to simulate the two-person setup. Each item shows who added it.
2. **Stores & aisles tab** — add your stores (Aldi, Coles, Woolworths). For each store, set the order categories appear (the order you walk through the shop).
3. **Tag items with stores** — tap the pencil icon on any item and check which stores stock it.
4. **Filter by store on shopping day** — select a store at the top of the list to see only items tagged for it, in your custom aisle order.
5. **Recipes tab** — paste a recipe URL to import ingredients, or add manually. Tap "Add all to list" when planning.
6. **Photos** — tap the pencil icon on any item, add a photo. Auto-compressed to ~50KB.
7. **Prices** — record a price each shop. Next time you edit that item, you'll see "last $X.XX" and "low $X.XX" per store.
8. **Backup** — the up/down arrows in the header let you export and restore JSON backups. Useful before migrating to Firebase.

## Data storage

Everything lives in your browser's `localStorage`. This means:

- Data is per-browser — Chrome and Safari won't share it
- Clearing your browser data wipes the list
- You and your wife each have completely independent data

This is fine for prototyping. Phase 2 fixes it.

## File structure

```
shopping-list/
├── index.html              Entry point
├── css/
│   └── style.css           All styling
└── js/
    ├── app.js              UI logic and rendering
    ├── data.js             Storage layer ⭐ (only file that changes for Firebase)
    ├── recipe-import.js    Recipe URL parser
    └── photo.js            Image compression helper
```

The architecture deliberately isolates `data.js`. When we migrate to Firebase, only that file changes — every function in it (`getItems`, `addItem`, `updateItem`, etc.) gets a Firestore implementation, but the function signatures stay identical, so `app.js` doesn't need to change.

## What changes for Phase 2 (Firebase)

1. Replace `data.js` internals with Firestore calls. Function names and shapes stay the same.
2. Add a tiny auth layer — Google sign-in, replacing the manual "You / Wife" toggle.
3. Subscribe to Firestore real-time updates so changes appear instantly on both devices.
4. Move photos to Firebase Storage (separate from Firestore for cost reasons).
5. Add `firebase.json` config and deploy with `firebase deploy`.

The UI, the styling, and the feature set don't change.

## Recipe import — what works

The importer reads schema.org `Recipe` markup, which is the structured data Google uses for recipe cards. Sites that work well:

- RecipeTin Eats
- Taste.com.au
- BBC Good Food
- AllRecipes
- Bon Appétit
- Most food blogs that use WordPress recipe plugins

Sites that may not work:

- Sites with paywalls (NYT Cooking sometimes)
- Some highly customised blogs
- Very old recipe pages without structured data

If an import fails, you can always add the recipe manually.

## Known limitations of the prototype

- **No real sync.** Each browser has its own data. This is the whole point of Phase 2.
- **Photos count toward localStorage's ~5MB browser limit.** Realistic for a few dozen items.
- **CORS proxy for recipes** uses corsproxy.io (free, no key). If it ever goes down, we'd need a backup.
- **No undo.** Be careful with delete buttons.

## Backup before Phase 2

Before migrating to Firebase, hit the **export** button (download arrow in the header) on each browser. We'll import these into Firestore so you don't lose any data.
