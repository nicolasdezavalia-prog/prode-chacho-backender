/**
 * mundial-proyeccion.js — Fase Proyección Ranking
 *
 * Calcula pts proyectados por pregunta usando los datos cargados HOY
 * (stats del fixture + goleadores + tops de tarjetas). Cero impacto en
 * scoring oficial — el oficial sigue dependiendo de `mundial_resultados`
 * que carga el admin. Este helper solo construye "qué pasaría si el
 * Mundial terminara hoy".
 *
 * Reusa `calcularPuntosPregunta` del scoring engine donde puede, simulando
 * un `resultado_json` desde los datos disponibles. Para preguntas con
 * scoring_manual (P35/P36) BYPASEA el engine y aplica la regla simple
 * documentada ("25 pts si user matchea el equipo en posición 1°").
 *
 * Empates en el top:
 *   - Si hay N equipos/jugadores empatados en posición 1° de su respectivo
 *     top, los N son candidatos válidos. El user gana pts si su apuesta
 *     matchea CUALQUIERA. Iteramos candidatos y devolvemos el máximo.
 *
 * Tier 1 (proyectable directo, alta confianza):
 *   P26, P27, P28 — Tercero/Segundo de grupo G/H/I
 *   P29 — Goles recibidos por Argentina en Grupo J
 *   P30 — Empates en grupo K
 *   P31 — Goles hechos por Panamá
 *   P32, P33, P34 — Eliminados en 16°/8°/4° (parcial OK)
 *
 * Tier 3 (proyectable con caveat documentado):
 *   P5 — Goleador del Mundial (usa canonización)
 *   P35, P36 — Equipo con más amarillas/rojas (bypass scoring_manual)
 *
 * Tier 2 (no proyectable durante grupos):
 *   P1-P4 — Campeón/Subcampeón/3°/4° (solo proyectable cuando hay final)
 *   P11-P15+ — Instancia donde perderá X (proyectable si X ya jugó esa ronda)
 *   Resto — null.
 *
 * Mundial 2026 es único: el dispatcher es hardcoded por `numero`. Si las
 * preguntas se renumeran en futuros torneos, este helper necesita
 * adaptación o (mejor) refactorizarse a config en `mundial_config`.
 */

const { calcularPuntosPregunta, normalizarTexto } = require('./mundial-scoring');

function safeParse(s) {
  if (!s) return null;
  if (typeof s === 'object') return s;
  try { return JSON.parse(s) || null; } catch { return null; }
}

// ── Canonización (mismo mecanismo que mundial-pusieron) ─────────────────
// Permite que "Mbappe" del user matchee con "K. Mbappé" del item top
// cuando el admin ya agrupó las variantes (tabla mundial_respuesta_canonizacion).
function cargarCanonMapPorPregunta(db, torneoId) {
  const map = new Map(); // pregunta_id → Map(variante_norm → canonico)
  try {
    const rows = db.prepare(`
      SELECT c.pregunta_id, c.variante_norm, c.canonico
      FROM mundial_respuesta_canonizacion c
      JOIN mundial_preguntas p ON p.id = c.pregunta_id
      WHERE p.torneo_id = ?
    `).all(torneoId);
    for (const r of rows) {
      if (!map.has(r.pregunta_id)) map.set(r.pregunta_id, new Map());
      map.get(r.pregunta_id).set(r.variante_norm, r.canonico);
    }
  } catch (_) {
    // Tabla puede no existir en setups muy viejos. Silencioso.
  }
  return map;
}

function aplicarCanon(texto, canonMap) {
  if (typeof texto !== 'string') return texto;
  if (!canonMap || canonMap.size === 0) return texto;
  const norm = normalizarTexto(texto);
  return canonMap.get(norm) || texto;
}

// ── Helpers de lookup en stats ──────────────────────────────────────────
function getEquipoStats(stats, codigo) {
  return (stats?.equipos || []).find(e => e.equipo_codigo === codigo) || null;
}
function getGrupoTabla(stats, grupo) {
  return (stats?.tabla_grupos || []).find(g => g.grupo === grupo) || null;
}
function tablaGrupoConJuego(stats, grupo) {
  const t = getGrupoTabla(stats, grupo);
  return !!(t && (t.jugados || 0) > 0);
}
function getEmpatesGrupo(stats, grupo) {
  const g = (stats?.empates_por_grupo || []).find(g => g.grupo === grupo);
  return g ? g.empates : null;
}
function getEquiposEnPosicionGrupo(stats, grupo, posicion) {
  // Devuelve TODOS los equipos empatados en esa posición exacta del grupo.
  const t = getGrupoTabla(stats, grupo);
  if (!t) return [];
  return (t.equipos || []).filter(e => e.posicion === posicion).map(e => e.equipo_codigo);
}
function getTopEnPosicion1(top) {
  if (!Array.isArray(top)) return [];
  return top.filter(it => it.posicion === 1).map(it => it.equipo_codigo);
}
function getEquiposEliminadosEnRonda(stats, ronda) {
  return (stats?.eliminados || [])
    .filter(e => e.eliminado_en === ronda)
    .map(e => e.equipo_codigo);
}
function getGoleadoresEnPosicion1(goleadores) {
  return (goleadores || []).filter(g => g.posicion === 1);
}

// ── Lider entre elegidos (P35/P36 — regla "10 pts entre los elegidos") ──
// Dado el set de respuestas para una pregunta de equipo y la métrica
// (amarillas/rojas), devuelve la lista de equipos empatados en máximo
// ENTRE los elegidos por los users. Si nadie eligió nada con > 0 → [].
//
// Esto cubre el caso "fui el único que adiviné un equipo con tarjetas":
// si nadie eligió el líder global del torneo pero alguien eligió un
// equipo con tarjetas, ese equipo es líder entre los elegidos y suma
// 10 pts según el seed.
function calcularLiderEntreElegidos(stats, statsField, respuestas) {
  if (!stats || !Array.isArray(respuestas) || respuestas.length === 0) return [];
  const elegidos = new Set();
  for (const r of respuestas) {
    const obj = safeParse(r.respuesta_json);
    if (obj && typeof obj.equipo === 'string' && obj.equipo.trim() !== '') {
      elegidos.add(obj.equipo);
    }
  }
  if (elegidos.size === 0) return [];
  let max = -1;
  const candidatos = [];
  for (const codigo of elegidos) {
    const equipo = (stats.equipos || []).find(e => e.equipo_codigo === codigo);
    const valor = equipo ? equipo[statsField] : 0;
    if (valor > max) {
      max = valor;
      candidatos.length = 0;
      candidatos.push(codigo);
    } else if (valor === max && valor > 0) {
      candidatos.push(codigo);
    }
  }
  // Solo cuenta como "líder" si tiene > 0 tarjetas. Si todos los elegidos
  // tienen 0, no hay líder (nadie adivinó nada con tarjetas).
  if (max <= 0) return [];
  return candidatos;
}

// Carga respuestas de una pregunta por numero (helper local).
// Devuelve [] si la pregunta no existe.
function cargarRespuestasPregunta(db, torneoId, numero) {
  const pregunta = db.prepare(`
    SELECT id FROM mundial_preguntas
    WHERE torneo_id = ? AND numero = ?
  `).get(torneoId, numero);
  if (!pregunta) return [];
  return db.prepare(`
    SELECT respuesta_json FROM mundial_respuestas_usuario
    WHERE pregunta_id = ?
  `).all(pregunta.id);
}

// ── Cargar contexto completo para proyección ────────────────────────────
// Recibe `stats` y `goleadores` ya calculados; el caller usualmente los
// arma desde calcularStats() y mundial_goleadores+orden.
//
// Precomputa también `lideresEntreElegidos` para P35 (amarillas) y P36
// (rojas) — necesarias para la regla "10 pts entre los elegidos".
function cargarContextoProyeccion(db, torneoId, stats, goleadores) {
  const lideresEntreElegidos = {};
  if (stats) {
    const pares = [[35, 'amarillas'], [36, 'rojas']];
    for (const [numero, campo] of pares) {
      const respuestas = cargarRespuestasPregunta(db, torneoId, numero);
      lideresEntreElegidos[numero] = calcularLiderEntreElegidos(stats, campo, respuestas);
    }
  }
  return {
    stats: stats || null,
    goleadores: Array.isArray(goleadores) ? goleadores : [],
    canonMapPorPregunta: cargarCanonMapPorPregunta(db, torneoId),
    lideresEntreElegidos,
  };
}

// ── ¿La pregunta es proyectable HOY? ────────────────────────────────────
// Bool puro. No mira respuestas — solo el contexto (stats actuales).
// Si devuelve false, el caller la mete en `no_proyectables` con el motivo.
function esProyectable(pregunta, ctx) {
  if (!ctx || !ctx.stats) return false;
  const stats = ctx.stats;
  switch (pregunta.numero) {
    case 5:  return getGoleadoresEnPosicion1(ctx.goleadores).length > 0;
    // P17/P18 — tops de goles en grupos. Proyectable si el top tiene
    // al menos un equipo con > 0 goles (los stats.tops vienen con
    // posicion=1° para el equipo líder, no aparece si total=0).
    case 17: return getTopEnPosicion1(stats.tops?.goleadores_grupos).length > 0;
    case 18: return getTopEnPosicion1(stats.tops?.goleados_grupos).length > 0;
    // P19-P21, P23-P28 — posicionales por grupo. Proyectable si el
    // grupo tiene al menos 1 partido jugado.
    case 19: case 20: return tablaGrupoConJuego(stats, 'A');
    case 21: return tablaGrupoConJuego(stats, 'B');
    case 22: return !!getEquipoStats(stats, 'HAI'); // necesita HAI en catálogo
    case 23: return tablaGrupoConJuego(stats, 'D');
    case 24: return tablaGrupoConJuego(stats, 'E');
    case 25: return tablaGrupoConJuego(stats, 'F');
    case 26: return tablaGrupoConJuego(stats, 'G');
    case 27: return tablaGrupoConJuego(stats, 'H');
    case 28: return tablaGrupoConJuego(stats, 'I');
    case 29: return !!getEquipoStats(stats, 'ARG');
    case 30: return getEmpatesGrupo(stats, 'K') !== null;
    case 31: return !!getEquipoStats(stats, 'PAN');
    case 32: return getEquiposEliminadosEnRonda(stats, 'dieciseisavos').length > 0;
    case 33: return getEquiposEliminadosEnRonda(stats, 'octavos').length > 0;
    case 34: return getEquiposEliminadosEnRonda(stats, 'cuartos').length > 0;
    case 35: return getTopEnPosicion1(stats.tops?.amarillas).length > 0;
    case 36: return getTopEnPosicion1(stats.tops?.rojas).length > 0;
    default: return false;
  }
}

// Motivo legible para preguntas no proyectables. Solo uso UX.
function motivoNoProyectable(pregunta) {
  switch (pregunta.numero) {
    case 1: case 2: case 3: case 4:
      return 'Se proyecta cuando se carga la final y el tercer puesto.';
    case 11: case 12: case 13: case 14: case 15: case 16:
      return 'Se proyecta cuando ese equipo es eliminado.';
    default:
      return 'Aún sin datos suficientes en el fixture.';
  }
}

// ── Dispatcher de proyección por pregunta ───────────────────────────────
// PRE: esProyectable(pregunta, ctx) === true.
// Devuelve number ≥ 0. Si user no respondió o respondió mal, 0.
// Si la pregunta no debería estar acá (caller olvidó chequear), null.
function proyectarPregunta(pregunta, cfg, respuesta, userId, ctx) {
  if (!esProyectable(pregunta, ctx)) return null;
  const stats = ctx.stats;
  const respObj = typeof respuesta === 'string' ? safeParse(respuesta) : respuesta;
  if (!respObj) return 0;

  switch (pregunta.numero) {
    case 5:  return proyectarGoleador(pregunta, cfg, respObj, ctx);
    case 17: return proyectarTopGoles(cfg, respObj, userId, stats.tops?.goleadores_grupos);
    case 18: return proyectarTopGoles(cfg, respObj, userId, stats.tops?.goleados_grupos);
    case 19: return proyectarPosicionGrupo(cfg, respObj, userId, ctx, 'A', 2);
    case 20: return proyectarPosicionGrupo(cfg, respObj, userId, ctx, 'A', 3);
    case 21: return proyectarPosicionGrupo(cfg, respObj, userId, ctx, 'B', 4);
    case 22: return proyectarSumaraPuntos(cfg, respObj, ctx, 'HAI');
    case 23: return proyectarPosicionGrupo(cfg, respObj, userId, ctx, 'D', 1);
    case 24: return proyectarPosicionGrupo(cfg, respObj, userId, ctx, 'E', 2);
    case 25: return proyectarPosicionGrupo(cfg, respObj, userId, ctx, 'F', 2);
    case 26: return proyectarPosicionGrupo(cfg, respObj, userId, ctx, 'G', 3);
    case 27: return proyectarPosicionGrupo(cfg, respObj, userId, ctx, 'H', 3);
    case 28: return proyectarPosicionGrupo(cfg, respObj, userId, ctx, 'I', 2);
    case 29: return proyectarNumero(pregunta, cfg, respObj, getEquipoStats(stats, 'ARG')?.gc_grupos || 0);
    case 30: return proyectarNumero(pregunta, cfg, respObj, getEmpatesGrupo(stats, 'K') || 0);
    case 31: return proyectarNumero(pregunta, cfg, respObj, getEquipoStats(stats, 'PAN')?.gf_total || 0);
    case 32: return proyectarMultiEliminados(cfg, respObj, ctx, 'dieciseisavos');
    case 33: return proyectarMultiEliminados(cfg, respObj, ctx, 'octavos');
    case 34: return proyectarMultiEliminados(cfg, respObj, ctx, 'cuartos');
    case 35: return proyectarTopTarjetas(respObj, stats.tops?.amarillas, ctx.lideresEntreElegidos?.[35]);
    case 36: return proyectarTopTarjetas(respObj, stats.tops?.rojas,     ctx.lideresEntreElegidos?.[36]);
    default: return 0;
  }
}

// ── Proyectores específicos ─────────────────────────────────────────────

function proyectarNumero(pregunta, cfg, respObj, valorEsperado) {
  if (!Number.isInteger(respObj.numero)) return 0;
  const res = { numero: valorEsperado };
  // Scoring engine maneja tanto numero_exacto como numero_por_banda.
  return calcularPuntosPregunta(pregunta.tipo_pregunta, cfg, res, respObj, null) || 0;
}

// Proyector genérico para preguntas tipo "Equipo en posición N del Grupo X".
// Cubre P19-P21, P23-P28: 2°/3°/4°/Ganador de cualquier grupo.
// Empates en la posición exacta: si 2 equipos comparten esa posición,
// ambos son candidatos. El user gana pts si matcheó cualquiera (pts máx).
function proyectarPosicionGrupo(cfg, respObj, userId, ctx, grupo, posicion) {
  const candidatos = getEquiposEnPosicionGrupo(ctx.stats, grupo, posicion);
  if (candidatos.length === 0) return 0;
  if (typeof respObj.equipo !== 'string') return 0;
  let maxPts = 0;
  for (const cand of candidatos) {
    const res = { equipo: cand };
    const pts = calcularPuntosPregunta('equipo_categoria', cfg, res, respObj, userId) || 0;
    if (pts > maxPts) maxPts = pts;
  }
  return maxPts;
}

// Proyector para P17 (equipo más goleador en grupos) y P18 (más goleado).
// Usa el scoring engine con categorias del seed (default 30 pts).
// Empates en pos 1° del top: todos los candidatos válidos, máx pts.
function proyectarTopGoles(cfg, respObj, userId, top) {
  if (!Array.isArray(top) || top.length === 0) return 0;
  if (typeof respObj.equipo !== 'string') return 0;
  const candidatos = getTopEnPosicion1(top);
  if (candidatos.length === 0) return 0;
  let maxPts = 0;
  for (const cand of candidatos) {
    const res = { equipo: cand };
    const pts = calcularPuntosPregunta('equipo_categoria', cfg, res, respObj, userId) || 0;
    if (pts > maxPts) maxPts = pts;
  }
  return maxPts;
}

// Proyector para P22: "¿Sumará puntos Haití (Grupo C)?".
// opcion_unica con ['Sí', 'No']. Proyección basada en estado actual:
// si HAI ya tiene pts > 0 → "Sí" definitivo. Sino → "No" provisional.
// Cuando HAI gane un partido en grupos, el sistema actualiza la proyección.
function proyectarSumaraPuntos(cfg, respObj, ctx, equipoCodigo) {
  if (typeof respObj.opcion !== 'string') return 0;
  const equipo = getEquipoStats(ctx.stats, equipoCodigo);
  // Si el equipo no está en stats (no jugó ni aparece en catálogo), no
  // podemos proyectar — devolvemos 0 (esProyectable filtra esto antes).
  if (!equipo) return 0;
  const proyectada = (equipo.pts > 0) ? 'Sí' : 'No';
  const res = { opcion: proyectada };
  return calcularPuntosPregunta('opcion_unica', cfg, res, respObj, null) || 0;
}

function proyectarMultiEliminados(cfg, respObj, ctx, ronda) {
  // Multi_equipo: scoring engine cuenta intersección × pts_por_acierto.
  // Si solo hay 1 eliminado todavía, el user gana 10 pts si lo tenía.
  // Se actualiza a medida que más equipos se eliminan en esa ronda.
  const eliminados = getEquiposEliminadosEnRonda(ctx.stats, ronda);
  if (eliminados.length === 0) return 0;
  if (!Array.isArray(respObj.equipos)) return 0;
  const res = { equipos: eliminados };
  return calcularPuntosPregunta('multi_equipo', cfg, res, respObj, null) || 0;
}

function proyectarTopTarjetas(respObj, top, lideresEntreElegidos) {
  // P35/P36 — scoring_manual: bypassamos el engine y aplicamos el seed:
  //   - 25 pts si el equipo del user está en posición 1° del top GLOBAL
  //     (incluye empates).
  //   - 10 pts si no está en el top global PERO está empatado en máximo
  //     entre los equipos ELEGIDOS por los users del torneo (regla
  //     "fui el único que adivinó un equipo con tarjetas").
  //   - 0 sino.
  // El admin sigue siendo el árbitro final al cierre; este proyectado
  // es la mejor aproximación posible con los datos actuales.
  if (typeof respObj.equipo !== 'string') return 0;
  const lideresGlobal = getTopEnPosicion1(top);
  if (lideresGlobal.includes(respObj.equipo)) return 25;
  if (Array.isArray(lideresEntreElegidos) && lideresEntreElegidos.includes(respObj.equipo)) return 10;
  return 0;
}

function proyectarGoleador(pregunta, cfg, respObj, ctx) {
  // P5: top goleadores empatados son todos candidatos. Match con canon.
  // Si user matchea cualquier candidato (o su variante canonizada),
  // gana cfg.pts_max (o 100 fallback).
  if (typeof respObj.texto !== 'string') return 0;
  const tops = getGoleadoresEnPosicion1(ctx.goleadores);
  if (tops.length === 0) return 0;
  const canonMap = ctx.canonMapPorPregunta?.get(pregunta.id) || null;
  const respNorm = normalizarTexto(aplicarCanon(respObj.texto, canonMap));
  if (respNorm === '') return 0;
  for (const g of tops) {
    const candidatos = [];
    if (typeof g.jugador === 'string' && g.jugador.trim() !== '') candidatos.push(g.jugador);
    if (typeof g.titulo  === 'string' && g.titulo.trim()  !== '') candidatos.push(g.titulo);
    for (const c of candidatos) {
      const cNorm = normalizarTexto(aplicarCanon(c, canonMap));
      if (cNorm !== '' && cNorm === respNorm) {
        return Number.isInteger(cfg?.pts_max) ? cfg.pts_max : 100;
      }
    }
  }
  return 0;
}

// ── Display "Vos" vs "Hoy" para detalle del ranking proyectado ──────────
// Devuelven strings cortos para renderizar en el FE como chips.
// Empates se serializan con " / " separator. Devuelven null cuando no
// hay valor renderizable (FE oculta el chip).
function _joinNoVacio(arr) {
  return Array.isArray(arr) && arr.length ? arr.join(' / ') : null;
}

// Lo que puso el user. Lee solo del respObj (no canoniza).
function displayRespuestaUser(pregunta, respObj) {
  if (!respObj) return null;
  switch (pregunta.numero) {
    case 5:
      return typeof respObj.texto === 'string' && respObj.texto.trim() !== '' ? respObj.texto : null;
    case 17: case 18:
    case 19: case 20: case 21:
    case 23: case 24: case 25: case 26: case 27: case 28:
    case 35: case 36:
      return typeof respObj.equipo === 'string' && respObj.equipo.trim() !== '' ? respObj.equipo : null;
    case 22:
      return typeof respObj.opcion === 'string' && respObj.opcion.trim() !== '' ? respObj.opcion : null;
    case 29: case 30: case 31:
      return Number.isInteger(respObj.numero) ? String(respObj.numero) : null;
    case 32: case 33: case 34:
      return Array.isArray(respObj.equipos) && respObj.equipos.length > 0
        ? respObj.equipos.join(' / ')
        : null;
    default:
      return null;
  }
}

// Lo que la proyección dice HOY. Lee de ctx/stats. Empates → " / ".
function displayProyeccionActual(pregunta, ctx) {
  const stats = ctx?.stats;
  if (!stats) return null;
  switch (pregunta.numero) {
    case 5: {
      const tops = getGoleadoresEnPosicion1(ctx.goleadores);
      if (!tops.length) return null;
      const nombres = tops
        .map(g => (typeof g.jugador === 'string' && g.jugador.trim()) ||
                  (typeof g.titulo  === 'string' && g.titulo.trim())  || '')
        .filter(Boolean);
      return nombres.length ? nombres.join(' / ') : null;
    }
    case 17: return _joinNoVacio(getTopEnPosicion1(stats.tops?.goleadores_grupos));
    case 18: return _joinNoVacio(getTopEnPosicion1(stats.tops?.goleados_grupos));
    case 19: return _joinNoVacio(getEquiposEnPosicionGrupo(stats, 'A', 2));
    case 20: return _joinNoVacio(getEquiposEnPosicionGrupo(stats, 'A', 3));
    case 21: return _joinNoVacio(getEquiposEnPosicionGrupo(stats, 'B', 4));
    case 22: {
      const e = getEquipoStats(stats, 'HAI');
      if (!e) return null;
      return (e.pts || 0) > 0 ? 'Sí' : 'No';
    }
    case 23: return _joinNoVacio(getEquiposEnPosicionGrupo(stats, 'D', 1));
    case 24: return _joinNoVacio(getEquiposEnPosicionGrupo(stats, 'E', 2));
    case 25: return _joinNoVacio(getEquiposEnPosicionGrupo(stats, 'F', 2));
    case 26: return _joinNoVacio(getEquiposEnPosicionGrupo(stats, 'G', 3));
    case 27: return _joinNoVacio(getEquiposEnPosicionGrupo(stats, 'H', 3));
    case 28: return _joinNoVacio(getEquiposEnPosicionGrupo(stats, 'I', 2));
    case 29: {
      const arg = getEquipoStats(stats, 'ARG');
      return arg ? String(arg.gc_grupos || 0) : null;
    }
    case 30: {
      const n = getEmpatesGrupo(stats, 'K');
      return n != null ? String(n) : null;
    }
    case 31: {
      const pan = getEquipoStats(stats, 'PAN');
      return pan ? String(pan.gf_total || 0) : null;
    }
    case 32: case 33: case 34: {
      const ronda = pregunta.numero === 32 ? 'dieciseisavos'
                  : pregunta.numero === 33 ? 'octavos' : 'cuartos';
      const elim = getEquiposEliminadosEnRonda(stats, ronda);
      return _joinNoVacio(elim);
    }
    case 35: return _joinNoVacio(getTopEnPosicion1(stats.tops?.amarillas));
    case 36: return _joinNoVacio(getTopEnPosicion1(stats.tops?.rojas));
    default: return null;
  }
}

// ─── Desempate proyectado (regla 2026-06-21, espejo de mundial-scoring.js) ───
// A igual puntos_proyectados, gana quien acertó el numero MÁS ALTO (regla
// "de abajo para arriba"). `aciertos_numeros` viene ordenado DESC.
// Si los aciertos coinciden exactamente, fallback alfabético.
function compararEmpateProy(a, b) {
  const A = a.aciertos_numeros || [];
  const B = b.aciertos_numeros || [];
  const min = Math.min(A.length, B.length);
  for (let i = 0; i < min; i++) {
    if (A[i] !== B[i]) return B[i] - A[i];  // mayor gana
  }
  if (A.length !== B.length) return B.length - A.length;
  return (a.nombre || '').localeCompare(b.nombre || '', 'es');
}
function mismaPosicionProy(a, b) {
  if (a.puntos_proyectados !== b.puntos_proyectados) return false;
  const A = a.aciertos_numeros || [];
  const B = b.aciertos_numeros || [];
  if (A.length !== B.length) return false;
  for (let i = 0; i < A.length; i++) if (A[i] !== B[i]) return false;
  return true;
}

// ── High-level: calcular ranking proyectado completo ────────────────────
// Devuelve el shape final para el endpoint. Carga TODO desde DB.
function calcularRankingProyectado(db, torneoId, stats, goleadores) {
  const ctx = cargarContextoProyeccion(db, torneoId, stats, goleadores);

  // Cargar preguntas activas + respuestas en una sola pasada por user.
  const preguntas = db.prepare(`
    SELECT id, numero, enunciado, tipo_pregunta, config_json
    FROM mundial_preguntas
    WHERE torneo_id = ? AND activa = 1
    ORDER BY numero ASC
  `).all(torneoId);
  const respuestas = db.prepare(`
    SELECT ru.user_id, u.nombre, ru.pregunta_id, ru.respuesta_json
    FROM mundial_respuestas_usuario ru
    JOIN users u ON u.id = ru.user_id
    JOIN mundial_preguntas p ON p.id = ru.pregunta_id
    WHERE p.torneo_id = ? AND p.activa = 1
  `).all(torneoId);

  // 1) Determinar qué preguntas son proyectables HOY.
  const preguntasParsed = preguntas.map(p => ({
    ...p,
    cfg: safeParse(p.config_json) || {},
  }));
  const proyectablesIds = new Set();
  const no_proyectables = [];
  for (const p of preguntasParsed) {
    if (esProyectable(p, ctx)) {
      proyectablesIds.add(p.id);
    } else {
      no_proyectables.push({
        numero: p.numero,
        enunciado: p.enunciado,
        motivo: motivoNoProyectable(p),
      });
    }
  }

  // 2) Agrupar respuestas por user.
  const porUser = new Map();
  for (const r of respuestas) {
    let bucket = porUser.get(r.user_id);
    if (!bucket) {
      bucket = { nombre: r.nombre, respuestas: new Map() };
      porUser.set(r.user_id, bucket);
    }
    bucket.respuestas.set(r.pregunta_id, r.respuesta_json);
  }

  // 3) Calcular pts por user sobre las preguntas proyectables.
  // Detalle por pregunta proyectable RESPONDIDA: { numero, enunciado,
  // pts_proyectados, acerto, respuesta_user_display, respuesta_actual_display }.
  // El FE usa los _display para chips "Vos: X" / "Hoy: Y".
  const ranking = [];
  for (const [user_id, { nombre, respuestas: rmap }] of porUser.entries()) {
    let puntos = 0, aciertos = 0;
    const detalle = [];
    for (const p of preguntasParsed) {
      if (!proyectablesIds.has(p.id)) continue;
      const respJson = rmap.get(p.id);
      if (!respJson) continue; // user no respondió esa pregunta
      const respObj = safeParse(respJson);
      const ptsRaw = proyectarPregunta(p, p.cfg, respObj, user_id, ctx);
      const pts = Number.isInteger(ptsRaw) ? ptsRaw : 0;
      const acerto = pts > 0;
      if (acerto) {
        puntos += pts;
        aciertos++;
      }
      detalle.push({
        numero: p.numero,
        enunciado: p.enunciado,
        pts_proyectados: pts,
        acerto,
        respuesta_user_display:   displayRespuestaUser(p, respObj),
        respuesta_actual_display: displayProyeccionActual(p, ctx),
      });
    }
    // Aciertos primero (más visibles), después numero DESC dentro de cada
    // grupo (refleja el orden "de abajo para arriba" del desempate).
    detalle.sort((a, b) => {
      if (a.acerto !== b.acerto) return a.acerto ? -1 : 1;
      return b.numero - a.numero;
    });
    // Para desempate: array de numeros acertados ordenado DESC (mayor a menor).
    const aciertos_numeros = detalle
      .filter(d => d.acerto)
      .map(d => d.numero)
      .sort((a, b) => b - a);
    ranking.push({
      user_id,
      nombre,
      puntos_proyectados: puntos,
      aciertos_proyectados: aciertos,
      aciertos_numeros,
      detalle,
    });
  }

  // 4) Sort + dense-rank con desempate "de abajo para arriba" (regla 2026-06-21).
  //    A igual pts, gana quien acertó el numero más ALTO. Si los aciertos
  //    coinciden exactamente, fallback alfabético.
  ranking.sort((a, b) => {
    if (b.puntos_proyectados !== a.puntos_proyectados) {
      return b.puntos_proyectados - a.puntos_proyectados;
    }
    return compararEmpateProy(a, b);
  });
  // Dense-rank: comparten posición sólo si mismos pts Y mismos aciertos.
  let pos = 0, prev = null;
  for (let i = 0; i < ranking.length; i++) {
    if (prev === null || !mismaPosicionProy(ranking[i], prev)) {
      pos = i + 1;
      prev = ranking[i];
    }
    ranking[i].posicion = pos;
  }

  return {
    ranking,
    preguntas_proyectables: proyectablesIds.size,
    total_preguntas: preguntasParsed.length,
    no_proyectables,
    caveat: 'Proyección al día de hoy. Sujeta a cambios y a la confirmación oficial del admin al final del Mundial.',
  };
}

module.exports = {
  esProyectable,
  motivoNoProyectable,
  proyectarPregunta,
  cargarContextoProyeccion,
  calcularRankingProyectado,
  displayRespuestaUser,
  displayProyeccionActual,
  // Helpers expuestos para reuso desde endpoints
  safeParse,
  // Exportados para testing
  aplicarCanon,
  cargarCanonMapPorPregunta,
};
