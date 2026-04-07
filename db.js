// db.js — IndexedDB wrapper for local persistence

const DB_NAME = 'factures-db';
const DB_VERSION = 1;

let db = null;

export async function openDB() {
  if (db) return db;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('factures')) {
        const store = d.createObjectStore('factures', { keyPath: 'id', autoIncrement: true });
        store.createIndex('date', 'date');
        store.createIndex('categorie', 'categorie');
        store.createIndex('annee_mois', 'annee_mois');
      }
      if (!d.objectStoreNames.contains('settings')) {
        d.createObjectStore('settings', { keyPath: 'key' });
      }
    };
    req.onsuccess = e => { db = e.target.result; resolve(db); };
    req.onerror = () => reject(req.error);
  });
}

export async function saveSetting(key, value) {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('settings', 'readwrite');
    tx.objectStore('settings').put({ key, value });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export async function getSetting(key) {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('settings', 'readonly');
    const req = tx.objectStore('settings').get(key);
    req.onsuccess = () => resolve(req.result?.value ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function addFacture(facture) {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('factures', 'readwrite');
    const req = tx.objectStore('factures').add({
      ...facture,
      created_at: new Date().toISOString()
    });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function updateFacture(id, data) {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('factures', 'readwrite');
    const store = tx.objectStore('factures');
    const get = store.get(id);
    get.onsuccess = () => {
      const updated = { ...get.result, ...data, id };
      store.put(updated);
    };
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteFacture(id) {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('factures', 'readwrite');
    tx.objectStore('factures').delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAllFactures() {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('factures', 'readonly');
    const req = tx.objectStore('factures').getAll();
    req.onsuccess = () => resolve(req.result.reverse());
    req.onerror = () => reject(req.error);
  });
}

export async function getFacturesByPeriod(annee, mois) {
  const all = await getAllFactures();
  return all.filter(f => {
    const d = new Date(f.date);
    if (annee && d.getFullYear() !== parseInt(annee)) return false;
    if (mois && (d.getMonth() + 1) !== parseInt(mois)) return false;
    return true;
  });
}
