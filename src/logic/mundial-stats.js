/**
 * mundial-stats.js — Sprint Final C3.
 *
 * Cálculo de stats del Mundial a partir del fixture. Módulo PURO:
 * determinístico, recalculable, sin DB adentro, sin cache (misma filosofía
 * que mundial-scoring.js). El SCORING NUNCA usa este módulo: las stats
 * alimentan Datos útiles y sugerencias; el ranking solo cambia cuando el
 * admin guarda mundial_resultados (preview obligatorio).
 *
 * API:
 *   calcularStats({ partidos, catalogo, tarjetasLegacy, topLimit }) → stats
 *
 * Entradas:
 *   - partidos:       filas de mundial_partidos (cualquier estado).
 *   - catalogo:       filas de mundial_equipos_catalogo ACTIVAS
 *                     ({ codigo, nombre, emoji, grupo, confederacion }).
 *   - tarjetasLegacy: filas de mundial_tarjetas_partido (fallback matriz).
 *   - topLimit:       corte por POSICIÓN de los tops (default 5, incluye empatados).
 *
 * Reglas:
 *   - Solo partidos estado='finalizado' cuentan para tabla/goles/tarjetas.
 *   - "Ronda alcanzada" cuenta APARICIÓN en cualquier partido (incluso
 *     pendiente): si el admin cargó el cruce, el equipo llegó a esa ronda.
 *   - Tarjetas: fuente='fixture' si hay >=1 finalizado, sino 'matriz' (legacy).
 *     NULL = no cargada (≠ 0 = no hubo). Se cuentan finalizados con tarjetas
 *     incompletas (alguna de las 4 columnas NULL) como `tarjetas_pendientes`.
 *   - Desempate SIMPLIFICADO y DECLARADO: Pts → DG → GF → alfabético, aislado
 *     en compararEquiposGrupo() / compararTerceros() para poder reemplazarlo
 *     por el criterio FIFA completo (head-to-head, fair play) sin tocar nada
 *     más. NO reemplaza la confirmación oficial: el admin confirma resultados
 *     en el tab Resultados (con preview) — las stats no puntúan nada.
 *
 *   - Formato 2026 (12 grupos de 4): clasifican 1° y 2° de cada grupo + los
 *     8 MEJORES TERCEROS. Reglas de estado:
 *       · grupo incompleto → equipos 'en_juego', tercero 'pendiente'.
 *       · grupo completo   → 1°/2° clasificados; 4° eliminado;
 *         3° según tabla de terceros: 'clasificaria' (top-8 del ranking de
 *         terceros de grupos COMPLETOS) o 'quedaria_afuera'.
 *       · 'quedaria_afuera' es DEFINITIVO aunque falten grupos (sumar más
 *         candidatos solo puede empeorar su ranking) → eliminado.
 *       · 'clasificaria' es PROVISORIO hasta que los 12 grupos estén
 *         completos → el equipo queda 'en_juego' (la tabla de terceros
 *         muestra el detalle); pasa a 'clasificado' cuando el ranking es
 *         definitivo o si aparece en un cruce KO (override práctico).
 *   - Aparición en KO (cualquier estado) confirma clasificación.
 *   - Eliminados en KO: perdedor de KO finalizado (goles, o penales si
 *     empate). Perdedor de semi con 3er puesto a la vista sigue vivo.
 */

const { RONDAS } = require('./mundial-validar-partido')

const RONDA_IDX = new Map(RONDAS.map((r, i) => [r, i]))

function nombreDe(cat, codigo) {
  return cat.get(codigo)?.nombre || codigo
}

/** Top con corte por posición (dense-rank, incluye empatados) — mismo criterio
 *  que calcularTop de tarjetas Fase 2. items: [{ equipo_codigo, total }]. */
function topPorPosicion(items, cat, limit) {
  const conValor = items.filter(t => t.total > 0)
  conValor.sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total
    return nombreDe(cat, a.equipo_codigo).localeCompare(nombreDe(cat, b.equipo_codigo), 'es', { sensitivity: 'base' })
  })
  let pos = 0, prev = null
  const out = []
  for (let i = 0; i < conValor.length; i++) {
    if (prev === null || conValor[i].total !== prev) { pos = i + 1; prev = conValor[i].total }
    if (pos > limit) break
    const m = cat.get(conValor[i].equipo_codigo)
    out.push({
      equipo_codigo: conValor[i].equipo_codigo,
      nombre: m?.nombre || conValor[i].equipo_codigo,
      emoji: m?.emoji || null,
      grupo: m?.grupo || null,
      total: conValor[i].total,
      posicion: pos,
    })
  }
  return out
}

// ── Comparators de posiciones (REEMPLAZABLES) ───────────────────────────────
// Único lugar donde vive el criterio de desempate. Para pasar al criterio
// FIFA completo (head-to-head, fair play, sorteo) alcanza con reescribir
// estas dos funciones; `contexto` ya recibe los partidos del grupo para
// poder implementar head-to-head sin cambiar la firma.

/** Desempate de tabla de grupo. a/b: stats de equipo (gf_grupos, etc.).
 *  SIMPLIFICADO: Pts → DG → GF → alfabético. */
function compararEquiposGrupo(a, b, _contexto) {
  const ptsA = a.g * 3 + a.e, ptsB = b.g * 3 + b.e
  if (ptsB !== ptsA) return ptsB - ptsA
  const dgA = a.gf_grupos - a.gc_grupos, dgB = b.gf_grupos - b.gc_grupos
  if (dgB !== dgA) return dgB - dgA
  if (b.gf_grupos !== a.gf_grupos) return b.gf_grupos - a.gf_grupos
  return (a.nombre || '').localeCompare(b.nombre || '', 'es', { sensitivity: 'base' })
}

/** Ranking de mejores terceros. a/b: filas de la tabla de terceros
 *  ({ pts, dg, gf, amarillas, rojas, nombre }).
 *  Criterios FIFA (orden): Pts → DG → GF → Fair Play (menos sanciones) →
 *  alfabético como último recurso. Fair Play se aproxima como
 *  amarillas + rojas*3 (menor = mejor). No incluye amarilla+roja directa
 *  ni doble amarilla como categorías separadas (datos no disponibles). */
function fairPlayScore(row) {
  return (row?.amarillas || 0) + (row?.rojas || 0) * 3
}
function compararTerceros(a, b) {
  if (b.pts !== a.pts) return b.pts - a.pts
  if (b.dg !== a.dg) return b.dg - a.dg
  if (b.gf !== a.gf) return b.gf - a.gf
  const fpA = fairPlayScore(a), fpB = fairPlayScore(b)
  if (fpA !== fpB) return fpA - fpB  // menor cantidad de sanciones gana
  return (a.nombre || '').localeCompare(b.nombre || '', 'es', { sensitivity: 'base' })
}

const NOTA_DESEMPATE = 'Cálculo preliminar (Pts → DG → GF → Fair Play → alfabético). ' +
  'Fair Play aproximado por amarillas + rojas×3. No reemplaza el criterio oficial FIFA ' +
  'ni la confirmación del admin en Resultados.'

/** Ganador/perdedor de un KO finalizado: goles, sino penales, sino null. */
function resolverKO(p) {
  if (p.goles_local === null || p.goles_visitante === null) return null
  if (p.goles_local > p.goles_visitante) return { ganador: p.equipo_local, perdedor: p.equipo_visitante }
  if (p.goles_local < p.goles_visitante) return { ganador: p.equipo_visitante, perdedor: p.equipo_local }
  const pl = p.penales_local, pv = p.penales_visitante
  if (Number.isInteger(pl) && Number.isInteger(pv) && pl !== pv) {
    return pl > pv
      ? { ganador: p.equipo_local, perdedor: p.equipo_visitante }
      : { ganador: p.equipo_visitante, perdedor: p.equipo_local }
  }
  return null // empate sin penales cargados → indefinido
}

function calcularStats({ partidos = [], catalogo = [], tarjetasLegacy = [], topLimit = 5 }) {
  const cat = new Map(catalogo.map(e => [e.codigo, e]))
  const finalizados = partidos.filter(p => p.estado === 'finalizado')
  const finalizadosGrupos = finalizados.filter(p => p.ronda === 'grupos')

  // ── stats por equipo (init con TODO el catálogo, para tablas completas) ──
  const eq = new Map()
  for (const e of catalogo) {
    eq.set(e.codigo, {
      equipo_codigo: e.codigo, nombre: e.nombre, emoji: e.emoji || null,
      grupo: e.grupo || null, confederacion: e.confederacion || null,
      pj: 0, g: 0, e: 0, p: 0,
      gf_total: 0, gc_total: 0, gf_grupos: 0, gc_grupos: 0,
      amarillas: 0, rojas: 0,
      ronda_alcanzada: e.grupo ? 'grupos' : null,
      estado: 'en_juego', eliminado_en: null, clasificado_grupos: false,
    })
  }
  const get = (c) => {
    if (!eq.has(c)) {
      // Equipo fuera de catálogo activo (no debería pasar: el endpoint valida).
      eq.set(c, {
        equipo_codigo: c, nombre: c, emoji: null, grupo: null, confederacion: null,
        pj: 0, g: 0, e: 0, p: 0, gf_total: 0, gc_total: 0, gf_grupos: 0, gc_grupos: 0,
        amarillas: 0, rojas: 0, ronda_alcanzada: null, estado: 'en_juego',
        eliminado_en: null, clasificado_grupos: false,
      })
    }
    return eq.get(c)
  }

  // ── goles y resultados (solo finalizados) ──
  for (const p of finalizados) {
    const L = get(p.equipo_local), V = get(p.equipo_visitante)
    const gl = p.goles_local ?? 0, gv = p.goles_visitante ?? 0
    L.gf_total += gl; L.gc_total += gv
    V.gf_total += gv; V.gc_total += gl
    if (p.ronda === 'grupos') {
      L.gf_grupos += gl; L.gc_grupos += gv
      V.gf_grupos += gv; V.gc_grupos += gl
      L.pj++; V.pj++
      if (gl > gv) { L.g++; V.p++ }
      else if (gl < gv) { V.g++; L.p++ }
      else { L.e++; V.e++ }
    }
  }

  // ── ronda alcanzada: aparición en CUALQUIER partido (cualquier estado) ──
  for (const p of partidos) {
    for (const c of [p.equipo_local, p.equipo_visitante]) {
      const s = get(c)
      const idx = RONDA_IDX.get(p.ronda) ?? 0
      const cur = s.ronda_alcanzada ? (RONDA_IDX.get(s.ronda_alcanzada) ?? 0) : -1
      if (idx > cur) s.ronda_alcanzada = p.ronda
    }
  }

  // ── tarjetas: fuente fixture o matriz legacy ──
  const fuente_tarjetas = finalizados.length > 0 ? 'fixture' : 'matriz'
  let tarjetas_pendientes = 0
  if (fuente_tarjetas === 'fixture') {
    for (const p of finalizados) {
      if (p.amarillas_local === null || p.amarillas_visitante === null ||
          p.rojas_local === null || p.rojas_visitante === null) {
        tarjetas_pendientes++
      }
      get(p.equipo_local).amarillas      += p.amarillas_local ?? 0
      get(p.equipo_local).rojas          += p.rojas_local ?? 0
      get(p.equipo_visitante).amarillas  += p.amarillas_visitante ?? 0
      get(p.equipo_visitante).rojas      += p.rojas_visitante ?? 0
    }
  } else {
    for (const t of tarjetasLegacy) {
      get(t.equipo_codigo).amarillas += t.amarillas || 0
      get(t.equipo_codigo).rojas     += t.rojas || 0
    }
  }

  // ── tabla de grupos ──
  const grupos = [...new Set(catalogo.filter(e => e.grupo).map(e => e.grupo))].sort()
  const tabla_grupos = grupos.map(grupo => {
    const equiposG = [...eq.values()].filter(s => s.grupo === grupo)
    const n = equiposG.length
    const total_partidos = (n * (n - 1)) / 2
    const jugados = finalizadosGrupos.filter(p => p.grupo === grupo).length
    const contexto = { partidos: finalizadosGrupos.filter(p => p.grupo === grupo) }
    const orden = [...equiposG].sort((a, b) => compararEquiposGrupo(a, b, contexto))
    return {
      grupo,
      completo: total_partidos > 0 && jugados >= total_partidos,
      jugados,
      total_partidos,
      equipos: orden.map((s, i) => ({
        posicion: i + 1,
        equipo_codigo: s.equipo_codigo, nombre: s.nombre, emoji: s.emoji,
        pj: s.pj, g: s.g, e: s.e, p: s.p,
        gf: s.gf_grupos, gc: s.gc_grupos, dg: s.gf_grupos - s.gc_grupos,
        pts: s.g * 3 + s.e,
      })),
    }
  })

  // ── empates por grupo ──
  const empates_por_grupo = grupos.map(grupo => ({
    grupo,
    empates: finalizadosGrupos.filter(p => p.grupo === grupo && (p.goles_local ?? 0) === (p.goles_visitante ?? 0)).length,
  }))
  const empates_total = empates_por_grupo.reduce((a, g) => a + g.empates, 0)

  // ── clasificados / eliminados / campeón ──
  // 1) aparición en KO (cualquier estado) → clasificado de grupos (override
  //    práctico: si el admin cargó el cruce, el equipo pasó, aunque el
  //    ranking simplificado de terceros no lo detecte).
  for (const p of partidos) {
    if (p.ronda !== 'grupos') {
      get(p.equipo_local).clasificado_grupos = true
      get(p.equipo_visitante).clasificado_grupos = true
    }
  }

  // 2) Tabla de TERCEROS (formato 2026: clasifican los 8 mejores 3°).
  //    Una fila por grupo: definitiva si el grupo está completo, 'pendiente'
  //    (provisional, con el 3° actual) si no. El ranking solo considera
  //    terceros de grupos COMPLETOS.
  const gruposCompletos = tabla_grupos.filter(tg => tg.completo).length
  const tercerosDefinitivo = grupos.length > 0 && gruposCompletos === grupos.length
  const tercerosRows = []
  for (const tg of tabla_grupos) {
    const t3 = tg.equipos[2] // posición 3 (puede no existir si el grupo tiene <3 equipos)
    if (!t3) continue
    const s = get(t3.equipo_codigo)
    tercerosRows.push({
      grupo: tg.grupo,
      equipo_codigo: t3.equipo_codigo, nombre: s.nombre, emoji: s.emoji,
      pj: t3.pj, pts: t3.pts, dg: t3.dg, gf: t3.gf, gc: t3.gc,
      amarillas: s.amarillas, rojas: s.rojas,
      grupo_completo: tg.completo,
      estado: tg.completo ? null : 'pendiente', // null → se asigna por ranking
    })
  }
  const candidatos = tercerosRows.filter(r => r.grupo_completo).sort(compararTerceros)
  candidatos.forEach((r, i) => {
    r.ranking = i + 1
    r.estado = i < 8 ? 'clasificaria' : 'quedaria_afuera'
  })
  // Los pendientes también se ordenan con el mismo criterio (Pts → DG → GF →
  // Fair Play → alfabético) para que la tabla sea consistente y útil incluso
  // mientras hay grupos sin terminar. No tienen ranking ni estado clasif/afuera
  // hasta que el grupo se complete.
  const pendientes = tercerosRows.filter(r => !r.grupo_completo).sort(compararTerceros)
  const terceros = {
    definitivo: tercerosDefinitivo,
    grupos_completos: gruposCompletos,
    total_grupos: grupos.length,
    cupos: 8,
    items: [
      ...candidatos,
      ...pendientes,
    ],
  }

  // 3) Estados por grupo completo:
  //    1°/2° → clasificados. 4° → eliminado. 3° → según terceros:
  //    'quedaria_afuera' es definitivo aunque falten grupos (más candidatos
  //    solo empeoran su ranking) → eliminado. 'clasificaria' recién marca
  //    clasificado cuando el ranking es definitivo (12/12) — antes queda
  //    en juego (o lo confirma la aparición en KO del paso 1).
  for (const tg of tabla_grupos) {
    if (!tg.completo) continue
    tg.equipos.forEach((e2, i) => {
      const s = get(e2.equipo_codigo)
      if (i < 2) { s.clasificado_grupos = true; return }
      if (i === 2) {
        const row = terceros.items.find(r => r.equipo_codigo === e2.equipo_codigo)
        if (row?.estado === 'clasificaria' && tercerosDefinitivo) s.clasificado_grupos = true
        if (row?.estado === 'quedaria_afuera' && !s.clasificado_grupos) {
          s.estado = 'eliminado'; s.eliminado_en = 'grupos'
        }
        return
      }
      if (!s.clasificado_grupos) { s.estado = 'eliminado'; s.eliminado_en = 'grupos' }
    })
  }
  // 3) KO finalizados → perdedor eliminado (con matices de semis/3er puesto/final).
  const koFinalizados = finalizados
    .filter(p => p.ronda !== 'grupos')
    .sort((a, b) => (RONDA_IDX.get(a.ronda) ?? 0) - (RONDA_IDX.get(b.ronda) ?? 0))
  const hayTercerPuestoPara = (codigo) =>
    partidos.some(p => p.ronda === 'tercer_puesto' && (p.equipo_local === codigo || p.equipo_visitante === codigo))
  let campeon = null
  for (const p of koFinalizados) {
    const r = resolverKO(p)
    if (!r) continue // empate sin penales → indefinido, no se asigna nada
    const perd = get(r.perdedor)
    if (p.ronda === 'final') {
      campeon = r.ganador
      get(r.ganador).estado = 'campeon'
      perd.estado = 'eliminado'; perd.eliminado_en = 'final'
    } else if (p.ronda === 'tercer_puesto') {
      get(r.ganador).estado = 'eliminado'; get(r.ganador).eliminado_en = 'tercer_puesto'
      perd.estado = 'eliminado'; perd.eliminado_en = 'tercer_puesto'
    } else if (p.ronda === 'semis' && hayTercerPuestoPara(r.perdedor)) {
      // pierde la semi pero juega el 3er puesto → sigue en juego
    } else {
      perd.estado = 'eliminado'; perd.eliminado_en = p.ronda
    }
  }

  const equipos = [...eq.values()].sort((a, b) =>
    (a.nombre || '').localeCompare(b.nombre || '', 'es', { sensitivity: 'base' }))
  for (const s of equipos) {
    if (s.estado === 'en_juego' && s.clasificado_grupos) s.estado = 'clasificado'
  }

  // ── tops ──
  const tops = {
    goleadores_grupos: topPorPosicion(equipos.map(s => ({ equipo_codigo: s.equipo_codigo, total: s.gf_grupos })), cat, topLimit),
    goleados_grupos:   topPorPosicion(equipos.map(s => ({ equipo_codigo: s.equipo_codigo, total: s.gc_grupos })), cat, topLimit),
    amarillas:         topPorPosicion(equipos.map(s => ({ equipo_codigo: s.equipo_codigo, total: s.amarillas })), cat, topLimit),
    rojas:             topPorPosicion(equipos.map(s => ({ equipo_codigo: s.equipo_codigo, total: s.rojas })), cat, topLimit),
  }

  return {
    tabla_grupos,
    terceros,
    empates_por_grupo,
    empates_total,
    equipos,
    tops,
    clasificados: equipos.filter(s => s.clasificado_grupos).map(s => s.equipo_codigo),
    eliminados: equipos.filter(s => s.estado === 'eliminado')
      .map(s => ({ equipo_codigo: s.equipo_codigo, eliminado_en: s.eliminado_en })),
    campeon,
    tarjetas: { fuente: fuente_tarjetas, pendientes: tarjetas_pendientes },
    nota_desempate: NOTA_DESEMPATE,
  }
}

module.exports = { calcularStats, compararEquiposGrupo, compararTerceros, RONDA_IDX }
