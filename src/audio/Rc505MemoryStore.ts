import type { Rc505MemoryPersistence } from './Rc505Memory';

/** Separate namespace; legacy ProjectMemory data and codecs are never modified. */
export class Rc505MemoryStore implements Rc505MemoryPersistence {
  private database: Promise<IDBDatabase> | null = null;
  private open(): Promise<IDBDatabase> {
    if (!this.database) this.database = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('webrc505-semantic-memory', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('memories');
        request.result.createObjectStore('recovery');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Semantic Memory storage is blocked by another page.'));
    }).catch((error: unknown) => { this.database = null; throw error; });
    return this.database;
  }
  private slot(slot: number): void { if (!Number.isInteger(slot) || slot < 1 || slot > 99) throw new RangeError('Memory number must be 01–99.'); }
  private async put(store: string, key: IDBValidKey, bytes: Uint8Array | null): Promise<void> {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const tx = database.transaction(store, 'readwrite');
      if (bytes) tx.objectStore(store).put(bytes.slice(), key); else tx.objectStore(store).delete(key);
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error ?? new Error('Memory transaction aborted.'));
    });
  }
  public async read(slot: number): Promise<Uint8Array | null> {
    this.slot(slot);
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const tx = database.transaction('memories', 'readonly');
      const request = tx.objectStore('memories').get(slot);
      let bytes: Uint8Array | null = null;
      request.onsuccess = () => { if (request.result !== undefined) {
        if (!(request.result instanceof Uint8Array)) { tx.abort(); return; }
        bytes = request.result.slice();
      } };
      tx.oncomplete = () => resolve(bytes); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error ?? new Error('Corrupt Memory record.'));
    });
  }
  public write(slot: number, bytes: Uint8Array): Promise<void> { this.slot(slot); return this.put('memories', slot, bytes); }
  public recovery(bytes: Uint8Array): Promise<void> { return this.put('recovery', 'before-switch', bytes); }
  public clear(slot: number): Promise<void> { this.slot(slot); return this.put('memories', slot, null); }
  public async readRecovery(): Promise<Uint8Array | null> {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const tx = database.transaction('recovery', 'readonly');
      const request = tx.objectStore('recovery').get('before-switch');
      let result: Uint8Array | null = null;
      request.onsuccess = () => { if (request.result instanceof Uint8Array) result = request.result.slice(); };
      tx.oncomplete = () => resolve(result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
  }
}
