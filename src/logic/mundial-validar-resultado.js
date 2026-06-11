/**
 * mundial-validar-resultado.js — Fase 3
 *
 * Validador puro del shape de `resultado_json` por tipo de pregunta. Análogo a
 * `mundial-validar-respuesta.js` pero para resultados reales cargados por admin.
 *
 * Retorna { ok: true, codigos_referenciados?: string[] } o { ok: false, error: string }.
 *
 * `codigos_referenciados` lista códigos de equipo que el caller debe cross-checkear
 * contra `mundial_equipos_catalogo` (igual patrón que respuestas).
 *
 * Fase B: para tipos texto acepta claves opcionales `texto_display` (string) y
 * `alias` (array de strings, sin vacíos ni duplicados post-normalización).
 */
const { normalizarTexto } = require('./mundial-scoring')

function validarOpcionUnica(res, cfg) {
  if (typeof res.opcion !== 'string' || !res.opcion) {
    return { ok: false, error: 'Falta `opcion` (string)' }
  }
  if (Array.isArray(cfg.opciones) && !cfg.opciones.includes(res.opcion)) {
    return { ok: false, error: `\`opcion\` "${res.opcion}" no está en las opciones válidas` }
  }
  return { ok: true }
}

function validarEquipoCategoria(res, cfg) {
  // Fase 3.2: si cfg.scoring_manual === true, `equipo` es opcional (admin puede
  // no saber el "ganador entre todos") y se acepta `overrides_pts`.
  if (cfg && cfg.scoring_manual === true) {
    const codigos = [];
    if (res.equipo !== undefined) {
      if (typeof res.equipo !== 'string' || !res.equipo) {
        return { ok: false, error: 'Si se incluye `equipo`, debe ser string no vacío' };
      }
      codigos.push(res.equipo);
    }
    if (res.overrides_pts !== undefined) {
      if (typeof res.overrides_pts !== 'object' || res.overrides_pts === null || Array.isArray(res.overrides_pts)) {
        return { ok: false, error: '`overrides_pts` debe ser objeto { user_id: pts }' };
      }
      for (const [k, v] of Object.entries(res.overrides_pts)) {
        if (!/^\d+$/.test(k)) {
          return { ok: false, error: `\`overrides_pts\` clave "${k}" no es user_id válido (entero)` };
        }
        if (!Number.isInteger(v) || v < 0) {
          return { ok: false, error: `\`overrides_pts[${k}]\` debe ser entero >= 0` };
        }
      }
    }
    return { ok: true, codigos_referenciados: codigos };
  }
  // Modo estándar: equipo requerido, sin overrides_pts.
  if (typeof res.equipo !== 'string' || !res.equipo) {
    return { ok: false, error: 'Falta `equipo` (string)' }
  }
  return { ok: true, codigos_referenciados: [res.equipo] }
}

function validarInstanciaEliminacion(res, cfg) {
  if (typeof res.instancia !== 'string' || !res.instancia) {
    return { ok: false, error: 'Falta `instancia` (string)' }
  }
  if (Array.isArray(cfg.instancias) && !cfg.instancias.includes(res.instancia)) {
    return { ok: false, error: `\`instancia\` "${res.instancia}" no está en las válidas` }
  }
  return { ok: true }
}

function validarNumeroExacto(res, _cfg) {
  if (!Number.isInteger(res.numero) || res.numero < 0) {
    return { ok: false, error: '`numero` debe ser entero >= 0' }
  }
  return { ok: true }
}

function validarNumeroPorBanda(res, cfg) {
  if (!Number.isInteger(res.numero) || res.numero < 0) {
    return { ok: false, error: '`numero` debe ser entero >= 0' }
  }
  if (Array.isArray(cfg.bandas)) {
    // verificar que el numero caiga en alguna banda
    const cae = cfg.bandas.some(b => {
      const min = Number.isInteger(b.min) ? b.min : -Infinity
      const max = Number.isInteger(b.max) ? b.max : Infinity
      return res.numero >= min && res.numero <= max
    })
    if (!cae) return { ok: false, error: `\`numero\` ${res.numero} no cae en ninguna banda configurada` }
  }
  return { ok: true }
}

function validarMultiEquipo(res, cfg) {
  if (!Array.isArray(res.equipos)) {
    return { ok: false, error: '`equipos` debe ser un array' }
  }
  if (res.equipos.some(c => typeof c !== 'string' || !c)) {
    return { ok: false, error: '`equipos` contiene códigos vacíos o no-string' }
  }
  const set = new Set(res.equipos)
  if (set.size !== res.equipos.length) {
    return { ok: false, error: '`equipos` contiene duplicados' }
  }
  if (Number.isInteger(cfg.n_equipos) && res.equipos.length > cfg.n_equipos) {
    return { ok: false, error: `\`equipos\` tiene ${res.equipos.length} ítems pero el máximo es ${cfg.n_equipos}` }
  }
  return { ok: true, codigos_referenciados: res.equipos.slice() }
}

function validarTexto(res, _cfg) {
  if (typeof res.texto !== 'string' || !res.texto.trim()) {
    return { ok: false, error: 'Falta `texto` (string no vacío)' }
  }
  // Fase B: claves opcionales de canonización
  if (res.texto_display !== undefined) {
    if (typeof res.texto_display !== 'string' || !res.texto_display.trim()) {
      return { ok: false, error: 'Si se incluye `texto_display`, debe ser string no vacío' }
    }
  }
  if (res.alias !== undefined) {
    if (!Array.isArray(res.alias)) {
      return { ok: false, error: '`alias` debe ser un array de strings' }
    }
    if (res.alias.length > 50) {
      return { ok: false, error: '`alias` admite hasta 50 entradas' }
    }
    const vistos = new Set()
    for (const a of res.alias) {
      if (typeof a !== 'string' || !a.trim()) {
        return { ok: false, error: '`alias` contiene entradas vacías o no-string' }
      }
      const norm = normalizarTexto(a)
      if (vistos.has(norm)) {
        return { ok: false, error: `\`alias\` contiene duplicados tras normalizar: "${a}"` }
      }
      vistos.add(norm)
    }
    // Un alias igual al canónico normalizado es redundante pero no rompe nada → warning suave vía error solo si TODOS lo son. Lo dejamos pasar.
  }
  if (res.pts_si_acierta !== undefined) {
    if (!Number.isInteger(res.pts_si_acierta) || res.pts_si_acierta < 0) {
      return { ok: false, error: '`pts_si_acierta` debe ser entero >= 0' }
    }
  }
  if (res.overrides_pts !== undefined) {
    if (typeof res.overrides_pts !== 'object' || res.overrides_pts === null || Array.isArray(res.overrides_pts)) {
      return { ok: false, error: '`overrides_pts` debe ser objeto { user_id: pts }' }
    }
    for (const [k, v] of Object.entries(res.overrides_pts)) {
      if (!/^\d+$/.test(k)) {
        return { ok: false, error: `\`overrides_pts\` clave "${k}" no es user_id válido (entero)` }
      }
      if (!Number.isInteger(v) || v < 0) {
        return { ok: false, error: `\`overrides_pts[${k}]\` debe ser entero >= 0` }
      }
    }
  }
  return { ok: true }
}

/**
 * Valida un `resultado_json` (objeto ya parseado) según el tipo de pregunta y
 * su `config_json` (también parseado).
 *
 * @param {string} tipo
 * @param {object} configJson
 * @param {object} resultado
 * @returns {{ ok: true, codigos_referenciados?: string[] } | { ok: false, error: string }}
 */
function validarResultado(tipo, configJson, resultado) {
  if (!resultado || typeof resultado !== 'object' || Array.isArray(resultado)) {
    return { ok: false, error: '`resultado_json` debe ser objeto' }
  }
  const cfg = configJson || {}
  switch (tipo) {
    case 'opcion_unica':          return validarOpcionUnica(resultado, cfg)
    case 'equipo_categoria':      return validarEquipoCategoria(resultado, cfg)
    case 'instancia_eliminacion': return validarInstanciaEliminacion(resultado, cfg)
    case 'numero_exacto':         return validarNumeroExacto(resultado, cfg)
    case 'numero_por_banda':      return validarNumeroPorBanda(resultado, cfg)
    case 'multi_equipo':          return validarMultiEquipo(resultado, cfg)
    case 'respuesta_manual':
    case 'regla_especial':        return validarTexto(resultado, cfg)
    default:                      return { ok: false, error: `tipo_pregunta no soportado: ${tipo}` }
  }
}

module.exports = { validarResultado }
