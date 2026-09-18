// Session persistence: file contents, extracted rows, edits, review state.
// Storage is behind a tiny adapter (same idiom as core/storage.js) so tests
// use an in-memory store instead of a real IndexedDB.

const DB_NAME = 'statement-bridge';
const STORE_NAME = 'sessions';
const CLEANUP_DAYS = 30;
const WARN_DAYS = 25;

export function createMemorySessionStore() {
  const map = new Map();
  return {
    async getAll() { return [...map.values()]; },
    async get(id) { return map.get(id); },
    async put(session) { map.set(session.id, session); },
    async delete(id) { map.delete(id); },
  };
}

/** Real IndexedDB-backed adapter for use inside the extension pages. */
export function createIndexedDbSessionStore(idb = globalThis.indexedDB) {
  function open() {
    return new Promise((resolve, reject) => {
      const req = idb.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE_NAME)) {
          req.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function tx(mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE_NAME, mode);
      const store = t.objectStore(STORE_NAME);
      const request = fn(store);
      t.oncomplete = () => resolve(request?.result);
      t.onerror = () => reject(t.error);
    });
  }
  return {
    getAll: () => tx('readonly', (s) => s.getAll()),
    get: (id) => tx('readonly', (s) => s.get(id)),
    put: (session) => tx('readwrite', (s) => s.put(session)),
    delete: (id) => tx('readwrite', (s) => s.delete(id)),
  };
}

function daysSince(isoDate, now) {
  return (now.getTime() - new Date(isoDate).getTime()) / (1000 * 60 * 60 * 24);
}

/**
 * Delete sessions whose lastOpened is older than CLEANUP_DAYS (30). Call on open.
 * @returns {string[]} ids deleted
 */
export async function cleanupOldSessions(store, now = new Date()) {
  const all = await store.getAll();
  const deleted = [];
  for (const session of all) {
    if (daysSince(session.lastOpened, now) > CLEANUP_DAYS) {
      await store.delete(session.id);
      deleted.push(session.id);
    }
  }
  return deleted;
}

/**
 * List sessions nearing deletion (>= 25 days old, not yet past 30) with a
 * days-remaining count, for a "deletes in 5 days" style warning.
 */
export async function sessionsNearingDeletion(store, now = new Date()) {
  const all = await store.getAll();
  return all
    .map((s) => ({ id: s.id, daysOld: daysSince(s.lastOpened, now) }))
    .filter((s) => s.daysOld >= WARN_DAYS && s.daysOld <= CLEANUP_DAYS)
    .map((s) => ({ id: s.id, daysRemaining: Math.max(0, Math.ceil(CLEANUP_DAYS - s.daysOld)) }));
}

export async function saveSession(store, session) {
  const withTimestamp = { ...session, lastOpened: new Date().toISOString() };
  await store.put(withTimestamp);
  return withTimestamp;
}

export async function touchSession(store, id, now = new Date()) {
  const session = await store.get(id);
  if (!session) return null;
  const updated = { ...session, lastOpened: now.toISOString() };
  await store.put(updated);
  return updated;
}

export async function clearAllSessions(store) {
  const all = await store.getAll();
  for (const s of all) await store.delete(s.id);
  return all.length;
}

/** Autosave mapping-wizard progress onto a session's mappingProgress field (MP-13). */
export async function autosaveMappingProgress(store, sessionId, progress) {
  const session = (await store.get(sessionId)) || { id: sessionId };
  const updated = { ...session, mappingProgress: progress, lastOpened: new Date().toISOString() };
  await store.put(updated);
  return updated;
}

/** Estimate storage usage; returns null where navigator.storage.estimate is unavailable. */
export async function storageUsageEstimate(nav = globalThis.navigator) {
  if (!nav?.storage?.estimate) return null;
  const { usage, quota } = await nav.storage.estimate();
  return { usage, quota };
}
