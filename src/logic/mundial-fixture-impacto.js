/**
 * mundial-fixture-impacto.js — Calcula el impacto de cada proximo partido
 * sobre el ranking y los puntos del user.
 */

const { calcularStats } = require('./mundial-stats')
const { calcularRankingProyectado } = require('./mundial-proyeccion')
const { calcularRanking } = require('./mundial-scoring')

const PREGUNTAS_POR_RONDA = {
  '16vos':          [32],
  '8vos':           [33],
  '4tos':           [34],
  'semis':          [1, 2],
  'tercer_puesto':  [3, 4],
  'final':          [1, 2],
}

const PREGUNTA_INSTANCIA_POR_EQUIPO = {
  'ING': 11, 'ARG': 12, 'BRA': 13, 'ESP': 14, 'ALE': 15, 'FRA': 16,
}

function calcularImpactoFixture(db, torneoId, userIdActual = null) {
  const partidos = db.prepare('SELECT * FROM mundial_partidos WHERE torneo_id = ?').all(torneoId)
  const catalogo = db.prepare(
    'SELECT codigo, nombre, emoji, grupo, confederacion FROM mundial_equipos_catalogo WHERE torneo_id = ? AND activo = 1'
  ).all(torneoId)
  const tarjetasLegacy = db.prepare(
    'SELECT equipo_codigo, amarillas, rojas FROM mundial_tarjetas_partido WHERE torneo_id = ?'
  ).all(torneoId)
  const tieneTablaModal = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='mundial_partido_goleadores'"
  ).get()
  const goleadoresRows = tieneTablaModal
    ? db.prepare(`
        SELECT jugador, equipo_codigo, SUM(goles) AS goles
        FROM (
          SELECT jugador, equipo_codigo, goles
          FROM mundial_goleadores
          WHERE torneo_id = ? AND activo = 1
          UNION ALL
          SELECT jugador, equipo_codigo, SUM(goles) AS goles
          FROM mundial_partido_goleadores
          WHERE torneo_id = ?
          GROUP BY jugador, equipo_codigo
        )
        GROUP BY jugador, equipo_codigo
        ORDER BY goles DESC, jugador ASC
      `).all(torneoId, torneoId)
    : db.prepare(`
        SELECT jugador, equipo_codigo, goles
        FROM mundial_goleadores
        WHERE torneo_id = ? AND activo = 1
        ORDER BY goles DESC, jugador ASC
      `).all(torneoId)
  let posG = 0, prevG = null
  const goleadores = goleadoresRows.map((g, i) => {
    if (prevG === null || g.goles !== prevG) { posG = i + 1; prevG = g.goles }
    return { ...g, posicion: posG }
  })

  const statsBase = calcularStats({ partidos, catalogo, tarjetasLegacy, topLimit: 50 })
  const rankingBase = calcularRankingProyectado(db, torneoId, statsBase, goleadores)
  const userActualRow = userIdActual != null
    ? rankingBase.ranking.find(r => r.user_id === userIdActual) || null
    : null
  // Fix "HOY ESTÁS" (2026-07-07): además del proyectado, calculamos el
  // ranking OFICIAL (basado en resultados_cargados) para el card "HOY ESTÁS".
  // Proyecciones siguen usando rankingBase. Si no hay resultados cargados,
  // rankingOficial devuelve ranking=[] y userActualOficialRow será null.
  const rankingOficial = calcularRanking(db, torneoId)
  const userActualOficialRow = userIdActual != null
    ? rankingOficial.ranking.find(r => r.user_id === userIdActual) || null
    : null

  const porVenirTodos = partidos.filter(p => p.estado === 'pendiente' || p.estado === 'en_juego')
  const rondaActual = detectarRondaActual(porVenirTodos)
  const soloKO = rondaActual && rondaActual !== 'grupos'
  const proximos = soloKO
    ? porVenirTodos.filter(p =>
        p.ronda === rondaActual &&
        p.equipo_local && p.equipo_visitante
      )
    : []

  const hoyUTC = new Date().toISOString().slice(0, 10)
  const jugadosHoy = partidos.filter(p =>
    p.estado === 'finalizado' &&
    p.updated_at && p.updated_at.slice(0, 10) === hoyUTC
  )

  const porVenirResult = []
  for (const partido of proximos) {
    const escenarios = {
      gana_local: calcularEscenarioKO(
        db, torneoId, partidos, partido, 'local',
        catalogo, tarjetasLegacy, goleadores, rankingBase, userIdActual
      ),
      gana_visitante: calcularEscenarioKO(
        db, torneoId, partidos, partido, 'visitante',
        catalogo, tarjetasLegacy, goleadores, rankingBase, userIdActual
      ),
    }
    porVenirResult.push({
      partido_id: partido.id,
      ronda: partido.ronda,
      orden: partido.orden,
      fecha: partido.fecha,
      equipo_local: partido.equipo_local,
      equipo_visitante: partido.equipo_visitante,
      estado: partido.estado,
      // Sprint fixture-en-vivo (2026-06-27): goles actuales si en_juego.
      goles_local: partido.goles_local,
      goles_visitante: partido.goles_visitante,
      escenarios,
      preguntas_en_juego: preguntasEnJuego(partido),
    })
  }

  const jornada = calcularJornada(porVenirResult, jugadosHoy, userIdActual, userActualRow)

  const misPtsBaseline = userIdActual != null && userActualRow
    ? userActualRow.puntos_proyectados
    : null
  const jugadosResult = jugadosHoy.map(p => {
    let ptsSumasteYo = null
    if (misPtsBaseline != null) {
      const partidosSinEste = partidos.map(x =>
        x.id === p.id
          ? { ...x, estado: 'pendiente', goles_local: null, goles_visitante: null,
              penales_local: null, penales_visitante: null }
          : x
      )
      const statsSin = calcularStats({ partidos: partidosSinEste, catalogo, tarjetasLegacy, topLimit: 50 })
      const rankSin = calcularRankingProyectado(db, torneoId, statsSin, goleadores)
      const rSin = rankSin.ranking.find(r => r.user_id === userIdActual)
      const ptsSin = rSin ? rSin.puntos_proyectados : 0
      ptsSumasteYo = Math.max(0, misPtsBaseline - ptsSin)
    }
    return {
      partido_id: p.id,
      ronda: p.ronda,
      orden: p.orden,
      fecha: p.fecha,
      equipo_local: p.equipo_local,
      equipo_visitante: p.equipo_visitante,
      goles_local: p.goles_local,
      goles_visitante: p.goles_visitante,
      pts_sumaste_yo: ptsSumasteYo,
    }
  })

  return {
    user_actual: userActualRow ? {
      user_id: userActualRow.user_id,
      nombre: userActualRow.nombre,
      posicion: userActualRow.posicion,
      pts: userActualRow.puntos_proyectados,
    } : null,
    // Ranking OFICIAL: lo que suma HOY según resultados YA cargados por el
    // admin. Si no hay ninguno cargado todavía, es null.
    user_actual_oficial: userActualOficialRow ? {
      user_id: userActualOficialRow.user_id,
      nombre: userActualOficialRow.nombre,
      posicion: userActualOficialRow.posicion,
      pts: userActualOficialRow.puntos_totales,
    } : null,
    ronda_actual: rondaActual,
    jornada,
    por_venir: porVenirResult,
    jugados_hoy: jugadosResult,
  }
}

const ORDEN_RONDAS_KO = ['16vos', '8vos', '4tos', 'semis', 'tercer_puesto', 'final']

function detectarRondaActual(porVenirTodos) {
  if (porVenirTodos.length === 0) return null
  const rondasPendientes = new Set(porVenirTodos.map(p => p.ronda))
  for (const r of ORDEN_RONDAS_KO) {
    if (rondasPendientes.has(r)) return r
  }
  if (rondasPendientes.has('grupos')) return 'grupos'
  return null
}

function preguntasEnJuego(partido) {
  const nums = new Set(PREGUNTAS_POR_RONDA[partido.ronda] || [])
  const pL = PREGUNTA_INSTANCIA_POR_EQUIPO[partido.equipo_local]
  const pV = PREGUNTA_INSTANCIA_POR_EQUIPO[partido.equipo_visitante]
  if (pL) nums.add(pL)
  if (pV) nums.add(pV)
  return [...nums].sort((a, b) => a - b)
}

function calcularEscenarioKO(
  db, torneoId, partidosBase, partidoAmodificar, ladoGanador,
  catalogo, tarjetasLegacy, goleadores, rankingBase, userIdActual
) {
  const gL = ladoGanador === 'local' ? 1 : 0
  const gV = ladoGanador === 'visitante' ? 1 : 0
  const partidosHipo = partidosBase.map(p =>
    p.id === partidoAmodificar.id
      ? { ...p, estado: 'finalizado', goles_local: gL, goles_visitante: gV }
      : p
  )
  const statsHipo = calcularStats({ partidos: partidosHipo, catalogo, tarjetasLegacy, topLimit: 50 })
  const rankingHipo = calcularRankingProyectado(db, torneoId, statsHipo, goleadores)

  const equipoGanador  = ladoGanador === 'local' ? partidoAmodificar.equipo_local : partidoAmodificar.equipo_visitante
  const equipoElim     = ladoGanador === 'local' ? partidoAmodificar.equipo_visitante : partidoAmodificar.equipo_local

  const rankingBaseById = new Map(rankingBase.ranking.map(r => [r.user_id, r]))
  const deltasBeneficiados = []
  let deltaYo = 0
  let nuevaPosYo = null

  for (const rHipo of rankingHipo.ranking) {
    const rBase = rankingBaseById.get(rHipo.user_id)
    const deltaPts = rHipo.puntos_proyectados - (rBase ? rBase.puntos_proyectados : 0)
    if (rHipo.user_id === userIdActual) {
      deltaYo = deltaPts
      nuevaPosYo = rHipo.posicion
    }
    if (deltaPts > 0) {
      deltasBeneficiados.push({
        user_id: rHipo.user_id,
        nombre: rHipo.nombre,
        delta_pts: deltaPts,
        posicion_base: rBase ? rBase.posicion : null,
        posicion_hipo: rHipo.posicion,
      })
    }
  }
  deltasBeneficiados.sort((a, b) => b.delta_pts - a.delta_pts)

  return {
    equipo_ganador: equipoGanador,
    equipo_eliminado: equipoElim,
    delta_yo: deltaYo,
    nueva_posicion_yo: nuevaPosYo,
    deltas_beneficiados: deltasBeneficiados,
  }
}

function calcularJornada(porVenir, jugadosHoy, userIdActual, userActualRow) {
  if (!userIdActual || !userActualRow) {
    return {
      partidos_por_venir: porVenir.length,
      partidos_jugados_hoy: jugadosHoy.length,
      max_pts_posible: 0,
      posicion_optimista: null,
      explicacion_optimista: null,
    }
  }
  let maxPts = 0
  let mejorEscenarioPos = userActualRow.posicion
  let explicacion = null

  for (const p of porVenir) {
    const dL = p.escenarios.gana_local.delta_yo
    const dV = p.escenarios.gana_visitante.delta_yo
    const mejorD = Math.max(dL, dV, 0)
    maxPts += mejorD
    const mejorEsc = dL >= dV ? p.escenarios.gana_local : p.escenarios.gana_visitante
    if (mejorEsc.nueva_posicion_yo != null && mejorEsc.nueva_posicion_yo < mejorEscenarioPos) {
      mejorEscenarioPos = mejorEsc.nueva_posicion_yo
      const arribaMio = mejorEsc.deltas_beneficiados
        .filter(d => d.posicion_hipo < mejorEsc.nueva_posicion_yo && d.user_id !== userIdActual)
        .sort((a, b) => a.posicion_hipo - b.posicion_hipo)[0]
      if (arribaMio) {
        explicacion = arribaMio.nombre + ' suma +' + arribaMio.delta_pts + ' y quedaria #' + arribaMio.posicion_hipo + '.'
      }
    }
  }
  return {
    partidos_por_venir: porVenir.length,
    partidos_jugados_hoy: jugadosHoy.length,
    max_pts_posible: maxPts,
    posicion_optimista: mejorEscenarioPos,
    explicacion_optimista: explicacion,
  }
}

module.exports = {
  calcularImpactoFixture,
  detectarRondaActual,
  preguntasEnJuego,
  PREGUNTAS_POR_RONDA,
  PREGUNTA_INSTANCIA_POR_EQUIPO,
}
