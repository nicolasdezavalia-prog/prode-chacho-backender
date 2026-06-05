/**
 * mundial-validar-dato-util.js — Datos útiles Fase 1
 *
 * Validador puro para POST/PUT de `mundial_datos_utiles`. No toca DB:
 * recibe los datos del catálogo (equipos del torneo) por argumento.
 *
 * Reglas:
 *   - tipo ∈ whitelist (mismo CHECK del schema).
 *   - titulo string no vacío (trim).
 *   - valor_num opcional, integer.
 *   - valor_texto opcional, string.
 *   - equipo_codigo opcional. Si viene, debe existir en el catálogo del torneo.
 *   - jugador opcional, string.
 *   - grupo opcional, string corto.
 *   - descripcion opcional, string.
 *   - orden_display opcional, integer >= 0 (default 0 en el endpoint).
 *   - activo opcional, 0/1 (default 1 en el endpoint).
 *   - pregunta_id opcional. Si viene, debe existir en el torneo (la
 *     verificación de pertenencia la hace el endpoint con un SELECT;
 *     acá solo verificamos que sea entero positivo).
 *     Fase 1: no se consume todavía en frontend. Fase 2: integración.
 *
 * API:
 *   validarDatoUtil(payload, { equiposCodigos: Set<string> })
 *     → { ok: true, valor: <obj normalizado> }
 *     → { ok: false, error, campo? }
 *
 * IMPORTANTE: este validador NO valida pregunta_id contra DB; eso lo hace
 * el endpoint (necesita acceso al torneo). Acá solo chequea forma.
 */

const TIPOS_VALIDOS = new Set([
  'goleadores',
  'amarillas_equipo',
  'rojas_equipo',
  'clasificados',
  'eliminados',
  'tabla_grupos',
  'otro',
]);

const fail = (error, campo) => campo ? { ok: false, error, campo } : { ok: false, error };

function asStringTrim(v) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') return undefined; // undefined = inválido
  const t = v.trim();
  return t === '' ? null : t;
}

function validarDatoUtil(payload, ctx = {}) {
  const equiposCodigos = ctx.equiposCodigos instanceof Set ? ctx.equiposCodigos : new Set();

  if (!payload || typeof payload !== 'object') {
    return fail('Payload requerido');
  }

  // tipo
  if (typeof payload.tipo !== 'string' || !TIPOS_VALIDOS.has(payload.tipo)) {
    return fail(`tipo inválido. Permitidos: ${[...TIPOS_VALIDOS].join(', ')}`, 'tipo');
  }

  // titulo (requerido)
  const titulo = asStringTrim(payload.titulo);
  if (titulo === undefined || titulo === null) {
    return fail('titulo es requerido (string no vacío)', 'titulo');
  }

  // valor_num (opcional)
  let valor_num = null;
  if (payload.valor_num !== undefined && payload.valor_num !== null && payload.valor_num !== '') {
    if (!Number.isInteger(payload.valor_num)) {
      return fail('valor_num debe ser entero o null', 'valor_num');
    }
    valor_num = payload.valor_num;
  }

  // valor_texto (opcional)
  let valor_texto = null;
  if (payload.valor_texto !== undefined && payload.valor_texto !== null) {
    const vt = asStringTrim(payload.valor_texto);
    if (vt === undefined) return fail('valor_texto debe ser string o null', 'valor_texto');
    valor_texto = vt;
  }

  // equipo_codigo (opcional, debe existir en catálogo si viene)
  let equipo_codigo = null;
  if (payload.equipo_codigo !== undefined && payload.equipo_codigo !== null && payload.equipo_codigo !== '') {
    const ec = asStringTrim(payload.equipo_codigo);
    if (ec === undefined || ec === null) {
      return fail('equipo_codigo debe ser string', 'equipo_codigo');
    }
    if (equiposCodigos.size > 0 && !equiposCodigos.has(ec)) {
      return fail(`equipo_codigo '${ec}' no existe en el catálogo del torneo`, 'equipo_codigo');
    }
    equipo_codigo = ec;
  }

  // jugador, grupo, descripcion (opcionales, strings)
  const jugador = (() => {
    const v = asStringTrim(payload.jugador);
    return v === undefined ? null : v;
  })();
  if (jugador === undefined) return fail('jugador debe ser string o null', 'jugador');

  const grupo = (() => {
    const v = asStringTrim(payload.grupo);
    return v === undefined ? null : v;
  })();
  if (grupo === undefined) return fail('grupo debe ser string o null', 'grupo');

  const descripcion = (() => {
    const v = asStringTrim(payload.descripcion);
    return v === undefined ? null : v;
  })();
  if (descripcion === undefined) return fail('descripcion debe ser string o null', 'descripcion');

  // orden_display (opcional, integer >= 0)
  let orden_display = 0;
  if (payload.orden_display !== undefined && payload.orden_display !== null) {
    if (!Number.isInteger(payload.orden_display) || payload.orden_display < 0) {
      return fail('orden_display debe ser entero >= 0', 'orden_display');
    }
    orden_display = payload.orden_display;
  }

  // activo (opcional, 0|1|true|false)
  let activo = 1;
  if (payload.activo !== undefined && payload.activo !== null) {
    const a = payload.activo;
    if (a === true || a === 1)       activo = 1;
    else if (a === false || a === 0) activo = 0;
    else return fail('activo debe ser 0 o 1 (boolean también aceptado)', 'activo');
  }

  // pregunta_id (opcional). El endpoint verifica que pertenezca al torneo.
  let pregunta_id = null;
  if (payload.pregunta_id !== undefined && payload.pregunta_id !== null) {
    if (!Number.isInteger(payload.pregunta_id) || payload.pregunta_id <= 0) {
      return fail('pregunta_id debe ser entero positivo o null', 'pregunta_id');
    }
    pregunta_id = payload.pregunta_id;
  }

  return {
    ok: true,
    valor: {
      tipo: payload.tipo,
      titulo,
      valor_num,
      valor_texto,
      equipo_codigo,
      jugador,
      grupo,
      descripcion,
      orden_display,
      activo,
      pregunta_id,
    },
  };
}

module.exports = { validarDatoUtil, TIPOS_VALIDOS };
