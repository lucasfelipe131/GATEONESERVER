let scenario = 'normal';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'QA06_SCENARIO' || !['normal', 'empty', 'metrics-error'].includes(event.data.scenario)) return;
  scenario = event.data.scenario;
  event.ports[0]?.postMessage({ applied: scenario });
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (scenario === 'metrics-error' && url.pathname === '/api/admin/command-center/metrics')
    event.respondWith(Promise.resolve(Response.json({ error: 'Falha sintética de QA' }, { status: 503 })));
  if (scenario === 'empty' && /^\/api\/admin\/command-center\/(exceptions|cases|activity|conversations)$/.test(url.pathname))
    event.respondWith(Promise.resolve(Response.json({ items: [], limit: 20, offset: 0, has_more: false })));
});
