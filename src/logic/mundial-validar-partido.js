/**
 * mundial-validar-partido.js — Sprint Final C1.
 *
 * Validador puro del shape de un partido del fixture (mundial_partidos).
 * Mismo patrón que mundial-validar-resultado.js: sin DB adentro; el caller
 * (endpoint) hace los cross-checks contra catálogo.
 *
 * API:
 *   - RONDAS: orden canónico de rondas (validación + sort + "ronda alcanzada").
 *   - validarPartido(p) → { ok:true, valor, codigos_referenciados } | { ok:false, error }
 *   - validarPartidosBulk(body) → { ok:true, partidos } | { ok:false, error, index? }
 *
 * Reglas:
 *   - ronda ∈ RONDAS (validado en código, sin CHECK en DB — regla R2).
 *   - grupo: obligatorio si ronda='grupos'; prohibido si no.
 *   - equipos: strings no vacíos y distintos. Pertenencia al catálogo la
 *     verifica el endpoint (codigos_referenciados).
 *   - goles/penales/amarillas/rojas: null/undefined (no cargado) o entero >= 0.
 *   - penales: solo en rondas KO (no 'grupos').
 *   - estado ∈ {pendiente, en_juego, finalizado, suspendido}; default 'pendiente'.
 *   - estado='finalizado' ⇒ goles_local y goles_visitante son enteros.
 *   - Tarjetas NULL = no cargadas (≠ 0 = no hubo). Pueden cargarse en
 *     cualquier estado (se van anotando durante el partido si se quiere),
 *     pero solo cuentan para stats cuando el partido está finalizado.
 */

const RONDAS = ['grupos', '16vos', '8vos', '4tos', 'semis', 'tercer_puesto', 'final'];
const ESTADOS_PARTIDO = ['pendiente', 'en_juego', 'finalizado', 'suspendido'];

/** Campos numéricos opcionales: null/undefined o entero >= 0. */
const CAMPOS_NUM = [
  'goles_local', 'goles_visitante',
  'penales_local', 'penales_visitante',
  'amarillas_local', 'amarillas_visitante',
  'rojas_local', 'rojas_visitante',
];

function numOpcional(v, nombre) {
  if (v === undefined || v === null || v === '') return { ok: true, valor: null };
  if (!Number.isInteger(v) || v < 0) {
    return { ok: false, error: `\`${nombre}\` debe ser entero >= 0 o vacío` };
  }
  return { ok: true, valor: v };
}

function validarPartido(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    return { ok: false, error: 'Cada partido debe ser un objeto' };
  }

  // ronda
  if (typeof p.ronda !== 'string' || !RONDAS.includes(p.ronda)) {
    return { ok: false, error: `\`ronda\` inválida ("${p.ronda}"). Válidas: ${RONDAS.join(', ')}` };
  }

  // grupo
  let grupo = null;
  if (p.ronda === 'grupos') {
    if (typeof p.grupo !== 'string' || !p.grupo.trim()) {
      return { ok: false, error: '`grupo` es obligatorio cuando ronda=grupos' };
    }
    grupo = p.grupo.trim().toUpperCase();
    if (grupo.length > 2) return { ok: false, error: `\`grupo\` inválido ("${p.grupo}")` };
  } else if (p.grupo !== undefined && p.grupo !== null && String(p.grupo).trim() !== '') {
    return { ok: false, error: `\`grupo\` solo aplica a ronda=grupos (ronda actual: ${p.ronda})` };
  }

  // orden
  if (!Number.isInteger(p.orden) || p.orden < 0) {
    return { ok: false, error: '`orden` debe ser entero >= 0' };
  }

  // fecha (opcional, informativa — solo chequeo liviano de tipo/largo)
  let fecha = null;
  if (p.fecha !== undefined && p.fecha !== null && p.fecha !== '') {
    if (typeof p.fecha !== 'string' || p.fecha.length > 40) {
      return { ok: false, error: '`fecha` debe ser string (ISO recomendado) o vacía' };
    }
    fecha = p.fecha;
  }

  // equipos
  if (typeof p.equipo_local !== 'string' || !p.equipo_local.trim()) {
    return { ok: false, error: 'Falta `equipo_local`' };
  }
  if (typeof p.equipo_visitante !== 'string' || !p.equipo_visitante.trim()) {
    return { ok: false, error: 'Falta `equipo_visitante`' };
  }
  const local = p.equipo_local.trim();
  const visitante = p.equipo_visitante.trim();
  if (local === visitante) {
    return { ok: false, error: `Un equipo no puede jugar contra sí mismo (${local})` };
  }

  // numéricos opcionales
  const nums = {};
  for (const campo of CAMPOS_NUM) {
    const r = numOpcional(p[campo], campo);
    if (!r.ok) return r;
    nums[campo] = r.valor;
  }

  // penales solo KO
  if (p.ronda === 'grupos' && (nums.penales_local !== null || nums.penales_visitante !== null)) {
    return { ok: false, error: 'Los penales no aplican en fase de grupos' };
  }

  // estado
  const estado = (p.estado === undefined || p.estado === null || p.estado === '')
    ? 'pendiente' : p.estado;
  if (!ESTADOS_PARTIDO.includes(estado)) {
    return { ok: false, error: `\`estado\` inválido ("${p.estado}"). Válidos: ${ESTADOS_PARTIDO.join(', ')}` };
  }
  if (estado === 'finalizado') {
    if (nums.goles_local === null || nums.goles_visitante === null) {
      return { ok: false, error: `Partido finalizado requiere goles cargados (${local} vs ${visitante})` };
    }
  }

  // observación
  let observacion = null;
  if (p.observacion !== undefined && p.observacion !== null && p.observacion !== '') {
    if (typeof p.observacion !== 'string' || p.observacion.length > 500) {
      return { ok: false, error: '`observacion` debe ser string de hasta 500 caracteres' };
    }
    observacion = p.observacion;
  }

  return {
    ok: true,
    valor: {
      ronda: p.ronda,
      grupo,
      orden: p.orden,
      fecha,
      equipo_local: local,
      equipo_visitante: visitante,
      ...nums,
      estado,
      observacion,
    },
    codigos_referenciados: [local, visitante],
  };
}

/**
 * Valida el body de PUT /partidos/bulk: { partidos: [...] }.
 * Además del shape por partido, rechaza (ronda, orden) duplicado en el payload.
 */
function validarPartidosBulk(body) {
  const { partidos } = body || {};
  if (!Array.isArray(partidos) || partidos.length === 0) {
    return { ok: false, error: 'Se espera body.partidos: array no vacío' };
  }
  if (partidos.length > 200) {
    return { ok: false, error: 'Máximo 200 partidos por bulk' };
  }
  const claves = new Set();
  const out = [];
  const codigos = new Set();
  for (let i = 0; i < partidos.length; i++) {
    const v = validarPartido(partidos[i]);
    if (!v.ok) return { ok: false, error: v.error, index: i };
    const clave = `${v.valor.ronda}|${v.valor.orden}`;
    if (claves.has(clave)) {
      return { ok: false, error: `(ronda=${v.valor.ronda}, orden=${v.valor.orden}) duplicado en el payload`, index: i };
    }
    claves.add(clave);
    out.push(v.valor);
    for (const c of v.codigos_referenciados) codigos.add(c);
  }
  return { ok: true, partidos: out, codigos_referenciados: [...codigos] };
}

module.exports = { validarPartido, validarPartidosBulk, RONDAS, ESTADOS_PARTIDO };
