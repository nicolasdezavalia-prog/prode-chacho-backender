#!/usr/bin/env node
/**
 * Diagnóstico Mundial — Datos útiles Fase 2 (Tarjetas estructuradas)
 *
 * Cubre:
 *   1. Schema/DB: columnas + UNIQUE + CHECKs de mundial_tarjetas_partido.
 *   2. Auth + grant temporal.
 *   3. Torneo de diag dedicado ('__DIAG_MUNDIAL_TJ__') + 4 equipos.
 *   4. PUT bulk con varias celdas → 200, GET → mismas celdas + totales.
 *   5. Validaciones PUT → 400:
 *        - celda duplicada (equipo, partido) en el body;
 *        - equipo_codigo inexistente;
 *        - partido_num <= 0;
 *        - amarillas negativa;
 *        - rojas negativa.
 *   6. Re-PUT mismo (equipo, partido) actualiza valores (UPSERT) y
 *      updated_at avanza.
 *   7. GET devuelve totales y tops correctos con corte por POSICIÓN
 *      (empates entran).
 *   8. GET ?limit=2 recorta el top.
 *   9. User no-admin: GET OK, PUT → 401/403.
 *  10. Cleanup (torneo + fake user).
 *
 * Uso:
 *   cd backend
 *   DIAG_AUTO_GRANT=1 node diagnostico-mundial-tarjetas-partido.js
 */

const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const path = require('path');

const DIAG_EMAIL         = process.env.DIAG_EMAIL    || 'admin@prode.com';
const DIAG_PASSWORD      = process.env.DIAG_PASSWORD || 'admin123';
const API_BASE_URL       = process.env.API_BASE_URL  || 'http://localhost:3001';
const DB_PATH            = process.env.DB_PATH       || path.join(__dirname, 'prode.db');
const DIAG_AUTO_GRANT    = process.env.DIAG_AUTO_GRANT === '1';
const DIAG_TORNEO_NOMBRE = '__DIAG_MUNDIAL_TJ__';

const FAKE_EMAIL    = '__diag_tj_userB@local';
const FAKE_PASSWORD = 'diagtj-pass-2026';
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
  const cols = db.prepare("PRAGMA table_info('mundial_tarjetas_partido')").all();
  const esperadas = [
    'torneo_id', 'equipo_codigo', 'partido_num', 'amarillas', 'rojas',
    'observacion', 'created_at', 'updated_at',
  ];
  for (const name of esperadas) {
    const col = cols.find(c => c.name === name);
    if (col) ok(`mundial_tarjetas_partido.${name} OK (type=${col.type})`);
    else fail(`Columna ${name} faltante`);
  }
  // CHECK partido_num >= 1
  try {
    db.prepare(`INSERT INTO mundial_tarjetas_partido
      (torneo_id, equipo_codigo, partido_num, amarillas, rojas)
      VALUES (-1, 'XXX', 0, 0, 0)`).run();
    fail(`CHECK partido_num NO rechaza 0`);
    db.prepare(`DELETE FROM mundial_tarjetas_partido WHERE torneo_id=-1`).run();
  } catch (e) {
    if (/CHECK/.test(e.message)) ok(`CHECK partido_num >= 1 ✓`);
    else fail(`Error inesperado: ${e.message}`);
  }
  // CHECK amarillas >= 0
  try {
    db.prepare(`INSERT INTO mundial_tarjetas_partido
      (torneo_id, equipo_codigo, partido_num, amarillas, rojas)
      VALUES (-1, 'XXX', 1, -3, 0)`).run();
    fail(`CHECK amarillas NO rechaza negativos`);
    db.prepare(`DELETE FROM mundial_tarjetas_partido WHERE torneo_id=-1`).run();
  } catch (e) {
    if (/CHECK/.test(e.message)) ok(`CHECK amarillas >= 0 ✓`);
    else fail(`Error inesperado: ${e.message}`);
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

// ── 3. Torneo + equipos ────────────────────────────────────────────────────
async function obtenerOCrearDiagTorneo() {
  console.log(H('3. Torneo de diag + equipos'));
  const todos = await http('GET', '/api/torneos');
  if (todos.status !== 200) { fail(`No pude listar torneos`); return null; }
  const existente = (todos.data || []).find(t => t.nombre === DIAG_TORNEO_NOMBRE);
  if (existente) { info(`Reusando torneo id=${existente.id}`); return existente; }
  const created = await http('POST', '/api/torneos', {
    nombre: DIAG_TORNEO_NOMBRE, semestre: '2026-DIAG-TJ', tipo: 'mundial_preguntas',
  });
  if (created.status === 201) { ok(`Torneo creado id=${created.data.id}`); return created.data; }
  fail(`Crear torneo falló (${created.status}): ${JSON.stringify(created.data)}`);
  return null;
}

const EQUIPOS_DIAG = [
  { codigo: 'TJ1', nombre: 'Alfa',   emoji: '🅰️', grupo: 'A', confederacion: 'UEFA' },
  { codigo: 'TJ2', nombre: 'Beta',   emoji: '🅱️', grupo: 'A', confederacion: 'CONMEBOL' },
  { codigo: 'TJ3', nombre: 'Gama',   emoji: '🆎', grupo: 'B', confederacion: 'CAF' },
  { codigo: 'TJ4', nombre: 'Delta',  emoji: '🆑', grupo: 'B', confederacion: 'CONCACAF' },
];

async function setupEquipos(torneoId) {
  const db = new DatabaseSync(DB_PATH);
  try {
    db.prepare('DELETE FROM mundial_equipos_catalogo WHERE torneo_id=?').run(torneoId);
    db.prepare('DELETE FROM mundial_tarjetas_partido WHERE torneo_id=?').run(torneoId);
  } finally { db.close(); }
  for (const e of EQUIPOS_DIAG) {
    const r = await http('POST', `/api/mundial/${torneoId}/equipos`, e);
    if (r.status !== 201) { fail(`POST equipo ${e.codigo}: ${r.status} ${JSON.stringify(r.data)}`); return false; }
  }
  ok(`Setup OK — 4 equipos cargados`);
  return true;
}

// ── 4. PUT bulk + GET totales ──────────────────────────────────────────────
async function testBulkUpsertYGet(torneoId) {
  console.log(H('4. PUT bulk + GET totales + tops'));

  // Total amarillas: Alfa=2+1+3=6, Beta=1+0+2=3, Gama=6 (empate con Alfa), Delta=0.
  // Total rojas:     Alfa=1, Beta=0, Gama=2, Delta=0.
  const celdas = [
    { equipo_codigo: 'TJ1', partido_num: 1, amarillas: 2, rojas: 1 },
    { equipo_codigo: 'TJ1', partido_num: 2, amarillas: 1, rojas: 0 },
    { equipo_codigo: 'TJ1', partido_num: 3, amarillas: 3, rojas: 0 },
    { equipo_codigo: 'TJ2', partido_num: 1, amarillas: 1, rojas: 0 },
    { equipo_codigo: 'TJ2', partido_num: 2, amarillas: 0, rojas: 0 },
    { equipo_codigo: 'TJ2', partido_num: 3, amarillas: 2, rojas: 0 },
    { equipo_codigo: 'TJ3', partido_num: 1, amarillas: 2, rojas: 1, observacion: 'g1' },
    { equipo_codigo: 'TJ3', partido_num: 2, amarillas: 2, rojas: 1 },
    { equipo_codigo: 'TJ3', partido_num: 3, amarillas: 2, rojas: 0 },
    // TJ4: sin cargar nada → totales 0, no aparece en top.
  ];
  let r = await http('PUT', `/api/mundial/${torneoId}/tarjetas-partido/bulk`, { celdas });
  if (r.status !== 200) { fail(`PUT bulk: ${r.status} ${JSON.stringify(r.data)}`); return false; }
  ok(`PUT bulk → 200 ✓`);

  // GET
  r = await http('GET', `/api/mundial/${torneoId}/tarjetas-partido`);
  if (r.status !== 200) { fail(`GET: ${r.status}`); return false; }
  const d = r.data;

  if (Array.isArray(d.celdas) && d.celdas.length === celdas.length) ok(`celdas.length=${celdas.length} ✓`);
  else fail(`Esperaba ${celdas.length} celdas, recibí ${d.celdas?.length}`);

  if (d.max_partido_num === 3) ok(`max_partido_num=3 ✓`);
  else fail(`Esperaba max_partido_num=3, recibí ${d.max_partido_num}`);

  // Totales por equipo. Solo equipos con celdas cargadas.
  const totByEq = new Map(d.totales_por_equipo.map(t => [t.equipo_codigo, t]));
  const esperado = {
    TJ1: { amarillas: 6, rojas: 1, partidos_jugados: 3 },
    TJ2: { amarillas: 3, rojas: 0, partidos_jugados: 3 },
    TJ3: { amarillas: 6, rojas: 2, partidos_jugados: 3 },
  };
  let okTotales = true;
  for (const [cod, esp] of Object.entries(esperado)) {
    const t = totByEq.get(cod);
    if (!t || t.amarillas !== esp.amarillas || t.rojas !== esp.rojas || t.partidos_jugados !== esp.partidos_jugados) {
      fail(`Total ${cod} inesperado: ${JSON.stringify(t)}`);
      okTotales = false;
    }
  }
  if (okTotales) ok(`Totales por equipo correctos (Alfa 6/1, Beta 3/0, Gama 6/2) ✓`);

  // Top amarillas: Alfa y Gama empatan en 6 → ambos posicion 1.
  // Beta queda en posicion 3 con 3.
  if (Array.isArray(d.top_amarillas) && d.top_amarillas.length === 3) {
    const pos1 = d.top_amarillas.filter(x => x.posicion === 1).map(x => x.equipo_codigo).sort();
    const pos3 = d.top_amarillas.find(x => x.posicion === 3);
    // empate en 1 → ambos comparten posición; el orden alfabético dicta Alfa antes que Gama.
    const ok1 = pos1.length === 2 && pos1[0] === 'TJ1' && pos1[1] === 'TJ3';
    const ok3 = pos3 && pos3.equipo_codigo === 'TJ2' && pos3.total === 3;
    if (ok1 && ok3) ok(`top_amarillas: Alfa+Gama empate pos 1 (6), Beta pos 3 (3) ✓`);
    else fail(`top_amarillas inesperado: ${JSON.stringify(d.top_amarillas)}`);
  } else fail(`top_amarillas len esperado 3, recibí ${d.top_amarillas?.length}`);

  // Top rojas: Gama 2, Alfa 1. Beta y Delta no aparecen (0 rojas).
  if (Array.isArray(d.top_rojas) && d.top_rojas.length === 2) {
    const ok1 = d.top_rojas[0].equipo_codigo === 'TJ3' && d.top_rojas[0].posicion === 1 && d.top_rojas[0].total === 2;
    const ok2 = d.top_rojas[1].equipo_codigo === 'TJ1' && d.top_rojas[1].posicion === 2 && d.top_rojas[1].total === 1;
    if (ok1 && ok2) ok(`top_rojas: Gama pos 1 (2), Alfa pos 2 (1) ✓`);
    else fail(`top_rojas inesperado: ${JSON.stringify(d.top_rojas)}`);
  } else fail(`top_rojas len esperado 2, recibí ${d.top_rojas?.length}`);

  // observacion roundtrip
  const cTJ3p1 = d.celdas.find(x => x.equipo_codigo === 'TJ3' && x.partido_num === 1);
  if (cTJ3p1?.observacion === 'g1') ok(`observacion roundtrip ✓`);
  else fail(`observacion esperada 'g1', recibí '${cTJ3p1?.observacion}'`);

  return true;
}

// ── 5. Validaciones ────────────────────────────────────────────────────────
async function testValidaciones(torneoId) {
  console.log(H('5. Validaciones PUT bulk'));

  const casos = [
    { body: { celdas: [
        { equipo_codigo: 'TJ1', partido_num: 1, amarillas: 0, rojas: 0 },
        { equipo_codigo: 'TJ1', partido_num: 1, amarillas: 2, rojas: 0 },
      ] }, hint: 'celda duplicada (equipo, partido)' },
    { body: { celdas: [{ equipo_codigo: 'ZZZ', partido_num: 1, amarillas: 0, rojas: 0 }] },
      hint: 'equipo_codigo inexistente' },
    { body: { celdas: [{ equipo_codigo: 'TJ1', partido_num: 0, amarillas: 0, rojas: 0 }] },
      hint: 'partido_num=0' },
    { body: { celdas: [{ equipo_codigo: 'TJ1', partido_num: 1, amarillas: -1, rojas: 0 }] },
      hint: 'amarillas negativa' },
    { body: { celdas: [{ equipo_codigo: 'TJ1', partido_num: 1, amarillas: 0, rojas: -2 }] },
      hint: 'rojas negativa' },
    { body: { celdas: 'noarray' }, hint: 'celdas no es array' },
  ];
  for (const cas of casos) {
    const r = await http('PUT', `/api/mundial/${torneoId}/tarjetas-partido/bulk`, cas.body);
    if (r.status === 400) ok(`PUT ${cas.hint} → 400 ✓`);
    else fail(`PUT ${cas.hint}: esperaba 400, recibí ${r.status} ${JSON.stringify(r.data)}`);
  }
}

// ── 6. UPSERT + updated_at avanza ──────────────────────────────────────────
async function testUpsert(torneoId) {
  console.log(H('6. UPSERT mismo (equipo, partido) + updated_at avanza'));

  let r = await http('GET', `/api/mundial/${torneoId}/tarjetas-partido`);
  const before = (r.data?.celdas || []).find(c => c.equipo_codigo === 'TJ1' && c.partido_num === 1);
  const beforeUpdated = before?.updated_at;

  await new Promise(rs => setTimeout(rs, 1100)); // dejar avanzar updated_at

  r = await http('PUT', `/api/mundial/${torneoId}/tarjetas-partido/bulk`, {
    celdas: [{ equipo_codigo: 'TJ1', partido_num: 1, amarillas: 5, rojas: 2, observacion: 'editado' }],
  });
  if (r.status !== 200) { fail(`Re-PUT: ${r.status}`); return; }

  const after = (r.data?.celdas || []).find(c => c.equipo_codigo === 'TJ1' && c.partido_num === 1);
  if (after?.amarillas === 5 && after?.rojas === 2 && after?.observacion === 'editado') {
    ok(`Valores actualizados (UPSERT) ✓`);
  } else fail(`Valores no se actualizaron: ${JSON.stringify(after)}`);
  if (after?.updated_at && after.updated_at !== beforeUpdated) ok(`updated_at avanzó ✓`);
  else fail(`updated_at no cambió: before=${beforeUpdated} after=${after?.updated_at}`);

  // Cantidad de celdas no debe haber cambiado.
  const totalCeldas = (r.data?.celdas || []).length;
  if (totalCeldas === 9) ok(`No se crearon filas extra (sigue habiendo 9 celdas) ✓`);
  else fail(`Esperaba 9 celdas, recibí ${totalCeldas}`);
}

// ── 7. ?limit recorta el top ───────────────────────────────────────────────
async function testLimit(torneoId) {
  console.log(H('7. GET ?limit recorta el top'));
  const r = await http('GET', `/api/mundial/${torneoId}/tarjetas-partido?limit=1`);
  if (r.status !== 200) { fail(`GET ?limit=1: ${r.status}`); return; }
  // Con limit=1 y empate en pos 1 (Alfa+Gama), DEBEN entrar ambos (corte por posición).
  // Wait — el test anterior actualizó TJ1 amarillas a 5 (no 6 ya). Veamos:
  // Después del re-PUT: TJ1 partido 1 quedó con 5 amarillas (antes 2). Otros partidos
  // mantienen 1 y 3 → Alfa total = 5+1+3 = 9. Gama sigue 6. Beta 3.
  // → top con limit=1: solo Alfa.
  const top = r.data?.top_amarillas || [];
  if (top.length === 1 && top[0].equipo_codigo === 'TJ1' && top[0].posicion === 1) {
    ok(`?limit=1 → solo Alfa (líder único tras re-PUT) ✓`);
  } else fail(`Esperaba [Alfa pos 1], recibí ${JSON.stringify(top)}`);
}

// ── 8. User no-admin ───────────────────────────────────────────────────────
async function testUserNoAdmin(torneoId) {
  console.log(H('8. User no-admin (GET sí, PUT no)'));

  const db = new DatabaseSync(DB_PATH);
  let fakeId;
  try {
    db.prepare(`DELETE FROM torneo_jugadores WHERE user_id IN (SELECT id FROM users WHERE email=?)`).run(FAKE_EMAIL);
    db.prepare(`DELETE FROM users WHERE email=?`).run(FAKE_EMAIL);
    const r = db.prepare('INSERT INTO users (nombre, email, password, role) VALUES (?, ?, ?, ?)')
      .run('DiagTJ UserB', FAKE_EMAIL, FAKE_BCRYPT, 'user');
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

  let r = await http('GET', `/api/mundial/${torneoId}/tarjetas-partido`);
  if (r.status === 200 && Array.isArray(r.data?.celdas)) ok(`User B GET → 200 ✓`);
  else fail(`User B GET: ${r.status}`);

  r = await http('PUT', `/api/mundial/${torneoId}/tarjetas-partido/bulk`, {
    celdas: [{ equipo_codigo: 'TJ1', partido_num: 1, amarillas: 0, rojas: 0 }],
  });
  if (r.status === 401 || r.status === 403) ok(`User B PUT → ${r.status} ✓`);
  else fail(`User B PUT: esperaba 401/403, recibí ${r.status}`);

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
  console.log(H('9. Cleanup'));
  const db = new DatabaseSync(DB_PATH);
  try {
    if (torneoId) {
      db.prepare('DELETE FROM mundial_tarjetas_partido WHERE torneo_id=?').run(torneoId);
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
    if (!(await testBulkUpsertYGet(torneoId))) return;
    await testValidaciones(torneoId);
    await testUpsert(torneoId);
    await testLimit(torneoId);
    await testUserNoAdmin(torneoId);
  } catch (e) {
    fail(`Excepción: ${e.message}`);
    if (e.stack) console.error(e.stack);
  } finally {
    if (torneoId) await cleanup(torneoId);
    revokePermisoSiGrantedPorDiag();
    console.log('');
    if (exitCode === 0) console.log(c('━━━ Diagnóstico Tarjetas OK ━━━', '1;32'));
    else                console.log(c('━━━ Diagnóstico Tarjetas con ERRORES ━━━', '1;31'));
    process.exit(exitCode);
  }
})();
