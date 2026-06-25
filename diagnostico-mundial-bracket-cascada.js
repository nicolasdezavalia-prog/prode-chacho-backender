/**
 * diagnostico-mundial-bracket-cascada.js — Sprint 2 KO cascade.
 *
 * Verifica:
 *   C1. Cargar 16 R32 base (sin finalizar) — 8vos no se materializa.
 *   C2. Finalizar R32-1 solo — 8vos-1 (R32-1 + R32-11) sigue pendiente.
 *   C3. Finalizar R32-11 — 8vos-1 materializa con los 2 ganadores.
 *   C4. Empate sin penales → ganador indefinido → 8vo no materializa.
 *   C5. Empate con penales → ganador resuelto → 8vo materializa.
 *   C6. Finalizar los 16 R32 → 8 octavos materializados.
 *   C7. Cascada hasta semis → 4tos, semis.
 *   C8. Final + tercer_puesto desde semis.
 *   C9. Corrección retroactiva: cambiar ganador R32 → 8vo actualiza equipos
 *       SIN tocar goles del 8vo.
 *   C10. Idempotencia.
 *
 * DB efímera en memoria.
 */

const { DatabaseSync } = require('node:sqlite');
const { avanzarBracketTras } = require('./src/logic/mundial-bracket');

let fallos = 0;
function check(nombre, cond, detalle) {
  if (cond) console.log(`  OK   ${nombre}`);
  else { fallos++; console.log(`  FAIL ${nombre}${detalle ? ' --- ' + detalle : ''}`); }
}

console.log('========================================================');
console.log('DIAGNOSTICO BRACKET CASCADA - Sprint 2');
console.log('DB: :memory: (efimera)');
console.log('========================================================\n');

const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE torneos (id INTEGER PRIMARY KEY);
  INSERT INTO torneos (id) VALUES (1);
  CREATE TABLE mundial_equipos_catalogo (
    id INTEGER PRIMARY KEY AUTOINCREMENT, torneo_id INTEGER NOT NULL, codigo TEXT NOT NULL,
    nombre TEXT NOT NULL, emoji TEXT, grupo TEXT, confederacion TEXT, activo INTEGER NOT NULL DEFAULT 1,
    UNIQUE(torneo_id, codigo)
  );
  CREATE TABLE mundial_partidos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, torneo_id INTEGER NOT NULL, ronda TEXT NOT NULL, grupo TEXT,
    orden INTEGER NOT NULL DEFAULT 0, fecha TEXT, equipo_local TEXT NOT NULL, equipo_visitante TEXT NOT NULL,
    goles_local INTEGER, goles_visitante INTEGER, penales_local INTEGER, penales_visitante INTEGER,
    amarillas_local INTEGER, amarillas_visitante INTEGER, rojas_local INTEGER, rojas_visitante INTEGER,
    estado TEXT NOT NULL DEFAULT 'pendiente', observacion TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(torneo_id, ronda, orden)
  );
`);

const TORNEO = 1;

// Sembrar los 16 R32 con equipos sintéticos pendientes.
// Naming: TLn = local n, TVn = visitante n.
const insR32 = db.prepare(`
  INSERT INTO mundial_partidos (torneo_id, ronda, grupo, orden, equipo_local, equipo_visitante, estado)
  VALUES (?, '16vos', NULL, ?, ?, ?, 'pendiente')
`);
for (let i = 1; i <= 16; i++) {
  insR32.run(TORNEO, i, `L${i}`, `V${i}`);
}
// Tambien catalogo minimo (para no romper compararEquiposGrupo si se invoca).
const insEq = db.prepare(`INSERT INTO mundial_equipos_catalogo (torneo_id, codigo, nombre, activo) VALUES (?, ?, ?, 1)`);
for (let i = 1; i <= 16; i++) { insEq.run(TORNEO, `L${i}`, `Local ${i}`); insEq.run(TORNEO, `V${i}`, `Visit ${i}`); }

function finalizarPartido(ronda, orden, gl, gv, pl = null, pv = null) {
  db.prepare(`
    UPDATE mundial_partidos
    SET goles_local=?, goles_visitante=?, penales_local=?, penales_visitante=?, estado='finalizado'
    WHERE torneo_id=? AND ronda=? AND orden=?
  `).run(gl, gv, pl, pv, TORNEO, ronda, orden);
}

// ---- C1 ---------------------------------------------------------------
console.log('C1) 16 R32 cargados, sin finalizar');
let res = avanzarBracketTras(db, TORNEO, '16vos');
check('paso = 8vos', res.paso === '8vos');
check('creados = 0', res.resultado.creados === 0);
check('pendientes = 8', res.resultado.pendientes.length === 8);

// ---- C2 ---------------------------------------------------------------
console.log('\nC2) Solo R32-1 finalizado -> 8vos-1 sigue pendiente');
finalizarPartido('16vos', 1, 2, 1);  // L1 gana
res = avanzarBracketTras(db, TORNEO, '16vos');
check('creados = 0 (8vos-1 falta R32-11)', res.resultado.creados === 0);

// ---- C3 ---------------------------------------------------------------
console.log('\nC3) R32-1 + R32-11 finalizados -> 8vos-1 materializa');
finalizarPartido('16vos', 11, 0, 3); // V11 gana
res = avanzarBracketTras(db, TORNEO, '16vos');
const o1 = db.prepare(`SELECT * FROM mundial_partidos WHERE torneo_id=? AND ronda='8vos' AND orden=1`).get(TORNEO);
check('8vos-1 existe', !!o1);
check('8vos-1 local = L1 (gano R32-1)', o1?.equipo_local === 'L1');
check('8vos-1 visitante = V11 (gano R32-11)', o1?.equipo_visitante === 'V11');

// ---- C4 ---------------------------------------------------------------
console.log('\nC4) R32-2 empate sin penales -> ganador indefinido');
finalizarPartido('16vos', 2, 1, 1, null, null);
finalizarPartido('16vos', 4, 2, 0); // L4 gana
res = avanzarBracketTras(db, TORNEO, '16vos');
const o2_pre = db.prepare(`SELECT * FROM mundial_partidos WHERE torneo_id=? AND ronda='8vos' AND orden=2`).get(TORNEO);
check('8vos-2 NO existe (R32-2 indefinido)', !o2_pre);

// ---- C5 ---------------------------------------------------------------
console.log('\nC5) R32-2 con penales -> 8vos-2 materializa');
finalizarPartido('16vos', 2, 1, 1, 4, 3); // L2 gana por penales
res = avanzarBracketTras(db, TORNEO, '16vos');
const o2 = db.prepare(`SELECT * FROM mundial_partidos WHERE torneo_id=? AND ronda='8vos' AND orden=2`).get(TORNEO);
check('8vos-2 existe', !!o2);
check('8vos-2 local = L2 (gano por penales)', o2?.equipo_local === 'L2');
check('8vos-2 visitante = L4', o2?.equipo_visitante === 'L4');

// ---- C6 ---------------------------------------------------------------
console.log('\nC6) Finalizar todos los R32 -> 8 octavos');
// Los R32 ya finalizados: 1, 2, 4, 11. Falta 3,5,6,7,8,9,10,12,13,14,15,16.
for (const o of [3, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15, 16]) {
  finalizarPartido('16vos', o, 3, 1); // local gana siempre
}
res = avanzarBracketTras(db, TORNEO, '16vos');
const todos8vos = db.prepare(`SELECT * FROM mundial_partidos WHERE torneo_id=? AND ronda='8vos' ORDER BY orden`).all(TORNEO);
check('8 octavos creados', todos8vos.length === 8, `len=${todos8vos.length}`);

// ---- C7 ---------------------------------------------------------------
console.log('\nC7) Cascada 8vos -> 4tos -> semis');
for (let o = 1; o <= 8; o++) {
  finalizarPartido('8vos', o, 2, 0); // local gana
}
res = avanzarBracketTras(db, TORNEO, '8vos');
const todos4tos = db.prepare(`SELECT * FROM mundial_partidos WHERE torneo_id=? AND ronda='4tos' ORDER BY orden`).all(TORNEO);
check('4 cuartos creados', todos4tos.length === 4);

for (let o = 1; o <= 4; o++) finalizarPartido('4tos', o, 1, 0);
res = avanzarBracketTras(db, TORNEO, '4tos');
const todasSemis = db.prepare(`SELECT * FROM mundial_partidos WHERE torneo_id=? AND ronda='semis' ORDER BY orden`).all(TORNEO);
check('2 semis creadas', todasSemis.length === 2);

// ---- C8 ---------------------------------------------------------------
console.log('\nC8) Semis -> final + tercer_puesto');
finalizarPartido('semis', 1, 3, 1);  // local gana
finalizarPartido('semis', 2, 0, 2);  // visitante gana
res = avanzarBracketTras(db, TORNEO, 'semis');
const final_ = db.prepare(`SELECT * FROM mundial_partidos WHERE torneo_id=? AND ronda='final' AND orden=1`).get(TORNEO);
const tercer = db.prepare(`SELECT * FROM mundial_partidos WHERE torneo_id=? AND ronda='tercer_puesto' AND orden=1`).get(TORNEO);
check('final existe', !!final_);
check('tercer_puesto existe', !!tercer);
// semis-1: local 3-1 visit -> ganador=local semis-1; perdedor=visit semis-1
// semis-2: local 0-2 visit -> ganador=visit semis-2; perdedor=local semis-2
const semis1 = todasSemis.find(p => p.orden === 1);
const semis2 = todasSemis.find(p => p.orden === 2);
check('final local = ganador semis-1', final_?.equipo_local === semis1.equipo_local);
check('final visitante = ganador semis-2', final_?.equipo_visitante === semis2.equipo_visitante);
check('tercer_puesto local = perdedor semis-1', tercer?.equipo_local === semis1.equipo_visitante);
check('tercer_puesto visitante = perdedor semis-2', tercer?.equipo_visitante === semis2.equipo_local);

// ---- C9 ---------------------------------------------------------------
console.log('\nC9) Correccion retroactiva KO: cambiar ganador R32-1');
// Cargar goles+tarjetas en 8vos-1 ANTES de retro-cambiar.
db.prepare(`
  UPDATE mundial_partidos
  SET goles_local=4, goles_visitante=2, amarillas_local=3, rojas_visitante=1
  WHERE torneo_id=? AND ronda='8vos' AND orden=1
`).run(TORNEO);

// Snapshot de los OTROS 7 octavos para verificar que la correccion solo toca el 8vos-1.
const snapOtrosOctavos = db.prepare(
  `SELECT orden, equipo_local, equipo_visitante FROM mundial_partidos
   WHERE torneo_id=? AND ronda='8vos' AND orden != 1 ORDER BY orden`
).all(TORNEO);

// Originalmente R32-1: L1 2-1 V1 -> ganador L1.
// Cambio: V1 gana 0-1 (L1 ya no es ganador).
finalizarPartido('16vos', 1, 0, 1);
res = avanzarBracketTras(db, TORNEO, '16vos');
check('actualizados >= 1', res.resultado.actualizados >= 1, `actualizados=${res.resultado.actualizados}`);

const o1_act = db.prepare(`SELECT * FROM mundial_partidos WHERE torneo_id=? AND ronda='8vos' AND orden=1`).get(TORNEO);
check('8vos-1 local actualizado a V1', o1_act?.equipo_local === 'V1');
check('8vos-1 goles_local preservados (=4)', o1_act?.goles_local === 4);
check('8vos-1 goles_visitante preservados (=2)', o1_act?.goles_visitante === 2);
check('8vos-1 amarillas_local preservadas (=3)', o1_act?.amarillas_local === 3);
check('8vos-1 rojas_visitante preservadas (=1)', o1_act?.rojas_visitante === 1);
check('8vos-1 estado sigue finalizado', o1_act?.estado === 'finalizado');

// Validar que los otros 7 octavos NO se tocaron.
const snapOtrosPost = db.prepare(
  `SELECT orden, equipo_local, equipo_visitante FROM mundial_partidos
   WHERE torneo_id=? AND ronda='8vos' AND orden != 1 ORDER BY orden`
).all(TORNEO);
let octavosTocados = 0;
for (let i = 0; i < snapOtrosOctavos.length; i++) {
  if (snapOtrosOctavos[i].equipo_local !== snapOtrosPost[i].equipo_local ||
      snapOtrosOctavos[i].equipo_visitante !== snapOtrosPost[i].equipo_visitante) octavosTocados++;
}
check('otros 7 octavos sin cambios', octavosTocados === 0, `tocados=${octavosTocados}`);

// ---- C11: cascada multinivel R32 -> 8vos -> 4tos ---------------------
console.log('\nC11) Cascada multinivel: el cambio del R32-1 propaga a 4tos-1');
// 8vos-1 alimenta 4tos-1 (CASCADA_KO: 4tos-1 = ganador 8vos-1 + ganador 8vos-2).
// El 8vos-1 ahora tiene local=V1 (cambiamos en C9). El resultado del 8vos-1
// estaba como 4-2 (local gana) -> ganador = V1.
// El 4tos-1 ya existia (creado en C7) con local original L1 (ganador del 8vos-1
// ANTES de la correccion).
res = avanzarBracketTras(db, TORNEO, '8vos');
const cuatros1 = db.prepare(`SELECT * FROM mundial_partidos WHERE torneo_id=? AND ronda='4tos' AND orden=1`).get(TORNEO);
check('4tos-1 local actualizado a V1 (cascada R32 -> 8vos -> 4tos)',
  cuatros1?.equipo_local === 'V1', `local=${cuatros1?.equipo_local}`);
check('4tos-1 actualizados refleja el cambio', res.resultado.actualizados >= 1);

// ---- C10 --------------------------------------------------------------
console.log('\nC10) Idempotencia: 2da corrida no toca');
const cnt8 = db.prepare(`SELECT COUNT(*) AS n FROM mundial_partidos WHERE torneo_id=? AND ronda='8vos'`).get(TORNEO).n;
res = avanzarBracketTras(db, TORNEO, '16vos');
const cnt8_2 = db.prepare(`SELECT COUNT(*) AS n FROM mundial_partidos WHERE torneo_id=? AND ronda='8vos'`).get(TORNEO).n;
check('sin duplicacion 8vos', cnt8 === cnt8_2 && cnt8 === 8);
check('creados en 2da corrida = 0', res.resultado.creados === 0);

// Cierre
console.log('\n========================================================');
if (fallos === 0) {
  console.log('OK DIAG BRACKET CASCADA SPRINT 2: TODOS LOS CHECKS PASARON');
  process.exit(0);
} else {
  console.log('FAIL DIAG BRACKET CASCADA SPRINT 2: ' + fallos + ' fallo(s)');
  process.exit(1);
}
