/**
 * mundial-scoring.js — Fase 3
 *
 * Cálculo de puntos del Mundial. Funciones puras, determinísticas y
 * re-ejecutables. Fuente de verdad: (config_json, resultado_json, respuesta_json).
 * NO mantiene cache propio. El ranking se calcula on-the-fly leyendo respuestas
 * y resultados de la DB.
 *
 * API pública:
 *   - calcularPuntosPregunta(tipo, configJson, resultadoJson, respuestaJson, userId) → number
 *   - calcularRanking(db, torneoId) → { ranking, preguntas_con_resultado, total_preguntas }
 *   - calcularMisPuntos(db, torneoId, userId) → array de detalle por pregunta
 *   - normalizarTexto(s) → string (helper expuesto para tests)
 *
 * Reglas por tipo (Fase 3 MVP, ver mini-plan):
 *   - opcion_unica:           si resp.opcion === res.opcion → pts_por_opcion[res.opcion] ?? cfg.pts. Sino 0.
 *   - equipo_categoria:       si resp.equipo === res.equipo → pts de la categoría que contiene a res.equipo
 *                             (o categoría default si ninguna lo contiene). Sino 0.
 *   - instancia_eliminacion:  si resp.instancia === res.instancia → cfg.pts_por_instancia[res.instancia]. Sino 0.
 *   - numero_exacto:          si resp.numero === res.numero → pts_si_acierta. Sino pts_si_no_acierta (default 0).
 *   - numero_por_banda:       banda(res.numero) === banda(resp.numero) → pts de esa banda. Sino 0.
 *   - multi_equipo:           |intersección(resp.equipos, res.equipos)| × pts_por_acierto.
 *   - respuesta_manual / regla_especial:
 *       1. Si res.overrides_pts[userId] está definido → ese pts (pisa todo).
 *       2. Sino, normalizar(resp.texto) === normalizar(res.texto) → pts_si_acierta ?? cfg.pts_max. Sino 0.
 *
 * Notas:
 *   - Si falta cualquier insumo (respuesta del user vacía, resultado no cargado),
 *     devuelve 0 sin throw. El caller decide si filtrar o no.
 *   - `userId` solo aplica para tipos texto (respuesta_manual / regla_especial)
 *     por el override individual. Para el resto se ignora.
 */

// ───────────────────────────── helpers ─────────────────────────────

/** Normaliza texto: lowercase + trim + sin tildes. Para matching tolerante.
 *  Implementado sin regex unicode (filtro char-by-char) para evitar problemas
 *  de encoding al guardar el archivo. */
function normalizarTexto(s) {
  if (typeof s !== 'string') return ''
  const nfd = s.normalize('NFD')
  let out = ''
  for (let i = 0; i < nfd.length; i++) {
    const c = nfd.charCodeAt(i)
    // Skip combining diacritical marks (U+0300..U+036F)
    if (c >= 0x0300 && c <= 0x036F) continue
    out += nfd[i]
  }
  return out.toLowerCase().trim()
}

/** Devuelve el índice de la banda que contiene `n`, o -1 si ninguna. */
function findBanda(bandas, n) {
  if (!Number.isInteger(n) || !Array.isArray(bandas)) return -1
  for (let i = 0; i < bandas.length; i++) {
    const b = bandas[i] || {}
    const min = Number.isInteger(b.min) ? b.min : -Infinity
    const max = Number.isInteger(b.max) ? b.max : Infinity
    if (n >= min && n <= max) return i
  }
  return -1
}

/** JSON.parse tolerante: vuelve {} si el string es null/inválido. */
function parseSafe(s) {
  if (!s) return {}
  try { return JSON.parse(s) || {} } catch { return {} }
}

// ───────────────────────────── por tipo ────────────────────────────

function puntosOpcionUnica(cfg, res, resp) {
  if (typeof res?.opcion !== 'string' || typeof resp?.opcion !== 'string') return 0
  if (resp.opcion !== res.opcion) return 0
  if (cfg.pts_por_opcion && typeof cfg.pts_por_opcion === 'object' && res.opcion in cfg.pts_por_opcion) {
    const v = cfg.pts_por_opcion[res.opcion]
    return Number.isInteger(v) ? v : 0
  }
  return Number.isInteger(cfg.pts) ? cfg.pts : 0
}

function puntosEquipoCategoria(cfg, res, resp, userId) {
  // Fase 3.2 — modo scoring_manual: ignora categorías y auto-match. Solo aplica
  // overrides_pts[userId]. Sin override → 0. Usado por P35/P36 (amarillas/rojas)
  // donde la asimetría "25 si entre todos / 10 si entre nuestros" no se modela
  // con categorías y se resuelve a mano.
  if (cfg.scoring_manual === true) {
    if (res?.overrides_pts && typeof res.overrides_pts === 'object' && userId != null) {
      const ov = res.overrides_pts[String(userId)]
      if (Number.isInteger(ov)) return ov
    }
    return 0
  }
  // Modo estándar: scoring por categorías.
  if (typeof res?.equipo !== 'string' || typeof resp?.equipo !== 'string') return 0
  if (resp.equipo !== res.equipo) return 0
  const cats = Array.isArray(cfg.categorias) ? cfg.categorias : []
  // 1) buscar categoría con `equipos` que incluya res.equipo
  for (const cat of cats) {
    if (cat && Array.isArray(cat.equipos) && cat.equipos.includes(res.equipo)) {
      return Number.isInteger(cat.pts) ? cat.pts : 0
    }
  }
  // 2) fallback: categoría default
  const def = cats.find(c => c && c.default)
  return def && Number.isInteger(def.pts) ? def.pts : 0
}

function puntosInstanciaEliminacion(cfg, res, resp) {
  if (typeof res?.instancia !== 'string' || typeof resp?.instancia !== 'string') return 0
  if (resp.instancia !== res.instancia) return 0
  const tbl = cfg.pts_por_instancia
  if (!tbl || typeof tbl !== 'object') return 0
  const v = tbl[res.instancia]
  return Number.isInteger(v) ? v : 0
}

function puntosNumeroExacto(cfg, res, resp) {
  if (!Number.isInteger(res?.numero) || !Number.isInteger(resp?.numero)) return 0
  if (resp.numero === res.numero) {
    return Number.isInteger(cfg.pts_si_acierta) ? cfg.pts_si_acierta : 0
  }
  return Number.isInteger(cfg.pts_si_no_acierta) ? cfg.pts_si_no_acierta : 0
}

function puntosNumeroPorBanda(cfg, res, resp) {
  if (!Number.isInteger(res?.numero) || !Number.isInteger(resp?.numero)) return 0
  const iRes  = findBanda(cfg.bandas, res.numero)
  const iResp = findBanda(cfg.bandas, resp.numero)
  if (iRes === -1 || iRes !== iResp) return 0
  const pts = (cfg.bandas[iRes] || {}).pts
  return Number.isInteger(pts) ? pts : 0
}

function puntosMultiEquipo(cfg, res, resp) {
  const respEquipos = Array.isArray(resp?.equipos) ? resp.equipos : []
  const resEquipos  = Array.isArray(res?.equipos)  ? res.equipos  : []
  if (resEquipos.length === 0 || respEquipos.length === 0) return 0
  const set = new Set(resEquipos)
  const aciertos = respEquipos.filter(c => set.has(c)).length
  const ptsPorAcierto = Number.isInteger(cfg.pts_por_acierto) ? cfg.pts_por_acierto : 0
  return aciertos * ptsPorAcierto
}

function puntosTexto(cfg, res, resp, userId) {
  // 1) override por user (clave puede venir como string o number)
  if (res?.overrides_pts && typeof res.overrides_pts === 'object' && userId != null) {
    const ov = res.overrides_pts[String(userId)]
    if (Number.isInteger(ov)) return ov
  }
  // 2) matching automático normalizado
  const tRes  = normalizarTexto(res?.texto)
  const tResp = normalizarTexto(resp?.texto)
  if (!tRes || !tResp) return 0
  if (tRes !== tResp) return 0
  if (Number.isInteger(res?.pts_si_acierta)) return res.pts_si_acierta
  if (Number.isInteger(cfg.pts_max))         return cfg.pts_max
  return 0
}

// ───────────────────────── dispatcher público ──────────────────────

function calcularPuntosPregunta(tipo, configJson, resultadoJson, respuestaJson, userId) {
  const cfg  = configJson    || {}
  const res  = resultadoJson || {}
  const resp = respuestaJson || {}
  switch (tipo) {
    case 'opcion_unica':          return puntosOpcionUnica(cfg, res, resp)
    case 'equipo_categoria':      return puntosEquipoCategoria(cfg, res, resp, userId)
    case 'instancia_eliminacion': return puntosInstanciaEliminacion(cfg, res, resp)
    case 'numero_exacto':         return puntosNumeroExacto(cfg, res, resp)
    case 'numero_por_banda':      return puntosNumeroPorBanda(cfg, res, resp)
    case 'multi_equipo':          return puntosMultiEquipo(cfg, res, resp)
    case 'respuesta_manual':
    case 'regla_especial':        return puntosTexto(cfg, res, resp, userId)
    default:                      return 0
  }
}

// ───────────────────────────── ranking ─────────────────────────────

/**
 * Calcula el ranking del torneo. Solo se evalúan preguntas que tienen resultado
 * cargado. Usuarios que nunca respondieron quedan fuera del ranking.
 *
 * Orden: puntos desc, empates por nombre alfabético. Posiciones por puntaje
 * (mismos pts → misma posición; la siguiente salta al rank correcto).
 */
function calcularRanking(db, torneoId) {
  // 1) Preguntas con (o sin) resultado del torneo
  const preguntas = db.prepare(`
    SELECT p.id, p.tipo_pregunta, p.config_json, r.resultado_json
    FROM mundial_preguntas p
    LEFT JOIN mundial_resultados r ON r.pregunta_id = p.id
    WHERE p.torneo_id = ? AND p.activa = 1
  `).all(torneoId)

  const preguntasConResultado = preguntas.filter(p => p.resultado_json)
  const total_preguntas       = preguntas.length
  const preguntas_con_resultado = preguntasConResultado.length

  if (preguntas_con_resultado === 0) {
    return { ranking: [], preguntas_con_resultado: 0, total_preguntas }
  }

  // 2) Pre-parsear cfg + resultado de cada pregunta una sola vez
  const parsed = preguntasConResultado.map(p => ({
    id:    p.id,
    tipo:  p.tipo_pregunta,
    cfg:   parseSafe(p.config_json),
    res:   parseSafe(p.resultado_json),
  }))

  // 3) Cargar respuestas de TODOS los users que respondieron en este torneo
  const respuestas = db.prepare(`
    SELECT ru.user_id, ru.pregunta_id, ru.respuesta_json, u.nombre
    FROM mundial_respuestas_usuario ru
    JOIN users u             ON u.id = ru.user_id
    JOIN mundial_preguntas p ON p.id = ru.pregunta_id
    WHERE p.torneo_id = ?
  `).all(torneoId)

  // 4) Indexar respuestas por user
  const porUser = new Map() // user_id → { nombre, respuestas: Map<pregunta_id, obj> }
  for (const r of respuestas) {
    let bucket = porUser.get(r.user_id)
    if (!bucket) {
      bucket = { nombre: r.nombre, respuestas: new Map() }
      porUser.set(r.user_id, bucket)
    }
    bucket.respuestas.set(r.pregunta_id, parseSafe(r.respuesta_json))
  }

  // 5) Calcular pts por user
  const ranking = []
  for (const [user_id, { nombre, respuestas: rmap }] of porUser.entries()) {
    let puntos_totales = 0
    let aciertos = 0
    for (const p of parsed) {
      const resp = rmap.get(p.id) || {}
      const pts  = calcularPuntosPregunta(p.tipo, p.cfg, p.res, resp, user_id)
      puntos_totales += pts
      if (pts > 0) aciertos++
    }
    ranking.push({ user_id, nombre, puntos_totales, aciertos })
  }

  // 6) Ordenar por pts desc, empates por nombre
  ranking.sort((a, b) => {
    if (b.puntos_totales !== a.puntos_totales) return b.puntos_totales - a.puntos_totales
    return (a.nombre || '').localeCompare(b.nombre || '', 'es')
  })

  // 7) Posiciones con dense-rank style (empates comparten posición)
  let posActual = 0
  let prevPts   = null
  for (let i = 0; i < ranking.length; i++) {
    if (prevPts === null || ranking[i].puntos_totales !== prevPts) {
      posActual = i + 1
      prevPts   = ranking[i].puntos_totales
    }
    ranking[i].posicion = posActual
  }

  return { ranking, preguntas_con_resultado, total_preguntas }
}

// ────────────────────────── detalle "mis puntos" ───────────────────

/**
 * Devuelve el detalle por pregunta del usuario indicado. Cada item incluye:
 *   { pregunta_id, numero, enunciado, tipo_pregunta, mi_respuesta, resultado,
 *     tiene_resultado, pts_obtenidos (null si pendiente) }
 *
 * Útil para pantalla "Mis puntos" en /mundial/:torneoId.
 */
function calcularMisPuntos(db, torneoId, userId) {
  const rows = db.prepare(`
    SELECT p.id, p.numero, p.enunciado, p.tipo_pregunta, p.config_json,
           r.resultado_json,
           ru.respuesta_json AS mi_respuesta_json
    FROM mundial_preguntas p
    LEFT JOIN mundial_resultados      r  ON r.pregunta_id  = p.id
    LEFT JOIN mundial_respuestas_usuario ru ON ru.pregunta_id = p.id AND ru.user_id = ?
    WHERE p.torneo_id = ? AND p.activa = 1
    ORDER BY p.numero
  `).all(userId, torneoId)

  return rows.map(p => {
    const cfg  = parseSafe(p.config_json)
    const res  = p.resultado_json    ? parseSafe(p.resultado_json)    : null
    const resp = p.mi_respuesta_json ? parseSafe(p.mi_respuesta_json) : null
    const pts  = res ? calcularPuntosPregunta(p.tipo_pregunta, cfg, res, resp || {}, userId) : null
    return {
      pregunta_id:    p.id,
      numero:         p.numero,
      enunciado:      p.enunciado,
      tipo_pregunta:  p.tipo_pregunta,
      mi_respuesta:   resp,
      resultado:      res,
      tiene_resultado: !!res,
      pts_obtenidos:   pts,
    }
  })
}

module.exports = {
  calcularPuntosPregunta,
  calcularRanking,
  calcularMisPuntos,
  normalizarTexto,
}
