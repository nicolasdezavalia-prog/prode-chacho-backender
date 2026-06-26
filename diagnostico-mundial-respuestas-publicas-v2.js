/**
 * diagnostico-mundial-respuestas-publicas-v2.js — sprint vista respuestas.
 *
 * Valida la lógica nueva del endpoint /respuestas-publicas:
 *   - proyectable: bool por pregunta.
 *   - resultado_oficial: shape correcto por tipo (codigos/simple).
 *   - Aliases en equipo_categoria empate → codigos = [principal, ...aliases].
 *   - Compat: pregunta sin resultado oficial → resultado_oficial=null.
 *
 * No levanta express. Test unitario de la función buildResultadoOficial replicada.
 */

let fallos = 0;
function check(n, ok, det) {
  if (ok) console.log(`  OK   ${n}`);
  else { fallos++; console.log(`  FAIL ${n}${det ? ' --- ' + det : ''}`); }
}

console.log('========================================================');
console.log('DIAG RESPUESTAS-PUBLICAS V2');
console.log('========================================================\n');

// Replica EXACTA del helper que está en routes/mundial.js
function buildResultadoOficial(tipo, cfg, res) {
  if (!res) return null;
  switch (tipo) {
    case 'opcion_unica':
      return typeof res.opcion === 'string' && res.opcion.trim()
        ? { simple: res.opcion } : null;
    case 'equipo_categoria': {
      if (typeof res.equipo === 'string' && res.equipo.trim()) {
        const aliases = Array.isArray(res.aliases) ? res.aliases.filter(a => typeof a === 'string' && a.trim()) : [];
        const codigos = [res.equipo, ...aliases];
        return { codigos };
      }
      return null;
    }
    case 'instancia_eliminacion':
      return typeof res.instancia === 'string' && res.instancia.trim()
        ? { simple: res.instancia, equipo_codigo: cfg?.equipo || null } : null;
    case 'numero_exacto':
    case 'numero_por_banda':
      return Number.isInteger(res.numero) ? { simple: String(res.numero) } : null;
    case 'multi_equipo':
      return Array.isArray(res.equipos) && res.equipos.length > 0
        ? { codigos: res.equipos.filter(c => typeof c === 'string' && c.trim()) } : null;
    case 'respuesta_manual':
    case 'regla_especial':
      return typeof res.texto === 'string' && res.texto.trim()
        ? { simple: res.texto } : null;
    default:
      return null;
  }
}

// ── A) opcion_unica ─────────────────────────────────────────────────────
console.log('A) opcion_unica');
check('A1 valor válido', buildResultadoOficial('opcion_unica', {}, { opcion: 'Sí' })?.simple === 'Sí');
check('A2 vacío null', buildResultadoOficial('opcion_unica', {}, { opcion: '' }) === null);
check('A3 sin res null', buildResultadoOficial('opcion_unica', {}, null) === null);

// ── B) equipo_categoria con/sin aliases ─────────────────────────────────
console.log('\nB) equipo_categoria');
const r1 = buildResultadoOficial('equipo_categoria', {}, { equipo: 'RSA' });
check('B1 sin aliases: codigos = [RSA]', Array.isArray(r1.codigos) && r1.codigos.length === 1 && r1.codigos[0] === 'RSA');

const r2 = buildResultadoOficial('equipo_categoria', {}, { equipo: 'ALE', aliases: ['FRA', 'HOL'] });
check('B2 con aliases: codigos = [ALE, FRA, HOL]',
  r2.codigos.length === 3 && r2.codigos[0] === 'ALE' && r2.codigos.includes('FRA') && r2.codigos.includes('HOL'));

const r3 = buildResultadoOficial('equipo_categoria', {}, { equipo: 'BRA', aliases: [null, 42, 'ARG'] });
check('B3 aliases con basura filtrada', r3.codigos.length === 2 && r3.codigos.includes('ARG'));

const r4 = buildResultadoOficial('equipo_categoria', {}, { equipo: '' });
check('B4 equipo vacio: null', r4 === null);

const r5 = buildResultadoOficial('equipo_categoria', {}, { equipo: 'ALE', aliases: [] });
check('B5 aliases [] → codigos = [ALE]', r5.codigos.length === 1 && r5.codigos[0] === 'ALE');

// ── C) instancia_eliminacion ────────────────────────────────────────────
console.log('\nC) instancia_eliminacion');
const r6 = buildResultadoOficial('instancia_eliminacion', { equipo: 'ING' }, { instancia: '8°' });
check('C1 instancia + equipo_codigo del cfg', r6.simple === '8°' && r6.equipo_codigo === 'ING');

const r7 = buildResultadoOficial('instancia_eliminacion', null, { instancia: 'Final' });
check('C2 sin cfg.equipo: equipo_codigo null', r7.simple === 'Final' && r7.equipo_codigo === null);

// ── D) numero ───────────────────────────────────────────────────────────
console.log('\nD) numero_exacto / numero_por_banda');
check('D1 numero entero', buildResultadoOficial('numero_exacto', {}, { numero: 5 })?.simple === '5');
check('D2 numero 0 (válido)', buildResultadoOficial('numero_exacto', {}, { numero: 0 })?.simple === '0');
check('D3 numero null → null', buildResultadoOficial('numero_exacto', {}, { numero: null }) === null);
check('D4 banda: idem', buildResultadoOficial('numero_por_banda', {}, { numero: 3 })?.simple === '3');

// ── E) multi_equipo ────────────────────────────────────────────────────
console.log('\nE) multi_equipo');
const r8 = buildResultadoOficial('multi_equipo', {}, { equipos: ['ALE', 'BRA', 'FRA'] });
check('E1 codigos = [ALE, BRA, FRA]', r8.codigos.length === 3);

const r9 = buildResultadoOficial('multi_equipo', {}, { equipos: [] });
check('E2 equipos []: null', r9 === null);

const r10 = buildResultadoOficial('multi_equipo', {}, { equipos: ['ALE', null, 'FRA', ''] });
check('E3 filtra falsy', r10.codigos.length === 2 && !r10.codigos.includes(null));

// ── F) respuesta_manual ────────────────────────────────────────────────
console.log('\nF) respuesta_manual / regla_especial');
check('F1 texto válido',
  buildResultadoOficial('respuesta_manual', {}, { texto: 'K. Mbappé' })?.simple === 'K. Mbappé');
check('F2 texto vacio: null',
  buildResultadoOficial('respuesta_manual', {}, { texto: '' }) === null);
check('F3 regla_especial mismo shape',
  buildResultadoOficial('regla_especial', {}, { texto: 'X' })?.simple === 'X');

// ── G) tipos desconocidos ──────────────────────────────────────────────
console.log('\nG) Tipos desconocidos');
check('G1 tipo invalido → null', buildResultadoOficial('foo', {}, { texto: 'x' }) === null);

console.log('\n========================================================');
if (fallos === 0) {
  console.log('OK DIAG: TODOS LOS CHECKS PASARON');
  process.exit(0);
} else {
  console.log(`FAIL DIAG: ${fallos} fallo(s)`);
  process.exit(1);
}
