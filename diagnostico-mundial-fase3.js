#!/usr/bin/env node
/**
 * Diagnóstico Mundial — Fase 3
 *
 * Cubre scoring + ranking + mis-puntos. Estrategia:
 *
 *   1. Schema/DB: tabla mundial_resultados existe con columnas esperadas.
 *   2. Auth real + auto-grant opcional.
 *   3. Torneo de diag dedicado a Fase 3 ('__DIAG_MUNDIAL_FASE3__'), separado de
 *      Fase 1/2 y del torneo real.
 *   4. Setup: catálogo de 4 equipos sintéticos + 8 preguntas (1 por cada tipo)
 *      + respuestas del admin user.
 *   5. Unit-level: testear `calcularPuntosPregunta` import directo, con fixtures
 *      por tipo (acierta, no acierta, parcial, override).
 *   6. HTTP:
 *      - POST resultado con estado < grupos_jugados → 409.
 *      - Forzar estado='grupos_jugados' via DB.
 *      - POST resultado por cada pregunta (200).
 *      - POST resultado con shape inválido → 400.
 *      - POST resultado con equipo no en catálogo → 400.
 *      - GET resultados → lista.
 *      - DELETE resultado → 200 + 404 al re-borrar.
 *      - GET ranking visible: true, con el admin posición 1.
 *      - GET mis-puntos: detalle por pregunta del admin con pts calculado.
 *   7. Idempotencia: correr ranking 2 veces → mismo output.
 *   8. Multi-usuario: insertar 1 user fake via DB con respuestas distintas,
 *      verificar orden ranking + posiciones + empate.
 *   9. Cleanup en finally: borra el torneo de diag + user fake + respuestas.
 *
 * Reutiliza patrones de diagnostico-mundial-fase2.js (auth, http, AUTO_GRANT).
 *
 * Uso típico:
 *   cd backend
 *   DIAG_AUTO_GRANT=1 node diagnostico-mundial-fase3.js
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DIAG_EMAIL         = process.env.DIAG_EMAIL    || 'admin@prode.com';
const DIAG_PASSWORD      = process.env.DIAG_PASSWORD || 'admin123';
const API_BASE_URL       = process.env.API_BASE_URL  || 'http://localhost:3001';
const DB_PATH            = process.env.DB_PATH       || path.join(__dirname, 'prode.db');
const DIAG_AUTO_GRANT    = process.env.DIAG_AUTO_GRANT === '1';
const DIAG_TORNEO_NOMBRE = '__DIAG_MUNDIAL_FASE3__';
const DIAG_FAKE_EMAIL    = '__diag_fase3_user2@local.test';

// Estado de grant temporal
const DIAG_GRANT_STATE = { granted: false };
// Estado para cleanup del user fake en finally
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
  catch (e) {
    fail(`No pude abrir la DB en ${DB_PATH}: ${e.message}`);
    process.exit(1);
  }
  const cols = db.prepare("PRAGMA table_info('mundial_resultados')").all();
  const esperadas = ['pregunta_id', 'resultado_json', 'cargado_por', 'cargado_at'];
  for (const name of esperadas) {
    const col = cols.find(c => c.name === name);
    if (col) ok(`mundial_resultados.${name} OK (type=${col.type})`);
    else fail(`Columna ${name} faltante en mundial_resultados`);
  }
  db.close();
}

// ── Auto-grant ─────────────────────────────────────────────────────────────
function maybeGrantPermisoForDiag() {
  if (!DIAG_AUTO_GRANT) return;
  const db = new DatabaseSync(DB_PATH);
  try {
    const user = db.prepare('SELECT id, email, role FROM users WHERE email = ?').get(DIAG_EMAIL);
    if (!user) { warn(`DIAG_AUTO_GRANT: ${DIAG_EMAIL} no existe. Continuando.`); return; }
    if (user.role === 'superadmin') { info(`DIAG_AUTO_GRANT: superadmin → no se necesita grant`); return; }
    const existente = db.prepare("SELECT 1 FROM user_permisos WHERE user_id = ? AND permiso = 'gestionar_mundial' LIMIT 1").get(user.id);
    if (existente) { info(`DIAG_AUTO_GRANT: ya tenía permiso, no asigno ni revoco`); return; }
    db.prepare("INSERT INTO user_permisos (user_id, permiso) VALUES (?, 'gestionar_mundial')").run(user.id);
    DIAG_GRANT_STATE.granted = true;
    warn(`DIAG_AUTO_GRANT: 'gestionar_mundial' asignado TEMPORALMENTE a ${DIAG_EMAIL}`);
  } catch (e) { fail(`DIAG_AUTO_GRANT falló: ${e.message}`); }
  finally { db.close(); }
}
function revokePermisoSiGrantedPorDiag() {
  if (!DIAG_GRANT_STATE.granted) return;
  const db = new DatabaseSync(DB_PATH);
  try {
    const user = db.prepare('SELECT id FROM users WHERE email = ?').get(DIAG_EMAIL);
    if (user) {
      db.prepare("DELETE FROM user_permisos WHERE user_id = ? AND permiso = 'gestionar_mundial'").run(user.id);
      info(`DIAG_AUTO_GRANT: permiso revocado`);
    }
  } catch (e) { fail(`Revoke falló: ${e.message}`); }
  finally { db.close(); }
}

// ── 2. Auth ────────────────────────────────────────────────────────────────
let TIENE_PERMISO_MUNDIAL = false;
async function authCheck() {
  console.log(H('2. Auth'));
  const r = await http('POST', '/api/auth/login', { email: DIAG_EMAIL, password: DIAG_PASSWORD });
  if (r.status === 0) { fail(`No pude conectar al backend: ${r.error}`); process.exit(1); }
  if (r.status !== 200 || !r.data?.token) { fail(`Login falló (status ${r.status})`); process.exit(1); }
  TOKEN = r.data.token; USER = r.data.user;
  ok(`Login OK — id=${USER.id} role=${USER.role}`);
  const perms = await http('GET', '/api/permisos/me');
  if (perms.status === 200) {
    TIENE_PERMISO_MUNDIAL = perms.data?.permisos?.includes('gestionar_mundial') || USER.role === 'superadmin';
    if (TIENE_PERMISO_MUNDIAL) ok(`Tiene 'gestionar_mundial'`);
    else warn(`Sin permiso 'gestionar_mundial'. Tests admin van a fallar/skipear.`);
  }
}

// ── 3. Torneo de diag ──────────────────────────────────────────────────────
async function obtenerOCrearDiagTorneo() {
  console.log(H('3. Torneo de diag Fase 3'));
  const todos = await http('GET', '/api/torneos');
  if (todos.status !== 200) { fail(`No pude listar torneos`); return null; }
  const existente = (todos.data || []).find(t => t.nombre === DIAG_TORNEO_NOMBRE);
  if (existente) {
    info(`Reusando torneo id=${existente.id}`);
    if (existente.tipo !== 'mundial_preguntas') {
      fail(`Torneo de diag tiene tipo='${existente.tipo}'. Borralo a mano para regenerar.`);
      return null;
    }
    return existente;
  }
  const created = await http('POST', '/api/torneos', {
    nombre: DIAG_TORNEO_NOMBRE,
    semestre: '2026-DIAG-F3',
    tipo: 'mundial_preguntas',
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

// ── 4. Setup catálogo + preguntas + respuestas admin ──────────────────────
// Catálogo mínimo: 4 equipos en 2 grupos (A,B), 2 confederaciones (UEFA, CONMEBOL).
const EQUIPOS_DIAG = [
  { codigo: 'X1', nombre: 'X One',  emoji: '🅰️', grupo: 'A', confederacion: 'UEFA' },
  { codigo: 'X2', nombre: 'X Two',  emoji: '🅱️', grupo: 'A', confederacion: 'CONMEBOL' },
  { codigo: 'Y1', nombre: 'Y One',  emoji: '🆎', grupo: 'B', confederacion: 'UEFA' },
  { codigo: 'Y2', nombre: 'Y Two',  emoji: '🆑', grupo: 'B', confederacion: 'CONMEBOL' },
];

// 1 pregunta por cada tipo. Numero arbitrario en rango 9700-9799 para no chocar.
const PREGUNTAS_DIAG = [
  { numero: 9701, enunciado: 'OU', tipo_pregunta: 'opcion_unica',
    config_json: { opciones: ['Sí', 'No'], pts_por_opcion: { 'Sí': 15, 'No': 10 } } },
  { numero: 9702, enunciado: 'EC', tipo_pregunta: 'equipo_categoria',
    config_json: { categorias: [
      { label: 'favorito', equipos: ['X1'], pts: 50 },
      { label: 'otro', pts: 100, default: true },
    ] } },
  { numero: 9703, enunciado: 'IE', tipo_pregunta: 'instancia_eliminacion',
    config_json: { equipo: 'X1', instancias: ['Grupos','16°','8°'], pts_por_instancia: { 'Grupos': 50, '16°': 40, '8°': 30 } } },
  { numero: 9704, enunciado: 'NE', tipo_pregunta: 'numero_exacto',
    config_json: { pts_si_acierta: 10, pts_si_no_acierta: 0 } },
  { numero: 9705, enunciado: 'NB', tipo_pregunta: 'numero_por_banda',
    config_json: { bandas: [{ min: 0, max: 2, pts: 10 }, { min: 3, pts: 25 }] } },
  { numero: 9706, enunciado: 'ME', tipo_pregunta: 'multi_equipo',
    config_json: { n_equipos: 2, pts_por_acierto: 10 } },
  { numero: 9707, enunciado: 'RM', tipo_pregunta: 'respuesta_manual',
    config_json: { pts_max: 75, instrucciones: 'Nombre jugador' } },
  { numero: 9708, enunciado: 'RE', tipo_pregunta: 'regla_especial',
    // regla_especial es escape-hatch: el validador-config exige `scoring_manual: true`
    // y `descripcion: string` (ver backend/src/logic/mundial-validar-config.js §validarReglaEspecial).
    config_json: { scoring_manual: true, pts_max: 50, descripcion: 'Texto libre' } },
];

// Respuestas del admin user — diseñadas para puntajes determinísticos.
// Resultados reales (definidos abajo). Suma del admin: 15+50+40+10+25+10+75+0 = 225
const RESPUESTAS_ADMIN = {
  9701: { opcion: 'Sí' },           // acierta → 15 (pts_por_opcion['Sí'])
  9702: { equipo: 'X1' },           // acierta, X1 está en categoría 'favorito' → 50
  9703: { instancia: '16°' },       // acierta → pts_por_instancia['16°'] = 40
  9704: { numero: 7 },              // acierta → pts_si_acierta = 10
  9705: { numero: 4 },              // exacto al resultado=4 (cae en banda 3+) → 25
  9706: { equipos: ['X1', 'Y1'] },  // resultado X1+X2; 1 acierto × 10 = 10
  9707: { texto: 'mbappe' },        // resultado 'Mbappé' → normalizado iguales → 75
  9708: { texto: 'no match' },      // resultado 'algo distinto' → 0
};

const RESULTADOS_REALES = {
  9701: { opcion: 'Sí' },
  9702: { equipo: 'X1' },
  9703: { instancia: '16°' },
  9704: { numero: 7 },
  9705: { numero: 4 },
  9706: { equipos: ['X1', 'X2'] },
  9707: { texto: 'Mbappé' },
  9708: { texto: 'algo distinto' },
};

// Tabla esperada de pts del admin por pregunta (mismo orden que PREGUNTAS_DIAG)
const PTS_ESPERADOS_ADMIN = {
  9701: 15, 9702: 50, 9703: 40, 9704: 10,
  9705: 25, 9706: 10, 9707: 75, 9708: 0,
};
const PTS_TOTAL_ADMIN = Object.values(PTS_ESPERADOS_ADMIN).reduce((a, b) => a + b, 0); // 225

async function setupContenido(torneoId) {
  console.log(H('4. Setup contenido (equipos + preguntas + respuestas admin)'));

  setEstado(torneoId, 'configuracion');

  // Equipos: limpiar lo que haya y crear los 4 del diag
  const db = new DatabaseSync(DB_PATH);
  try {
    db.prepare('DELETE FROM mundial_equipos_catalogo WHERE torneo_id = ?').run(torneoId);
  } finally { db.close(); }

  for (const e of EQUIPOS_DIAG) {
    const r = await http('POST', `/api/mundial/${torneoId}/equipos`, e);
    if (r.status !== 201) { fail(`POST equipo ${e.codigo}: ${r.status} ${JSON.stringify(r.data)}`); return false; }
  }
  ok(`4 equipos cargados (X1/X2 Grupo A, Y1/Y2 Grupo B)`);

  // Preguntas: borrar las del rango 9700-9799 + crear las 8 del diag
  const db2 = new DatabaseSync(DB_PATH);
  try {
    db2.prepare(`DELETE FROM mundial_resultados WHERE pregunta_id IN
      (SELECT id FROM mundial_preguntas WHERE torneo_id=? AND numero BETWEEN 9700 AND 9799)`).run(torneoId);
    db2.prepare(`DELETE FROM mundial_respuestas_usuario WHERE pregunta_id IN
      (SELECT id FROM mundial_preguntas WHERE torneo_id=? AND numero BETWEEN 9700 AND 9799)`).run(torneoId);
    db2.prepare(`DELETE FROM mundial_preguntas WHERE torneo_id=? AND numero BETWEEN 9700 AND 9799`).run(torneoId);
  } finally { db2.close(); }

  for (const p of PREGUNTAS_DIAG) {
    const r = await http('POST', `/api/mundial/${torneoId}/preguntas`, p);
    if (r.status !== 201) { fail(`POST pregunta ${p.numero}: ${r.status} ${JSON.stringify(r.data)}`); return false; }
  }
  ok(`8 preguntas creadas (1 por tipo)`);

  // Cargar respuestas del admin (necesita estado='abierto')
  setEstado(torneoId, 'abierto');
  const preguntas = await http('GET', `/api/mundial/${torneoId}/preguntas?activa=1`);
  if (preguntas.status !== 200) { fail(`GET preguntas: ${preguntas.status}`); return false; }
  const byNum = new Map(preguntas.data.map(p => [p.numero, p.id]));
  const respArr = Object.entries(RESPUESTAS_ADMIN).map(([num, r]) => ({
    pregunta_id: byNum.get(parseInt(num, 10)),
    respuesta_json: r,
  }));
  const r = await http('PUT', `/api/mundial/${torneoId}/mis-respuestas`, { respuestas: respArr });
  if (r.status !== 200) { fail(`PUT respuestas admin: ${r.status} ${JSON.stringify(r.data)}`); return false; }
  ok(`Respuestas admin cargadas (${respArr.length})`);

  return byNum;
}

// ── 5. Unit-level scoring (import directo) ─────────────────────────────────
function unitTestScoring() {
  console.log(H('5. Unit tests calcularPuntosPregunta (sin HTTP)'));
  const { calcularPuntosPregunta, normalizarTexto } = require('./src/logic/mundial-scoring');

  const fixtures = [
    // [label, tipo, config, resultado, respuesta, userId, esperado]
    ['OU acierta pts_por_opcion', 'opcion_unica', { opciones: ['Sí','No'], pts_por_opcion: { 'Sí': 15, 'No': 10 } }, { opcion: 'Sí' }, { opcion: 'Sí' }, 1, 15],
    ['OU no acierta', 'opcion_unica', { opciones: ['Sí','No'], pts: 15 }, { opcion: 'Sí' }, { opcion: 'No' }, 1, 0],
    ['OU pts uniforme', 'opcion_unica', { opciones: ['A','B'], pts: 20 }, { opcion: 'A' }, { opcion: 'A' }, 1, 20],
    ['EC acierta categoría con equipos', 'equipo_categoria',
      { categorias: [{ label: 't', equipos: ['BRA','ARG'], pts: 50 }, { label: 'o', pts: 100, default: true }] },
      { equipo: 'BRA' }, { equipo: 'BRA' }, 1, 50],
    ['EC acierta categoría default', 'equipo_categoria',
      { categorias: [{ label: 't', equipos: ['BRA'], pts: 50 }, { label: 'o', pts: 100, default: true }] },
      { equipo: 'ARG' }, { equipo: 'ARG' }, 1, 100],
    ['EC no acierta', 'equipo_categoria',
      { categorias: [{ label: 'o', pts: 100, default: true }] },
      { equipo: 'BRA' }, { equipo: 'ARG' }, 1, 0],
    ['IE acierta', 'instancia_eliminacion',
      { equipo: 'BRA', instancias: ['Grupos','16°'], pts_por_instancia: { 'Grupos': 50, '16°': 40 } },
      { instancia: '16°' }, { instancia: '16°' }, 1, 40],
    ['IE no acierta', 'instancia_eliminacion',
      { equipo: 'BRA', instancias: ['Grupos','16°'], pts_por_instancia: { 'Grupos': 50, '16°': 40 } },
      { instancia: 'Grupos' }, { instancia: '16°' }, 1, 0],
    ['NE acierta', 'numero_exacto', { pts_si_acierta: 10, pts_si_no_acierta: 0 }, { numero: 3 }, { numero: 3 }, 1, 10],
    ['NE no acierta', 'numero_exacto', { pts_si_acierta: 10, pts_si_no_acierta: 0 }, { numero: 3 }, { numero: 5 }, 1, 0],
    ['NE no acierta con pts default', 'numero_exacto', { pts_si_acierta: 10, pts_si_no_acierta: 3 }, { numero: 3 }, { numero: 5 }, 1, 3],
    // numero_por_banda — Regla 2026-06-21: EXACTO + pts de la banda donde
    // cae el valor real. Ya no paga por "misma banda".
    ['NB exacto banda alta', 'numero_por_banda',
      { bandas: [{ min: 0, max: 2, pts: 10 }, { min: 3, pts: 25 }] },
      { numero: 4 }, { numero: 4 }, 1, 25],
    ['NB exacto banda baja', 'numero_por_banda',
      { bandas: [{ min: 0, max: 2, pts: 10 }, { min: 3, pts: 25 }] },
      { numero: 2 }, { numero: 2 }, 1, 10],
    ['NB misma banda sin exacto → 0', 'numero_por_banda',
      { bandas: [{ min: 0, max: 2, pts: 10 }, { min: 3, pts: 25 }] },
      { numero: 4 }, { numero: 7 }, 1, 0],
    ['NB banda distinta → 0', 'numero_por_banda',
      { bandas: [{ min: 0, max: 2, pts: 10 }, { min: 3, pts: 25 }] },
      { numero: 1 }, { numero: 5 }, 1, 0],
    ['ME 1 acierto de 2', 'multi_equipo',
      { n_equipos: 2, pts_por_acierto: 10 },
      { equipos: ['X1','X2'] }, { equipos: ['X1','Y1'] }, 1, 10],
    ['ME 2 aciertos', 'multi_equipo',
      { n_equipos: 2, pts_por_acierto: 10 },
      { equipos: ['X1','X2'] }, { equipos: ['X2','X1'] }, 1, 20],
    ['ME 0 aciertos parcial', 'multi_equipo',
      { n_equipos: 2, pts_por_acierto: 10 },
      { equipos: ['X1','X2'] }, { equipos: ['Y1'] }, 1, 0],
    ['RM match normalizado (sin tildes)', 'respuesta_manual',
      { pts_max: 75 }, { texto: 'Mbappé' }, { texto: 'mbappe' }, 1, 75],
    ['RM override pisa match auto', 'respuesta_manual',
      { pts_max: 75 }, { texto: 'X', overrides_pts: { '1': 30 } }, { texto: 'Y' }, 1, 30],
    ['RM no match', 'respuesta_manual',
      { pts_max: 75 }, { texto: 'X' }, { texto: 'Y' }, 1, 0],
    ['RE pts_si_acierta pisa pts_max', 'regla_especial',
      { pts_max: 75 }, { texto: 'X', pts_si_acierta: 20 }, { texto: 'x' }, 1, 20],
    ['RE override 0 explícito', 'regla_especial',
      { pts_max: 50 }, { texto: 'X', overrides_pts: { '1': 0 } }, { texto: 'X' }, 1, 0],
  ];

  for (const [label, tipo, cfg, res, resp, userId, esperado] of fixtures) {
    const actual = calcularPuntosPregunta(tipo, cfg, res, resp, userId);
    if (actual === esperado) ok(`${label}: ${actual} pts ✓`);
    else fail(`${label}: esperaba ${esperado}, recibí ${actual}`);
  }

  // normalizarTexto smoke
  if (normalizarTexto('Mbappé ') === 'mbappe') ok(`normalizarTexto OK ('Mbappé ' → 'mbappe')`);
  else fail(`normalizarTexto inesperado: '${normalizarTexto('Mbappé ')}'`);
}

// ── 6. HTTP endpoints ──────────────────────────────────────────────────────
async function httpEndpoints(torneoId, byNum) {
  console.log(H('6. HTTP endpoints'));

  // 6.1 POST resultado con estado='abierto' → 409
  setEstado(torneoId, 'abierto');
  let r = await http('POST', `/api/mundial/${torneoId}/resultados/${byNum.get(9701)}`, {
    resultado_json: { opcion: 'Sí' },
  });
  if (r.status === 409) ok(`POST resultado en estado 'abierto' → 409 ✓`);
  else fail(`Esperaba 409, recibí ${r.status}: ${JSON.stringify(r.data)}`);

  // 6.2 GET ranking en estado 'abierto' → visible:false, motivo:'estado_no_apto'
  r = await http('GET', `/api/mundial/${torneoId}/ranking`);
  if (r.status === 200 && r.data?.visible === false && r.data?.motivo === 'estado_no_apto') {
    ok(`GET ranking en estado 'abierto' → visible:false motivo:estado_no_apto ✓`);
  } else fail(`Esperaba visible:false estado_no_apto, recibí ${JSON.stringify(r.data)}`);

  // 6.3 Forzar 'grupos_jugados' y cargar todos los resultados reales
  setEstado(torneoId, 'grupos_jugados');
  info(`Estado → 'grupos_jugados'`);

  for (const [num, resJson] of Object.entries(RESULTADOS_REALES)) {
    const r = await http('POST', `/api/mundial/${torneoId}/resultados/${byNum.get(parseInt(num, 10))}`, {
      resultado_json: resJson,
    });
    if (r.status !== 201) { fail(`POST resultado #${num}: ${r.status} ${JSON.stringify(r.data)}`); return false; }
  }
  ok(`POST 8 resultados → 201 ✓`);

  // 6.4 POST resultado con shape inválido → 400
  r = await http('POST', `/api/mundial/${torneoId}/resultados/${byNum.get(9701)}`, {
    resultado_json: { opcion: 'OpcionInvalida' },
  });
  if (r.status === 400) ok(`POST resultado opción no válida → 400 ✓`);
  else fail(`Esperaba 400, recibí ${r.status}`);

  // 6.5 POST resultado con equipo no en catálogo → 400
  r = await http('POST', `/api/mundial/${torneoId}/resultados/${byNum.get(9702)}`, {
    resultado_json: { equipo: 'NOEXISTE' },
  });
  if (r.status === 400 && Array.isArray(r.data?.codigos_invalidos)) {
    ok(`POST resultado equipo fuera de catálogo → 400 con codigos_invalidos ✓`);
  } else fail(`Esperaba 400 + codigos_invalidos, recibí ${r.status} ${JSON.stringify(r.data)}`);

  // 6.6 Verificar que el resultado original (X1) sigue cargado (POST inválido no pisó)
  const lista = await http('GET', `/api/mundial/${torneoId}/resultados`);
  if (lista.status === 200 && Array.isArray(lista.data) && lista.data.length === 8) {
    ok(`GET resultados devuelve 8 cargados ✓`);
  } else fail(`GET resultados: esperaba 8, recibí ${lista.data?.length} (status ${lista.status})`);

  // 6.7 DELETE resultado + 404 al re-borrar
  r = await http('DELETE', `/api/mundial/${torneoId}/resultados/${byNum.get(9708)}`);
  if (r.status === 200) ok(`DELETE resultado P9708 → 200 ✓`);
  else fail(`DELETE: esperaba 200, recibí ${r.status}`);
  r = await http('DELETE', `/api/mundial/${torneoId}/resultados/${byNum.get(9708)}`);
  if (r.status === 404) ok(`DELETE re-borrar → 404 ✓`);
  else fail(`Re-DELETE: esperaba 404, recibí ${r.status}`);
  // Recargar el resultado para los siguientes tests
  await http('POST', `/api/mundial/${torneoId}/resultados/${byNum.get(9708)}`, {
    resultado_json: RESULTADOS_REALES[9708],
  });

  // 6.8 GET mis-puntos del admin: pts_totales = PTS_TOTAL_ADMIN
  const mp = await http('GET', `/api/mundial/${torneoId}/mis-puntos`);
  if (mp.status !== 200) { fail(`GET mis-puntos: ${mp.status}`); return false; }
  if (mp.data.pts_totales === PTS_TOTAL_ADMIN) {
    ok(`GET mis-puntos pts_totales=${PTS_TOTAL_ADMIN} ✓`);
  } else {
    fail(`mis-puntos.pts_totales: esperaba ${PTS_TOTAL_ADMIN}, recibí ${mp.data.pts_totales}`);
    for (const it of mp.data.items) {
      info(`P${it.numero} ${it.tipo_pregunta}: pts=${it.pts_obtenidos} esperado=${PTS_ESPERADOS_ADMIN[it.numero]}`);
    }
  }

  // 6.9 GET ranking con resultados cargados → visible:true, admin posición 1
  const rk = await http('GET', `/api/mundial/${torneoId}/ranking`);
  if (rk.status !== 200) { fail(`GET ranking: ${rk.status}`); return false; }
  if (rk.data.visible !== true) { fail(`ranking.visible no es true: ${rk.data.visible}`); return false; }
  const adminEnRanking = rk.data.ranking.find(u => u.user_id === USER.id);
  if (adminEnRanking && adminEnRanking.posicion === 1 && adminEnRanking.puntos_totales === PTS_TOTAL_ADMIN) {
    ok(`Ranking: admin posición 1, ${PTS_TOTAL_ADMIN} pts ✓`);
  } else {
    fail(`Admin no posición 1 o pts incorrectos: ${JSON.stringify(adminEnRanking)}`);
  }

  // Fase A — Detalle del ranking oficial: cada user del ranking trae detalle[]
  // con respuesta_user_display + respuesta_oficial_display por pregunta evaluada.
  if (Array.isArray(adminEnRanking?.detalle) && adminEnRanking.detalle.length === Object.keys(RESPUESTAS_ADMIN).length) {
    ok(`Ranking: admin trae detalle de ${adminEnRanking.detalle.length} preguntas ✓`);
  } else {
    fail(`Admin detalle esperado ${Object.keys(RESPUESTAS_ADMIN).length} items, recibí ${adminEnRanking?.detalle?.length}`);
  }
  // Sample: P9705 (numero_por_banda) — admin respondió numero:4 que es exacto al resultado:4.
  const d9705 = adminEnRanking?.detalle?.find(d => d.numero === 9705);
  if (d9705 && d9705.acerto === true && d9705.pts === 25 &&
      d9705.respuesta_user_display === '4' && d9705.respuesta_oficial_display === '4') {
    ok(`Ranking detalle P9705: vos=4 / oficial=4, acerto=true, +25 ✓`);
  } else {
    fail(`Detalle P9705 inesperado: ${JSON.stringify(d9705)}`);
  }
  // Sample: P9702 (equipo_categoria) — admin equipo:X1 resultado:X1 → 50 pts.
  const d9702 = adminEnRanking?.detalle?.find(d => d.numero === 9702);
  if (d9702 && d9702.acerto === true && d9702.pts === 50 &&
      d9702.respuesta_user_display === 'X1' && d9702.respuesta_oficial_display === 'X1') {
    ok(`Ranking detalle P9702: vos=X1 / oficial=X1, +50 ✓`);
  } else {
    fail(`Detalle P9702 inesperado: ${JSON.stringify(d9702)}`);
  }
  // Detalle ordenado: aciertos primero, luego fallidos (P9708 falló).
  if (Array.isArray(adminEnRanking?.detalle)) {
    const ultima = adminEnRanking.detalle[adminEnRanking.detalle.length - 1];
    if (ultima && ultima.numero === 9708 && ultima.acerto === false) {
      ok(`Ranking detalle: P9708 (fallida) al final ✓`);
    } else {
      fail(`Detalle no terminó con P9708 fallida: ${JSON.stringify(ultima)}`);
    }
  }

  return true;
}

// ── 7. Multi-user ranking ──────────────────────────────────────────────────
async function multiUserRanking(torneoId, byNum) {
  console.log(H('7. Multi-user ranking'));
  const db = new DatabaseSync(DB_PATH);
  let fakeId;
  try {
    // Crear user fake (columna `password` no `password_hash`; valor 'x' es
    // suficiente para satisfacer NOT NULL — el user nunca va a loguearse).
    db.prepare("INSERT OR IGNORE INTO users (email, password, nombre, role) VALUES (?, 'x', 'Fake F3', 'user')").run(DIAG_FAKE_EMAIL);
    const u = db.prepare('SELECT id FROM users WHERE email = ?').get(DIAG_FAKE_EMAIL);
    fakeId = u.id;
    DIAG_FAKE_USER_STATE.userId  = fakeId;
    DIAG_FAKE_USER_STATE.created = true;
    info(`Fake user creado id=${fakeId}`);

    // Fase preprod: insertar fake user en torneo_jugadores para reflejar la
    // semántica real de participación. Sin esto, los endpoints user del
    // backend devolverían 403 si el diag los probara como ese user.
    // En la práctica el diag corre como admin (bypass), pero el setup correcto
    // mantiene los datos consistentes con el modelo.
    db.prepare(
      'INSERT OR IGNORE INTO torneo_jugadores (torneo_id, user_id) VALUES (?, ?)'
    ).run(torneoId, fakeId);

    // Borrar respuestas previas del fake en este torneo (si re-run)
    db.prepare(`DELETE FROM mundial_respuestas_usuario WHERE user_id = ? AND pregunta_id IN
                (SELECT id FROM mundial_preguntas WHERE torneo_id = ?)`).run(fakeId, torneoId);

    // Respuestas del fake: solo acierta 9701 (+15) y 9704 (+10) = 25 pts
    const fakeRespuestas = [
      [9701, { opcion: 'Sí' }],
      [9702, { equipo: 'Y2' }],            // 0 (X1 era correcto)
      [9703, { instancia: 'Grupos' }],     // 0 (16° era correcto)
      [9704, { numero: 7 }],               // 10 (acierta)
      [9705, { numero: 1 }],               // 0 (NO exacto — resultado 4)
      [9706, { equipos: ['Y1','Y2'] }],    // 0 aciertos
      [9707, { texto: 'no-match' }],       // 0
      [9708, { texto: 'no-match-tampoco' }], // 0
    ];
    const ins = db.prepare(`INSERT INTO mundial_respuestas_usuario (pregunta_id, user_id, respuesta_json) VALUES (?, ?, ?)`);
    for (const [num, r] of fakeRespuestas) {
      ins.run(byNum.get(num), fakeId, JSON.stringify(r));
    }
  } finally { db.close(); }

  const rk = await http('GET', `/api/mundial/${torneoId}/ranking`);
  if (rk.status !== 200 || !rk.data.visible) { fail(`Ranking multi-user no visible`); return; }
  if (rk.data.ranking.length !== 2) { fail(`Esperaba 2 users en ranking, recibí ${rk.data.ranking.length}`); return; }
  const [primero, segundo] = rk.data.ranking;
  if (primero.user_id === USER.id && primero.puntos_totales === PTS_TOTAL_ADMIN && primero.posicion === 1) {
    ok(`Posición 1: admin con ${PTS_TOTAL_ADMIN} pts ✓`);
  } else fail(`Posición 1 inesperada: ${JSON.stringify(primero)}`);
  if (segundo.user_id === fakeId && segundo.puntos_totales === 25 && segundo.posicion === 2) {
    ok(`Posición 2: fake con 25 pts ✓`);
  } else fail(`Posición 2 inesperada: ${JSON.stringify(segundo)}`);
}

// ── 8. Idempotencia ────────────────────────────────────────────────────────
async function idempotencia(torneoId) {
  console.log(H('8. Idempotencia ranking'));
  const a = await http('GET', `/api/mundial/${torneoId}/ranking`);
  const b = await http('GET', `/api/mundial/${torneoId}/ranking`);
  if (JSON.stringify(a.data) === JSON.stringify(b.data)) ok(`Ranking idempotente (2 corridas, mismo output) ✓`);
  else fail(`Ranking no idempotente — output cambió entre corridas`);
}

// ── Cleanup ────────────────────────────────────────────────────────────────
async function cleanup(torneoId) {
  console.log(H('9. Cleanup'));
  const db = new DatabaseSync(DB_PATH);
  try {
    if (DIAG_FAKE_USER_STATE.created && DIAG_FAKE_USER_STATE.userId) {
      db.prepare('DELETE FROM mundial_respuestas_usuario WHERE user_id = ?').run(DIAG_FAKE_USER_STATE.userId);
      db.prepare('DELETE FROM torneo_jugadores WHERE user_id = ?').run(DIAG_FAKE_USER_STATE.userId);
      db.prepare('DELETE FROM users WHERE id = ?').run(DIAG_FAKE_USER_STATE.userId);
      info(`Fake user borrado`);
    }
    if (torneoId) {
      db.prepare(`DELETE FROM mundial_resultados WHERE pregunta_id IN
                  (SELECT id FROM mundial_preguntas WHERE torneo_id = ?)`).run(torneoId);
      db.prepare(`DELETE FROM mundial_respuestas_usuario WHERE pregunta_id IN
                  (SELECT id FROM mundial_preguntas WHERE torneo_id = ?)`).run(torneoId);
      db.prepare('DELETE FROM mundial_preguntas WHERE torneo_id = ?').run(torneoId);
      db.prepare('DELETE FROM mundial_equipos_catalogo WHERE torneo_id = ?').run(torneoId);
      db.prepare('DELETE FROM mundial_config WHERE torneo_id = ?').run(torneoId);
      db.prepare('DELETE FROM torneo_jugadores WHERE torneo_id = ?').run(torneoId);
      db.prepare('DELETE FROM torneos WHERE id = ?').run(torneoId);
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
    unitTestScoring();
    const t = await obtenerOCrearDiagTorneo();
    if (!t) { exitCode = 1; return; }
    torneoId = t.id;
    if (!TIENE_PERMISO_MUNDIAL) {
      warn(`Sin 'gestionar_mundial': salteando tests HTTP que requieren admin.`);
      return;
    }
    const byNum = await setupContenido(torneoId);
    if (!byNum) { exitCode = 1; return; }
    const okHttp = await httpEndpoints(torneoId, byNum);
    if (!okHttp) return;
    await multiUserRanking(torneoId, byNum);
    await idempotencia(torneoId);
  } catch (e) {
    fail(`Excepción no manejada: ${e.message}`);
    if (e.stack) console.error(e.stack);
  } finally {
    if (torneoId) await cleanup(torneoId);
    revokePermisoSiGrantedPorDiag();
    console.log('');
    if (exitCode === 0) console.log(c('━━━ Diagnóstico Fase 3 OK ━━━', '1;32'));
    else                console.log(c('━━━ Diagnóstico Fase 3 con ERRORES ━━━', '1;31'));
    process.exit(exitCode);
  }
})();
