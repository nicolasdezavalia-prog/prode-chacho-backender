const express = require('express');
const { getDb } = require('../db');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');
const { recalcularFecha, recalcularTablaTorneoCompleta, generarMovimientosCruce } = require('../logic/puntos');

const router = express.Router();

// GET /api/torneos/:torneoId/fechas
router.get('/torneo/:torneoId', authMiddleware, (req, res) => {
  const db = getDb();
  const fechas = db.prepare(
    'SELECT * FROM fechas WHERE torneo_id = ? ORDER BY numero ASC'
  ).all(req.params.torneoId);
  res.json(fechas);
});

// POST /api/fechas - crear fecha
router.post('/', authMiddleware, adminMiddleware, (req, res) => {
  const { torneo_id, nombre, numero, mes, anio, bloque1_nombre, bloque2_nombre, tipo, importe_apuesta, deadline } = req.body;
  if (!torneo_id || !nombre || !numero || !mes || !anio) {
    return res.status(400).json({ error: 'Faltan campos requeridos' });
  }

  const tiposValidos = ['completa', 'resumida'];
  const tipoFinal = tiposValidos.includes(tipo) ? tipo : 'completa';
  const importeFinal = importe_apuesta ? parseInt(importe_apuesta) : null;
  const deadlineFinal = deadline || null;

  const db = getDb();
  const result = db.prepare(`
    INSERT INTO fechas (torneo_id, nombre, numero, mes, anio, bloque1_nombre, bloque2_nombre, tipo, importe_apuesta, deadline)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    torneo_id, nombre, numero, mes, anio,
    bloque1_nombre || 'Bloque 1',
    bloque2_nombre || 'Bloque 2',
    tipoFinal,
    importeFinal,
    deadlineFinal
  );

  const fecha = db.prepare('SELECT * FROM fechas WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(fecha);
});

// GET /api/fechas/:id
router.get('/:id', authMiddleware, (req, res) => {
  const db = getDb();
  const fecha = db.prepare('SELECT * FROM fechas WHERE id = ?').get(req.params.id);
  if (!fecha) return res.status(404).json({ error: 'Fecha no encontrada' });

  const eventos = db.prepare('SELECT * FROM eventos WHERE fecha_id = ? ORDER BY orden').all(fecha.id);
  const cruces = db.prepare('SELECT * FROM cruces WHERE fecha_id = ?').all(fecha.id);

  res.json({ ...fecha, eventos, cruces });
});

// PATCH /api/fechas/:id - actualizar estado u otros campos
router.patch('/:id', authMiddleware, adminMiddleware, (req, res) => {
  const db = getDb();
  const fecha = db.prepare('SELECT * FROM fechas WHERE id = ?').get(req.params.id);
  if (!fecha) return res.status(404).json({ error: 'Fecha no encontrada' });

  const { estado, nombre, bloque1_nombre, bloque2_nombre, tipo, mes, anio, importe_apuesta, deadline } = req.body;
  const updates = [];
  const values = [];

  if (estado) {
    const estadosValidos = ['borrador', 'abierta', 'cerrada', 'finalizada'];
    if (!estadosValidos.includes(estado)) {
      return res.status(400).json({ error: 'Estado inválido' });
    }
    updates.push('estado = ?'); values.push(estado);
  }
  if (nombre) { updates.push('nombre = ?'); values.push(nombre); }
  if (bloque1_nombre) { updates.push('bloque1_nombre = ?'); values.push(bloque1_nombre); }
  if (bloque2_nombre) { updates.push('bloque2_nombre = ?'); values.push(bloque2_nombre); }
  if (tipo) {
    const tiposValidos = ['completa', 'resumida'];
    if (!tiposValidos.includes(tipo)) {
      return res.status(400).json({ error: 'Tipo inválido' });
    }
    updates.push('tipo = ?'); values.push(tipo);
  }
  if (mes !== undefined) { updates.push('mes = ?'); values.push(parseInt(mes)); }
  if (anio !== undefined) { updates.push('anio = ?'); values.push(parseInt(anio)); }
  if (importe_apuesta !== undefined) {
    updates.push('importe_apuesta = ?');
    values.push(importe_apuesta === null || importe_apuesta === '' ? null : parseInt(importe_apuesta));
  }
  if (deadline !== undefined) {
    updates.push('deadline = ?');
    values.push(deadline === null || deadline === '' ? null : deadline);
  }

  if (updates.length === 0) return res.status(400).json({ error: 'Nada que actualizar' });

  values.push(req.params.id);
  db.prepare(`UPDATE fechas SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  // Si la fecha pasa a 'finalizada', recalcular puntos + cruces + tabla general
  if (estado === 'finalizada') {
    const fechaActualizada = db.prepare('SELECT * FROM fechas WHERE id = ?').get(req.params.id);
    if (fechaActualizada.tipo === 'resumida') {
      recalcularTablaTorneoCompleta(db, fechaActualizada.torneo_id);
      const cruces = db.prepare('SELECT * FROM cruces WHERE fecha_id = ? AND ganador_fecha IS NOT NULL').all(fechaActualizada.id);
      for (const cruce of cruces) {
        generarMovimientosCruce(db, cruce.id, cruce.user1_id, cruce.user2_id, cruce.ganador_fecha, fechaActualizada);
      }
    } else {
      recalcularFecha(db, parseInt(req.params.id));
    }
  } else if (estado && estado !== fecha.estado) {
    // Si la fecha salió de 'finalizada' (o cambió a un estado no-finalizada),
    // limpiar cualquier deuda pendiente ligada a sus cruces. Las deudas solo
    // deben existir mientras la fecha está finalizada. Los pagos ya confirmados
    // se preservan como histórico.
    db.prepare(`
      DELETE FROM movimientos_economicos
      WHERE pagado = 0
        AND tipo IN ('empate_pozo', 'deuda_rival')
        AND fecha_id = ?
    `).run(req.params.id);
  }

  const updated = db.prepare('SELECT * FROM fechas WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// DELETE /api/fechas/:id
router.delete('/:id', authMiddleware, adminMiddleware, (req, res) => {
  const db = getDb();
  // Solo se puede borrar una fecha en borrador
  const fecha = db.prepare('SELECT * FROM fechas WHERE id = ?').get(req.params.id);
  if (!fecha) return res.status(404).json({ error: 'Fecha no encontrada' });

  const torneoId = fecha.torneo_id;

  db.prepare('DELETE FROM pronosticos WHERE evento_id IN (SELECT id FROM eventos WHERE fecha_id = ?)').run(req.params.id);
  db.prepare('DELETE FROM eventos WHERE fecha_id = ?').run(req.params.id);
  db.prepare('DELETE FROM cruces WHERE fecha_id = ?').run(req.params.id);
  db.prepare('DELETE FROM fechas WHERE id = ?').run(req.params.id);

  // Recalcular tabla del torneo completa desde cero (sin los cruces de la fecha eliminada)
  recalcularTablaTorneoCompleta(db, torneoId);

  res.json({ message: 'Fecha eliminada y tabla recalculada' });
});

// GET /api/fechas/:id/deadline-cumplimiento - estado de cumplimiento de deadline por jugador
router.get('/:id/deadline-cumplimiento', authMiddleware, adminMiddleware, (req, res) => {
  const db = getDb();
  const fecha = db.prepare('SELECT * FROM fechas WHERE id = ?').get(req.params.id);
  if (!fecha) return res.status(404).json({ error: 'Fecha no encontrada' });
  if (!fecha.deadline) return res.status(400).json({ error: 'Esta fecha no tiene deadline' });

  // Jugadores del torneo
  const jugadores = db.prepare(`
    SELECT u.id, u.nombre
    FROM torneo_jugadores tj
    JOIN users u ON tj.user_id = u.id
    WHERE tj.torneo_id = ?
    ORDER BY u.nombre ASC
  `).all(fecha.torneo_id);

  // Total de eventos de la fecha
  const { total_eventos } = db.prepare(
    'SELECT COUNT(*) AS total_eventos FROM eventos WHERE fecha_id = ?'
  ).get(fecha.id);

  // Pronósticos agrupados por usuario (count + max updated_at)
  const pronosRows = db.prepare(`
    SELECT p.user_id,
           COUNT(*) AS total_pronos,
           MAX(p.updated_at) AS ultimo_at
    FROM pronosticos p
    JOIN eventos e ON p.evento_id = e.id
    WHERE e.fecha_id = ?
    GROUP BY p.user_id
  `).all(fecha.id);
  const pronoMap = {};
  for (const r of pronosRows) pronoMap[r.user_id] = r;

  // Multas de deadline ya cargadas para esta fecha
  const multasRows = db.prepare(`
    SELECT user_id, SUM(importe) AS importe_total
    FROM movimientos_economicos
    WHERE fecha_id = ? AND tipo = 'multa_deadline'
    GROUP BY user_id
  `).all(fecha.id);
  const multaMap = {};
  for (const r of multasRows) multaMap[r.user_id] = r.importe_total;

  const deadline = new Date(fecha.deadline);

  const resultado = jugadores.map(j => {
    const p = pronoMap[j.id];
    const total_pronos = p ? p.total_pronos : 0;
    const ultimo_at = p ? p.ultimo_at : null;

    let estado;
    if (total_pronos < total_eventos) {
      estado = 'incompleto';
    } else if (ultimo_at && new Date(ultimo_at) > deadline) {
      estado = 'fuera_de_termino';
    } else {
      estado = 'ok';
    }

    return {
      user_id: j.id,
      nombre: j.nombre,
      total_eventos,
      total_pronos,
      ultimo_at,
      estado,
      ya_multado: !!multaMap[j.id],
      importe_multa: multaMap[j.id] || 0,
    };
  });

  res.json({ deadline: fecha.deadline, jugadores: resultado });
});

// POST /api/fechas/:id/recalcular - forzar recálculo
router.post('/:id/recalcular', authMiddleware, adminMiddleware, (req, res) => {
  const db = getDb();
  const fecha = db.prepare('SELECT * FROM fechas WHERE id = ?').get(req.params.id);
  if (!fecha) return res.status(404).json({ error: 'Fecha no encontrada' });

  // Diagnóstico previo
  const eventos   = db.prepare('SELECT COUNT(*) as n FROM eventos WHERE fecha_id = ?').get(fecha.id);
  const cruces    = db.prepare('SELECT COUNT(*) as n FROM cruces WHERE fecha_id = ?').get(fecha.id);
  const pronosticos = db.prepare(
    'SELECT COUNT(*) as n FROM pronosticos WHERE evento_id IN (SELECT id FROM eventos WHERE fecha_id = ?)'
  ).get(fecha.id);

  if (fecha.tipo === 'resumida') {
    // Fechas resumidas: los cruces ya están cargados vía "Resultados resumidos".
    // Recalcular tabla general y regenerar movimientos económicos para cada cruce con resultado.
    recalcularTablaTorneoCompleta(db, fecha.torneo_id);
    const cruces = db.prepare('SELECT * FROM cruces WHERE fecha_id = ? AND ganador_fecha IS NOT NULL').all(fecha.id);
    for (const cruce of cruces) {
      generarMovimientosCruce(db, cruce.id, cruce.user1_id, cruce.user2_id, cruce.ganador_fecha, fecha);
    }
  } else {
    recalcularFecha(db, fecha.id);
  }

  // Diagnóstico posterior
  const crucesPost = db.prepare(
    'SELECT user1_id, user2_id, ganador_fecha, pts_torneo_u1, pts_torneo_u2 FROM cruces WHERE fecha_id = ?'
  ).all(fecha.id);

  res.json({
    message: 'Recálculo completado',
    estado: fecha.estado,
    eventos: eventos.n,
    cruces: cruces.n,
    pronosticos: pronosticos.n,
    resultado_cruces: crucesPost,
  });
});

module.exports = router;
