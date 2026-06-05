#!/usr/bin/env node
/**
 * Diagnóstico Mundial — Respuestas públicas corregidas (mini-fase)
 *
 * Valida que GET /api/mundial/:torneoId/respuestas-publicas devuelva la
 * data ampliada manteniendo compat con el shape anterior.
 *
 * Escenarios montados con el admin (sin segundo user):
 *   - P1 opcion_unica: admin "Sí", resultado "Sí"       → correcto +50
 *   - P2 opcion_unica: admin "Sí", resultado "No"       → incorrecto 0
 *   - P3 multi_equipo: admin [X1,X2,X3], result [X1,X2,X3] → correcto full
 *   - P4 multi_equipo: admin [X1,X2,X3], result [X1,X2,X4] → parcial (2 aciertos)
 *   - P5 opcion_unica: admin "Sí", SIN resultado        → pendiente
 *
 * Cubre:
 *   1. Shape compat: preguntas[].respuestas[].respuesta_json sigue ahí.
 *   2. participantes top-level: incluye puntos_totales coherente con ranking.
 *   3. tiene_resultado por pregunta.
 *   4. estado + puntos_obtenidos por celda (correcto/incorrecto/parcial/pendiente).
 *   5. detalle_items para multi_equipo con resultado cargado, marcando
 *      correcto:true/false por código.
 *   6. detalle_items NO presente en preguntas pendientes ni en tipos no multi.
 *   7. Seguimiento admin con torneo abierto (mini-fase):
 *      - visible:false + total_preguntas + seguimiento[] solo para admin.
 *      - 3 estados validados: completo / incompleto / sin_empezar.
 *      - Sin respuesta_json en seguimiento (no se filtran respuestas).
 *      - Orden alfabético por nombre.
 *
 * Uso:
 *   cd backend
 *   DIAG_AUTO_GRANT=1 node diagnostico-mundial-respuestas-publicas.js
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DIAG_EMAIL         = process.env.DIAG_EMAIL    || 'admin@prode.com';
const DIAG_PASSWORD      = process.env.DIAG_PASSWORD || 'admin123';
const API_BASE_URL       = process.env.API_BASE_URL  || 'http://localhost:3001';
const DB_PATH            = process.env.DB_PATH       || path.join(__dirname, 'prode.db');
const DIAG_AUTO_GRANT    = process.env.DIAG_AUTO_GRANT === '1';
const DIAG_TORNEO_NOMBRE = '__DIAG_MUNDIAL_RP__';

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
  console.log(H('1. Auth'));
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

// ── Torneo de diag ─────────────────────────────────────────────────────────
async function obtenerOCrearDiagTorneo() {
  console.log(H('2. Torneo de diag'));
  const todos = await http('GET', '/api/torneos');
  if (todos.status !== 200) { fail(`No pude listar torneos`); return null; }
  const existente = (todos.data || []).find(t => t.nombre === DIAG_TORNEO_NOMBRE);
  if (existente) {
    info(`Reusando torneo id=${existente.id}`);
    return existente;
  }
  const created = await http('POST', '/api/torneos', {
    nombre: DIAG_TORNEO_NOMBRE, semestre: '2026-DIAG-RP', tipo: 'mundial_preguntas',
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

// ── Setup contenido ────────────────────────────────────────────────────────
const EQUIPOS_DIAG = [
  { codigo: 'X1', nombre: 'X One',  emoji: '🅰️', grupo: 'A', confederacion: 'UEFA' },
  { codigo: 'X2', nombre: 'X Two',  emoji: '🅱️', grupo: 'A', confederacion: 'CONMEBOL' },
  { codigo: 'X3', nombre: 'X Three',emoji: '🇨🇮', grupo: 'B', confederacion: 'CAF' },
  { codigo: 'X4', nombre: 'X Four', emoji: '🇨🇼', grupo: 'B', confederacion: 'CONCACAF' },
];

const PREGUNTAS_DIAG = [
  { numero: 9701, enunciado: 'RP-P1 ouni-correcta', tipo_pregunta: 'opcion_unica',
    config_json: { opciones: ['Sí', 'No'], pts: 50 } },
  { numero: 9702, enunciado: 'RP-P2 ouni-incorrecta', tipo_pregunta: 'opcion_unica',
    config_json: { opciones: ['Sí', 'No'], pts: 30 } },
  // multi_equipo: el validador exige `n_equipos` entero >= 1 (no `max_equipos`).
  // Ambas preguntas reciben 3 equipos en la respuesta → n_equipos: 3.
  { numero: 9703, enunciado: 'RP-P3 multi-full', tipo_pregunta: 'multi_equipo',
    config_json: { n_equipos: 3, pts_por_acierto: 10 } },
  { numero: 9704, enunciado: 'RP-P4 multi-parcial', tipo_pregunta: 'multi_equipo',
    config_json: { n_equipos: 3, pts_por_acierto: 10 } },
  { numero: 9705, enunciado: 'RP-P5 ouni-pendiente', tipo_pregunta: 'opcion_unica',
    config_json: { opciones: ['Sí', 'No'], pts: 40 } },
];

async function setupContenido(torneoId) {
  console.log(H('3. Setup contenido'));
  setEstado(torneoId, 'configuracion');

  // Equipos (limpiar + cargar)
  const db = new DatabaseSync(DB_PATH);
  try { db.prepare('DELETE FROM mundial_equipos_catalogo WHERE torneo_id=?').run(torneoId); }
  finally { db.close(); }
  for (const e of EQUIPOS_DIAG) {
    const r = await http('POST', `/api/mundial/${torneoId}/equipos`, e);
    if (r.status !== 201) { fail(`POST equipo ${e.codigo}: ${r.status}`); return null; }
  }

  // Preguntas
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
    if (r.status !== 201) { fail(`POST pregunta ${p.numero}: ${r.status} ${JSON.stringify(r.data)}`); return null; }
  }
  ok(`Contenido base OK (4 equipos + 5 preguntas)`);

  // Respuestas del admin (estado='abierto')
  setEstado(torneoId, 'abierto');
  const preg = await http('GET', `/api/mundial/${torneoId}/preguntas?activa=1`);
  const byNum = new Map(preg.data.map(p => [p.numero, p.id]));
  const respArr = [
    { pregunta_id: byNum.get(9701), respuesta_json: { opcion: 'Sí' } },
    { pregunta_id: byNum.get(9702), respuesta_json: { opcion: 'Sí' } },
    { pregunta_id: byNum.get(9703), respuesta_json: { equipos: ['X1','X2','X3'] } },
    { pregunta_id: byNum.get(9704), respuesta_json: { equipos: ['X1','X2','X3'] } },
    { pregunta_id: byNum.get(9705), respuesta_json: { opcion: 'Sí' } },
  ];
  const rResp = await http('PUT', `/api/mundial/${torneoId}/mis-respuestas`, { respuestas: respArr });
  if (rResp.status !== 200) { fail(`PUT respuestas admin: ${rResp.status}: ${JSON.stringify(rResp.data)}`); return null; }

  // Cargar resultados (P1, P2, P3, P4). P5 queda SIN resultado → pendiente.
  setEstado(torneoId, 'grupos_jugados');
  const cargas = [
    [9701, { opcion: 'Sí' }],                  // correcto
    [9702, { opcion: 'No' }],                  // incorrecto
    [9703, { equipos: ['X1','X2','X3'] }],     // multi full → correcto
    [9704, { equipos: ['X1','X2','X4'] }],     // multi parcial (2 aciertos de 3)
  ];
  for (const [num, body] of cargas) {
    const r = await http('POST', `/api/mundial/${torneoId}/resultados/${byNum.get(num)}`, { resultado_json: body });
    if (r.status !== 200 && r.status !== 201) { fail(`Cargar resultado ${num}: ${r.status} ${JSON.stringify(r.data)}`); return null; }
  }
  info(`Resultados cargados: P1✓ P2✗ P3✓full P4parcial P5pendiente`);

  // Estado visible para respuestas-publicas: grupos_jugados ya basta.
  return byNum;
}

// ── Verificación del endpoint ──────────────────────────────────────────────
async function verificarEndpoint(torneoId, byNum) {
  console.log(H('4. GET /respuestas-publicas — shape + estados'));
  const r = await http('GET', `/api/mundial/${torneoId}/respuestas-publicas`);
  if (r.status !== 200) { fail(`GET respuestas-publicas: ${r.status}`); return false; }
  const d = r.data;

  // 4.1 Visible + compat — shape preexistente intacto.
  if (d.visible !== true) { fail(`visible debería ser true`); return false; }
  ok(`visible:true ✓`);

  if (!Array.isArray(d.preguntas) || d.preguntas.length !== 5) {
    fail(`Esperaba 5 preguntas, recibí ${d.preguntas?.length}`); return false;
  }
  // shape compat: respuesta_json + nombre + user_id deben seguir presentes.
  const p1 = d.preguntas.find(p => p.numero === 9701);
  const adminRowP1 = (p1?.respuestas || []).find(r => r.user_id === USER.id);
  if (adminRowP1 && typeof adminRowP1.respuesta_json === 'string' && typeof adminRowP1.nombre === 'string') {
    ok(`Shape compat: respuesta_json + nombre + user_id preservados ✓`);
  } else fail(`Shape compat roto: ${JSON.stringify(adminRowP1)}`);

  // 4.2 participantes top-level.
  if (!Array.isArray(d.participantes)) { fail(`participantes top-level faltante`); return false; }
  const yo = d.participantes.find(p => p.user_id === USER.id);
  if (!yo) { fail(`participantes no incluye al admin`); return false; }
  // Puntos esperados: P1(+50) + P2(0) + P3(3×10=30) + P4(2×10=20) + P5(null/0) = 100
  const ptsEsperados = 100;
  if (yo.puntos_totales === ptsEsperados) {
    ok(`participantes[admin].puntos_totales=${yo.puntos_totales} ✓`);
  } else fail(`Esperaba puntos_totales=${ptsEsperados}, recibí ${yo.puntos_totales}`);

  // 4.3 tiene_resultado por pregunta.
  const tieneResMap = new Map(d.preguntas.map(p => [p.numero, p.tiene_resultado]));
  const esperadoTieneRes = { 9701: true, 9702: true, 9703: true, 9704: true, 9705: false };
  let okTieneRes = true;
  for (const [num, esp] of Object.entries(esperadoTieneRes)) {
    if (tieneResMap.get(parseInt(num)) !== esp) {
      fail(`P${num}.tiene_resultado esperaba ${esp}, recibí ${tieneResMap.get(parseInt(num))}`);
      okTieneRes = false;
    }
  }
  if (okTieneRes) ok(`tiene_resultado correcto para las 5 preguntas ✓`);

  // 4.4 Celdas: estado + puntos_obtenidos por escenario.
  function cellAdmin(numero) {
    const p = d.preguntas.find(p => p.numero === numero);
    return (p?.respuestas || []).find(r => r.user_id === USER.id);
  }
  const escenarios = [
    { num: 9701, estado: 'correcto',   pts: 50,   nota: 'P1 correcto' },
    { num: 9702, estado: 'incorrecto', pts: 0,    nota: 'P2 incorrecto' },
    { num: 9703, estado: 'correcto',   pts: 30,   nota: 'P3 multi full' },
    { num: 9704, estado: 'parcial',    pts: 20,   nota: 'P4 multi parcial' },
    { num: 9705, estado: 'pendiente',  pts: null, nota: 'P5 pendiente (sin resultado)' },
  ];
  for (const esc of escenarios) {
    const cell = cellAdmin(esc.num);
    if (!cell) { fail(`${esc.nota}: celda admin faltante`); continue; }
    const okEstado = cell.estado === esc.estado;
    const okPts    = cell.puntos_obtenidos === esc.pts;
    if (okEstado && okPts) {
      ok(`${esc.nota}: estado='${esc.estado}' + pts=${esc.pts} ✓`);
    } else {
      fail(`${esc.nota}: esperaba estado='${esc.estado}'/pts=${esc.pts}, recibí estado='${cell.estado}'/pts=${cell.puntos_obtenidos}`);
    }
  }

  // 4.5 detalle_items: solo en multi_equipo con resultado.
  const cellP3 = cellAdmin(9703);
  if (Array.isArray(cellP3?.detalle_items) && cellP3.detalle_items.length === 3) {
    const todosCorrectos = cellP3.detalle_items.every(it => it.correcto === true);
    const codigosOk = cellP3.detalle_items.map(it => it.codigo).join(',') === 'X1,X2,X3';
    if (todosCorrectos && codigosOk) ok(`P3 multi full: detalle_items 3/3 verdes ✓`);
    else fail(`P3 detalle_items inesperado: ${JSON.stringify(cellP3.detalle_items)}`);
  } else fail(`P3 detalle_items faltante o longitud incorrecta`);

  const cellP4 = cellAdmin(9704);
  if (Array.isArray(cellP4?.detalle_items) && cellP4.detalle_items.length === 3) {
    // admin: [X1,X2,X3], result: [X1,X2,X4] → X1,X2 correctos; X3 incorrecto.
    const expected = [
      { codigo: 'X1', correcto: true },
      { codigo: 'X2', correcto: true },
      { codigo: 'X3', correcto: false },
    ];
    const matchOk = expected.every((e, i) =>
      cellP4.detalle_items[i].codigo === e.codigo &&
      cellP4.detalle_items[i].correcto === e.correcto
    );
    if (matchOk) ok(`P4 multi parcial: detalle_items 2/3 con X3 marcado false ✓`);
    else fail(`P4 detalle_items inesperado: ${JSON.stringify(cellP4.detalle_items)}`);
  } else fail(`P4 detalle_items faltante o longitud incorrecta`);

  // 4.6 detalle_items NO en tipos no multi + NO en pendiente.
  const cellP1 = cellAdmin(9701);
  if (cellP1?.detalle_items === undefined) ok(`P1 (opcion_unica) sin detalle_items ✓`);
  else fail(`P1 no debería tener detalle_items: ${JSON.stringify(cellP1.detalle_items)}`);

  const cellP5 = cellAdmin(9705);
  if (cellP5?.detalle_items === undefined) ok(`P5 (pendiente) sin detalle_items ✓`);
  else fail(`P5 (pendiente) no debería tener detalle_items: ${JSON.stringify(cellP5.detalle_items)}`);

  return true;
}

// ── Seguimiento admin (sección nueva) ─────────────────────────────────────
// Cuando el torneo está en estado 'abierto' (carga aún en curso), el endpoint
// devuelve visible:false. Para admin/superadmin agregamos seguimiento[] con
// conteos por participante. Validamos los 3 estados (completo/incompleto/
// sin_empezar) creando 2 fake users en DB.
const DIAG_FAKE_EMAILS = ['__diag_rp_segB@local', '__diag_rp_segC@local'];
const DIAG_FAKE_BCRYPT = '$2a$10$diagdummypasswordsdiagdummypasswordsdiagdummypassworddiag1';

async function verificarSeguimientoAdmin(torneoId, byNum) {
  console.log(H('5. Seguimiento admin (carga abierta)'));

  // 5.1 Forzar estado='abierto' + deadline futuro → visible:false.
  const db = new DatabaseSync(DB_PATH);
  let userBId, userCId;
  try {
    db.prepare(`UPDATE mundial_config
                SET estado='abierto', deadline_carga='2099-12-31 23:59:59'
                WHERE torneo_id=?`).run(torneoId);

    // 5.2 Crear 2 fake users + agregarlos a torneo_jugadores.
    // El admin ya está implícito (entra como admin/superadmin sin necesidad
    // de torneo_jugadores), pero para el conteo necesitamos que aparezca.
    // Agregamos también al admin a torneo_jugadores explícitamente.
    db.prepare(`INSERT OR IGNORE INTO torneo_jugadores (torneo_id, user_id) VALUES (?, ?)`)
      .run(torneoId, USER.id);

    // Limpieza defensiva por si quedaron de una corrida previa abortada.
    for (const email of DIAG_FAKE_EMAILS) {
      db.prepare(`DELETE FROM torneo_jugadores
                  WHERE user_id IN (SELECT id FROM users WHERE email=?)`).run(email);
      db.prepare(`DELETE FROM mundial_respuestas_usuario
                  WHERE user_id IN (SELECT id FROM users WHERE email=?)`).run(email);
      db.prepare(`DELETE FROM users WHERE email=?`).run(email);
    }

    const insertUser = db.prepare(
      'INSERT INTO users (nombre, email, password, role) VALUES (?, ?, ?, ?)'
    );
    userBId = insertUser.run('DiagSeg B', '__diag_rp_segB@local', DIAG_FAKE_BCRYPT, 'user').lastInsertRowid;
    userCId = insertUser.run('DiagSeg C', '__diag_rp_segC@local', DIAG_FAKE_BCRYPT, 'user').lastInsertRowid;

    const linkTorneo = db.prepare('INSERT INTO torneo_jugadores (torneo_id, user_id) VALUES (?, ?)');
    linkTorneo.run(torneoId, userBId);
    linkTorneo.run(torneoId, userCId);

    // 5.3 User B responde solo la pregunta 9701 → incompleto (1/5).
    const pregId = byNum.get(9701);
    db.prepare(`INSERT INTO mundial_respuestas_usuario
                (pregunta_id, user_id, respuesta_json, updated_at)
                VALUES (?, ?, ?, datetime('now'))`)
      .run(pregId, userBId, JSON.stringify({ opcion: 'Sí' }));

    ok(`Setup: torneo→abierto, deadline futuro, 2 fake users (B con 1 respuesta, C con 0)`);
  } catch (e) {
    fail(`Setup seguimiento falló: ${e.message}`);
    db.close();
    return false;
  }
  db.close();

  // 5.4 GET endpoint con token de admin.
  const r = await http('GET', `/api/mundial/${torneoId}/respuestas-publicas`);
  if (r.status !== 200) { fail(`GET respuestas-publicas: ${r.status}`); return false; }
  const d = r.data;

  if (d.visible !== false) fail(`visible debería ser false (carga abierta), recibí ${d.visible}`);
  else ok(`visible:false ✓`);

  if (d.motivo !== 'carga_abierta') fail(`motivo esperado 'carga_abierta', recibí '${d.motivo}'`);
  else ok(`motivo:'carga_abierta' ✓`);

  if (d.total_preguntas !== 5) fail(`total_preguntas esperado 5, recibí ${d.total_preguntas}`);
  else ok(`total_preguntas:5 ✓`);

  if (!Array.isArray(d.seguimiento)) { fail(`seguimiento[] faltante`); return false; }
  if (d.seguimiento.length !== 3)   fail(`seguimiento.length esperado 3, recibí ${d.seguimiento.length}`);
  else ok(`seguimiento.length:3 ✓`);

  // No debe filtrar respuestas.
  const algunaTieneRespuestaJson = d.seguimiento.some(s => 'respuesta_json' in s);
  if (!algunaTieneRespuestaJson) ok(`seguimiento NO incluye respuesta_json ✓`);
  else fail(`seguimiento NO debería incluir respuesta_json`);

  // 5.5 Verificar cada participante.
  const filaAdmin = d.seguimiento.find(s => s.user_id === USER.id);
  if (filaAdmin
      && filaAdmin.respondidas === 5
      && filaAdmin.faltan === 0
      && filaAdmin.porcentaje === 100
      && filaAdmin.estado === 'completo'
      && filaAdmin.ultima_actualizacion) {
    ok(`Admin: 5/5, 0 faltan, 100%, estado='completo', ultima!=null ✓`);
  } else fail(`Admin row inesperada: ${JSON.stringify(filaAdmin)}`);

  const filaB = d.seguimiento.find(s => s.user_id === userBId);
  if (filaB
      && filaB.respondidas === 1
      && filaB.faltan === 4
      && filaB.porcentaje === 20
      && filaB.estado === 'incompleto'
      && filaB.ultima_actualizacion) {
    ok(`User B: 1/5, 4 faltan, 20%, estado='incompleto', ultima!=null ✓`);
  } else fail(`User B row inesperada: ${JSON.stringify(filaB)}`);

  const filaC = d.seguimiento.find(s => s.user_id === userCId);
  if (filaC
      && filaC.respondidas === 0
      && filaC.faltan === 5
      && filaC.porcentaje === 0
      && filaC.estado === 'sin_empezar'
      && filaC.ultima_actualizacion === null) {
    ok(`User C: 0/5, 5 faltan, 0%, estado='sin_empezar', ultima=null ✓`);
  } else fail(`User C row inesperada: ${JSON.stringify(filaC)}`);

  // 5.6 Orden alfabético por nombre.
  const nombres = d.seguimiento.map(s => s.nombre);
  const ordenados = [...nombres].sort((a, b) => (a || '').localeCompare(b || '', 'es', { sensitivity: 'base' }));
  if (JSON.stringify(nombres) === JSON.stringify(ordenados)) ok(`Orden alfabético por nombre ✓`);
  else fail(`Orden inesperado: ${JSON.stringify(nombres)}`);

  return true;
}

// ── Cleanup ────────────────────────────────────────────────────────────────
function cleanupFakeUsers() {
  const db = new DatabaseSync(DB_PATH);
  try {
    for (const email of DIAG_FAKE_EMAILS) {
      db.prepare(`DELETE FROM mundial_respuestas_usuario
                  WHERE user_id IN (SELECT id FROM users WHERE email=?)`).run(email);
      db.prepare(`DELETE FROM torneo_jugadores
                  WHERE user_id IN (SELECT id FROM users WHERE email=?)`).run(email);
      db.prepare(`DELETE FROM users WHERE email=?`).run(email);
    }
  } catch (e) { fail(`Cleanup fake users falló: ${e.message}`); }
  finally { db.close(); }
}

async function cleanup(torneoId) {
  console.log(H('6. Cleanup'));
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
  cleanupFakeUsers();
}

// ── Main ───────────────────────────────────────────────────────────────────
(async () => {
  let torneoId;
  try {
    maybeGrantPermisoForDiag();
    await authCheck();
    const t = await obtenerOCrearDiagTorneo();
    if (!t) { exitCode = 1; return; }
    torneoId = t.id;
    if (!TIENE_PERMISO) { warn(`Sin permiso: skipping HTTP admin tests`); return; }

    const byNum = await setupContenido(torneoId);
    if (!byNum) { exitCode = 1; return; }

    await verificarEndpoint(torneoId, byNum);
    await verificarSeguimientoAdmin(torneoId, byNum);
  } catch (e) {
    fail(`Excepción: ${e.message}`);
    if (e.stack) console.error(e.stack);
  } finally {
    if (torneoId) await cleanup(torneoId);
    revokePermisoSiGrantedPorDiag();
    console.log('');
    if (exitCode === 0) console.log(c('━━━ Diagnóstico Respuestas-publicas OK ━━━', '1;32'));
    else                console.log(c('━━━ Diagnóstico Respuestas-publicas con ERRORES ━━━', '1;31'));
    process.exit(exitCode);
  }
})();
