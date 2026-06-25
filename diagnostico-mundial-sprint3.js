/**
 * diagnostico-mundial-sprint3.js — Sprint 3 backend.
 *
 * Verifica:
 *   A. ordenarConLoPusieron — items con lo_pusieron a igual valor van primero.
 *   B. P11-P16 — proyeccion instancia_eliminacion.
 *   C. Mapping AFC — pregunta numero=10 disponible para chip.
 */
const { ordenarConLoPusieron, MAPPING } = require('./src/logic/mundial-pusieron');
const { esProyectable, proyectarPregunta } = require('./src/logic/mundial-proyeccion');

let fallos = 0;
function check(n, ok, det) {
  if (ok) console.log(`  OK   ${n}`);
  else { fallos++; console.log(`  FAIL ${n}${det ? ' --- ' + det : ''}`); }
}

console.log('========================================================');
console.log('DIAG SPRINT 3 - sort tops, P11-P16, AFC');
console.log('========================================================\n');

// ── A. ordenarConLoPusieron ─────────────────────────────────────────────
console.log('A) ordenarConLoPusieron');

// A1: a igual valor, los con lo_pusieron van primero, preservando orden de los demas
const items = [
  { id: 'a', total: 5, lo_pusieron: [] },
  { id: 'b', total: 5, lo_pusieron: [{ user_id: 1 }] },
  { id: 'c', total: 3, lo_pusieron: [] },
  { id: 'd', total: 3, lo_pusieron: [{ user_id: 2 }] },
];
const sorted = ordenarConLoPusieron(items, x => x.total);
check('A1 conserva grupos por valor (orden primario)',
  sorted.map(x => x.total).join() === '5,5,3,3', `got ${sorted.map(x=>x.total).join()}`);
check('A1 dentro de valor=5: b (con lo_pusieron) antes que a',
  sorted[0].id === 'b' && sorted[1].id === 'a', `got ${sorted[0].id},${sorted[1].id}`);
check('A1 dentro de valor=3: d (con lo_pusieron) antes que c',
  sorted[2].id === 'd' && sorted[3].id === 'c', `got ${sorted[2].id},${sorted[3].id}`);

// A2: lista vacia
check('A2 lista vacia', ordenarConLoPusieron([], x => x.total).length === 0);

// A3: ninguno con lo_pusieron → orden preservado
const items3 = [
  { id: 'x', total: 2, lo_pusieron: [] },
  { id: 'y', total: 2, lo_pusieron: [] },
];
const s3 = ordenarConLoPusieron(items3, x => x.total);
check('A3 sin lo_pusieron mantiene orden', s3[0].id === 'x' && s3[1].id === 'y');

// A4: todos con lo_pusieron → orden preservado
const items4 = [
  { id: 'p', total: 1, lo_pusieron: [{}] },
  { id: 'q', total: 1, lo_pusieron: [{}] },
];
const s4 = ordenarConLoPusieron(items4, x => x.total);
check('A4 todos con lo_pusieron mantiene orden', s4[0].id === 'p' && s4[1].id === 'q');

// A5: lo_pusieron undefined no rompe
const items5 = [
  { id: 'm', total: 1 },                          // sin lo_pusieron
  { id: 'n', total: 1, lo_pusieron: [{}] },
];
const s5 = ordenarConLoPusieron(items5, x => x.total);
check('A5 lo_pusieron undefined tratado como vacio (n primero)',
  s5[0].id === 'n', `got ${s5[0].id}`);

// ── B. P11-P16 proyeccion ────────────────────────────────────────────────
console.log('\nB) P11-P16 proyeccion instancia_eliminacion');

function ctxConEquipo(codigo, eliminadoEn, estado) {
  return {
    stats: {
      equipos: [{ equipo_codigo: codigo, eliminado_en: eliminadoEn, estado: estado || 'eliminado' }],
    },
  };
}

// Simulamos cómo viene la pregunta desde la DB:
//   - config_json: STRING JSON (TEXT column)
//   - cfg: parseado por el caller (calcularRankingProyectado lo hace).
// El bug del QA era leer config_json como objeto. El fix lee `cfg` primero
// con fallback a safeParse(config_json).
const CFG_11 = {
  equipo: 'ING',
  instancias: ['Grupos', '16°', '8°', '4°', 'Semis', 'Final'],
  pts_por_instancia: { 'Grupos': 50, '16°': 40, '8°': 30, '4°': 20, 'Semis': 30, 'Final': 30 },
};
const preg11 = {
  numero: 11,
  config_json: JSON.stringify(CFG_11),  // como viene de DB
  cfg: CFG_11,                           // como lo parsea el caller
};
// Pregunta SIN cfg pre-parseado (caller olvidó parsear) — debe seguir funcionando
const preg11_sinCfg = {
  numero: 11,
  config_json: JSON.stringify(CFG_11),
};

// B1: ING todavia no eliminado -> no proyectable
check('B1 ING en_juego no proyectable',
  esProyectable(preg11, ctxConEquipo('ING', null, 'en_juego')) === false);

// B2: ING eliminado en 8vos
const ctx_ing_8 = ctxConEquipo('ING', '8vos', 'eliminado');
check('B2 ING eliminado 8vos es proyectable', esProyectable(preg11, ctx_ing_8) === true);
const pts_ok = proyectarPregunta(preg11, CFG_11, JSON.stringify({ instancia: '8°' }), 1, ctx_ing_8);
check('B2 respuesta=8° pts=30', pts_ok === 30, `got ${pts_ok}`);
const pts_no = proyectarPregunta(preg11, CFG_11, JSON.stringify({ instancia: 'Semis' }), 1, ctx_ing_8);
check('B2 respuesta=Semis pts=0', pts_no === 0, `got ${pts_no}`);

// B3: tercer_puesto se mapea a Semis
const ctx_tp = ctxConEquipo('ING', 'tercer_puesto', 'eliminado');
const pts_tp = proyectarPregunta(preg11, CFG_11, JSON.stringify({ instancia: 'Semis' }), 1, ctx_tp);
check('B3 tercer_puesto -> Semis pts=30', pts_tp === 30, `got ${pts_tp}`);

// B4: campeon mapea a Final
const ctx_camp = ctxConEquipo('ING', null, 'campeon');
const pts_camp = proyectarPregunta(preg11, CFG_11, JSON.stringify({ instancia: 'Final' }), 1, ctx_camp);
check('B4 campeon -> Final pts=30', pts_camp === 30, `got ${pts_camp}`);

// B5: respuesta mal formada -> 0
const pts_bad = proyectarPregunta(preg11, CFG_11, JSON.stringify({ foo: 'bar' }), 1, ctx_ing_8);
check('B5 respuesta sin instancia -> 0', pts_bad === 0);

// B6: equipo no en stats -> no proyectable
const ctx_vacio = { stats: { equipos: [] } };
check('B6 equipo no en stats no proyectable', esProyectable(preg11, ctx_vacio) === false);

// B7: ronda 'grupos' -> 'Grupos'
const ctx_g = ctxConEquipo('ING', 'grupos', 'eliminado');
const pts_g = proyectarPregunta(preg11, CFG_11, JSON.stringify({ instancia: 'Grupos' }), 1, ctx_g);
check('B7 grupos -> Grupos pts=50', pts_g === 50, `got ${pts_g}`);

// B8: ronda '16vos' -> '16°'
const ctx_16 = ctxConEquipo('ING', '16vos', 'eliminado');
const pts_16 = proyectarPregunta(preg11, CFG_11, JSON.stringify({ instancia: '16°' }), 1, ctx_16);
check('B8 16vos -> 16° pts=40', pts_16 === 40);

// B9: ronda 'final' -> 'Final' (subcampeon)
const ctx_f = ctxConEquipo('ING', 'final', 'eliminado');
const pts_f = proyectarPregunta(preg11, CFG_11, JSON.stringify({ instancia: 'Final' }), 1, ctx_f);
check('B9 final (subcampeon) -> Final pts=30', pts_f === 30);

// B10: esProyectable con config_json STRING + cfg parseado (path normal del caller)
check('B10 esProyectable con cfg parseado funciona',
  esProyectable(preg11, ctx_ing_8) === true);

// B11: esProyectable con SOLO config_json string (sin cfg) — fallback defensivo
check('B11 esProyectable sin cfg, parsea config_json string',
  esProyectable(preg11_sinCfg, ctx_ing_8) === true);

// ── D. P32-P34 fix bug latente: eliminados en KO ─────────────────────────
console.log('\nD) P32-P34 eliminados en KO (fix bug latente)');
// stats.equipos[].eliminado_en usa strings '16vos', '8vos', '4tos'.
// Antes el dispatcher usaba 'dieciseisavos', 'octavos', 'cuartos' → no matcheaba.
function ctxConEliminados(equiposEliminados) {
  // stats.eliminados es el campo real que lee getEquiposEliminadosEnRonda
  // (proyeccion.js:104). Shape: { equipo_codigo, eliminado_en }.
  return {
    stats: {
      eliminados: equiposEliminados.map(e => ({
        equipo_codigo: e.codigo, eliminado_en: e.ronda,
      })),
    },
  };
}
const preg32 = { numero: 32, cfg: { n_equipos: 8, pts_por_acierto: 10 } };
// D1: con un equipo eliminado en 16vos, P32 es proyectable
const ctx32 = ctxConEliminados([{ codigo: 'X1', ronda: '16vos' }]);
check('D1 P32 proyectable con eliminado en 16vos', esProyectable(preg32, ctx32) === true);
// D2: con stats vacío P32 no proyectable
const ctxVacio = ctxConEliminados([]);
check('D2 P32 NO proyectable sin eliminados', esProyectable(preg32, ctxVacio) === false);
// D3: respuesta acertada en P32 da pts
const preg33 = { numero: 33, cfg: { n_equipos: 4, pts_por_acierto: 10 } };
const ctx33 = ctxConEliminados([{ codigo: 'A', ronda: '8vos' }, { codigo: 'B', ronda: '8vos' }]);
const pts33 = proyectarPregunta(preg33, preg33.cfg, JSON.stringify({ equipos: ['A','B','Z'] }), 1, ctx33);
check('D3 P33 con 2 aciertos en 8vos = 20 pts', pts33 === 20, `got ${pts33}`);

// ── C. MAPPING AFC ───────────────────────────────────────────────────────
console.log('\nC) MAPPING AFC chip');
check('C1 MAPPING.equipo_afc apunta a numero=10', MAPPING?.equipo_afc?.numero === 10);

// ── Cierre ──────────────────────────────────────────────────────────────
console.log('\n========================================================');
if (fallos === 0) console.log('OK SPRINT 3 DIAG: TODOS LOS CHECKS PASARON');
else console.log(`FAIL SPRINT 3 DIAG: ${fallos} fallo(s)`);
process.exit(fallos === 0 ? 0 : 1);
