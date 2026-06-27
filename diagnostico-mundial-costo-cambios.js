/**
 * diagnostico-mundial-costo-cambios.js — sprint costo por equipo.
 *
 * Valida la función pura costoCambioEnCupos:
 *   A. multi_equipo con diff de equipos.
 *   B. Otros tipos: 1 si difiere, 0 si igual.
 *   C. Strings JSON y objetos: ambos shapes funcionan.
 *   D. Edge cases.
 */

const { costoCambioEnCupos, respuestasIguales } = require('./src/logic/mundial-costo-cambios');

let fallos = 0;
function check(n, ok, det) {
  if (ok) console.log(`  OK   ${n}`);
  else { fallos++; console.log(`  FAIL ${n}${det ? ' --- ' + det : ''}`); }
}

console.log('========================================================');
console.log('DIAG COSTO POR EQUIPO EN CAMBIOS');
console.log('========================================================\n');

// ── A) multi_equipo ─────────────────────────────────────────────────────
console.log('A) multi_equipo (P32/P33/P34)');

const a1 = costoCambioEnCupos('multi_equipo',
  { equipos: ['ALE','BRA','FRA','ESP'] },
  { equipos: ['ALE','BRA','FRA','ARG'] });
check('A1 cambiar 1 equipo (ESP→ARG) costo=1', a1 === 1, `got ${a1}`);

const a2 = costoCambioEnCupos('multi_equipo',
  { equipos: ['ALE','BRA','FRA','ESP'] },
  { equipos: ['ARG','MEX','POR','HOL'] });
check('A2 cambiar 4 equipos (todos distintos) costo=4', a2 === 4);

const a3 = costoCambioEnCupos('multi_equipo',
  { equipos: ['ALE','BRA','FRA','ESP'] },
  { equipos: ['ALE','BRA','FRA','ESP'] });
check('A3 misma lista costo=0', a3 === 0);

const a4 = costoCambioEnCupos('multi_equipo',
  { equipos: ['ALE','BRA','FRA','ESP'] },
  { equipos: ['BRA','ALE','ESP','FRA'] });
check('A4 reordenar misma lista costo=0', a4 === 0);

const a5 = costoCambioEnCupos('multi_equipo',
  { equipos: ['ALE','BRA','FRA','ESP','POR','ITA','ING','HOL'] },
  { equipos: ['ALE','BRA','FRA','ESP','POR','ITA','ING','ARG'] });
check('A5 P32 (8 equipos) cambiar 1 costo=1', a5 === 1);

// Edge: list anterior vacía
const a6 = costoCambioEnCupos('multi_equipo', {}, { equipos: ['A','B','C'] });
check('A6 anterior vacio + 3 nuevos costo=3', a6 === 3);

// Edge: list nueva vacía
const a7 = costoCambioEnCupos('multi_equipo', { equipos: ['A','B'] }, { equipos: [] });
check('A7 nueva vacia costo=0 (sin equipos nuevos)', a7 === 0);

// ── B) Otros tipos ──────────────────────────────────────────────────────
console.log('\nB) Tipos NO multi_equipo');

check('B1 equipo_categoria mismo costo=0',
  costoCambioEnCupos('equipo_categoria', { equipo: 'ALE' }, { equipo: 'ALE' }) === 0);
check('B2 equipo_categoria distinto costo=1',
  costoCambioEnCupos('equipo_categoria', { equipo: 'ALE' }, { equipo: 'BRA' }) === 1);

check('B3 instancia_eliminacion mismo costo=0',
  costoCambioEnCupos('instancia_eliminacion', { instancia: '8°' }, { instancia: '8°' }) === 0);
check('B4 instancia_eliminacion distinto costo=1',
  costoCambioEnCupos('instancia_eliminacion', { instancia: '8°' }, { instancia: '4°' }) === 1);

check('B5 numero_exacto mismo costo=0',
  costoCambioEnCupos('numero_exacto', { numero: 5 }, { numero: 5 }) === 0);
check('B6 numero_exacto distinto costo=1',
  costoCambioEnCupos('numero_exacto', { numero: 5 }, { numero: 7 }) === 1);

check('B7 respuesta_manual mismo costo=0',
  costoCambioEnCupos('respuesta_manual', { texto: 'Mbappé' }, { texto: 'Mbappé' }) === 0);
check('B8 respuesta_manual distinto costo=1',
  costoCambioEnCupos('respuesta_manual', { texto: 'Mbappé' }, { texto: 'Haaland' }) === 1);

check('B9 opcion_unica mismo costo=0',
  costoCambioEnCupos('opcion_unica', { opcion: 'Sí' }, { opcion: 'Sí' }) === 0);
check('B10 opcion_unica distinto costo=1',
  costoCambioEnCupos('opcion_unica', { opcion: 'Sí' }, { opcion: 'No' }) === 1);

// ── C) Strings JSON vs objetos ──────────────────────────────────────────
console.log('\nC) Strings JSON y objetos');

const c1 = costoCambioEnCupos('multi_equipo',
  '{"equipos":["A","B","C"]}',
  '{"equipos":["A","B","D"]}');
check('C1 ambos strings JSON costo=1', c1 === 1);

const c2 = costoCambioEnCupos('multi_equipo',
  '{"equipos":["A","B"]}',
  { equipos: ['A','B'] });
check('C2 mix string + objeto costo=0', c2 === 0);

const c3 = costoCambioEnCupos('equipo_categoria',
  '{"equipo":"ALE"}', '{"equipo":"BRA"}');
check('C3 strings JSON tipo no multi costo=1', c3 === 1);

// ── D) Edge cases ──────────────────────────────────────────────────────
console.log('\nD) Edge cases');

check('D1 anterior null costo=0 si nueva vacia',
  costoCambioEnCupos('multi_equipo', null, { equipos: [] }) === 0);
check('D2 nueva null costo=0',
  costoCambioEnCupos('multi_equipo', { equipos: ['A'] }, null) === 0);
check('D3 ambos null tipo no multi costo=0',
  costoCambioEnCupos('equipo_categoria', null, null) === 0);
check('D4 ambos null multi_equipo costo=0',
  costoCambioEnCupos('multi_equipo', null, null) === 0);
check('D5 string JSON malformado defaulta {}',
  costoCambioEnCupos('multi_equipo', '{malformado', { equipos: ['A'] }) === 1);

// ── E) respuestasIguales ───────────────────────────────────────────────
console.log('\nE) respuestasIguales');
check('E1 multi_equipo: misma lista reordenada iguales',
  respuestasIguales('multi_equipo', { equipos: ['A','B','C'] }, { equipos: ['C','B','A'] }) === true);
check('E2 multi_equipo: tamano distinto NO iguales',
  respuestasIguales('multi_equipo', { equipos: ['A','B'] }, { equipos: ['A','B','C'] }) === false);
check('E3 equipo_categoria: mismo objeto iguales',
  respuestasIguales('equipo_categoria', { equipo: 'ALE' }, { equipo: 'ALE' }) === true);

console.log('\n========================================================');
if (fallos === 0) {
  console.log('OK DIAG: TODOS LOS CHECKS PASARON');
  process.exit(0);
} else {
  console.log(`FAIL DIAG: ${fallos} fallo(s)`);
  process.exit(1);
}
