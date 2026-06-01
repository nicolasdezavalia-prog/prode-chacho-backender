#!/usr/bin/env node
/**
 * Diagnóstico Fase 1 Mundial — schema/DB + HTTP real.
 *
 * Verifica:
 *   1. Schema/DB read-only: columna torneos.tipo, 9 tablas mundial_*, CHECK user_permisos,
 *      ausencia de seed automático de gestionar_mundial.
 *   2. Auth real: login contra /api/auth/login con DIAG_EMAIL/DIAG_PASSWORD.
 *   3. HTTP: GET/POST/PUT/PATCH a /api/mundial/* y /api/torneos/* (rechazo de cambio
 *      de tipo, defensa en recalcular-tabla).
 *
 * Usa un torneo de diagnóstico con nombre __DIAG_MUNDIAL_FASE1__ que se reusa si
 * ya existe. NO toca torneos reales, NO asigna permisos, NO borra nada.
 *
 * Config por variables de entorno (todas con fallback):
 *   DIAG_EMAIL       (default: admin@prode.com)
 *   DIAG_PASSWORD    (default: admin123)
 *   API_BASE_URL     (default: http://localhost:3001)
 *   DB_PATH          (default: ./prode.db relativo al script)
 *
 * Uso:
 *   cd backend
 *   node diagnostico-mundial-fase1.js
 *
 * Requiere: Node 22.5+ (node:sqlite, fetch global).
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DIAG_EMAIL       = process.env.DIAG_EMAIL    || 'admin@prode.com';
const DIAG_PASSWORD    = process.env.DIAG_PASSWORD || 'admin123';
const API_BASE_URL     = process.env.API_BASE_URL  || 'http://localhost:3001';
const DB_PATH          = process.env.DB_PATH       || path.join(__dirname, 'prode.db');
const DIAG_TORNEO_NOMBRE = '__DIAG_MUNDIAL_FASE1__';

const TABLAS_MUNDIAL_ESPERADAS = [
  'mundial_config',
  'mundial_equipos_catalogo',
  'mundial_preguntas',
  'mundial_resultados',
  'mundial_respuestas_usuario',
  'mundial_premios',
  'mundial_ventanas_cambios',
  'mundial_ventana_habilitados',
  'mundial_cambios_respuesta',
];

// ── pintura ─────────────────────────────────────────────────────────────────
const c    = (txt, code) => `[${code}m${txt}[0m`;
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
  try {
    res = await fetch(url, opts);
  } catch (e) {
    return { status: 0, error: e.message };
  }
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

// ── 1. DB checks ────────────────────────────────────────────────────────────
function dbChecks() {
  console.log(H('1. Schema/DB (read-only)'));
  let db;
  try {
    db = new DatabaseSync(DB_PATH);
  } catch (e) {
    fail(`No pude abrir la DB en ${DB_PATH}: ${e.message}`);
    process.exit(1);
  }

  // torneos.tipo
  const torneosCols = db.prepare("PRAGMA table_info('torneos')").all();
  const tipoCol = torneosCols.find(col => col.name === 'tipo');
  if (!tipoCol) {
    fail(`Columna 'tipo' NO existe en 'torneos'`);
  } else {
    ok(`torneos.tipo existe (type=${tipoCol.type}, notnull=${tipoCol.notnull})`);
    const dflt = String(tipoCol.dflt_value || '').replace(/'/g, '');
    if (dflt === 'prode_semestral') {
      ok(`torneos.tipo DEFAULT = 'prode_semestral' ✓`);
    } else {
      fail(`torneos.tipo DEFAULT esperado 'prode_semestral', encontrado: ${tipoCol.dflt_value}`);
    }
  }

  // Sin NULLs
  const nulls = db.prepare('SELECT COUNT(*) AS n FROM torneos WHERE tipo IS NULL').get();
  if (nulls.n === 0) ok(`Sin filas torneos.tipo IS NULL`);
  else fail(`${nulls.n} fila(s) con torneos.tipo IS NULL`);

  // Distribución
  const dist = db.prepare('SELECT tipo, COUNT(*) AS n FROM torneos GROUP BY tipo ORDER BY tipo').all();
  if (dist.length === 0) {
    info(`No hay torneos en DB todavía.`);
  } else {
    for (const r of dist) info(`tipo='${r.tipo}': ${r.n} torneo(s)`);
  }

  // 9 tablas mundial_*
  const tablasReales = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'mundial_%' ORDER BY name"
  ).all().map(r => r.name);
  for (const t of TABLAS_MUNDIAL_ESPERADAS) {
    if (tablasReales.includes(t)) ok(`Tabla ${t} existe`);
    else fail(`Tabla ${t} NO existe`);
  }
  const extras = tablasReales.filter(t => !TABLAS_MUNDIAL_ESPERADAS.includes(t));
  if (extras.length > 0) warn(`Tablas mundial_* no esperadas (¿adelantadas?): ${extras.join(', ')}`);

  // CHECK user_permisos
  const upSchema = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='user_permisos'"
  ).get();
  if (!upSchema) {
    fail(`Tabla user_permisos no existe`);
  } else if (upSchema.sql.includes('gestionar_mundial')) {
    ok(`user_permisos CHECK incluye 'gestionar_mundial'`);
  } else {
    fail(`user_permisos CHECK NO incluye 'gestionar_mundial' (¿migración no corrió?)`);
  }

  // Sin seed automático
  const cnt = db.prepare(
    "SELECT COUNT(*) AS n FROM user_permisos WHERE permiso = 'gestionar_mundial'"
  ).get();
  if (cnt.n === 0) {
    ok(`Sin seed automático: 0 filas con permiso='gestionar_mundial'`);
  } else {
    warn(`Hay ${cnt.n} fila(s) con permiso='gestionar_mundial'. NO vino de seed masivo (la migración no lo hace) — fue asignado manual o por otro proceso.`);
    const usuarios = db.prepare(`
      SELECT up.user_id, u.email, u.role
      FROM user_permisos up JOIN users u ON up.user_id = u.id
      WHERE up.permiso = 'gestionar_mundial'
    `).all();
    for (const u of usuarios) info(`  user_id=${u.user_id} email=${u.email} role=${u.role}`);
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
    info(`Configurá DIAG_EMAIL y DIAG_PASSWORD con credenciales reales.`);
    process.exit(1);
  }
  TOKEN = r.data.token;
  USER  = r.data.user;
  ok(`Login OK — id=${USER.id} email=${USER.email} role=${USER.role}`);

  // Permisos del user
  const perms = await http('GET', '/api/permisos/me');
  if (perms.status === 200 && perms.data && Array.isArray(perms.data.permisos)) {
    TIENE_PERMISO_MUNDIAL = perms.data.permisos.includes('gestionar_mundial');
    if (USER.role === 'superadmin') {
      ok(`Es superadmin: bypass de permisos (operaciones admin pasan).`);
      TIENE_PERMISO_MUNDIAL = true;
    } else if (TIENE_PERMISO_MUNDIAL) {
      ok(`Tiene 'gestionar_mundial' asignado manualmente.`);
    } else {
      warn(`Usuario sin 'gestionar_mundial'. Endpoints admin Mundial van a devolver 403.`);
      warn(`Para diagnóstico completo: corré el script con un superadmin, o asigná el permiso desde /admin/permisos.`);
    }
  } else {
    warn(`No pude leer /api/permisos/me (status ${perms.status}). Asumo que NO tiene permiso.`);
  }
}

// ── 3. HTTP tests ───────────────────────────────────────────────────────────
async function listarMundialTorneos() {
  console.log(H('3.1 GET /api/mundial/torneos'));
  const r = await http('GET', '/api/mundial/torneos');
  if (r.status === 200 && Array.isArray(r.data)) {
    ok(`200 con array (${r.data.length} torneo(s) Mundial)`);
    return r.data;
  }
  fail(`Esperaba 200 con array, recibí ${r.status}: ${JSON.stringify(r.data)}`);
  return [];
}

async function obtenerOCrearDiagTorneo() {
  console.log(H('3.2 Obtener o crear torneo de diagnóstico'));
  const todos = await http('GET', '/api/torneos');
  if (todos.status !== 200) {
    fail(`No pude listar /api/torneos (status ${todos.status})`);
    return null;
  }
  const existente = (todos.data || []).find(t => t.nombre === DIAG_TORNEO_NOMBRE);
  if (existente) {
    info(`Reusando torneo existente: id=${existente.id} tipo='${existente.tipo}'`);
    if (existente.tipo !== 'mundial_preguntas') {
      fail(`El torneo de diag existe pero tiene tipo='${existente.tipo}'. Borralo a mano para regenerarlo.`);
      return null;
    }
    ok(`Torneo de diag id=${existente.id} reusable`);
    return existente;
  }
  // Crear
  const created = await http('POST', '/api/torneos', {
    nombre: DIAG_TORNEO_NOMBRE,
    semestre: '2026-DIAG',
    tipo: 'mundial_preguntas',
  });
  if (created.status === 201) {
    ok(`Torneo de diag creado id=${created.data.id} tipo='${created.data.tipo}'`);
    return created.data;
  }
  if (created.status === 403) {
    fail(`Crear torneo falló 403 — tu usuario no tiene 'crear_torneo'. Corré con superadmin o asigná el permiso.`);
  } else {
    fail(`Crear torneo falló (status ${created.status}): ${JSON.stringify(created.data)}`);
  }
  return null;
}

async function verEnListaMundial(torneoId) {
  console.log(H('3.3 Aparece en GET /api/mundial/torneos'));
  const r = await http('GET', '/api/mundial/torneos');
  if (r.status === 200 && Array.isArray(r.data) && r.data.find(t => t.id === torneoId)) {
    ok(`Torneo id=${torneoId} aparece en lista Mundial ✓`);
  } else {
    fail(`Torneo id=${torneoId} NO aparece en lista Mundial`);
  }
}

async function checkConfig(torneoId) {
  console.log(H('3.4 GET /api/mundial/:id/config — sin TC'));
  const r = await http('GET', `/api/mundial/${torneoId}/config`);
  if (r.status !== 200) {
    fail(`status ${r.status}: ${JSON.stringify(r.data)}`);
    return;
  }
  const cfg = r.data;
  const esperados = ['estado', 'costo_cambio_usd', 'cambios_por_usuario', 'deadline_carga'];
  for (const k of esperados) {
    if (!(k in cfg)) fail(`Falta campo '${k}' en config`);
  }
  const camposTC = ['tc_blue_ars', 'tc_blue_ars_snapshot', 'tc', 'tc_blue'];
  let tieneTC = false;
  for (const k of camposTC) {
    if (k in cfg) { fail(`Campo TC '${k}' aparece en config (NO debería)`); tieneTC = true; }
  }
  if (!tieneTC) ok(`Sin campos de TC en config ✓`);
  info(`estado='${cfg.estado}', costo_cambio_usd=${cfg.costo_cambio_usd}, cambios_por_usuario=${cfg.cambios_por_usuario}`);
}

async function checkConfigPut(torneoId) {
  console.log(H('3.5 PUT /api/mundial/:id/config — costo_cambio_usd'));
  if (!TIENE_PERMISO_MUNDIAL) {
    info(`Skip: usuario sin 'gestionar_mundial' (esperaríamos 403).`);
    const r = await http('PUT', `/api/mundial/${torneoId}/config`, { costo_cambio_usd: 42 });
    if (r.status === 403) ok(`Confirmado: PUT config → 403 ✓ (sin permiso)`);
    else fail(`Esperaba 403, recibí ${r.status}: ${JSON.stringify(r.data)}`);
    return;
  }
  const target = 42;
  const r = await http('PUT', `/api/mundial/${torneoId}/config`, { costo_cambio_usd: target });
  if (r.status === 200 && r.data && r.data.costo_cambio_usd === target) {
    ok(`PUT costo_cambio_usd=${target} → 200 y persistió ✓`);
  } else {
    fail(`PUT config inesperado (status ${r.status}): ${JSON.stringify(r.data)}`);
  }
}

async function checkConfigTC(torneoId) {
  console.log(H('3.6 PUT /api/mundial/:id/config con tc_blue_ars (debe rechazar o no persistir)'));
  if (!TIENE_PERMISO_MUNDIAL) {
    info(`Skip: usuario sin permiso. (Para test real: correr como superadmin.)`);
    return;
  }
  const r = await http('PUT', `/api/mundial/${torneoId}/config`, { tc_blue_ars: 1200 });
  if (r.status === 400) {
    ok(`PUT tc_blue_ars → 400 ✓ (rechazo explícito)`);
  } else if (r.status === 200) {
    const despues = await http('GET', `/api/mundial/${torneoId}/config`);
    if ('tc_blue_ars' in (despues.data || {})) {
      fail(`PUT 200 y tc_blue_ars APARECIÓ en GET — NO debe persistir`);
    } else {
      warn(`PUT 200 pero sin persistir (silent ignore). Seguro pero esperábamos 400 explícito.`);
    }
  } else {
    fail(`PUT inesperado (status ${r.status}): ${JSON.stringify(r.data)}`);
  }
}

async function checkEquipos(torneoId) {
  console.log(H('3.7 POST /equipos con ARG y duplicado'));
  if (!TIENE_PERMISO_MUNDIAL) {
    info(`Skip: usuario sin permiso. (Esperaríamos 403 en POST.)`);
    const r = await http('POST', `/api/mundial/${torneoId}/equipos`, { codigo: 'ARG', nombre: 'Argentina', grupo: 'J' });
    if (r.status === 403) ok(`Confirmado: POST equipos → 403 ✓`);
    else fail(`Esperaba 403, recibí ${r.status}: ${JSON.stringify(r.data)}`);
    return;
  }

  const r1 = await http('POST', `/api/mundial/${torneoId}/equipos`, { codigo: 'ARG', nombre: 'Argentina', grupo: 'J' });
  if (r1.status === 201) {
    ok(`POST ARG → 201 (id=${r1.data.id})`);
  } else if (r1.status === 409) {
    info(`ARG ya existía (409). Reuso.`);
  } else {
    fail(`POST ARG inesperado (status ${r1.status}): ${JSON.stringify(r1.data)}`);
    return;
  }
  const r2 = await http('POST', `/api/mundial/${torneoId}/equipos`, { codigo: 'ARG', nombre: 'Argentina', grupo: 'J' });
  if (r2.status === 409) ok(`POST ARG (repetido) → 409 ✓`);
  else fail(`POST ARG repetido esperado 409, recibí ${r2.status}: ${JSON.stringify(r2.data)}`);
}

async function checkPremios(torneoId) {
  console.log(H('3.8 PUT /premios/bulk — USD pos/neg + ars_manual'));
  if (!TIENE_PERMISO_MUNDIAL) {
    info(`Skip: usuario sin permiso. (Esperaríamos 403.)`);
    const r = await http('PUT', `/api/mundial/${torneoId}/premios/bulk`, { premios: [{ posicion: 1, usd: 1 }] });
    if (r.status === 403) ok(`Confirmado: PUT premios → 403 ✓`);
    else fail(`Esperaba 403, recibí ${r.status}: ${JSON.stringify(r.data)}`);
    return;
  }
  const body = {
    premios: [
      { posicion: 1,  usd:  200, ars_manual: 240000 },
      { posicion: 2,  usd:   50 },
      { posicion: 3,  usd:   25, ars_manual: 30000 },
      { posicion: 13, usd:  -50 },
    ],
  };
  const r = await http('PUT', `/api/mundial/${torneoId}/premios/bulk`, body);
  if (r.status !== 200 || !Array.isArray(r.data)) {
    fail(`PUT premios bulk inesperado (status ${r.status}): ${JSON.stringify(r.data)}`);
    return;
  }
  ok(`PUT premios bulk → 200 con ${r.data.length} fila(s)`);
  const p1  = r.data.find(p => p.posicion === 1);
  const p13 = r.data.find(p => p.posicion === 13);
  if (p1  && p1.usd  ===  200 && p1.ars_manual === 240000) ok(`pos 1: usd=200, ars_manual=240000 ✓`);
  else                                                      fail(`pos 1: ${JSON.stringify(p1)}`);
  if (p13 && p13.usd === -50)                                ok(`pos 13: usd=-50 (negativo aceptado) ✓`);
  else                                                       fail(`pos 13: ${JSON.stringify(p13)}`);
}

async function checkTipoInmutable(torneoId) {
  console.log(H('3.9 PATCH /api/torneos/:id { tipo: ... } debe ser 409'));
  const r = await http('PATCH', `/api/torneos/${torneoId}`, { tipo: 'prode_semestral' });
  if (r.status === 409) ok(`PATCH con tipo → 409 ✓ (tipo inmutable post-creación)`);
  else                  fail(`Esperaba 409, recibí ${r.status}: ${JSON.stringify(r.data)}`);
}

async function checkRecalcular(torneoId) {
  console.log(H('4. POST /api/torneos/:id/recalcular-tabla sobre torneo Mundial'));
  const r = await http('POST', `/api/torneos/${torneoId}/recalcular-tabla`);
  if (r.status === 400) ok(`Recalcular tabla en torneo Mundial → 400 ✓ (defensa OK)`);
  else                  fail(`Esperaba 400, recibí ${r.status}: ${JSON.stringify(r.data)}`);
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(c('Diagnóstico Fase 1 Mundial — schema/DB + HTTP real', '1;37'));
  console.log(c(`Torneo de diag: ${DIAG_TORNEO_NOMBRE}`, '90'));
  console.log(c(`DB_PATH: ${DB_PATH}`, '90'));

  try { dbChecks(); }
  catch (e) { fail(`Error en DB checks: ${e.message}`); process.exit(1); }

  await authCheck();
  await listarMundialTorneos();
  const t = await obtenerOCrearDiagTorneo();
  if (!t) {
    console.log(H('Fin'));
    fail('No se pudo obtener torneo de diag. HTTP no probado completamente.');
    process.exit(exitCode);
  }
  await verEnListaMundial(t.id);
  await checkConfig(t.id);
  await checkConfigPut(t.id);
  await checkConfigTC(t.id);
  await checkEquipos(t.id);
  await checkPremios(t.id);
  await checkTipoInmutable(t.id);
  await checkRecalcular(t.id);

  console.log(H('Resultado'));
  if (exitCode === 0) console.log(OK('Diagnóstico Fase 1 Mundial: TODO OK'));
  else                console.log(FAIL('Diagnóstico encontró problemas (revisar arriba)'));
  process.exit(exitCode);
}

main().catch(e => { console.error(e); process.exit(1); });
