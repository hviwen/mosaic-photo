type DbStoreNames = 'projects' | 'assets'

type MosaicDb = IDBDatabase

const DB_NAME = 'mosaicPhoto'
const DB_VERSION = 1

let dbPromise: Promise<MosaicDb> | null = null

export function openMosaicDb(): Promise<MosaicDb> {
  if (dbPromise) return dbPromise

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)

    req.onupgradeneeded = () => {
      const db = req.result

      if (!db.objectStoreNames.contains('projects')) {
        db.createObjectStore('projects', { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains('assets')) {
        db.createObjectStore('assets', { keyPath: 'id' })
      }
    }

    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('Failed to open IndexedDB'))
  })

  return dbPromise
}

export async function txStore<T>(
  storeName: DbStoreNames,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => Promise<T> | T
): Promise<T> {
  const db = await openMosaicDb()
  return await new Promise<T>((resolve, reject) => {
    const tx = db.transaction(storeName, mode)
    const store = tx.objectStore(storeName)

    Promise.resolve(fn(store))
      .then((v) => {
        tx.oncomplete = () => resolve(v)
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'))
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
      })
      .catch(reject)
  })
}

export function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'))
  })
}
