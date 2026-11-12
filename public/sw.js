self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
// Event data and invitation links always come from the server.
self.addEventListener('fetch', event => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(fetch(event.request).catch(() => new Response(
    'Majic Crew Tasks needs a connection. Reconnect and reload to open your board.',
    { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
  )));
});
