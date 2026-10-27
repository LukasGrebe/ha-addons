// Browser-side store of the recording and its decodings (IndexedDB, in memory when unavailable).
//
// Telegrams are stored once per distinct master/slave pair ("line", as in ebusd's hex notation)
// with how often and when they were seen; the runs the timeline fetched are stored as
// occurrences pointing at a line, so repeats cost a few bytes. Every decoding of a telegram with a
// definition is stored with the definition's key, its source (checkout or community layer) and the
// compile it came from, so that candidates can be compared and chosen without decoding again.
const DB_NAME = "ebusd-workbench";
const DB_VERSION = 1;
const STORES = {
  telegrams: { keyPath: "line", indexes: [["first_ms", "first_ms"]] },
  occurrences: { keyPath: ["line", "t0"], indexes: [["t0", "t0"], ["line", "line"]] },
  decodes: { keyPath: "id", indexes: [["line", "line"], ["defKey", "defKey"], ["compileId", "compileId"]] },
  definitions: { keyPath: "key", indexes: [] },
  compiles: { keyPath: "id", indexes: [] },
  meta: { keyPath: "key", indexes: [] },
};

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB request failed"));
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
  });
}

class IndexedStore {
  constructor(db) { this.db = db; this.kind = "indexeddb"; }

  async get(store, key) { return request(this.db.transaction(store).objectStore(store).get(key)); }

  async getAll(store, index = null, range = null) {
    const source = this.db.transaction(store).objectStore(store);
    return request(index ? source.index(index).getAll(range) : source.getAll(range));
  }

  async count(store) { return request(this.db.transaction(store).objectStore(store).count()); }

  async putAll(store, items) {
    if (!items.length) return;
    const tx = this.db.transaction(store, "readwrite");
    const os = tx.objectStore(store);
    for (const item of items) os.put(item);
    await transactionDone(tx);
  }

  async deleteKeys(store, keys) {
    if (!keys.length) return;
    const tx = this.db.transaction(store, "readwrite");
    const os = tx.objectStore(store);
    for (const key of keys) os.delete(key);
    await transactionDone(tx);
  }

  async clear(store) {
    const tx = this.db.transaction(store, "readwrite");
    tx.objectStore(store).clear();
    await transactionDone(tx);
  }

  async clearAll() { for (const name of Object.keys(STORES)) await this.clear(name); }
}

/** The same interface on Maps, for browsers without IndexedDB (private windows, old WebViews). */
class MemoryStore {
  constructor() { this.kind = "memory"; this.data = Object.fromEntries(Object.keys(STORES).map((n) => [n, new Map()])); }
  keyOf(store, item) {
    const kp = STORES[store].keyPath;
    return Array.isArray(kp) ? JSON.stringify(kp.map((k) => item[k])) : item[kp];
  }
  async get(store, key) { return this.data[store].get(Array.isArray(key) ? JSON.stringify(key) : key); }
  async getAll(store, index = null, range = null) {
    let items = [...this.data[store].values()];
    if (index && range) items = items.filter((i) => range.includes(i[index]));
    return items;
  }
  async count(store) { return this.data[store].size; }
  async putAll(store, items) { for (const item of items) this.data[store].set(this.keyOf(store, item), item); }
  async deleteKeys(store, keys) { for (const key of keys) this.data[store].delete(Array.isArray(key) ? JSON.stringify(key) : key); }
  async clear(store) { this.data[store].clear(); }
  async clearAll() { for (const name of Object.keys(STORES)) this.data[name].clear(); }
}

export async function openStore() {
  if (typeof indexedDB === "undefined") return new MemoryStore();
  try {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [name, spec] of Object.entries(STORES)) {
        if (db.objectStoreNames.contains(name)) continue;
        const os = db.createObjectStore(name, { keyPath: spec.keyPath });
        for (const [indexName, path] of spec.indexes) os.createIndex(indexName, path);
      }
    };
    const db = await request(req);
    db.onversionchange = () => db.close();
    return new IndexedStore(db);
  } catch (err) {
    console.warn("IndexedDB unavailable, keeping the recording in memory only:", err);
    return new MemoryStore();
  }
}

export const storeNames = Object.keys(STORES);
