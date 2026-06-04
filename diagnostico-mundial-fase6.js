#!/usr/bin/env node
/**
 * Diagnóstico Mundial — Fase 6 + 6.1 (Premios MVP + comida_rol)
 *
 * Cubre:
 *   1. Schema/DB: columnas de mundial_premios (incluye comida_rol Fase 6.1).
 *   2. Auth + grant temporal.
 *   3. Torneo de diag dedicado ('__DIAG_MUNDIAL_FASE6__').
 *   4. Setup mínimo: equipos sintéticos + preguntas + respuestas del admin.
 *   5. Cargar resultados + verificar ranking inicial.
 *   6. PUT /premios/bulk con preset Mundial 2026 (13 posiciones, con negativos
 *      + comida_rol: 1-5 gratis, 6-12 paga, 13 organiza).
 *   7. PUT /premios/bulk con posicion duplicada → 400.
 *   8. PUT /premios/bulk con usd no entero → 400.
 *   9. PUT /premios/bulk con comida_rol inválido → 400 (Fase 6.1).
 *  10. PUT /premios/bulk con comida_rol='' → 200 y se normaliza a null.
 *  11. GET /premios → devuelve filas ordenadas por posicion (con negativos)
 *      y comida_rol correcto por tramo.
 *  12. GET /premios-calculados:
 *        - usuario correcto por posición del ranking;
 *        - posiciones sin user en ranking → usuario:null;
 *        - estimado:true mientras estado != finalizado;
 *        - total_neto coherente con SUM(usd);
 *        - comida_rol por posición coherente con el preset.
 *  13. Forzar estado='finalizado' → PUT /premios/bulk → 409.
 *  14. GET /premios-calculados con estado='finalizado' → estimado:false.
 *  15. Cleanup en finally (incluye fake user de torneo_jugadores).
 *
 * Uso:
 *   cd backend
 *   DIAG_AUTO_GRANT=1 node diagnostico-mundial-fase6.js
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DIAG_EMAIL         = process.env.DIAG_EMAIL    || 'admin@prode.com';
const DIAG_PASSWORD      = process.env.DIAG_PASSWORD || 'admin123';
const API_BASE_URL       = process.env.API_BASE_URL  || 'http://localhost:3001';
const DB_PATH            = process.env.DB_PATH       || path.join(__dirname, 'prode.db');
const DIAG_AUTO_GRANT    = process.env.DIAG_AUTO_GRANT === '1';
const DIAG_TORNEO_NOMBRE = '__DIAG_MUNDIAL_FASE6__';

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
  const cols = db.prepare("PRAGMA table_info('mundial_premios')").all();
  const esperadas = ['torneo_id', 'posicion', 'usd', 'ars_manual', 'comida_rol'];
  for (const name of esperadas) {
    const col = cols.find(c => c.name === name);
    if (col) ok(`mundial_premios.${name} OK (type=${col.type})`);
    else fail(`Columna ${name} faltante en mundial_premios`);
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

// ── 3. Torneo de diag ──────────────────────────────────────────────────────
async function obtenerOCrearDiagTorneo() {
  console.log(H('3. Torneo de diag Fase 6'));
  const todos = await http('GET', '/api/torneos');
  if (todos.status !== 200) { fail(`No pude listar torneos`); return null; }
  const existente = (todos.data || []).find(t => t.nombre === DIAG_TORNEO_NOMBRE);
  if (existente) {
    info(`Reusando torneo id=${existente.id}`);
    return existente;
  }
  const created = await http('POST', '/api/torneos', {
    nombre: DIAG_TORNEO_NOMBRE, semestre: '2026-DIAG-F6', tipo: 'mundial_preguntas',
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

// ── 4. Setup mínimo (equipos + preguntas + respuestas admin + resultados) ─
const EQUIPOS_DIAG = [
  { codigo: 'X1', nombre: 'X One', emoji: '🅰️', grupo: 'A', confederacion: 'UEFA' },
  { codigo: 'X2', nombre: 'X Two', emoji: '🅱️', grupo: 'A', confederacion: 'CONMEBOL' },
];

const PREGUNTAS_DIAG = [
  { numero: 9901, enunciado: 'P6a', tipo_pregunta: 'opcion_unica',
    config_json: { opciones: ['Sí', 'No'], pts: 50 } },
  { numero: 9902, enunciado: 'P6b', tipo_pregunta: 'equipo_categoria',
    config_json: { categorias: [{ label: 'default', pts: 100, default: true }] } },
];

async function setupContenido(torneoId) {
  console.log(H('4. Setup contenido + resultados'));
  setEstado(torneoId, 'configuracion');

  // Equipos
  const db = new DatabaseSync(DB_PATH);
  try { db.prepare('DELETE FROM mundial_equipos_catalogo WHERE torneo_id=?').run(torneoId); }
  finally { db.close(); }
  for (const e of EQUIPOS_DIAG) {
    const r = await http('POST', `/api/mundial/${torneoId}/equipos`, e);
    if (r.status !== 201) { fail(`POST equipo ${e.codigo}: ${r.status}`); return null; }
  }

  // Preguntas (limpiar + crear)
  const db2 = new DatabaseSync(DB_PATH);
  try {
    db2.prepare(`DELETE FROM mundial_resultados WHERE pregunta_id IN
      (SELECT id FROM mundial_preguntas WHERE torneo_id=? AND numero BETWEEN 9900 AND 9999)`).run(torneoId);
    db2.prepare(`DELETE FROM mundial_respuestas_usuario WHERE pregunta_id IN
      (SELECT id FROM mundial_preguntas WHERE torneo_id=? AND numero BETWEEN 9900 AND 9999)`).run(torneoId);
    db2.prepare(`DELETE FROM mundial_preguntas WHERE torneo_id=? AND numero BETWEEN 9900 AND 9999`).run(torneoId);
    // Limpiar premios previos del torneo
    db2.prepare('DELETE FROM mundial_premios WHERE torneo_id=?').run(torneoId);
  } finally { db2.close(); }

  for (const p of PREGUNTAS_DIAG) {
    const r = await http('POST', `/api/mundial/${torneoId}/preguntas`, p);
    if (r.status !== 201) { fail(`POST pregunta ${p.numero}: ${r.status} ${JSON.stringify(r.data)}`); return null; }
  }
  ok(`Contenido base OK`);

  // Respuestas del admin (estado='abierto') — admin acertará todo
  setEstado(torneoId, 'abierto');
  const preg = await http('GET', `/api/mundial/${torneoId}/preguntas?activa=1`);
  const byNum = new Map(preg.data.map(p => [p.numero, p.id]));
  const respArr = [
    { pregunta_id: byNum.get(9901), respuesta_json: { opcion: 'Sí' } },
    { pregunta_id: byNum.get(9902), respuesta_json: { equipo: 'X1' } },
  ];
  const rResp = await http('PUT', `/api/mundial/${torneoId}/mis-respuestas`, { respuestas: respArr });
  if (rResp.status !== 200) { fail(`PUT respuestas admin: ${rResp.status}`); return null; }

  // Forzar grupos_jugados y cargar resultados — admin acierta ambos → 150 pts
  setEstado(torneoId, 'grupos_jugados');
  await http('POST', `/api/mundial/${torneoId}/resultados/${byNum.get(9901)}`, {
    resultado_json: { opcion: 'Sí' },
  });
  await http('POST', `/api/mundial/${torneoId}/resultados/${byNum.get(9902)}`, {
    resultado_json: { equipo: 'X1' },
  });
  info(`Resultados cargados — admin acierta ambos (50+100=150)`);

  // Verificar ranking
  const rk = await http('GET', `/api/mundial/${torneoId}/ranking`);
  if (rk.status === 200 && rk.data.visible) {
    const adminRow = rk.data.ranking.find(r => r.user_id === USER.id);
    if (adminRow && adminRow.puntos_totales === 150 && adminRow.posicion === 1) {
      ok(`Ranking inicial: admin posición 1, 150 pts ✓`);
    } else fail(`Ranking inesperado: ${JSON.stringify(adminRow)}`);
  } else fail(`GET ranking inicial: ${rk.status}`);

  return byNum;
}

// ── 5. Preset Mundial 2026 + casos 4xx + GET ──────────────────────────────
// Fase 6.1: comida_rol viaja en el mismo bulk.
//   1..5  → 'gratis'   (los 5 primeros comen)
//   6..12 → 'paga'     (medio paga)
//   13    → 'organiza' (último organiza)
const PRESET_MUNDIAL_2026 = [
  { posicion: 1,  usd: 200, comida_rol: 'gratis'   },
  { posicion: 2,  usd: 50,  comida_rol: 'gratis'   },
  { posicion: 3,  usd: 25,  comida_rol: 'gratis'   },
  { posicion: 4,  usd: -5,  comida_rol: 'gratis'   },
  { posicion: 5,  usd: -10, comida_rol: 'gratis'   },
  { posicion: 6,  usd: -15, comida_rol: 'paga'     },
  { posicion: 7,  usd: -20, comida_rol: 'paga'     },
  { posicion: 8,  usd: -25, comida_rol: 'paga'     },
  { posicion: 9,  usd: -30, comida_rol: 'paga'     },
  { posicion: 10, usd: -35, comida_rol: 'paga'     },
  { posicion: 11, usd: -40, comida_rol: 'paga'     },
  { posicion: 12, usd: -45, comida_rol: 'paga'     },
  { posicion: 13, usd: -50, comida_rol: 'organiza' },
];
const NETO_PRESET = PRESET_MUNDIAL_2026.reduce((a, p) => a + p.usd, 0); // 200+50+25 - (5+10+15+20+25+30+35+40+45+50) = 275 - 275 = 0

async function testPremiosCrud(torneoId) {
  console.log(H('5. CRUD + casos 4xx'));

  // 5.1 PUT preset OK
  let r = await http('PUT', `/api/mundial/${torneoId}/premios/bulk`, { premios: PRESET_MUNDIAL_2026 });
  if (r.status === 200) ok(`PUT preset Mundial 2026 (13 filas con negativos) → 200 ✓`);
  else { fail(`PUT preset: ${r.status} ${JSON.stringify(r.data)}`); return false; }

  // 5.2 PUT con posicion duplicada → 400
  r = await http('PUT', `/api/mundial/${torneoId}/premios/bulk`, {
    premios: [{ posicion: 1, usd: 100 }, { posicion: 1, usd: 200 }],
  });
  if (r.status === 400 && /duplicada/i.test(String(r.data?.error || ''))) {
    ok(`PUT posicion duplicada → 400 ✓`);
  } else fail(`Esperaba 400 dup, recibí ${r.status}: ${JSON.stringify(r.data)}`);

  // 5.3 PUT con usd no entero → 400
  r = await http('PUT', `/api/mundial/${torneoId}/premios/bulk`, {
    premios: [{ posicion: 1, usd: 1.5 }],
  });
  if (r.status === 400) ok(`PUT usd no entero → 400 ✓`);
  else fail(`Esperaba 400, recibí ${r.status}`);

  // 5.4 PUT con posicion no entero positivo → 400
  r = await http('PUT', `/api/mundial/${torneoId}/premios/bulk`, {
    premios: [{ posicion: 0, usd: 100 }],
  });
  if (r.status === 400) ok(`PUT posicion 0 → 400 ✓`);
  else fail(`Esperaba 400 pos<=0, recibí ${r.status}`);

  // 5.4b PUT con comida_rol inválido → 400 (Fase 6.1)
  r = await http('PUT', `/api/mundial/${torneoId}/premios/bulk`, {
    premios: [{ posicion: 1, usd: 100, comida_rol: 'medio_pelo' }],
  });
  if (r.status === 400 && /comida_rol/i.test(String(r.data?.error || ''))) {
    ok(`PUT comida_rol inválido → 400 ✓`);
  } else fail(`Esperaba 400 comida_rol inválido, recibí ${r.status}: ${JSON.stringify(r.data)}`);

  // 5.4c PUT con comida_rol = '' (vacío) → 200, se normaliza a null
  r = await http('PUT', `/api/mundial/${torneoId}/premios/bulk`, {
    premios: [{ posicion: 1, usd: 200, comida_rol: '' }],
  });
  if (r.status === 200) {
    const fila = r.data.find(p => p.posicion === 1);
    if (fila && (fila.comida_rol === null || fila.comida_rol === undefined)) {
      ok(`PUT comida_rol='' se normaliza a null ✓`);
    } else fail(`comida_rol='' debería normalizarse a null, recibí: ${JSON.stringify(fila)}`);
  } else fail(`Esperaba 200 con comida_rol='', recibí ${r.status}`);

  // Reaplicar el preset completo después de los tests de validación
  r = await http('PUT', `/api/mundial/${torneoId}/premios/bulk`, { premios: PRESET_MUNDIAL_2026 });
  if (r.status !== 200) { fail(`Re-aplicar preset falló: ${r.status}`); return false; }

  // 5.5 GET premios — verifica filas presentes, ordenadas, con negativos y comida_rol
  r = await http('GET', `/api/mundial/${torneoId}/premios`);
  if (r.status === 200 && Array.isArray(r.data) && r.data.length === 13) {
    const ordenadas = r.data.every((p, i) => p.posicion === i + 1);
    const conNegativos = r.data.some(p => p.usd < 0);
    if (ordenadas && conNegativos) {
      ok(`GET premios → 13 filas ordenadas con negativos ✓`);
    } else fail(`GET premios: orden o negativos inesperado: ${JSON.stringify(r.data)}`);

    // Fase 6.1: comida_rol presente y consistente con el preset
    const gratis    = r.data.filter(p => p.comida_rol === 'gratis').map(p => p.posicion);
    const paga      = r.data.filter(p => p.comida_rol === 'paga').map(p => p.posicion);
    const organiza  = r.data.filter(p => p.comida_rol === 'organiza').map(p => p.posicion);
    const okGratis   = JSON.stringify(gratis)   === JSON.stringify([1, 2, 3, 4, 5]);
    const okPaga     = JSON.stringify(paga)     === JSON.stringify([6, 7, 8, 9, 10, 11, 12]);
    const okOrganiza = JSON.stringify(organiza) === JSON.stringify([13]);
    if (okGratis && okPaga && okOrganiza) {
      ok(`GET premios → comida_rol correcto (gratis=1-5, paga=6-12, organiza=13) ✓`);
    } else fail(`comida_rol inesperado: gratis=${gratis} paga=${paga} organiza=${organiza}`);
  } else fail(`GET premios: status=${r.status} length=${r.data?.length}`);

  return true;
}

// ── 6. Premios calculados ──────────────────────────────────────────────────
async function testPremiosCalculados(torneoId) {
  console.log(H('6. Premios calculados (cruce con ranking)'));
  const r = await http('GET', `/api/mundial/${torneoId}/premios-calculados`);
  if (r.status !== 200) { fail(`GET premios-calculados: ${r.status}`); return false; }

  const d = r.data;
  // Verificar estructura
  if (!Array.isArray(d.premios) || d.premios.length !== 13) {
    fail(`Esperaba 13 premios, recibí ${d.premios?.length}`);
    return false;
  }
  if (d.configurado !== true) fail(`configurado debería ser true`);
  if (d.estimado !== true)    fail(`estimado debería ser true (estado != finalizado)`);

  // total_neto = SUM(usd) del preset = 0
  if (d.total_neto === NETO_PRESET) ok(`total_neto=${d.total_neto} coherente con SUM(usd) ✓`);
  else fail(`total_neto ${d.total_neto} != esperado ${NETO_PRESET}`);

  // Posición 1 debería ser el admin (único user con respuestas + acierto)
  const pos1 = d.premios.find(p => p.posicion === 1);
  if (pos1 && pos1.usuario?.user_id === USER.id && pos1.usd === 200) {
    ok(`Posición 1: admin (id=${USER.id}) gana +200 USD ✓`);
  } else fail(`Posición 1 inesperada: ${JSON.stringify(pos1)}`);

  // Posiciones 2-13: usuario:null porque solo hay 1 user en el ranking
  const sinUser = d.premios.filter(p => p.posicion > 1 && p.usuario === null);
  if (sinUser.length === 12) ok(`Posiciones 2-13 con usuario:null (no hay más users en ranking) ✓`);
  else fail(`Esperaba 12 posiciones sin usuario, recibí ${sinUser.length}`);

  // Fase 6.1: comida_rol también viaja en /premios-calculados
  if (pos1?.comida_rol === 'gratis') ok(`Posición 1: comida_rol='gratis' ✓`);
  else fail(`Posición 1 esperaba comida_rol='gratis', recibí ${pos1?.comida_rol}`);
  const pos13 = d.premios.find(p => p.posicion === 13);
  if (pos13?.comida_rol === 'organiza') ok(`Posición 13: comida_rol='organiza' ✓`);
  else fail(`Posición 13 esperaba comida_rol='organiza', recibí ${pos13?.comida_rol}`);
  const pos8 = d.premios.find(p => p.posicion === 8);
  if (pos8?.comida_rol === 'paga') ok(`Posición 8: comida_rol='paga' ✓`);
  else fail(`Posición 8 esperaba comida_rol='paga', recibí ${pos8?.comida_rol}`);

  return true;
}

// ── 7. Estado finalizado ──────────────────────────────────────────────────
async function testFinalizado(torneoId) {
  console.log(H('7. Finalizado bloquea edición'));

  // Forzar finalizado vía DB (bypass forward-only)
  setEstado(torneoId, 'finalizado');
  info(`Estado forzado a 'finalizado'`);

  // PUT premios/bulk → 409
  let r = await http('PUT', `/api/mundial/${torneoId}/premios/bulk`, {
    premios: [{ posicion: 1, usd: 999 }],
  });
  if (r.status === 409) ok(`PUT premios/bulk con torneo finalizado → 409 ✓`);
  else fail(`Esperaba 409, recibí ${r.status}: ${JSON.stringify(r.data)}`);

  // GET premios-calculados → estimado:false
  r = await http('GET', `/api/mundial/${torneoId}/premios-calculados`);
  if (r.status === 200 && r.data.estimado === false && r.data.estado === 'finalizado') {
    ok(`GET premios-calculados con estado=finalizado → estimado:false ✓`);
  } else fail(`Esperaba estimado:false, recibí ${JSON.stringify({ estimado: r.data?.estimado, estado: r.data?.estado })}`);
}

// ── Cleanup ────────────────────────────────────────────────────────────────
async function cleanup(torneoId) {
  console.log(H('8. Cleanup'));
  const db = new DatabaseSync(DB_PATH);
  try {
    if (torneoId) {
      db.prepare('DELETE FROM mundial_premios WHERE torneo_id=?').run(torneoId);
      db.prepare(`DELETE FROM mundial_resultados WHERE pregunta_id IN
        (SELECT id FROM mundial_preguntas WHERE torneo_id=?)`).run(torneoId);
      db.prepare(`DELETE FROM mundial_respuestas_usuario WHERE pregunta_id IN
        (SELECT id FROM mundial_preguntas WHERE torneo_id=?)`).run(torneoId);
      db.prepare('DELETE FROM mundial_preguntas WHERE torneo_id=?').run(torneoId);
      db.prepare('DELETE FROM mundial_equipos_catalogo WHERE torneo_id=?').run(torneoId);
      db.prepare('DELETE FROM mundial_config WHERE torneo_id=?').run(torneoId);
      db.prepare('DELETE FROM torneo_jugadores WHERE torneo_id=?').run(torneoId);
      db.prepare('DELETE FROM torneos WHERE id=?').run(torneoId);
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
    if (!TIENE_PERMISO) { warn(`Sin permiso: skipping HTTP admin tests`); return; }

    const byNum = await setupContenido(torneoId);
    if (!byNum) { exitCode = 1; return; }

    if (!(await testPremiosCrud(torneoId))) return;
    if (!(await testPremiosCalculados(torneoId))) return;
    await testFinalizado(torneoId);
  } catch (e) {
    fail(`Excepción: ${e.message}`);
    if (e.stack) console.error(e.stack);
  } finally {
    if (torneoId) await cleanup(torneoId);
    revokePermisoSiGrantedPorDiag();
    console.log('');
    if (exitCode === 0) console.log(c('━━━ Diagnóstico Fase 6 OK ━━━', '1;32'));
    else                console.log(c('━━━ Diagnóstico Fase 6 con ERRORES ━━━', '1;31'));
    process.exit(exitCode);
  }
})();
