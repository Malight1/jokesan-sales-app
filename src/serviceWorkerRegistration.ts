// Registers the hand-written public/service-worker.js. Only runs on
// HTTPS or localhost (a browser requirement for service workers).
export function register() {
  if (!('serviceWorker' in navigator)) return;
  const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  if (window.location.protocol !== 'https:' && !isLocalhost) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/service-worker.js')
      .catch((err) => console.warn('Service worker registration failed:', err));
  });
}
