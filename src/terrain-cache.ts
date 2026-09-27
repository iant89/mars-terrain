export type CachedTerrainTile = {
  key: string;
  blob: Blob;
  crc: number;
};

const DATABASE = 'mars-terrain-dem-cache';
const STORE = 'tiles';
const VERSION = 1;

let databasePromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('This browser does not support IndexedDB terrain caching.'));
      return;
    }
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error('Unable to open the terrain cache.'));
    request.onblocked = () => reject(new Error('The terrain cache is blocked by another open app tab.'));
  }).catch(error => {
    databasePromise = null;
    throw error;
  });
  return databasePromise!;
}

export async function getCachedTerrainTile(key: string): Promise<CachedTerrainTile | undefined> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readonly');
    const request = transaction.objectStore(STORE).get(key);
    request.onsuccess = () => resolve(request.result as CachedTerrainTile | undefined);
    request.onerror = () => reject(request.error ?? new Error('Unable to read a cached terrain tile.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Terrain cache read was aborted.'));
  });
}

export async function cacheTerrainTile(tile: CachedTerrainTile): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    transaction.objectStore(STORE).put(tile);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Unable to save this terrain tile.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Terrain cache write was aborted.'));
  });
}
