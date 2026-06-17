#!/usr/bin/env node
/**
 * Diagnóstico Mundial — Fase B "lo pusieron"
 *
 * Verifica el cruce entre items del dashboard de Datos útiles y respuestas
 * de users. MAPPING hardcoded (Mundial 2026):
 *   goleadores_item  → pregunta numero=5  (respuesta_manual)
 *   top_amarillas    → pregunta numero=35 (equipo_categoria)
 *   top_rojas        → pregunta numero=36 (equipo_categoria)
 *
 * Cubre:
 *   1. Helper puro (matchTexto, matchEquipo, loadContexto).
 *   2. Setup: torneo + 3 equipos + 3 preguntas con esos numeros + 3 fake
 *      users que respondieron distinto.
 *   3. GET /datos-utiles → items tipo 'goleadores' traen lo_pusieron[].
 *   4. GET /goleadores → cada goleador estructurado trae lo_pusieron[].
 *   5. GET /tarjetas-partido → top_amarillas[].lo_pusieron y
 *      top_rojas[].lo_pusieron.
 *   6. Edge: si la pregunta del MAPPING no existe → lo_pusieron: [].
 *   7. Match texto normalizado (tildes, mayúsculas, espacios).
 *   8. Cleanup completo.
 *
 * Uso:
 *   cd backend
 *   DIAG_AUTO_GRANT=1 node diagnostico-mundial-pusieron.js
 */

const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const path = require('path');

const DIAG_EMAIL         = process.env.DIAG_EMAIL    || 'admin@prode.com';
const DIAG_PASSWORD      = process.env.DIAG_PASSWORD || 'admin123';
const API_BASE_URL       = process.env.API_BASE_URL  || 'http://localhost:3001';
const DB_PATH            = process.env.DB_PATH       || path.join(__dirname, 'prode.db');
const DIAG_AUTO_GRANT    = process.env.DIAG_AUTO_GRANT === '1';
const DIAG_TORNEO_NOMBRE = '__DIAG_MUNDIAL_PUSIERON__';

const FAKE_USERS = [
  { email: '__diag_pus_userB@local', nombre: 'DiagPus B' },
  { email: '__diag_pus_userC@local', nombre: 'DiagPus C' },
  { email: '__diag_pus_userD@local', nombre: 'DiagPus D' },
];
const FAKE_PASSWORD = 'diagpus-pass-2026';
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

// ── 1. Helper puro ─────────────────────────────────────────────────────────
function testHelperPuro() {
  console.log(H('1. Helper puro (mundial-pusieron)'));
  const helper = require('./src/logic/mundial-pusieron');

  // matchTexto: tildes y mayúsculas
  if (helper.matchTexto('Messi', 'respuesta_manual', JSON.stringify({ texto: 'messi' }))) ok(`matchTexto case-insensitive ✓`);
  else fail(`matchTexto case-insensitive falló`);
  if (helper.matchTexto('Mbappé', 'respuesta_manual', JSON.stringify({ texto: 'mbappe' }))) ok(`matchTexto sin tildes ✓`);
  else fail(`matchTexto sin tildes falló`);
  if (helper.matchTexto('L. Messi', 'respuesta_manual', JSON.stringify({ texto: '  L. MESSI  ' }))) ok(`matchTexto trim ✓`);
  else fail(`matchTexto trim falló`);
  // texto vacío no matchea
  if (!helper.matchTexto('', 'respuesta_manual', JSON.stringify({ texto: '' }))) ok(`matchTexto strings vacíos no matchean ✓`);
  else fail(`matchTexto debería rechazar vacíos`);
  // tipo de pregunta no apto
  if (!helper.matchTexto('Messi', 'opcion_unica', JSON.stringify({ texto: 'Messi' }))) ok(`matchTexto rechaza tipo no apto ✓`);
  else fail(`matchTexto no debería matchear en opcion_unica`);

  // matchEquipo
  if (helper.matchEquipo('ARG', 'equipo_categoria', JSON.stringify({ equipo: 'ARG' }))) ok(`matchEquipo equipo_categoria ✓`);
  else fail(`matchEquipo equipo_categoria falló`);
  if (helper.matchEquipo('BRA', 'multi_equipo', JSON.stringify({ equipos: ['ARG','BRA','FRA'] }))) ok(`matchEquipo multi_equipo (incluye) ✓`);
  else fail(`matchEquipo multi_equipo falló`);
  if (!helper.matchEquipo('GER', 'multi_equipo', JSON.stringify({ equipos: ['ARG','BRA','FRA'] }))) ok(`matchEquipo multi_equipo (no incluye) ✓`);
  else fail(`matchEquipo multi_equipo no debería matchear`);
  if (!helper.matchEquipo('ARG', 'numero_exacto', JSON.stringify({ numero: 5 }))) ok(`matchEquipo rechaza tipo no apto ✓`);
  else fail(`matchEquipo no debería matchear en numero_exacto`);
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

// ── Auth ───────────────────────────────────────────────────────────────────
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

// ── Torneo + equipos ───────────────────────────────────────────────────────
async function obtenerOCrearDiagTorneo() {
  console.log(H('3. Torneo + equipos'));
  const todos = await http('GET', '/api/torneos');
  if (todos.status !== 200) { fail(`No pude listar torneos`); return null; }
  const existente = (todos.data || []).find(t => t.nombre === DIAG_TORNEO_NOMBRE);
  let torneo;
  if (existente) {
    info(`Reusando torneo id=${existente.id}`);
    torneo = existente;
  } else {
    const created = await http('POST', '/api/torneos', {
      nombre: DIAG_TORNEO_NOMBRE, semestre: '2026-DIAG-PUS', tipo: 'mundial_preguntas',
    });
    if (created.status !== 201) { fail(`Crear torneo: ${created.status}`); return null; }
    torneo = created.data;
    ok(`Torneo creado id=${torneo.id}`);
  }

  // Equipos
  const db = new DatabaseSync(DB_PATH);
  try {
    db.prepare('DELETE FROM mundial_equipos_catalogo WHERE torneo_id=?').run(torneo.id);
    db.prepare('DELETE FROM mundial_datos_utiles    WHERE torneo_id=?').run(torneo.id);
    db.prepare('DELETE FROM mundial_tarjetas_partido WHERE torneo_id=?').run(torneo.id);
    db.prepare('DELETE FROM mundial_goleadores WHERE torneo_id=?').run(torneo.id);
  } finally { db.close(); }

  const eqs = [
    { codigo: 'ARG', nombre: 'Argentina', emoji: '🇦🇷', grupo: 'A', confederacion: 'CONMEBOL' },
    { codigo: 'BRA', nombre: 'Brasil',    emoji: '🇧🇷', grupo: 'B', confederacion: 'CONMEBOL' },
    { codigo: 'FRA', nombre: 'Francia',   emoji: '🇫🇷', grupo: 'C', confederacion: 'UEFA' },
  ];
  for (const e of eqs) {
    const r = await http('POST', `/api/mundial/${torneo.id}/equipos`, e);
    if (r.status !== 201) { fail(`POST equipo ${e.codigo}: ${r.status}`); return null; }
  }
  ok(`3 equipos cargados (ARG, BRA, FRA)`);
  return torneo;
}

// ── Setup preguntas + fake users + respuestas ─────────────────────────────
async function setupPreguntasYRespuestas(torneoId) {
  console.log(H('4. Preguntas (#5, #35, #36) + fake users + respuestas'));

  // Limpieza defensiva de corridas previas + crear preguntas con esos numeros.
  // Forzamos estado='configuracion' para poder crear preguntas.
  const db = new DatabaseSync(DB_PATH);
  let p5Id, p35Id, p36Id;
  let fakeIds = [];
  try {
    db.prepare(`INSERT OR IGNORE INTO mundial_config (torneo_id) VALUES (?)`).run(torneoId);
    db.prepare(`UPDATE mundial_config SET estado='configuracion' WHERE torneo_id=?`).run(torneoId);

    db.prepare(`DELETE FROM mundial_resultados WHERE pregunta_id IN
                (SELECT id FROM mundial_preguntas WHERE torneo_id=?)`).run(torneoId);
    db.prepare(`DELETE FROM mundial_respuestas_usuario WHERE pregunta_id IN
                (SELECT id FROM mundial_preguntas WHERE torneo_id=?)`).run(torneoId);
    db.prepare('DELETE FROM mundial_preguntas WHERE torneo_id=?').run(torneoId);
  } finally { db.close(); }

  // Pregunta #5 — respuesta_manual ("Goleador del Mundial")
  let r = await http('POST', `/api/mundial/${torneoId}/preguntas`, {
    numero: 5, enunciado: 'Goleador del Mundial', tipo_pregunta: 'respuesta_manual',
    config_json: { pts_max: 100 },
  });
  if (r.status !== 201) { fail(`POST pregunta #5: ${r.status} ${JSON.stringify(r.data)}`); return null; }
  p5Id = r.data.id;

  // Pregunta #35 — equipo_categoria (top amarillas)
  r = await http('POST', `/api/mundial/${torneoId}/preguntas`, {
    numero: 35, enunciado: 'Equipo con más amarillas', tipo_pregunta: 'equipo_categoria',
    config_json: { categorias: [{ label: 'default', pts: 50, default: true }] },
  });
  if (r.status !== 201) { fail(`POST pregunta #35: ${r.status} ${JSON.stringify(r.data)}`); return null; }
  p35Id = r.data.id;

  // Pregunta #36 — equipo_categoria (top rojas)
  r = await http('POST', `/api/mundial/${torneoId}/preguntas`, {
    numero: 36, enunciado: 'Equipo con más rojas', tipo_pregunta: 'equipo_categoria',
    config_json: { categorias: [{ label: 'default', pts: 50, default: true }] },
  });
  if (r.status !== 201) { fail(`POST pregunta #36: ${r.status} ${JSON.stringify(r.data)}`); return null; }
  p36Id = r.data.id;
  ok(`3 preguntas creadas (#5 manual, #35/#36 equipo_categoria)`);

  // Fake users + torneo_jugadores + respuestas directas
  const db2 = new DatabaseSync(DB_PATH);
  try {
    // Limpieza defensiva
    for (const u of FAKE_USERS) {
      db2.prepare(`DELETE FROM mundial_respuestas_usuario WHERE user_id IN (SELECT id FROM users WHERE email=?)`).run(u.email);
      db2.prepare(`DELETE FROM torneo_jugadores WHERE user_id IN (SELECT id FROM users WHERE email=?)`).run(u.email);
      db2.prepare(`DELETE FROM users WHERE email=?`).run(u.email);
    }
    const insertUser = db2.prepare('INSERT INTO users (nombre, email, password, role) VALUES (?, ?, ?, ?)');
    const linkTorneo = db2.prepare('INSERT INTO torneo_jugadores (torneo_id, user_id) VALUES (?, ?)');
    for (const u of FAKE_USERS) {
      const r = insertUser.run(u.nombre, u.email, FAKE_BCRYPT, 'user');
      fakeIds.push(r.lastInsertRowid);
      linkTorneo.run(torneoId, r.lastInsertRowid);
    }
    // Respuestas:
    // User B → Messi / ARG / BRA
    // User C → "L. Messi" (variación) / ARG / FRA
    // User D → Mbappé / BRA / ARG
    const insResp = db2.prepare(`INSERT INTO mundial_respuestas_usuario
      (pregunta_id, user_id, respuesta_json, updated_at) VALUES (?, ?, ?, datetime('now'))`);
    insResp.run(p5Id,  fakeIds[0], JSON.stringify({ texto: 'Messi' }));
    insResp.run(p5Id,  fakeIds[1], JSON.stringify({ texto: 'L. Messi' }));
    insResp.run(p5Id,  fakeIds[2], JSON.stringify({ texto: 'Mbappé' }));
    insResp.run(p35Id, fakeIds[0], JSON.stringify({ equipo: 'ARG' }));
    insResp.run(p35Id, fakeIds[1], JSON.stringify({ equipo: 'ARG' }));
    insResp.run(p35Id, fakeIds[2], JSON.stringify({ equipo: 'BRA' }));
    insResp.run(p36Id, fakeIds[0], JSON.stringify({ equipo: 'BRA' }));
    insResp.run(p36Id, fakeIds[1], JSON.stringify({ equipo: 'FRA' }));
    insResp.run(p36Id, fakeIds[2], JSON.stringify({ equipo: 'ARG' }));
  } finally { db2.close(); }
  ok(`3 fake users + 9 respuestas insertadas`);
  return { p5Id, p35Id, p36Id, fakeIds };
}

// ── Test datos-utiles (items manuales tipo goleadores) ────────────────────
async function testDatosUtiles(torneoId, fakeIds) {
  console.log(H('5. GET /datos-utiles → lo_pusieron en items goleadores'));

  // Crear un item manual tipo goleadores con titulo "Messi" + jugador "L. Messi".
  // El helper prueba primero jugador, luego titulo — debería matchear users B+C.
  let r = await http('POST', `/api/mundial/${torneoId}/datos-utiles`, {
    tipo: 'goleadores', titulo: 'Messi', jugador: 'L. Messi',
    valor_num: 8, equipo_codigo: 'ARG',
  });
  if (r.status !== 201) { fail(`POST item Messi: ${r.status} ${JSON.stringify(r.data)}`); return; }
  ok(`Item manual "Messi" creado`);

  // Crear otro item tipo otro (no goleador) → NO debe traer lo_pusieron.
  r = await http('POST', `/api/mundial/${torneoId}/datos-utiles`, {
    tipo: 'otro', titulo: 'Curiosidad', valor_texto: 'No relacionado',
  });
  if (r.status !== 201) { fail(`POST item otro: ${r.status}`); return; }

  // GET y verificar
  r = await http('GET', `/api/mundial/${torneoId}/datos-utiles`);
  if (r.status !== 200) { fail(`GET datos-utiles: ${r.status}`); return; }

  const messi = r.data.find(x => x.titulo === 'Messi' && x.tipo === 'goleadores');
  const otro  = r.data.find(x => x.tipo === 'otro');

  // Messi: User B puso "Messi" (match titulo), User C puso "L. Messi" (match jugador) → 2 matches
  // User D puso Mbappé → NO match
  if (Array.isArray(messi?.lo_pusieron) && messi.lo_pusieron.length === 2) {
    const ids = messi.lo_pusieron.map(p => p.user_id).sort();
    const esperado = [fakeIds[0], fakeIds[1]].sort();
    if (JSON.stringify(ids) === JSON.stringify(esperado)) {
      ok(`Messi → lo_pusieron incluye B y C (match titulo + jugador) ✓`);
    } else fail(`Messi lo_pusieron ids inesperados: ${JSON.stringify(messi.lo_pusieron)}`);
  } else fail(`Messi lo_pusieron len esperado 2, recibí ${messi?.lo_pusieron?.length}: ${JSON.stringify(messi?.lo_pusieron)}`);

  // Item tipo 'otro' NO debe traer lo_pusieron
  if (otro && (otro.lo_pusieron === undefined)) ok(`Item tipo 'otro' SIN lo_pusieron ✓`);
  else fail(`Item tipo 'otro' debería NO tener lo_pusieron: ${JSON.stringify(otro)}`);
}

// ── Test goleadores estructurados ─────────────────────────────────────────
async function testGoleadoresEstructurados(torneoId, fakeIds) {
  console.log(H('6. GET /goleadores → lo_pusieron por goleador'));

  let r = await http('PUT', `/api/mundial/${torneoId}/goleadores/bulk`, {
    goleadores: [
      { jugador: 'L. Messi',  goles: 8, equipo_codigo: 'ARG' },
      { jugador: 'K. Mbappé', goles: 6, equipo_codigo: 'FRA' },
    ],
  });
  if (r.status !== 200) { fail(`PUT goleadores bulk: ${r.status} ${JSON.stringify(r.data)}`); return; }

  r = await http('GET', `/api/mundial/${torneoId}/goleadores`);
  if (r.status !== 200) { fail(`GET goleadores: ${r.status}`); return; }
  const list = r.data?.goleadores || [];

  const messi   = list.find(g => g.jugador === 'L. Messi');
  const mbappe  = list.find(g => g.jugador === 'K. Mbappé');

  // Messi: User B "Messi" no matchea jugador "L. Messi" — pero el helper también
  // prueba con titulo si jugador no encuentra. mundial_goleadores no tiene titulo
  // así que matchTexto solo prueba jugador. B = "Messi", jugador = "L. Messi"
  // normalizado: "messi" vs "l. messi" → NO match. C = "L. Messi" → match.
  // Esperado: solo C.
  if (Array.isArray(messi?.lo_pusieron) && messi.lo_pusieron.length === 1
      && messi.lo_pusieron[0].user_id === fakeIds[1]) {
    ok(`L. Messi → solo User C (match exacto contra "L. Messi") ✓`);
  } else fail(`L. Messi lo_pusieron inesperado: ${JSON.stringify(messi?.lo_pusieron)}`);

  // Mbappé: User D puso "Mbappé" → match
  if (Array.isArray(mbappe?.lo_pusieron) && mbappe.lo_pusieron.length === 1
      && mbappe.lo_pusieron[0].user_id === fakeIds[2]) {
    ok(`K. Mbappé → User D ✓`);
  } else fail(`Mbappé lo_pusieron inesperado: ${JSON.stringify(mbappe?.lo_pusieron)}`);
}

// ── Test tarjetas-partido ─────────────────────────────────────────────────
async function testTarjetasPartido(torneoId, fakeIds) {
  console.log(H('7. GET /tarjetas-partido → lo_pusieron en top_amarillas/rojas'));

  // ARG con muchas amarillas, BRA con muchas rojas.
  let r = await http('PUT', `/api/mundial/${torneoId}/tarjetas-partido/bulk`, {
    celdas: [
      { equipo_codigo: 'ARG', partido_num: 1, amarillas: 5, rojas: 1 },
      { equipo_codigo: 'BRA', partido_num: 1, amarillas: 2, rojas: 3 },
      { equipo_codigo: 'FRA', partido_num: 1, amarillas: 1, rojas: 2 },
    ],
  });
  if (r.status !== 200) { fail(`PUT tarjetas bulk: ${r.status}`); return; }

  r = await http('GET', `/api/mundial/${torneoId}/tarjetas-partido`);
  if (r.status !== 200) { fail(`GET tarjetas: ${r.status}`); return; }

  // Top amarillas: ARG (5), BRA (2), FRA (1).
  // ARG en respuestas #35: User B y C lo pusieron como "equipo con más amarillas".
  const argAmar = r.data.top_amarillas.find(x => x.equipo_codigo === 'ARG');
  if (Array.isArray(argAmar?.lo_pusieron) && argAmar.lo_pusieron.length === 2) {
    const ids = argAmar.lo_pusieron.map(p => p.user_id).sort();
    const esperado = [fakeIds[0], fakeIds[1]].sort();
    if (JSON.stringify(ids) === JSON.stringify(esperado)) ok(`Top amarillas ARG → B y C ✓`);
    else fail(`ARG amarillas ids inesperados: ${JSON.stringify(argAmar.lo_pusieron)}`);
  } else fail(`ARG amarillas lo_pusieron len: ${argAmar?.lo_pusieron?.length}`);

  // BRA en #35: User D la puso.
  const braAmar = r.data.top_amarillas.find(x => x.equipo_codigo === 'BRA');
  if (Array.isArray(braAmar?.lo_pusieron) && braAmar.lo_pusieron.length === 1
      && braAmar.lo_pusieron[0].user_id === fakeIds[2]) {
    ok(`Top amarillas BRA → User D ✓`);
  } else fail(`BRA amarillas inesperado: ${JSON.stringify(braAmar?.lo_pusieron)}`);

  // Top rojas: BRA (3), FRA (2), ARG (1).
  // BRA en #36: User B la puso.
  const braRoja = r.data.top_rojas.find(x => x.equipo_codigo === 'BRA');
  if (Array.isArray(braRoja?.lo_pusieron) && braRoja.lo_pusieron.length === 1
      && braRoja.lo_pusieron[0].user_id === fakeIds[0]) {
    ok(`Top rojas BRA → User B ✓`);
  } else fail(`BRA rojas inesperado: ${JSON.stringify(braRoja?.lo_pusieron)}`);

  // ARG en #36: User D la puso.
  const argRoja = r.data.top_rojas.find(x => x.equipo_codigo === 'ARG');
  if (Array.isArray(argRoja?.lo_pusieron) && argRoja.lo_pusieron.length === 1
      && argRoja.lo_pusieron[0].user_id === fakeIds[2]) {
    ok(`Top rojas ARG → User D ✓`);
  } else fail(`ARG rojas inesperado: ${JSON.stringify(argRoja?.lo_pusieron)}`);

  // FRA en #36: User C la puso.
  const fraRoja = r.data.top_rojas.find(x => x.equipo_codigo === 'FRA');
  if (Array.isArray(fraRoja?.lo_pusieron) && fraRoja.lo_pusieron.length === 1
      && fraRoja.lo_pusieron[0].user_id === fakeIds[1]) {
    ok(`Top rojas FRA → User C ✓`);
  } else fail(`FRA rojas inesperado: ${JSON.stringify(fraRoja?.lo_pusieron)}`);
}

// ── Edge: pregunta del MAPPING NO existe ──────────────────────────────────
async function testPreguntaMissing(torneoId) {
  console.log(H('8. Edge: pregunta del MAPPING no existe → lo_pusieron []'));

  // Borrar la pregunta #5 → re-llamar GET /datos-utiles → lo_pusieron debe ser [].
  const db = new DatabaseSync(DB_PATH);
  try {
    db.prepare(`DELETE FROM mundial_respuestas_usuario WHERE pregunta_id IN
                (SELECT id FROM mundial_preguntas WHERE torneo_id=? AND numero=5)`).run(torneoId);
    db.prepare(`DELETE FROM mundial_preguntas WHERE torneo_id=? AND numero=5`).run(torneoId);
  } finally { db.close(); }

  const r = await http('GET', `/api/mundial/${torneoId}/datos-utiles`);
  if (r.status !== 200) { fail(`GET datos-utiles edge: ${r.status}`); return; }
  const messi = r.data.find(x => x.titulo === 'Messi' && x.tipo === 'goleadores');
  if (Array.isArray(messi?.lo_pusieron) && messi.lo_pusieron.length === 0) {
    ok(`Sin pregunta #5 → Messi lo_pusieron es [] ✓`);
  } else fail(`Esperaba lo_pusieron:[], recibí ${JSON.stringify(messi?.lo_pusieron)}`);
}

// ── Cleanup ────────────────────────────────────────────────────────────────
async function cleanup(torneoId) {
  console.log(H('9. Cleanup'));
  const db = new DatabaseSync(DB_PATH);
  try {
    if (torneoId) {
      db.prepare(`DELETE FROM mundial_respuestas_usuario WHERE pregunta_id IN
                  (SELECT id FROM mundial_preguntas WHERE torneo_id=?)`).run(torneoId);
      db.prepare('DELETE FROM mundial_preguntas WHERE torneo_id=?').run(torneoId);
      db.prepare('DELETE FROM mundial_datos_utiles WHERE torneo_id=?').run(torneoId);
      db.prepare('DELETE FROM mundial_tarjetas_partido WHERE torneo_id=?').run(torneoId);
      db.prepare('DELETE FROM mundial_goleadores WHERE torneo_id=?').run(torneoId);
      db.prepare('DELETE FROM mundial_equipos_catalogo WHERE torneo_id=?').run(torneoId);
      db.prepare('DELETE FROM mundial_config WHERE torneo_id=?').run(torneoId);
      db.prepare('DELETE FROM torneo_jugadores WHERE torneo_id=?').run(torneoId);
      db.prepare('DELETE FROM torneos WHERE id=?').run(torneoId);
      info(`Torneo de diag borrado`);
    }
    for (const u of FAKE_USERS) {
      db.prepare(`DELETE FROM mundial_respuestas_usuario WHERE user_id IN (SELECT id FROM users WHERE email=?)`).run(u.email);
      db.prepare(`DELETE FROM torneo_jugadores WHERE user_id IN (SELECT id FROM users WHERE email=?)`).run(u.email);
      db.prepare(`DELETE FROM users WHERE email=?`).run(u.email);
    }
  } catch (e) { fail(`Cleanup falló: ${e.message}`); }
  finally { db.close(); }
}

// ── Main ───────────────────────────────────────────────────────────────────
(async () => {
  let torneoId;
  try {
    testHelperPuro();
    maybeGrantPermisoForDiag();
    await authCheck();
    const t = await obtenerOCrearDiagTorneo();
    if (!t) { exitCode = 1; return; }
    torneoId = t.id;
    if (!TIENE_PERMISO) { warn(`Sin permiso: skipping HTTP tests`); return; }

    const setup = await setupPreguntasYRespuestas(torneoId);
    if (!setup) { exitCode = 1; return; }
    const { fakeIds } = setup;

    await testDatosUtiles(torneoId, fakeIds);
    await testGoleadoresEstructurados(torneoId, fakeIds);
    await testTarjetasPartido(torneoId, fakeIds);
    await testPreguntaMissing(torneoId);
  } catch (e) {
    fail(`Excepción: ${e.message}`);
    if (e.stack) console.error(e.stack);
  } finally {
    if (torneoId) await cleanup(torneoId);
    revokePermisoSiGrantedPorDiag();
    console.log('');
    if (exitCode === 0) console.log(c('━━━ Diagnóstico Lo pusieron OK ━━━', '1;32'));
    else                console.log(c('━━━ Diagnóstico Lo pusieron con ERRORES ━━━', '1;31'));
    process.exit(exitCode);
  }
})();
