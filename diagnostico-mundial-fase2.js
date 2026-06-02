#!/usr/bin/env node
/**
 * Diagnóstico Mundial — Fase 2.x
 *
 * Cubre Fase 2.1 (catálogo de equipos) + Fase 2.2 (preguntas + validación).
 *
 *   1. Schema/DB: columna `emoji` en mundial_equipos_catalogo.
 *   2. Auth real: login contra /api/auth/login.
 *   3. Torneo de diag dedicado a Fase 2 (no toca el de Fase 1 ni reales).
 *   4. Seed UPSERT de equipos: idempotencia + sincronización (pisa nombres editados).
 *   5. Alta manual de equipo individual + 409 por duplicado.
 *   6. Edición de nombre/emoji/grupo/activo + rechazo de cambio de código.
 *   7. Borrado + 404 al re-borrar.
 *   8. Bloqueo por estado del catálogo: con estado 'cerrado', POST/PATCH/DELETE → 409.
 *   9. Preguntas (Fase 2.2): CRUD + bulk + validación strict de config_json +
 *      warnings de códigos no-en-catálogo + bloqueo granular por estado.
 *  10. No regresión Fase 1: torneos, config, tipo inmutable, recalcular bloqueado.
 *
 * Bypass de estado: manipula directamente `mundial_config.estado` vía DB
 * (BYPASS de la máquina de estados forward-only del backend). Solo afecta al
 * torneo de diag y se restaura en finally.
 *
 * Config por env vars (todas con fallback):
 *   DIAG_EMAIL       (default: admin@prode.com)
 *   DIAG_PASSWORD    (default: admin123)
 *   API_BASE_URL     (default: http://localhost:3001)
 *   DB_PATH          (default: ./prode.db relativo al script)
 *   DIAG_AUTO_GRANT  (default: no aplica) — si vale '1' Y el user de diag NO tiene
 *                    'gestionar_mundial', se lo asigna TEMPORALMENTE solo para este
 *                    run y se revoca al finalizar (preserva el estado original).
 *                    USO LOCAL / DEV solamente — NO usar en producción.
 *
 * Uso típico (local con admin sin permiso de Mundial):
 *   cd backend
 *   DIAG_AUTO_GRANT=1 node diagnostico-mundial-fase2.js
 *
 * Sin auto-grant: si el user es superadmin, los tests admin pasan por bypass.
 * Si es admin común y NO tiene 'gestionar_mundial', los tests admin se skipean
 * y solo se verifica que devuelvan 403.
 *
 * Requiere: Node 22.5+ (node:sqlite, fetch global) y backend corriendo.
 *
 * Limpieza posterior (opcional, manual via sqlite3):
 *   DELETE FROM mundial_equipos_catalogo WHERE torneo_id IN
 *     (SELECT id FROM torneos WHERE nombre = '__DIAG_MUNDIAL_FASE2__');
 *   DELETE FROM mundial_preguntas        WHERE torneo_id IN
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
const DIAG_AUTO_GRANT    = process.env.DIAG_AUTO_GRANT === '1';
const DIAG_TORNEO_NOMBRE = '__DIAG_MUNDIAL_FASE2__';
// Código del equipo de prueba — debe respetar el límite 2-10 chars del backend.
// 'DIAGTEST' (8 chars) es suficientemente distintivo y no choca con códigos reales
// del Mundial 2026 (todos los del dataset oficial son códigos de 3 letras).
const TEST_EQUIPO_CODIGO = 'DIAGTEST';

// Estado de grant temporal aplicado por DIAG_AUTO_GRANT. Mutado al inicio si
// corresponde y leído en el finally del shutdown para revocar.
const DIAG_GRANT_STATE = { granted: false };

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

// ── 1.bis Auto-grant temporal (opcional, solo si DIAG_AUTO_GRANT=1) ─────────
// Asigna 'gestionar_mundial' al DIAG_EMAIL antes del login para que los tests
// admin puedan correr completos. Se revoca al finalizar — preserva el estado
// original (si el user ya lo tenía, NO se revoca).
//
// USO LOCAL / DEV. No usar en producción.
function maybeGrantPermisoForDiag() {
  if (!DIAG_AUTO_GRANT) return;

  const db = new DatabaseSync(DB_PATH);
  try {
    const user = db.prepare('SELECT id, email, role FROM users WHERE email = ?').get(DIAG_EMAIL);
    if (!user) {
      warn(`DIAG_AUTO_GRANT activo, pero ${DIAG_EMAIL} no existe en DB. Continuando sin grant.`);
      return;
    }
    if (user.role === 'superadmin') {
      info(`DIAG_AUTO_GRANT: ${DIAG_EMAIL} es superadmin → bypass de permisos, no se necesita grant`);
      return;
    }
    const existente = db.prepare(
      "SELECT 1 FROM user_permisos WHERE user_id = ? AND permiso = 'gestionar_mundial' LIMIT 1"
    ).get(user.id);
    if (existente) {
      info(`DIAG_AUTO_GRANT: ${DIAG_EMAIL} ya tenía 'gestionar_mundial' previamente — no se asigna ni se revoca`);
      return;
    }
    db.prepare(
      "INSERT INTO user_permisos (user_id, permiso) VALUES (?, 'gestionar_mundial')"
    ).run(user.id);
    DIAG_GRANT_STATE.granted = true;
    warn(`DIAG_AUTO_GRANT: 'gestionar_mundial' asignado TEMPORALMENTE a ${DIAG_EMAIL}`);
    warn(`DIAG_AUTO_GRANT: se va a revocar al finalizar el diagnóstico. USO LOCAL/DEV — no usar en producción.`);
  } catch (e) {
    fail(`DIAG_AUTO_GRANT falló: ${e.message}`);
  } finally {
    db.close();
  }
}

function revokePermisoSiGrantedPorDiag() {
  if (!DIAG_GRANT_STATE.granted) return;
  const db = new DatabaseSync(DB_PATH);
  try {
    const user = db.prepare('SELECT id FROM users WHERE email = ?').get(DIAG_EMAIL);
    if (!user) {
      warn(`Revoke: ${DIAG_EMAIL} ya no existe en DB. Saltando.`);
      return;
    }
    const r = db.prepare(
      "DELETE FROM user_permisos WHERE user_id = ? AND permiso = 'gestionar_mundial'"
    ).run(user.id);
    if (r.changes > 0) {
      info(`DIAG_AUTO_GRANT: 'gestionar_mundial' revocado de ${DIAG_EMAIL} (estado pre-diag restaurado)`);
    } else {
      warn(`DIAG_AUTO_GRANT: revoke no encontró fila para borrar — estado posible: ya fue revocado externamente`);
    }
  } catch (e) {
    fail(`Revoke falló: ${e.message}. Hay que revocar manualmente con: DELETE FROM user_permisos WHERE user_id = (SELECT id FROM users WHERE email = '${DIAG_EMAIL}') AND permiso = 'gestionar_mundial';`);
  } finally {
    db.close();
  }
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

// ── 9. Preguntas (Fase 2.2) ─────────────────────────────────────────────────
// Cubre CRUD + bulk + validación strict de config_json + warnings de equipos
// no-en-catálogo + bloqueo granular (configuracion / abierto / cerrado).
// Crea preguntas con numero >= 9000 para distinguirlas de las reales y
// limpiarlas al final. NO toca equipos creados por la fase 2.1.
async function checkPreguntas(torneoId) {
  console.log(H('9. Preguntas (Fase 2.2)'));
  if (!TIENE_PERMISO_MUNDIAL) {
    info('Skip (sin permiso). Test 403:');
    const r = await http('POST', `/api/mundial/${torneoId}/preguntas`, {
      numero: 9001, enunciado: 't', tipo_pregunta: 'opcion_unica',
      config_json: { opciones: ['A', 'B'], pts: 10 },
    });
    if (r.status === 403) ok('POST preguntas sin permiso → 403 ✓');
    else fail(`Esperaba 403, recibí ${r.status}`);
    return;
  }

  // Pre-condición: estado en 'configuracion' (puede haber quedado en otro estado
  // de un run previo que crasheó antes del finally).
  forzarConfiguracion(torneoId);

  // Limpieza inicial: borrar todas las preguntas del diag (numero >= 9000) que
  // hayan quedado de un run anterior.
  const previas = (await http('GET', `/api/mundial/${torneoId}/preguntas`)).data || [];
  let limpieza = 0;
  for (const p of previas) {
    if (p.numero >= 9000) {
      await http('DELETE', `/api/mundial/${torneoId}/preguntas/${p.id}`);
      limpieza++;
    }
  }
  if (limpieza > 0) info(`Limpieza inicial: ${limpieza} pregunta(s) del diag borradas`);

  // ── 9.1 POST de los 8 tipos con config válido ──
  const casos = [
    { num: 9001, tipo: 'opcion_unica',          cfg: { opciones: ['Sí', 'No'], pts: 15 } },
    { num: 9009, tipo: 'opcion_unica',          cfg: { opciones: ['Sí', 'No'], pts_por_opcion: { 'Sí': 15, 'No': 10 } } },
    { num: 9002, tipo: 'equipo_categoria',      cfg: {
        categorias: [
          { label: 'fav',  equipos: ['ARG', 'BRA'], pts: 50 },
          { label: 'otro', pts: 100, default: true },
        ],
    }},
    { num: 9003, tipo: 'instancia_eliminacion', cfg: {
        equipo: 'ING',
        instancias: ['Grupos','16°','8°','4°','Semis','Final'],
        pts_por_instancia: { 'Grupos':50, '16°':40, '8°':30, '4°':20, 'Semis':30, 'Final':30 },
    }},
    { num: 9004, tipo: 'numero_exacto',         cfg: { pts_si_acierta: 10 } },
    { num: 9005, tipo: 'numero_por_banda',      cfg: {
        bandas: [
          { min: 0, max: 2, pts: 10 },
          { min: 3, pts: 25 },
        ],
    }},
    { num: 9006, tipo: 'multi_equipo',          cfg: { n_equipos: 8, pts_por_acierto: 10 } },
    { num: 9007, tipo: 'respuesta_manual',      cfg: { pts_max: 25, instrucciones: 'A mano.' } },
    { num: 9008, tipo: 'regla_especial',        cfg: { scoring_manual: true, descripcion: 'Regla custom.' } },
  ];

  let creadosOK = 0;
  for (const c of casos) {
    const r = await http('POST', `/api/mundial/${torneoId}/preguntas`, {
      numero: c.num, enunciado: `Diag ${c.tipo}`, tipo_pregunta: c.tipo, config_json: c.cfg,
    });
    if (r.status === 201 && r.data?.pregunta?.numero === c.num) creadosOK++;
    else fail(`POST ${c.tipo} (#${c.num}) inesperado: ${r.status} ${JSON.stringify(r.data)}`);
  }
  if (creadosOK === casos.length) ok(`POST de los ${casos.length} tipos OK ✓`);

  // ── 9.2 POST con config inválido por tipo ──
  const invalidos = [
    { num: 9101, tipo: 'opcion_unica',          cfg: { opciones: [], pts: 10 },                                                                     espera: 'opciones' },
    { num: 9110, tipo: 'opcion_unica',          cfg: { opciones: ['A','B'] },                                                                        espera: 'debe tener' },
    { num: 9111, tipo: 'opcion_unica',          cfg: { opciones: ['A','B'], pts: 10, pts_por_opcion: { A: 10, B: 5 } },                              espera: 'a la vez' },
    { num: 9112, tipo: 'opcion_unica',          cfg: { opciones: ['A','B'], pts_por_opcion: { A: 10, C: 5 } },                                       espera: 'coincidir' },
    { num: 9102, tipo: 'equipo_categoria',      cfg: { categorias: [{ label: 'x', equipos: ['ARG'], pts: 10 }] },                                   espera: 'default' },
    { num: 9103, tipo: 'instancia_eliminacion', cfg: { equipo: 'ING', instancias: ['A','B'], pts_por_instancia: { A: 10 } },                        espera: 'pts_por_instancia' },
    { num: 9104, tipo: 'numero_exacto',         cfg: { pts_si_acierta: -1 },                                                                        espera: 'pts_si_acierta' },
    { num: 9105, tipo: 'numero_por_banda',      cfg: { bandas: [{ min: 0, max: 2, pts: 10 }, { min: 5, pts: 25 }] },                                espera: 'hueco' },
    { num: 9106, tipo: 'multi_equipo',          cfg: { n_equipos: 0, pts_por_acierto: 10 },                                                         espera: 'n_equipos' },
    { num: 9107, tipo: 'respuesta_manual',      cfg: { pts_max: -1 },                                                                                espera: 'pts_max' },
    { num: 9108, tipo: 'regla_especial',        cfg: { scoring_manual: true },                                                                       espera: 'descripcion' },
  ];

  let rechazos400 = 0;
  for (const c of invalidos) {
    const r = await http('POST', `/api/mundial/${torneoId}/preguntas`, {
      numero: c.num, enunciado: 'diag inv', tipo_pregunta: c.tipo, config_json: c.cfg,
    });
    const txt = String(r.data?.error || '').toLowerCase();
    if (r.status === 400 && txt.includes(c.espera.toLowerCase())) rechazos400++;
    else fail(`POST ${c.tipo} inválido: esperaba 400 con '${c.espera}', recibí ${r.status}: ${JSON.stringify(r.data)}`);
  }
  if (rechazos400 === invalidos.length) ok(`Validación strict de config_json: ${invalidos.length} tipos rechazados con mensaje específico ✓`);

  // ── 9.3 POST con numero duplicado → 409 ──
  const dup = await http('POST', `/api/mundial/${torneoId}/preguntas`, {
    numero: 9001, enunciado: 'dup', tipo_pregunta: 'opcion_unica',
    config_json: { opciones: ['A','B'], pts: 10 },
  });
  if (dup.status === 409) ok('POST numero duplicado → 409 ✓');
  else fail(`Esperaba 409 (dup), recibí ${dup.status}`);

  // ── 9.4 Warning de equipos no en catálogo ──
  const warn = await http('POST', `/api/mundial/${torneoId}/preguntas`, {
    numero: 9201, enunciado: 'warn test', tipo_pregunta: 'equipo_categoria',
    config_json: {
      categorias: [
        { label: 'real', equipos: ['ARG', 'XYZ'], pts: 50 }, // XYZ no existe
        { label: 'otro', pts: 100, default: true },
      ],
    },
  });
  if (warn.status === 201
      && Array.isArray(warn.data.warnings)
      && warn.data.warnings.some(w => Array.isArray(w.codigos_no_encontrados) && w.codigos_no_encontrados.includes('XYZ'))) {
    ok('Warning de codigos_no_encontrados con XYZ ✓ (POST 201, pregunta se guarda)');
  } else fail(`Esperaba 201 con warning de XYZ, recibí ${warn.status}: ${JSON.stringify(warn.data)}`);

  // ── 9.5 PATCH enunciado/aclaracion/activa en configuracion ──
  const lista = (await http('GET', `/api/mundial/${torneoId}/preguntas`)).data;
  const pregExist = lista.find(p => p.numero === 9001);
  if (!pregExist) {
    fail('Pregunta 9001 no existe para tests PATCH');
    return;
  }
  const p1 = await http('PATCH', `/api/mundial/${torneoId}/preguntas/${pregExist.id}`, {
    enunciado: 'editado diag', aclaracion: 'aclaracion test', activa: 0,
  });
  if (p1.status === 200
      && p1.data.pregunta?.enunciado === 'editado diag'
      && p1.data.pregunta?.activa === 0) {
    ok('PATCH enunciado/aclaracion/activa en configuracion → 200 ✓');
  } else fail(`PATCH inesperado: ${JSON.stringify(p1.data)}`);

  // ── 9.6 PATCH tipo_pregunta → 409 ──
  const p2 = await http('PATCH', `/api/mundial/${torneoId}/preguntas/${pregExist.id}`, { tipo_pregunta: 'numero_exacto' });
  if (p2.status === 409) ok('PATCH tipo_pregunta → 409 ✓ (inmutable)');
  else fail(`Esperaba 409, recibí ${p2.status}`);

  // ── 9.7 PATCH numero → 409 ──
  const p3 = await http('PATCH', `/api/mundial/${torneoId}/preguntas/${pregExist.id}`, { numero: 88888 });
  if (p3.status === 409) ok('PATCH numero → 409 ✓ (inmutable)');
  else fail(`Esperaba 409, recibí ${p3.status}`);

  // ── 9.8 PATCH config_json válido ──
  const p4 = await http('PATCH', `/api/mundial/${torneoId}/preguntas/${pregExist.id}`, {
    config_json: { opciones: ['Sí', 'No', 'Tal vez'], pts: 20 },
  });
  if (p4.status === 200) ok('PATCH config_json válido en configuracion → 200 ✓');
  else fail(`PATCH config_json inesperado: ${p4.status} ${JSON.stringify(p4.data)}`);

  // ── 9.9 PATCH config_json inválido → 400 ──
  const p5 = await http('PATCH', `/api/mundial/${torneoId}/preguntas/${pregExist.id}`, {
    config_json: { opciones: [], pts: 10 },
  });
  if (p5.status === 400) ok('PATCH config_json inválido → 400 ✓');
  else fail(`Esperaba 400, recibí ${p5.status}`);

  // ── 9.10 DELETE pregunta ──
  const del = await http('DELETE', `/api/mundial/${torneoId}/preguntas/${pregExist.id}`);
  if (del.status === 200 && del.data.ok) ok('DELETE pregunta → 200 ✓');
  else fail(`DELETE inesperado: ${del.status}`);

  const after = await http('GET', `/api/mundial/${torneoId}/preguntas`);
  if (!(after.data || []).find(p => p.id === pregExist.id)) ok('Pregunta borrada no aparece en GET ✓');
  else fail('Pregunta borrada todavía aparece en GET');

  const del2 = await http('DELETE', `/api/mundial/${torneoId}/preguntas/${pregExist.id}`);
  if (del2.status === 404) ok('Re-DELETE → 404 ✓');
  else fail(`Esperaba 404, recibí ${del2.status}`);

  // ── 9.11 PUT bulk: creados + idempotencia ──
  const bulkBody = {
    preguntas: [
      { numero: 9301, enunciado: 'Bulk 1', tipo_pregunta: 'opcion_unica',  config_json: { opciones: ['A','B'], pts: 5 } },
      { numero: 9302, enunciado: 'Bulk 2', tipo_pregunta: 'numero_exacto', config_json: { pts_si_acierta: 10 } },
      { numero: 9303, enunciado: 'Bulk 3', tipo_pregunta: 'multi_equipo',  config_json: { n_equipos: 4, pts_por_acierto: 5 } },
    ],
  };
  const bulk = await http('PUT', `/api/mundial/${torneoId}/preguntas/bulk`, bulkBody);
  if (bulk.status === 200 && bulk.data.creados === 3 && bulk.data.actualizados === 0 && bulk.data.total === 3) {
    ok(`PUT bulk inicial: creados=3 actualizados=0 ✓`);
  } else fail(`PUT bulk inicial inesperado: ${JSON.stringify(bulk.data)}`);

  const bulkAgain = await http('PUT', `/api/mundial/${torneoId}/preguntas/bulk`, bulkBody);
  if (bulkAgain.status === 200 && bulkAgain.data.creados === 0 && bulkAgain.data.actualizados === 3) {
    ok(`PUT bulk idempotente: creados=0 actualizados=3 ✓`);
  } else fail(`PUT bulk idempotente: ${JSON.stringify(bulkAgain.data)}`);

  // ── 9.12 PUT bulk con una inválida → 400, ninguna persiste ──
  const bulkInvBody = {
    preguntas: [
      { numero: 9401, enunciado: 'Valida',   tipo_pregunta: 'opcion_unica',  config_json: { opciones: ['A','B'], pts: 5 } },
      { numero: 9402, enunciado: 'Invalida', tipo_pregunta: 'numero_exacto', config_json: { pts_si_acierta: -1 } },
    ],
  };
  const bulkInv = await http('PUT', `/api/mundial/${torneoId}/preguntas/bulk`, bulkInvBody);
  if (bulkInv.status === 400) {
    ok('PUT bulk con una inválida → 400 ✓');
    const atomicCheck = await http('GET', `/api/mundial/${torneoId}/preguntas`);
    const persisted = (atomicCheck.data || []).find(p => p.numero === 9401);
    if (!persisted) ok('Atomicidad: la pregunta válida 9401 tampoco persistió ✓');
    else fail('Atomicidad rota: la pregunta válida 9401 quedó persistida');
  } else fail(`Esperaba 400, recibí ${bulkInv.status}: ${JSON.stringify(bulkInv.data)}`);

  // ── 9.13 Bloqueo granular en 'abierto' ──
  const db = new DatabaseSync(DB_PATH);
  try {
    db.prepare(`UPDATE mundial_config SET estado='abierto' WHERE torneo_id=?`).run(torneoId);
    info(`Estado forzado a 'abierto'`);

    const pOpen = await http('POST', `/api/mundial/${torneoId}/preguntas`, {
      numero: 9501, enunciado: 't', tipo_pregunta: 'opcion_unica',
      config_json: { opciones: ['A', 'B'], pts: 5 },
    });
    if (pOpen.status === 409) ok(`POST en 'abierto' → 409 ✓`);
    else fail(`Esperaba 409 (POST en abierto), recibí ${pOpen.status}`);

    const bOpen = await http('PUT', `/api/mundial/${torneoId}/preguntas/bulk`, { preguntas: [] });
    if (bOpen.status === 409) ok(`PUT bulk en 'abierto' → 409 ✓`);
    else fail(`Esperaba 409 (bulk en abierto), recibí ${bOpen.status}`);

    const algunaP = ((await http('GET', `/api/mundial/${torneoId}/preguntas`)).data || [])[0];
    if (algunaP) {
      const dOpen = await http('DELETE', `/api/mundial/${torneoId}/preguntas/${algunaP.id}`);
      if (dOpen.status === 409) ok(`DELETE en 'abierto' → 409 ✓`);
      else fail(`Esperaba 409 (DELETE en abierto), recibí ${dOpen.status}`);

      const oE = await http('PATCH', `/api/mundial/${torneoId}/preguntas/${algunaP.id}`, { enunciado: 'editado en abierto' });
      if (oE.status === 200) ok(`PATCH enunciado en 'abierto' → 200 ✓`);
      else fail(`PATCH enunciado en abierto: esperaba 200, recibí ${oE.status}: ${JSON.stringify(oE.data)}`);

      const oC = await http('PATCH', `/api/mundial/${torneoId}/preguntas/${algunaP.id}`, {
        config_json: { opciones: ['A','B'], pts: 5 },
      });
      if (oC.status === 409) ok(`PATCH config_json en 'abierto' → 409 ✓`);
      else fail(`PATCH config_json en abierto: esperaba 409, recibí ${oC.status}`);

      const oT = await http('PATCH', `/api/mundial/${torneoId}/preguntas/${algunaP.id}`, {
        tipo_pregunta: 'numero_exacto',
      });
      if (oT.status === 409) ok(`PATCH tipo_pregunta en 'abierto' → 409 ✓`);
      else fail(`PATCH tipo_pregunta en abierto: esperaba 409, recibí ${oT.status}`);
    } else {
      warn(`Sin preguntas para test de PATCH/DELETE en abierto`);
    }

    // ── 9.14 Bloqueo total en 'cerrado' ──
    db.prepare(`UPDATE mundial_config SET estado='cerrado' WHERE torneo_id=?`).run(torneoId);
    info(`Estado forzado a 'cerrado'`);

    const algunaC = ((await http('GET', `/api/mundial/${torneoId}/preguntas`)).data || [])[0];
    if (algunaC) {
      const cE = await http('PATCH', `/api/mundial/${torneoId}/preguntas/${algunaC.id}`, { enunciado: 'editado en cerrado' });
      if (cE.status === 409) ok(`PATCH en 'cerrado' → 409 ✓ (bloqueo total)`);
      else fail(`PATCH en cerrado: esperaba 409, recibí ${cE.status}`);
    }
  } finally {
    try {
      db.prepare(`UPDATE mundial_config SET estado='configuracion' WHERE torneo_id=?`).run(torneoId);
      info(`Estado restaurado a 'configuracion'`);
    } catch (e) {
      fail(`No pude restaurar estado: ${e.message}`);
    }
    db.close();
  }

  // ── Limpieza final ──
  const finalList = await http('GET', `/api/mundial/${torneoId}/preguntas`);
  let borradas = 0;
  for (const p of (finalList.data || [])) {
    if (p.numero >= 9000) {
      const r = await http('DELETE', `/api/mundial/${torneoId}/preguntas/${p.id}`);
      if (r.status === 200) borradas++;
    }
  }
  info(`Limpieza final: ${borradas} pregunta(s) del diag borradas`);
}

// ── 10. Respuestas usuario (Fase 2.4) ───────────────────────────────────────
// Crea 5 preguntas de prueba (numeros 9601..9605), fuerza estado 'abierto' vía DB,
// y prueba PUT/GET de respuestas: shape, idempotencia, atomicidad, cross-check
// estricto contra catálogo, bloqueo por estado y por deadline. Limpia al final.
async function checkRespuestasUsuario(torneoId) {
  console.log(H('10. Respuestas usuario (Fase 2.4)'));
  if (!TIENE_PERMISO_MUNDIAL) {
    info('Skip parcial: sin `gestionar_mundial` no podemos crear preguntas de prueba.');
    const r = await http('GET', `/api/mundial/${torneoId}/mis-respuestas`);
    if (r.status === 200 && Array.isArray(r.data)) ok(`GET mis-respuestas → 200 (sin permiso especial requerido) ✓`);
    else fail(`GET mis-respuestas falló: ${r.status}`);
    return;
  }

  // Pre-condición: 'configuracion' para poder crear preguntas; catálogo cargado en §4.
  forzarConfiguracion(torneoId);

  // Limpieza inicial: borrar respuestas y preguntas de runs previos (rango 9600-9699).
  const dbInit = new DatabaseSync(DB_PATH);
  try {
    dbInit.prepare(`
      DELETE FROM mundial_respuestas_usuario
      WHERE pregunta_id IN (
        SELECT id FROM mundial_preguntas WHERE torneo_id = ? AND numero >= 9600 AND numero < 9700
      )
    `).run(torneoId);
    dbInit.prepare(`
      DELETE FROM mundial_preguntas WHERE torneo_id = ? AND numero >= 9600 AND numero < 9700
    `).run(torneoId);
  } finally { dbInit.close(); }

  // Crear 5 preguntas de test (un tipo distinto cada una)
  const preguntasTest = [
    { numero: 9601, tipo_pregunta: 'opcion_unica',          enunciado: 'Diag-resp opcion_unica',
      config_json: { opciones: ['Sí', 'No'], pts: 10 } },
    { numero: 9602, tipo_pregunta: 'equipo_categoria',      enunciado: 'Diag-resp equipo_categoria',
      config_json: { categorias: [
        { label: 'top',  equipos: ['ARG', 'BRA'], pts: 50 },
        { label: 'otro', pts: 10, default: true },
      ] } },
    { numero: 9603, tipo_pregunta: 'instancia_eliminacion', enunciado: 'Diag-resp instancia',
      config_json: { equipo: 'ARG', instancias: ['Grupos','16°','Final'],
                     pts_por_instancia: { 'Grupos': 50, '16°': 30, 'Final': 20 } } },
    { numero: 9604, tipo_pregunta: 'numero_exacto',         enunciado: 'Diag-resp numero',
      config_json: { pts_si_acierta: 10, pts_si_no_acierta: 0 } },
    { numero: 9605, tipo_pregunta: 'multi_equipo',          enunciado: 'Diag-resp multi',
      config_json: { n_equipos: 2, pts_por_acierto: 5 } },
  ];
  let creadasOK = 0;
  for (const p of preguntasTest) {
    const r = await http('POST', `/api/mundial/${torneoId}/preguntas`, p);
    if (r.status === 201) creadasOK++;
    else fail(`POST pregunta ${p.numero} falló: ${r.status} ${JSON.stringify(r.data)}`);
  }
  if (creadasOK === preguntasTest.length) ok(`${creadasOK} preguntas de prueba creadas`);

  // Mapear numero → id para los PUT
  const todasPreg = (await http('GET', `/api/mundial/${torneoId}/preguntas`)).data || [];
  const idByNum = {};
  for (const p of todasPreg) idByNum[p.numero] = p.id;

  // Forzar estado 'abierto' (carga habilitada) y limpiar deadline
  const db = new DatabaseSync(DB_PATH);
  try {
    db.prepare(`UPDATE mundial_config SET estado='abierto', deadline_carga=NULL WHERE torneo_id=?`).run(torneoId);
    info(`Estado forzado a 'abierto', deadline limpiada`);

    // 10.1 GET mis-respuestas vacío (post-limpieza)
    let r = await http('GET', `/api/mundial/${torneoId}/mis-respuestas`);
    if (r.status === 200 && Array.isArray(r.data)) {
      ok(`GET mis-respuestas vacío → 200 con array (${r.data.length} items previos)`);
    } else fail(`GET mis-respuestas inicial: ${r.status}`);

    // 10.2 PUT 5 respuestas válidas
    r = await http('PUT', `/api/mundial/${torneoId}/mis-respuestas`, {
      respuestas: [
        { pregunta_id: idByNum[9601], respuesta_json: { opcion: 'Sí' } },
        { pregunta_id: idByNum[9602], respuesta_json: { equipo: 'ARG' } },
        { pregunta_id: idByNum[9603], respuesta_json: { instancia: '16°' } },
        { pregunta_id: idByNum[9604], respuesta_json: { numero: 3 } },
        { pregunta_id: idByNum[9605], respuesta_json: { equipos: ['ARG', 'BRA'] } },
      ],
    });
    if (r.status === 200 && r.data.total === 5) {
      ok(`PUT 5 respuestas válidas → 200 (creadas=${r.data.creadas}, actualizadas=${r.data.actualizadas}) ✓`);
    } else fail(`PUT inesperado: ${r.status} ${JSON.stringify(r.data)}`);

    // 10.3 GET refleja lo guardado
    r = await http('GET', `/api/mundial/${torneoId}/mis-respuestas`);
    const ids = (r.data || []).map(x => x.pregunta_id);
    const todasGuardadas = [9601, 9602, 9603, 9604, 9605].every(n => ids.includes(idByNum[n]));
    if (r.status === 200 && todasGuardadas) ok(`GET refleja las 5 respuestas guardadas ✓`);
    else fail(`GET post-PUT: ${r.status}, ids=${JSON.stringify(ids)}`);

    // 10.4 PUT idempotente — re-PUT actualiza, no crea
    r = await http('PUT', `/api/mundial/${torneoId}/mis-respuestas`, {
      respuestas: [{ pregunta_id: idByNum[9601], respuesta_json: { opcion: 'No' } }],
    });
    if (r.status === 200 && r.data.creadas === 0 && r.data.actualizadas === 1) {
      ok(`PUT idempotente (re-respuesta) → actualizadas=1 creadas=0 ✓`);
    } else fail(`PUT idempotente: ${JSON.stringify(r.data)}`);

    // 10.5 PUT con opción no en config.opciones → 400
    r = await http('PUT', `/api/mundial/${torneoId}/mis-respuestas`, {
      respuestas: [{ pregunta_id: idByNum[9601], respuesta_json: { opcion: 'OpcionInvalida' } }],
    });
    if (r.status === 400) ok(`PUT opción inválida → 400 ✓`);
    else fail(`Esperaba 400 (opción inválida), recibí ${r.status}`);

    // 10.6 PUT con código no en catálogo → 400 (strict cross-check)
    r = await http('PUT', `/api/mundial/${torneoId}/mis-respuestas`, {
      respuestas: [{ pregunta_id: idByNum[9602], respuesta_json: { equipo: 'XYZ' } }],
    });
    const haFalladoXYZ = r.status === 400 && (
      (Array.isArray(r.data?.codigos_no_encontrados) && r.data.codigos_no_encontrados.includes('XYZ'))
      || /XYZ/.test(String(r.data?.error || ''))
    );
    if (haFalladoXYZ) ok(`PUT código XYZ no-en-catálogo → 400 con detalle ✓`);
    else fail(`PUT XYZ esperaba 400 con XYZ, recibí ${r.status} ${JSON.stringify(r.data)}`);

    // 10.7 PUT multi_equipo con cantidad incorrecta → 400
    r = await http('PUT', `/api/mundial/${torneoId}/mis-respuestas`, {
      respuestas: [{ pregunta_id: idByNum[9605], respuesta_json: { equipos: ['ARG'] } }],
    });
    if (r.status === 400) ok(`PUT multi_equipo con count incorrecto → 400 ✓`);
    else fail(`Esperaba 400 (multi count), recibí ${r.status}`);

    // 10.8 Atomicidad: 1 válida + 1 inválida → 400, ninguna persiste
    // Guardamos snapshot pre-test
    const preAtomic = (await http('GET', `/api/mundial/${torneoId}/mis-respuestas`)).data || [];
    const opcAntes = preAtomic.find(x => x.pregunta_id === idByNum[9601]);
    const valAntes = opcAntes ? JSON.parse(opcAntes.respuesta_json).opcion : null;

    r = await http('PUT', `/api/mundial/${torneoId}/mis-respuestas`, {
      respuestas: [
        { pregunta_id: idByNum[9601], respuesta_json: { opcion: 'Sí' } },     // válida
        { pregunta_id: idByNum[9604], respuesta_json: { numero: -5 } },        // inválida
      ],
    });
    if (r.status === 400) {
      const postAtomic = (await http('GET', `/api/mundial/${torneoId}/mis-respuestas`)).data || [];
      const opcPost = postAtomic.find(x => x.pregunta_id === idByNum[9601]);
      const valPost = opcPost ? JSON.parse(opcPost.respuesta_json).opcion : null;
      if (valPost === valAntes) {
        ok(`Atomicidad: 1 falla → la válida tampoco se persistió (opcion sigue '${valAntes}') ✓`);
      } else fail(`Atomicidad rota: opcion cambió de '${valAntes}' a '${valPost}'`);
    } else fail(`Esperaba 400 atomic, recibí ${r.status}`);

    // 10.9 Deadline vencido → PUT → 409
    db.prepare(`UPDATE mundial_config SET deadline_carga='2020-01-01T00:00:00Z' WHERE torneo_id=?`).run(torneoId);
    info(`Deadline forzado a 2020-01-01 (vencido)`);
    r = await http('PUT', `/api/mundial/${torneoId}/mis-respuestas`, {
      respuestas: [{ pregunta_id: idByNum[9601], respuesta_json: { opcion: 'Sí' } }],
    });
    if (r.status === 409 && /deadline/i.test(String(r.data?.error || ''))) {
      ok(`PUT con deadline vencido → 409 con mención de deadline ✓`);
    } else fail(`Esperaba 409 (deadline), recibí ${r.status} ${JSON.stringify(r.data)}`);
    db.prepare(`UPDATE mundial_config SET deadline_carga=NULL WHERE torneo_id=?`).run(torneoId);

    // 10.10a Restricción: crear pregunta con `restriccion grupo D` y validar
    // que un equipo de OTRO grupo es rechazado con 400.
    //
    // POST/PATCH preguntas requiere 'configuracion'. Forzamos transitoriamente
    // 'configuracion' (y limpiamos deadline por las dudas), creamos las
    // preguntas de test, y volvemos a 'abierto' para probar el PUT respuestas.
    db.prepare(`UPDATE mundial_config SET estado='configuracion', deadline_carga=NULL WHERE torneo_id=?`).run(torneoId);
    info(`Estado forzado a 'configuracion' para crear preguntas de test con restricción`);

    const presPregR = await http('POST', `/api/mundial/${torneoId}/preguntas`, {
      numero: 9651, enunciado: 'Test restriccion grupo D',
      tipo_pregunta: 'equipo_categoria',
      config_json: {
        categorias: [{ label: 'cualquiera', pts: 10, default: true }],
        restriccion: { tipo: 'grupo', grupo: 'D' },
      },
    });
    const presPregC = await http('POST', `/api/mundial/${torneoId}/preguntas`, {
      numero: 9652, enunciado: 'Test restriccion AFC',
      tipo_pregunta: 'equipo_categoria',
      config_json: {
        categorias: [{ label: 'cualquiera', pts: 20, default: true }],
        restriccion: { tipo: 'confederacion', confederacion: 'AFC' },
      },
    });

    // Volver a 'abierto' para que el PUT /mis-respuestas pueda correr
    db.prepare(`UPDATE mundial_config SET estado='abierto', deadline_carga=NULL WHERE torneo_id=?`).run(torneoId);
    info(`Estado vuelto a 'abierto' para validar respuestas`);

    if (presPregR.status === 201) {
      const idR = presPregR.data.pregunta?.id;
      // Respuesta válida: un equipo del Grupo D (USA, PAR, AUS, TUR)
      r = await http('PUT', `/api/mundial/${torneoId}/mis-respuestas`, {
        respuestas: [{ pregunta_id: idR, respuesta_json: { equipo: 'USA' } }],
      });
      if (r.status === 200) ok(`PUT restriccion grupo D con USA → 200 ✓`);
      else fail(`PUT restriccion: esperaba 200, recibí ${r.status}: ${JSON.stringify(r.data)}`);

      // Respuesta inválida: un equipo de OTRO grupo (ARG está en J)
      r = await http('PUT', `/api/mundial/${torneoId}/mis-respuestas`, {
        respuestas: [{ pregunta_id: idR, respuesta_json: { equipo: 'ARG' } }],
      });
      if (r.status === 400 && (
        /restricción/i.test(String(r.data?.error || '')) ||
        Array.isArray(r.data?.codigos_invalidos_por_restriccion)
      )) {
        ok(`PUT restriccion grupo D con ARG → 400 ✓ (detalle: ${r.data?.error?.slice(0,60) || ''}…)`);
      } else fail(`PUT restriccion ARG: esperaba 400, recibí ${r.status}: ${JSON.stringify(r.data)}`);
    } else {
      fail(`POST pregunta con restriccion grupo D falló: ${presPregR.status} ${JSON.stringify(presPregR.data)}`);
    }

    // 10.10b Restricción confederacion: AFC
    if (presPregC.status === 201) {
      const idC = presPregC.data.pregunta?.id;
      // KSA es AFC
      r = await http('PUT', `/api/mundial/${torneoId}/mis-respuestas`, {
        respuestas: [{ pregunta_id: idC, respuesta_json: { equipo: 'KSA' } }],
      });
      if (r.status === 200) ok(`PUT restriccion AFC con KSA → 200 ✓`);
      else fail(`PUT AFC KSA: esperaba 200, recibí ${r.status}: ${JSON.stringify(r.data)}`);

      // BRA es CONMEBOL — debe rechazar
      r = await http('PUT', `/api/mundial/${torneoId}/mis-respuestas`, {
        respuestas: [{ pregunta_id: idC, respuesta_json: { equipo: 'BRA' } }],
      });
      if (r.status === 400) ok(`PUT restriccion AFC con BRA → 400 ✓`);
      else fail(`PUT AFC BRA: esperaba 400, recibí ${r.status}`);
    } else {
      fail(`POST pregunta con restriccion AFC falló: ${presPregC.status} ${JSON.stringify(presPregC.data)}`);
    }

    // 10.11 Estado 'cerrado' → PUT → 409
    db.prepare(`UPDATE mundial_config SET estado='cerrado' WHERE torneo_id=?`).run(torneoId);
    info(`Estado forzado a 'cerrado'`);
    r = await http('PUT', `/api/mundial/${torneoId}/mis-respuestas`, {
      respuestas: [{ pregunta_id: idByNum[9601], respuesta_json: { opcion: 'Sí' } }],
    });
    if (r.status === 409) ok(`PUT con estado 'cerrado' → 409 ✓`);
    else fail(`Esperaba 409 (cerrado), recibí ${r.status}`);

    // GET sigue funcionando en 'cerrado' (es read-only)
    r = await http('GET', `/api/mundial/${torneoId}/mis-respuestas`);
    if (r.status === 200) ok(`GET mis-respuestas en 'cerrado' → 200 ✓ (lectura libre)`);
    else fail(`GET en cerrado: ${r.status}`);
  } finally {
    // Restaurar estado y limpiar preguntas/respuestas del diag
    try {
      db.prepare(`UPDATE mundial_config SET estado='configuracion', deadline_carga=NULL WHERE torneo_id=?`).run(torneoId);
      info(`Estado restaurado a 'configuracion'`);
    } catch (e) { fail(`No pude restaurar estado: ${e.message}`); }

    try {
      const r1 = db.prepare(`
        DELETE FROM mundial_respuestas_usuario
        WHERE pregunta_id IN (
          SELECT id FROM mundial_preguntas WHERE torneo_id = ? AND numero >= 9600 AND numero < 9700
        )
      `).run(torneoId);
      const r2 = db.prepare(`
        DELETE FROM mundial_preguntas WHERE torneo_id = ? AND numero >= 9600 AND numero < 9700
      `).run(torneoId);
      info(`Limpieza final: ${r2.changes} pregunta(s), ${r1.changes} respuesta(s) borradas`);
    } catch (e) {
      fail(`Limpieza final falló: ${e.message}`);
    }
    db.close();
  }
}

// ── 11. No regresión Fase 1 ─────────────────────────────────────────────────
async function checkNoRegresion(torneoId) {
  console.log(H('11. No regresión Fase 1'));

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
  console.log(c('Diagnóstico Mundial — Fase 2.x', '1;37'));
  console.log(c(`Torneo de diag: ${DIAG_TORNEO_NOMBRE}`, '90'));
  console.log(c(`DB_PATH: ${DB_PATH}`, '90'));
  if (DIAG_AUTO_GRANT) console.log(c(`DIAG_AUTO_GRANT=1 — auto-grant temporal habilitado`, '33'));

  try { dbChecks(); }
  catch (e) { fail(`Error en DB checks: ${e.message}`); process.exit(1); }

  // Auto-grant ANTES del authCheck para que /api/permisos/me lo vea.
  maybeGrantPermisoForDiag();

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
  await checkPreguntas(t.id);
  await checkRespuestasUsuario(t.id);
  await checkNoRegresion(t.id);

  console.log(H('Resultado'));
  if (exitCode === 0) console.log(OK('Diagnóstico Mundial — Fase 2.x: TODO OK'));
  else                console.log(FAIL('Diagnóstico encontró problemas (revisar arriba)'));
}

// Salida limpia para Windows: process.exit() puede disparar la assertion de libuv
//   `!(handle->flags & UV_HANDLE_CLOSING)` (src\win\async.c)
// cuando hay conexiones HTTP keepalive del dispatcher global de undici (fetch)
// aún abiertas. Solución estándar:
//   1. usar `process.exitCode` y dejar drenar el event loop;
//   2. cerrar explícitamente el dispatcher de undici si está disponible.
async function shutdown() {
  // 1. Revocar permiso temporal si lo asignamos (preserva estado original).
  try { revokePermisoSiGrantedPorDiag(); }
  catch (e) { fail(`Revoke en shutdown falló: ${e.message}`); }

  // 2. Cerrar conexiones HTTP keepalive de undici para que el process exit
  //    no dispare la assertion de libuv en Windows.
  try {
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
