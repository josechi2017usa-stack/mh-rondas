// Service Worker — SOLO se encarga de que la app (HTML/JS/manifest/ícono)
// cargue sin internet. La cola de registros pendientes NO vive aquí, vive
// en IndexedDB manejada por app.js — así evitamos mezclar dos mecanismos
// de "offline" distintos y tener errores de lógica difíciles de rastrear.

const CACHE_NAME = 'mh-rondas-v2';
const APP_SHELL = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './icon.svg',
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(APP_SHELL);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (nombres) {
      return Promise.all(
        nombres
          .filter(function (n) { return n !== CACHE_NAME; })
          .map(function (n) { return caches.delete(n); })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function (event) {
  const url = new URL(event.request.url);

  // Cualquier petición que NO sea a nuestros propios archivos (por
  // ejemplo, las llamadas a la API de Apps Script) se deja pasar tal
  // cual — el manejo de offline para esas peticiones lo hace app.js.
  if (url.origin !== self.location.origin) {
    return;
  }

  // Red primero: si hay señal, siempre trae la versión más nueva y
  // actualiza la copia guardada. Solo usa la copia vieja si de verdad
  // no hay conexión — así las actualizaciones sí llegan sin que el
  // vigilante tenga que desinstalar y reinstalar la app.
  event.respondWith(
    fetch(event.request).then(function (respuestaRed) {
      const copia = respuestaRed.clone();
      caches.open(CACHE_NAME).then(function (cache) { cache.put(event.request, copia); });
      return respuestaRed;
    }).catch(function () {
      return caches.match(event.request).then(function (cacheado) {
        return cacheado || caches.match('./index.html');
      });
    })
  );
});
