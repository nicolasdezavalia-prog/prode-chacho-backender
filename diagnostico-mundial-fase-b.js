/**
 * diagnostico-mundial-fase-b.js — Fase B: normalización + alias en Resultados.
 *
 * READ-ONLY. No escribe nada en la DB.
 *
 * Verifica:
 *   1. Regresión de scoring: para TODOS los resultados ya guardados (que no
 *      tienen `alias`), los puntos por (pregunta, user) calculados por el
 *      código nuevo son IDÉNTICOS a los del algoritmo Fase 3 (replicado acá
 *      de forma independiente).
 *   2. Normalización extendida: casos canónicos (tildes, mayúsculas, puntos,
 *      comillas, espacios dobles, guiones).
 *   3. matchTexto: precedencia override → exacto/normalizado → alias → sin_match.
 *   4. Validador: acepta alias/texto_display válidos y rechaza inválidos.
 *   5. Inventario informativo de respuestas de texto agrupadas por normalizado
 *      (insumo para definir alias), por torneo.
 *
 * Uso:
 *   node diagnostico-mundial-fase-b.js                  → DB local (backend/prode.db) — DECLARADO como local
 *   DB_PATH=/data/prode.db node diagnostico-mundial-fase-b.js   → producción (correr dentro de Fly)
 *
 * Regla operativa (2026-06-10): este script declara SIEMPRE contra qué DB corre
 * y NO asume torneo_id — itera todos los torneos tipo 'mundial_preguntas'.
 */

const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { normalizarTexto, matchTexto, calcularPuntosPregunta } = require('./src/logic/mundial-scoring');
const { validarResultado } = require('./src/logic/mundial-validar-resultado');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'prode.db');
const esProd = !!process.env.DB_PATH;

let fallos = 0;
function check(nombre, cond, detalle) {
  if (cond) { console.log(`  OK   ${nombre}`); }
  else { fallos++; console.log(`  FAIL ${nombre}${detalle ? ' — ' + detalle : ''}`); }
}

function parseSafe(s) { if (!s) return {}; try { return JSON.parse(s) || {} } catch { return {} } }

// ── Algoritmo Fase 3 replicado de forma independiente (referencia de regresión) ──
function normalizarViejo(s) {
  if (typeof s !== 'string') return '';
  const nfd = s.normalize('NFD');
  let out = '';
  for (let i = 0; i < nfd.length; i++) {
    const c = nfd.charCodeAt(i);
    if (c >= 0x0300 && c <= 0x036F) continue;
    out += nfd[i];
  }
  return out.toLowerCase().trim();
}
function puntosTextoViejo(cfg, res, resp, userId) {
  if (res?.overrides_pts && typeof res.overrides_pts === 'object' && userId != null) {
    const ov = res.overrides_pts[String(userId)];
    if (Number.isInteger(ov)) return ov;
  }
  const a = normalizarViejo(res?.texto), b = normalizarViejo(resp?.texto);
  if (!a || !b) return 0;
  if (a !== b) return 0;
  if (Number.isInteger(res?.pts_si_acierta)) return res.pts_si_acierta;
  if (Number.isInteger(cfg.pts_max)) return cfg.pts_max;
  return 0;
}

console.log('════════════════════════════════════════════════════════');
console.log('DIAGNÓSTICO FASE B — normalización + alias');
console.log(`DB: ${DB_PATH}  →  ${esProd ? 'PRODUCCIÓN (DB_PATH seteado)' : '*** DB LOCAL DE DESARROLLO — NO refleja producción ***'}`);
console.log('Modo: READ-ONLY (la conexión rechaza escrituras)');
console.log('════════════════════════════════════════════════════════\n');

const db = new DatabaseSync(DB_PATH, { readOnly: true });

// ── 1) Regresión sobre resultados guardados ─────────────────────────────────
console.log('1) REGRESIÓN: resultados guardados puntúan idéntico (nuevo vs Fase 3)');
const torneos = db.prepare("SELECT id, nombre FROM torneos WHERE tipo = 'mundial_preguntas' ORDER BY id").all();
let comparaciones = 0, difs = 0;
for (const t of torneos) {
  const filas = db.prepare(`
    SELECT p.id pregunta_id, p.numero, p.tipo_pregunta, p.config_json, r.resultado_json
    FROM mundial_resultados r JOIN mundial_preguntas p ON p.id = r.pregunta_id
    WHERE p.torneo_id = ?
  `).all(t.id);
  for (const f of filas) {
    const cfg = parseSafe(f.config_json);
    const res = parseSafe(f.resultado_json);
    const conAlias = Array.isArray(res.alias) && res.alias.length > 0;
    const respuestas = db.prepare(`
      SELECT ru.user_id, ru.respuesta_json FROM mundial_respuestas_usuario ru WHERE ru.pregunta_id = ?
    `).all(f.pregunta_id);
    for (const r of respuestas) {
      const resp = parseSafe(r.respuesta_json);
      const nuevo = calcularPuntosPregunta(f.tipo_pregunta, cfg, res, resp, r.user_id);
      let viejo;
      if (f.tipo_pregunta === 'respuesta_manual' || f.tipo_pregunta === 'regla_especial') {
        viejo = puntosTextoViejo(cfg, res, resp, r.user_id);
      } else {
        viejo = nuevo; // tipos no-texto: código sin cambios, no hay nada que comparar
      }
      comparaciones++;
      if (!conAlias && nuevo !== viejo) {
        difs++;
        console.log(`  DIF torneo ${t.id} P${f.numero} user ${r.user_id}: nuevo=${nuevo} viejo=${viejo} resp=${JSON.stringify(resp)}`);
      }
    }
  }
}
check(`${comparaciones} comparaciones (pregunta,user) sin diferencias en resultados sin alias`, difs === 0, `${difs} diferencias`);

// ── 2) Normalización extendida ───────────────────────────────────────────────
console.log('\n2) NORMALIZACIÓN EXTENDIDA');
const casosNorm = [
  ['Mbappé', 'mbappe'], ['MBAPPE', 'mbappe'], ['Unai Simón', 'unai simon'],
  ['E. Martínez', 'e martinez'], ['Emiliano "Dibu" Martínez', 'emiliano dibu martinez'],
  ['Saint-Maximin', 'saint maximin'], ['  doble   espacio  ', 'doble espacio'],
  ["O'Reilly", 'oreilly'], ['Lamine Yamal', 'lamine yamal'],
];
for (const [inp, esp] of casosNorm) {
  check(`normalizar(${JSON.stringify(inp)}) = ${JSON.stringify(esp)}`, normalizarTexto(inp) === esp, `obtuve ${JSON.stringify(normalizarTexto(inp))}`);
}
// Compatibilidad: todo lo que matcheaba con la normalización vieja sigue matcheando
const paresViejosMatch = [['Mbappé', 'mbappe'], ['Unai Simón', 'unai simon'], ['Dibu Martínez', 'dibu martinez']];
for (const [a, b] of paresViejosMatch) {
  check(`compat: "${a}" sigue matcheando "${b}"`, normalizarTexto(a) === normalizarTexto(b));
}

// ── 3) matchTexto: precedencia ───────────────────────────────────────────────
console.log('\n3) MATCH TEXTO: precedencia override → exacto/normalizado → alias → sin_match');
const cfgT = { pts_max: 30 };
const resT = { texto: 'E. Martinez', texto_display: 'E. Martínez', alias: ['Dibu', 'Dibu Martinez', 'Emiliano Martinez'], pts_si_acierta: 30, overrides_pts: { '9': 12 } };
const casosMatch = [
  ['E. Martinez', 1, 'exacto', 30], ['e martínez', 1, 'normalizado', 30],
  ['DIBU', 1, 'alias', 30], ['dibu martínez', 1, 'alias', 30],
  ['Emiliano Martínez', 1, 'alias', 30], ['Unai Simon', 1, 'sin_match', 0],
  ['cualquiera', 9, 'override', 12],
];
for (const [texto, uid, matchEsp, ptsEsp] of casosMatch) {
  const m = matchTexto(cfgT, resT, { texto }, uid);
  check(`"${texto}" (user ${uid}) → ${matchEsp}:${ptsEsp}`, m.match === matchEsp && m.pts === ptsEsp, `obtuve ${m.match}:${m.pts}`);
}
// Sin alias en el resultado → comportamiento Fase 3 puro
const resSin = { texto: 'Kane', pts_si_acierta: 75 };
check('sin alias: "KANE" → normalizado:75', (() => { const m = matchTexto({ pts_max: 75 }, resSin, { texto: 'KANE' }, 1); return m.match === 'normalizado' && m.pts === 75 })());
check('sin alias: "Olise" → sin_match:0', (() => { const m = matchTexto({ pts_max: 75 }, resSin, { texto: 'Olise' }, 1); return m.match === 'sin_match' && m.pts === 0 })());

// ── 4) Validador ─────────────────────────────────────────────────────────────
console.log('\n4) VALIDADOR DE RESULTADO (claves nuevas opcionales)');
const cfgV = { pts_max: 30 };
check('acepta resultado SIN alias (compat)', validarResultado('respuesta_manual', cfgV, { texto: 'Kane' }).ok === true);
check('acepta alias válidos + texto_display', validarResultado('respuesta_manual', cfgV, { texto: 'E. Martinez', texto_display: 'E. Martínez', alias: ['Dibu', 'Emiliano Martinez'] }).ok === true);
check('rechaza alias no-array', validarResultado('respuesta_manual', cfgV, { texto: 'X', alias: 'Dibu' }).ok === false);
check('rechaza alias con entrada vacía', validarResultado('respuesta_manual', cfgV, { texto: 'X', alias: ['Dibu', '  '] }).ok === false);
check('rechaza alias duplicados post-normalización', validarResultado('respuesta_manual', cfgV, { texto: 'X', alias: ['Dibu', 'DIBU'] }).ok === false);
check('rechaza texto_display vacío', validarResultado('respuesta_manual', cfgV, { texto: 'X', texto_display: ' ' }).ok === false);
check('regla_especial: mismas reglas', validarResultado('regla_especial', cfgV, { texto: 'X', alias: ['y'] }).ok === true);

// ── 5) Inventario informativo: respuestas texto agrupadas por normalizado ───
console.log('\n5) INVENTARIO (informativo): respuestas de texto por normalizado');
for (const t of torneos) {
  const pt = db.prepare(`
    SELECT p.id, p.numero, p.enunciado FROM mundial_preguntas p
    WHERE p.torneo_id = ? AND p.tipo_pregunta IN ('respuesta_manual','regla_especial') AND p.activa = 1
    ORDER BY p.numero
  `).all(t.id);
  if (pt.length === 0) continue;
  console.log(`  Torneo ${t.id} (${t.nombre}):`);
  for (const p of pt) {
    const rows = db.prepare('SELECT respuesta_json FROM mundial_respuestas_usuario WHERE pregunta_id = ?').all(p.id);
    const g = new Map();
    for (const r of rows) {
      const tx = parseSafe(r.respuesta_json).texto || '';
      const k = normalizarTexto(tx);
      if (!g.has(k)) g.set(k, { n: 0, variantes: new Set() });
      g.get(k).n++; g.get(k).variantes.add(tx);
    }
    const det = [...g.entries()].map(([k, v]) => `${JSON.stringify(k)}×${v.n}${v.variantes.size > 1 ? ' (' + [...v.variantes].join(' | ') + ')' : ''}`).join(', ');
    console.log(`    P${p.numero} ${p.enunciado}: ${rows.length} respuestas, ${g.size} grupos → ${det || '(sin respuestas)'}`);
  }
}

console.log('\n════════════════════════════════════════════════════════');
console.log(fallos === 0 ? 'RESULTADO: TODO OK ✔' : `RESULTADO: ${fallos} FALLOS ✘`);
console.log('════════════════════════════════════════════════════════');
process.exit(fallos === 0 ? 0 : 1);
