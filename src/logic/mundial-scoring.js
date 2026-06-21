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
 *   - numero_por_banda:       resp.numero === res.numero → pts de la banda donde cae res.numero. Sino 0.
 *                             (Las bandas definen los pts según el valor real, no rangos aceptables.)
 *   - multi_equipo:           |intersección(resp.equipos, res.equipos)| × pts_por_acierto.
 *   - respuesta_manual / regla_especial:
 *       1. Si res.overrides_pts[userId] está definido → ese pts (pisa todo).
 *       2. Sino, normalizar(resp.texto) === normalizar(res.texto) → pts_si_acierta ?? cfg.pts_max.
 *       2-bis. (Fase B) Sino, normalizar(resp.texto) ∈ normalizar(res.alias[]) → mismos pts.
 *       3. Sino 0.
 *
 * Notas:
 *   - Si falta cualquier insumo (respuesta del user vacía, resultado no cargado),
 *     devuelve 0 sin throw. El caller decide si filtrar o no.
 *   - `userId` solo aplica para tipos texto (respuesta_manual / regla_especial)
 *     por el override individual. Para el resto se ignora.
 */

// ───────────────────────────── helpers ─────────────────────────────

/** Normaliza texto: lowercase + trim + sin tildes + sin puntuación simple +
 *  espacios colapsados. Para matching tolerante (Fase B: amplía la versión
 *  Fase 3, que solo hacía tildes/lowercase/trim — la ampliación solo puede
 *  convertir no-matches en matches, nunca romper matches existentes).
 *  Implementado sin regex unicode (filtro char-by-char por charCode) para
 *  evitar problemas de encoding al guardar el archivo. */

// Puntuación que se ELIMINA: . , ; : ! ? ' " ´ ` y comillas tipográficas ‘ ’ “ ”
const PUNT_ELIMINAR = new Set([
  0x2E, 0x2C, 0x3B, 0x3A, 0x21, 0x3F, 0x27, 0x22, 0xB4, 0x60,
  0x2018, 0x2019, 0x201C, 0x201D,
])
// Separadores que se convierten en ESPACIO: - _ /
const PUNT_A_ESPACIO = new Set([0x2D, 0x5F, 0x2F])

function normalizarTexto(s) {
  if (typeof s !== 'string') return ''
  const nfd = s.normalize('NFD')
  let out = ''
  for (let i = 0; i < nfd.length; i++) {
    const c = nfd.charCodeAt(i)
    // Skip combining diacritical marks (U+0300..U+036F)
    if (c >= 0x0300 && c <= 0x036F) continue
    if (PUNT_ELIMINAR.has(c)) continue
    if (PUNT_A_ESPACIO.has(c)) { out += ' '; continue }
    out += nfd[i]
  }
  // Colapsar espacios múltiples (incluye los introducidos por separadores)
  let limpio = ''
  let prevEspacio = false
  for (let i = 0; i < out.length; i++) {
    const esEspacio = out[i] === ' ' || out[i] === '\t' || out[i] === '\n'
    if (esEspacio) {
      if (!prevEspacio) limpio += ' '
      prevEspacio = true
    } else {
      limpio += out[i]
      prevEspacio = false
    }
  }
  return limpio.toLowerCase().trim()
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
  // Regla del juego (confirmada 2026-06-21):
  //   Sólo paga si el user acierta el numero EXACTO. La banda donde cae el
  //   valor real define cuántos pts vale ese acierto (acertar valores poco
  //   probables paga más).
  //   Ejemplo (cfg.bandas = [{min:0,max:2,pts:10},{min:3,pts:25}]):
  //     res=2, resp=2 → 10 (exacto, cae en banda 0-2)
  //     res=2, resp=1 → 0  (NO exacto, aunque ambos en 0-2)
  //     res=5, resp=5 → 25 (exacto, cae en banda 3+)
  //     res=5, resp=3 → 0  (NO exacto, aunque ambos en 3+)
  if (!Number.isInteger(res?.numero) || !Number.isInteger(resp?.numero)) return 0
  if (resp.numero !== res.numero) return 0
  const iRes = findBanda(cfg.bandas, res.numero)
  if (iRes === -1) return 0
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

/**
 * matchTexto — Fase B. Evalúa una respuesta de texto contra el resultado y
 * devuelve { match, pts } donde match ∈:
 *   'override'    → overrides_pts[userId] definido (pisa todo, igual que siempre)
 *   'exacto'      → resp.texto === res.texto (identidad de string)
 *   'normalizado' → iguales tras normalizarTexto()
 *   'alias'       → normalizado coincide con algún res.alias[] normalizado
 *   'sin_match'   → ninguna de las anteriores (pts 0)
 * Compatibilidad: con resultado sin `alias`, los pts son idénticos a Fase 3
 * (override → normalizado → 0). Usado por puntosTexto y por el preview admin.
 */
function matchTexto(cfg, res, resp, userId) {
  // 1) override por user (clave puede venir como string o number)
  if (res?.overrides_pts && typeof res.overrides_pts === 'object' && userId != null) {
    const ov = res.overrides_pts[String(userId)]
    if (Number.isInteger(ov)) return { match: 'override', pts: ov }
  }
  const ptsAcierto =
    Number.isInteger(res?.pts_si_acierta) ? res.pts_si_acierta :
    Number.isInteger(cfg?.pts_max)        ? cfg.pts_max        : 0
  const tRes  = normalizarTexto(res?.texto)
  const tResp = normalizarTexto(resp?.texto)
  if (!tRes || !tResp) return { match: 'sin_match', pts: 0 }
  // 2) matching automático: exacto / normalizado
  if (tRes === tResp) {
    const exacto = typeof res?.texto === 'string' && typeof resp?.texto === 'string' &&
                   res.texto.trim() === resp.texto.trim()
    return { match: exacto ? 'exacto' : 'normalizado', pts: ptsAcierto }
  }
  // 2-bis) alias definidos por admin (Fase B). Mismos pts que el canónico.
  if (Array.isArray(res?.alias)) {
    for (const a of res.alias) {
      const tAlias = normalizarTexto(a)
      if (tAlias && tAlias === tResp) return { match: 'alias', pts: ptsAcierto }
    }
  }
  return { match: 'sin_match', pts: 0 }
}

function puntosTexto(cfg, res, resp, userId) {
  return matchTexto(cfg, res, resp, userId).pts
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
 * Orden: pts_totales DESC. Empate de pts: gana quien acertó la pregunta de
 * NUMERO MÁS ALTO (regla del juego confirmada 2026-06-21 — "de abajo para
 * arriba"). Si los aciertos coinciden exactamente, fallback alfabético.
 * Dense-rank: comparten posición sólo si mismos pts Y mismos aciertos.
 */
// `aciertos_numeros` viene ordenado DESC (mayor a menor) para que el primer
// elemento sea el numero más alto que el user acertó. El comparator itera
// por índice y el primer diff define ganador.
function compararEmpate(a, b) {
  const A = a.aciertos_numeros || []
  const B = b.aciertos_numeros || []
  const min = Math.min(A.length, B.length)
  for (let i = 0; i < min; i++) {
    if (A[i] !== B[i]) return B[i] - A[i]  // mayor gana (asume arrays desc)
  }
  // Si uno tiene más aciertos y los comparados son iguales, gana el más largo.
  if (A.length !== B.length) return B.length - A.length
  // Mismos aciertos exactos → fallback alfabético.
  return (a.nombre || '').localeCompare(b.nombre || '', 'es')
}

// Dense-rank: comparten posición sólo si pts y aciertos son idénticos.
function mismaPosicionRanking(a, b) {
  if (a.puntos_totales !== b.puntos_totales) return false
  const A = a.aciertos_numeros || []
  const B = b.aciertos_numeros || []
  if (A.length !== B.length) return false
  for (let i = 0; i < A.length; i++) if (A[i] !== B[i]) return false
  return true
}

function calcularRanking(db, torneoId) {
  // 1) Preguntas con (o sin) resultado del torneo
  const preguntas = db.prepare(`
    SELECT p.id, p.numero, p.tipo_pregunta, p.config_json, r.resultado_json
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

  // 2) Pre-parsear cfg + resultado de cada pregunta una sola vez.
  //    Ordenamos por numero DESC para que el array de aciertos quede ordenado
  //    de mayor a menor (necesario para el desempate "de abajo para arriba").
  const parsed = preguntasConResultado.map(p => ({
    id:     p.id,
    numero: p.numero,
    tipo:   p.tipo_pregunta,
    cfg:    parseSafe(p.config_json),
    res:    parseSafe(p.resultado_json),
  })).sort((a, b) => b.numero - a.numero)

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

  // 5) Calcular pts por user + array de aciertos (numeros DESC) para desempate
  const ranking = []
  for (const [user_id, { nombre, respuestas: rmap }] of porUser.entries()) {
    let puntos_totales = 0
    let aciertos = 0
    const aciertos_numeros = []
    for (const p of parsed) {
      const resp = rmap.get(p.id) || {}
      const pts  = calcularPuntosPregunta(p.tipo, p.cfg, p.res, resp, user_id)
      puntos_totales += pts
      if (pts > 0) {
        aciertos++
        aciertos_numeros.push(p.numero)  // parsed ya iterado en orden desc
      }
    }
    ranking.push({ user_id, nombre, puntos_totales, aciertos, aciertos_numeros })
  }

  // 6) Ordenar: pts desc, después desempate por numero más alto, fallback nombre.
  ranking.sort((a, b) => {
    if (b.puntos_totales !== a.puntos_totales) return b.puntos_totales - a.puntos_totales
    return compararEmpate(a, b)
  })

  // 7) Dense-rank: comparten posición sólo si mismos pts Y mismos aciertos.
  let posActual = 0
  let prev = null
  for (let i = 0; i < ranking.length; i++) {
    if (prev === null || !mismaPosicionRanking(ranking[i], prev)) {
      posActual = i + 1
      prev = ranking[i]
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
  matchTexto,
}
