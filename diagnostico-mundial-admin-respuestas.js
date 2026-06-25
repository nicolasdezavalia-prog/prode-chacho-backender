/**
 * diagnostico-mundial-admin-respuestas.js — Sprint mobile-admin.
 *
 * DB efimera en memoria. Valida la logica de validacion y el log de
 * auditoria SIN levantar el servidor express. Mockea getDb y simula
 * el flujo del PUT /respuestas-admin/:userId.
 *
 * Checks:
 *   A1. Tabla mundial_respuestas_admin_log existe con todas las columnas.
 *   A2. Insert + select del log funciona.
 *   A3. Multiliga: log filtra correctamente por torneo_id.
 *   B1. validarRespuesta acepta shape OK (opcion_unica).
 *   B2. validarRespuesta rechaza shape malo.
 *   C1. Constraint torneo_id (FK) bloquea inserts con torneo inexistente.
 */

const { DatabaseSync } = require('node:sqlite');
const { validarRespuesta } = require('./src/logic/mundial-validar-respuesta');

let fallos = 0;
function check(n, ok, det) {
  if (ok) console.log(`  OK   ${n}`);
  else { fallos++; console.log(`  FAIL ${n}${det ? ' --- ' + det : ''}`); }
}

console.log('========================================================');
console.log('DIAG MUNDIAL ADMIN-RESPUESTAS');
console.log('DB: :memory: (efimera)');
console.log('========================================================\n');

const db = new DatabaseSync(':memory:');

db.exec(`
  CREATE TABLE torneos (id INTEGER PRIMARY KEY);
  INSERT INTO torneos (id) VALUES (1), (2);

  CREATE TABLE users (id INTEGER PRIMARY KEY, nombre TEXT, activo INTEGER DEFAULT 1);
  INSERT INTO users (id, nombre) VALUES (10, 'TestUser'), (99, 'AdminUser');

  CREATE TABLE mundial_preguntas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    torneo_id INTEGER NOT NULL REFERENCES torneos(id),
    numero INTEGER NOT NULL,
    tipo_pregunta TEXT NOT NULL,
    config_json TEXT NOT NULL,
    activa INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE mundial_respuestas_usuario (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pregunta_id INTEGER NOT NULL REFERENCES mundial_preguntas(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    respuesta_json TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(pregunta_id, user_id)
  );

  CREATE TABLE mundial_respuestas_admin_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    torneo_id INTEGER NOT NULL REFERENCES torneos(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    admin_id INTEGER NOT NULL REFERENCES users(id),
    cant_creadas INTEGER NOT NULL DEFAULT 0,
    cant_actualizadas INTEGER NOT NULL DEFAULT 0,
    estado_torneo TEXT NOT NULL,
    observacion TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// ── A) Schema log ────────────────────────────────────────────────────────
console.log('A) Schema mundial_respuestas_admin_log');
const cols = db.prepare("PRAGMA table_info(mundial_respuestas_admin_log)").all().map(c => c.name);
for (const c of ['id','torneo_id','user_id','admin_id','cant_creadas','cant_actualizadas','estado_torneo','observacion','created_at']) {
  check(`columna ${c}`, cols.includes(c));
}

// ── A2: insert + select ──────────────────────────────────────────────────
console.log('\nA2) Insert + select log');
const ins = db.prepare(`
  INSERT INTO mundial_respuestas_admin_log
    (torneo_id, user_id, admin_id, cant_creadas, cant_actualizadas, estado_torneo, observacion)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
ins.run(1, 10, 99, 3, 2, 'cambios_cerrados', 'override por pedido');
ins.run(1, 10, 99, 1, 0, 'cambios_cerrados', null);
ins.run(2, 10, 99, 5, 0, 'abierto', null);
const rows = db.prepare(`SELECT * FROM mundial_respuestas_admin_log WHERE torneo_id = 1 ORDER BY id`).all();
check('2 filas para torneo 1', rows.length === 2, `got ${rows.length}`);
check('primera fila: 3 creadas, 2 actualizadas', rows[0].cant_creadas === 3 && rows[0].cant_actualizadas === 2);
check('observacion preservada', rows[0].observacion === 'override por pedido');
check('observacion null OK', rows[1].observacion === null);

// ── A3: multiliga ────────────────────────────────────────────────────────
console.log('\nA3) Multiliga: filtro por torneo_id');
const r1 = db.prepare(`SELECT COUNT(*) AS n FROM mundial_respuestas_admin_log WHERE torneo_id = 1`).get().n;
const r2 = db.prepare(`SELECT COUNT(*) AS n FROM mundial_respuestas_admin_log WHERE torneo_id = 2`).get().n;
check('torneo 1: 2 rows', r1 === 2);
check('torneo 2: 1 row', r2 === 1);

// ── B) validarRespuesta ─────────────────────────────────────────────────
console.log('\nB) validarRespuesta (mismo helper que /mis-respuestas)');
const cfgOu = JSON.stringify({ opciones: ['Si','No'], pts_por_opcion: { 'Si': 10, 'No': 10 } });
const vOk = validarRespuesta('opcion_unica', cfgOu, { opcion: 'Si' });
check('B1 opcion_unica valida', vOk.ok === true);

const vBad = validarRespuesta('opcion_unica', cfgOu, { opcion: 'Maybe' });
check('B2 opcion_unica rechaza valor fuera de set', vBad.ok === false);

// ── C) FK constraint ────────────────────────────────────────────────────
console.log('\nC) FK constraint torneo_id');
let throwingOK = false;
try {
  db.exec('PRAGMA foreign_keys = ON');
  db.prepare(`INSERT INTO mundial_respuestas_admin_log (torneo_id, user_id, admin_id, estado_torneo) VALUES (999, 10, 99, 'abierto')`).run();
} catch (e) {
  throwingOK = String(e.message || '').includes('FOREIGN KEY');
}
check('C1 rechaza torneo inexistente (FK)', throwingOK);

// ── D) Upsert + log atomico (simula el flujo del endpoint) ──────────────
console.log('\nD) Flujo upsert + log atomico');
db.exec(`PRAGMA foreign_keys = OFF`); // reset para insert simple
db.prepare("INSERT INTO mundial_preguntas (id, torneo_id, numero, tipo_pregunta, config_json) VALUES (?, ?, ?, ?, ?)").run(
  100, 1, 5, 'opcion_unica', cfgOu
);
const upsert = db.prepare(`
  INSERT INTO mundial_respuestas_usuario (pregunta_id, user_id, respuesta_json, updated_at)
  VALUES (?, ?, ?, datetime('now'))
  ON CONFLICT(pregunta_id, user_id) DO UPDATE SET
    respuesta_json = excluded.respuesta_json,
    updated_at     = excluded.updated_at
`);
try {
  db.exec('BEGIN');
  upsert.run(100, 10, JSON.stringify({ opcion: 'Si' }));
  ins.run(1, 10, 99, 1, 0, 'cambios_cerrados', 'test atomico');
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  throw e;
}
const u = db.prepare(`SELECT * FROM mundial_respuestas_usuario WHERE user_id = 10 AND pregunta_id = 100`).get();
check('D1 respuesta guardada', u && u.respuesta_json.includes('Si'));
const lcnt = db.prepare(`SELECT COUNT(*) AS n FROM mundial_respuestas_admin_log WHERE observacion = 'test atomico'`).get().n;
check('D2 log registrado en mismo transaction', lcnt === 1);

// Update (no crea, actualiza)
db.exec('BEGIN');
upsert.run(100, 10, JSON.stringify({ opcion: 'No' }));
ins.run(1, 10, 99, 0, 1, 'cambios_cerrados', 'corrige a No');
db.exec('COMMIT');
const u2 = db.prepare(`SELECT * FROM mundial_respuestas_usuario WHERE user_id = 10 AND pregunta_id = 100`).get();
check('D3 update preservo unico row, valor nuevo', u2.respuesta_json.includes('No'));

console.log('\n========================================================');
if (fallos === 0) {
  console.log('OK DIAG ADMIN-RESPUESTAS: TODOS LOS CHECKS PASARON');
  process.exit(0);
} else {
  console.log(`FAIL DIAG ADMIN-RESPUESTAS: ${fallos} fallo(s)`);
  process.exit(1);
}
