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
const { calcularStats } = require('./src/logic/mundial-stats');

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

// ── 2b) MÓDULO DE STATS (unit, fixture sintético de resultados conocidos) ───
console.log('\n2b) MUNDIAL-STATS (C3): fixture sintético');
{
  const catalogo = [
    { codigo: 'A1', nombre: 'Alfa', grupo: 'A', confederacion: 'UEFA' },
    { codigo: 'A2', nombre: 'Beta', grupo: 'A', confederacion: 'AFC' },
    { codigo: 'A3', nombre: 'Gama', grupo: 'A', confederacion: 'CONMEBOL' },
    { codigo: 'A4', nombre: 'Delta', grupo: 'A', confederacion: 'AFC' },
    { codigo: 'B1', nombre: 'Eco', grupo: 'B', confederacion: 'UEFA' },
    { codigo: 'C1', nombre: 'Fox', grupo: 'C', confederacion: 'CAF' },
  ];
  const F = (o) => ({ estado: 'finalizado', penales_local: null, penales_visitante: null,
    amarillas_local: null, amarillas_visitante: null, rojas_local: null, rojas_visitante: null, ...o });
  const partidos = [
    F({ ronda: 'grupos', grupo: 'A', orden: 0, equipo_local: 'A1', equipo_visitante: 'A2', goles_local: 3, goles_visitante: 0, amarillas_local: 2, amarillas_visitante: 1, rojas_local: 0, rojas_visitante: 1 }),
    F({ ronda: 'grupos', grupo: 'A', orden: 1, equipo_local: 'A3', equipo_visitante: 'A4', goles_local: 1, goles_visitante: 1, amarillas_local: 0, amarillas_visitante: 3, rojas_local: 0, rojas_visitante: 0 }),
    F({ ronda: 'grupos', grupo: 'A', orden: 2, equipo_local: 'A1', equipo_visitante: 'A3', goles_local: 2, goles_visitante: 1, amarillas_local: 1, amarillas_visitante: 1, rojas_local: 0, rojas_visitante: 0 }),
    F({ ronda: 'grupos', grupo: 'A', orden: 3, equipo_local: 'A2', equipo_visitante: 'A4', goles_local: 2, goles_visitante: 0, amarillas_local: 0, amarillas_visitante: 0, rojas_local: 0, rojas_visitante: 0 }),
    F({ ronda: 'grupos', grupo: 'A', orden: 4, equipo_local: 'A1', equipo_visitante: 'A4', goles_local: 0, goles_visitante: 0 }),
    F({ ronda: 'grupos', grupo: 'A', orden: 5, equipo_local: 'A2', equipo_visitante: 'A3', goles_local: 1, goles_visitante: 0, amarillas_local: 1, amarillas_visitante: 2, rojas_local: 0, rojas_visitante: 0 }),
    F({ ronda: 'semis', grupo: null, orden: 0, equipo_local: 'A1', equipo_visitante: 'B1', goles_local: 1, goles_visitante: 1, penales_local: 5, penales_visitante: 4 }),
    { ronda: 'tercer_puesto', grupo: null, orden: 0, equipo_local: 'B1', equipo_visitante: 'A2', estado: 'pendiente', goles_local: null, goles_visitante: null, penales_local: null, penales_visitante: null, amarillas_local: null, amarillas_visitante: null, rojas_local: null, rojas_visitante: null },
    F({ ronda: 'final', grupo: null, orden: 0, equipo_local: 'A1', equipo_visitante: 'C1', goles_local: 2, goles_visitante: 0 }),
  ];
  const s = calcularStats({ partidos, catalogo, tarjetasLegacy: [], topLimit: 5 });
  const A = s.tabla_grupos.find(g => g.grupo === 'A');
  check('grupo A completo 6/6', A.completo === true && A.jugados === 6);
  check('posiciones A1,A2,A4,A3', A.equipos.map(e => e.equipo_codigo).join(',') === 'A1,A2,A4,A3', A.equipos.map(e => e.equipo_codigo));
  const a1 = A.equipos[0];
  check('A1: 7pts 3PJ 2G 1E 0P 5GF 1GC +4DG', a1.pts === 7 && a1.pj === 3 && a1.g === 2 && a1.e === 1 && a1.p === 0 && a1.gf === 5 && a1.gc === 1 && a1.dg === 4, a1);
  check('empates grupo A = 2', s.empates_por_grupo.find(g => g.grupo === 'A').empates === 2);
  const eqA1 = s.equipos.find(e => e.equipo_codigo === 'A1');
  check('A1 gf_grupos=5, gf_total=8', eqA1.gf_grupos === 5 && eqA1.gf_total === 8, eqA1);
  check('fuente=fixture, 3 partidos con tarjetas pendientes', s.tarjetas.fuente === 'fixture' && s.tarjetas.pendientes === 3, s.tarjetas);
  check('top amarillas A1=3, top rojas A2=1', s.tops.amarillas[0].equipo_codigo === 'A1' && s.tops.amarillas[0].total === 3 && s.tops.rojas[0].equipo_codigo === 'A2', s.tops);
  check('top goleador grupos A1(5), goleado A3(4)', s.tops.goleadores_grupos[0].equipo_codigo === 'A1' && s.tops.goleados_grupos[0].equipo_codigo === 'A3');
  const get = c => s.equipos.find(e => e.equipo_codigo === c);
  check('A1 campeón', get('A1').estado === 'campeon' && s.campeon === 'A1');
  check('C1 eliminado en final', get('C1').estado === 'eliminado' && get('C1').eliminado_en === 'final');
  check('B1 perdió semi pero juega 3er puesto → clasificado (vivo)', get('B1').estado === 'clasificado' && get('B1').ronda_alcanzada === 'tercer_puesto', get('B1'));
  // Formato 2026: el 4° (A3) queda eliminado; el 3° (A4) entra a la tabla de
  // terceros — 'clasificaria' PROVISORIO (1 de 3 grupos completos) → en_juego.
  check('A3 (4° del grupo) eliminado en grupos', get('A3').estado === 'eliminado' && get('A3').eliminado_en === 'grupos', get('A3'));
  check('A4 (3°) NO eliminado: ranking de terceros provisorio → en_juego', get('A4').estado === 'en_juego' && get('A4').eliminado_en === null, get('A4'));
  check('terceros: no definitivo (1/3 grupos completos), cupos 8', s.terceros.definitivo === false && s.terceros.grupos_completos === 1 && s.terceros.cupos === 8, s.terceros);
  const t3A = s.terceros.items.find(r => r.grupo === 'A');
  check('terceros: fila grupo A = A4, ranking 1, clasificaria, 2pts DG-2', t3A?.equipo_codigo === 'A4' && t3A.ranking === 1 && t3A.estado === 'clasificaria' && t3A.pts === 2 && t3A.dg === -2, t3A);
  check('clasificados = A1,A2,B1,C1 (A4 provisorio NO entra)', JSON.stringify([...s.clasificados].sort()) === JSON.stringify(['A1', 'A2', 'B1', 'C1']), s.clasificados);
  check('nota_desempate presente (declaración obligatoria)', typeof s.nota_desempate === 'string' && s.nota_desempate.includes('simplificado'));
  const s2 = calcularStats({ partidos: [], catalogo, tarjetasLegacy: [{ equipo_codigo: 'A1', amarillas: 4, rojas: 1 }] });
  check('sin finalizados: fuente=matriz, tops desde legacy', s2.tarjetas.fuente === 'matriz' && s2.tops.amarillas[0]?.total === 4, s2.tops.amarillas);
  check('sin finalizados: terceros pendientes, no definitivo', s2.terceros.definitivo === false && s2.terceros.items.every(r => r.estado === 'pendiente'), s2.terceros.items);
}

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

// ── 5b) C5/C6: integridad de goleadores y premios individuales ──────────────
console.log('\n5b) GOLEADORES Y PREMIOS INDIVIDUALES (C5/C6)');
for (const t of torneos) {
  const gole = db.prepare('SELECT * FROM mundial_goleadores WHERE torneo_id = ?').all(t.id);
  const prem = db.prepare('SELECT * FROM mundial_premios_individuales WHERE torneo_id = ?').all(t.id);
  if (gole.length === 0 && prem.length === 0) continue;
  console.log(`  Torneo ${t.id} (${t.nombre}): ${gole.length} goleadores, ${prem.length} premios`);
  const catSet = new Set(
    db.prepare('SELECT codigo FROM mundial_equipos_catalogo WHERE torneo_id = ? AND activo = 1').all(t.id).map(r => r.codigo)
  );
  let errs = 0;
  for (const g of gole) {
    if (!catSet.has(g.equipo_codigo)) { errs++; console.log(`  ! goleador ${g.jugador}: equipo ${g.equipo_codigo} fuera de catálogo`); }
    if (!Number.isInteger(g.goles) || g.goles < 0) { errs++; console.log(`  ! goleador ${g.jugador}: goles inválidos`); }
  }
  for (const p of prem) {
    if (p.equipo_codigo && !catSet.has(p.equipo_codigo)) { errs++; console.log(`  ! premio ${p.premio}: equipo ${p.equipo_codigo} fuera de catálogo`); }
    if (p.pregunta_id) {
      const preg = db.prepare('SELECT id FROM mundial_preguntas WHERE id = ? AND torneo_id = ?').get(p.pregunta_id, t.id);
      if (!preg) { errs++; console.log(`  ! premio ${p.premio}: pregunta_id ${p.pregunta_id} no pertenece al torneo`); }
    }
  }
  check(`torneo ${t.id}: integridad goleadores/premios`, errs === 0, `${errs} problemas`);
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
  ['mundial_goleadores', 'goleadores estructurados'],
  ['mundial_premios_individuales', 'premios individuales'],
]) {
  const n = db.prepare(`SELECT COUNT(*) c FROM ${tabla}`).get().c;
  console.log(`  ${label}: ${n}`);
}
console.log('  (comparar manualmente antes/después de operar el fixture: deben ser idénticos salvo acciones explícitas del admin)');

console.log('\n════════════════════════════════════════════════════════');
console.log(fallos === 0 ? 'RESULTADO: TODO OK ✔' : `RESULTADO: ${fallos} FALLOS ✘`);
console.log('════════════════════════════════════════════════════════');
process.exit(fallos === 0 ? 0 : 1);
