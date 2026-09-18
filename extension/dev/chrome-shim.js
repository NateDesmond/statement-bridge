// Dev-only shim: maps the chrome.storage.local surface the extension code
// uses onto localStorage, so workspace.html's modules run in a plain tab
// (no real extension context) for screenshotting. Not shipped: only
// dev/index.html loads this, before workspace.html's own scripts.
(function () {
  const PREFIX = 'sb-dev:';
  function readAll() {
    const out = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key.startsWith(PREFIX)) out[key.slice(PREFIX.length)] = JSON.parse(localStorage.getItem(key));
    }
    return out;
  }
  window.chrome = {
    runtime: { getURL: (p) => p },
    storage: {
      local: {
        async get(key) {
          if (key == null) return readAll();
          if (typeof key === 'string') {
            const raw = localStorage.getItem(PREFIX + key);
            return raw == null ? {} : { [key]: JSON.parse(raw) };
          }
          const out = {};
          for (const k of key) {
            const raw = localStorage.getItem(PREFIX + k);
            if (raw != null) out[k] = JSON.parse(raw);
          }
          return out;
        },
        async set(obj) {
          for (const [k, v] of Object.entries(obj)) localStorage.setItem(PREFIX + k, JSON.stringify(v));
        },
        async remove(key) {
          const keys = Array.isArray(key) ? key : [key];
          for (const k of keys) localStorage.removeItem(PREFIX + k);
        },
        async getBytesInUse() {
          return new Blob(Object.values(readAll()).map((v) => JSON.stringify(v))).size;
        },
      },
    },
  };
})();
