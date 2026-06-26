/**
 * diagnostico-mundial-exclusion-comida.js — sprint exclusion-comida.
 *
 * Valida en DB efimera:
 *   A. Schema: columna torneo_jugadores.excluido_comida.
 *   B. Default = 0 al insertar sin valor explicito.
 *   C. UPDATE → SELECT refleja el cambio.
 *   D. Logica de shift de "posicion efectiva" (replicada en frontend):
 *      ranking ordenado por pts → si excluyo al 2do, el rol del 2do baja al 3ero.
 */

const { DatabaseSync } = require('node:sqlite');

let fallos = 0;
function check(n, ok, det) {
  if (ok) console.log(`  OK   ${n}`);
  else { fallos++; console.log(`  FAIL ${n}${det ? ' --- ' + det : ''}`); }
}

console.log('========================================================');
console.log('DIAG EXCLUSION-COMIDA');
console.log('DB: :memory: (efimera)');
console.log('========================================================\n');

const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE torneos (id INTEGER PRIMARY KEY);
  INSERT INTO torneos (id) VALUES (1), (2);
  CREATE TABLE users (id INTEGER PRIMARY KEY, nombre TEXT, activo INTEGER DEFAULT 1);
  INSERT INTO users (id, nombre) VALUES (10, 'Chacho'), (11, 'Nico'), (12, 'Juanmar'), (13, 'Pato');

  CREATE TABLE torneo_jugadores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    torneo_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    excluido_comida INTEGER NOT NULL DEFAULT 0,
    UNIQUE(torneo_id, user_id)
  );
`);

// ── A) Schema ────────────────────────────────────────────────────────────
console.log('A) Schema');
const cols = db.prepare(`PRAGMA table_info(torneo_jugadores)`).all().map(c => c.name);
check('columna excluido_comida existe', cols.includes('excluido_comida'));
const info = db.prepare(`PRAGMA table_info(torneo_jugadores)`).all().find(c => c.name === 'excluido_comida');
check('tipo INTEGER NOT NULL DEFAULT 0', info && info.type === 'INTEGER' && info.notnull === 1 && info.dflt_value === '0');

// ── B) Default = 0 ──────────────────────────────────────────────────────
console.log('\nB) Default 0');
db.prepare('INSERT INTO torneo_jugadores (torneo_id, user_id) VALUES (?, ?)').run(1, 10);
db.prepare('INSERT INTO torneo_jugadores (torneo_id, user_id) VALUES (?, ?)').run(1, 11);
db.prepare('INSERT INTO torneo_jugadores (torneo_id, user_id) VALUES (?, ?)').run(1, 12);
db.prepare('INSERT INTO torneo_jugadores (torneo_id, user_id) VALUES (?, ?)').run(1, 13);
db.prepare('INSERT INTO torneo_jugadores (torneo_id, user_id) VALUES (?, ?)').run(2, 13);
const todos = db.prepare('SELECT * FROM torneo_jugadores WHERE torneo_id=1').all();
check('4 jugadores torneo 1', todos.length === 4);
check('default excluido_comida = 0', todos.every(j => j.excluido_comida === 0));

// ── C) UPDATE ────────────────────────────────────────────────────────────
console.log('\nC) UPDATE refleja cambio');
db.prepare('UPDATE torneo_jugadores SET excluido_comida=? WHERE torneo_id=? AND user_id=?').run(1, 1, 11);
const nico = db.prepare('SELECT * FROM torneo_jugadores WHERE torneo_id=1 AND user_id=11').get();
check('Nico ahora excluido', nico.excluido_comida === 1);
const chacho = db.prepare('SELECT * FROM torneo_jugadores WHERE torneo_id=1 AND user_id=10').get();
check('Chacho NO excluido (sin cambio)', chacho.excluido_comida === 0);

// Multiliga: torneo 2 no se ve afectado.
const pato_t2 = db.prepare('SELECT * FROM torneo_jugadores WHERE torneo_id=2 AND user_id=13').get();
check('multiliga: torneo 2 NO afectado', pato_t2.excluido_comida === 0);

// ── D) Shift de posicion efectiva ───────────────────────────────────────
console.log('\nD) Shift de posicion efectiva');

// Helper IDENTICO al de MundialRanking.jsx (importante mantenerlo sincronizado)
function buildComidaPorUserId(ranking, comidaPorPosicion) {
  const out = new Map();
  if (!Array.isArray(ranking) || !comidaPorPosicion || comidaPorPosicion.size === 0) return out;
  const eligibles = ranking.filter(r => !r.excluido_comida);
  let posEfectiva = 0;
  let prevPosOriginal = null;
  for (let i = 0; i < eligibles.length; i++) {
    const r = eligibles[i];
    if (r.posicion !== prevPosOriginal) {
      posEfectiva = i + 1;
      prevPosOriginal = r.posicion;
    }
    const rol = comidaPorPosicion.get(posEfectiva);
    if (rol) out.set(r.user_id, rol);
  }
  return out;
}

const comidaPorPosicion = new Map([
  [1, 'gratis'], [2, 'gratis'], [3, 'gratis'],
  [4, 'paga'],   [5, 'organiza'],
]);

// D1: ranking SIN excluidos → asignacion identica a la posicion real
const ranking1 = [
  { user_id: 10, posicion: 1, excluido_comida: false }, // Chacho
  { user_id: 11, posicion: 2, excluido_comida: false }, // Nico
  { user_id: 12, posicion: 3, excluido_comida: false }, // Juanmar
  { user_id: 13, posicion: 4, excluido_comida: false }, // Pato
  { user_id: 14, posicion: 5, excluido_comida: false }, // X
];
const m1 = buildComidaPorUserId(ranking1, comidaPorPosicion);
check('D1 sin excluidos: Chacho=gratis', m1.get(10) === 'gratis');
check('D1 sin excluidos: Pato=paga', m1.get(13) === 'paga');
check('D1 sin excluidos: X=organiza', m1.get(14) === 'organiza');

// D2: Nico (2do) excluido → su "gratis" baja al 3ero (Juanmar)
//   Real:    [Chacho 1, Nico 2(excl), Juanmar 3, Pato 4, X 5]
//   Eligible:[Chacho, Juanmar, Pato, X]  → efectiva 1,2,3,4
//   Roles:   gratis, gratis, gratis, paga
const ranking2 = [
  { user_id: 10, posicion: 1, excluido_comida: false }, // Chacho → efectiva 1 = gratis
  { user_id: 11, posicion: 2, excluido_comida: true },  // Nico EXCLUIDO
  { user_id: 12, posicion: 3, excluido_comida: false }, // Juanmar → efectiva 2 = gratis
  { user_id: 13, posicion: 4, excluido_comida: false }, // Pato → efectiva 3 = gratis
  { user_id: 14, posicion: 5, excluido_comida: false }, // X → efectiva 4 = paga
];
const m2 = buildComidaPorUserId(ranking2, comidaPorPosicion);
check('D2 Nico excluido: no aparece en map', !m2.has(11));
check('D2 Chacho sigue gratis', m2.get(10) === 'gratis');
check('D2 Juanmar SUBE a gratis (era paga sin shift)', m2.get(12) === 'gratis');
check('D2 Pato SUBE a gratis', m2.get(13) === 'gratis');
check('D2 X SUBE a paga (era organiza sin shift)', m2.get(14) === 'paga');

// D3: empate en posicion 2 (Nico y Juanmar comparten posicion=2)
const ranking3 = [
  { user_id: 10, posicion: 1, excluido_comida: false }, // Chacho
  { user_id: 11, posicion: 2, excluido_comida: false }, // Nico  } empate
  { user_id: 12, posicion: 2, excluido_comida: false }, // Juanmar} empate
  { user_id: 13, posicion: 4, excluido_comida: false }, // Pato
];
const m3 = buildComidaPorUserId(ranking3, comidaPorPosicion);
check('D3 Nico y Juanmar comparten posicion 2 → ambos gratis',
  m3.get(11) === 'gratis' && m3.get(12) === 'gratis');
check('D3 Pato en posicion 4 real → posicion efectiva 4 = paga', m3.get(13) === 'paga');

// D4: excluir al 1ero
const ranking4 = [
  { user_id: 10, posicion: 1, excluido_comida: true },  // Chacho EXCLUIDO
  { user_id: 11, posicion: 2, excluido_comida: false }, // Nico → efectiva 1 = gratis
];
const m4 = buildComidaPorUserId(ranking4, comidaPorPosicion);
check('D4 Chacho excluido NO recibe rol', !m4.has(10));
check('D4 Nico ahora come gratis (era gratis igual, pero por shift)', m4.get(11) === 'gratis');

// D5: comidaPorPosicion vacio → map vacio
const m5 = buildComidaPorUserId(ranking1, new Map());
check('D5 comidaPorPosicion vacio → map vacio', m5.size === 0);

// D6: ranking vacio → map vacio
const m6 = buildComidaPorUserId([], comidaPorPosicion);
check('D6 ranking vacio → map vacio', m6.size === 0);

console.log('\n========================================================');
if (fallos === 0) {
  console.log('OK DIAG EXCLUSION-COMIDA: TODOS LOS CHECKS PASARON');
  process.exit(0);
} else {
  console.log(`FAIL DIAG EXCLUSION-COMIDA: ${fallos} fallo(s)`);
  process.exit(1);
}
