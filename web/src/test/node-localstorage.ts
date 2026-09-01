// Node 26's own `localStorage` (undefined without `--localstorage-file`) and `Storage` globals shadow
// jsdom's, breaking every storage read and making `vi.spyOn(Storage.prototype, …)` patch a dead
// prototype. Rebind both to the store jsdom still holds as `window._localStorage`. Must be the first
// setup file: `src/lib/*` reads `localStorage` at module scope.

/** jsdom's internal handle on the storage area it built; not part of the DOM lib. */
interface JsdomWindowInternals {
  _localStorage?: Storage;
}

// SAFETY: the intersection only adds one optional field; the `undefined` case is handled below.
const jsdomStore = (window as Window & JsdomWindowInternals)._localStorage;

if (jsdomStore === undefined) {
  // Fail loudly: a silent in-memory fallback would leave the prototype spies inert.
  throw new Error(
    "jsdom's window._localStorage is gone, so the Node 26 localStorage/Storage shadowing cannot be " +
      "repaired (src/test/node-localstorage.ts). Check how this jsdom version exposes its storage " +
      "areas and rebind to that instead.",
  );
}

// Unconditional and idempotent, so the shadowed getter (which warns) is never read.
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  writable: true,
  value: jsdomStore,
});

// The class the suite spies on, so a patched prototype reaches the real methods.
const jsdomStorageProto: object | null = Object.getPrototypeOf(jsdomStore);
if (jsdomStorageProto !== null && globalThis.Storage.prototype !== jsdomStorageProto) {
  Object.defineProperty(globalThis, "Storage", {
    configurable: true,
    writable: true,
    value: jsdomStorageProto.constructor,
  });
}
