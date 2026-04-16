/**
 * Lógica de negocio central del Prode Chacho.
 * Todas las reglas están definidas en el PRD y no deben simplificarse.
 */

/**
 * Calcula el signo L/E/V a partir de dos resultados numéricos.
 */
function calcularLEV(golesLocal, golesVisitante) {
  if (golesLocal === null || golesVisitante === null) return null;
  if (golesLocal > golesVisitante) return 'L';
  if (golesLocal === golesVisitante) return 'E';
  return 'V';
}

/**
 * Calcula los puntos obtenidos por un pronóstico dado el resultado real del evento.
 *
 * Reglas PRD:
 * - Si acerta el L/E/V: suma los puntos del signo correcto
 * - Si además acerta el resultado exacto: suma el extra
 * - Si no acerta el L/E/V: 0 puntos
 */
function calcularPuntosPronostico(evento, pronostico) {
  if (!pronostico) return 0;

  if (evento.tipo === 'partido') {
    // Para partidos, lev_real es prerequisito (resultado aún no cargado)
    if (evento.lev_real === null || evento.lev_real === undefined) return 0;
    const levPron = pronostico.lev_pronostico;
    if (!levPron || levPron !== evento.lev_real) return 0;

    let puntos = 0;
    switch (evento.lev_real) {
      case 'L': puntos = evento.pts_local; break;
      case 'E': puntos = evento.pts_empate; break;
      case 'V': puntos = evento.pts_visitante; break;
    }

    // Bonus por resultado exacto
    if (
      pronostico.goles_local === evento.resultado_local &&
      pronostico.goles_visitante === evento.resultado_visitante
    ) {
      puntos += evento.pts_exacto;
    }

    return puntos;
  }

  if (evento.tipo === 'pregunta') {
    if (!pronostico.opcion_elegida) return 0;

    // Modelo nuevo: config_json + resultado_json con ids estables
    if (evento.config_json && evento.resultado_json) {
      try {
        const config   = JSON.parse(evento.config_json);
        const resultado = JSON.parse(evento.resultado_json);
        const subtipo  = config.subtipo;

        // binaria: pts variable por opción (cada opción tiene su propio pts)
        if (subtipo === 'binaria') {
          if (pronostico.opcion_elegida !== resultado.correcta) return 0;
          const op = (config.opciones || []).find(o => o.id === pronostico.opcion_elegida);
          return op ? (op.pts || 0) : 0;
        }

        // opcion_unica: N opciones, un correcto, pts planos
        if (subtipo === 'opcion_unica') {
          if (pronostico.opcion_elegida !== resultado.correcta) return 0;
          return config.pts || 0;
        }

        // multi_select: múltiples correctas, pts por acierto
        // ("acumulativa" es solo un nombre visual para este mismo subtipo)
        if (subtipo === 'multi_select') {
          let elegidas;
          try { elegidas = JSON.parse(pronostico.opcion_elegida); }
          catch  { elegidas = []; }
          if (!Array.isArray(elegidas)) elegidas = [];
          const correctas = resultado.correctas || [];
          const aciertos  = elegidas.filter(id => correctas.includes(id)).length;
          return aciertos * (config.pts_por_acierto || 0);
        }
      } catch (_) {
        // config_json malformado → caer al modelo legacy
      }
    }

    // Modelo legacy (fallback para preguntas viejas sin config_json)
    if (evento.opcion_correcta && pronostico.opcion_elegida === evento.opcion_correcta) {
      return evento.pts_local || 0;
    }
    return 0;
  }

  return 0;
}

/**
 * Recalcula todos los pronósticos de una fecha y actualiza puntos_obtenidos.
 * También actualiza los totales de cruce.
 * Retorna un resumen del cálculo.
 */
function recalcularFecha(db, fechaId) {
  const eventos = db.prepare('SELECT * FROM eventos WHERE fecha_id = ?').all(fechaId);
  const pronosticos = db.prepare('SELECT * FROM pronosticos WHERE evento_id IN (SELECT id FROM eventos WHERE fecha_id = ?)').all(fechaId);

  // Actualizar lev_real para cada evento que tenga resultado cargado
  const updateLev = db.prepare('UPDATE eventos SET lev_real = ? WHERE id = ?');
  for (const ev of eventos) {
    if (ev.resultado_local !== null && ev.resultado_visitante !== null) {
      const lev = calcularLEV(ev.resultado_local, ev.resultado_visitante);
      updateLev.run(lev, ev.id);
      ev.lev_real = lev; // actualizar en memoria también
    }
  }

  // Recalcular puntos por pronóstico
  const updatePuntos = db.prepare('UPDATE pronosticos SET puntos_obtenidos = ? WHERE id = ?');
  const updateLevPron = db.prepare('UPDATE pronosticos SET lev_pronostico = ?, puntos_obtenidos = ? WHERE id = ?');

  for (const pron of pronosticos) {
    const evento = eventos.find(e => e.id === pron.evento_id);
    if (!evento) continue;

    // Preguntas abiertas: puntaje 100% manual — no se recalcula nunca.
    // pronosticos.puntos_obtenidos es la fuente de verdad asignada por el admin.
    if (evento.tipo === 'pregunta') {
      try {
        const cfg = evento.config_json ? JSON.parse(evento.config_json) : {};
        if (cfg.subtipo === 'abierta') continue; // preservar puntos manuales
      } catch (_) {}
    }

    // Recalcular lev_pronostico desde goles (partidos)
    // Si el usuario seteó manualmente el LEV (lev_manual=1), se respeta sin pisar
    if (evento.tipo === 'partido' && pron.goles_local !== null && pron.goles_visitante !== null) {
      const levPron = pron.lev_manual ? pron.lev_pronostico : calcularLEV(pron.goles_local, pron.goles_visitante);
      pron.lev_pronostico = levPron;
      const puntos = calcularPuntosPronostico(evento, pron);
      updateLevPron.run(levPron, puntos, pron.id);
    } else {
      const puntos = calcularPuntosPronostico(evento, pron);
      updatePuntos.run(puntos, pron.id);
    }
  }

  // Recalcular cruces de esta fecha
  recalcularCruces(db, fechaId);
}

/**
 * Recalcula los cruces de una fecha:
 * - Suma puntos Tabla A (eventos 1-15) y Tabla B (eventos 16-30) por usuario
 * - Determina ganador de cada tabla
 * - Aplica desempate de GDT si corresponde
 * - Calcula ganador de fecha y puntos de torneo
 */
function recalcularCruces(db, fechaId) {
  const cruces = db.prepare('SELECT * FROM cruces WHERE fecha_id = ?').all(fechaId);
  const eventos = db.prepare('SELECT * FROM eventos WHERE fecha_id = ?').all(fechaId);

  for (const cruce of cruces) {
    // Obtener pronósticos de ambos usuarios para esta fecha
    const pronosU1 = db.prepare(
      'SELECT p.*, e.orden FROM pronosticos p JOIN eventos e ON p.evento_id = e.id WHERE e.fecha_id = ? AND p.user_id = ?'
    ).all(fechaId, cruce.user1_id);

    const pronosU2 = db.prepare(
      'SELECT p.*, e.orden FROM pronosticos p JOIN eventos e ON p.evento_id = e.id WHERE e.fecha_id = ? AND p.user_id = ?'
    ).all(fechaId, cruce.user2_id);

    // Calcular puntos Tabla A (eventos 1-15) y Tabla B (eventos 16-30)
    let ptsAu1 = 0, ptsAu2 = 0;
    let ptsBu1 = 0, ptsBu2 = 0;

    for (const ev of eventos) {
      const pronU1 = pronosU1.find(p => p.evento_id === ev.id);
      const pronU2 = pronosU2.find(p => p.evento_id === ev.id);
      const ptsU1 = pronU1 ? (pronU1.puntos_obtenidos || 0) : 0;
      const ptsU2 = pronU2 ? (pronU2.puntos_obtenidos || 0) : 0;

      if (ev.orden >= 1 && ev.orden <= 15) {
        ptsAu1 += ptsU1;
        ptsAu2 += ptsU2;
      } else if (ev.orden >= 16 && ev.orden <= 30) {
        ptsBu1 += ptsU1;
        ptsBu2 += ptsU2;
      }
    }

    // Determinar ganadores de Tabla A y Tabla B
    const ganadorA = determinarGanador(ptsAu1, ptsAu2);
    const ganadorB = determinarGanador(ptsBu1, ptsBu2);

    // Calcular puntos internos de fecha
    // TablaA = 1 punto, TablaB = 1 punto, GDT = 2 puntos
    let piU1 = 0, piU2 = 0;
    if (ganadorA === 'user1') piU1 += 1;
    else if (ganadorA === 'user2') piU2 += 1;

    if (ganadorB === 'user1') piU1 += 1;
    else if (ganadorB === 'user2') piU2 += 1;

    // Si hay GDT calculado, incorporarlo
    // El GDT se agrega cuando se implemente (fase posterior)
    // Por ahora, si hay ganador_gdt lo usamos
    let ganadorGDT = cruce.ganador_gdt;

    // Aplicar desempate de GDT si corresponde (PRD 10.3)
    if (ganadorGDT === 'empate' || ganadorGDT === null) {
      // Si GDT empata, desempatar por Tabla A, luego Tabla B
      if (ganadorA !== 'empate') {
        ganadorGDT = ganadorA; // el que ganó Tabla A, gana el GDT
      } else if (ganadorB !== 'empate') {
        ganadorGDT = ganadorB; // el que ganó Tabla B, gana el GDT
      } else {
        ganadorGDT = 'empate'; // ambas empatan → GDT empata
      }
    }

    // Solo agregar puntos de GDT si está calculado (no null)
    if (cruce.gdt_duelos_u1 !== null && cruce.gdt_duelos_u2 !== null) {
      if (ganadorGDT === 'user1') piU1 += 2;
      else if (ganadorGDT === 'user2') piU2 += 2;
      // empate = 0 puntos para ambos
    }

    // Determinar ganador de la fecha
    let ganadorFecha;
    if (piU1 > piU2) ganadorFecha = 'user1';
    else if (piU2 > piU1) ganadorFecha = 'user2';
    else ganadorFecha = 'empate';

    // Calcular puntos de torneo
    // Victoria=3, Empate=1, Derrota=0
    // Bonus por victoria perfecta (ganar A + B + GDT) = +1
    let ptsTorneoU1 = 0, ptsTorneoU2 = 0;

    if (ganadorFecha === 'user1') {
      ptsTorneoU1 = 3;
      ptsTorneoU2 = 0;
    } else if (ganadorFecha === 'user2') {
      ptsTorneoU1 = 0;
      ptsTorneoU2 = 3;
    } else {
      ptsTorneoU1 = 1;
      ptsTorneoU2 = 1;
    }

    // Bonus: solo si hay GDT calculado y se ganó todo
    if (cruce.gdt_duelos_u1 !== null) {
      if (ganadorA === 'user1' && ganadorB === 'user1' && ganadorGDT === 'user1') {
        ptsTorneoU1 += 1; // victoria perfecta
      }
      if (ganadorA === 'user2' && ganadorB === 'user2' && ganadorGDT === 'user2') {
        ptsTorneoU2 += 1; // victoria perfecta
      }
    }

    // Actualizar cruce en DB
    db.prepare(`
      UPDATE cruces SET
        pts_tabla_a_u1 = ?, pts_tabla_a_u2 = ?,
        pts_tabla_b_u1 = ?, pts_tabla_b_u2 = ?,
        ganador_tabla_a = ?, ganador_tabla_b = ?,
        ganador_gdt = ?,
        puntos_internos_u1 = ?, puntos_internos_u2 = ?,
        ganador_fecha = ?,
        pts_torneo_u1 = ?, pts_torneo_u2 = ?
      WHERE id = ?
    `).run(
      ptsAu1, ptsAu2,
      ptsBu1, ptsBu2,
      ganadorA, ganadorB,
      ganadorGDT || null,
      piU1, piU2,
      ganadorFecha,
      ptsTorneoU1, ptsTorneoU2,
      cruce.id
    );
  }

  // Recalcular tabla general del torneo
  recalcularTablaGeneral(db, fechaId);
}

/**
 * Determina el ganador entre dos puntajes.
 * Retorna: 'user1' | 'user2' | 'empate'
 */
function determinarGanador(ptsU1, ptsU2) {
  if (ptsU1 > ptsU2) return 'user1';
  if (ptsU2 > ptsU1) return 'user2';
  return 'empate';
}

/**
 * Recalcula la tabla general del torneo para todos los usuarios de una fecha.
 */
function recalcularTablaGeneral(db, fechaId) {
  const fecha = db.prepare('SELECT * FROM fechas WHERE id = ?').get(fechaId);
  if (!fecha) return;

  const cruces = db.prepare('SELECT * FROM cruces WHERE fecha_id = ? AND ganador_fecha IS NOT NULL').all(fechaId);

  for (const cruce of cruces) {
    actualizarEntradaTabla(db, fecha.torneo_id, cruce.user1_id, cruce, 'user1');
    actualizarEntradaTabla(db, fecha.torneo_id, cruce.user2_id, cruce, 'user2');
  }
}

/**
 * Actualiza la entrada de la tabla general para un usuario en un torneo.
 * Recalcula desde cero todos los cruces del torneo para evitar doble conteo.
 */
function actualizarEntradaTabla(db, torneoId, userId, cruceActual, rol) {
  // Recalcular desde todos los cruces del torneo para este usuario
  const todosCruces = db.prepare(`
    SELECT c.* FROM cruces c
    JOIN fechas f ON c.fecha_id = f.id
    WHERE f.torneo_id = ? AND (c.user1_id = ? OR c.user2_id = ?)
    AND c.ganador_fecha IS NOT NULL
    AND f.estado = 'finalizada'
  `).all(torneoId, userId, userId);

  let puntos = 0, pj = 0, victorias = 0, empates = 0, derrotas = 0, bonus = 0;

  for (const c of todosCruces) {
    const esUser1 = c.user1_id === userId;
    const ganador = c.ganador_fecha;
    pj++;

    if (ganador === (esUser1 ? 'user1' : 'user2')) {
      victorias++;
      puntos += esUser1 ? c.pts_torneo_u1 : c.pts_torneo_u2;
      // Detectar si hubo bonus (victoria perfecta = 4 puntos)
      const ptsEste = esUser1 ? c.pts_torneo_u1 : c.pts_torneo_u2;
      if (ptsEste === 4) bonus++;
    } else if (ganador === 'empate') {
      empates++;
      puntos += 1;
    } else {
      derrotas++;
    }
  }

  // Upsert en tabla_torneo
  db.prepare(`
    INSERT INTO tabla_torneo (torneo_id, user_id, puntos, pj, victorias, empates, derrotas, bonus)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(torneo_id, user_id) DO UPDATE SET
      puntos = excluded.puntos,
      pj = excluded.pj,
      victorias = excluded.victorias,
      empates = excluded.empates,
      derrotas = excluded.derrotas,
      bonus = excluded.bonus
  `).run(torneoId, userId, puntos, pj, victorias, empates, derrotas, bonus);
}

/**
 * Calcula y persiste el resultado de un cruce en modo RESUMIDO.
 * No necesita eventos ni pronósticos — el admin indica directamente
 * quién ganó cada bloque.
 *
 * @param {Object} db
 * @param {number} cruceId
 * @param {'user1'|'user2'|'empate'} ganadorA  - Bloque Argentina
 * @param {'user1'|'user2'|'empate'} ganadorB  - Bloque Juanmar
 * @param {'user1'|'user2'|'empate'} ganadorGDT
 */
function calcularCruceResumido(db, cruceId, ganadorA, ganadorB, ganadorGDT) {
  // Puntos internos (misma lógica que modo completo):
  //   Bloque A = 1 pt, Bloque B = 1 pt, GDT = 2 pts
  let piU1 = 0, piU2 = 0;

  if (ganadorA === 'user1')   piU1 += 1;
  else if (ganadorA === 'user2') piU2 += 1;

  if (ganadorB === 'user1')   piU1 += 1;
  else if (ganadorB === 'user2') piU2 += 1;

  if (ganadorGDT === 'user1')   piU1 += 2;
  else if (ganadorGDT === 'user2') piU2 += 2;

  // Ganador de fecha
  let ganadorFecha;
  if (piU1 > piU2)      ganadorFecha = 'user1';
  else if (piU2 > piU1) ganadorFecha = 'user2';
  else                   ganadorFecha = 'empate';

  // Puntos de torneo: V=3, E=1, D=0; +1 si ganó los 3 bloques (victoria perfecta)
  let ptsTorneoU1 = 0, ptsTorneoU2 = 0;
  if (ganadorFecha === 'user1')      { ptsTorneoU1 = 3; }
  else if (ganadorFecha === 'user2') { ptsTorneoU2 = 3; }
  else { ptsTorneoU1 = 1; ptsTorneoU2 = 1; }

  if (ganadorA === 'user1' && ganadorB === 'user1' && ganadorGDT === 'user1') ptsTorneoU1 += 1;
  if (ganadorA === 'user2' && ganadorB === 'user2' && ganadorGDT === 'user2') ptsTorneoU2 += 1;

  // En modo resumido pts_tabla_a/b son simbólicos (1=ganó, 0=no) — solo para display
  const ptsAu1 = ganadorA === 'user1' ? 1 : 0;
  const ptsAu2 = ganadorA === 'user2' ? 1 : 0;
  const ptsBu1 = ganadorB === 'user1' ? 1 : 0;
  const ptsBu2 = ganadorB === 'user2' ? 1 : 0;

  // gdt_duelos: usamos sentinel -1 para indicar "GDT jugado en modo resumido"
  // Esto permite que recalcularCruces detecte que el GDT existe sin duelos reales
  const gdtDuelosU1 = ganadorGDT === 'user1' ? 11 : ganadorGDT === 'user2' ? 0 : 5;
  const gdtDuelosU2 = ganadorGDT === 'user2' ? 11 : ganadorGDT === 'user1' ? 0 : 5;

  db.prepare(`
    UPDATE cruces SET
      pts_tabla_a_u1 = ?, pts_tabla_a_u2 = ?,
      pts_tabla_b_u1 = ?, pts_tabla_b_u2 = ?,
      ganador_tabla_a = ?, ganador_tabla_b = ?,
      gdt_duelos_u1 = ?, gdt_duelos_u2 = ?, ganador_gdt = ?,
      puntos_internos_u1 = ?, puntos_internos_u2 = ?,
      ganador_fecha = ?,
      pts_torneo_u1 = ?, pts_torneo_u2 = ?
    WHERE id = ?
  `).run(
    ptsAu1, ptsAu2, ptsBu1, ptsBu2,
    ganadorA, ganadorB,
    gdtDuelosU1, gdtDuelosU2, ganadorGDT,
    piU1, piU2,
    ganadorFecha,
    ptsTorneoU1, ptsTorneoU2,
    cruceId
  );
}

/**
 * Recalcula la tabla_torneo completa de un torneo desde cero.
 * Útil después de eliminar una fecha para que los puntos queden correctos.
 */
function recalcularTablaTorneoCompleta(db, torneoId) {
  // Obtener todos los usuarios del torneo
  const jugadores = db.prepare(
    'SELECT user_id FROM torneo_jugadores WHERE torneo_id = ?'
  ).all(torneoId);

  for (const j of jugadores) {
    actualizarEntradaTabla(db, torneoId, j.user_id, null, null);
  }
}

module.exports = {
  calcularLEV,
  calcularPuntosPronostico,
  recalcularFecha,
  recalcularCruces,
  recalcularTablaGeneral,
  recalcularTablaTorneoCompleta,
  determinarGanador,
  calcularCruceResumido,
};
