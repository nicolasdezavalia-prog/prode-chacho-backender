/**
 * diagnostico-mundial-cambios-historial.js — sprint cambios por ventana.
 *
 * Valida en DB efimera:
 *   A. Estados permitidos para cargar cambios (post fix).
 *      - configuracion → bloqueado
 *      - finalizado → bloqueado
 *      - todos los demas (incluido grupos_jugados) → permitidos
 *   B. Historial de cambios publicados se construye correctamente.
 *      - Solo cambios con publicado=1
 *      - Ordenados por fecha asc
 *      - Multiples cambios por (pregunta, user) en distintas ventanas
 */

const { DatabaseSync } = require('node:sqlite');

let fallos = 0;
function check(n, ok, det) {
  if (ok) console.log(`  OK   ${n}`);
  else { fallos++; console.log(`  FAIL ${n}${det ? ' --- ' + det : ''}`); }
}

console.log('========================================================');
console.log('DIAG CAMBIOS POR VENTANA + HISTORIAL');
console.log('========================================================\n');

const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE torneos (id INTEGER PRIMARY KEY);
  INSERT INTO torneos (id) VALUES (1);
  CREATE TABLE users (id INTEGER PRIMARY KEY, nombre TEXT);
  INSERT INTO users (id, nombre) VALUES (10, 'Negro'), (11, 'Chacho');
  CREATE TABLE mundial_preguntas (
    id INTEGER PRIMARY KEY, torneo_id INTEGER, numero INTEGER,
    enunciado TEXT, tipo_pregunta TEXT, config_json TEXT, activa INTEGER DEFAULT 1
  );
  INSERT INTO mundial_preguntas (id, torneo_id, numero, enunciado, tipo_pregunta, config_json)
    VALUES (100, 1, 5, 'Goleador', 'respuesta_manual', '{}');
  CREATE TABLE mundial_ventanas_cambios (
    id INTEGER PRIMARY KEY, torneo_id INTEGER, nombre TEXT,
    costo_usd INTEGER, cambios_por_usuario INTEGER, estado TEXT
  );
  INSERT INTO mundial_ventanas_cambios (id, torneo_id, nombre, costo_usd, cambios_por_usuario, estado)
    VALUES (1, 1, 'Ventana 1', 5, 3, 'publicada'),
           (2, 1, 'Ventana 2', 10, 2, 'publicada'),
           (3, 1, 'Ventana 3', 5, 1, 'abierta');
  CREATE TABLE mundial_cambios_respuesta (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ventana_id INTEGER, torneo_id INTEGER, user_id INTEGER, pregunta_id INTEGER,
    respuesta_anterior_json TEXT, respuesta_nueva_json TEXT,
    costo_usd INTEGER, publicado INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// ── A) Lógica de estados (replica del check del endpoint) ────────────────
console.log('A) Estados permitidos');
function estadoBloqueado(estado) {
  return estado === 'configuracion' || estado === 'finalizado';
}
check('A1 configuracion bloqueado', estadoBloqueado('configuracion') === true);
check('A2 finalizado bloqueado', estadoBloqueado('finalizado') === true);
check('A3 abierto permitido', estadoBloqueado('abierto') === false);
check('A4 cerrado permitido', estadoBloqueado('cerrado') === false);
check('A5 grupos_jugados permitido (el caso del usuario)',
  estadoBloqueado('grupos_jugados') === false);
check('A6 cambios_abiertos permitido (legacy)',
  estadoBloqueado('cambios_abiertos') === false);
check('A7 cambios_cerrados permitido', estadoBloqueado('cambios_cerrados') === false);
check('A8 resultados permitido', estadoBloqueado('resultados') === false);

// ── B) Historial ──────────────────────────────────────────────────────────
console.log('\nB) Historial de cambios');

// Seed: Negro hizo 2 cambios publicados en distintas ventanas, 1 pendiente.
//   V1 publicada: Mbappe -> Haaland
//   V2 publicada: Haaland -> Vinicius
//   V3 abierta (pendiente): Vinicius -> Salah  (publicado=0)
const ins = db.prepare(`INSERT INTO mundial_cambios_respuesta
  (ventana_id, torneo_id, user_id, pregunta_id, respuesta_anterior_json, respuesta_nueva_json, costo_usd, publicado, created_at)
  VALUES (?,?,?,?,?,?,?,?,?)`);
ins.run(1, 1, 10, 100, '{"texto":"Mbappe"}', '{"texto":"Haaland"}', 5, 1, '2026-06-01 10:00');
ins.run(2, 1, 10, 100, '{"texto":"Haaland"}', '{"texto":"Vinicius"}', 10, 1, '2026-06-15 12:00');
ins.run(3, 1, 10, 100, '{"texto":"Vinicius"}', '{"texto":"Salah"}', 5, 0, '2026-06-25 14:00');
// Chacho hizo 1 cambio publicado.
ins.run(1, 1, 11, 100, '{"texto":"Kane"}', '{"texto":"Lewandowski"}', 5, 1, '2026-06-01 11:00');

// Query del endpoint (igual al cambio del backend)
const rows = db.prepare(`
  SELECT c.pregunta_id, c.user_id, c.respuesta_anterior_json, c.respuesta_nueva_json,
         c.costo_usd, c.created_at, v.nombre AS ventana_nombre
  FROM mundial_cambios_respuesta c
  JOIN mundial_ventanas_cambios v ON v.id = c.ventana_id
  WHERE c.torneo_id = ? AND c.publicado = 1
  ORDER BY c.pregunta_id, c.user_id, c.created_at ASC
`).all(1);

const historial = new Map();
for (const h of rows) {
  const key = `${h.pregunta_id}_${h.user_id}`;
  if (!historial.has(key)) historial.set(key, []);
  historial.get(key).push(h);
}

check('B1 Negro tiene 2 cambios publicados', historial.get('100_10')?.length === 2);
check('B2 NO incluye el cambio pendiente (publicado=0)',
  historial.get('100_10')?.every(h => h.respuesta_nueva_json !== '{"texto":"Salah"}'));
check('B3 Orden cronologico asc', historial.get('100_10')?.[0]?.created_at < historial.get('100_10')?.[1]?.created_at);

const hNegro = historial.get('100_10');
check('B4 cambio 1: Mbappe -> Haaland',
  hNegro[0].respuesta_anterior_json === '{"texto":"Mbappe"}' && hNegro[0].respuesta_nueva_json === '{"texto":"Haaland"}');
check('B5 cambio 2: Haaland -> Vinicius',
  hNegro[1].respuesta_anterior_json === '{"texto":"Haaland"}' && hNegro[1].respuesta_nueva_json === '{"texto":"Vinicius"}');
check('B6 cada cambio trae el nombre de la ventana',
  hNegro[0].ventana_nombre === 'Ventana 1' && hNegro[1].ventana_nombre === 'Ventana 2');
check('B7 costos preservados', hNegro[0].costo_usd === 5 && hNegro[1].costo_usd === 10);

check('B8 Chacho tiene 1 cambio publicado', historial.get('100_11')?.length === 1);

// Para usuarios sin cambios, el map no tiene la key
check('B9 Pregunta-user sin cambios → no key en map', !historial.has('100_99'));

// ── C) Multiliga ────────────────────────────────────────────────────────
console.log('\nC) Multiliga');
// torneo_id en WHERE → torneo 2 no aparece
const torneo2 = db.prepare(
  `SELECT COUNT(*) AS n FROM mundial_cambios_respuesta WHERE torneo_id = 2 AND publicado = 1`
).get();
check('C1 Filtra por torneo_id correctamente', torneo2.n === 0);

console.log('\n========================================================');
if (fallos === 0) {
  console.log('OK DIAG CAMBIOS+HISTORIAL: TODOS LOS CHECKS PASARON');
  process.exit(0);
} else {
  console.log(`FAIL DIAG: ${fallos} fallo(s)`);
  process.exit(1);
}
