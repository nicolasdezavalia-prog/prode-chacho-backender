/**
 * diagnostico-mundial-sprint-final.js — Sprint Final Mundial, base C1.
 *
 * READ-ONLY. No escribe nada en la DB.
 *
 * Verifica (C1):
 *   1. Tablas nuevas existen (mundial_partidos, mundial_goleadores,
 *      mundial_premios_individuales) con sus columnas clave.
 *   2. Validador de partido: casos válidos e inválidos (unit, sin DB).
 *   3. Integridad del fixture cargado, por torneo: equipos en catálogo,
 *      grupo coherente con catálogo, finalizados con goles, penales solo KO,
 *      (ronda, orden) únicos, rondas válidas.
 *   4. Regla de fuente de tarjetas: 'fixture' si >=1 finalizado, sino 'matriz'.
 *   5. Comparación matriz legacy vs fixture (totales amarillas/rojas por
 *      equipo) cuando AMBAS fuentes tienen datos — reporta diferencias.
 *   6. NO-impacto: counts de respuestas/resultados/preguntas (el fixture no
 *      toca nada existente).
 *
 * Uso:
 *   node diagnostico-mundial-sprint-final.js                → DB local (DECLARADA local)
 *   DB_PATH=/data/prode.db node diagnostico-mundial-sprint-final.js  → producción (en Fly)
 *
 * Regla operativa: declara SIEMPRE contra qué DB corre y NO asume torneo_id.
 */

const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { validarPartido, validarPartidosBulk, RONDAS } = require('./src/logic/mundial-validar-partido');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'prode.db');
const esProd = !!process.env.DB_PATH;

let fallos = 0;
function check(nombre, cond, detalle) {
  if (cond) console.log(`  OK   ${nombre}`);
  else { fallos++; console.log(`  FAIL ${nombre}${detalle ? ' — ' + detalle : ''}`); }
}

console.log('════════════════════════════════════════════════════════');
console.log('DIAGNÓSTICO SPRINT FINAL — C1 fixture backend');
console.log(`DB: ${DB_PATH}  →  ${esProd
  ? (DB_PATH === '/data/prode.db' ? 'PRODUCCIÓN (/data/prode.db en Fly)' : `DB_PATH custom (${DB_PATH}) — NO es la ruta de producción`)
  : '*** DB LOCAL DE DESARROLLO — NO refleja producción ***'}`);
console.log('Modo: READ-ONLY');
console.log('════════════════════════════════════════════════════════\n');

const db = new DatabaseSync(DB_PATH, { readOnly: true });

// ── 1) Tablas nuevas ─────────────────────────────────────────────────────────
console.log('1) TABLAS NUEVAS');
for (const t of ['mundial_partidos', 'mundial_goleadores', 'mundial_premios_individuales']) {
  const existe = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
  check(`tabla ${t} existe`, existe);
}
if (db.prepare("SELECT name FROM sqlite_master WHERE name='mundial_partidos'").get()) {
  const cols = db.prepare('PRAGMA table_info(mundial_partidos)').all().map(c => c.name);
  for (const c of ['ronda', 'grupo', 'orden', 'equipo_local', 'equipo_visitante', 'goles_local',
    'amarillas_local', 'amarillas_visitante', 'rojas_local', 'rojas_visitante', 'penales_local', 'estado']) {
    check(`mundial_partidos.${c}`, cols.includes(c));
  }
}

// ── 2) Validador (unit, sin DB) ──────────────────────────────────────────────
console.log('\n2) VALIDADOR DE PARTIDO');
const base = { ronda: 'grupos', grupo: 'A', orden: 1, equipo_local: 'MEX', equipo_visitante: 'SUD' };
check('válido mínimo (pendiente sin goles)', validarPartido(base).ok === true);
check('válido finalizado con goles y tarjetas', validarPartido({
  ...base, goles_local: 1, goles_visitante: 0, amarillas_local: 1, amarillas_visitante: 2, rojas_local: 0, rojas_visitante: 0, estado: 'finalizado',
}).ok === true);
check('rechaza ronda inválida', validarPartido({ ...base, ronda: 'cuartos' }).ok === false);
check('rechaza grupos sin grupo', validarPartido({ ...base, grupo: undefined }).ok === false);
check('rechaza grupo en ronda KO', validarPartido({ ...base, ronda: 'semis', grupo: 'A' }).ok === false);
check('rechaza equipo vs sí mismo', validarPartido({ ...base, equipo_visitante: 'MEX' }).ok === false);
check('rechaza finalizado sin goles', validarPartido({ ...base, estado: 'finalizado' }).ok === false);
check('rechaza penales en grupos', validarPartido({ ...base, penales_local: 4 }).ok === false);
check('acepta penales en KO', validarPartido({ ronda: '4tos', orden: 1, equipo_local: 'ARG', equipo_visitante: 'FRA', goles_local: 2, goles_visitante: 2, penales_local: 4, penales_visitante: 2, estado: 'finalizado' }).ok === true);
check('rechaza tarjetas negativas', validarPartido({ ...base, amarillas_local: -1 }).ok === false);
check('bulk rechaza (ronda,orden) duplicado', validarPartidosBulk({ partidos: [base, { ...base, equipo_local: 'ARG', equipo_visitante: 'FRA' }] }).ok === false);
check('bulk acepta payload válido', validarPartidosBulk({ partidos: [base, { ...base, orden: 2, equipo_local: 'ARG', equipo_visitante: 'FRA', grupo: 'A' }] }).ok === true);

// ── 3-5) Por torneo ──────────────────────────────────────────────────────────
const torneos = db.prepare("SELECT id, nombre FROM torneos WHERE tipo = 'mundial_preguntas' ORDER BY id").all();
for (const t of torneos) {
  console.log(`\n3-5) TORNEO ${t.id} (${t.nombre})`);
  const partidos = db.prepare('SELECT * FROM mundial_partidos WHERE torneo_id = ?').all(t.id);
  const finalizados = partidos.filter(p => p.estado === 'finalizado');
  console.log(`  partidos: ${partidos.length} (${finalizados.length} finalizados)`);

  if (partidos.length > 0) {
    const catalogo = new Map(
      db.prepare('SELECT codigo, grupo FROM mundial_equipos_catalogo WHERE torneo_id = ? AND activo = 1')
        .all(t.id).map(r => [r.codigo, r.grupo])
    );
    let errs = 0;
    const claves = new Set();
    for (const p of partidos) {
      if (!RONDAS.includes(p.ronda)) { errs++; console.log(`  ! ronda inválida en partido ${p.id}: ${p.ronda}`); }
      for (const c of [p.equipo_local, p.equipo_visitante]) {
        if (!catalogo.has(c)) { errs++; console.log(`  ! partido ${p.id}: equipo ${c} no está en catálogo activo`); }
      }
      if (p.ronda === 'grupos') {
        for (const c of [p.equipo_local, p.equipo_visitante]) {
          if (catalogo.has(c) && catalogo.get(c) !== p.grupo) {
            errs++; console.log(`  ! partido ${p.id}: ${c} es del grupo ${catalogo.get(c)}, partido dice ${p.grupo}`);
          }
        }
        if (p.penales_local !== null || p.penales_visitante !== null) {
          errs++; console.log(`  ! partido ${p.id}: penales en fase de grupos`);
        }
      }
      if (p.estado === 'finalizado' && (p.goles_local === null || p.goles_visitante === null)) {
        errs++; console.log(`  ! partido ${p.id}: finalizado sin goles`);
      }
      const k = `${p.ronda}|${p.orden}`;
      if (claves.has(k)) { errs++; console.log(`  ! (ronda,orden) duplicado: ${k}`); }
      claves.add(k);
    }
    check('integridad del fixture', errs === 0, `${errs} problemas`);
  }

  const fuente = finalizados.length > 0 ? 'fixture' : 'matriz';
  console.log(`  fuente_tarjetas: ${fuente}`);

  // 5) comparación matriz vs fixture (si ambas tienen datos)
  const matriz = db.prepare(
    'SELECT equipo_codigo, SUM(amarillas) am, SUM(rojas) ro FROM mundial_tarjetas_partido WHERE torneo_id = ? GROUP BY equipo_codigo'
  ).all(t.id);
  const hayTarjetasFixture = finalizados.some(p =>
    p.amarillas_local !== null || p.amarillas_visitante !== null || p.rojas_local !== null || p.rojas_visitante !== null);
  if (matriz.length > 0 && hayTarjetasFixture) {
    console.log('  comparación matriz legacy vs fixture (informativo):');
    const fix = new Map();
    for (const p of finalizados) {
      const acc = (cod, am, ro) => {
        const r = fix.get(cod) || { am: 0, ro: 0 };
        r.am += am || 0; r.ro += ro || 0; fix.set(cod, r);
      };
      acc(p.equipo_local, p.amarillas_local, p.rojas_local);
      acc(p.equipo_visitante, p.amarillas_visitante, p.rojas_visitante);
    }
    for (const m of matriz) {
      const f = fix.get(m.equipo_codigo) || { am: 0, ro: 0 };
      const dif = (m.am !== f.am || m.ro !== f.ro) ? '  ← DIFIEREN' : '';
      console.log(`    ${m.equipo_codigo}: matriz ${m.am}🟨/${m.ro}🟥 vs fixture ${f.am}🟨/${f.ro}🟥${dif}`);
    }
  } else if (matriz.length > 0) {
    console.log(`  matriz legacy con datos (${matriz.length} equipos) — fixture sin tarjetas: convive como fallback, sin conflicto`);
  }
}

// ── 6) NO-impacto sobre datos existentes ─────────────────────────────────────
console.log('\n6) NO-IMPACTO (counts de referencia)');
for (const [tabla, label] of [
  ['mundial_respuestas_usuario', 'respuestas de usuarios'],
  ['mundial_resultados', 'resultados'],
  ['mundial_preguntas', 'preguntas'],
  ['mundial_respuesta_canonizacion', 'canonizaciones'],
  ['mundial_tarjetas_partido', 'celdas matriz legacy'],
  ['mundial_datos_utiles', 'datos útiles manuales'],
]) {
  const n = db.prepare(`SELECT COUNT(*) c FROM ${tabla}`).get().c;
  console.log(`  ${label}: ${n}`);
}
console.log('  (comparar manualmente antes/después de operar el fixture: deben ser idénticos salvo acciones explícitas del admin)');

console.log('\n════════════════════════════════════════════════════════');
console.log(fallos === 0 ? 'RESULTADO: TODO OK ✔' : `RESULTADO: ${fallos} FALLOS ✘`);
console.log('════════════════════════════════════════════════════════');
process.exit(fallos === 0 ? 0 : 1);
