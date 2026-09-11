let connection;
function db() {
  return connection ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('browsercrew', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('tasks', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Saved tasks could not be opened. Existing records have been kept.'));
  });
}
export async function save(task) {
  if (task.schemaVersion !== 1) throw new Error('This task needs a newer version of BrowserCrew.');
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction('tasks', 'readwrite');
    tx.objectStore('tasks').put(structuredClone(task));
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(new Error('Progress could not be saved. No further action will run.'));
  });
}
export async function list() {
  const database = await db();
  return new Promise((resolve, reject) => {
    const request = database.transaction('tasks').objectStore('tasks').getAll();
    request.onsuccess = () => {
      if (request.result.some(t => t.schemaVersion !== 1)) return reject(new Error('Some saved tasks need a newer version. They have been kept unchanged.'));
      resolve(request.result.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    };
    request.onerror = () => reject(new Error('Saved tasks could not be read.'));
  });
}
export async function remove(id) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction('tasks', 'readwrite');
    tx.objectStore('tasks').delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(new Error('The saved task could not be deleted.'));
  });
}
