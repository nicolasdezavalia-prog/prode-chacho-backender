#!/usr/bin/env node
/**
 * Diagnóstico Fase 2.1 Mundial — catálogo de equipos.
 *
 * Cubre:
 *   1. Schema/DB: columna `emoji` en mundial_equipos_catalogo.
 *   2. Auth real: login contra /api/auth/login.
 *   3. Torneo de diag dedicado a Fase 2 (no toca el de Fase 1 ni reales).
 *   4. Seed UPSERT: idempotencia + sincronización (pisa nombres editados).
 *   5. Alta manual de equipo individual + 409 por duplicado.
 *   6. Edición de nombre/emoji/grupo/activo + rechazo de cambio de código.
 *   7. Borrado + 404 al re-borrar.
 *   8. Bloqueo por estado: con estado 'cerrado', POST/PATCH/DELETE devuelven 409.
 *   9. No regresión Fase 1: torneos, config, tipo inmutable, recalcular bloqueado.
 *
 * Para testear bloqueo por estado, manipula directamente `mundial_config.estado`
 * vía DB (BYPASS de la máquina de estados forward-only del backend). Solo afecta
 * al torneo de diag y se restaura en finally — el resto del sistema no se ve afectado.
 *
 * Config por env vars (todas con fallback):
 *   DIAG_EMAIL       (default: admin@prode.com)
 *   DIAG_PASSWORD    (default: admin123)
 *   API_BASE_URL     (default: http://localhost:3001)
 *   DB_PATH          (default: ./prode.db relativo al script)
 *
 * Uso:
 *   cd backend
 *   node diagnostico-mundial-fase2.js
 *
 * Requiere: Node 22.5+ (node:sqlite, fetch global) y backend corriendo.
 *
 * Limpieza posterior (opcional, manual via sqlite3):
 *   DELETE FROM mundial_equipos_catalogo WHERE torneo_id IN
 *     (SELECT id FROM torneos WHERE nombre = '__DIAG_MUNDIAL_FASE2__');
 *   DELETE FROM mundial_config           WHERE torneo_id IN
 *     (SELECT id FROM torneos WHERE nombre = '__DIAG_MUNDIAL_FASE2__');
 *   DELETE FROM torneos                  WHERE nombre = '__DIAG_MUNDIAL_FASE2__';
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DIAG_EMAIL         = process.env.DIAG_EMAIL    || 'admin@prode.com';
const DIAG_PASSWORD      = process.env.DIAG_PASSWORD || 'admin123';
const API_BASE_URL       = process.env.API_BASE_URL  || 'http://localhost:3001';
const DB_PATH            = process.env.DB_PATH       || path.join(__dirname, 'prode.db');
const DIAG_TORNEO_NOMBRE = '__DIAG_MUNDIAL_FASE2__';
// Código del equipo de prueba — debe respetar el límite 2-10 chars del backend.
// 'DIAGTEST' (8 chars) es suficientemente distintivo y no choca con códigos reales
// del Mundial 2026 (todos los del dataset oficial son códigos de 3 letras).
const TEST_EQUIPO_CODIGO = 'DIAGTEST';

// ── pintura ─────────────────────────────────────────────────────────────────
const c    = (txt, code) => `[${code}m${txt}[0m`;
const OK   = (s) => c(`  ✓ ${s}`, '32');
const FAIL = (s) => c(`  ✗ ${s}`, '31');
const WARN = (s) => c(`  ⚠ ${s}`, '33');
const INFO = (s) => c(`  · ${s}`, '36');
const H    = (s) => `\n${c('━━━', '90')} ${c(s, '1;37')} ${c('━━━', '90')}`;

let exitCode = 0;
const ok   = (m) => console.log(OK(m));
const fail = (m) => { exitCode = 1; console.log(FAIL(m)); };
const warn = (m) => console.log(WARN(m));
const info = (m) => console.log(INFO(m));

// ── HTTP helper ─────────────────────────────────────────────────────────────
let TOKEN = null;
let USER  = null;

async function http(method, p, body) {
  const url  = `${API_BASE_URL}${p}`;
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (TOKEN) opts.headers.Authorization = `Bearer ${TOKEN}`;
  if (body !== undefined) opts.body = JSON.stringify(body);
  let res;
  try { res = await fetch(url, opts); }
  catch (e) { return { status: 0, error: e.message }; }
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

// ── 1. Schema DB ────────────────────────────────────────────────────────────
function dbChecks() {
  console.log(H('1. Schema/DB (read-only)'));
  let db;
  try { db = new DatabaseSync(DB_PATH); }
  catch (e) {
    fail(`No pude abrir la DB en ${DB_PATH}: ${e.message}`);
    process.exit(1);
  }

  const cols = db.prepare("PRAGMA table_info('mundial_equipos_catalogo')").all();
  const esperadas = ['id', 'torneo_id', 'codigo', 'nombre', 'emoji', 'grupo', 'activo'];
  for (const name of esperadas) {
    const col = cols.find(c => c.name === name);
    if (col) ok(`mundial_equipos_catalogo.${name} OK (type=${col.type})`);
    else fail(`Columna ${name} faltante en mundial_equipos_catalogo`);
  }

  db.close();
}

// ── 2. Auth ─────────────────────────────────────────────────────────────────
let TIENE_PERMISO_MUNDIAL = false;

async function authCheck() {
  console.log(H('2. Auth (login real)'));
  info(`API_BASE_URL = ${API_BASE_URL}`);
  info(`DIAG_EMAIL   = ${DIAG_EMAIL}`);

  const r = await http('POST', '/api/auth/login', { email: DIAG_EMAIL, password: DIAG_PASSWORD });
  if (r.status === 0) {
    fail(`No pude conectar al backend: ${r.error}. ¿Está corriendo "npm run dev"?`);
    process.exit(1);
  }
  if (r.status !== 200 || !r.data || !r.data.token) {
    fail(`Login falló (status ${r.status}): ${JSON.stringify(r.data)}`);
    process.exit(1);
  }
  TOKEN = r.data.token;
  USER  = r.data.user;
  ok(`Login OK — id=${USER.id} email=${USER.email} role=${USER.role}`);

  const perms = await http('GET', '/api/permisos/me');
  if (perms.status === 200 && perms.data && Array.isArray(perms.data.permisos)) {
    TIENE_PERMISO_MUNDIAL = perms.data.permisos.includes('gestionar_mundial');
    if (USER.role === 'superadmin') {
      ok(`Superadmin: bypass de permisos`);
      TIENE_PERMISO_MUNDIAL = true;
    } else if (TIENE_PERMISO_MUNDIAL) {
      ok(`Tiene 'gestionar_mundial'`);
    } else {
      warn(`Sin permiso 'gestionar_mundial'. Endpoints admin van a devolver 403.`);
      warn(`Para diagnóstico completo: correr con superadmin.`);
    }
  } else {
    warn(`No pude leer /api/permisos/me (status ${perms.status}).`);
  }
}

// ── 3. Torneo de diag ───────────────────────────────────────────────────────
async function obtenerOCrearDiagTorneo() {
  console.log(H('3. Torneo de diag (separado de Fase 1)'));
  const todos = await http('GET', '/api/torneos');
  if (todos.status !== 200) {
    fail(`No pude listar /api/torneos (status ${todos.status})`);
    return null;
  }
  const existente = (todos.data || []).find(t => t.nombre === DIAG_TORNEO_NOMBRE);
  if (existente) {
    info(`Reusando torneo existente: id=${existente.id} tipo='${existente.tipo}'`);
    if (existente.tipo !== 'mundial_preguntas') {
      fail(`Torneo de diag tiene tipo='${existente.tipo}'. Borralo a mano para regenerar.`);
      return null;
    }
    ok(`Torneo de diag id=${existente.id} reusable`);
    return existente;
  }
  const created = await http('POST', '/api/torneos', {
    nombre: DIAG_TORNEO_NOMBRE,
    semestre: '2026-DIAG-F2',
    tipo: 'mundial_preguntas',
  });
  if (created.status === 201) {
    ok(`Torneo de diag creado id=${created.data.id}`);
    return created.data;
  }
  if (created.status === 403) {
    fail(`Crear torneo falló 403 — tu usuario no tiene 'crear_torneo'.`);
  } else {
    fail(`Crear torneo falló (status ${created.status}): ${JSON.stringify(created.data)}`);
  }
  return null;
}

// Asegura que el torneo esté en estado 'configuracion' antes de los tests.
// Bypassea la máquina de estados forward-only escribiendo directo a DB.
function forzarConfiguracion(torneoId) {
  const db = new DatabaseSync(DB_PATH);
  try {
    db.prepare(
      `INSERT OR IGNORE INTO mundial_config (torneo_id) VALUES (?)`
    ).run(torneoId);
    db.prepare(
      `UPDATE mundial_config SET estado = 'configuracion' WHERE torneo_id = ?`
    ).run(torneoId);
  } finally {
    db.close();
  }
}

// ── 4. Seed UPSERT ──────────────────────────────────────────────────────────
async function checkSeed(torneoId) {
  console.log(H('4. Seed UPSERT (idempotencia + sincronización)'));
  if (!TIENE_PERMISO_MUNDIAL) {
    info(`Skip (sin permiso). Test 403:`);
    const r = await http('POST', `/api/mundial/${torneoId}/equipos/seed-mundial-2026`);
    if (r.status === 403) ok(`POST seed sin permiso → 403 ✓`);
    else fail(`Esperaba 403, recibí ${r.status}`);
    return null;
  }

  // 4.1 Primera corrida
  const r1 = await http('POST', `/api/mundial/${torneoId}/equipos/seed-mundial-2026`);
  if (r1.status !== 200) {
    fail(`POST seed falló (status ${r1.status}): ${JSON.stringify(r1.data)}`);
    return null;
  }
  const totalEsperado = r1.data.total;
  const suma = r1.data.creados + r1.data.actualizados;
  if (suma === totalEsperado && totalEsperado >= 48) {
    ok(`Primera corrida: creados=${r1.data.creados} actualizados=${r1.data.actualizados} total=${totalEsperado} ✓`);
  } else {
    fail(`Suma inconsistente: creados+actualizados (${suma}) != total (${totalEsperado})`);
  }

  // 4.2 Segunda corrida — todo actualizado, nada creado
  const r2 = await http('POST', `/api/mundial/${torneoId}/equipos/seed-mundial-2026`);
  if (r2.status === 200 && r2.data.creados === 0 && r2.data.actualizados === totalEsperado) {
    ok(`Segunda corrida idempotente: creados=0 actualizados=${totalEsperado} ✓`);
  } else {
    fail(`Segunda corrida: esperaba creados=0 actualizados=${totalEsperado}, recibí ${JSON.stringify(r2.data)}`);
  }

  // 4.3 Sincronización: editar nombre a mano, re-seed, verificar pisado
  const lista = await http('GET', `/api/mundial/${torneoId}/equipos`);
  if (!Array.isArray(lista.data) || lista.data.length === 0) {
    fail(`Lista vacía tras seed`);
    return null;
  }
  const target = lista.data[0];
  const nombreOriginal = target.nombre;
  const emojiOriginal  = target.emoji;
  info(`Target para sync test: ${target.codigo} '${nombreOriginal}'`);

  const patchR = await http('PATCH', `/api/mundial/${torneoId}/equipos/${target.id}`, {
    nombre: '__EDITADO_DIAG__',
  });
  if (patchR.status !== 200) {
    fail(`PATCH para sync test falló: ${patchR.status} ${JSON.stringify(patchR.data)}`);
    return null;
  }

  const r3 = await http('POST', `/api/mundial/${torneoId}/equipos/seed-mundial-2026`);
  if (r3.status !== 200) {
    fail(`Re-seed (sync test) falló: ${r3.status}`);
    return null;
  }
  const listaPost = await http('GET', `/api/mundial/${torneoId}/equipos`);
  const targetPost = (listaPost.data || []).find(e => e.id === target.id);
  if (targetPost && targetPost.nombre === nombreOriginal) {
    ok(`UPSERT pisó nombre editado: '__EDITADO_DIAG__' → '${nombreOriginal}' ✓`);
  } else {
    fail(`UPSERT NO pisó: nombre quedó en '${targetPost?.nombre}' (esperaba '${nombreOriginal}')`);
  }
  if (targetPost && targetPost.emoji === emojiOriginal) {
    ok(`UPSERT preservó emoji original ✓`);
  } else {
    warn(`emoji post seed: '${targetPost?.emoji}' (original '${emojiOriginal}')`);
  }

  return totalEsperado;
}

// ── 5. Alta manual ──────────────────────────────────────────────────────────
let TEST_EQUIPO_ID = null;

async function checkAltaManual(torneoId) {
  console.log(H('5. Alta manual de equipo'));
  if (!TIENE_PERMISO_MUNDIAL) {
    info(`Skip (sin permiso). Test 403:`);
    const r = await http('POST', `/api/mundial/${torneoId}/equipos`, {
      codigo: TEST_EQUIPO_CODIGO, nombre: 'X',
    });
    if (r.status === 403) ok(`POST sin permiso → 403 ✓`);
    else fail(`Esperaba 403, recibí ${r.status}`);
    return;
  }

  // Limpiar de runs previos
  const previo = await http('GET', `/api/mundial/${torneoId}/equipos`);
  const ex = (previo.data || []).find(e => e.codigo === TEST_EQUIPO_CODIGO);
  if (ex) {
    await http('DELETE', `/api/mundial/${torneoId}/equipos/${ex.id}`);
    info(`Equipo de test previo borrado para limpieza`);
  }

  const r = await http('POST', `/api/mundial/${torneoId}/equipos`, {
    codigo: TEST_EQUIPO_CODIGO,
    nombre: 'Equipo Test Diag',
    emoji:  '🏳️',
    grupo:  'A',
  });
  if (r.status === 201 && r.data.codigo === TEST_EQUIPO_CODIGO) {
    TEST_EQUIPO_ID = r.data.id;
    ok(`POST equipo manual → 201 id=${r.data.id} ✓`);
  } else {
    fail(`POST equipo manual inesperado (status ${r.status}): ${JSON.stringify(r.data)}`);
    return;
  }

  // 409 por duplicado
  const r2 = await http('POST', `/api/mundial/${torneoId}/equipos`, {
    codigo: TEST_EQUIPO_CODIGO, nombre: 'Otro',
  });
  if (r2.status === 409) ok(`POST duplicado → 409 ✓`);
  else fail(`Esperaba 409 (duplicado), recibí ${r2.status}`);

  // 400 por código inválido
  const r3 = await http('POST', `/api/mundial/${torneoId}/equipos`, {
    codigo: 'X', nombre: 'Y',
  });
  if (r3.status === 400) ok(`POST codigo 1 char → 400 ✓ (fuera de 2-10)`);
  else fail(`Esperaba 400 (codigo corto), recibí ${r3.status}`);
}

// ── 6. Edición ──────────────────────────────────────────────────────────────
async function checkEdicion(torneoId) {
  console.log(H('6. Edición (PATCH)'));
  if (!TIENE_PERMISO_MUNDIAL || !TEST_EQUIPO_ID) {
    info(`Skip (sin permiso o equipo de test)`);
    return;
  }

  const r = await http('PATCH', `/api/mundial/${torneoId}/equipos/${TEST_EQUIPO_ID}`, {
    nombre: 'Equipo Test Diag Editado',
    emoji:  '🚩',
    grupo:  'B',
    activo: 0,
  });
  if (r.status === 200
      && r.data.nombre === 'Equipo Test Diag Editado'
      && r.data.emoji === '🚩'
      && r.data.grupo === 'B'
      && r.data.activo === 0) {
    ok(`PATCH nombre/emoji/grupo/activo OK ✓`);
  } else {
    fail(`PATCH inesperado: ${JSON.stringify(r.data)}`);
  }

  // 409 al cambiar codigo
  const r2 = await http('PATCH', `/api/mundial/${torneoId}/equipos/${TEST_EQUIPO_ID}`, {
    codigo: 'OTRO_CODE',
  });
  if (r2.status === 409) ok(`PATCH cambio de codigo → 409 ✓ (inmutable)`);
  else fail(`Esperaba 409, recibí ${r2.status}`);

  // 404 para equipo inexistente
  const r3 = await http('PATCH', `/api/mundial/${torneoId}/equipos/999999`, {
    nombre: 'X',
  });
  if (r3.status === 404) ok(`PATCH equipo inexistente → 404 ✓`);
  else fail(`Esperaba 404, recibí ${r3.status}`);
}

// ── 7. Borrado ──────────────────────────────────────────────────────────────
async function checkBorrado(torneoId) {
  console.log(H('7. Borrado (DELETE)'));
  if (!TIENE_PERMISO_MUNDIAL || !TEST_EQUIPO_ID) {
    info(`Skip (sin permiso o equipo de test)`);
    return;
  }

  const r = await http('DELETE', `/api/mundial/${torneoId}/equipos/${TEST_EQUIPO_ID}`);
  if (r.status === 200 && r.data.ok) {
    ok(`DELETE equipo de test → 200 ✓`);
  } else {
    fail(`DELETE inesperado: ${JSON.stringify(r.data)}`);
    return;
  }

  const lista = await http('GET', `/api/mundial/${torneoId}/equipos`);
  const sigue = (lista.data || []).find(e => e.id === TEST_EQUIPO_ID);
  if (!sigue) ok(`Verificación: equipo borrado no aparece en lista ✓`);
  else fail(`El equipo borrado todavía aparece en la lista`);

  const r2 = await http('DELETE', `/api/mundial/${torneoId}/equipos/${TEST_EQUIPO_ID}`);
  if (r2.status === 404) ok(`DELETE re-borrado → 404 ✓`);
  else fail(`Esperaba 404, recibí ${r2.status}`);

  TEST_EQUIPO_ID = null;
}

// ── 8. Bloqueo por estado ───────────────────────────────────────────────────
async function checkBloqueoEstado(torneoId) {
  console.log(H('8. Bloqueo por estado del torneo'));
  if (!TIENE_PERMISO_MUNDIAL) {
    info(`Skip (sin permiso)`);
    return;
  }

  const db = new DatabaseSync(DB_PATH);
  try {
    db.prepare(
      `INSERT OR IGNORE INTO mundial_config (torneo_id) VALUES (?)`
    ).run(torneoId);
    db.prepare(
      `UPDATE mundial_config SET estado = 'cerrado' WHERE torneo_id = ?`
    ).run(torneoId);
    info(`Estado del torneo de diag forzado a 'cerrado' vía DB (bypass forward-only)`);

    // POST seed → 409
    let r = await http('POST', `/api/mundial/${torneoId}/equipos/seed-mundial-2026`);
    if (r.status === 409) ok(`POST seed con estado cerrado → 409 ✓`);
    else fail(`Esperaba 409 (seed bloqueado), recibí ${r.status}: ${JSON.stringify(r.data)}`);

    // POST single → 409 (la guardia de estado se evalúa ANTES que la validación
    // de codigo, por eso el código de prueba acá puede ser cualquiera dentro del rango)
    r = await http('POST', `/api/mundial/${torneoId}/equipos`, {
      codigo: 'LOCKTEST', nombre: 'Lock test',
    });
    if (r.status === 409) ok(`POST equipo individual con estado cerrado → 409 ✓`);
    else fail(`Esperaba 409 (POST bloqueado), recibí ${r.status}`);

    // PATCH cualquier equipo → 409
    const lista = await http('GET', `/api/mundial/${torneoId}/equipos`);
    const alguno = (lista.data || [])[0];
    if (alguno) {
      r = await http('PATCH', `/api/mundial/${torneoId}/equipos/${alguno.id}`, { nombre: 'Bloqueado' });
      if (r.status === 409) ok(`PATCH con estado cerrado → 409 ✓`);
      else fail(`Esperaba 409 (PATCH bloqueado), recibí ${r.status}`);

      r = await http('DELETE', `/api/mundial/${torneoId}/equipos/${alguno.id}`);
      if (r.status === 409) ok(`DELETE con estado cerrado → 409 ✓`);
      else fail(`Esperaba 409 (DELETE bloqueado), recibí ${r.status}`);
    } else {
      warn(`Sin equipos en la lista para test de PATCH/DELETE bloqueado`);
    }
  } finally {
    try {
      db.prepare(
        `UPDATE mundial_config SET estado = 'configuracion' WHERE torneo_id = ?`
      ).run(torneoId);
      info(`Estado restaurado a 'configuracion' (en finally)`);
    } catch (e) {
      fail(`No pude restaurar estado: ${e.message}`);
    }
    db.close();
  }
}

// ── 9. No regresión Fase 1 ──────────────────────────────────────────────────
async function checkNoRegresion(torneoId) {
  console.log(H('9. No regresión Fase 1'));

  let r;

  r = await http('GET', `/api/mundial/torneos`);
  if (r.status === 200 && Array.isArray(r.data) && r.data.find(t => t.id === torneoId)) {
    ok(`GET /api/mundial/torneos OK (torneo de diag presente) ✓`);
  } else fail(`GET /api/mundial/torneos falló (status ${r.status})`);

  r = await http('GET', `/api/mundial/${torneoId}/config`);
  if (r.status === 200 && r.data && 'estado' in r.data) {
    ok(`GET /api/mundial/:id/config OK (estado='${r.data.estado}') ✓`);
    // Confirmar que no aparece TC Blue
    const camposTC = ['tc_blue_ars', 'tc_blue_ars_snapshot', 'tc', 'tc_blue'];
    const conTC = camposTC.find(c => c in r.data);
    if (!conTC) ok(`Config sin campos de TC ✓`);
    else fail(`Config expone campo TC '${conTC}' (no debería)`);
  } else fail(`GET /api/mundial/:id/config falló`);

  r = await http('PATCH', `/api/torneos/${torneoId}`, { tipo: 'prode_semestral' });
  if (r.status === 409) ok(`PATCH torneo con tipo → 409 ✓ (inmutable post-creación)`);
  else fail(`Esperaba 409, recibí ${r.status}`);

  r = await http('POST', `/api/torneos/${torneoId}/recalcular-tabla`);
  if (r.status === 400) ok(`recalcular-tabla en torneo Mundial → 400 ✓`);
  else fail(`Esperaba 400, recibí ${r.status}`);
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(c('Diagnóstico Fase 2.1 Mundial — catálogo de equipos', '1;37'));
  console.log(c(`Torneo de diag: ${DIAG_TORNEO_NOMBRE}`, '90'));
  console.log(c(`DB_PATH: ${DB_PATH}`, '90'));

  try { dbChecks(); }
  catch (e) { fail(`Error en DB checks: ${e.message}`); process.exit(1); }

  await authCheck();
  const t = await obtenerOCrearDiagTorneo();
  if (!t) {
    console.log(H('Fin'));
    fail('Sin torneo de diag — abort');
    process.exit(exitCode);
  }

  // Asegurar estado 'configuracion' antes de tests (puede haber quedado en otro
  // estado por un run previo que crasheó antes del finally).
  try {
    forzarConfiguracion(t.id);
    info(`Estado de mundial_config forzado a 'configuracion' antes de tests`);
  } catch (e) {
    fail(`No pude forzar estado inicial: ${e.message}`);
  }

  await checkSeed(t.id);
  await checkAltaManual(t.id);
  await checkEdicion(t.id);
  await checkBorrado(t.id);
  await checkBloqueoEstado(t.id);
  await checkNoRegresion(t.id);

  console.log(H('Resultado'));
  if (exitCode === 0) console.log(OK('Diagnóstico Fase 2.1 Mundial: TODO OK'));
  else                console.log(FAIL('Diagnóstico encontró problemas (revisar arriba)'));
}

// Salida limpia para Windows: process.exit() puede disparar la assertion de libuv
//   `!(handle->flags & UV_HANDLE_CLOSING)` (src\win\async.c)
// cuando hay conexiones HTTP keepalive del dispatcher global de undici (fetch)
// aún abiertas. Solución estándar:
//   1. usar `process.exitCode` y dejar drenar el event loop;
//   2. cerrar explícitamente el dispatcher de undici si está disponible.
async function shutdown() {
  try {
    // undici viene bundleado en Node 18+ como motor del fetch global.
    const undici = require('undici');
    if (undici?.getGlobalDispatcher) {
      await undici.getGlobalDispatcher().close();
    }
  } catch (_) {
    // No accesible (Node sin undici exportado) — proceder sin cleanup explícito.
  }
  process.exitCode = exitCode;
}

main()
  .catch(e => { console.error(e); exitCode = 1; })
  .finally(() => shutdown());
