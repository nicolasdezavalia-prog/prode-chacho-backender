#!/usr/bin/env node
/**
 * Diagnóstico Mundial — Fase 5 (Cambios post-grupos)
 *
 * Cubre el ciclo completo:
 *   1. Schema/DB: columna `cambio_habilitado` + índice UNIQUE en cambios_respuesta.
 *   2. Auth + auto-grant.
 *   3. Torneo de diag dedicado ('__DIAG_MUNDIAL_FASE5__'), aislado de fase3.
 *   4. Setup: catálogo de equipos + preguntas + respuestas iniciales del admin
 *      (que actúa como el "participante" de prueba).
 *   5. Tests del PATCH preguntas extendido — admin marca cambio_habilitado.
 *   6. Flujo ventana:
 *      a. POST /ventanas-cambios crea ventana 'cerrada'.
 *      b. PUT /mis-cambios con ventana cerrada → 409.
 *      c. PATCH abre la ventana.
 *      d. PUT /mis-cambios sin habilitado → 403.
 *      e. POST /habilitados agrega al admin.
 *      f. PUT /mis-cambios con pregunta no cambiable → 400.
 *      g. PUT /mis-cambios válido → 200, sin afectar mundial_respuestas_usuario.
 *      h. Cargar resultados.
 *      i. GET /ranking — refleja respuesta vieja.
 *      j. POST /publicar — pisa mundial_respuestas_usuario + marca publicado=1.
 *      k. GET /ranking — refleja respuesta nueva.
 *   7. Edge cases: 2 ventanas abiertas (409), publicar irreversible (409 al PATCH),
 *      deshabilitar user con cambios cargados (no se publican).
 *   8. Cleanup en finally.
 *
 * Uso:
 *   cd backend
 *   DIAG_AUTO_GRANT=1 node diagnostico-mundial-fase5.js
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DIAG_EMAIL         = process.env.DIAG_EMAIL    || 'admin@prode.com';
const DIAG_PASSWORD      = process.env.DIAG_PASSWORD || 'admin123';
const API_BASE_URL       = process.env.API_BASE_URL  || 'http://localhost:3001';
const DB_PATH            = process.env.DB_PATH       || path.join(__dirname, 'prode.db');
const DIAG_AUTO_GRANT    = process.env.DIAG_AUTO_GRANT === '1';
const DIAG_TORNEO_NOMBRE = '__DIAG_MUNDIAL_FASE5__';
const DIAG_FAKE_EMAIL    = '__diag_fase5_user2@local.test';

const DIAG_GRANT_STATE     = { granted: false };
const DIAG_FAKE_USER_STATE = { userId: null, created: false };

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
  console.log(H('1. Schema/DB (read-only)'));
  let db;
  try { db = new DatabaseSync(DB_PATH); }
  catch (e) { fail(`No pude abrir la DB en ${DB_PATH}: ${e.message}`); process.exit(1); }

  // Columna cambio_habilitado en mundial_preguntas
  const cols = db.prepare("PRAGMA table_info('mundial_preguntas')").all();
  const col  = cols.find(c => c.name === 'cambio_habilitado');
  if (col) ok(`mundial_preguntas.cambio_habilitado OK (type=${col.type})`);
  else fail(`Columna cambio_habilitado faltante en mundial_preguntas — correr migración (reiniciar backend).`);

  // Índice UNIQUE en mundial_cambios_respuesta
  const idx = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type='index' AND name='idx_mundial_cambios_respuesta_unique'
  `).get();
  if (idx) ok(`Índice UNIQUE en mundial_cambios_respuesta (ventana_id, user_id, pregunta_id) OK`);
  else fail(`Falta índice idx_mundial_cambios_respuesta_unique — correr migración.`);

  db.close();
}

// ── Auto-grant ─────────────────────────────────────────────────────────────
function maybeGrantPermisoForDiag() {
  if (!DIAG_AUTO_GRANT) return;
  const db = new DatabaseSync(DB_PATH);
  try {
    const user = db.prepare('SELECT id, email, role FROM users WHERE email = ?').get(DIAG_EMAIL);
    if (!user) { warn(`${DIAG_EMAIL} no existe. Continuando.`); return; }
    if (user.role === 'superadmin') { info(`Superadmin → no se necesita grant`); return; }
    const existente = db.prepare("SELECT 1 FROM user_permisos WHERE user_id=? AND permiso='gestionar_mundial' LIMIT 1").get(user.id);
    if (existente) { info(`Ya tenía permiso, no asigno ni revoco`); return; }
    db.prepare("INSERT INTO user_permisos (user_id, permiso) VALUES (?, 'gestionar_mundial')").run(user.id);
    DIAG_GRANT_STATE.granted = true;
    warn(`'gestionar_mundial' asignado TEMPORALMENTE a ${DIAG_EMAIL}`);
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
    else warn(`Sin permiso. Tests admin van a fallar.`);
  }
}

// ── 3. Torneo de diag ──────────────────────────────────────────────────────
async function obtenerOCrearDiagTorneo() {
  console.log(H('3. Torneo de diag Fase 5'));
  const todos = await http('GET', '/api/torneos');
  if (todos.status !== 200) { fail(`No pude listar torneos`); return null; }
  const existente = (todos.data || []).find(t => t.nombre === DIAG_TORNEO_NOMBRE);
  if (existente) {
    info(`Reusando torneo id=${existente.id}`);
    if (existente.tipo !== 'mundial_preguntas') {
      fail(`Torneo de diag tiene tipo='${existente.tipo}'. Borralo a mano.`);
      return null;
    }
    return existente;
  }
  const created = await http('POST', '/api/torneos', {
    nombre: DIAG_TORNEO_NOMBRE, semestre: '2026-DIAG-F5', tipo: 'mundial_preguntas',
  });
  if (created.status === 201) { ok(`Torneo creado id=${created.data.id}`); return created.data; }
  fail(`Crear torneo falló (${created.status}): ${JSON.stringify(created.data)}`);
  return null;
}

function setEstado(torneoId, estado) {
  const db = new DatabaseSync(DB_PATH);
  try {
    db.prepare(`INSERT OR IGNORE INTO mundial_config (torneo_id) VALUES (?)`).run(torneoId);
    db.prepare(`UPDATE mundial_config SET estado=? WHERE torneo_id=?`).run(estado, torneoId);
  } finally { db.close(); }
}

// ── 4. Setup contenido ─────────────────────────────────────────────────────
const EQUIPOS_DIAG = [
  { codigo: 'X1', nombre: 'X One', emoji: '🅰️', grupo: 'A', confederacion: 'UEFA' },
  { codigo: 'X2', nombre: 'X Two', emoji: '🅱️', grupo: 'A', confederacion: 'CONMEBOL' },
];

// Preguntas: 9801 cambio_habilitado=1, 9802 cambio_habilitado=0 (control).
const PREGUNTAS_DIAG = [
  { numero: 9801, enunciado: 'EC cambiable', tipo_pregunta: 'equipo_categoria',
    config_json: { categorias: [{ label: 'cualquiera', pts: 50, default: true }] } },
  { numero: 9802, enunciado: 'EC NO cambiable', tipo_pregunta: 'equipo_categoria',
    config_json: { categorias: [{ label: 'cualquiera', pts: 30, default: true }] } },
];

async function setupContenido(torneoId) {
  console.log(H('4. Setup contenido'));
  setEstado(torneoId, 'configuracion');

  // Equipos
  const db = new DatabaseSync(DB_PATH);
  try { db.prepare('DELETE FROM mundial_equipos_catalogo WHERE torneo_id=?').run(torneoId); }
  finally { db.close(); }
  for (const e of EQUIPOS_DIAG) {
    const r = await http('POST', `/api/mundial/${torneoId}/equipos`, e);
    if (r.status !== 201) { fail(`POST equipo ${e.codigo}: ${r.status}`); return false; }
  }
  ok(`Equipos cargados`);

  // Preguntas (borrar previas en rango 9800-9899)
  const db2 = new DatabaseSync(DB_PATH);
  try {
    db2.prepare(`DELETE FROM mundial_cambios_respuesta WHERE pregunta_id IN
      (SELECT id FROM mundial_preguntas WHERE torneo_id=? AND numero BETWEEN 9800 AND 9899)`).run(torneoId);
    db2.prepare(`DELETE FROM mundial_resultados WHERE pregunta_id IN
      (SELECT id FROM mundial_preguntas WHERE torneo_id=? AND numero BETWEEN 9800 AND 9899)`).run(torneoId);
    db2.prepare(`DELETE FROM mundial_respuestas_usuario WHERE pregunta_id IN
      (SELECT id FROM mundial_preguntas WHERE torneo_id=? AND numero BETWEEN 9800 AND 9899)`).run(torneoId);
    db2.prepare(`DELETE FROM mundial_preguntas WHERE torneo_id=? AND numero BETWEEN 9800 AND 9899`).run(torneoId);
    // También limpiamos ventanas previas del torneo (re-run safe)
    db2.prepare(`DELETE FROM mundial_ventana_habilitados WHERE ventana_id IN
      (SELECT id FROM mundial_ventanas_cambios WHERE torneo_id=?)`).run(torneoId);
    db2.prepare(`DELETE FROM mundial_ventanas_cambios WHERE torneo_id=?`).run(torneoId);
  } finally { db2.close(); }

  for (const p of PREGUNTAS_DIAG) {
    const r = await http('POST', `/api/mundial/${torneoId}/preguntas`, p);
    if (r.status !== 201) { fail(`POST pregunta ${p.numero}: ${r.status} ${JSON.stringify(r.data)}`); return false; }
  }
  ok(`Preguntas creadas`);

  // PATCH preguntas: marcar 9801 cambio_habilitado=1 (test del PATCH extendido)
  const preg = await http('GET', `/api/mundial/${torneoId}/preguntas?activa=1`);
  if (preg.status !== 200) { fail(`GET preguntas: ${preg.status}`); return false; }
  const byNum = new Map(preg.data.map(p => [p.numero, p]));
  const id9801 = byNum.get(9801).id;
  const id9802 = byNum.get(9802).id;

  const r1 = await http('PATCH', `/api/mundial/${torneoId}/preguntas/${id9801}`, { cambio_habilitado: true });
  if (r1.status === 200 && r1.data.pregunta?.cambio_habilitado === 1) {
    ok(`PATCH cambio_habilitado=true sobre P9801 → 200 ✓`);
  } else fail(`PATCH cambio_habilitado P9801: ${r1.status} ${JSON.stringify(r1.data)}`);

  // 9802 queda con cambio_habilitado=0 (default).
  const r2 = await http('PATCH', `/api/mundial/${torneoId}/preguntas/${id9802}`, { cambio_habilitado: false });
  if (r2.status === 200 && r2.data.pregunta?.cambio_habilitado === 0) {
    ok(`PATCH cambio_habilitado=false sobre P9802 → 200 ✓`);
  } else fail(`PATCH cambio_habilitado P9802: ${r2.status}`);

  // Respuestas iniciales del admin (estado='abierto' para PUT /mis-respuestas)
  setEstado(torneoId, 'abierto');
  const respArr = [
    { pregunta_id: id9801, respuesta_json: { equipo: 'X1' } },  // que se va a cambiar
    { pregunta_id: id9802, respuesta_json: { equipo: 'X2' } },  // no cambiable
  ];
  const rResp = await http('PUT', `/api/mundial/${torneoId}/mis-respuestas`, { respuestas: respArr });
  if (rResp.status !== 200) { fail(`PUT respuestas iniciales: ${rResp.status} ${JSON.stringify(rResp.data)}`); return false; }
  ok(`Respuestas iniciales admin cargadas`);

  return { byNum, id9801, id9802 };
}

// ── 5. Ventana + habilitados + cambios + publicar ──────────────────────────
async function flujoCambios(torneoId, ids) {
  console.log(H('5. Flujo ventana → habilitar → cargar → publicar'));

  // 5.1 Cargar resultados con torneo en 'grupos_jugados' para poder cargarlos
  setEstado(torneoId, 'grupos_jugados');
  await http('POST', `/api/mundial/${torneoId}/resultados/${ids.id9801}`, {
    resultado_json: { equipo: 'X2' },  // X2 es correcto. Admin respondió X1 → fallará scoring inicial.
  });
  await http('POST', `/api/mundial/${torneoId}/resultados/${ids.id9802}`, {
    resultado_json: { equipo: 'X2' },  // Admin respondió X2 → acierta 30 pts.
  });
  info(`Resultados cargados: P9801=X2, P9802=X2`);

  // Verificar ranking inicial: admin pts = 0 (no acertó 9801) + 30 (9802) = 30
  const rk0 = await http('GET', `/api/mundial/${torneoId}/ranking`);
  if (rk0.status === 200 && rk0.data.visible) {
    const adminRow = rk0.data.ranking.find(r => r.user_id === USER.id);
    if (adminRow && adminRow.puntos_totales === 30) {
      ok(`Ranking inicial: admin pts=30 (P9802 acierta) ✓`);
    } else fail(`Ranking inicial inesperado: ${JSON.stringify(adminRow)}`);
  } else fail(`GET ranking inicial: ${rk0.status} ${JSON.stringify(rk0.data)}`);

  // 5.2 Pasar a cambios_abiertos (vía force)
  setEstado(torneoId, 'cambios_abiertos');

  // 5.3 Crear ventana 'cerrada'
  let r = await http('POST', `/api/mundial/${torneoId}/ventanas-cambios`, {
    nombre: 'Diag Fase 5', costo_usd: 25, cambios_por_usuario: 2,
  });
  if (r.status !== 201) { fail(`POST ventana: ${r.status} ${JSON.stringify(r.data)}`); return false; }
  const ventanaId = r.data.id;
  if (r.data.estado === 'cerrada') ok(`Ventana creada id=${ventanaId} estado='cerrada' ✓`);
  else fail(`Estado inesperado: ${r.data.estado}`);

  // 5.4 Intentar cargar cambio con ventana cerrada → 409 (no hay ventana abierta)
  r = await http('PUT', `/api/mundial/${torneoId}/mis-cambios`, {
    cambios: [{ pregunta_id: ids.id9801, respuesta_json: { equipo: 'X2' } }],
  });
  if (r.status === 409) ok(`PUT mis-cambios sin ventana abierta → 409 ✓`);
  else fail(`Esperaba 409, recibí ${r.status}: ${JSON.stringify(r.data)}`);

  // 5.5 Abrir ventana
  r = await http('PATCH', `/api/mundial/${torneoId}/ventanas-cambios/${ventanaId}`, { estado: 'abierta' });
  if (r.status === 200 && r.data.estado === 'abierta') ok(`PATCH ventana abierta → 200 ✓`);
  else fail(`PATCH abrir: ${r.status} ${JSON.stringify(r.data)}`);

  // 5.6 Intentar abrir una segunda ventana → 409 (MVP: 1 abierta a la vez)
  let r2 = await http('POST', `/api/mundial/${torneoId}/ventanas-cambios`, { nombre: 'Otra' });
  const ventana2Id = r2.data?.id;
  r2 = await http('PATCH', `/api/mundial/${torneoId}/ventanas-cambios/${ventana2Id}`, { estado: 'abierta' });
  if (r2.status === 409) ok(`Abrir 2da ventana → 409 (1 abierta a la vez) ✓`);
  else fail(`Esperaba 409 al abrir 2da, recibí ${r2.status}`);
  // Cleanup ventana 2 (sigue cerrada)
  const dbC = new DatabaseSync(DB_PATH);
  try { dbC.prepare('DELETE FROM mundial_ventanas_cambios WHERE id=?').run(ventana2Id); } finally { dbC.close(); }

  // 5.7 Intentar PUT mis-cambios sin habilitado → 403
  r = await http('PUT', `/api/mundial/${torneoId}/mis-cambios`, {
    cambios: [{ pregunta_id: ids.id9801, respuesta_json: { equipo: 'X2' } }],
  });
  if (r.status === 403) ok(`PUT mis-cambios sin habilitado → 403 ✓`);
  else fail(`Esperaba 403, recibí ${r.status}`);

  // 5.8 Habilitar admin
  r = await http('POST', `/api/mundial/${torneoId}/ventanas-cambios/${ventanaId}/habilitados`, {
    user_id: USER.id,
  });
  if (r.status === 201) ok(`POST habilitar admin → 201 ✓`);
  else fail(`POST habilitar: ${r.status} ${JSON.stringify(r.data)}`);

  // 5.9 Intentar PUT con pregunta NO cambiable → 400
  r = await http('PUT', `/api/mundial/${torneoId}/mis-cambios`, {
    cambios: [{ pregunta_id: ids.id9802, respuesta_json: { equipo: 'X1' } }],
  });
  if (r.status === 400 && /no es elegible|cambio_habilitado/i.test(String(r.data?.error || ''))) {
    ok(`PUT pregunta NO cambiable → 400 con mensaje claro ✓`);
  } else fail(`Esperaba 400 elegibilidad, recibí ${r.status}: ${JSON.stringify(r.data)}`);

  // 5.10 Verificar respuesta_usuario NO modificada todavía
  const dbV1 = new DatabaseSync(DB_PATH);
  try {
    const row = dbV1.prepare(
      'SELECT respuesta_json FROM mundial_respuestas_usuario WHERE pregunta_id=? AND user_id=?'
    ).get(ids.id9801, USER.id);
    if (row && JSON.parse(row.respuesta_json).equipo === 'X1') {
      ok(`mundial_respuestas_usuario sigue con X1 (original) ✓`);
    } else fail(`respuesta_usuario inesperada: ${row?.respuesta_json}`);
  } finally { dbV1.close(); }

  // 5.11 PUT mis-cambios válido (cambiar 9801 de X1 a X2)
  r = await http('PUT', `/api/mundial/${torneoId}/mis-cambios`, {
    cambios: [{ pregunta_id: ids.id9801, respuesta_json: { equipo: 'X2' } }],
  });
  if (r.status === 200 && r.data.creados === 1 && r.data.cambios_usados === 1) {
    ok(`PUT mis-cambios válido → 200 (creados=1, usados=1) ✓`);
  } else fail(`PUT válido: ${r.status} ${JSON.stringify(r.data)}`);

  // 5.12 Verificar mundial_respuestas_usuario AÚN no se pisa
  const dbV2 = new DatabaseSync(DB_PATH);
  try {
    const row = dbV2.prepare(
      'SELECT respuesta_json FROM mundial_respuestas_usuario WHERE pregunta_id=? AND user_id=?'
    ).get(ids.id9801, USER.id);
    if (row && JSON.parse(row.respuesta_json).equipo === 'X1') {
      ok(`mundial_respuestas_usuario sigue con X1 (cambio publicado=0) ✓`);
    } else fail(`respuesta_usuario inesperada: ${row?.respuesta_json}`);
    const cambio = dbV2.prepare(
      'SELECT publicado FROM mundial_cambios_respuesta WHERE ventana_id=? AND user_id=? AND pregunta_id=?'
    ).get(ventanaId, USER.id, ids.id9801);
    if (cambio && cambio.publicado === 0) ok(`mundial_cambios_respuesta.publicado=0 ✓`);
    else fail(`cambios_respuesta.publicado inesperado: ${cambio?.publicado}`);
  } finally { dbV2.close(); }

  // 5.13 Verificar ranking sigue mostrando respuesta vieja (admin pts=30)
  const rk1 = await http('GET', `/api/mundial/${torneoId}/ranking`);
  if (rk1.status === 200) {
    const adminRow = rk1.data.ranking.find(rr => rr.user_id === USER.id);
    if (adminRow && adminRow.puntos_totales === 30) {
      ok(`Ranking pre-publicación sigue con respuesta vieja (pts=30) ✓`);
    } else fail(`Ranking pre-publicación inesperado: ${JSON.stringify(adminRow)}`);
  }

  // 5.14 GET /mis-cambios-disponibles
  r = await http('GET', `/api/mundial/${torneoId}/mis-cambios-disponibles`);
  if (r.status === 200 && r.data.habilitado === true && r.data.cambios_usados === 1
      && r.data.cambios_restantes === 1 && r.data.preguntas_habilitables.length === 1) {
    ok(`GET mis-cambios-disponibles OK (usados=1, restantes=1, 1 pregunta elegible) ✓`);
  } else fail(`GET mis-cambios-disponibles inesperado: ${JSON.stringify(r.data)}`);

  // 5.15 POST /publicar — acción atómica
  r = await http('POST', `/api/mundial/${torneoId}/ventanas-cambios/${ventanaId}/publicar`);
  if (r.status === 200 && r.data.ventana?.estado === 'publicada' && r.data.publicados === 1) {
    ok(`POST publicar → 200 ventana='publicada' publicados=1 ✓`);
  } else fail(`POST publicar: ${r.status} ${JSON.stringify(r.data)}`);

  // 5.16 Verificar mundial_respuestas_usuario ahora con X2
  const dbV3 = new DatabaseSync(DB_PATH);
  try {
    const row = dbV3.prepare(
      'SELECT respuesta_json FROM mundial_respuestas_usuario WHERE pregunta_id=? AND user_id=?'
    ).get(ids.id9801, USER.id);
    if (row && JSON.parse(row.respuesta_json).equipo === 'X2') {
      ok(`mundial_respuestas_usuario.X1 → X2 (pisado por publicación) ✓`);
    } else fail(`respuesta_usuario post-publicación inesperada: ${row?.respuesta_json}`);
    const cambio = dbV3.prepare(
      'SELECT publicado FROM mundial_cambios_respuesta WHERE ventana_id=? AND user_id=? AND pregunta_id=?'
    ).get(ventanaId, USER.id, ids.id9801);
    if (cambio && cambio.publicado === 1) ok(`mundial_cambios_respuesta.publicado=1 ✓`);
    else fail(`cambios_respuesta.publicado post: ${cambio?.publicado}`);
  } finally { dbV3.close(); }

  // 5.17 Ranking post-publicación: admin ahora pts = 50 (9801 acierta) + 30 (9802) = 80
  const rk2 = await http('GET', `/api/mundial/${torneoId}/ranking`);
  if (rk2.status === 200) {
    const adminRow = rk2.data.ranking.find(rr => rr.user_id === USER.id);
    if (adminRow && adminRow.puntos_totales === 80) {
      ok(`Ranking post-publicación pts=80 (refleja respuesta nueva) ✓`);
    } else fail(`Ranking post inesperado: ${JSON.stringify(adminRow)}`);
  }

  // 5.18 PATCH sobre ventana publicada → 409
  r = await http('PATCH', `/api/mundial/${torneoId}/ventanas-cambios/${ventanaId}`, { estado: 'abierta' });
  if (r.status === 409) ok(`PATCH ventana publicada → 409 (irreversible) ✓`);
  else fail(`Esperaba 409, recibí ${r.status}`);

  return ventanaId;
}

// ── 6. Deshabilitar user con cambios cargados (escenario edge) ─────────────
async function testDeshabilitarConCambios(torneoId, ids) {
  console.log(H('6. Deshabilitar user con cambios cargados'));

  // Crear ventana nueva (la anterior está publicada).
  let r = await http('POST', `/api/mundial/${torneoId}/ventanas-cambios`, { cambios_por_usuario: 1 });
  if (r.status !== 201) { fail(`Crear ventana 2da: ${r.status}`); return; }
  const ventanaId = r.data.id;
  await http('PATCH', `/api/mundial/${torneoId}/ventanas-cambios/${ventanaId}`, { estado: 'abierta' });

  // Crear fake user, agregarlo a torneo_jugadores y habilitarlo.
  const db = new DatabaseSync(DB_PATH);
  let fakeId;
  try {
    db.prepare("INSERT OR IGNORE INTO users (email, password, nombre, role) VALUES (?, 'x', 'Fake F5', 'user')").run(DIAG_FAKE_EMAIL);
    fakeId = db.prepare('SELECT id FROM users WHERE email=?').get(DIAG_FAKE_EMAIL).id;
    DIAG_FAKE_USER_STATE.userId = fakeId;
    DIAG_FAKE_USER_STATE.created = true;
    db.prepare('INSERT OR IGNORE INTO torneo_jugadores (torneo_id, user_id) VALUES (?, ?)').run(torneoId, fakeId);
    // Respuesta inicial del fake
    db.prepare(`INSERT OR IGNORE INTO mundial_respuestas_usuario (pregunta_id, user_id, respuesta_json) VALUES (?, ?, ?)`)
      .run(ids.id9801, fakeId, JSON.stringify({ equipo: 'X1' }));
  } finally { db.close(); }
  info(`Fake user id=${fakeId} listo`);

  r = await http('POST', `/api/mundial/${torneoId}/ventanas-cambios/${ventanaId}/habilitados`, { user_id: fakeId });
  if (r.status !== 201) { fail(`Habilitar fake: ${r.status}`); return; }

  // Cargar un cambio "como fake user" — directo en DB porque no hay JWT del fake.
  const dbI = new DatabaseSync(DB_PATH);
  try {
    dbI.prepare(`INSERT INTO mundial_cambios_respuesta
      (ventana_id, torneo_id, user_id, pregunta_id, respuesta_anterior_json, respuesta_nueva_json, costo_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      ventanaId, torneoId, fakeId, ids.id9801,
      JSON.stringify({ equipo: 'X1' }), JSON.stringify({ equipo: 'X2' }), 25
    );
  } finally { dbI.close(); }
  info(`Cambio del fake cargado en DB`);

  // Deshabilitar fake
  r = await http('DELETE', `/api/mundial/${torneoId}/ventanas-cambios/${ventanaId}/habilitados/${fakeId}`);
  if (r.status === 200 && r.data.cambios_cargados_no_publicables === 1) {
    ok(`DELETE habilitado reporta cambios_cargados_no_publicables=1 ✓`);
  } else fail(`DELETE habilitado: ${r.status} ${JSON.stringify(r.data)}`);

  // Publicar la ventana — el cambio del fake NO debe publicarse
  r = await http('POST', `/api/mundial/${torneoId}/ventanas-cambios/${ventanaId}/publicar`);
  if (r.status === 200 && r.data.publicados === 0 && r.data.no_publicados === 1) {
    ok(`Publicar con fake deshabilitado: publicados=0, no_publicados=1 ✓`);
  } else fail(`Publicar inesperado: ${JSON.stringify(r.data)}`);

  // Verificar respuesta_usuario del fake sigue con X1 (no se pisó)
  const dbV = new DatabaseSync(DB_PATH);
  try {
    const row = dbV.prepare(
      'SELECT respuesta_json FROM mundial_respuestas_usuario WHERE pregunta_id=? AND user_id=?'
    ).get(ids.id9801, fakeId);
    if (row && JSON.parse(row.respuesta_json).equipo === 'X1') {
      ok(`Fake user mantiene respuesta original X1 (cambio no publicado) ✓`);
    } else fail(`Fake respuesta inesperada: ${row?.respuesta_json}`);
  } finally { dbV.close(); }
}

// ── Cleanup ────────────────────────────────────────────────────────────────
async function cleanup(torneoId) {
  console.log(H('7. Cleanup'));
  const db = new DatabaseSync(DB_PATH);
  try {
    if (DIAG_FAKE_USER_STATE.created && DIAG_FAKE_USER_STATE.userId) {
      const fid = DIAG_FAKE_USER_STATE.userId;
      db.prepare(`DELETE FROM mundial_cambios_respuesta WHERE user_id=?`).run(fid);
      db.prepare(`DELETE FROM mundial_ventana_habilitados WHERE user_id=?`).run(fid);
      db.prepare(`DELETE FROM mundial_respuestas_usuario WHERE user_id=?`).run(fid);
      db.prepare(`DELETE FROM torneo_jugadores WHERE user_id=?`).run(fid);
      db.prepare(`DELETE FROM users WHERE id=?`).run(fid);
      info(`Fake user borrado`);
    }
    if (torneoId) {
      db.prepare(`DELETE FROM mundial_cambios_respuesta WHERE torneo_id=?`).run(torneoId);
      db.prepare(`DELETE FROM mundial_ventana_habilitados WHERE ventana_id IN
        (SELECT id FROM mundial_ventanas_cambios WHERE torneo_id=?)`).run(torneoId);
      db.prepare(`DELETE FROM mundial_ventanas_cambios WHERE torneo_id=?`).run(torneoId);
      db.prepare(`DELETE FROM mundial_resultados WHERE pregunta_id IN
        (SELECT id FROM mundial_preguntas WHERE torneo_id=?)`).run(torneoId);
      db.prepare(`DELETE FROM mundial_respuestas_usuario WHERE pregunta_id IN
        (SELECT id FROM mundial_preguntas WHERE torneo_id=?)`).run(torneoId);
      db.prepare(`DELETE FROM mundial_preguntas WHERE torneo_id=?`).run(torneoId);
      db.prepare(`DELETE FROM mundial_equipos_catalogo WHERE torneo_id=?`).run(torneoId);
      db.prepare(`DELETE FROM mundial_config WHERE torneo_id=?`).run(torneoId);
      db.prepare(`DELETE FROM torneo_jugadores WHERE torneo_id=?`).run(torneoId);
      db.prepare(`DELETE FROM torneos WHERE id=?`).run(torneoId);
      info(`Torneo de diag borrado`);
    }
  } catch (e) { fail(`Cleanup falló: ${e.message}`); }
  finally { db.close(); }
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
    if (!TIENE_PERMISO) { warn(`Sin permiso: skipping HTTP tests`); return; }

    const ids = await setupContenido(torneoId);
    if (!ids) { exitCode = 1; return; }

    const ventanaId = await flujoCambios(torneoId, ids);
    if (!ventanaId) { exitCode = 1; return; }

    await testDeshabilitarConCambios(torneoId, ids);
  } catch (e) {
    fail(`Excepción: ${e.message}`);
    if (e.stack) console.error(e.stack);
  } finally {
    if (torneoId) await cleanup(torneoId);
    revokePermisoSiGrantedPorDiag();
    console.log('');
    if (exitCode === 0) console.log(c('━━━ Diagnóstico Fase 5 OK ━━━', '1;32'));
    else                console.log(c('━━━ Diagnóstico Fase 5 con ERRORES ━━━', '1;31'));
    process.exit(exitCode);
  }
})();
