// ============================================================
// CONFIGURACIÓN — cambia esto si vuelves a implementar el Apps Script
// ============================================================
const API_URL = 'https://script.google.com/macros/s/AKfycbySRlYlbopRDGAbcWyxJa8YZsEVZcX0DJslaKhyHawcA6bXwRz_JlpEnVyyI0nNXlhF/exec';

// ============================================================
// IndexedDB — cola de registros pendientes de sincronizar
// ============================================================
const DB_NAME = 'mh_rondas_db';
const STORE_PENDIENTES = 'pendientes';

function abrirDB() {
  return new Promise(function (resolve, reject) {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = function () {
      req.result.createObjectStore(STORE_PENDIENTES, { keyPath: 'intento_id' });
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
}

async function guardarPendiente(payload) {
  const db = await abrirDB();
  return new Promise(function (resolve, reject) {
    const tx = db.transaction(STORE_PENDIENTES, 'readwrite');
    tx.objectStore(STORE_PENDIENTES).put(payload);
    tx.oncomplete = resolve;
    tx.onerror = function () { reject(tx.error); };
  });
}

async function listarPendientes() {
  const db = await abrirDB();
  return new Promise(function (resolve, reject) {
    const tx = db.transaction(STORE_PENDIENTES, 'readonly');
    const req = tx.objectStore(STORE_PENDIENTES).getAll();
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
}

async function eliminarPendiente(intentoId) {
  const db = await abrirDB();
  return new Promise(function (resolve, reject) {
    const tx = db.transaction(STORE_PENDIENTES, 'readwrite');
    tx.objectStore(STORE_PENDIENTES).delete(intentoId);
    tx.oncomplete = resolve;
    tx.onerror = function () { reject(tx.error); };
  });
}

// ============================================================
// Llamadas a la API (Apps Script) — GET simple y POST simple, sin
// cabeceras personalizadas, para no disparar preflight de CORS.
// ============================================================
async function llamarAPI(payload, timeoutMs) {
  const controlador = new AbortController();
  const timer = setTimeout(function () { controlador.abort(); }, timeoutMs || 10000);
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      body: JSON.stringify(payload),
      signal: controlador.signal,
    });
    clearTimeout(timer);
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function obtenerDatosFormulario() {
  const res = await fetch(API_URL + '?accion=datos');
  const datos = await res.json();
  localStorage.setItem('mh_datos_cache', JSON.stringify(datos)); // respaldo para abrir offline
  return datos;
}

function obtenerDatosCache() {
  const guardado = localStorage.getItem('mh_datos_cache');
  return guardado ? JSON.parse(guardado) : { puntos: [], turnos: [] };
}

// ============================================================
// Envío de un registro: intenta en vivo, y si falla (o está offline)
// lo guarda en la cola local sin perder nada.
// ============================================================
async function enviarORegistrarComoPendiente(payload) {
  if (!navigator.onLine) {
    await guardarPendiente(payload);
    return { encolado: true };
  }
  try {
    const resultado = await llamarAPI(payload, 10000);
    return { encolado: false, resultado: resultado };
  } catch (err) {
    // Sin señal real, timeout, o el servidor no respondió: se guarda
    // igual, nunca se pierde el registro por un fallo de red.
    await guardarPendiente(payload);
    return { encolado: true };
  }
}

// ============================================================
// Sincronización de la cola — se llama al detectar conexión, al abrir
// la app, o manualmente. Procesa uno por uno; si uno falla por red,
// se detiene ahí (los demás se reintentan en la próxima pasada) para
// no generar una ráfaga de errores.
// ============================================================
let sincronizando = false;

async function sincronizarPendientes(onProgreso) {
  if (sincronizando || !navigator.onLine) return { enviados: 0, quedanPendientes: (await listarPendientes()).length };
  sincronizando = true;
  let enviados = 0;
  try {
    const pendientes = await listarPendientes();
    for (const item of pendientes) {
      try {
        const resultado = await llamarAPI(item, 10000);
        // El servidor ya es idempotente por intento_id: si este mismo
        // intento ya se había procesado antes, devuelve el mismo
        // resultado en vez de duplicar — así que siempre es seguro
        // borrar de la cola local tras una respuesta ok.
        if (resultado && resultado.ok) {
          await eliminarPendiente(item.intento_id);
          enviados++;
          if (onProgreso) onProgreso(enviados, pendientes.length);
        } else {
          // Error de datos (no de red): lo dejamos en cola para revisión,
          // pero seguimos intentando los demás.
          continue;
        }
      } catch (err) {
        // Falla de red a mitad de la sincronización: paramos aquí,
        // el resto se reintenta en la próxima pasada.
        break;
      }
    }
  } finally {
    sincronizando = false;
  }
  const restantes = await listarPendientes();
  return { enviados: enviados, quedanPendientes: restantes.length };
}

// Disparadores automáticos de sincronización
window.addEventListener('online', function () { sincronizarPendientes(actualizarBadgePendientes); });
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'visible' && navigator.onLine) {
    sincronizarPendientes(actualizarBadgePendientes);
  }
});

async function actualizarBadgePendientes() {
  const pendientes = await listarPendientes();
  const badge = document.getElementById('badge_pendientes');
  if (!badge) return;
  if (pendientes.length > 0) {
    badge.style.display = 'block';
    badge.textContent = '📥 ' + pendientes.length + ' registro(s) pendiente(s) de sincronizar';
  } else {
    badge.style.display = 'none';
  }
}

// ============================================================
// Registro del Service Worker
// ============================================================
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('./sw.js');
  });
}

// ============================================================
// Exporta lo que necesita la UI (index.html)
// ============================================================
window.MHRondas = {
  obtenerDatosFormulario: obtenerDatosFormulario,
  obtenerDatosCache: obtenerDatosCache,
  enviarORegistrarComoPendiente: enviarORegistrarComoPendiente,
  sincronizarPendientes: sincronizarPendientes,
  actualizarBadgePendientes: actualizarBadgePendientes,
  listarPendientes: listarPendientes,
};