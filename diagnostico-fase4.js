/**
 * Diagnóstico Fase 4 — UNIQUE per-liga en gdt_jugadores y gdt_equipos_catalogo.
 *
 * Solo lectura. NO modifica datos. NO corre migraciones.
 *
 * Abre prode.db directamente con node:sqlite en modo readOnly y ejecuta 7 checks
 * para decidir si la migración a UNIQUE per-liga puede correr sin pérdida de datos.
 *
 * Correr con:    node diagnostico-fase4.js
 * Path opcional: DB_PATH=/otra/ruta/prode.db node diagnostico-fase4.js
 *
 * Bloqueantes (NO MIGRAR si > 0):
 *   #3 — duplicados gdt_jugadores que romperían el nuevo UNIQUE
 *   #4 — duplicados gdt_equipos_catalogo que romperían el nuevo UNIQUE
 *   #5 — mismatch gdt_equipos.gdt_liga_id vs gdt_jugadores.gdt_liga_id
 *   #6 — mismatch gdt_jugadores.gdt_liga_id vs gdt_equipos_catalogo.gdt_liga_id
 *
 * No bloqueantes (warning, la migración los maneja o no afectan):
 *   #1 — gdt_jugadores con gdt_liga_id NULL (backfill aditivo se encarga)
 *   #2 — gdt_equipos_catalogo con gdt_liga_id NULL (idem)
 *   #7 — gdt_jugadores con merged_into cross-liga (corrupción histórica, no rompe UNIQUE)
 */
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'prode.db');

// ── Helpers de output ────────────────────────────────────────────────────────
function header(titulo) {
  console.log('\n' + '═'.repeat(72));
  console.log('  ' + titulo);
  console.log('═'.repeat(72));
}

function seccion(num, titulo, bloqueante) {
  console.log(`\n──── ${num}. ${titulo}${bloqueante ? '  [BLOQUEANTE]' : '  [warning]'} ────`);
}

function ok(msg)    { console.log('   ✅ ' + msg); }
function warn(msg)  { console.log('   ⚠️  ' + msg); }
function fail(msg)  { console.log('   ❌ ' + msg); }

function listar(filas, formatear, max = 10) {
  filas.slice(0, max).forEach(f => console.log('      • ' + formatear(f)));
  if (filas.length > max) console.log(`      … y ${filas.length - max} más`);
}

// ── Apertura read-only ───────────────────────────────────────────────────────
let db;
try {
  // node:sqlite acepta { readOnly: true } desde Node 22.5+. Si tu Node no lo soporta
  // (error claro al abrir), avisame y lo cambiamos por una verificación alternativa.
  db = new DatabaseSync(DB_PATH, { readOnly: true });
} catch (e) {
  console.error('❌ No se pudo abrir la DB en read-only.');
  console.error('   Path:', DB_PATH);
  console.error('   Error:', e.message);
  process.exit(2);
}

header('DIAGNÓSTICO FASE 4 — UNIQUE per-liga (gdt_jugadores y gdt_equipos_catalogo)');
console.log(`   Modo: read-only (no se modifican datos, no corre migraciones)`);
console.log(`   DB:   ${DB_PATH}`);

// Sanity: las tablas existen
const tablas = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('gdt_jugadores','gdt_equipos_catalogo','gdt_equipos','gdt_ligas')"
).all().map(r => r.name);
const requeridas = ['gdt_jugadores', 'gdt_equipos_catalogo', 'gdt_equipos', 'gdt_ligas'];
const faltantes = requeridas.filter(t => !tablas.includes(t));
if (faltantes.length > 0) {
  fail('Faltan tablas requeridas: ' + faltantes.join(', '));
  process.exit(2);
}

// Conteos generales
const totalJug = db.prepare('SELECT COUNT(*) AS n FROM gdt_jugadores').get().n;
const totalCat = db.prepare('SELECT COUNT(*) AS n FROM gdt_equipos_catalogo').get().n;
const totalEq  = db.prepare('SELECT COUNT(*) AS n FROM gdt_equipos').get().n;
const totalLig = db.prepare('SELECT COUNT(*) AS n FROM gdt_ligas').get().n;
console.log(`   Filas: gdt_jugadores=${totalJug} · gdt_equipos_catalogo=${totalCat} · gdt_equipos=${totalEq} · gdt_ligas=${totalLig}`);

// Snapshot de los UNIQUE actuales (informativo)
const sqlJug = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='gdt_jugadores'").get()?.sql || '';
const sqlCat = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='gdt_equipos_catalogo'").get()?.sql || '';
const uniqueJugObjetivo = sqlJug.includes('UNIQUE(torneo_id, gdt_liga_id, nombre_normalizado, equipo_real)');
const uniqueCatObjetivo = sqlCat.includes('UNIQUE(torneo_id, gdt_liga_id, nombre_normalizado)');
console.log(`   UNIQUE objetivo aplicado: gdt_jugadores=${uniqueJugObjetivo ? 'sí' : 'no'} · gdt_equipos_catalogo=${uniqueCatObjetivo ? 'sí' : 'no'}`);
if (uniqueJugObjetivo && uniqueCatObjetivo) {
  console.log('   ℹ️  Schema ya está en estado objetivo. La migración Fase 4 no haría nada (idempotente).');
}

// ── Acumulador de bloqueantes ────────────────────────────────────────────────
const issues = { bloqueantes: 0, warnings: 0 };

// ── #1 gdt_jugadores con gdt_liga_id NULL (warning) ──────────────────────────
seccion(1, 'gdt_jugadores con gdt_liga_id NULL', false);
{
  const filas = db.prepare(`
    SELECT id, torneo_id, nombre, equipo_real, estado, activo
    FROM gdt_jugadores WHERE gdt_liga_id IS NULL
    ORDER BY torneo_id, id
  `).all();
  if (filas.length === 0) ok('0 filas');
  else {
    issues.warnings++;
    warn(`${filas.length} fila(s) sin gdt_liga_id. La migración hará backfill defensivo a la liga default.`);
    listar(filas, f => `id=${f.id} torneo=${f.torneo_id} "${f.nombre}" / "${f.equipo_real}" estado=${f.estado} activo=${f.activo}`);
  }
}

// ── #2 gdt_equipos_catalogo con gdt_liga_id NULL (warning) ───────────────────
seccion(2, 'gdt_equipos_catalogo con gdt_liga_id NULL', false);
{
  const filas = db.prepare(`
    SELECT id, torneo_id, nombre, nombre_normalizado, activo
    FROM gdt_equipos_catalogo WHERE gdt_liga_id IS NULL
    ORDER BY torneo_id, id
  `).all();
  if (filas.length === 0) ok('0 filas');
  else {
    issues.warnings++;
    warn(`${filas.length} fila(s) sin gdt_liga_id. La migración hará backfill defensivo.`);
    listar(filas, f => `id=${f.id} torneo=${f.torneo_id} "${f.nombre}" (norm="${f.nombre_normalizado}") activo=${f.activo}`);
  }
}

// ── #3 BLOQUEANTE — duplicados gdt_jugadores por nuevo UNIQUE ────────────────
seccion(3, 'duplicados gdt_jugadores por nuevo UNIQUE(torneo_id, gdt_liga_id, nombre_normalizado, equipo_real)', true);
{
  const grupos = db.prepare(`
    SELECT torneo_id, gdt_liga_id, nombre_normalizado, equipo_real,
           COUNT(*) AS cnt, GROUP_CONCAT(id) AS ids
    FROM gdt_jugadores
    WHERE activo = 1
    GROUP BY torneo_id, gdt_liga_id, nombre_normalizado, equipo_real
    HAVING cnt > 1
    ORDER BY cnt DESC, torneo_id
  `).all();
  if (grupos.length === 0) ok('0 grupos de duplicados');
  else {
    issues.bloqueantes++;
    fail(`${grupos.length} grupo(s) de duplicados — bloquean la migración.`);
    console.log('      Cada grupo debe resolverse vía POST /jugadores/merge entre filas de la MISMA liga.');
    listar(grupos, g => `torneo=${g.torneo_id} liga=${g.gdt_liga_id} "${g.nombre_normalizado}" / "${g.equipo_real}"  cnt=${g.cnt}  ids=[${g.ids}]`);
  }
}

// ── #4 BLOQUEANTE — duplicados gdt_equipos_catalogo por nuevo UNIQUE ─────────
seccion(4, 'duplicados gdt_equipos_catalogo por nuevo UNIQUE(torneo_id, gdt_liga_id, nombre_normalizado)', true);
{
  const grupos = db.prepare(`
    SELECT torneo_id, gdt_liga_id, nombre_normalizado,
           COUNT(*) AS cnt, GROUP_CONCAT(id) AS ids
    FROM gdt_equipos_catalogo
    GROUP BY torneo_id, gdt_liga_id, nombre_normalizado
    HAVING cnt > 1
    ORDER BY cnt DESC, torneo_id
  `).all();
  if (grupos.length === 0) ok('0 grupos de duplicados');
  else {
    issues.bloqueantes++;
    fail(`${grupos.length} grupo(s) de duplicados — bloquean la migración.`);
    console.log('      Cada grupo requiere desactivar (activo=0) las filas duplicadas conservando una.');
    listar(grupos, g => `torneo=${g.torneo_id} liga=${g.gdt_liga_id} norm="${g.nombre_normalizado}"  cnt=${g.cnt}  ids=[${g.ids}]`);
  }
}

// ── #5 BLOQUEANTE — mismatch gdt_equipos.gdt_liga_id vs gdt_jugadores.gdt_liga_id ──
seccion(5, 'mismatch gdt_equipos vs gdt_jugadores (slot apunta a jugador de otra liga)', true);
{
  const filas = db.prepare(`
    SELECT ge.user_id, ge.slot, ge.gdt_liga_id AS liga_equipo,
           gj.id AS jugador_id, gj.nombre, gj.gdt_liga_id AS liga_jugador
    FROM gdt_equipos ge
    JOIN gdt_jugadores gj ON ge.jugador_id = gj.id
    WHERE ge.gdt_liga_id IS NOT NULL
      AND gj.gdt_liga_id IS NOT NULL
      AND ge.gdt_liga_id <> gj.gdt_liga_id
    ORDER BY ge.user_id, ge.slot
  `).all();
  if (filas.length === 0) ok('0 mismatches');
  else {
    issues.bloqueantes++;
    fail(`${filas.length} mismatch(es) — corrupción cross-liga del bug histórico de POST /catalogo/usuario.`);
    console.log('      Resolución: clonar gdt_jugadores en la liga correcta y redirigir gdt_equipos.jugador_id.');
    console.log('      No es automático — pedir intervención manual antes de migrar.');
    listar(filas, f => `user=${f.user_id} slot=${f.slot} liga_equipo=${f.liga_equipo} jugador_id=${f.jugador_id} "${f.nombre}" liga_jugador=${f.liga_jugador}`);
  }
}

// ── #6 BLOQUEANTE — mismatch gdt_jugadores vs gdt_equipos_catalogo ───────────
seccion(6, 'mismatch gdt_jugadores vs gdt_equipos_catalogo (jugador apunta a equipo de otra liga)', true);
{
  const filas = db.prepare(`
    SELECT gj.id AS jugador_id, gj.nombre, gj.gdt_liga_id AS liga_jugador,
           ec.id AS catalogo_id, ec.nombre AS catalogo_nombre, ec.gdt_liga_id AS liga_catalogo
    FROM gdt_jugadores gj
    JOIN gdt_equipos_catalogo ec ON gj.equipo_catalogo_id = ec.id
    WHERE gj.gdt_liga_id IS NOT NULL
      AND ec.gdt_liga_id IS NOT NULL
      AND gj.gdt_liga_id <> ec.gdt_liga_id
    ORDER BY gj.id
  `).all();
  if (filas.length === 0) ok('0 mismatches');
  else {
    issues.bloqueantes++;
    fail(`${filas.length} mismatch(es) — gdt_jugadores.equipo_catalogo_id apunta a otra liga.`);
    console.log('      Resolución: limpiar equipo_catalogo_id (NULL) o reasignarlo a un catálogo de la misma liga.');
    listar(filas, f => `jugador=${f.jugador_id} "${f.nombre}" liga=${f.liga_jugador} → catalogo=${f.catalogo_id} "${f.catalogo_nombre}" liga=${f.liga_catalogo}`);
  }
}

// ── #7 gdt_jugadores con merged_into cross-liga (warning) ────────────────────
seccion(7, 'gdt_jugadores con merged_into cross-liga', false);
{
  const filas = db.prepare(`
    SELECT gj.id, gj.nombre, gj.gdt_liga_id AS liga,
           mt.id AS merged_id, mt.nombre AS merged_nombre, mt.gdt_liga_id AS merged_liga
    FROM gdt_jugadores gj
    JOIN gdt_jugadores mt ON gj.merged_into = mt.id
    WHERE gj.gdt_liga_id IS NOT NULL
      AND mt.gdt_liga_id IS NOT NULL
      AND gj.gdt_liga_id <> mt.gdt_liga_id
    ORDER BY gj.id
  `).all();
  if (filas.length === 0) ok('0 merges cross-liga históricos');
  else {
    issues.warnings++;
    warn(`${filas.length} merge(s) cross-liga histórico(s). No bloquea migración (no viola UNIQUE), pero indica corrupción que C5/C6 va a evitar a futuro vía guard.`);
    listar(filas, f => `id=${f.id} "${f.nombre}" liga=${f.liga} → merged_into=${f.merged_id} "${f.merged_nombre}" liga=${f.merged_liga}`);
  }
}

// ── Veredicto ────────────────────────────────────────────────────────────────
header('VEREDICTO');
if (issues.bloqueantes === 0 && issues.warnings === 0) {
  console.log('\n   ✅ OK PARA MIGRAR — sin issues detectadas.');
  console.log('      Próximo paso: backup manual de prode.db, luego implementar Fase 4 + endpoints C5/C6.');
} else if (issues.bloqueantes === 0) {
  console.log(`\n   ✅ OK PARA MIGRAR — ${issues.warnings} warning(s), ningún bloqueante.`);
  console.log('      Los warnings se resuelven solos durante la migración (backfill defensivo) o quedan');
  console.log('      como corrupción histórica que no impide migrar.');
  console.log('      Próximo paso: backup manual de prode.db, luego implementar Fase 4 + endpoints.');
} else {
  console.log(`\n   ❌ NO MIGRAR — ${issues.bloqueantes} issue(s) bloqueante(s).`);
  console.log('      Resolver los puntos marcados [BLOQUEANTE] antes de tocar el schema.');
  console.log('      Si es necesario, podemos armar un script auxiliar de limpieza dirigido,');
  console.log('      pero la decisión de qué fila conservar la toma vos / el admin.');
}
console.log('');

db.close();
process.exit(issues.bloqueantes > 0 ? 1 : 0);
