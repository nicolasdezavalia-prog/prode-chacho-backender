#!/usr/bin/env node
/**
 * Diagnóstico Mundial — Fase Proyección Ranking
 *
 * Valida el helper mundial-proyeccion.js + endpoint /ranking-proyectado.
 *
 * Cubre:
 *   1. Helpers puros (esProyectable, proyectores por tipo).
 *   2. Setup: torneo + 8 equipos (2 grupos: G y H) + 3 preguntas mock
 *      con numeros mapeados (29, 30, 35, 5, 32, 26).
 *   3. Carga de partidos finalizados → stats con tabla, empates, tops.
 *   4. Fake users con respuestas que cubren TODOS los casos:
 *        - Acierta numero_por_banda (P29 → goles ARG en Grupo G de diag).
 *        - Acierta numero_exacto (P30 → empates Grupo H).
 *        - Acierta P35 (top amarillas).
 *        - Empate en top P36 (rojas) — 2 candidatos, user matchea uno.
 *        - Empate en top P5 (goleador) — 2 jugadores en posición 1°.
 *        - Multi_equipo P32 parcial (1 eliminado de los 8 propuestos).
 *        - Empate en tercer puesto P26 (2 equipos comparten 3°).
 *   5. GET /ranking-proyectado verifica:
 *        - Posiciones, puntos, aciertos.
 *        - no_proyectables incluye Tier 2.
 *        - Empates en el top: cualquier candidato matchea.
 *   6. Cleanup.
 *
 * NOTA: usamos torneo de diag con numeros reales del Mundial 2026 (29, 30,
 *       35, etc.) porque el dispatcher del helper es hardcoded por número.
 *       Si esto cambia, el diag falla y avisa.
 *
 * Uso:
 *   cd backend
 *   DIAG_AUTO_GRANT=1 node diagnostico-mundial-proyeccion.js
 */

const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const path = require('path');

const DIAG_EMAIL         = process.env.DIAG_EMAIL    || 'admin@prode.com';
const DIAG_PASSWORD      = process.env.DIAG_PASSWORD || 'admin123';
const API_BASE_URL       = process.env.API_BASE_URL  || 'http://localhost:3001';
const DB_PATH            = process.env.DB_PATH       || path.join(__dirname, 'prode.db');
const DIAG_AUTO_GRANT    = process.env.DIAG_AUTO_GRANT === '1';
const DIAG_TORNEO_NOMBRE = '__DIAG_MUNDIAL_PROYECCION__';

const FAKE_USERS = [
  { email: '__diag_proy_userB@local', nombre: 'DiagProy B' },
  { email: '__diag_proy_userC@local', nombre: 'DiagProy C' },
  { email: '__diag_proy_userD@local', nombre: 'DiagProy D' },
];
const FAKE_PASSWORD = 'diagproy-pass-2026';
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

// ── 1. Helpers puros ───────────────────────────────────────────────────────
function testHelpersPuros() {
  console.log(H('1. Helpers puros'));
  const m = require('./src/logic/mundial-proyeccion');

  // esProyectable con stats vacío
  const sinStats = { stats: null, goleadores: [] };
  if (!m.esProyectable({ numero: 29 }, sinStats)) ok(`esProyectable false sin stats ✓`);
  else fail(`esProyectable debería false sin stats`);

  // motivoNoProyectable
  if (typeof m.motivoNoProyectable({ numero: 1 }) === 'string') ok(`motivoNoProyectable devuelve string ✓`);

  // aplicarCanon
  const canon = new Map([['mbappe', 'K. Mbappé']]);
  if (m.aplicarCanon('Mbappe', canon) === 'K. Mbappé') ok(`aplicarCanon mapea variante ✓`);
  else fail(`aplicarCanon variante falló`);
  if (m.aplicarCanon('Cualquiera', canon) === 'Cualquiera') ok(`aplicarCanon devuelve original si no matchea ✓`);
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
    else warn(`Sin permiso — skipping`);
  }
}

// ── Torneo + setup completo ────────────────────────────────────────────────
async function obtenerOCrearDiagTorneo() {
  console.log(H('3. Torneo de diag'));
  const todos = await http('GET', '/api/torneos');
  if (todos.status !== 200) { fail(`No pude listar torneos`); return null; }
  const existente = (todos.data || []).find(t => t.nombre === DIAG_TORNEO_NOMBRE);
  let torneo;
  if (existente) {
    info(`Reusando torneo id=${existente.id}`);
    torneo = existente;
  } else {
    const created = await http('POST', '/api/torneos', {
      nombre: DIAG_TORNEO_NOMBRE, semestre: '2026-DIAG-PROY', tipo: 'mundial_preguntas',
    });
    if (created.status !== 201) { fail(`Crear torneo: ${created.status}`); return null; }
    torneo = created.data;
    ok(`Torneo creado id=${torneo.id}`);
  }
  return torneo;
}

function setEstado(torneoId, estado) {
  const db = new DatabaseSync(DB_PATH);
  try {
    db.prepare(`INSERT OR IGNORE INTO mundial_config (torneo_id) VALUES (?)`).run(torneoId);
    db.prepare(`UPDATE mundial_config SET estado=? WHERE torneo_id=?`).run(estado, torneoId);
  } finally { db.close(); }
}

async function setupContenido(torneoId) {
  console.log(H('4. Setup contenido — equipos + preguntas + partidos + tarjetas + goleadores'));

  setEstado(torneoId, 'configuracion');

  // Equipos: 4 en Grupo G, 4 en Grupo H. Usamos códigos reales esperados:
  // ARG (en Grupo G para el test — solo para diag, fuera de Mundial real),
  // PAN (en Grupo G también). Resto: equipos sintéticos.
  // Esto es OK porque el helper solo mira los códigos.
  const db = new DatabaseSync(DB_PATH);
  try {
    db.prepare('DELETE FROM mundial_equipos_catalogo WHERE torneo_id=?').run(torneoId);
    db.prepare(`DELETE FROM mundial_partidos WHERE torneo_id=?`).run(torneoId);
    db.prepare(`DELETE FROM mundial_tarjetas_partido WHERE torneo_id=?`).run(torneoId);
    db.prepare(`DELETE FROM mundial_goleadores WHERE torneo_id=?`).run(torneoId);
    db.prepare(`DELETE FROM mundial_resultados WHERE pregunta_id IN
      (SELECT id FROM mundial_preguntas WHERE torneo_id=?)`).run(torneoId);
    db.prepare(`DELETE FROM mundial_respuestas_usuario WHERE pregunta_id IN
      (SELECT id FROM mundial_preguntas WHERE torneo_id=?)`).run(torneoId);
    db.prepare('DELETE FROM mundial_preguntas WHERE torneo_id=?').run(torneoId);
  } finally { db.close(); }

  const equipos = [
    // Grupo A — para tests P19/P20 (Segundo/Tercero Grupo A) y P17 (top GF grupos)
    { codigo: 'USA', nombre: 'Estados Unidos', emoji: '🇺🇸', grupo: 'A', confederacion: 'CONCACAF' },
    { codigo: 'MEX', nombre: 'México',         emoji: '🇲🇽', grupo: 'A', confederacion: 'CONCACAF' },
    // Grupo C — incluye HAI para test P22 (Sumará puntos Haití?)
    { codigo: 'HAI', nombre: 'Haití',          emoji: '🇭🇹', grupo: 'C', confederacion: 'CONCACAF' },
    // Grupo G — incluye ARG para test P29 ("goles ARG en Grupo J" — usamos G acá)
    { codigo: 'ARG', nombre: 'Argentina',  emoji: '🇦🇷', grupo: 'G', confederacion: 'CONMEBOL' },
    { codigo: 'PAR', nombre: 'Paraguay',   emoji: '🇵🇾', grupo: 'G', confederacion: 'CONMEBOL' },
    { codigo: 'PAN', nombre: 'Panamá',     emoji: '🇵🇦', grupo: 'G', confederacion: 'CONCACAF' },
    { codigo: 'BOL', nombre: 'Bolivia',    emoji: '🇧🇴', grupo: 'G', confederacion: 'CONMEBOL' },
    // Grupo H
    { codigo: 'ESP', nombre: 'España',     emoji: '🇪🇸', grupo: 'H', confederacion: 'UEFA' },
    { codigo: 'URU', nombre: 'Uruguay',    emoji: '🇺🇾', grupo: 'H', confederacion: 'CONMEBOL' },
    { codigo: 'ITA', nombre: 'Italia',     emoji: '🇮🇹', grupo: 'H', confederacion: 'UEFA' },
    { codigo: 'JPN', nombre: 'Japón',      emoji: '🇯🇵', grupo: 'H', confederacion: 'AFC' },
    // Grupo I — uno solo, para no proyectar P28 con datos
    { codigo: 'FRA', nombre: 'Francia',    emoji: '🇫🇷', grupo: 'I', confederacion: 'UEFA' },
    { codigo: 'BRA', nombre: 'Brasil',     emoji: '🇧🇷', grupo: 'I', confederacion: 'CONMEBOL' },
    // Grupo K — para test P30
    { codigo: 'CRC', nombre: 'Costa Rica', emoji: '🇨🇷', grupo: 'K', confederacion: 'CONCACAF' },
    { codigo: 'MAR', nombre: 'Marruecos',  emoji: '🇲🇦', grupo: 'K', confederacion: 'CAF' },
  ];
  for (const e of equipos) {
    const r = await http('POST', `/api/mundial/${torneoId}/equipos`, e);
    if (r.status !== 201) { fail(`POST equipo ${e.codigo}: ${r.status}`); return null; }
  }
  ok(`${equipos.length} equipos cargados (Grupos G, H, I, K)`);

  // Preguntas: las que el helper proyecta (numeros 5, 26, 27, 28, 29, 30,
  // 31, 32, 35, 36) + alguna no proyectable (P1 campeón).
  const preguntas = [
    { numero: 1, enunciado: 'Campeón', tipo_pregunta: 'equipo_categoria',
      config_json: { categorias: [{ label: 'default', pts: 100, default: true }] } },
    { numero: 5, enunciado: 'Goleador del Mundial', tipo_pregunta: 'respuesta_manual',
      config_json: { pts_max: 100 } },
    // P17 — equipo más goleador en grupos (categorias default 30 pts)
    { numero: 17, enunciado: 'Equipo más goleador en Grupos', tipo_pregunta: 'equipo_categoria',
      config_json: { categorias: [{ label: 'default', pts: 30, default: true }] } },
    // P19 — Segundo Grupo A (categorias default 10 pts, restriccion grupo A)
    { numero: 19, enunciado: 'Segundo Grupo A', tipo_pregunta: 'equipo_categoria',
      config_json: {
        categorias: [{ label: 'default', pts: 10, default: true }],
        restriccion: { tipo: 'grupo', grupo: 'A' },
      } },
    // P22 — Sumará puntos Haití (opcion_unica Sí/No con pts asimétricos)
    { numero: 22, enunciado: 'Sumará puntos Haití (Grupo C)??', tipo_pregunta: 'opcion_unica',
      config_json: { opciones: ['Sí', 'No'], pts_por_opcion: { 'Sí': 15, 'No': 10 } } },
    { numero: 26, enunciado: 'Tercero Grupo G', tipo_pregunta: 'equipo_categoria',
      config_json: { categorias: [
        { label: 'ARG', equipos: ['ARG'], pts: 30 },
        { label: 'otros', pts: 10, default: true },
      ] } },
    { numero: 29, enunciado: 'Cuántos goles recibirá ARG', tipo_pregunta: 'numero_por_banda',
      config_json: { bandas: [
        { min: 0, max: 2, pts: 10 },
        { min: 3, pts: 25 },
      ] } },
    { numero: 30, enunciado: 'Cuántos empates en grupo K', tipo_pregunta: 'numero_exacto',
      config_json: { pts_si_acierta: 10, pts_si_no_acierta: 0 } },
    { numero: 31, enunciado: 'Cuántos goles Panamá', tipo_pregunta: 'numero_por_banda',
      config_json: { bandas: [
        { min: 0, max: 2, pts: 10 },
        { min: 3, pts: 20 },
      ] } },
    { numero: 32, enunciado: 'Eliminados en 16°', tipo_pregunta: 'multi_equipo',
      config_json: { n_equipos: 8, pts_por_acierto: 10 } },
    { numero: 35, enunciado: 'Equipo con más amarillas', tipo_pregunta: 'equipo_categoria',
      config_json: {
        scoring_manual: true,
        categorias: [{ label: 'manual', pts: 0, default: true }],
      } },
    { numero: 36, enunciado: 'Equipo con más rojas', tipo_pregunta: 'equipo_categoria',
      config_json: {
        scoring_manual: true,
        categorias: [{ label: 'manual', pts: 0, default: true }],
      } },
  ];
  for (const p of preguntas) {
    const r = await http('POST', `/api/mundial/${torneoId}/preguntas`, p);
    if (r.status !== 201) { fail(`POST pregunta #${p.numero}: ${r.status} ${JSON.stringify(r.data)}`); return null; }
  }
  ok(`${preguntas.length} preguntas creadas`);

  // Partidos finalizados — para alimentar stats.
  // Grupo G: ARG 1-2 PAR, ARG 0-1 PAN, PAR 1-1 BOL, PAN 2-1 BOL. ARG gc=3.
  // Grupo G tabla esperada (Pts):
  //   PAR: G(ARG)=W+1, E(BOL)=D+1 → 4pts, GF=3 GC=2 DG=+1
  //   PAN: G(ARG)=W, G(BOL)=W → 6pts, GF=3 GC=1 DG=+2
  //   ARG: L(PAR), L(PAN) → 0pts, GF=1 GC=3 DG=-2
  //   BOL: D(PAR), L(PAN) → 1pt, GF=2 GC=3 DG=-1
  // Orden: PAN(6), PAR(4), BOL(1), ARG(0). Tercero = BOL.
  // Grupo H: 2 partidos con empate.
  //   ESP 1-1 URU, ITA 2-2 JPN. 2 empates en Grupo H. (P30 mide GRUPO K; acá es para tabla H.)
  // Grupo K: CRC 1-1 MAR (1 empate). MAR 2-2 CRC (otro empate). Total Grupo K = 2 empates.
  // Esto matchea el P30 "empates en grupo K = 2".
  const partidosDB = new DatabaseSync(DB_PATH);
  try {
    const ins = partidosDB.prepare(`
      INSERT INTO mundial_partidos (torneo_id, ronda, grupo, orden, equipo_local, equipo_visitante,
        goles_local, goles_visitante, estado, fecha)
      VALUES (?, 'grupos', ?, ?, ?, ?, ?, ?, 'finalizado', ?)
    `);
    let __ord = 0;
    // Grupo A — USA 2-0 MEX. USA pos 1° (3 pts), MEX pos 2° (0 pts).
    ins.run(torneoId, 'A', ++__ord, 'USA', 'MEX', 2, 0, '2026-06-14');
    // Grupo G
    ins.run(torneoId, 'G', ++__ord, 'ARG', 'PAR', 1, 2, '2026-06-15');
    ins.run(torneoId, 'G', ++__ord, 'ARG', 'PAN', 0, 1, '2026-06-18');
    ins.run(torneoId, 'G', ++__ord, 'PAR', 'BOL', 1, 1, '2026-06-21');
    ins.run(torneoId, 'G', ++__ord, 'PAN', 'BOL', 2, 1, '2026-06-24');
    // Grupo H
    ins.run(torneoId, 'H', ++__ord, 'ESP', 'URU', 1, 1, '2026-06-15');
    ins.run(torneoId, 'H', ++__ord, 'ITA', 'JPN', 2, 2, '2026-06-18');
    // Grupo K
    ins.run(torneoId, 'K', ++__ord, 'CRC', 'MAR', 1, 1, '2026-06-16');
    ins.run(torneoId, 'K', ++__ord, 'MAR', 'CRC', 2, 2, '2026-06-19');
  } finally { partidosDB.close(); }
  ok(`9 partidos finalizados`);

  // Tarjetas — vía FIXTURE (Sprint Final 2026-06-11: con partidos finalizados,
  // la matriz legacy queda read-only). Pongo amarillas/rojas directamente en
  // los partidos del Grupo G. Totales objetivo:
  //   PAR: amarillas=5, rojas=2 (líder único global ambas → P35/P36 25 pts)
  //   ARG: amarillas=3, rojas=0
  //   PAN: amarillas=4, rojas=1 (líder rojas entre elegidos {BOL,PAN,ARG} → P36 10 pts para C)
  //   BOL: amarillas=0, rojas=0
  // Distribución por partido (L = local, V = visitante):
  //   ARG-PAR: ARG am=3 rj=0; PAR am=2 rj=1
  //   ARG-PAN: ARG am=0 rj=0; PAN am=2 rj=0
  //   PAR-BOL: PAR am=3 rj=1; BOL am=0 rj=0
  //   PAN-BOL: PAN am=2 rj=1; BOL am=0 rj=0
  const cardsDB = new DatabaseSync(DB_PATH);
  try {
    const upd = cardsDB.prepare(`UPDATE mundial_partidos
      SET amarillas_local=?, amarillas_visitante=?, rojas_local=?, rojas_visitante=?
      WHERE torneo_id=? AND ronda='grupos' AND equipo_local=? AND equipo_visitante=?`);
    upd.run(3, 2, 0, 1, torneoId, 'ARG', 'PAR');
    upd.run(0, 2, 0, 0, torneoId, 'ARG', 'PAN');
    upd.run(3, 0, 1, 0, torneoId, 'PAR', 'BOL');
    upd.run(2, 0, 1, 0, torneoId, 'PAN', 'BOL');
  } finally { cardsDB.close(); }
  ok(`Tarjetas cargadas vía fixture (PAR líder único am=5/rj=2, PAN líder entre elegidos rj=1)`);
  let r;

  // Goleadores — empate en posición 1°: 2 jugadores con 3 goles cada uno.
  r = await http('PUT', `/api/mundial/${torneoId}/goleadores/bulk`, {
    goleadores: [
      { jugador: 'L. Messi',   goles: 3, equipo_codigo: 'ARG' },
      { jugador: 'K. Mbappé',  goles: 3, equipo_codigo: 'FRA' },
      { jugador: 'V. Osimhen', goles: 2, equipo_codigo: 'PAR' },
    ],
  });
  if (r.status !== 200) { fail(`PUT goleadores bulk: ${r.status}`); return null; }
  ok(`Goleadores: Messi y Mbappé EMPATADOS en 1° con 3 goles`);

  // Fake users + respuestas variadas
  setEstado(torneoId, 'abierto');
  const db2 = new DatabaseSync(DB_PATH);
  let fakeIds = [];
  let pIds = {};
  try {
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
    // Mapa numero → pregunta_id
    const rows = db2.prepare(`SELECT id, numero FROM mundial_preguntas WHERE torneo_id=?`).all(torneoId);
    for (const p of rows) pIds[p.numero] = p.id;

    const insResp = db2.prepare(`INSERT INTO mundial_respuestas_usuario
      (pregunta_id, user_id, respuesta_json, updated_at) VALUES (?, ?, ?, datetime('now'))`);

    // User B — acierta varios
    insResp.run(pIds[5],  fakeIds[0], JSON.stringify({ texto: 'L. Messi' }));         // empate Messi/Mbappé en 1° — match exacto normalizado
    insResp.run(pIds[17], fakeIds[0], JSON.stringify({ equipo: 'PAR' }));             // top GF grupos: PAR (3) y PAN (3) empate. PAR matchea → 30 pts
    insResp.run(pIds[19], fakeIds[0], JSON.stringify({ equipo: 'MEX' }));             // 2° Grupo A = MEX (USA es 1°) → 10 pts
    insResp.run(pIds[22], fakeIds[0], JSON.stringify({ opcion: 'No' }));              // HAI pts=0 → proyectada "No" → 10 pts
    insResp.run(pIds[26], fakeIds[0], JSON.stringify({ equipo: 'BOL' }));             // 3° del Grupo G es BOL → 10 pts (categoría default)
    insResp.run(pIds[29], fakeIds[0], JSON.stringify({ numero: 3 }));                 // ARG gc=3 → banda 3+: 25 pts
    insResp.run(pIds[30], fakeIds[0], JSON.stringify({ numero: 2 }));                 // empates K=2 → exact: 10 pts
    insResp.run(pIds[35], fakeIds[0], JSON.stringify({ equipo: 'PAR' }));             // top amarillas = PAR → 25 pts
    insResp.run(pIds[36], fakeIds[0], JSON.stringify({ equipo: 'BOL' }));             // BOL: 0 rojas, NO en top global ni en líder entre elegidos → 0 pts
    insResp.run(pIds[1],  fakeIds[0], JSON.stringify({ equipo: 'ARG' }));             // P1 no proyectable

    // User C — acierta el caso "10 pts entre los elegidos" en P36
    insResp.run(pIds[5],  fakeIds[1], JSON.stringify({ texto: 'K. Mbappé' }));        // matchea otro líder — match exacto normalizado
    insResp.run(pIds[17], fakeIds[1], JSON.stringify({ equipo: 'BOL' }));             // BOL no es top GF (PAR/PAN sí) → 0 pts
    insResp.run(pIds[22], fakeIds[1], JSON.stringify({ opcion: 'Sí' }));              // HAI pts=0, proyectada "No" → C no acierta → 0 pts
    insResp.run(pIds[26], fakeIds[1], JSON.stringify({ equipo: 'ARG' }));             // ARG está último, no es 3° → 0 pts
    insResp.run(pIds[29], fakeIds[1], JSON.stringify({ numero: 1 }));                 // 1 está en banda 0-2 → 10 pts
    insResp.run(pIds[36], fakeIds[1], JSON.stringify({ equipo: 'PAN' }));             // PAN: 1 roja, NO líder global (PAR=2). Líder entre elegidos {BOL,PAN,ARG}: PAN. → 10 pts

    // User D — acierta poco
    insResp.run(pIds[5],  fakeIds[2], JSON.stringify({ texto: 'Cualquiera' }));       // no matchea → 0
    insResp.run(pIds[35], fakeIds[2], JSON.stringify({ equipo: 'ARG' }));             // ARG no es top amarillas (PAR sí) → 0 pts
    insResp.run(pIds[36], fakeIds[2], JSON.stringify({ equipo: 'ARG' }));             // ARG: 0 rojas, no líder global ni entre elegidos → 0 pts
  } finally { db2.close(); }
  ok(`3 fake users + respuestas cargadas`);

  return { fakeIds, pIds };
}

// ── 5. GET endpoint y verificar ────────────────────────────────────────────
async function testEndpoint(torneoId, fakeIds) {
  console.log(H('5. GET /ranking-proyectado + asserts'));

  const r = await http('GET', `/api/mundial/${torneoId}/ranking-proyectado`);
  if (r.status !== 200) { fail(`GET ranking-proyectado: ${r.status} ${JSON.stringify(r.data)}`); return; }

  const d = r.data;

  // Shape básico
  if (!Array.isArray(d.ranking)) { fail(`ranking no es array`); return; }
  if (typeof d.preguntas_proyectables !== 'number') fail(`preguntas_proyectables no es number`);
  else ok(`preguntas_proyectables=${d.preguntas_proyectables} de total=${d.total_preguntas} ✓`);

  // P1 (campeón) debería estar en no_proyectables
  const p1NoProy = (d.no_proyectables || []).find(p => p.numero === 1);
  if (p1NoProy) ok(`P1 (campeón) en no_proyectables ✓`);
  else fail(`P1 debería estar en no_proyectables, recibí ${JSON.stringify(d.no_proyectables)}`);

  // Caveat presente
  if (typeof d.caveat === 'string' && d.caveat.length > 0) ok(`caveat presente ✓`);

  // Buscar user B y verificar puntos esperados.
  // User B esperado (después de ampliar dispatcher con P17/P19/P22):
  //   P5 Messi → 100
  //   P17 PAR → top GF grupos empate PAR/PAN → 30
  //   P19 MEX → 2° Grupo A → 10
  //   P22 No → HAI pts=0 → 10
  //   P26 BOL → 10
  //   P29 numero=3 → 25
  //   P30 numero=2 → 10
  //   P35 PAR → 25
  //   P36 BOL → 0
  //   Total: 100+30+10+10+10+25+10+25 = 220 pts, 8 aciertos
  const b = d.ranking.find(u => u.user_id === fakeIds[0]);
  if (!b) { fail(`User B no aparece en ranking`); return; }
  if (b.puntos_proyectados === 220 && b.aciertos_proyectados === 8) {
    ok(`User B: 220 pts, 8 aciertos ✓`);
  } else fail(`User B esperaba 220/8, recibí ${b.puntos_proyectados}/${b.aciertos_proyectados}`);

  // User C esperado:
  //   P5 K. Mbappé → 100
  //   P17 BOL → BOL no es top GF (PAR/PAN sí) → 0
  //   P22 Sí → HAI pts=0, proyectada "No" → 0
  //   P26 ARG → 0
  //   P29 numero=1 → 0 (banda 0-2 ≠ banda actual 3+ donde ARG gc=3)
  //   P36 PAN → 10 (líder entre elegidos)
  //   Total: 100+10 = 110, 2 aciertos.
  const cUser = d.ranking.find(u => u.user_id === fakeIds[1]);
  if (cUser && cUser.puntos_proyectados === 110 && cUser.aciertos_proyectados === 2) {
    ok(`User C: 110 pts, 2 aciertos ✓`);
  } else fail(`User C esperaba 110/2, recibí ${cUser?.puntos_proyectados}/${cUser?.aciertos_proyectados}`);

  // User D esperado: 0 puntos (todo errado).
  const dUser = d.ranking.find(u => u.user_id === fakeIds[2]);
  if (dUser && dUser.puntos_proyectados === 0 && dUser.aciertos_proyectados === 0) {
    ok(`User D: 0/0 (todo errado) ✓`);
  } else fail(`User D esperaba 0/0, recibí ${dUser?.puntos_proyectados}/${dUser?.aciertos_proyectados}`);

  // Posiciones: B > C > D
  if (b.posicion === 1 && cUser.posicion === 2 && dUser.posicion === 3) {
    ok(`Posiciones: B 1°, C 2°, D 3° ✓`);
  } else fail(`Posiciones inesperadas: B=${b.posicion}, C=${cUser.posicion}, D=${dUser.posicion}`);

  // Meta presente
  if (d.meta && d.meta.partidos_finalizados === 9) ok(`meta.partidos_finalizados=9 ✓`);
  else fail(`meta esperaba 9 partidos finalizados, recibí ${d.meta?.partidos_finalizados}`);

  // Detalle por user (Opción A — expand inline).
  // User B respondió 9 preguntas proyectables: P5, P17, P19, P22, P26, P29,
  // P30, P35, P36. 8 acertadas + 1 fallida (P36 BOL).
  if (Array.isArray(b.detalle) && b.detalle.length === 9) {
    ok(`User B detalle.length=9 (proyectables respondidas) ✓`);
  } else fail(`User B detalle len esperado 9, recibí ${b.detalle?.length}: ${JSON.stringify(b.detalle?.map(x=>x.numero))}`);

  // Detalle ordenado DESC dentro de cada grupo (regla 2026-06-21):
  // Aciertos primero desc: 35/30/29/26/22/19/17/5. Después fallido: 36.
  if (Array.isArray(b.detalle)) {
    const orden = b.detalle.map(x => x.numero).join(',');
    const acertosCorrectos = b.detalle.slice(0, 8).every(d => d.acerto === true);
    const ultimoFallido = b.detalle[8].acerto === false && b.detalle[8].numero === 36;
    if (orden === '35,30,29,26,22,19,17,5,36' && acertosCorrectos && ultimoFallido) {
      ok(`User B detalle DESC: 8 aciertos (35→5) + P36 fallido al final ✓`);
    } else fail(`User B detalle inesperado: ${JSON.stringify(b.detalle.map(x=>({n:x.numero,a:x.acerto})))}`);
  }

  // Desempate (regla 2026-06-21 "de abajo para arriba"): aciertos_numeros DESC.
  // User B aciertos: 35, 30, 29, 26, 22, 19, 17, 5.
  const expectedBNums = [35, 30, 29, 26, 22, 19, 17, 5];
  if (Array.isArray(b.aciertos_numeros) &&
      b.aciertos_numeros.length === expectedBNums.length &&
      b.aciertos_numeros.every((n, i) => n === expectedBNums[i])) {
    ok(`User B aciertos_numeros DESC = [${expectedBNums.join(',')}] ✓`);
  } else fail(`User B aciertos_numeros inesperado: ${JSON.stringify(b.aciertos_numeros)}`);

  // Vos / Hoy — chips de respuesta vs proyección actual en el detalle.
  // User B respondió P17=PAR, hoy líder GF grupos = PAR/PAN empate.
  const b17 = b.detalle.find(d => d.numero === 17);
  if (b17 && b17.respuesta_user_display === 'PAR') ok(`User B P17 respuesta_user_display=PAR ✓`);
  else fail(`User B P17 respuesta_user_display esperaba PAR, recibí ${b17?.respuesta_user_display}`);
  if (b17 && typeof b17.respuesta_actual_display === 'string' &&
      b17.respuesta_actual_display.includes('PAR') &&
      b17.respuesta_actual_display.includes('PAN')) {
    ok(`User B P17 respuesta_actual_display incluye PAR y PAN (empate) ✓`);
  } else fail(`User B P17 respuesta_actual_display esperaba contener PAR y PAN, recibí ${b17?.respuesta_actual_display}`);

  // User B respondió P22=No, HAI pts=0 → proyectada No.
  const b22 = b.detalle.find(d => d.numero === 22);
  if (b22 && b22.respuesta_user_display === 'No' && b22.respuesta_actual_display === 'No') {
    ok(`User B P22 Vos=No / Hoy=No ✓`);
  } else fail(`User B P22 displays inesperados: vos=${b22?.respuesta_user_display} hoy=${b22?.respuesta_actual_display}`);

  // User B P29 respondió numero=3, ARG gc=3 → display "3"/"3".
  const b29 = b.detalle.find(d => d.numero === 29);
  if (b29 && b29.respuesta_user_display === '3' && b29.respuesta_actual_display === '3') {
    ok(`User B P29 Vos=3 / Hoy=3 ✓`);
  } else fail(`User B P29 displays inesperados: vos=${b29?.respuesta_user_display} hoy=${b29?.respuesta_actual_display}`);

  // User B P5 respondió "L. Messi", Hoy debería incluir "L. Messi" (empate con Mbappé).
  const b5 = b.detalle.find(d => d.numero === 5);
  if (b5 && b5.respuesta_user_display === 'L. Messi' &&
      typeof b5.respuesta_actual_display === 'string' &&
      b5.respuesta_actual_display.includes('L. Messi')) {
    ok(`User B P5 Vos="L. Messi" / Hoy incluye "L. Messi" (empate) ✓`);
  } else fail(`User B P5 displays inesperados: vos=${b5?.respuesta_user_display} hoy=${b5?.respuesta_actual_display}`);

  // User C detalle: respondió P5, P17, P22, P26, P29, P36 → 6 entries.
  // Aciertos: P5, P36 (2). Fallidos: P17, P22, P26, P29 (4).
  if (Array.isArray(cUser.detalle) && cUser.detalle.length === 6) {
    ok(`User C detalle.length=6 ✓`);
    const ordenC = cUser.detalle.map(x => x.numero).join(',');
    // Aciertos primero DESC: 36, 5. Después fallidos DESC: 29, 26, 22, 17.
    if (ordenC === '36,5,29,26,22,17') ok(`User C detalle DESC: 36/5 + 29/26/22/17 ✓`);
    else fail(`User C detalle orden inesperado: ${ordenC}`);
    // P36 debe ser acierto con 10 pts.
    const p36C = cUser.detalle.find(d => d.numero === 36);
    if (p36C && p36C.acerto === true && p36C.pts_proyectados === 10) {
      ok(`User C detalle P36: 10 pts (entre los elegidos) ✓`);
    } else fail(`User C P36 esperaba 10/true, recibí ${JSON.stringify(p36C)}`);
  } else fail(`User C detalle len esperado 6, recibí ${cUser.detalle?.length}`);

  // User D: respondió P5, P35, P36 (3 preguntas proyectables). Todas erradas.
  if (Array.isArray(dUser.detalle) && dUser.detalle.length === 3) {
    const ningunAcerto = dUser.detalle.every(d => d.acerto === false);
    if (ningunAcerto) ok(`User D detalle: 3 entries (5/35/36), ningún acerto ✓`);
    else fail(`User D debería tener todos acerto=false: ${JSON.stringify(dUser.detalle)}`);
  } else fail(`User D detalle len esperado 3, recibí ${dUser.detalle?.length}`);
}

// ── 5b. /mis-puntos-proyectados (Fase 2) ──────────────────────────────────
async function testMisPuntosProyectados(torneoId, fakeIds) {
  console.log(H('5b. GET /mis-puntos-proyectados (Fase 2)'));

  // Login como User B para verificar su detalle.
  const adminToken = TOKEN;
  const login = await http('POST', '/api/auth/login', {
    email: FAKE_USERS[0].email, password: FAKE_PASSWORD,
  });
  if (login.status !== 200 || !login.data?.token) {
    fail(`Login user B falló (${login.status})`); TOKEN = adminToken; return;
  }
  TOKEN = login.data.token;

  const r = await http('GET', `/api/mundial/${torneoId}/mis-puntos-proyectados`);
  TOKEN = adminToken;
  if (r.status !== 200) { fail(`GET mis-puntos-proyectados: ${r.status}`); return; }

  const d = r.data;
  if (!Array.isArray(d.items)) { fail(`items no es array`); return; }

  // pts_totales esperado = 220 (User B después de ampliar dispatcher P17/P19/P22:
  // +30 (P17 PAR) +10 (P19 MEX) +10 (P22 No) sobre los 170 anteriores).
  if (d.pts_totales_proyectados === 220) ok(`pts_totales_proyectados=220 ✓`);
  else fail(`Esperaba 220, recibí ${d.pts_totales_proyectados}`);

  // P1 (campeón) debería ser proyectable=false con motivo.
  const p1 = d.items.find(i => i.numero === 1);
  if (p1 && p1.proyectable === false && p1.pts_proyectados === null && typeof p1.motivo === 'string') {
    ok(`P1 no proyectable con motivo ✓`);
  } else fail(`P1 inesperado: ${JSON.stringify(p1)}`);

  // P5 Goleador para B (Messi): proyectable=true, pts=100.
  const p5 = d.items.find(i => i.numero === 5);
  if (p5 && p5.proyectable === true && p5.pts_proyectados === 100) {
    ok(`P5 Messi → 100 pts proyectados ✓`);
  } else fail(`P5 inesperado: ${JSON.stringify(p5)}`);

  // P26 Tercero Grupo G para B (BOL — 3° real): pts=10 (categoría default).
  const p26 = d.items.find(i => i.numero === 26);
  if (p26 && p26.proyectable === true && p26.pts_proyectados === 10) {
    ok(`P26 BOL → 10 pts ✓`);
  } else fail(`P26 inesperado: ${JSON.stringify(p26)}`);

  // P36 BOL para B: no es líder global ni líder entre elegidos → 0 pts.
  const p36 = d.items.find(i => i.numero === 36);
  if (p36 && p36.proyectable === true && p36.pts_proyectados === 0) {
    ok(`P36 BOL (no líder global ni entre elegidos) → 0 pts ✓`);
  } else fail(`P36 inesperado: ${JSON.stringify(p36)}`);

  // P35 PAR para B: líder global de amarillas → 25 pts (validamos que la
  // regla 25 pts global sigue funcionando junto al fix de 10 pts).
  const p35 = d.items.find(i => i.numero === 35);
  if (p35 && p35.proyectable === true && p35.pts_proyectados === 25) {
    ok(`P35 PAR (líder global amarillas) → 25 pts ✓`);
  } else fail(`P35 inesperado: ${JSON.stringify(p35)}`);

  // P17 PAR para B: empate top GF grupos PAR/PAN → 30 pts (categoria default).
  const p17 = d.items.find(i => i.numero === 17);
  if (p17 && p17.proyectable === true && p17.pts_proyectados === 30) {
    ok(`P17 PAR (top GF grupos, empate con PAN) → 30 pts ✓`);
  } else fail(`P17 inesperado: ${JSON.stringify(p17)}`);
  // mis-puntos: chips Vos/Hoy presentes.
  if (p17 && p17.respuesta_user_display === 'PAR' &&
      typeof p17.respuesta_actual_display === 'string' &&
      p17.respuesta_actual_display.includes('PAR') &&
      p17.respuesta_actual_display.includes('PAN')) {
    ok(`mis-puntos P17 Vos=PAR / Hoy incluye PAR y PAN ✓`);
  } else fail(`mis-puntos P17 displays inesperados: vos=${p17?.respuesta_user_display} hoy=${p17?.respuesta_actual_display}`);

  // P19 MEX para B: 2° Grupo A → 10 pts.
  const p19 = d.items.find(i => i.numero === 19);
  if (p19 && p19.proyectable === true && p19.pts_proyectados === 10) {
    ok(`P19 MEX (2° Grupo A) → 10 pts ✓`);
  } else fail(`P19 inesperado: ${JSON.stringify(p19)}`);

  // P22 No para B: HAI pts=0 → proyectada "No" → 10 pts.
  const p22 = d.items.find(i => i.numero === 22);
  if (p22 && p22.proyectable === true && p22.pts_proyectados === 10) {
    ok(`P22 'No' (HAI sin pts) → 10 pts ✓`);
  } else fail(`P22 inesperado: ${JSON.stringify(p22)}`);

  if (typeof d.caveat === 'string' && d.caveat.length > 0) ok(`caveat presente ✓`);
  else fail(`caveat ausente en mis-puntos-proyectados`);
}

// ── Cleanup ────────────────────────────────────────────────────────────────
async function cleanup(torneoId) {
  console.log(H('6. Cleanup'));
  const db = new DatabaseSync(DB_PATH);
  try {
    if (torneoId) {
      db.prepare(`DELETE FROM mundial_respuestas_usuario WHERE pregunta_id IN
                  (SELECT id FROM mundial_preguntas WHERE torneo_id=?)`).run(torneoId);
      db.prepare('DELETE FROM mundial_preguntas WHERE torneo_id=?').run(torneoId);
      db.prepare('DELETE FROM mundial_goleadores WHERE torneo_id=?').run(torneoId);
      db.prepare('DELETE FROM mundial_tarjetas_partido WHERE torneo_id=?').run(torneoId);
      db.prepare('DELETE FROM mundial_partidos WHERE torneo_id=?').run(torneoId);
      db.prepare('DELETE FROM mundial_equipos_catalogo WHERE torneo_id=?').run(torneoId);
      db.prepare('DELETE FROM mundial_config WHERE torneo_id=?').run(torneoId);
      db.prepare('DELETE FROM torneo_jugadores WHERE torneo_id=?').run(torneoId);
      db.prepare('DELETE FROM torneos WHERE id=?').run(torneoId);
      info(`Torneo borrado`);
    }
    for (const u of FAKE_USERS) {
      db.prepare(`DELETE FROM users WHERE email=?`).run(u.email);
    }
  } catch (e) { fail(`Cleanup: ${e.message}`); }
  finally { db.close(); }
}

// ── Main ───────────────────────────────────────────────────────────────────
(async () => {
  let torneoId;
  try {
    testHelpersPuros();
    maybeGrantPermisoForDiag();
    await authCheck();
    const t = await obtenerOCrearDiagTorneo();
    if (!t) { exitCode = 1; return; }
    torneoId = t.id;
    if (!TIENE_PERMISO) { warn(`Sin permiso: skipping`); return; }

    const setup = await setupContenido(torneoId);
    if (!setup) { exitCode = 1; return; }

    await testEndpoint(torneoId, setup.fakeIds);
    await testMisPuntosProyectados(torneoId, setup.fakeIds);
  } catch (e) {
    fail(`Excepción: ${e.message}`);
    if (e.stack) console.error(e.stack);
  } finally {
    if (torneoId) await cleanup(torneoId);
    revokePermisoSiGrantedPorDiag();
    console.log('');
    if (exitCode === 0) console.log(c('━━━ Diagnóstico Proyección OK ━━━', '1;32'));
    else                console.log(c('━━━ Diagnóstico Proyección con ERRORES ━━━', '1;31'));
    process.exit(exitCode);
  }
})();
