const express = require('express');
const { getDb } = require('../db');
const { authMiddleware, adminMiddleware, requirePermiso } = require('../middleware/auth');
const { calcularLEV, recalcularFecha } = require('../logic/puntos');

const router = express.Router();

// GET /api/eventos/fecha/:fechaId
router.get('/fecha/:fechaId', authMiddleware, (req, res) => {
  const db = getDb();
  const eventos = db.prepare(
    'SELECT * FROM eventos WHERE fecha_id = ? ORDER BY orden'
  ).all(req.params.fechaId);
  res.json(eventos);
});

// POST /api/eventos - crear un evento
router.post('/', authMiddleware, adminMiddleware, (req, res) => {
  const {
    fecha_id, orden, tipo,
    evento, torneo_contexto, local, visitante, condicion,
    pts_local, pts_empate, pts_visitante, pts_exacto,
    pregunta_texto, opciones, opcion_correcta,
    config_json, resultado_json
  } = req.body;

  if (!fecha_id || !orden || !tipo) {
    return res.status(400).json({ error: 'fecha_id, orden y tipo son requeridos' });
  }
  if (orden < 1 || orden > 30) {
    return res.status(400).json({ error: 'El orden debe ser entre 1 y 30' });
  }

  const db = getDb();
  const fecha = db.prepare('SELECT * FROM fechas WHERE id = ?').get(fecha_id);
  if (!fecha) return res.status(404).json({ error: 'Fecha no encontrada' });

  const opcionesStr = opciones ? JSON.stringify(opciones) : null;
  const eventoVal = evento || torneo_contexto || null;

  try {
    const result = db.prepare(`
      INSERT INTO eventos (
        fecha_id, orden, tipo,
        evento, torneo_contexto, local, visitante, condicion,
        pts_local, pts_empate, pts_visitante, pts_exacto,
        pregunta_texto, opciones, opcion_correcta,
        config_json, resultado_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      fecha_id, orden, tipo,
      eventoVal, eventoVal,
      local || null, visitante || null, condicion || null,
      pts_local ?? 5, pts_empate ?? 5, pts_visitante ?? 5, pts_exacto ?? 5,
      pregunta_texto || null, opcionesStr, opcion_correcta || null,
      config_json || null, resultado_json || null
    );

    const evento_creado = db.prepare('SELECT * FROM eventos WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(evento_creado);
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: `Ya existe un evento con orden ${orden} en esta fecha` });
    }
    throw err;
  }
});

// PUT /api/eventos/fecha/:fechaId/bulk - cargar/actualizar los 30 eventos de una fecha
router.put('/fecha/:fechaId/bulk', authMiddleware, adminMiddleware, requirePermiso('editar_fecha'), (req, res) => {
  const { eventos } = req.body;
  if (!Array.isArray(eventos)) {
    return res.status(400).json({ error: 'Se espera un array de eventos' });
  }

  const db = getDb();
  const fecha = db.prepare('SELECT * FROM fechas WHERE id = ?').get(req.params.fechaId);
  if (!fecha) return res.status(404).json({ error: 'Fecha no encontrada' });

  const upsert = db.prepare(`
    INSERT INTO eventos (
      fecha_id, orden, tipo,
      evento, torneo_contexto, local, visitante, condicion,
      pts_local, pts_empate, pts_visitante, pts_exacto,
      pregunta_texto, opciones, opcion_correcta,
      config_json, resultado_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(fecha_id, orden) DO UPDATE SET
      tipo = excluded.tipo,
      evento = excluded.evento,
      torneo_contexto = excluded.torneo_contexto,
      local = excluded.local,
      visitante = excluded.visitante,
      condicion = excluded.condicion,
      pts_local = excluded.pts_local,
      pts_empate = excluded.pts_empate,
      pts_visitante = excluded.pts_visitante,
      pts_exacto = excluded.pts_exacto,
      pregunta_texto = excluded.pregunta_texto,
      opciones = excluded.opciones,
      opcion_correcta = excluded.opcion_correcta,
      config_json = excluded.config_json,
      resultado_json = excluded.resultado_json
  `);

  try {
    db.exec('BEGIN');
    for (const ev of eventos) {
      const opcionesStr = ev.opciones ? JSON.stringify(ev.opciones) : null;
      const eventoVal = ev.evento !== undefined ? ev.evento : (ev.torneo_contexto || null);
      upsert.run(
        req.params.fechaId, ev.orden, ev.tipo || 'partido',
        eventoVal, eventoVal,
        ev.local || null, ev.visitante || null, ev.condicion || null,
        ev.pts_local ?? 5, ev.pts_empate ?? 5, ev.pts_visitante ?? 5, ev.pts_exacto ?? 5,
        ev.pregunta_texto || null, opcionesStr, ev.opcion_correcta || null,
        ev.config_json || null, ev.resultado_json || null
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const result = db.prepare('SELECT * FROM eventos WHERE fecha_id = ? ORDER BY orden').all(req.params.fechaId);
  res.json(result);
});

// PATCH /api/eventos/:id - actualizar un evento
router.patch('/:id', authMiddleware, adminMiddleware, (req, res) => {
  const db = getDb();
  const evento = db.prepare('SELECT * FROM eventos WHERE id = ?').get(req.params.id);
  if (!evento) return res.status(404).json({ error: 'Evento no encontrado' });

  const {
    evento: eventoNombre, torneo_contexto,
    local, visitante, condicion,
    pts_local, pts_empate, pts_visitante, pts_exacto,
    resultado_local, resultado_visitante,
    pregunta_texto, opciones, opcion_correcta,
    config_json, resultado_json
  } = req.body;

  const updates = [];
  const values = [];

  const addField = (field, val) => {
    if (val !== undefined) { updates.push(`${field} = ?`); values.push(val); }
  };

  const eventoVal = eventoNombre !== undefined ? eventoNombre : torneo_contexto;
  if (eventoVal !== undefined) {
    addField('evento', eventoVal);
    addField('torneo_contexto', eventoVal);
  }

  addField('local', local);
  addField('visitante', visitante);
  addField('condicion', condicion);
  addField('pts_local', pts_local);
  addField('pts_empate', pts_empate);
  addField('pts_visitante', pts_visitante);
  addField('pts_exacto', pts_exacto);
  addField('pregunta_texto', pregunta_texto);
  addField('opcion_correcta', opcion_correcta);
  addField('config_json', config_json);
  addField('resultado_json', resultado_json);

  if (opciones !== undefined) {
    updates.push('opciones = ?');
    values.push(opciones ? JSON.stringify(opciones) : null);
  }

  // Resultado real de partido
  if (resultado_local !== undefined && resultado_visitante !== undefined) {
    const rl = parseInt(resultado_local);
    const rv = parseInt(resultado_visitante);
    if (isNaN(rl) || isNaN(rv) || rl < 0 || rv < 0) {
      return res.status(400).json({ error: 'Resultados inválidos' });
    }
    updates.push('resultado_local = ?'); values.push(rl);
    updates.push('resultado_visitante = ?'); values.push(rv);
    const lev = calcularLEV(rl, rv);
    updates.push('lev_real = ?'); values.push(lev);
  }

  if (updates.length === 0) return res.status(400).json({ error: 'Nada que actualizar' });

  values.push(req.params.id);
  db.prepare(`UPDATE eventos SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  // Recalcular al cargar resultado (partido o pregunta)
  if (resultado_local !== undefined || resultado_json !== undefined) {
    recalcularFecha(db, evento.fecha_id);
  }

  const updated = db.prepare('SELECT * FROM eventos WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// PUT /api/eventos/fecha/:fechaId/resultados - cargar resultados de partidos en bulk
router.put('/fecha/:fechaId/resultados', authMiddleware, adminMiddleware, requirePermiso('cargar_resultados'), (req, res) => {
  const { resultados } = req.body;
  if (!Array.isArray(resultados)) {
    return res.status(400).json({ error: 'Se espera un array de resultados' });
  }

  const db = getDb();
  const updateRes = db.prepare(
    'UPDATE eventos SET resultado_local = ?, resultado_visitante = ?, lev_real = ? WHERE id = ? AND fecha_id = ?'
  );

  try {
    db.exec('BEGIN');
    for (const r of resultados) {
      const rl = parseInt(r.resultado_local);
      const rv = parseInt(r.resultado_visitante);
      if (!isNaN(rl) && !isNaN(rv)) {
        const lev = calcularLEV(rl, rv);
        updateRes.run(rl, rv, lev, r.evento_id, req.params.fechaId);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  recalcularFecha(db, req.params.fechaId);

  const eventos = db.prepare('SELECT * FROM eventos WHERE fecha_id = ? ORDER BY orden').all(req.params.fechaId);
  res.json(eventos);
});

module.exports = router;
