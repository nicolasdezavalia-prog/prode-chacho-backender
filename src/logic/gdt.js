/**
 * Lógica de negocio del módulo Gran DT (GDT).
 * Reglas según PRD — no simplificar.
 *
 * Formación estándar: 1 ARQ + 4 DEF + 4 MED + 2 DEL = 11 jugadores
 *
 * Identidad del jugador: nombre_canonico ?? nombre_normalizado
 *                        en contexto de equipo_catalogo_id ?? equipo_real
 *
 * Estados del jugador (gdt_jugadores.estado):
 *   aprobado  → participa en todo: duelos, bloqueados/eliminados
 *   pendiente → NO participa; slot cuenta como vacío
 *   rechazado → NO participa; slot cuenta como vacío (permanente)
 *
 * Estados de equipo (gdt_equipo_estado):
 *   valido              → participa en GDT (requiere 11 jugadores aprobados)
 *   observado           → excluido (mismatch de posición detectado)
 *   requiere_correccion → excluido (admin confirmó el problema)
 *
 * Un equipo con jugadores pendientes o rechazados = sin_equipo = forfeit.
 * Forfeit: si un equipo no es valido, el rival gana el GDT 11-0 con motivo registrado.
 */

const SLOTS = ['ARQ', 'DEF1', 'DEF2', 'DEF3', 'DEF4', 'MED1', 'MED2', 'MED3', 'MED4', 'DEL1', 'DEL2'];

const SLOT_A_POSICION = {
  ARQ:  'ARQ',
  DEF1: 'DEF', DEF2: 'DEF', DEF3: 'DEF', DEF4: 'DEF',
  MED1: 'MED', MED2: 'MED', MED3: 'MED', MED4: 'MED',
  DEL1: 'DEL', DEL2: 'DEL',
};

// ─── NORMALIZACIÓN ───────────────────────────────────────────────────────────

/**
 * Normaliza un nombre para comparación/deduplicación.
 * Minúsculas, sin acentos, sin espacios extra.
 */
function normalizarNombre(nombre) {
  return nombre
    .trim()
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

/**
 * Distancia de Levenshtein entre dos strings.
 */
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = [];
  for (let i = 0; i <= m; i++) {
    dp[i] = [i];
    for (let j = 1; j <= n; j++) {
      dp[i][j] = i === 0
        ? j
        : Math.min(
            dp[i-1][j] + 1,
            dp[i][j-1] + 1,
            dp[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1)
          );
    }
  }
  return dp[m][n];
}

/**
 * Busca un jugador en el torneo por nombre (con deduplicación).
 * Si se pasa equipoCatalogoId, filtra por ese equipo.
 * Retorna match exacto (por nombre_normalizado) y/o similares (Levenshtein ≤ 2).
 * Busca en todos los estados (aprobado, pendiente) para evitar duplicados.
 *
 * @param {Object} db
 * @param {number} torneoId
 * @param {string} nombreInput
 * @param {number|null} equipoCatalogoId - opcional
 * @returns {{ exacto: Object|null, similares: Object[] }}
 */
function buscarJugador(db, torneoId, nombreInput, equipoCatalogoId = null) {
  const norm = normalizarNombre(nombreInput);

  let exacto = null;
  let candidatos = [];

  if (equipoCatalogoId) {
    exacto = db.prepare(`
      SELECT * FROM gdt_jugadores
      WHERE torneo_id = ? AND equipo_catalogo_id = ? AND nombre_normalizado = ? AND activo = 1
    `).get(torneoId, equipoCatalogoId, norm);

    if (!exacto) {
      candidatos = db.prepare(`
        SELECT * FROM gdt_jugadores
        WHERE torneo_id = ? AND equipo_catalogo_id = ? AND activo = 1
      `).all(torneoId, equipoCatalogoId);
    }
  } else {
    // Sin equipo conocido: buscar en todo el torneo
    exacto = db.prepare(`
      SELECT * FROM gdt_jugadores
      WHERE torneo_id = ? AND nombre_normalizado = ? AND activo = 1
      ORDER BY CASE estado WHEN 'aprobado' THEN 0 WHEN 'pendiente' THEN 1 ELSE 2 END
      LIMIT 1
    `).get(torneoId, norm);

    if (!exacto) {
      candidatos = db.prepare(`
        SELECT * FROM gdt_jugadores
        WHERE torneo_id = ? AND activo = 1
      `).all(torneoId);
    }
  }

  if (exacto) return { exacto, similares: [] };

  const similares = norm.length <= 5
    ? []
    : candidatos.filter(j => {
        const normJ = j.nombre_normalizado || normalizarNombre(j.nombre);
        return levenshtein(norm, normJ) <= 2;
      });

  return { exacto: null, similares };
}

// ─── VALIDACIÓN DE POSICIÓN ──────────────────────────────────────────────────

/**
 * Valida que los jugadores APROBADOS de un equipo coincidan con los slots asignados.
 * Los jugadores pendientes/rechazados son ignorados (no participan de todos modos).
 * Retorna lista de observaciones (vacía si todo OK).
 *
 * @param {Object} db
 * @param {number} torneoId
 * @param {number} userId
 * @returns {Array} observaciones: [{ slot, jugador, posicion_jugador, posicion_esperada }]
 */
function validarPosicionesEquipo(db, torneoId, userId) {
  const slots = db.prepare(`
    SELECT ge.slot, ge.jugador_id, gj.nombre, gj.posicion
    FROM gdt_equipos ge
    JOIN gdt_jugadores gj ON ge.jugador_id = gj.id
    WHERE ge.torneo_id = ? AND ge.user_id = ? AND gj.estado = 'aprobado'
  `).all(torneoId, userId);

  const observaciones = [];
  for (const s of slots) {
    const esperada = SLOT_A_POSICION[s.slot];
    if (s.posicion && s.posicion !== esperada) {
      observaciones.push({
        slot: s.slot,
        jugador: s.nombre,
        posicion_jugador: s.posicion,
        posicion_esperada: esperada,
      });
    }
  }
  return observaciones;
}

/**
 * Persiste el estado de validación del equipo de un usuario.
 * Solo aplica si hay 11 jugadores aprobados; si no, no toca el registro.
 * Si hay observaciones de posición → 'observado'. Si no → 'valido'.
 * No sobreescribe 'requiere_correccion' (el admin debe levantarlo explícitamente).
 *
 * @param {Object} db
 * @param {number} torneoId
 * @param {number} userId
 * @param {Array}  observaciones
 */
function persistirEstadoEquipo(db, torneoId, userId, observaciones) {
  const actual = db.prepare(
    'SELECT estado FROM gdt_equipo_estado WHERE torneo_id = ? AND user_id = ?'
  ).get(torneoId, userId);

  // Si el admin puso 'requiere_correccion', no lo pisamos automáticamente
  if (actual?.estado === 'requiere_correccion') return;

  const nuevoEstado = observaciones.length > 0 ? 'observado' : 'valido';
  const obsJson = observaciones.length > 0 ? JSON.stringify(observaciones) : null;

  db.prepare(`
    INSERT INTO gdt_equipo_estado (torneo_id, user_id, estado, observaciones, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(torneo_id, user_id) DO UPDATE SET
      estado = excluded.estado,
      observaciones = excluded.observaciones,
      motivo_admin = CASE WHEN excluded.estado = 'valido' THEN NULL ELSE motivo_admin END,
      invalidado_por = CASE WHEN excluded.estado = 'valido' THEN NULL ELSE invalidado_por END,
      updated_at = excluded.updated_at
  `).run(torneoId, userId, nuevoEstado, obsJson);
}

/**
 * Retorna el estado efectivo del equipo de un usuario para la lógica de juego.
 *
 * 'sin_equipo' si tiene menos de 11 jugadores con estado='aprobado'.
 * Esto incluye: sin equipo cargado, equipo incompleto, o con jugadores pendientes/rechazados.
 *
 * @returns 'valido' | 'observado' | 'requiere_correccion' | 'sin_equipo'
 */
function getEstadoEquipo(db, torneoId, userId) {
  // Solo los aprobados cuentan como slots válidos
  const slotsAprobados = db.prepare(`
    SELECT COUNT(*) as cnt FROM gdt_equipos ge
    JOIN gdt_jugadores gj ON ge.jugador_id = gj.id
    WHERE ge.torneo_id = ? AND ge.user_id = ? AND gj.estado = 'aprobado'
  `).get(torneoId, userId);

  if (!slotsAprobados || slotsAprobados.cnt < 11) return 'sin_equipo';

  const estado = db.prepare(
    'SELECT estado FROM gdt_equipo_estado WHERE torneo_id = ? AND user_id = ?'
  ).get(torneoId, userId);

  return estado?.estado || 'valido';
}

// ─── ESTADO GLOBAL DE JUGADORES (BLOQUEADOS / ELIMINADOS) ───────────────────

/**
 * Calcula el estado global de jugadores en un torneo.
 * SOLO considera jugadores con estado='aprobado' en equipos con estado='valido'.
 *
 * @returns {{ bloqueados: Set<number>, eliminados: Set<number>, conteos: Map<number, number> }}
 */
function getEstadoGlobalJugadores(db, torneoId) {
  // Solo cuentan los usuarios con equipo válido y jugadores aprobados
  const rows = db.prepare(`
    SELECT ge.jugador_id, COUNT(DISTINCT ge.user_id) as cnt
    FROM gdt_equipos ge
    JOIN gdt_jugadores gj ON ge.jugador_id = gj.id
    LEFT JOIN gdt_equipo_estado ee ON ge.torneo_id = ee.torneo_id AND ge.user_id = ee.user_id
    WHERE ge.torneo_id = ?
      AND gj.estado = 'aprobado'
      AND (ee.estado IS NULL OR ee.estado = 'valido')
    GROUP BY ge.jugador_id
  `).all(torneoId);

  const bloqueados = new Set();
  const eliminados = new Set();
  const conteos = new Map();

  for (const row of rows) {
    conteos.set(row.jugador_id, row.cnt);
    if (row.cnt >= 4)      eliminados.add(row.jugador_id);
    else if (row.cnt >= 2) bloqueados.add(row.jugador_id);
  }

  return { bloqueados, eliminados, conteos };
}

// ─── RESOLUCIÓN DE DUELOS ────────────────────────────────────────────────────

/**
 * Resuelve un duelo entre dos jugadores en un slot.
 *
 * Regla especial (explícita, no genérica):
 *   -1 jugando le GANA a 0 no jugó
 *   -1 jugando PIERDE contra 0 jugando (0 > -1 numéricamente)
 *
 * @param {{ puntos, jugo, eliminado }} a
 * @param {{ puntos, jugo, eliminado }} b
 * @returns {'a' | 'b' | 'empate'}
 */
function resolverDuelo(a, b) {
  const pa = a.eliminado ? { puntos: 0, jugo: false } : a;
  const pb = b.eliminado ? { puntos: 0, jugo: false } : b;

  // Comparación numérica: mayor puntos gana (0 siempre > -1, sin excepciones)
  if (pa.puntos > pb.puntos) return 'a';
  if (pb.puntos > pa.puntos) return 'b';

  // Desempate por participación: igual puntos → quien jugó le gana a quien no jugó
  if (pa.jugo && !pb.jugo) return 'a';
  if (pb.jugo && !pa.jugo) return 'b';

  return 'empate';
}

// ─── CÁLCULO DE RESULTADO GDT ────────────────────────────────────────────────

/**
 * Calcula el resultado GDT de un cruce.
 *
 * Si un equipo no está en estado 'valido' → forfeit.
 * Esto incluye equipos con jugadores pendientes/rechazados (estado='sin_equipo').
 * El forfeit queda registrado en gdt_motivo para trazabilidad.
 *
 * Los duelos se resuelven solo entre jugadores aprobados.
 *
 * @returns {{ duelos, duelos_u1, duelos_u2, ganador_gdt, gdt_motivo }}
 */
function calcularResultadoGDT(db, cruceId) {
  const cruce = db.prepare('SELECT * FROM cruces WHERE id = ?').get(cruceId);
  if (!cruce) throw new Error(`Cruce ${cruceId} no encontrado`);

  const fecha = db.prepare('SELECT * FROM fechas WHERE id = ?').get(cruce.fecha_id);
  if (!fecha) throw new Error(`Fecha no encontrada para cruce ${cruceId}`);

  const torneoId = fecha.torneo_id;

  // Verificar estado de ambos equipos
  const estadoU1 = getEstadoEquipo(db, torneoId, cruce.user1_id);
  const estadoU2 = getEstadoEquipo(db, torneoId, cruce.user2_id);
  const u1Valido = estadoU1 === 'valido';
  const u2Valido = estadoU2 === 'valido';

  // Casos de forfeit
  if (!u1Valido && !u2Valido) {
    return {
      duelos: [],
      duelos_u1: 0,
      duelos_u2: 0,
      ganador_gdt: 'empate',
      gdt_motivo: 'forfeit_ambos',
    };
  }
  if (!u1Valido) {
    return {
      duelos: [],
      duelos_u1: 0,
      duelos_u2: 11,
      ganador_gdt: 'user2',
      gdt_motivo: `forfeit_u1:${estadoU1}`,
    };
  }
  if (!u2Valido) {
    return {
      duelos: [],
      duelos_u1: 11,
      duelos_u2: 0,
      ganador_gdt: 'user1',
      gdt_motivo: `forfeit_u2:${estadoU2}`,
    };
  }

  // Ambos válidos → leer composición de equipos (snapshot si existe, live si no)
  const hasSnapshot = db.prepare(
    'SELECT COUNT(*) AS n FROM gdt_equipos_snapshot WHERE fecha_id = ?'
  ).get(cruce.fecha_id).n > 0;

  let equipoU1, equipoU2;
  if (hasSnapshot) {
    // Resolver liga igual que crearSnapshotGDTFechaSiNoExiste para filtro defensivo
    const fechaLigaId = fecha.gdt_liga_id
      || db.prepare("SELECT id FROM gdt_ligas WHERE es_default = 1 AND activo = 1 LIMIT 1").get()?.id
      || db.prepare("SELECT id FROM gdt_ligas WHERE activo = 1 ORDER BY id ASC LIMIT 1").get()?.id
      || null;
    const qEquipo = db.prepare(`
      SELECT s.slot, s.jugador_id, gj.nombre, gj.equipo_real
      FROM gdt_equipos_snapshot s JOIN gdt_jugadores gj ON s.jugador_id = gj.id
      WHERE s.fecha_id = ? AND s.user_id = ? AND s.gdt_liga_id = ? AND gj.estado = 'aprobado'
    `);
    equipoU1 = qEquipo.all(cruce.fecha_id, cruce.user1_id, fechaLigaId);
    equipoU2 = qEquipo.all(cruce.fecha_id, cruce.user2_id, fechaLigaId);
  } else {
    equipoU1 = db.prepare(`
      SELECT ge.slot, ge.jugador_id, gj.nombre, gj.equipo_real
      FROM gdt_equipos ge JOIN gdt_jugadores gj ON ge.jugador_id = gj.id
      WHERE ge.torneo_id = ? AND ge.user_id = ? AND gj.estado = 'aprobado'
    `).all(torneoId, cruce.user1_id);
    equipoU2 = db.prepare(`
      SELECT ge.slot, ge.jugador_id, gj.nombre, gj.equipo_real
      FROM gdt_equipos ge JOIN gdt_jugadores gj ON ge.jugador_id = gj.id
      WHERE ge.torneo_id = ? AND ge.user_id = ? AND gj.estado = 'aprobado'
    `).all(torneoId, cruce.user2_id);
  }

  if (equipoU1.length === 0 || equipoU2.length === 0) return null;

  const puntajesRaw = db.prepare(
    'SELECT jugador_id, puntos, jugo FROM gdt_puntajes_fecha WHERE fecha_id = ?'
  ).all(cruce.fecha_id);
  const puntajesMap = new Map(puntajesRaw.map(p => [p.jugador_id, p]));

  const { eliminados } = getEstadoGlobalJugadoresFecha(db, torneoId, fecha.id);
  const slotU1 = Object.fromEntries(equipoU1.map(e => [e.slot, e]));
  const slotU2 = Object.fromEntries(equipoU2.map(e => [e.slot, e]));

  const duelos = [];
  let duelosU1 = 0, duelosU2 = 0;

  for (const slot of SLOTS) {
    const jugU1 = slotU1[slot];
    const jugU2 = slotU2[slot];
    if (!jugU1 && !jugU2) continue;

    const getPuntaje = (jug) => {
      if (!jug) return { puntos: 0, jugo: false, hayPuntaje: false, eliminado: false };
      const p = puntajesMap.get(jug.jugador_id);
      return {
        puntos: p ? p.puntos : 0,
        jugo: p ? Boolean(p.jugo) : false,
        hayPuntaje: !!p,
        eliminado: eliminados.has(jug.jugador_id),
      };
    };

    const pA = getPuntaje(jugU1);
    const pB = getPuntaje(jugU2);

    // Si alguno no tiene puntaje aún (partido no jugado) → duelo pendiente, no contar
    const aPendiente = !pA.hayPuntaje && !pA.eliminado;
    const bPendiente = !pB.hayPuntaje && !pB.eliminado;
    const esPendiente = aPendiente || bPendiente;

    const resultado = esPendiente ? 'pendiente' : resolverDuelo(pA, pB);

    if (resultado === 'a') duelosU1++;
    else if (resultado === 'b') duelosU2++;

    duelos.push({
      slot,
      jugador_u1:   jugU1?.nombre || null,
      equipo_u1:    jugU1?.equipo_real || null,
      pts_u1:       pA.eliminado ? 0 : pA.puntos,
      jugo_u1:      pA.eliminado ? false : pA.jugo,
      hayPuntaje_u1: pA.hayPuntaje,
      eliminado_u1: pA.eliminado,
      jugador_u2:   jugU2?.nombre || null,
      equipo_u2:    jugU2?.equipo_real || null,
      pts_u2:       pB.eliminado ? 0 : pB.puntos,
      jugo_u2:      pB.eliminado ? false : pB.jugo,
      hayPuntaje_u2: pB.hayPuntaje,
      eliminado_u2: pB.eliminado,
      ganador: resultado,
    });
  }

  const ganadorGDT = duelosU1 > duelosU2 ? 'user1' : duelosU2 > duelosU1 ? 'user2' : 'empate';

  return { duelos, duelos_u1: duelosU1, duelos_u2: duelosU2, ganador_gdt: ganadorGDT, gdt_motivo: null };
}

/**
 * Recalcula el GDT de todos los cruces de una fecha y dispara recálculo de puntos.
 */
function recalcularGDTFecha(db, fechaId, recalcularCruces) {
  crearSnapshotGDTFechaSiNoExiste(db, fechaId);
  const cruces = db.prepare('SELECT * FROM cruces WHERE fecha_id = ?').all(fechaId);

  for (const cruce of cruces) {
    const resultado = calcularResultadoGDT(db, cruce.id);
    if (!resultado) continue;

    db.prepare(`
      UPDATE cruces SET
        gdt_duelos_u1 = ?,
        gdt_duelos_u2 = ?,
        ganador_gdt   = ?,
        gdt_motivo    = ?
      WHERE id = ?
    `).run(resultado.duelos_u1, resultado.duelos_u2, resultado.ganador_gdt, resultado.gdt_motivo, cruce.id);
  }

  recalcularCruces(db, fechaId);
}

/**
 * Retorna todos los jugadores APROBADOS que aparecen en al menos un equipo válido del torneo.
 * Usado para la grilla de puntajes del admin.
 */
function getJugadoresActivosTorneo(db, torneoId) {
  return db.prepare(`
    SELECT DISTINCT gj.id, gj.nombre, gj.equipo_real, gj.posicion
    FROM gdt_jugadores gj
    JOIN gdt_equipos ge ON gj.id = ge.jugador_id
    LEFT JOIN gdt_equipo_estado ee ON ge.torneo_id = ee.torneo_id AND ge.user_id = ee.user_id
    WHERE gj.torneo_id = ?
      AND gj.estado = 'aprobado'
      AND (ee.estado IS NULL OR ee.estado = 'valido')
    ORDER BY gj.nombre
  `).all(torneoId);
}

/**
 * Re-evalúa el estado de todos los equipos que tienen al jugador dado.
 * Llamar después de aprobar/rechazar un jugador para mantener estados consistentes.
 */
function reevaluarEquiposConJugador(db, torneoId, jugadorId) {
  const usuarios = db.prepare(`
    SELECT DISTINCT user_id FROM gdt_equipos
    WHERE torneo_id = ? AND jugador_id = ?
  `).all(torneoId, jugadorId);

  for (const { user_id } of usuarios) {
    const obs = validarPosicionesEquipo(db, torneoId, user_id);
    // Solo persistimos estado si el equipo tiene 11 aprobados (sino queda sin_equipo)
    const aprobados = db.prepare(`
      SELECT COUNT(*) as cnt FROM gdt_equipos ge
      JOIN gdt_jugadores gj ON ge.jugador_id = gj.id
      WHERE ge.torneo_id = ? AND ge.user_id = ? AND gj.estado = 'aprobado'
    `).get(torneoId, user_id);

    if (aprobados?.cnt >= 11) {
      persistirEstadoEquipo(db, torneoId, user_id, obs);
    }
  }
}

// ─── SNAPSHOT DE EQUIPO POR FECHA ─────────────────────────────────────────────

/**
 * Crea un snapshot del equipo GDT de cada usuario para una fecha dada.
 * Idempotente: si ya existe snapshot para esa fecha, no hace nada.
 *
 * El snapshot congela que jugador ocupa cada slot en el momento en que se
 * empieza a cargar puntajes. Cambios posteriores (ventanas de transferencias)
 * no afectan resultados historicos.
 *
 * Copia todos los slots de la liga activa de la fecha.
 * NO filtra por estado del equipo.
 * La validez se evalúa en tiempo de cálculo.
 *
 * @param {Object} db
 * @param {number} fechaId
 */
function crearSnapshotGDTFechaSiNoExiste(db, fechaId) {
  // Idempotente: si ya hay filas para esta fecha, no sobrescribir
  const existe = db.prepare(
    'SELECT COUNT(*) AS n FROM gdt_equipos_snapshot WHERE fecha_id = ?'
  ).get(fechaId);
  if (existe.n > 0) return;

  // Obtener la fecha para saber torneo_id y gdt_liga_id
  const fecha = db.prepare('SELECT * FROM fechas WHERE id = ?').get(fechaId);
  if (!fecha) return;

  // Resolver la liga: la de la fecha, la default, o nada
  const ligaId = fecha.gdt_liga_id
    || db.prepare("SELECT id FROM gdt_ligas WHERE es_default = 1 AND activo = 1 LIMIT 1").get()?.id
    || db.prepare("SELECT id FROM gdt_ligas WHERE activo = 1 ORDER BY id ASC LIMIT 1").get()?.id
    || null;

  // Sin liga resuelta no hay snapshot posible
  if (!ligaId) return;

  // Copiar desde gdt_equipos: congelar composición de slots por liga.
  // NO filtrar por validez del equipo: la validez se evalúa en vivo al calcular.
  db.prepare(`
    INSERT INTO gdt_equipos_snapshot
      (fecha_id, torneo_id, gdt_liga_id, user_id, slot, jugador_id)
    SELECT
      ?, ge.torneo_id, ?, ge.user_id, ge.slot, ge.jugador_id
    FROM gdt_equipos ge
    JOIN gdt_jugadores gj ON ge.jugador_id = gj.id
    WHERE ge.torneo_id = ?
      AND gj.gdt_liga_id = ?
      AND gj.activo = 1
  `).run(fechaId, ligaId, fecha.torneo_id, ligaId);
}

/**
 * Igual que getEstadoGlobalJugadores pero anclado a una fecha específica.
 * Si existe snapshot para la fecha, lo usa (ya filtrado por liga y validez).
 * Si no, cae al comportamiento actual desde gdt_equipos filtrando por liga.
 * Devuelve { bloqueados, eliminados, conteos } — mismo formato.
 */
function getEstadoGlobalJugadoresFecha(db, torneoId, fechaId) {
  const hasSnapshot = db.prepare(
    'SELECT COUNT(*) AS n FROM gdt_equipos_snapshot WHERE fecha_id = ?'
  ).get(fechaId).n > 0;

  let rows;
  if (hasSnapshot) {
    // Snapshot congela composición; estado de jugador/equipo se evalúa en vivo
    rows = db.prepare(`
      SELECT s.jugador_id, COUNT(DISTINCT s.user_id) AS cnt
      FROM gdt_equipos_snapshot s
      JOIN gdt_jugadores gj ON s.jugador_id = gj.id
      LEFT JOIN gdt_equipo_estado ee
        ON s.torneo_id = ee.torneo_id AND s.user_id = ee.user_id AND ee.gdt_liga_id = s.gdt_liga_id
      WHERE s.fecha_id = ?
        AND gj.estado = 'aprobado'
        AND (ee.estado IS NULL OR ee.estado = 'valido')
      GROUP BY s.jugador_id
    `).all(fechaId);
  } else {
    // Fallback: igual a getEstadoGlobalJugadores pero con gdt_liga_id
    const fecha = db.prepare('SELECT * FROM fechas WHERE id = ?').get(fechaId);
    const ligaId = (fecha && fecha.gdt_liga_id)
      || db.prepare("SELECT id FROM gdt_ligas WHERE es_default = 1 AND activo = 1 LIMIT 1").get()?.id
      || null;

    if (ligaId) {
      rows = db.prepare(`
        SELECT ge.jugador_id, COUNT(DISTINCT ge.user_id) AS cnt
        FROM gdt_equipos ge
        JOIN gdt_jugadores gj ON ge.jugador_id = gj.id
        LEFT JOIN gdt_equipo_estado ee
          ON ge.torneo_id = ee.torneo_id AND ge.user_id = ee.user_id AND ee.gdt_liga_id = ?
        WHERE ge.torneo_id = ?
          AND gj.estado = 'aprobado'
          AND gj.gdt_liga_id = ?
          AND (ee.estado IS NULL OR ee.estado = 'valido')
        GROUP BY ge.jugador_id
      `).all(ligaId, torneoId, ligaId);
    } else {
      rows = db.prepare(`
        SELECT ge.jugador_id, COUNT(DISTINCT ge.user_id) AS cnt
        FROM gdt_equipos ge
        JOIN gdt_jugadores gj ON ge.jugador_id = gj.id
        LEFT JOIN gdt_equipo_estado ee ON ge.torneo_id = ee.torneo_id AND ge.user_id = ee.user_id
        WHERE ge.torneo_id = ?
          AND gj.estado = 'aprobado'
          AND (ee.estado IS NULL OR ee.estado = 'valido')
        GROUP BY ge.jugador_id
      `).all(torneoId);
    }
  }

  const bloqueados = new Set();
  const eliminados = new Set();
  const conteos = new Map();

  for (const row of rows) {
    conteos.set(row.jugador_id, row.cnt);
    if (row.cnt >= 4)      eliminados.add(row.jugador_id);
    else if (row.cnt >= 2) bloqueados.add(row.jugador_id);
  }

  return { bloqueados, eliminados, conteos };
}

/**
 * Lista de jugadores activos para una fecha específica.
 * Si hay snapshot para la fecha, lo usa (composición congelada).
 * Si no, cae al comportamiento actual filtrado por liga.
 * Devuelve el mismo formato que getJugadoresActivosTorneo:
 *   [{ id, nombre, equipo_real, posicion }]
 */
function getJugadoresActivosFecha(db, fechaId) {
  const hasSnapshot = db.prepare(
    'SELECT COUNT(*) AS n FROM gdt_equipos_snapshot WHERE fecha_id = ?'
  ).get(fechaId).n > 0;

  if (hasSnapshot) {
    return db.prepare(`
      SELECT DISTINCT gj.id, gj.nombre, gj.equipo_real, gj.posicion
      FROM gdt_equipos_snapshot s
      JOIN gdt_jugadores gj ON s.jugador_id = gj.id
      LEFT JOIN gdt_equipo_estado ee
        ON s.torneo_id = ee.torneo_id AND s.user_id = ee.user_id AND ee.gdt_liga_id = s.gdt_liga_id
      WHERE s.fecha_id = ?
        AND gj.estado = 'aprobado'
        AND (ee.estado IS NULL OR ee.estado = 'valido')
      ORDER BY gj.nombre
    `).all(fechaId);
  }

  // Fallback: lógica actual filtrada por liga de la fecha
  const fecha = db.prepare('SELECT * FROM fechas WHERE id = ?').get(fechaId);
  if (!fecha) return [];

  const torneoId = fecha.torneo_id;
  const ligaId = fecha.gdt_liga_id
    || db.prepare("SELECT id FROM gdt_ligas WHERE es_default = 1 AND activo = 1 LIMIT 1").get()?.id
    || null;

  if (ligaId) {
    return db.prepare(`
      SELECT DISTINCT gj.id, gj.nombre, gj.equipo_real, gj.posicion
      FROM gdt_jugadores gj
      JOIN gdt_equipos ge ON gj.id = ge.jugador_id
      LEFT JOIN gdt_equipo_estado ee
        ON ge.torneo_id = ee.torneo_id AND ge.user_id = ee.user_id AND ee.gdt_liga_id = ?
      WHERE ge.torneo_id = ?
        AND gj.estado = 'aprobado'
        AND gj.gdt_liga_id = ?
        AND (ee.estado IS NULL OR ee.estado = 'valido')
      ORDER BY gj.nombre
    `).all(ligaId, torneoId, ligaId);
  }

  // Sin liga resuelta: comportamiento original sin filtro de liga
  return db.prepare(`
    SELECT DISTINCT gj.id, gj.nombre, gj.equipo_real, gj.posicion
    FROM gdt_jugadores gj
    JOIN gdt_equipos ge ON gj.id = ge.jugador_id
    LEFT JOIN gdt_equipo_estado ee ON ge.torneo_id = ee.torneo_id AND ge.user_id = ee.user_id
    WHERE ge.torneo_id = ?
      AND gj.estado = 'aprobado'
      AND (ee.estado IS NULL OR ee.estado = 'valido')
    ORDER BY gj.nombre
  `).all(torneoId);
}

module.exports = {
  SLOTS,
  SLOT_A_POSICION,
  normalizarNombre,
  levenshtein,
  buscarJugador,
  validarPosicionesEquipo,
  persistirEstadoEquipo,
  getEstadoEquipo,
  getEstadoGlobalJugadores,
  resolverDuelo,
  calcularResultadoGDT,
  recalcularGDTFecha,
  getJugadoresActivosTorneo,
  reevaluarEquiposConJugador,
  crearSnapshotGDTFechaSiNoExiste,
  getEstadoGlobalJugadoresFecha,
  getJugadoresActivosFecha,
};
