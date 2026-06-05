#!/usr/bin/env node
/**
 * Diagnóstico Mundial — Datos útiles Fase 1 (MVP manual)
 *
 * Cubre:
 *   1. Schema/DB: columnas y CHECK de tipos en `mundial_datos_utiles`.
 *   2. Auth + grant temporal.
 *   3. Torneo de diag dedicado ('__DIAG_MUNDIAL_DU__') + 2 equipos.
 *   4. POST varios items válidos (goleadores, amarillas_equipo, otro) → 201.
 *   5. POST inválidos → 400:
 *        - tipo desconocido;
 *        - titulo vacío;
 *        - equipo_codigo inexistente;
 *        - valor_num no entero;
 *        - pregunta_id no perteneciente al torneo.
 *   6. GET sin filtros: orden por (tipo, orden_display, id).
 *   7. GET ?tipo=goleadores: filtra correctamente.
 *   8. PUT actualiza valor + updated_at avanza.
 *   9. PUT activo=0 → desaparece de GET default, aparece con
 *      ?incluir_inactivos=1 (admin).
 *  10. DELETE remueve fila; segundo DELETE → 404.
 *  11. User no-admin: GET OK, POST 401/403, PUT 401/403, DELETE 401/403,
 *      y ?incluir_inactivos=1 NO trae inactivos (gate admin).
 *  12. Cleanup (incluido fake user para test no-admin).
 *
 * Uso:
 *   cd backend
 *   DIAG_AUTO_GRANT=1 node diagnostico-mundial-datos-utiles.js
 */

const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const path = require('path');

const DIAG_EMAIL         = process.env.DIAG_EMAIL    || 'admin@prode.com';
const DIAG_PASSWORD      = process.env.DIAG_PASSWORD || 'admin123';
const API_BASE_URL       = process.env.API_BASE_URL  || 'http://localhost:3001';
const DB_PATH            = process.env.DB_PATH       || path.join(__dirname, 'prode.db');
const DIAG_AUTO_GRANT    = process.env.DIAG_AUTO_GRANT === '1';
const DIAG_TORNEO_NOMBRE = '__DIAG_MUNDIAL_DU__';

const FAKE_EMAIL    = '__diag_du_userB@local';
const FAKE_PASSWORD = 'diagdu-pass-2026';
const FAKE_BCRYPT   = bcrypt.hashSync(FAKE_PASSWORD, 4);

const DIAG_GRANT_STATE = { granted: false };

// ── pintura ────────────────────────────────────────────────────────────────
const c    = (txt, code) => `\x1b[${code}m${txt}\x1b[0m`;
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

// ── HTTP ───────────────────────────────────────────────────────────────────
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

// ── 1. Schema/DB ───────────────────────────────────────────────────────────
function dbChecks() {
  console.log(H('1. Schema/DB'));
  let db;
  try { db = new DatabaseSync(DB_PATH); }
  catch (e) { fail(`No pude abrir la DB: ${e.message}`); process.exit(1); }
  const cols = db.prepare("PRAGMA table_info('mundial_datos_utiles')").all();
  const esperadas = [
    'torneo_id', 'tipo', 'titulo', 'valor_num', 'valor_texto',
    'equipo_codigo', 'jugador', 'grupo', 'descripcion',
    'orden_display', 'activo', 'pregunta_id', 'created_at', 'updated_at',
  ];
  for (const name of esperadas) {
    const col = cols.find(c => c.name === name);
    if (col) ok(`mundial_datos_utiles.${name} OK (type=${col.type})`);
    else fail(`Columna ${name} faltante`);
  }
  // Verificar que el CHECK rechaza un tipo inválido vía INSERT directo.
  try {
    db.prepare(`INSERT INTO mundial_datos_utiles
      (torneo_id, tipo, titulo) VALUES (-9999, 'xxxxx_invalid', 'tmp')`).run();
    fail(`CHECK de tipo NO rechazó valor inválido`);
    db.prepare(`DELETE FROM mundial_datos_utiles WHERE torneo_id=-9999`).run();
  } catch (e) {
    if (/CHECK/.test(e.message)) ok(`CHECK de tipo rechaza valores inválidos ✓`);
    else fail(`Error inesperado en INSERT: ${e.message}`);
  }
  db.close();
}

// ── Auto-grant ─────────────────────────────────────────────────────────────
function maybeGrantPermisoForDiag() {
  if (!DIAG_AUTO_GRANT) return;
  const db = new DatabaseSync(DB_PATH);
  try {
    const user = db.prepare('SELECT id, role FROM users WHERE email = ?').get(DIAG_EMAIL);
    if (!user) { warn(`${DIAG_EMAIL} no existe.`); return; }
    if (user.role === 'superadmin') { info(`Superadmin → no se necesita grant`); return; }
    const existente = db.prepare("SELECT 1 FROM user_permisos WHERE user_id=? AND permiso='gestionar_mundial' LIMIT 1").get(user.id);
    if (existente) { info(`Ya tenía permiso`); return; }
    db.prepare("INSERT INTO user_permisos (user_id, permiso) VALUES (?, 'gestionar_mundial')").run(user.id);
    DIAG_GRANT_STATE.granted = true;
    warn(`'gestionar_mundial' asignado TEMPORALMENTE`);
  } catch (e) { fail(`AUTO_GRANT falló: ${e.message}`); }
  finally { db.close(); }
}
function revokePermisoSiGrantedPorDiag() {
  if (!DIAG_GRANT_STATE.granted) return;
  const db = new DatabaseSync(DB_PATH);
  try {
    const user = db.prepare('SELECT id FROM users WHERE email = ?').get(DIAG_EMAIL);
    if (user) {
      db.prepare("DELETE FROM user_permisos WHERE user_id=? AND permiso='gestionar_mundial'").run(user.id);
      info(`Permiso revocado`);
    }
  } catch (e) { fail(`Revoke falló: ${e.message}`); }
  finally { db.close(); }
}

// ── 2. Auth ────────────────────────────────────────────────────────────────
let TIENE_PERMISO = false;
async function authCheck() {
  console.log(H('2. Auth'));
  const r = await http('POST', '/api/auth/login', { email: DIAG_EMAIL, password: DIAG_PASSWORD });
  if (r.status === 0) { fail(`No pude conectar: ${r.error}`); process.exit(1); }
  if (r.status !== 200 || !r.data?.token) { fail(`Login falló (${r.status})`); process.exit(1); }
  TOKEN = r.data.token; USER = r.data.user;
  ok(`Login OK — id=${USER.id} role=${USER.role}`);
  const perms = await http('GET', '/api/permisos/me');
  if (perms.status === 200) {
    TIENE_PERMISO = perms.data?.permisos?.includes('gestionar_mundial') || USER.role === 'superadmin';
    if (TIENE_PERMISO) ok(`Tiene 'gestionar_mundial'`);
    else warn(`Sin permiso — tests admin van a skipear`);
  }
}

// ── 3. Torneo de diag + setup ──────────────────────────────────────────────
async function obtenerOCrearDiagTorneo() {
  console.log(H('3. Torneo de diag + setup'));
  const todos = await http('GET', '/api/torneos');
  if (todos.status !== 200) { fail(`No pude listar torneos`); return null; }
  const existente = (todos.data || []).find(t => t.nombre === DIAG_TORNEO_NOMBRE);
  if (existente) {
    info(`Reusando torneo id=${existente.id}`);
    return existente;
  }
  const created = await http('POST', '/api/torneos', {
    nombre: DIAG_TORNEO_NOMBRE, semestre: '2026-DIAG-DU', tipo: 'mundial_preguntas',
  });
  if (created.status === 201) { ok(`Torneo creado id=${created.data.id}`); return created.data; }
  fail(`Crear torneo falló (${created.status}): ${JSON.stringify(created.data)}`);
  return null;
}

const EQUIPOS_DIAG = [
  { codigo: 'X1', nombre: 'X One', emoji: '🅰️', grupo: 'A', confederacion: 'UEFA' },
  { codigo: 'X2', nombre: 'X Two', emoji: '🅱️', grupo: 'B', confederacion: 'CONMEBOL' },
];

async function setupEquipos(torneoId) {
  const db = new DatabaseSync(DB_PATH);
  try {
    db.prepare('DELETE FROM mundial_equipos_catalogo WHERE torneo_id=?').run(torneoId);
    // Limpiar datos útiles previos por las dudas.
    db.prepare('DELETE FROM mundial_datos_utiles WHERE torneo_id=?').run(torneoId);
  } finally { db.close(); }
  for (const e of EQUIPOS_DIAG) {
    const r = await http('POST', `/api/mundial/${torneoId}/equipos`, e);
    if (r.status !== 201) { fail(`POST equipo ${e.codigo}: ${r.status}`); return false; }
  }
  ok(`Setup OK — 2 equipos cargados`);
  return true;
}

// ── 4. CRUD admin ──────────────────────────────────────────────────────────
async function testCrudAdmin(torneoId) {
  console.log(H('4. POST válidos + GET orden + filtros'));

  const items = [
    { tipo: 'goleadores',        titulo: 'Messi',  valor_num: 7, jugador: 'L. Messi', equipo_codigo: 'X1', orden_display: 1 },
    { tipo: 'goleadores',        titulo: 'Mbappé', valor_num: 5, jugador: 'K. Mbappé', equipo_codigo: 'X2', orden_display: 2 },
    { tipo: 'amarillas_equipo',  titulo: 'X One — 8 amarillas',  valor_num: 8, equipo_codigo: 'X1', grupo: 'A', orden_display: 1 },
    { tipo: 'otro',              titulo: 'Curiosidad', valor_texto: 'Récord de algo' },
  ];
  const creados = [];
  for (const it of items) {
    const r = await http('POST', `/api/mundial/${torneoId}/datos-utiles`, it);
    if (r.status !== 201) { fail(`POST ${it.tipo}: ${r.status} ${JSON.stringify(r.data)}`); return null; }
    creados.push(r.data);
  }
  ok(`POST ${items.length} items válidos ✓`);

  // GET sin filtros: orden tipo asc → amarillas_equipo, goleadores, otro
  let r = await http('GET', `/api/mundial/${torneoId}/datos-utiles`);
  if (r.status !== 200 || !Array.isArray(r.data) || r.data.length !== 4) {
    fail(`GET inicial: status=${r.status} length=${r.data?.length}`);
    return null;
  }
  // Verificar orden
  const tipos = r.data.map(x => x.tipo);
  const esperado = ['amarillas_equipo', 'goleadores', 'goleadores', 'otro'];
  if (JSON.stringify(tipos) === JSON.stringify(esperado)) ok(`Orden por (tipo, orden_display, id) correcto ✓`);
  else fail(`Orden inesperado: ${JSON.stringify(tipos)}`);

  // Dentro de goleadores, Messi (orden 1) debe ir antes que Mbappé (orden 2).
  const goleadores = r.data.filter(x => x.tipo === 'goleadores');
  if (goleadores[0].titulo === 'Messi' && goleadores[1].titulo === 'Mbappé') {
    ok(`Sub-orden por orden_display dentro del mismo tipo ✓`);
  } else fail(`Sub-orden inesperado: ${goleadores.map(g => g.titulo).join(',')}`);

  // GET ?tipo=goleadores → 2 filas
  r = await http('GET', `/api/mundial/${torneoId}/datos-utiles?tipo=goleadores`);
  if (r.status === 200 && Array.isArray(r.data) && r.data.length === 2) {
    ok(`GET ?tipo=goleadores → 2 filas ✓`);
  } else fail(`Filtro tipo: status=${r.status} length=${r.data?.length}`);

  // GET ?tipo=desconocido → 400
  r = await http('GET', `/api/mundial/${torneoId}/datos-utiles?tipo=cualquier`);
  if (r.status === 400) ok(`GET tipo inválido → 400 ✓`);
  else fail(`Esperaba 400, recibí ${r.status}`);

  return creados;
}

async function testValidaciones(torneoId) {
  console.log(H('5. Validaciones POST'));

  const casos = [
    { body: { tipo: 'noexiste', titulo: 'x' }, hint: 'tipo desconocido' },
    { body: { tipo: 'goleadores', titulo: '' }, hint: 'titulo vacío' },
    { body: { tipo: 'goleadores', titulo: 'sin trim', equipo_codigo: 'ZZZ' }, hint: 'equipo_codigo inexistente' },
    { body: { tipo: 'goleadores', titulo: 'x', valor_num: 1.5 }, hint: 'valor_num no entero' },
    { body: { tipo: 'goleadores', titulo: 'x', orden_display: -1 }, hint: 'orden_display negativo' },
    { body: { tipo: 'goleadores', titulo: 'x', pregunta_id: 999999 }, hint: 'pregunta_id de otro torneo' },
  ];
  for (const cas of casos) {
    const r = await http('POST', `/api/mundial/${torneoId}/datos-utiles`, cas.body);
    if (r.status === 400) ok(`POST ${cas.hint} → 400 ✓`);
    else fail(`POST ${cas.hint}: esperaba 400, recibí ${r.status} ${JSON.stringify(r.data)}`);
  }
}

async function testPutDelete(torneoId, creados) {
  console.log(H('6. PUT + activo=0 + DELETE'));

  // Pickear el primer goleador y editarlo.
  const id = creados.find(c => c.tipo === 'goleadores').id;
  const beforeR = await http('GET', `/api/mundial/${torneoId}/datos-utiles`);
  const before = (beforeR.data || []).find(x => x.id === id);
  const updatedAtBefore = before?.updated_at;

  // Pequeña espera para que updated_at avance al menos 1s.
  await new Promise(r => setTimeout(r, 1100));

  let r = await http('PUT', `/api/mundial/${torneoId}/datos-utiles/${id}`, {
    tipo: 'goleadores', titulo: 'Messi', valor_num: 9, equipo_codigo: 'X1', orden_display: 1,
  });
  if (r.status === 200 && r.data?.valor_num === 9) ok(`PUT actualiza valor_num=9 ✓`);
  else { fail(`PUT falló: ${r.status} ${JSON.stringify(r.data)}`); return; }
  if (r.data.updated_at && r.data.updated_at !== updatedAtBefore) ok(`updated_at avanzó ✓`);
  else fail(`updated_at no cambió: before=${updatedAtBefore} after=${r.data.updated_at}`);

  // Marcar como inactivo y verificar que desaparece de GET default.
  r = await http('PUT', `/api/mundial/${torneoId}/datos-utiles/${id}`, {
    tipo: 'goleadores', titulo: 'Messi', valor_num: 9, equipo_codigo: 'X1', activo: 0,
  });
  if (r.status === 200 && r.data?.activo === 0) ok(`PUT activo=0 ✓`);
  else fail(`PUT activo=0 falló: ${r.status}`);

  r = await http('GET', `/api/mundial/${torneoId}/datos-utiles`);
  const aparece = (r.data || []).some(x => x.id === id);
  if (!aparece) ok(`GET default oculta inactivos ✓`);
  else fail(`GET default debería ocultar el item inactivo`);

  // Como admin: ?incluir_inactivos=1 lo trae de vuelta.
  r = await http('GET', `/api/mundial/${torneoId}/datos-utiles?incluir_inactivos=1`);
  const apareceAdmin = (r.data || []).some(x => x.id === id);
  if (apareceAdmin) ok(`GET admin ?incluir_inactivos=1 lo expone ✓`);
  else fail(`Admin con incluir_inactivos=1 debería ver el item`);

  // DELETE
  r = await http('DELETE', `/api/mundial/${torneoId}/datos-utiles/${id}`);
  if (r.status === 200 && r.data?.ok === true) ok(`DELETE → 200 ✓`);
  else fail(`DELETE: ${r.status} ${JSON.stringify(r.data)}`);

  // DELETE segundo → 404
  r = await http('DELETE', `/api/mundial/${torneoId}/datos-utiles/${id}`);
  if (r.status === 404) ok(`DELETE inexistente → 404 ✓`);
  else fail(`Esperaba 404, recibí ${r.status}`);
}

// ── 7. User no-admin ───────────────────────────────────────────────────────
async function testUserNoAdmin(torneoId) {
  console.log(H('7. User no-admin (lectura sí, escritura no)'));

  // Crear fake user + agregar a torneo_jugadores.
  const db = new DatabaseSync(DB_PATH);
  let fakeId;
  try {
    // Limpieza defensiva
    db.prepare(`DELETE FROM torneo_jugadores WHERE user_id IN (SELECT id FROM users WHERE email=?)`).run(FAKE_EMAIL);
    db.prepare(`DELETE FROM users WHERE email=?`).run(FAKE_EMAIL);
    const r = db.prepare(
      'INSERT INTO users (nombre, email, password, role) VALUES (?, ?, ?, ?)'
    ).run('DiagDU UserB', FAKE_EMAIL, FAKE_BCRYPT, 'user');
    fakeId = r.lastInsertRowid;
    db.prepare('INSERT INTO torneo_jugadores (torneo_id, user_id) VALUES (?, ?)').run(torneoId, fakeId);
  } finally { db.close(); }

  const adminToken = TOKEN;
  const login = await http('POST', '/api/auth/login', { email: FAKE_EMAIL, password: FAKE_PASSWORD });
  if (login.status !== 200 || !login.data?.token) {
    fail(`Login user B falló (${login.status})`); TOKEN = adminToken; return;
  }
  TOKEN = login.data.token;
  ok(`Login user B OK — role=${login.data.user.role}`);

  // GET OK
  let r = await http('GET', `/api/mundial/${torneoId}/datos-utiles`);
  if (r.status === 200 && Array.isArray(r.data)) ok(`User B GET → 200 ✓`);
  else fail(`User B GET: ${r.status}`);

  // ?incluir_inactivos=1 NO trae inactivos (gate admin).
  // En este punto puede no haber inactivos cargados; el chequeo es defensivo.
  r = await http('GET', `/api/mundial/${torneoId}/datos-utiles?incluir_inactivos=1`);
  if (r.status === 200) {
    const tieneInactivos = (r.data || []).some(x => x.activo === 0);
    if (!tieneInactivos) ok(`User B con ?incluir_inactivos=1 NO recibe inactivos ✓`);
    else fail(`User B no debería recibir items inactivos`);
  } else fail(`User B GET incluir_inactivos: ${r.status}`);

  // POST → 403 (adminMiddleware) o 401 según middleware exacto.
  r = await http('POST', `/api/mundial/${torneoId}/datos-utiles`, {
    tipo: 'goleadores', titulo: 'Hack',
  });
  if (r.status === 403 || r.status === 401) ok(`User B POST → ${r.status} ✓`);
  else fail(`User B POST: esperaba 401/403, recibí ${r.status}`);

  // PUT/DELETE sobre un id real (tomamos cualquiera).
  const liveR = await http('GET', `/api/mundial/${torneoId}/datos-utiles`);
  const algunId = (liveR.data || [])[0]?.id;
  if (algunId) {
    r = await http('PUT', `/api/mundial/${torneoId}/datos-utiles/${algunId}`, {
      tipo: 'goleadores', titulo: 'Hack',
    });
    if (r.status === 403 || r.status === 401) ok(`User B PUT → ${r.status} ✓`);
    else fail(`User B PUT: esperaba 401/403, recibí ${r.status}`);

    r = await http('DELETE', `/api/mundial/${torneoId}/datos-utiles/${algunId}`);
    if (r.status === 403 || r.status === 401) ok(`User B DELETE → ${r.status} ✓`);
    else fail(`User B DELETE: esperaba 401/403, recibí ${r.status}`);
  }

  TOKEN = adminToken;
}

// ── Cleanup ────────────────────────────────────────────────────────────────
function cleanupFakeUsers() {
  const db = new DatabaseSync(DB_PATH);
  try {
    db.prepare(`DELETE FROM torneo_jugadores WHERE user_id IN (SELECT id FROM users WHERE email=?)`).run(FAKE_EMAIL);
    db.prepare(`DELETE FROM users WHERE email=?`).run(FAKE_EMAIL);
  } catch (e) { fail(`Cleanup fake user falló: ${e.message}`); }
  finally { db.close(); }
}

async function cleanup(torneoId) {
  console.log(H('8. Cleanup'));
  const db = new DatabaseSync(DB_PATH);
  try {
    if (torneoId) {
      db.prepare('DELETE FROM mundial_datos_utiles WHERE torneo_id=?').run(torneoId);
      db.prepare('DELETE FROM mundial_equipos_catalogo WHERE torneo_id=?').run(torneoId);
      db.prepare('DELETE FROM mundial_config WHERE torneo_id=?').run(torneoId);
      db.prepare('DELETE FROM torneo_jugadores WHERE torneo_id=?').run(torneoId);
      db.prepare('DELETE FROM torneos WHERE id=?').run(torneoId);
      info(`Torneo de diag borrado`);
    }
  } catch (e) { fail(`Cleanup falló: ${e.message}`); }
  finally { db.close(); }
  cleanupFakeUsers();
}

// ── Main ───────────────────────────────────────────────────────────────────
(async () => {
  let torneoId;
  try {
    dbChecks();
    maybeGrantPermisoForDiag();
    await authCheck();
    const t = await obtenerOCrearDiagTorneo();
    if (!t) { exitCode = 1; return; }
    torneoId = t.id;
    if (!TIENE_PERMISO) { warn(`Sin permiso: skipping HTTP admin tests`); return; }

    if (!(await setupEquipos(torneoId))) return;
    const creados = await testCrudAdmin(torneoId);
    if (!creados) return;
    await testValidaciones(torneoId);
    await testPutDelete(torneoId, creados);
    await testUserNoAdmin(torneoId);
  } catch (e) {
    fail(`Excepción: ${e.message}`);
    if (e.stack) console.error(e.stack);
  } finally {
    if (torneoId) await cleanup(torneoId);
    revokePermisoSiGrantedPorDiag();
    console.log('');
    if (exitCode === 0) console.log(c('━━━ Diagnóstico Datos útiles OK ━━━', '1;32'));
    else                console.log(c('━━━ Diagnóstico Datos útiles con ERRORES ━━━', '1;31'));
    process.exit(exitCode);
  }
})();
