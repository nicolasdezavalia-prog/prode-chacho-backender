const express = require('express');
const { getDb } = require('../db');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');
const { recalcularFecha, recalcularTablaTorneoCompleta } = require('../logic/puntos');

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
  const { torneo_id, nombre, numero, mes, anio, bloque1_nombre, bloque2_nombre, tipo } = req.body;
  if (!torneo_id || !nombre || !numero || !mes || !anio) {
    return res.status(400).json({ error: 'Faltan campos requeridos' });
  }

  const tiposValidos = ['completa', 'resumida'];
  const tipoFinal = tiposValidos.includes(tipo) ? tipo : 'completa';

  const db = getDb();
  const result = db.prepare(`
    INSERT INTO fechas (torneo_id, nombre, numero, mes, anio, bloque1_nombre, bloque2_nombre, tipo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    torneo_id, nombre, numero, mes, anio,
    bloque1_nombre || 'Bloque 1',
    bloque2_nombre || 'Bloque 2',
    tipoFinal
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

  const { estado, nombre, bloque1_nombre, bloque2_nombre, tipo, mes, anio } = req.body;
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

  if (updates.length === 0) return res.status(400).json({ error: 'Nada que actualizar' });

  values.push(req.params.id);
  db.prepare(`UPDATE fechas SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  // Si la fecha pasa a 'finalizada', recalcular puntos + cruces + tabla general
  if (estado === 'finalizada') {
    recalcularFecha(db, parseInt(req.params.id));
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

  recalcularFecha(db, fecha.id);

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
