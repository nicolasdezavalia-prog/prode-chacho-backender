/**
 * mundial-sugerencias.js — Sprint Final C7.
 *
 * Sugerencias de resultado para Admin → Resultados, derivadas de:
 *   - stats del fixture (mundial-stats.js),
 *   - mundial_goleadores,
 *   - mundial_premios_individuales,
 *   - canonización B2 (solo para precargar alias en preguntas de texto).
 *
 * Módulo PURO. REGLAS DURAS:
 *   - NO escribe nada. NO toca scoring/ranking/respuestas/resultados.
 *   - La sugerencia solo PRECARGA el editor: el guardado sigue siendo el
 *     flujo existente Guardar → Preview impacto → Confirmar.
 *   - Mapeo EXPLÍCITO por `numero` de pregunta (seed mundial-2026), con
 *     guarda de tipo: si el numero no matchea el tipo esperado → sin
 *     sugerencia (falla en silencio seguro, p.ej. preguntas editadas).
 *   - Empate en un top → `candidatos[]` + `requiere_decision` (valor null).
 *   - Dato incompleto → `completo:false` + detalle (el admin decide).
 *
 * SIN sugerencia (decidido, no inventar):
 *   - #3 Tercero / #4 Cuarto: stats no distingue 3° de 4° (ambos terminan
 *     "tercer_puesto"); se deriva fácil a futuro si hace falta.
 *   - #8 Fair Play: premio a equipo sin fuente estructurada (se carga a mano).
 *   - #9 Último del Mundial: criterio no modelado (peor equipo del torneo,
 *     empates masivos en fase de grupos, se decide a mano).
 *
 * Feature A sugerencia-eliminados (2026-06-27):
 *   - #32/33/34 (multi_equipo "eliminados en 16°/8°/4°") YA TIENEN sugerencia.
 *     Ahora el admin puede cargar los N eliminados reales (M > cfg.n_equipos)
 *     porque quitamos el enforce del validator. La sugerencia lista todos los
 *     equipos eliminados en esa ronda hasta hoy — completo=false mientras
 *     la ronda esté en curso.
 */

const { normalizarTexto } = require('./mundial-scoring')

// Posiciones de grupo: numero → { grupo, posicion } (1 = ganador).
const POSICIONES_GRUPO = {
  19: { grupo: 'A', posicion: 2 },
  20: { grupo: 'A', posicion: 3 },
  21: { grupo: 'B', posicion: 4 },
  23: { grupo: 'D', posicion: 1 },
  24: { grupo: 'E', posicion: 2 },
  25: { grupo: 'F', posicion: 2 },
  26: { grupo: 'G', posicion: 3 },
  27: { grupo: 'H', posicion: 3 },
  28: { grupo: 'I', posicion: 2 },
}

// Rondas del fixture en orden cronológico SIN tercer_puesto, para mapear
// POSICIONALMENTE contra cfg.instancias (["Grupos","16°","8°","4°","Semis",
// "Final"]). tercer_puesto se mapea al índice de semis (perdió la semi).
const RONDAS_POSICIONALES = ['grupos', '16vos', '8vos', '4tos', 'semis', 'final']

// Rondas ordenadas por PRESTIGIO ascendente para "Mejor equipo AFC" (P10).
// tercer_puesto > semis: jugarlo implica haber pasado semis.
// Campeón queda por encima de "final" (se resuelve aparte con estado==='campeon').
const RONDAS_PRESTIGIO = ['grupos', '16vos', '8vos', '4tos', 'semis', 'tercer_puesto', 'final']

function nombreEquipo(catalogo, codigo) {
  const e = catalogo.find(x => x.codigo === codigo)
  return e ? `${e.emoji ? e.emoji + ' ' : ''}${e.nombre}` : codigo
}

/** Busca el código de un equipo por NOMBRE normalizado (evita hardcodear
 *  códigos del catálogo, que pueden variar entre torneos). */
function codigoPorNombre(catalogo, nombre) {
  const n = normalizarTexto(nombre)
  const hit = catalogo.find(e => normalizarTexto(e.nombre) === n)
  return hit ? hit.codigo : null
}

/** Alias para una sugerencia de texto, desde la canonización B2: variantes
 *  agrupadas bajo un canónico que coincide (normalizado) con el jugador. */
function aliasDesdeCanonizacion(canonMap, jugador) {
  if (!canonMap || canonMap.size === 0) return []
  const objetivo = normalizarTexto(jugador)
  const alias = []
  for (const [varianteNorm, canonico] of canonMap.entries()) {
    if (normalizarTexto(canonico) === objetivo && varianteNorm !== objetivo) {
      alias.push(varianteNorm)
    }
  }
  return alias
}

function sugTexto({ pregunta, fuente, jugador, detalle, completo, canonMap }) {
  const valor = { texto: jugador, texto_display: jugador }
  const alias = aliasDesdeCanonizacion(canonMap, jugador)
  if (alias.length > 0) valor.alias = alias
  return base(pregunta, fuente, valor, jugador, completo, detalle +
    (alias.length > 0 ? ` · ${alias.length} alias precargados desde canonización` : ''))
}

function base(pregunta, fuente, valor, valor_display, completo, detalle, extra = {}) {
  return {
    pregunta_id: pregunta.id,
    numero: pregunta.numero,
    tipo_pregunta: pregunta.tipo_pregunta,
    fuente,
    valor,
    valor_display,
    completo: !!completo,
    detalle: detalle || '',
    ...extra,
  }
}

function empate(pregunta, fuente, candidatos, completo, detalle) {
  return base(pregunta, fuente, null, `${candidatos.length} candidatos empatados`, completo,
    detalle + ' · empate: requiere decisión del admin',
    { candidatos, requiere_decision: true })
}

/** Top de equipos por métrica con manejo de empate. items: [{codigo, total}] ya >0. */
function sugerenciaTopEquipo(pregunta, items, catalogo, completo, etiqueta) {
  if (items.length === 0) return null
  const max = Math.max(...items.map(i => i.total))
  const lideres = items.filter(i => i.total === max)
  const detalle = `${etiqueta}: ${max}`
  if (lideres.length === 1) {
    return base(pregunta, 'fixture', { equipo: lideres[0].codigo },
      nombreEquipo(catalogo, lideres[0].codigo), completo, detalle)
  }
  // Sprint aliases (2026-06-25): empate → devolvemos el valor LISTO para usar
  // como resultado con { equipo: primer_lider, aliases: [resto] }. El admin
  // confirma con un click (mismo flujo que sin empate). El display agrupa los
  // nombres con " / " para que se vea en la card. La proyeccion ya manejaba
  // empates sin esto; ahora el resultado oficial tambien.
  const principal = lideres[0].codigo
  const aliases = lideres.slice(1).map(l => l.codigo)
  const displayLideres = lideres.map(l => nombreEquipo(catalogo, l.codigo)).join(' / ')
  return base(
    pregunta, 'fixture',
    { equipo: principal, aliases },
    displayLideres,
    completo,
    detalle + ` · empate de ${lideres.length}: todos los empatados cobran`,
    { candidatos: lideres.map(l => ({ valor: { equipo: l.codigo }, valor_display: nombreEquipo(catalogo, l.codigo) })) }
  )
}

/**
 * @param preguntas  filas de mundial_preguntas activas (config_json parseado en `cfg`).
 * @param stats      salida de calcularStats (o null si no hay fixture).
 * @param goleadores filas de mundial_goleadores.
 * @param premios    filas de mundial_premios_individuales.
 * @param canonizacionPorPregunta Map(pregunta_id → Map(variante_norm → canonico)).
 * @param catalogo   catálogo activo [{codigo, nombre, emoji, grupo, confederacion}].
 */
function calcularSugerencias({ preguntas = [], stats = null, goleadores = [], premios = [], canonizacionPorPregunta = new Map(), catalogo = [] }) {
  const out = []
  const eqStats = (codigo) => stats?.equipos?.find(e => e.equipo_codigo === codigo) || null
  const gruposCompletos = stats?.terceros?.grupos_completos ?? 0
  const totalGrupos = stats?.terceros?.total_grupos ?? 0
  const todosCompletos = totalGrupos > 0 && gruposCompletos === totalGrupos
  const grupoCompleto = (g) => !!stats?.tabla_grupos?.find(t => t.grupo === g)?.completo
  const hayFinalizados = (stats?.equipos || []).some(e => e.pj > 0 || e.gf_total > 0 || e.gc_total > 0)

  // Premios por pregunta_id linkeado (prioridad) y por tipo (fallback 6/7).
  const premioPorPregunta = new Map()
  for (const p of premios) {
    if (p.pregunta_id && p.jugador) premioPorPregunta.set(p.pregunta_id, p)
  }
  const premioPorTipo = new Map(premios.filter(p => p.jugador).map(p => [p.premio, p]))
  const FALLBACK_PREMIO = { 6: 'balon_oro', 7: 'guante_oro' }

  for (const pregunta of preguntas) {
    const { numero, tipo_pregunta: tipo, cfg } = pregunta
    const canonMap = canonizacionPorPregunta.get(pregunta.id)

    // ── Goleador (#5) ──
    if (numero === 5 && tipo === 'respuesta_manual') {
      if (goleadores.length === 0) continue
      const max = Math.max(...goleadores.map(g => g.goles))
      if (max <= 0) continue
      const lideres = goleadores.filter(g => g.goles === max)
      const detalle = `máximo: ${max} goles (tabla de goleadores)`
      if (lideres.length === 1) {
        out.push(sugTexto({ pregunta, fuente: 'goleadores', jugador: lideres[0].jugador, detalle, completo: false, canonMap }))
      } else {
        out.push(empate(pregunta, 'goleadores',
          lideres.map(l => {
            const v = { texto: l.jugador, texto_display: l.jugador }
            const a = aliasDesdeCanonizacion(canonMap, l.jugador)
            if (a.length > 0) v.alias = a
            return { valor: v, valor_display: l.jugador }
          }), false, detalle))
      }
      continue
    }

    // ── Balón/Guante de Oro (#6/#7) — premios individuales ──
    if ((numero === 6 || numero === 7) && tipo === 'respuesta_manual') {
      const premio = premioPorPregunta.get(pregunta.id) ||
        premioPorTipo.get(FALLBACK_PREMIO[numero])
      if (!premio) continue
      out.push(sugTexto({
        pregunta, fuente: 'premios_individuales', jugador: premio.jugador,
        detalle: `${premio.titulo}${premio.equipo_codigo ? ' · ' + nombreEquipo(catalogo, premio.equipo_codigo) : ''}`,
        completo: true, canonMap,
      }))
      continue
    }

    if (!stats || !hayFinalizados) continue // el resto deriva del fixture

    // ── Campeón / Subcampeón (#1/#2) ──
    if (numero === 1 && tipo === 'equipo_categoria' && stats.campeon) {
      out.push(base(pregunta, 'fixture', { equipo: stats.campeon },
        nombreEquipo(catalogo, stats.campeon), true, 'ganador de la final'))
      continue
    }
    if (numero === 2 && tipo === 'equipo_categoria') {
      const sub = (stats.eliminados || []).find(e => e.eliminado_en === 'final')
      if (sub) {
        out.push(base(pregunta, 'fixture', { equipo: sub.equipo_codigo },
          nombreEquipo(catalogo, sub.equipo_codigo), true, 'perdedor de la final'))
      }
      continue
    }

    // ── Instancia de eliminación (#11-16) — mapeo POSICIONAL contra cfg.instancias ──
    if (tipo === 'instancia_eliminacion' && Array.isArray(cfg.instancias) && cfg.instancias.length === RONDAS_POSICIONALES.length) {
      const s = cfg.equipo ? eqStats(cfg.equipo) : null
      if (s && s.estado === 'eliminado' && s.eliminado_en) {
        const ronda = s.eliminado_en === 'tercer_puesto' ? 'semis' : s.eliminado_en
        const idx = RONDAS_POSICIONALES.indexOf(ronda)
        if (idx >= 0) {
          const instancia = cfg.instancias[idx]
          out.push(base(pregunta, 'fixture', { instancia }, instancia, true,
            `${nombreEquipo(catalogo, cfg.equipo)} eliminado en ${ronda} (mapeo posicional de instancias)`))
        }
      }
      continue
    }

    // ── Mejor equipo asiático (#10) — equipo_categoria ─────────────────
    // Feature Mejor AFC (2026-07-03): tomamos el/los equipos AFC que
    // llegaron más lejos según ronda_alcanzada (con campeón como top).
    // sugerenciaTopEquipo() ya empaqueta empates como { equipo: X,
    // aliases: [Y,Z,...] } — el scoring premia a quien haya puesto
    // CUALQUIERA de los empatados. completo:true solo si NO quedan AFC
    // en juego (podría subir la vara).
    if (numero === 10 && tipo === 'equipo_categoria') {
      const afc = (stats.equipos || []).filter(e => e.confederacion === 'AFC')
      if (afc.length === 0) continue
      const prestigioDe = (e) => e.estado === 'campeon'
        ? RONDAS_PRESTIGIO.length
        : RONDAS_PRESTIGIO.indexOf(e.ronda_alcanzada)
      const items = afc
        .map(e => ({ codigo: e.equipo_codigo, total: prestigioDe(e) }))
        .filter(i => i.total >= 0)
      if (items.length === 0) continue
      const vivos = afc.filter(e => e.estado === 'en_juego').length
      const completo = vivos === 0
      const extra = vivos > 0 ? ` (quedan ${vivos} AFC en juego, puede cambiar)` : ''
      const s = sugerenciaTopEquipo(pregunta, items, catalogo, completo,
        `equipo AFC que llegó más lejos${extra}`)
      if (s) out.push(s)
      continue
    }

    // ── Más goleador / más goleado en grupos (#17/#18) ──
    if ((numero === 17 || numero === 18) && tipo === 'equipo_categoria') {
      const campo = numero === 17 ? 'gf_grupos' : 'gc_grupos'
      const items = (stats.equipos || []).filter(e => e[campo] > 0).map(e => ({ codigo: e.equipo_codigo, total: e[campo] }))
      const s = sugerenciaTopEquipo(pregunta, items, catalogo, todosCompletos,
        `${numero === 17 ? 'más goles a favor' : 'más goles en contra'} en grupos (${gruposCompletos}/${totalGrupos} grupos completos)`)
      if (s) out.push(s)
      continue
    }

    // ── Posiciones de grupo (#19-28 salvo 22) ──
    if (POSICIONES_GRUPO[numero] && tipo === 'equipo_categoria') {
      const { grupo, posicion } = POSICIONES_GRUPO[numero]
      const tg = stats.tabla_grupos?.find(t => t.grupo === grupo)
      if (!tg || tg.jugados === 0) continue
      const fila = tg.equipos[posicion - 1]
      if (!fila) continue
      out.push(base(pregunta, 'fixture', { equipo: fila.equipo_codigo },
        nombreEquipo(catalogo, fila.equipo_codigo), tg.completo,
        `posición ${posicion} del grupo ${grupo} (${tg.jugados}/${tg.total_partidos} jugados, desempate simplificado)`))
      continue
    }

    // ── Haití suma puntos (#22) ──
    if (numero === 22 && tipo === 'opcion_unica' && Array.isArray(cfg.opciones)) {
      const codigo = codigoPorNombre(catalogo, 'Haití')
      const s = codigo ? eqStats(codigo) : null
      if (!s || s.pj === 0) continue
      const pts = s.g * 3 + s.e
      const opcionSi = cfg.opciones.find(o => normalizarTexto(o) === 'si')
      const opcionNo = cfg.opciones.find(o => normalizarTexto(o) === 'no')
      if (!opcionSi || !opcionNo) continue
      if (pts > 0) {
        out.push(base(pregunta, 'fixture', { opcion: opcionSi }, opcionSi, true, `Haití ya sumó ${pts} punto(s)`))
      } else {
        out.push(base(pregunta, 'fixture', { opcion: opcionNo }, opcionNo,
          grupoCompleto(s.grupo), `Haití con 0 puntos (${s.pj} jugados)`))
      }
      continue
    }

    // ── Goles recibidos por Argentina en grupos (#29) ──
    if (numero === 29 && tipo === 'numero_por_banda') {
      const codigo = codigoPorNombre(catalogo, 'Argentina')
      const s = codigo ? eqStats(codigo) : null
      if (!s || s.pj === 0) continue
      out.push(base(pregunta, 'fixture', { numero: s.gc_grupos }, String(s.gc_grupos),
        grupoCompleto(s.grupo), `GC de Argentina en grupos: ${s.gc_grupos} (${s.pj} jugados${grupoCompleto(s.grupo) ? ', grupo completo' : ''})`))
      continue
    }

    // ── Empates en grupo K (#30) ──
    if (numero === 30 && tipo === 'numero_exacto') {
      const fila = stats.empates_por_grupo?.find(g => g.grupo === 'K')
      const tg = stats.tabla_grupos?.find(t => t.grupo === 'K')
      if (!fila || !tg || tg.jugados === 0) continue
      out.push(base(pregunta, 'fixture', { numero: fila.empates }, String(fila.empates),
        tg.completo, `empates en el grupo K: ${fila.empates} (${tg.jugados}/${tg.total_partidos} jugados)`))
      continue
    }

    // ── Goles de Panamá (#31) ──
    if (numero === 31 && tipo === 'numero_por_banda') {
      const codigo = codigoPorNombre(catalogo, 'Panamá')
      const s = codigo ? eqStats(codigo) : null
      if (!s || (s.pj === 0 && s.gf_total === 0)) continue
      const terminado = s.estado === 'eliminado'
      out.push(base(pregunta, 'fixture', { numero: s.gf_total }, String(s.gf_total),
        terminado, `goles de Panamá en el torneo: ${s.gf_total}${terminado ? ' (eliminado: definitivo)' : ' (sigue en juego)'}`))
      continue
    }

    // ── Eliminados en 16°/8°/4° (#32/#33/#34) — multi_equipo ─────────────
    // Feature A sugerencia-eliminados (2026-06-27): sugerimos los equipos
    // realmente eliminados en cada ronda a partir de stats.eliminados.
    if ((numero === 32 || numero === 33 || numero === 34) && tipo === 'multi_equipo') {
      const ronda = numero === 32 ? '16vos' : numero === 33 ? '8vos' : '4tos'
      const elim = (stats.eliminados || []).filter(e => e.eliminado_en === ronda)
      if (elim.length === 0) continue
      const equipos = elim.map(e => e.equipo_codigo)
      const totalRondaEsperado = numero === 32 ? 16 : numero === 33 ? 8 : 4
      const completo = equipos.length >= totalRondaEsperado
      const display = elim.map(e => nombreEquipo(catalogo, e.equipo_codigo)).join(' / ')
      const detalle = completo
        ? equipos.length + ' equipos eliminados en ' + ronda + ' (ronda cerrada)'
        : equipos.length + '/' + totalRondaEsperado + ' eliminados en ' + ronda + ' - ronda en curso, volve cuando termine'
      out.push(base(pregunta, 'fixture', { equipos }, display, completo, detalle))
      continue
    }

    // ── Más amarillas / más rojas (#35/#36) — equipo_categoria scoring_manual ──
    if ((numero === 35 || numero === 36) && tipo === 'equipo_categoria') {
      const campo = numero === 35 ? 'amarillas' : 'rojas'
      const items = (stats.equipos || []).filter(e => e[campo] > 0).map(e => ({ codigo: e.equipo_codigo, total: e[campo] }))
      const completo = todosCompletos && (stats.tarjetas?.pendientes ?? 0) === 0
      const s = sugerenciaTopEquipo(pregunta, items, catalogo, completo,
        `${campo} (fuente: ${stats.tarjetas?.fuente || '?'}${stats.tarjetas?.pendientes ? `, ${stats.tarjetas.pendientes} partidos con tarjetas sin cargar` : ''})`)
      if (s) {
        if (cfg.scoring_manual === true) {
          s.detalle += ' · ⚠ pregunta de scoring manual: la sugerencia completa el equipo; los puntos por usuario siguen siendo overrides'
        }
        out.push(s)
      }
      continue
    }
  }

  return out
}

module.exports = { calcularSugerencias, POSICIONES_GRUPO }
