// Node 26 ships `localStorage` AND `Storage` globals of its own, and both shadow jsdom's.
//
// `localStorage` is gated behind `--localstorage-file`: without that flag Node still defines the
// accessor, but its getter emits `ExperimentalWarning: localStorage is not available…` and returns
// UNDEFINED. Under Vitest's jsdom environment `globalThis` and `window` are the same object, and
// Node's accessor is the one left standing on it — so `window.localStorage` is undefined too, and
// every bare `localStorage.…` in the app and in these tests reads that instead of a working store.
// On Node 26 that failed 130 tests across 17 files on `reading 'clear'` / `'getItem'` / `'setItem'`,
// for code that works fine in a browser.
//
// The second half is quieter and worse. Node's `Storage` CLASS shadows jsdom's too, so
// `Storage.prototype` is Node's prototype and not the one jsdom's storage objects actually inherit
// from. Every `vi.spyOn(Storage.prototype, "setItem")` in this suite — eight of them, all staging
// "storage throws" (Safari private mode, quota exceeded) — then patches a prototype nothing uses and
// silently tests NOTHING. Those cases go green while the failure path they exist to cover is never
// entered; `lib/drafts.test.ts` is the one that also asserts the write did not land, which is why it
// is the single case that fails rather than lies.
//
// Repairing it in each test file's `beforeEach` was the reflex and it is the wrong shape twice over:
// the reads happen in `src/lib/*` at MODULE scope (design, drafts, haptics, last-seen, push,
// operator-config, i18n), long before any `beforeEach` runs, and a per-file fix cannot restore a
// global class identity. So this runs FIRST — it is the first entry in `setupFiles`, evaluated before
// `setup.ts` and therefore before the `@/lib/*` imports it pulls in.
//
// Not `--localstorage-file`: that would make Node's store real AND file-backed, so it would persist
// between runs and leak between test files — strictly worse than the gap it closes.
//
// jsdom's own store is not gone, only displaced: the Window still holds it as `_localStorage`. Both
// repairs are therefore a REBIND to what jsdom already built, not a reimplementation — the store
// keeps its real quota behaviour and its real prototype, so the spies above bite again.

/**
 * jsdom's `Window` keeps the storage areas it built as `_localStorage` / `_sessionStorage` — names
 * Node's globals do not displace. The DOM lib cannot know about them, because they are jsdom's
 * internals rather than the platform's.
 */
interface JsdomWindowInternals {
  _localStorage?: Storage;
}

// SAFETY: an intersection, so this WIDENS `window` by exactly one optional property and every
// existing `Window` member keeps its own type — nothing is narrowed and no evidence is discarded.
// The added field is `Storage | undefined`, and the `undefined` half is what the guard below handles
// rather than assumes away.
const jsdomStore = (window as Window & JsdomWindowInternals)._localStorage;

if (jsdomStore === undefined) {
  // Loud on purpose. This reaches into a jsdom implementation detail, and if a jsdom upgrade renames
  // it the honest outcome is one legible failure here — not 130 cryptic ones, and emphatically not a
  // silent fallback that would leave the `Storage.prototype` spies inert all over again.
  throw new Error(
    "jsdom's window._localStorage is gone, so the Node 26 localStorage/Storage shadowing cannot be " +
      "repaired (src/test/node-localstorage.ts). Check how this jsdom version exposes its storage " +
      "areas and rebind to that instead.",
  );
}

// 1. The store, under the bare name every module reads.
//
// Rebound unconditionally rather than only when Node is found to have won this particular startup:
// the assignment is idempotent — where jsdom's own accessor did survive, this sets the name to the
// very object that accessor already returned — and being unconditional means never having to read
// the shadowed getter to find out, which is the read that emits Node's warning.
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  writable: true,
  value: jsdomStore,
});

// 2. The class whose prototype the suite spies on, so patching it reaches the real methods.
const jsdomStorageProto: object | null = Object.getPrototypeOf(jsdomStore);
if (jsdomStorageProto !== null && globalThis.Storage.prototype !== jsdomStorageProto) {
  Object.defineProperty(globalThis, "Storage", {
    configurable: true,
    writable: true,
    value: jsdomStorageProto.constructor,
  });
}
