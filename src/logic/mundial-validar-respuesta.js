/**
 * Validador puro de `respuesta_json` por `tipo_pregunta` — Fase 2.4.
 *
 * - Sin DB. Sin red. Testeable en aislamiento.
 * - Recibe (tipoPregunta, configRaw, respuestaRaw).
 * - Devuelve:
 *     { ok: true, codigos_referenciados: [string], respuestaNormalizada: object }
 *     { ok: false, error: string, campo?: string }
 *
 * - `respuestaNormalizada` es la respuesta limpia (trim, uppercase de códigos, etc.)
 *   lista para JSON.stringify y persistir.
 * - `codigos_referenciados` lo usa el caller (route) para el cross-check
 *   estricto contra `mundial_equipos_catalogo`. En Fase 2.4 los faltantes
 *   son ERROR (400), no warnings.
 *
 * Reglas por tipo (shape esperado del respuesta_json):
 *   - opcion_unica:         { opcion: string }                     — debe ∈ config.opciones
 *   - equipo_categoria:     { equipo: string }                     — código uppercase
 *   - instancia_eliminacion:{ instancia: string }                  — debe ∈ config.instancias
 *   - numero_exacto:        { numero: int }                        — ≥ 0
 *   - numero_por_banda:     { numero: int }                        — ≥ 0
 *   - multi_equipo:         { equipos: [string] }                  — length === n_equipos, únicos
 *   - respuesta_manual:     { texto: string }                      — no vacío
 *   - regla_especial:       { texto: string }                      — no vacío
 */

function asObject(raw) {
  if (raw == null) return { error: 'requerida' };
  if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw);
      if (p == null || typeof p !== 'object' || Array.isArray(p)) {
        return { error: 'debe ser objeto' };
      }
      return { obj: p };
    } catch {
      return { error: 'no es JSON parseable' };
    }
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) return { obj: raw };
  return { error: 'debe ser objeto o string JSON' };
}

const fail = (error, campo) => campo ? { ok: false, error, campo } : { ok: false, error };
const ok   = (respuesta, codigos = []) => ({ ok: true, codigos_referenciados: codigos, respuestaNormalizada: respuesta });

// ── Validadores por tipo ────────────────────────────────────────────────────

function vOpcionUnica(c, r) {
  if (typeof r.opcion !== 'string') return fail('opcion_unica: `opcion` string requerido', 'opcion');
  const opciones = Array.isArray(c.opciones) ? c.opciones : [];
  if (!opciones.includes(r.opcion)) {
    return fail(`opcion_unica: '${r.opcion}' no está entre las opciones permitidas (${opciones.join(', ')})`, 'opcion');
  }
  return ok({ opcion: r.opcion });
}

function vEquipoCategoria(c, r) {
  if (typeof r.equipo !== 'string' || !r.equipo.trim()) {
    return fail('equipo_categoria: `equipo` (código) requerido', 'equipo');
  }
  const codigo = r.equipo.trim().toUpperCase();
  return ok({ equipo: codigo }, [codigo]);
}

function vInstanciaEliminacion(c, r) {
  if (typeof r.instancia !== 'string') {
    return fail('instancia_eliminacion: `instancia` string requerida', 'instancia');
  }
  const instancias = Array.isArray(c.instancias) ? c.instancias : [];
  if (!instancias.includes(r.instancia)) {
    return fail(`instancia_eliminacion: '${r.instancia}' no está entre las instancias permitidas (${instancias.join(', ')})`, 'instancia');
  }
  return ok({ instancia: r.instancia });
}

function vNumeroExacto(c, r) {
  if (!Number.isInteger(r.numero) || r.numero < 0) {
    return fail('numero_exacto: `numero` entero ≥ 0 requerido', 'numero');
  }
  return ok({ numero: r.numero });
}

function vNumeroPorBanda(c, r) {
  if (!Number.isInteger(r.numero) || r.numero < 0) {
    return fail('numero_por_banda: `numero` entero ≥ 0 requerido', 'numero');
  }
  return ok({ numero: r.numero });
}

function vMultiEquipo(c, r) {
  if (!Array.isArray(r.equipos)) {
    return fail('multi_equipo: `equipos` array requerido', 'equipos');
  }
  const n = c.n_equipos;
  if (r.equipos.length !== n) {
    return fail(`multi_equipo: deben ser exactamente ${n} equipos (recibidos: ${r.equipos.length})`, 'equipos');
  }
  const normalizados = [];
  for (const e of r.equipos) {
    if (typeof e !== 'string' || !e.trim()) {
      return fail('multi_equipo: todos los códigos deben ser strings no vacíos', 'equipos');
    }
    normalizados.push(e.trim().toUpperCase());
  }
  const set = new Set(normalizados);
  if (set.size !== normalizados.length) {
    return fail('multi_equipo: hay códigos duplicados', 'equipos');
  }
  return ok({ equipos: normalizados }, [...set]);
}

function vRespuestaManual(c, r) {
  if (typeof r.texto !== 'string' || !r.texto.trim()) {
    return fail('respuesta_manual: `texto` string no vacío requerido', 'texto');
  }
  return ok({ texto: r.texto.trim() });
}

function vReglaEspecial(c, r) {
  if (typeof r.texto !== 'string' || !r.texto.trim()) {
    return fail('regla_especial: `texto` string no vacío requerido', 'texto');
  }
  return ok({ texto: r.texto.trim() });
}

const VALIDADORES = {
  opcion_unica:          vOpcionUnica,
  equipo_categoria:      vEquipoCategoria,
  instancia_eliminacion: vInstanciaEliminacion,
  numero_exacto:         vNumeroExacto,
  numero_por_banda:      vNumeroPorBanda,
  multi_equipo:          vMultiEquipo,
  respuesta_manual:      vRespuestaManual,
  regla_especial:        vReglaEspecial,
};

/**
 * @param {string} tipoPregunta
 * @param {string|object} configRaw — config_json de la pregunta
 * @param {string|object} respuestaRaw — respuesta_json del user
 * @returns {{ok: true, codigos_referenciados: string[], respuestaNormalizada: object} | {ok: false, error: string, campo?: string}}
 */
function validarRespuesta(tipoPregunta, configRaw, respuestaRaw) {
  const v = VALIDADORES[tipoPregunta];
  if (!v) return fail(`tipo_pregunta desconocido: '${tipoPregunta}'`);
  const cfg = asObject(configRaw);
  if (cfg.error) return fail(`config_json inválido: ${cfg.error}`);
  const res = asObject(respuestaRaw);
  if (res.error) return fail(`respuesta_json ${res.error}`, 'respuesta_json');
  return v(cfg.obj, res.obj);
}

module.exports = { validarRespuesta };
