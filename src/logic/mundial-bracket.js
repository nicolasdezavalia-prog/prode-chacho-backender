/**
 * mundial-bracket.js — Generación automática del bracket KO del Mundial 2026.
 *
 * Maneja:
 *   - Creación incremental de R32 a medida que cierran los grupos:
 *       · 8 cruces SIN tercero (R32-1, R32-2, R32-4, R32-5, R32-11, R32-12,
 *         R32-14, R32-15): se crean apenas los 2 grupos involucrados cierran.
 *       · 8 cruces CON tercero (R32-3, R32-6, R32-7, R32-8, R32-9, R32-10,
 *         R32-13, R32-16): se crean cuando los 12 grupos cierran y se conocen
 *         los 8 mejores terceros (matriz FIFA, Anexo C).
 *   - Cascada KO automática R32 → 8vos → 4tos → semis → final + 3er puesto.
 *   - Corrección retroactiva: si el admin cambia el ganador de un partido KO
 *     que ya generó el siguiente, se propaga el cambio automáticamente; los
 *     goles/tarjetas ya cargados del partido siguiente se mantienen, solo
 *     cambia el código de equipo.
 *
 * Idempotente: si la ronda ya tiene partidos, no rehace.
 * Determinístico: misma entrada → misma salida.
 *
 * Reglas anti-loop: estas funciones NO se llaman recursivamente desde el
 * trigger del PUT — el trigger ejecuta UN solo paso (próxima ronda) y termina.
 * Si después el admin guarda otro partido, el siguiente paso se dispara.
 */

const MATRIZ_TERCEROS = require('../data/mundial-r32-matriz.js')
const { compararTerceros, compararEquiposGrupo } = require('./mundial-stats.js')

// ─────────────────────────────────────────────────────────────────────────
// Bracket base — 16 cruces R32 según fixture oficial Mundial 2026.
// El campo `slot` se resuelve durante la generación: 'pos:grupo' (ej.
// '1:A' = 1° del Grupo A) o 'third:vs1X' (rival de 1X, según matriz).
// `orden` es el número fijo del partido en el fixture (1..16 = R32-1..R32-16).
// ─────────────────────────────────────────────────────────────────────────
const R32_BRACKET = [
  { orden: 1,  local: { tipo: 'pos', pos: 2, grupo: 'A' }, visitante: { tipo: 'pos', pos: 2, grupo: 'B' } },
  { orden: 2,  local: { tipo: 'pos', pos: 1, grupo: 'C' }, visitante: { tipo: 'pos', pos: 2, grupo: 'F' } },
  { orden: 3,  local: { tipo: 'pos', pos: 1, grupo: 'E' }, visitante: { tipo: 'third', slot: 'THIRD_SLOT_vs_1E' } },
  { orden: 4,  local: { tipo: 'pos', pos: 1, grupo: 'F' }, visitante: { tipo: 'pos', pos: 2, grupo: 'C' } },
  { orden: 5,  local: { tipo: 'pos', pos: 2, grupo: 'E' }, visitante: { tipo: 'pos', pos: 2, grupo: 'I' } },
  { orden: 6,  local: { tipo: 'pos', pos: 1, grupo: 'I' }, visitante: { tipo: 'third', slot: 'THIRD_SLOT_vs_1I' } },
  { orden: 7,  local: { tipo: 'pos', pos: 1, grupo: 'A' }, visitante: { tipo: 'third', slot: 'THIRD_SLOT_vs_1A' } },
  { orden: 8,  local: { tipo: 'pos', pos: 1, grupo: 'L' }, visitante: { tipo: 'third', slot: 'THIRD_SLOT_vs_1L' } },
  { orden: 9,  local: { tipo: 'pos', pos: 1, grupo: 'G' }, visitante: { tipo: 'third', slot: 'THIRD_SLOT_vs_1G' } },
  { orden: 10, local: { tipo: 'pos', pos: 1, grupo: 'D' }, visitante: { tipo: 'third', slot: 'THIRD_SLOT_vs_1D' } },
  { orden: 11, local: { tipo: 'pos', pos: 1, grupo: 'H' }, visitante: { tipo: 'pos', pos: 2, grupo: 'J' } },
  { orden: 12, local: { tipo: 'pos', pos: 2, grupo: 'K' }, visitante: { tipo: 'pos', pos: 2, grupo: 'L' } },
  { orden: 13, local: { tipo: 'pos', pos: 1, grupo: 'B' }, visitante: { tipo: 'third', slot: 'THIRD_SLOT_vs_1B' } },
  { orden: 14, local: { tipo: 'pos', pos: 2, grupo: 'D' }, visitante: { tipo: 'pos', pos: 2, grupo: 'G' } },
  { orden: 15, local: { tipo: 'pos', pos: 1, grupo: 'J' }, visitante: { tipo: 'pos', pos: 2, grupo: 'H' } },
  { orden: 16, local: { tipo: 'pos', pos: 1, grupo: 'K' }, visitante: { tipo: 'third', slot: 'THIRD_SLOT_vs_1K' } },
]

// ─────────────────────────────────────────────────────────────────────────
// Bracket cascada KO — qué partido alimenta a qué siguiente.
// ─────────────────────────────────────────────────────────────────────────
const CASCADA_KO = [
  { ronda: '8vos', orden: 1, local: { from: '16vos', orden: 1, lado: 'ganador' },  visitante: { from: '16vos', orden: 11, lado: 'ganador' } },
  { ronda: '8vos', orden: 2, local: { from: '16vos', orden: 2, lado: 'ganador' },  visitante: { from: '16vos', orden: 4,  lado: 'ganador' } },
  { ronda: '8vos', orden: 3, local: { from: '16vos', orden: 3, lado: 'ganador' },  visitante: { from: '16vos', orden: 6,  lado: 'ganador' } },
  { ronda: '8vos', orden: 4, local: { from: '16vos', orden: 5, lado: 'ganador' },  visitante: { from: '16vos', orden: 15, lado: 'ganador' } },
  { ronda: '8vos', orden: 5, local: { from: '16vos', orden: 7, lado: 'ganador' },  visitante: { from: '16vos', orden: 13, lado: 'ganador' } },
  { ronda: '8vos', orden: 6, local: { from: '16vos', orden: 8, lado: 'ganador' },  visitante: { from: '16vos', orden: 9,  lado: 'ganador' } },
  { ronda: '8vos', orden: 7, local: { from: '16vos', orden: 10, lado: 'ganador' }, visitante: { from: '16vos', orden: 14, lado: 'ganador' } },
  { ronda: '8vos', orden: 8, local: { from: '16vos', orden: 12, lado: 'ganador' }, visitante: { from: '16vos', orden: 16, lado: 'ganador' } },
  { ronda: '4tos', orden: 1, local: { from: '8vos', orden: 1, lado: 'ganador' },   visitante: { from: '8vos', orden: 2, lado: 'ganador' } },
  { ronda: '4tos', orden: 2, local: { from: '8vos', orden: 3, lado: 'ganador' },   visitante: { from: '8vos', orden: 4, lado: 'ganador' } },
  { ronda: '4tos', orden: 3, local: { from: '8vos', orden: 5, lado: 'ganador' },   visitante: { from: '8vos', orden: 6, lado: 'ganador' } },
  { ronda: '4tos', orden: 4, local: { from: '8vos', orden: 7, lado: 'ganador' },   visitante: { from: '8vos', orden: 8, lado: 'ganador' } },
  { ronda: 'semis', orden: 1, local: { from: '4tos', orden: 1, lado: 'ganador' },  visitante: { from: '4tos', orden: 2, lado: 'ganador' } },
  { ronda: 'semis', orden: 2, local: { from: '4tos', orden: 3, lado: 'ganador' },  visitante: { from: '4tos', orden: 4, lado: 'ganador' } },
  { ronda: 'tercer_puesto', orden: 1, local: { from: 'semis', orden: 1, lado: 'perdedor' }, visitante: { from: 'semis', orden: 2, lado: 'perdedor' } },
  { ronda: 'final',         orden: 1, local: { from: 'semis', orden: 1, lado: 'ganador' },  visitante: { from: 'semis', orden: 2, lado: 'ganador' } },
]

// ─────────────────────────────────────────────────────────────────────────
// Helpers internos
// ─────────────────────────────────────────────────────────────────────────

function grupoCompleto(db, torneoId, grupo) {
  const fin = db.prepare(
    `SELECT COUNT(*) AS n FROM mundial_partidos
     WHERE torneo_id = ? AND ronda = 'grupos' AND grupo = ? AND estado = 'finalizado'`
  ).get(torneoId, grupo)?.n || 0
  return fin >= 6
}

function equipoEnPosicionGrupo(db, torneoId, grupo, posicion) {
  if (!grupoCompleto(db, torneoId, grupo)) return null
  const partidos = db.prepare(
    `SELECT * FROM mundial_partidos WHERE torneo_id = ? AND ronda = 'grupos' AND grupo = ? AND estado = 'finalizado'`
  ).all(torneoId, grupo)
  if (partidos.length < 6) return null
  const catRows = db.prepare(
    `SELECT codigo, nombre FROM mundial_equipos_catalogo WHERE torneo_id = ? AND grupo = ? AND activo = 1`
  ).all(torneoId, grupo)
  // Construimos los stats con la MISMA shape que calcularStats emite (gf_grupos,
  // gc_grupos, etc.) para poder reusar compararEquiposGrupo y NO duplicar el
  // criterio de desempate. Si mañana se agrega head-to-head o fair play a la
  // tabla de grupos, esto se beneficia automáticamente.
  const stats = new Map()
  for (const e of catRows) stats.set(e.codigo, {
    codigo: e.codigo, nombre: e.nombre,
    g: 0, e: 0, p: 0,
    gf_grupos: 0, gc_grupos: 0,
    amarillas: 0, rojas: 0,
  })
  for (const p of partidos) {
    const L = stats.get(p.equipo_local), V = stats.get(p.equipo_visitante)
    if (!L || !V) continue
    L.gf_grupos += p.goles_local; L.gc_grupos += p.goles_visitante
    V.gf_grupos += p.goles_visitante; V.gc_grupos += p.goles_local
    L.amarillas += p.amarillas_local || 0; L.rojas += p.rojas_local || 0
    V.amarillas += p.amarillas_visitante || 0; V.rojas += p.rojas_visitante || 0
    if (p.goles_local > p.goles_visitante) { L.g++; V.p++ }
    else if (p.goles_local < p.goles_visitante) { V.g++; L.p++ }
    else { L.e++; V.e++ }
  }
  const arr = [...stats.values()].sort((a, b) => compararEquiposGrupo(a, b, partidos))
  return arr[posicion - 1]?.codigo || null
}

function gruposDelTorneo(db, torneoId) {
  return db.prepare(
    `SELECT DISTINCT grupo FROM mundial_equipos_catalogo WHERE torneo_id = ? AND grupo IS NOT NULL AND activo = 1 ORDER BY grupo`
  ).all(torneoId).map(r => r.grupo)
}

function todosGruposCompletos(db, torneoId) {
  const grupos = gruposDelTorneo(db, torneoId)
  if (grupos.length === 0) return false
  return grupos.every(g => grupoCompleto(db, torneoId, g))
}

function calcularAsignacionTerceros(db, torneoId) {
  if (!todosGruposCompletos(db, torneoId)) return null
  const grupos = gruposDelTorneo(db, torneoId)
  const tercerosRows = []
  for (const g of grupos) {
    const codigo = equipoEnPosicionGrupo(db, torneoId, g, 3)
    if (!codigo) continue
    const eq = db.prepare(
      `SELECT codigo, nombre FROM mundial_equipos_catalogo WHERE torneo_id = ? AND codigo = ? AND activo = 1`
    ).get(torneoId, codigo)
    const ps = db.prepare(
      `SELECT * FROM mundial_partidos WHERE torneo_id = ? AND ronda = 'grupos' AND grupo = ? AND estado = 'finalizado'
       AND (equipo_local = ? OR equipo_visitante = ?)`
    ).all(torneoId, g, codigo, codigo)
    let pts = 0, gf = 0, gc = 0, amarillas = 0, rojas = 0
    for (const p of ps) {
      const esLocal = p.equipo_local === codigo
      const mGf = esLocal ? p.goles_local : p.goles_visitante
      const mGc = esLocal ? p.goles_visitante : p.goles_local
      gf += mGf; gc += mGc
      if (mGf > mGc) pts += 3
      else if (mGf === mGc) pts += 1
      amarillas += (esLocal ? p.amarillas_local : p.amarillas_visitante) || 0
      rojas     += (esLocal ? p.rojas_local     : p.rojas_visitante)     || 0
    }
    tercerosRows.push({ grupo: g, equipo_codigo: codigo, nombre: eq?.nombre || codigo, pts, dg: gf - gc, gf, gc, amarillas, rojas })
  }
  tercerosRows.sort(compararTerceros)
  const top8 = tercerosRows.slice(0, 8)
  const grupos8 = top8.map(r => r.grupo).sort()
  if (grupos8.length !== 8) return null
  const comboKey = grupos8.join('-')
  const asignacion = MATRIZ_TERCEROS[comboKey] || null
  if (!asignacion) {
    console.warn(`[bracket] combo de terceros NO encontrada en matriz: ${comboKey} (torneo ${torneoId})`)
  }
  let slotEquipos = null
  if (asignacion) {
    slotEquipos = {}
    for (const [slot, codTercero] of Object.entries(asignacion)) {
      const grupoLetra = codTercero[1]
      const row = tercerosRows.find(r => r.grupo === grupoLetra)
      if (!row?.equipo_codigo) {
        console.warn(`[bracket] slot ${slot} (esperaba 3${grupoLetra}) no resuelve a equipo — torneo ${torneoId}, combo ${comboKey}`)
      }
      slotEquipos[slot] = row?.equipo_codigo || null
    }
  }
  return { grupos8, comboKey, asignacion, slotEquipos, tercerosRows }
}

function resolverSlotR32(db, torneoId, slot, terceros) {
  if (slot.tipo === 'pos') {
    return equipoEnPosicionGrupo(db, torneoId, slot.grupo, slot.pos)
  }
  if (slot.tipo === 'third') {
    if (!terceros || !terceros.slotEquipos) return null
    return terceros.slotEquipos[slot.slot] || null
  }
  return null
}

function resolverGanadorKO(p) {
  if (p.estado !== 'finalizado') return null
  if (p.goles_local === null || p.goles_visitante === null) return null
  if (p.goles_local > p.goles_visitante) return { ganador: p.equipo_local, perdedor: p.equipo_visitante }
  if (p.goles_local < p.goles_visitante) return { ganador: p.equipo_visitante, perdedor: p.equipo_local }
  const pl = p.penales_local, pv = p.penales_visitante
  if (Number.isInteger(pl) && Number.isInteger(pv) && pl !== pv) {
    return pl > pv
      ? { ganador: p.equipo_local, perdedor: p.equipo_visitante }
      : { ganador: p.equipo_visitante, perdedor: p.equipo_local }
  }
  return null
}

// ─────────────────────────────────────────────────────────────────────────
// API pública
// ─────────────────────────────────────────────────────────────────────────

function generarR32Incremental(db, torneoId) {
  const terceros = calcularAsignacionTerceros(db, torneoId)
  const ahora = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
  const existentes = db.prepare(
    `SELECT * FROM mundial_partidos WHERE torneo_id = ? AND ronda = '16vos'`
  ).all(torneoId)
  const existByOrden = new Map(existentes.map(p => [p.orden, p]))

  let creados = 0, actualizados = 0
  const pendientes = []

  const insert = db.prepare(`
    INSERT INTO mundial_partidos (torneo_id, ronda, grupo, orden, equipo_local, equipo_visitante, estado, created_at, updated_at)
    VALUES (?, '16vos', NULL, ?, ?, ?, 'pendiente', ?, ?)
  `)
  const update = db.prepare(`
    UPDATE mundial_partidos SET equipo_local = ?, equipo_visitante = ?, updated_at = ?
    WHERE id = ?
  `)

  for (const cruce of R32_BRACKET) {
    const local = resolverSlotR32(db, torneoId, cruce.local, terceros)
    const visit = resolverSlotR32(db, torneoId, cruce.visitante, terceros)
    if (!local || !visit) {
      pendientes.push({ orden: cruce.orden, motivo: !local ? 'local' : 'visitante' })
      continue
    }
    const existente = existByOrden.get(cruce.orden)
    if (!existente) {
      insert.run(torneoId, cruce.orden, local, visit, ahora, ahora)
      creados++
    } else if (existente.equipo_local !== local || existente.equipo_visitante !== visit) {
      update.run(local, visit, ahora, existente.id)
      actualizados++
    }
  }
  return { creados, actualizados, total_R32: 16, pendientes }
}

function generarSiguienteRonda(db, torneoId, rondaActual) {
  const partidos = db.prepare(
    `SELECT * FROM mundial_partidos WHERE torneo_id = ? AND ronda = ?`
  ).all(torneoId, rondaActual)
  const ganadores = new Map()
  const perdedores = new Map()
  for (const p of partidos) {
    const r = resolverGanadorKO(p)
    if (r) { ganadores.set(p.orden, r.ganador); perdedores.set(p.orden, r.perdedor) }
  }

  const reglas = CASCADA_KO.filter(r => {
    if (rondaActual === 'semis') return r.ronda === 'final' || r.ronda === 'tercer_puesto'
    const map = { '16vos': '8vos', '8vos': '4tos', '4tos': 'semis' }
    return r.ronda === map[rondaActual]
  })

  const ahora = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
  const insert = db.prepare(`
    INSERT INTO mundial_partidos (torneo_id, ronda, grupo, orden, equipo_local, equipo_visitante, estado, created_at, updated_at)
    VALUES (?, ?, NULL, ?, ?, ?, 'pendiente', ?, ?)
  `)
  const update = db.prepare(`
    UPDATE mundial_partidos SET equipo_local = ?, equipo_visitante = ?, updated_at = ?
    WHERE id = ?
  `)

  let creados = 0, actualizados = 0
  const pendientes = []
  for (const regla of reglas) {
    const local  = regla.local.lado  === 'ganador'  ? ganadores.get(regla.local.orden)  : perdedores.get(regla.local.orden)
    const visit  = regla.visitante.lado === 'ganador' ? ganadores.get(regla.visitante.orden) : perdedores.get(regla.visitante.orden)
    if (!local || !visit) {
      pendientes.push({ ronda: regla.ronda, orden: regla.orden, motivo: !local ? 'local' : 'visitante' })
      continue
    }
    const existente = db.prepare(
      `SELECT * FROM mundial_partidos WHERE torneo_id = ? AND ronda = ? AND orden = ?`
    ).get(torneoId, regla.ronda, regla.orden)
    if (!existente) {
      insert.run(torneoId, regla.ronda, regla.orden, local, visit, ahora, ahora)
      creados++
    } else if (existente.equipo_local !== local || existente.equipo_visitante !== visit) {
      update.run(local, visit, ahora, existente.id)
      actualizados++
    }
  }
  return { creados, actualizados, pendientes }
}

function avanzarBracketTras(db, torneoId, ronda) {
  if (ronda === 'grupos') return { paso: 'R32', resultado: generarR32Incremental(db, torneoId) }
  if (ronda === '16vos')  return { paso: '8vos', resultado: generarSiguienteRonda(db, torneoId, '16vos') }
  if (ronda === '8vos')   return { paso: '4tos', resultado: generarSiguienteRonda(db, torneoId, '8vos') }
  if (ronda === '4tos')   return { paso: 'semis', resultado: generarSiguienteRonda(db, torneoId, '4tos') }
  if (ronda === 'semis')  return { paso: 'final+tercer_puesto', resultado: generarSiguienteRonda(db, torneoId, 'semis') }
  return { paso: 'noop', resultado: null }
}

module.exports = {
  generarR32Incremental,
  generarSiguienteRonda,
  avanzarBracketTras,
  calcularAsignacionTerceros,
  resolverGanadorKO,
  grupoCompleto,
  todosGruposCompletos,
  equipoEnPosicionGrupo,
  R32_BRACKET,
  CASCADA_KO,
}
