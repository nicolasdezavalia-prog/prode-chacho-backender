/**
 * diagnostico-mundial-bracket.js — Sprint 1 KO automation.
 *
 * Corre en DB EFÍMERA en memoria (`:memory:`), NO toca prod ni dev local.
 * Crea schema mínimo (mundial_equipos_catalogo + mundial_partidos), siembra
 * 12 grupos × 4 equipos y va finalizando partidos para validar:
 *
 *   T1.  Sin grupos cerrados, R32 pendientes = 16.
 *   T2.  Cerrar solo grupo A → todavía 0 R32 creados.
 *   T3.  Cerrar A+B → R32-1 (2A vs 2B) materializa.
 *   T4.  Cerrar A+B+C+F → R32-2 (1C vs 2F), R32-4 (1F vs 2C) materializan.
 *   T5.  Cerrar los 12 → comboKey = 'A-C-D-F-G-H-J-L', 16 R32 creados.
 *   T6.  Slot terceros: valores EXACTOS derivados de la matriz.
 *   T7.  Idempotencia: llamar avanzarBracketTras dos veces no recrea.
 *   T8.  Corrección retroactiva: cambiar resultado del grupo A → R32-1
 *        actualiza equipo_local SIN tocar goles/tarjetas, y los otros 15 R32
 *        quedan intactos.
 *
 * Uso:
 *   node diagnostico-mundial-bracket.js
 */

const { DatabaseSync } = require('node:sqlite');
const {
  avanzarBracketTras,
  generarR32Incremental,
  calcularAsignacionTerceros,
  R32_BRACKET,
} = require('./src/logic/mundial-bracket');
const MATRIZ = require('./src/data/mundial-r32-matriz.js');

let fallos = 0;
function check(nombre, cond, detalle) {
  if (cond) console.log(`  OK   ${nombre}`);
  else { fallos++; console.log(`  FAIL ${nombre}${detalle ? ' — ' + detalle : ''}`); }
}

console.log('════════════════════════════════════════════════════════');
console.log('DIAGNÓSTICO BRACKET — Sprint 1 (R32 incremental)');
console.log('DB: :memory: (efímera, no toca prod/dev)');
console.log('════════════════════════════════════════════════════════\n');

const db = new DatabaseSync(':memory:');

db.exec(`
  CREATE TABLE torneos (id INTEGER PRIMARY KEY);
  INSERT INTO torneos (id) VALUES (1);

  CREATE TABLE mundial_equipos_catalogo (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    torneo_id INTEGER NOT NULL REFERENCES torneos(id),
    codigo TEXT NOT NULL,
    nombre TEXT NOT NULL,
    emoji TEXT, grupo TEXT, confederacion TEXT,
    activo INTEGER NOT NULL DEFAULT 1,
    UNIQUE(torneo_id, codigo)
  );

  CREATE TABLE mundial_partidos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    torneo_id INTEGER NOT NULL REFERENCES torneos(id),
    ronda TEXT NOT NULL,
    grupo TEXT,
    orden INTEGER NOT NULL DEFAULT 0,
    fecha TEXT,
    equipo_local TEXT NOT NULL,
    equipo_visitante TEXT NOT NULL,
    goles_local INTEGER, goles_visitante INTEGER,
    penales_local INTEGER, penales_visitante INTEGER,
    amarillas_local INTEGER, amarillas_visitante INTEGER,
    rojas_local INTEGER, rojas_visitante INTEGER,
    estado TEXT NOT NULL DEFAULT 'pendiente',
    observacion TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(torneo_id, ronda, orden)
  );
`);

const TORNEO = 1;
const GRUPOS = ['A','B','C','D','E','F','G','H','I','J','K','L'];

const insEq = db.prepare(
  `INSERT INTO mundial_equipos_catalogo (torneo_id, codigo, nombre, grupo, activo) VALUES (?, ?, ?, ?, 1)`
);
for (const g of GRUPOS) {
  for (let i = 1; i <= 4; i++) {
    insEq.run(TORNEO, `G${g}${i}`, `Eq ${g}${i}`, g);
  }
}

// Dos patrones de resultados de grupo:
//   'fuerte': el 3° saca 3 pts (E con eq1 y eq2). DG=0. → entra al top-8 de terceros.
//   'debil': el 3° saca 1 pt. DG=-2. → queda fuera del top-8.
function sembrarGrupo(g, patron) {
  const e1 = `G${g}1`, e2 = `G${g}2`, e3 = `G${g}3`, e4 = `G${g}4`;
  const ins = db.prepare(`
    INSERT INTO mundial_partidos
      (torneo_id, ronda, grupo, orden, equipo_local, equipo_visitante,
       goles_local, goles_visitante, amarillas_local, amarillas_visitante,
       rojas_local, rojas_visitante, estado)
    VALUES (?, 'grupos', ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 'finalizado')
  `);
  const ob = GRUPOS.indexOf(g) * 6;
  if (patron === 'fuerte') {
    ins.run(TORNEO, g, ob + 1, e1, e2, 2, 0);
    ins.run(TORNEO, g, ob + 2, e1, e3, 1, 1);
    ins.run(TORNEO, g, ob + 3, e1, e4, 1, 0);
    ins.run(TORNEO, g, ob + 4, e2, e3, 0, 0);
    ins.run(TORNEO, g, ob + 5, e2, e4, 1, 0);
    ins.run(TORNEO, g, ob + 6, e3, e4, 0, 0);
  } else {
    ins.run(TORNEO, g, ob + 1, e1, e2, 1, 0);
    ins.run(TORNEO, g, ob + 2, e1, e3, 3, 0);
    ins.run(TORNEO, g, ob + 3, e1, e4, 1, 0);
    ins.run(TORNEO, g, ob + 4, e2, e3, 3, 0);
    ins.run(TORNEO, g, ob + 5, e2, e4, 1, 0);
    ins.run(TORNEO, g, ob + 6, e3, e4, 0, 0);
  }
}

// ── T1 ───────────────────────────────────────────────────────────────────
console.log('T1) Sin grupos cerrados');
let res = avanzarBracketTras(db, TORNEO, 'grupos');
check('paso = R32', res.paso === 'R32');
check('creados = 0', res.resultado.creados === 0);
check('pendientes = 16', res.resultado.pendientes.length === 16);

// ── T2 ───────────────────────────────────────────────────────────────────
console.log('\nT2) Cerrar solo grupo A');
sembrarGrupo('A', 'fuerte');
res = generarR32Incremental(db, TORNEO);
check('creados = 0 (ningún cruce R32 depende SOLO de A)', res.creados === 0);

// ── T3 ───────────────────────────────────────────────────────────────────
console.log('\nT3) Cerrar A + B → R32-1 (2A vs 2B)');
sembrarGrupo('B', 'debil');
res = generarR32Incremental(db, TORNEO);
const r32_1 = db.prepare(`SELECT * FROM mundial_partidos WHERE torneo_id=? AND ronda='16vos' AND orden=1`).get(TORNEO);
check('R32-1 existe', !!r32_1);
check('R32-1 local = GA2', r32_1?.equipo_local === 'GA2');
check('R32-1 visitante = GB2', r32_1?.equipo_visitante === 'GB2');

// ── T4 ───────────────────────────────────────────────────────────────────
console.log('\nT4) + C + F → R32-2 (1C vs 2F), R32-4 (1F vs 2C)');
sembrarGrupo('C', 'fuerte');
sembrarGrupo('F', 'fuerte');
generarR32Incremental(db, TORNEO);
const r32_2 = db.prepare(`SELECT * FROM mundial_partidos WHERE torneo_id=? AND ronda='16vos' AND orden=2`).get(TORNEO);
const r32_4 = db.prepare(`SELECT * FROM mundial_partidos WHERE torneo_id=? AND ronda='16vos' AND orden=4`).get(TORNEO);
check('R32-2 = 1C vs 2F', r32_2?.equipo_local === 'GC1' && r32_2?.equipo_visitante === 'GF2');
check('R32-4 = 1F vs 2C', r32_4?.equipo_local === 'GF1' && r32_4?.equipo_visitante === 'GC2');

// ── T5 ───────────────────────────────────────────────────────────────────
console.log('\nT5) Cerrar los 12 grupos');
sembrarGrupo('D', 'fuerte');
sembrarGrupo('E', 'debil');
sembrarGrupo('G', 'fuerte');
sembrarGrupo('H', 'fuerte');
sembrarGrupo('I', 'debil');
sembrarGrupo('J', 'fuerte');
sembrarGrupo('K', 'debil');
sembrarGrupo('L', 'fuerte');

const asignacion = calcularAsignacionTerceros(db, TORNEO);
check('asignacion no es null', asignacion !== null);
check('grupos8 = A-C-D-F-G-H-J-L', asignacion?.grupos8?.join('-') === 'A-C-D-F-G-H-J-L',
  `grupos8=${asignacion?.grupos8?.join('-')}`);
check('combo está en la matriz', !!asignacion?.asignacion);

res = generarR32Incremental(db, TORNEO);
const todosR32 = db.prepare(`SELECT * FROM mundial_partidos WHERE torneo_id=? AND ronda='16vos' ORDER BY orden`).all(TORNEO);
check('16 R32 creados', todosR32.length === 16);
check('pendientes = 0', res.pendientes.length === 0);

// ── T6: valores EXACTOS desde matriz ────────────────────────────────────
console.log('\nT6) Slot terceros (valores EXACTOS desde matriz)');
const asignMatriz = MATRIZ['A-C-D-F-G-H-J-L'];
check('matriz tiene combo A-C-D-F-G-H-J-L', !!asignMatriz);

function tercerEsperadoParaOrden(orden) {
  const cruce = R32_BRACKET.find(c => c.orden === orden);
  if (!cruce) return null;
  for (const lado of ['local', 'visitante']) {
    if (cruce[lado]?.tipo === 'third') {
      const slot = cruce[lado].slot;
      const codTercero = asignMatriz[slot];
      if (!codTercero) return null;
      return { lado, codigo: `G${codTercero[1]}3` };
    }
  }
  return null;
}

for (const orden of [3, 6, 7, 8, 9, 10, 13, 16]) {
  const partido = todosR32.find(p => p.orden === orden);
  const esperado = tercerEsperadoParaOrden(orden);
  if (!esperado) {
    check(`R32-${orden} tercero esperado calculado`, false, 'no se pudo derivar de matriz');
    continue;
  }
  const codActual = partido?.[`equipo_${esperado.lado}`];
  check(`R32-${orden} ${esperado.lado}=${esperado.codigo}`,
    codActual === esperado.codigo, `actual=${codActual}`);
}

// ── T7: idempotencia ────────────────────────────────────────────────────
console.log('\nT7) Idempotencia');
const antes = db.prepare(`SELECT COUNT(*) AS n FROM mundial_partidos WHERE torneo_id=? AND ronda='16vos'`).get(TORNEO).n;
res = avanzarBracketTras(db, TORNEO, 'grupos');
const despues = db.prepare(`SELECT COUNT(*) AS n FROM mundial_partidos WHERE torneo_id=? AND ronda='16vos'`).get(TORNEO).n;
check('sin duplicación', antes === 16 && despues === 16);
check('creados en 2da corrida = 0', res.resultado.creados === 0);
check('actualizados = 0', res.resultado.actualizados === 0);

// ── T8: corrección retroactiva ──────────────────────────────────────────
console.log('\nT8) Corrección retroactiva grupo A');
db.prepare(`
  UPDATE mundial_partidos
  SET goles_local = 3, goles_visitante = 2, amarillas_local = 4, rojas_visitante = 1
  WHERE torneo_id = ? AND ronda = '16vos' AND orden = 1
`).run(TORNEO);

// Cambio resultado partido eq2-eq3 del grupo A: 0-5 (GA3 le gana fuerte a GA2)
// → GA3 sube de pts (de 3 a 5) y pasa a ser 2° en vez de GA2.
db.prepare(`UPDATE mundial_partidos SET goles_local=0, goles_visitante=5 WHERE torneo_id=? AND ronda='grupos' AND grupo='A' AND orden=4`).run(TORNEO);

const snapshotOtros = db.prepare(
  `SELECT orden, equipo_local, equipo_visitante FROM mundial_partidos
   WHERE torneo_id=? AND ronda='16vos' AND orden != 1 ORDER BY orden`
).all(TORNEO);

res = avanzarBracketTras(db, TORNEO, 'grupos');
check('actualizados >= 1', res.resultado.actualizados >= 1, `actualizados=${res.resultado.actualizados}`);

const r32_1_act = db.prepare(`SELECT * FROM mundial_partidos WHERE torneo_id=? AND ronda='16vos' AND orden=1`).get(TORNEO);
check('R32-1 local cambió a GA3', r32_1_act?.equipo_local === 'GA3', `local=${r32_1_act?.equipo_local}`);
check('R32-1 goles_local preservados (=3)', r32_1_act?.goles_local === 3);
check('R32-1 goles_visitante preservados (=2)', r32_1_act?.goles_visitante === 2);
check('R32-1 amarillas_local preservadas (=4)', r32_1_act?.amarillas_local === 4);
check('R32-1 rojas_visitante preservadas (=1)', r32_1_act?.rojas_visitante === 1);

// Los R32 dependientes del grupo A son:
//   - R32-1 (2A vs 2B): 2A pasa de GA2 a GA3.
//   - R32-9 (1G vs 3A): 3A pasa de GA3 a GA2.
// Cualquier otro R32 que cambie es bug.
const snapshotDespues = db.prepare(
  `SELECT orden, equipo_local, equipo_visitante FROM mundial_partidos
   WHERE torneo_id=? AND ronda='16vos' AND orden != 1 ORDER BY orden`
).all(TORNEO);
const cambios = [];
for (let i = 0; i < snapshotOtros.length; i++) {
  if (snapshotOtros[i].equipo_local !== snapshotDespues[i].equipo_local ||
      snapshotOtros[i].equipo_visitante !== snapshotDespues[i].equipo_visitante) {
    cambios.push({
      orden: snapshotOtros[i].orden,
      antes: `${snapshotOtros[i].equipo_local}-${snapshotOtros[i].equipo_visitante}`,
      despues: `${snapshotDespues[i].equipo_local}-${snapshotDespues[i].equipo_visitante}`,
    });
  }
}
// R32-9 debe cambiar (1G vs 3A → su tercero GA3 ahora es GA2)
const r32_9_cambio = cambios.find(c => c.orden === 9);
check('R32-9 actualizó tercero (3A pasó de GA3 a GA2)',
  r32_9_cambio?.antes === 'GG1-GA3' && r32_9_cambio?.despues === 'GG1-GA2',
  `r32_9_cambio=${JSON.stringify(r32_9_cambio)}`);
// Solo R32-9 puede haber cambiado además de R32-1 (excluido por la WHERE).
const inesperados = cambios.filter(c => c.orden !== 9);
check('R32-2..R32-16 sin cambios inesperados (solo R32-1 y R32-9)',
  inesperados.length === 0,
  inesperados.length ? JSON.stringify(inesperados) : '');

// Cierre
console.log('\n========================================================');
if (fallos === 0) {
  console.log('OK DIAG BRACKET SPRINT 1: TODOS LOS CHECKS PASARON');
  process.exit(0);
} else {
  console.log('FAIL DIAG BRACKET SPRINT 1: ' + fallos + ' fallo(s)');
  process.exit(1);
}
