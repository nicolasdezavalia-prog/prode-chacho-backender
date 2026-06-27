/**
 * diagnostico-mundial-partido-goleadores.js — sprint goleadores por partido.
 *
 * Valida en DB efimera:
 *   A. Schema mundial_partido_goleadores.
 *   B. UNIQUE(partido_id, jugador, equipo_codigo).
 *   C. CHECK(goles > 0).
 *   D. CASCADE: borrar partido borra sus goleadores.
 *   E. Top consolidado: SUM de mundial_goleadores + mundial_partido_goleadores.
 *   F. Autocomplete jugadores: UNION de 4 fuentes, dedupe por nombre normalizado.
 */

const { DatabaseSync } = require('node:sqlite');

let fallos = 0;
function check(n, ok, det) {
  if (ok) console.log(`  OK   ${n}`);
  else { fallos++; console.log(`  FAIL ${n}${det ? ' --- ' + det : ''}`); }
}

console.log('========================================================');
console.log('DIAG GOLEADORES POR PARTIDO');
console.log('========================================================\n');

const db = new DatabaseSync(':memory:');
db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE torneos (id INTEGER PRIMARY KEY);
  INSERT INTO torneos (id) VALUES (1);

  CREATE TABLE mundial_partidos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    torneo_id INTEGER NOT NULL,
    equipo_local TEXT NOT NULL,
    equipo_visitante TEXT NOT NULL,
    goles_local INTEGER,
    goles_visitante INTEGER
  );
  INSERT INTO mundial_partidos (id, torneo_id, equipo_local, equipo_visitante, goles_local, goles_visitante)
    VALUES (10, 1, 'ESP', 'MEX', 2, 1),
           (11, 1, 'ARG', 'BRA', 3, 0);

  CREATE TABLE mundial_partido_goleadores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    torneo_id INTEGER NOT NULL,
    partido_id INTEGER NOT NULL REFERENCES mundial_partidos(id) ON DELETE CASCADE,
    jugador TEXT NOT NULL,
    equipo_codigo TEXT NOT NULL,
    goles INTEGER NOT NULL CHECK(goles > 0),
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(partido_id, jugador, equipo_codigo)
  );
  CREATE TABLE mundial_goleadores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    torneo_id INTEGER NOT NULL,
    jugador TEXT NOT NULL,
    equipo_codigo TEXT NOT NULL,
    goles INTEGER NOT NULL DEFAULT 0,
    activo INTEGER NOT NULL DEFAULT 1,
    UNIQUE(torneo_id, jugador, equipo_codigo)
  );
  CREATE TABLE mundial_datos_utiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    torneo_id INTEGER, tipo TEXT, jugador TEXT, equipo_codigo TEXT,
    activo INTEGER DEFAULT 1
  );
  CREATE TABLE mundial_premios_individuales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    torneo_id INTEGER, jugador TEXT, equipo_codigo TEXT
  );
`);

// ── A) Schema ────────────────────────────────────────────────────────────
console.log('A) Schema');
const cols = db.prepare('PRAGMA table_info(mundial_partido_goleadores)').all().map(c => c.name);
for (const c of ['id', 'torneo_id', 'partido_id', 'jugador', 'equipo_codigo', 'goles', 'created_at']) {
  check(`columna ${c}`, cols.includes(c));
}

// ── B) UNIQUE ────────────────────────────────────────────────────────────
console.log('\nB) UNIQUE(partido_id, jugador, equipo_codigo)');
const ins = db.prepare('INSERT INTO mundial_partido_goleadores (torneo_id, partido_id, jugador, equipo_codigo, goles) VALUES (?,?,?,?,?)');
ins.run(1, 10, 'Yamal', 'ESP', 1);
let dupErr = null;
try { ins.run(1, 10, 'Yamal', 'ESP', 1); } catch (e) { dupErr = e.message; }
check('B1 duplicado mismo partido+jugador+equipo rechaza',
  dupErr && dupErr.includes('UNIQUE'));
// Mismo jugador en OTRO partido es permitido
ins.run(1, 11, 'Yamal', 'ESP', 2);
check('B2 mismo jugador en otro partido OK', true);

// ── C) CHECK goles > 0 ──────────────────────────────────────────────────
console.log('\nC) CHECK(goles > 0)');
let checkErr = null;
try { ins.run(1, 10, 'Otro', 'ESP', 0); } catch (e) { checkErr = e.message; }
check('C1 goles=0 rechaza', checkErr && checkErr.includes('CHECK'));
let negErr = null;
try { ins.run(1, 10, 'OtroX', 'ESP', -1); } catch (e) { negErr = e.message; }
check('C2 goles<0 rechaza', negErr && negErr.includes('CHECK'));

// ── D) CASCADE ──────────────────────────────────────────────────────────
console.log('\nD) ON DELETE CASCADE');
db.prepare('INSERT INTO mundial_partido_goleadores (torneo_id, partido_id, jugador, equipo_codigo, goles) VALUES (?,?,?,?,?)').run(1, 10, 'Pedri', 'ESP', 1);
const antes = db.prepare('SELECT COUNT(*) AS n FROM mundial_partido_goleadores WHERE partido_id = 10').get().n;
check('D1 hay 2 goleadores en partido 10', antes === 2);
db.prepare('DELETE FROM mundial_partidos WHERE id = 10').run();
const despues = db.prepare('SELECT COUNT(*) AS n FROM mundial_partido_goleadores WHERE partido_id = 10').get().n;
check('D2 borrar partido borra goleadores en cascade', despues === 0);

// ── E) Top consolidado ──────────────────────────────────────────────────
console.log('\nE) Top consolidado (UNION manual + por-partido)');
// Re-seed para asegurar datos limpios
db.prepare('DELETE FROM mundial_partido_goleadores').run();
db.prepare('DELETE FROM mundial_goleadores').run();
db.prepare('INSERT INTO mundial_partidos (id, torneo_id, equipo_local, equipo_visitante) VALUES (?,?,?,?)').run(20, 1, 'ARG', 'BRA');

// Manual: Negro carga Messi 2 goles desde Admin → Goleadores
db.prepare('INSERT INTO mundial_goleadores (torneo_id, jugador, equipo_codigo, goles) VALUES (?,?,?,?)').run(1, 'Messi', 'ARG', 2);
db.prepare('INSERT INTO mundial_goleadores (torneo_id, jugador, equipo_codigo, goles) VALUES (?,?,?,?)').run(1, 'Vinicius', 'BRA', 1);
// Por partido: Messi mete 1 en R32 desde el modal Fixture
db.prepare('INSERT INTO mundial_partido_goleadores (torneo_id, partido_id, jugador, equipo_codigo, goles) VALUES (?,?,?,?,?)').run(1, 20, 'Messi', 'ARG', 1);
// Otro jugador nuevo solo en por-partido
db.prepare('INSERT INTO mundial_partido_goleadores (torneo_id, partido_id, jugador, equipo_codigo, goles) VALUES (?,?,?,?,?)').run(1, 20, 'Lautaro', 'ARG', 1);

const top = db.prepare(`
  SELECT jugador, equipo_codigo, SUM(goles) AS goles
  FROM (
    SELECT jugador, equipo_codigo, goles FROM mundial_goleadores
      WHERE torneo_id = ? AND activo = 1
    UNION ALL
    SELECT jugador, equipo_codigo, SUM(goles) AS goles FROM mundial_partido_goleadores
      WHERE torneo_id = ?
      GROUP BY jugador, equipo_codigo
  )
  GROUP BY jugador, equipo_codigo
  ORDER BY goles DESC, jugador ASC
`).all(1, 1);

check('E1 Messi tiene 3 goles totales (2 manuales + 1 por-partido)',
  top.find(t => t.jugador === 'Messi')?.goles === 3);
check('E2 Lautaro tiene 1 gol (solo por-partido)',
  top.find(t => t.jugador === 'Lautaro')?.goles === 1);
check('E3 Vinicius tiene 1 gol (solo manual)',
  top.find(t => t.jugador === 'Vinicius')?.goles === 1);
check('E4 sort por goles DESC: Messi primero', top[0]?.jugador === 'Messi');

// ── F) Autocomplete UNION 4 fuentes ────────────────────────────────────
console.log('\nF) Autocomplete jugadores conocidos');
db.prepare("INSERT INTO mundial_datos_utiles (torneo_id, tipo, jugador, equipo_codigo, activo) VALUES (1, 'goleadores', 'Yamal', 'ESP', 1)").run();
db.prepare("INSERT INTO mundial_premios_individuales (torneo_id, jugador, equipo_codigo) VALUES (1, 'Yamal', 'ESP')").run();
db.prepare("INSERT INTO mundial_partido_goleadores (torneo_id, partido_id, jugador, equipo_codigo, goles) VALUES (1, 20, 'Yamal', 'ESP', 1)").run();
db.prepare("INSERT INTO mundial_partido_goleadores (torneo_id, partido_id, jugador, equipo_codigo, goles) VALUES (1, 20, 'Yamal junior', 'ESP', 1)").run();
// Otro equipo: NO debe aparecer en sugerencias de ESP
db.prepare("INSERT INTO mundial_partido_goleadores (torneo_id, partido_id, jugador, equipo_codigo, goles) VALUES (1, 20, 'Vinicius Jr', 'BRA', 1)").run();

const sug = db.prepare(`
  SELECT jugador, COUNT(*) AS apariciones
  FROM (
    SELECT jugador FROM mundial_datos_utiles
      WHERE torneo_id = ? AND tipo = 'goleadores' AND jugador IS NOT NULL AND activo = 1 AND equipo_codigo = ?
    UNION ALL
    SELECT jugador FROM mundial_goleadores
      WHERE torneo_id = ? AND jugador IS NOT NULL AND activo = 1 AND equipo_codigo = ?
    UNION ALL
    SELECT jugador FROM mundial_premios_individuales
      WHERE torneo_id = ? AND jugador IS NOT NULL AND equipo_codigo = ?
    UNION ALL
    SELECT jugador FROM mundial_partido_goleadores
      WHERE torneo_id = ? AND equipo_codigo = ?
  )
  WHERE jugador IS NOT NULL AND TRIM(jugador) != ''
  GROUP BY LOWER(TRIM(jugador))
  ORDER BY apariciones DESC, jugador ASC
`).all(1, 'ESP', 1, 'ESP', 1, 'ESP', 1, 'ESP');

check('F1 Yamal aparece con 3 apariciones (datos_utiles + premios + partido)',
  sug.find(s => s.jugador === 'Yamal')?.apariciones === 3);
check('F2 "Yamal junior" aparece con 1 aparicion',
  sug.find(s => s.jugador === 'Yamal junior')?.apariciones === 1);
check('F3 Vinicius Jr (BRA) NO aparece en sugerencias ESP',
  !sug.find(s => s.jugador === 'Vinicius Jr'));
check('F4 sort por apariciones DESC: Yamal primero', sug[0]?.jugador === 'Yamal');

console.log('\n========================================================');
if (fallos === 0) {
  console.log('OK DIAG: TODOS LOS CHECKS PASARON');
  process.exit(0);
} else {
  console.log(`FAIL DIAG: ${fallos} fallo(s)`);
  process.exit(1);
}
