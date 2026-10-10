// Read/write the production Windows profile through the CI-only WebView host.
const [port, operation] = process.argv.slice(2);
const deadline = Date.now() + 60000;
let target;
let inspection = 'no response';
while (Date.now() < deadline) {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    inspection = JSON.stringify(targets.map(item => ({ type: item.type, url: item.url })));
    target = targets.find(item => item.type === 'page' && new URL(item.url).hostname === 'wails.localhost');
    if (target?.webSocketDebuggerUrl) break;
  } catch (error) { inspection = String(error.cause || error); }
  await new Promise(resolve => setTimeout(resolve, 500));
}
if (!target?.webSocketDebuggerUrl) throw new Error('Actual BeefTV WebView did not start: ' + inspection);
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
const expression = `(async () => {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('beeftv-installer-acceptance', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction('drafts', ${JSON.stringify(operation === 'write' ? 'readwrite' : 'readonly')});
      const store = transaction.objectStore('drafts');
      const request = ${operation === 'write' ? "store.put('preserve unsaved draft', 'installer-draft')" : "store.get('installer-draft')"};
      let value;
      request.onsuccess = () => { value = request.result; };
      transaction.oncomplete = () => resolve(${operation === 'write' ? 'true' : "value === 'preserve unsaved draft'"});
      transaction.onerror = () => reject(transaction.error);
    });
  } finally { db.close(); }
})()`;
try {
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebView cache probe timed out')), 20000);
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) return;
      clearTimeout(timer);
      if (message.error || message.result?.exceptionDetails) reject(new Error('WebView cache evaluation failed'));
      else resolve(message.result?.result?.value);
    });
    socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  if (result !== true) throw new Error('Actual WebView IndexedDB draft was lost');
  console.log('PASS actual Windows WebView IndexedDB:', operation);
} finally { socket.close(); }
