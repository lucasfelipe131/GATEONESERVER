const frame = document.getElementById('qaFrame');
const viewport = document.getElementById('viewport');
const scenario = document.getElementById('scenario');
const status = document.getElementById('qaStatus');
const sizes = { desktop: [1440, 900], tablet: [1024, 768], portrait: [768, 1024], mobile: [390, 844], large: [430, 932] };
function resize() {
  frame.className = viewport.value;
  const [w, h] = sizes[viewport.value];
  status.textContent = `${w} × ${h} CSS px · ${scenario.selectedOptions[0].textContent}`;
}
viewport.addEventListener('change', resize);
// Test-only response fixtures. No API writes, credentials or production data.
const registration = await navigator.serviceWorker.register('/qa06-sw.js', { scope: '/' });
await navigator.serviceWorker.ready;
const worker = registration.active;
worker.postMessage({ type: 'QA06_SCENARIO', scenario: 'normal' });
scenario.addEventListener('change', () => {
  const channel = new MessageChannel();
  channel.port1.onmessage = () => { frame.src = '/'; resize(); channel.port1.close(); };
  worker.postMessage({ type: 'QA06_SCENARIO', scenario: scenario.value }, [channel.port2]);
});
resize();
