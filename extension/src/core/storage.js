// Tiny storage adapter so core modules don't hard-depend on chrome.storage.local.
// Tests inject an in-memory map; the extension pages inject the chrome-backed one.

export function createMemoryStorage() {
  const map = new Map();
  return {
    async get(key) { return map.has(key) ? map.get(key) : undefined; },
    async set(key, value) { map.set(key, value); },
    async remove(key) { map.delete(key); },
  };
}

export function createChromeStorage() {
  return {
    async get(key) {
      const result = await chrome.storage.local.get(key);
      return result[key];
    },
    async set(key, value) {
      await chrome.storage.local.set({ [key]: value });
    },
    async remove(key) {
      await chrome.storage.local.remove(key);
    },
  };
}
