/**
 * diagnostico-mundial-resultado-proyectado.js — sprint chip proyectado.
 *
 * Valida buildResultadoProyectado para cada bucket de preguntas:
 *   A. P11-P16 instancia eliminacion (texto + equipo_codigo).
 *   B. P17/P18 tops goleadores/goleados (codigos).
 *   C. P19-P28 posiciones fijas de grupo (codigos[1]).
 *   D. P22 sumara Haiti (Sí/No).
 *   E. P29-P31 numeros derivados.
 *   F. P32-P34 eliminados en KO (codigos array).
 *   G. P35-P36 lideres en tarjetas.
 *   H. Numero desconocido → null.
 */

const { buildResultadoProyectado } = require('./src/logic/mundial-proyeccion');

let fallos = 0;
function check(n, ok, det) {
  if (ok) console.log(`  OK   ${n}`);
  else { fallos++; console.log(`  FAIL ${n}${det ? ' --- ' + det : ''}`); }
}

console.log('========================================================');
console.log('DIAG RESULTADO PROYECTADO');
console.log('========================================================\n');

// Helper: arma ctx mínimo con stats.
function ctxConStats(stats) {
  return { stats, goleadores: [] };
}

// ── A) P11-P16 ──────────────────────────────────────────────────────────
console.log('A) P11-P16 instancia_eliminacion');
const ctxING = ctxConStats({
  equipos: [{ equipo_codigo: 'ING', eliminado_en: '8vos', estado: 'eliminado' }],
});
const r11 = buildResultadoProyectado({ numero: 11, cfg: { equipo: 'ING' } }, ctxING);
check('A1 P11 ING → simple "8°" + equipo_codigo ING',
  r11?.simple === '8°' && r11?.equipo_codigo === 'ING');

const ctxARG_camp = ctxConStats({
  equipos: [{ equipo_codigo: 'ARG', eliminado_en: null, estado: 'campeon' }],
});
const r12 = buildResultadoProyectado({ numero: 12, cfg: { equipo: 'ARG' } }, ctxARG_camp);
check('A2 P12 ARG campeon → simple "Final"', r12?.simple === 'Final');

const ctxNoEq = ctxConStats({ equipos: [] });
const r11_no = buildResultadoProyectado({ numero: 11, cfg: { equipo: 'ING' } }, ctxNoEq);
check('A3 P11 sin equipo en stats → null', r11_no === null);

// ── B) P17/P18 top goleadores ───────────────────────────────────────────
console.log('\nB) P17/P18 tops goleadores/goleados');
const ctxTop17 = ctxConStats({
  tops: {
    goleadores_grupos: [
      { equipo_codigo: 'ALE', total: 10, posicion: 1 },
      { equipo_codigo: 'FRA', total: 10, posicion: 1 },
      { equipo_codigo: 'HOL', total: 10, posicion: 1 },
      { equipo_codigo: 'CAN', total: 9,  posicion: 4 },
    ],
  },
});
const r17 = buildResultadoProyectado({ numero: 17, cfg: {} }, ctxTop17);
check('B1 P17 empate 3 → codigos [ALE,FRA,HOL]',
  Array.isArray(r17?.codigos) && r17.codigos.length === 3 &&
  r17.codigos.includes('ALE') && r17.codigos.includes('FRA') && r17.codigos.includes('HOL'));

const ctxTop17_uno = ctxConStats({
  tops: { goleadores_grupos: [{ equipo_codigo: 'ALE', total: 10, posicion: 1 }] },
});
const r17_uno = buildResultadoProyectado({ numero: 17, cfg: {} }, ctxTop17_uno);
check('B2 P17 unico líder → codigos [ALE]', r17_uno?.codigos?.length === 1);

const r17_vacio = buildResultadoProyectado({ numero: 17, cfg: {} }, ctxConStats({ tops: { goleadores_grupos: [] } }));
check('B3 P17 sin tops → null', r17_vacio === null);

// P18 mismo patrón sobre goleados_grupos
const ctxTop18 = ctxConStats({
  tops: { goleados_grupos: [{ equipo_codigo: 'IRQ', total: 12, posicion: 1 }] },
});
const r18 = buildResultadoProyectado({ numero: 18, cfg: {} }, ctxTop18);
check('B4 P18 → codigos [IRQ]', r18?.codigos?.[0] === 'IRQ');

// ── C) P19-P28 posiciones de grupo ─────────────────────────────────────
console.log('\nC) P19-P28 posiciones grupo');
const ctxTabla = ctxConStats({
  tabla_grupos: [
    { grupo: 'A', equipos: [
      { equipo_codigo: 'MEX', posicion: 1 },
      { equipo_codigo: 'RSA', posicion: 2 },
      { equipo_codigo: 'CZE', posicion: 3 },
      { equipo_codigo: 'KOR', posicion: 4 },
    ]},
    { grupo: 'B', equipos: [
      { equipo_codigo: 'BOS', posicion: 1 },
      { equipo_codigo: 'CAN', posicion: 2 },
      { equipo_codigo: 'QAT', posicion: 4 },
    ]},
  ],
});
check('C1 P19 segundo A → RSA',
  buildResultadoProyectado({ numero: 19, cfg: {} }, ctxTabla)?.codigos?.[0] === 'RSA');
check('C2 P20 tercero A → CZE',
  buildResultadoProyectado({ numero: 20, cfg: {} }, ctxTabla)?.codigos?.[0] === 'CZE');
check('C3 P21 cuarto B → QAT',
  buildResultadoProyectado({ numero: 21, cfg: {} }, ctxTabla)?.codigos?.[0] === 'QAT');

// Sin grupo en stats
const r19_vacio = buildResultadoProyectado({ numero: 19, cfg: {} }, ctxConStats({ tabla_grupos: [] }));
check('C4 P19 sin tabla grupos → null', r19_vacio === null);

// ── D) P22 Haití suma puntos ────────────────────────────────────────────
console.log('\nD) P22 Haití');
const r22_si = buildResultadoProyectado({ numero: 22, cfg: {} }, ctxConStats({
  equipos: [{ equipo_codigo: 'HAI', pts: 4 }],
}));
check('D1 HAI pts > 0 → "Sí"', r22_si?.simple === 'Sí');

const r22_no = buildResultadoProyectado({ numero: 22, cfg: {} }, ctxConStats({
  equipos: [{ equipo_codigo: 'HAI', pts: 0 }],
}));
check('D2 HAI pts 0 → "No"', r22_no?.simple === 'No');

const r22_no_eq = buildResultadoProyectado({ numero: 22, cfg: {} }, ctxConStats({ equipos: [] }));
check('D3 HAI no en stats → null', r22_no_eq === null);

// ── E) P29-P31 números ──────────────────────────────────────────────────
console.log('\nE) P29-P31 números');
const r29 = buildResultadoProyectado({ numero: 29, cfg: {} }, ctxConStats({
  equipos: [{ equipo_codigo: 'ARG', gc_grupos: 2 }],
}));
check('E1 P29 ARG gc=2 → "2"', r29?.simple === '2');

const r30 = buildResultadoProyectado({ numero: 30, cfg: {} }, ctxConStats({
  empates_por_grupo: [{ grupo: 'K', empates: 3 }],
}));
check('E2 P30 empates K=3 → "3"', r30?.simple === '3');

const r31 = buildResultadoProyectado({ numero: 31, cfg: {} }, ctxConStats({
  equipos: [{ equipo_codigo: 'PAN', gf_total: 5 }],
}));
check('E3 P31 PAN gf=5 → "5"', r31?.simple === '5');

// ── F) P32-P34 eliminados en KO ─────────────────────────────────────────
console.log('\nF) P32-P34 eliminados KO');
const ctxElim = ctxConStats({
  eliminados: [
    { equipo_codigo: 'JAP', eliminado_en: '16vos' },
    { equipo_codigo: 'CRC', eliminado_en: '16vos' },
    { equipo_codigo: 'MEX', eliminado_en: '8vos' },
    { equipo_codigo: 'KOR', eliminado_en: '4tos' },
  ],
});
const r32 = buildResultadoProyectado({ numero: 32, cfg: {} }, ctxElim);
check('F1 P32 16vos → [JAP, CRC]', r32?.codigos?.length === 2 && r32.codigos.includes('JAP'));

const r33 = buildResultadoProyectado({ numero: 33, cfg: {} }, ctxElim);
check('F2 P33 8vos → [MEX]', r33?.codigos?.length === 1 && r33.codigos[0] === 'MEX');

const r34 = buildResultadoProyectado({ numero: 34, cfg: {} }, ctxElim);
check('F3 P34 4tos → [KOR]', r34?.codigos?.length === 1 && r34.codigos[0] === 'KOR');

const r32_no = buildResultadoProyectado({ numero: 32, cfg: {} }, ctxConStats({ eliminados: [] }));
check('F4 sin eliminados → null', r32_no === null);

// ── G) P35-P36 tarjetas ─────────────────────────────────────────────────
console.log('\nG) P35-P36 tarjetas');
const ctxTarj = ctxConStats({
  tops: {
    amarillas: [{ equipo_codigo: 'KOR', total: 8, posicion: 1 }],
    rojas:     [
      { equipo_codigo: 'ARG', total: 2, posicion: 1 },
      { equipo_codigo: 'BRA', total: 2, posicion: 1 },
    ],
  },
});
const r35 = buildResultadoProyectado({ numero: 35, cfg: {} }, ctxTarj);
check('G1 P35 amarillas KOR → [KOR]', r35?.codigos?.length === 1 && r35.codigos[0] === 'KOR');

const r36 = buildResultadoProyectado({ numero: 36, cfg: {} }, ctxTarj);
check('G2 P36 rojas empate → [ARG, BRA]',
  r36?.codigos?.length === 2 && r36.codigos.includes('ARG') && r36.codigos.includes('BRA'));

// ── H) Tipos desconocidos / sin contexto ────────────────────────────────
console.log('\nH) Edge cases');
check('H1 numero desconocido (999) → null',
  buildResultadoProyectado({ numero: 999, cfg: {} }, ctxConStats({})) === null);
check('H2 P1 (Tier 2 no implementado) → null',
  buildResultadoProyectado({ numero: 1, cfg: {} }, ctxConStats({})) === null);
check('H3 ctx null → null',
  buildResultadoProyectado({ numero: 17, cfg: {} }, null) === null);
check('H4 ctx sin stats → null',
  buildResultadoProyectado({ numero: 17, cfg: {} }, {}) === null);

console.log('\n========================================================');
if (fallos === 0) {
  console.log('OK DIAG: TODOS LOS CHECKS PASARON');
  process.exit(0);
} else {
  console.log(`FAIL DIAG: ${fallos} fallo(s)`);
  process.exit(1);
}
