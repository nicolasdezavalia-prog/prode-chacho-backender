const express = require('express');
const { getDb } = require('../db');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');
const { calcularLEV, calcularPuntosPronostico, recalcularFecha, recalcularCruces } = require('../logic/puntos');

const router = express.Router();

// GET /api/pronosticos/fecha/:fechaId - obtener pronósticos de la fecha para el usuario actual
router.get('/fecha/:fechaId', authMiddleware, (req, res) => {
  const db = getDb();
  const userId = req.query.user_id ? parseInt(req.query.user_id) : req.user.id;

  // Si piden pronósticos de otro usuario, verificar que la fecha esté cerrada/finalizada
  if (userId !== req.user.id && req.user.role !== 'admin' && req.user.role !== 'superadmin') {
    const fecha = db.prepare('SELECT estado FROM fechas WHERE id = ?').get(req.params.fechaId);
    if (!fecha || (fecha.estado !== 'cerrada' && fecha.estado !== 'finalizada')) {
      return res.status(403).json({ error: 'Los pronósticos de otros jugadores solo son visibles cuando la fecha está cerrada o finalizada' });
    }
  }

  const pronosticos = db.prepare(`
    SELECT p.*, e.orden, e.tipo, e.local, e.visitante, e.lev_real, e.resultado_local, e.resultado_visitante
    FROM pronosticos p
    JOIN eventos e ON p.evento_id = e.id
    WHERE e.fecha_id = ? AND p.user_id = ?
    ORDER BY e.orden
  `).all(req.params.fechaId, userId);

  res.json(pronosticos);
});

// GET /api/pronosticos/fecha/:fechaId/todos - todos los pronósticos de la fecha (admin)
// Incluye tipo, config_json y pregunta_texto para que AdminResultados pueda mostrar respuestas abiertas
router.get('/fecha/:fechaId/todos', authMiddleware, adminMiddleware, (req, res) => {
  const db = getDb();
  const pronosticos = db.prepare(`
    SELECT p.*,
           u.nombre AS usuario_nombre,
           e.orden, e.tipo, e.local, e.visitante,
           e.pregunta_texto, e.config_json
    FROM pronosticos p
    JOIN eventos e ON p.evento_id = e.id
    JOIN users u ON p.user_id = u.id
    WHERE e.fecha_id = ?
    ORDER BY e.orden, u.nombre
  `).all(req.params.fechaId);

  res.json(pronosticos);
});

// PATCH /api/pronosticos/:id/puntos - asignar puntaje manual (solo admin, para preguntas abiertas)
router.patch('/:id/puntos', authMiddleware, adminMiddleware, (req, res) => {
  const { puntos } = req.body;
  if (puntos === undefined || puntos === null || isNaN(parseInt(puntos))) {
    return res.status(400).json({ error: 'puntos es requerido y debe ser un número' });
  }
  const pts = Math.max(0, parseInt(puntos));

  const db = getDb();
  const pron = db.prepare(`
    SELECT p.*, e.fecha_id, e.config_json, e.tipo
    FROM pronosticos p
    JOIN eventos e ON p.evento_id = e.id
    WHERE p.id = ?
  `).get(req.params.id);

  if (!pron) return res.status(404).json({ error: 'Pronóstico no encontrado' });

  // Validar que sea una pregunta abierta y aplicar límites de pts_max
  if (pron.tipo === 'pregunta') {
    try {
      const cfg = pron.config_json ? JSON.parse(pron.config_json) : {};
      if (cfg.subtipo !== 'abierta') {
        return res.status(400).json({ error: 'Solo las preguntas abiertas admiten corrección manual' });
      }
      // Respetar pts_max si está definido
      if (cfg.pts_max !== undefined && cfg.pts_max !== null) {
        const max = parseInt(cfg.pts_max);
        if (!isNaN(max) && pts > max) {
          return res.status(400).json({
            error: `El puntaje no puede superar el máximo de ${max} pts para esta pregunta`
          });
        }
      }
    } catch (_) {}
  }

  db.prepare('UPDATE pronosticos SET puntos_obtenidos = ? WHERE id = ?').run(pts, pron.id);

  // Recalcular cruces (no recalcularFecha completo, ya que preservamos los demás puntos)
  recalcularCruces(db, pron.fecha_id);

  const updated = db.prepare('SELECT * FROM pronosticos WHERE id = ?').get(pron.id);
  res.json(updated);
});

// PATCH /api/pronosticos/:id/lev — corregir lev_pronostico manualmente (solo admin)
// Útil cuando el usuario puso un LEV override pero se perdió al recargar y volver a guardar
router.patch('/:id/lev', authMiddleware, adminMiddleware, (req, res) => {
  const { lev } = req.body;
  if (!['L', 'E', 'V'].includes(lev)) {
    return res.status(400).json({ error: 'lev debe ser L, E o V' });
  }

  const db = getDb();
  const pron = db.prepare(`
    SELECT p.*, e.fecha_id FROM pronosticos p
    JOIN eventos e ON p.evento_id = e.id
    WHERE p.id = ?
  `).get(req.params.id);

  if (!pron) return res.status(404).json({ error: 'Pronóstico no encontrado' });

  db.prepare('UPDATE pronosticos SET lev_pronostico = ?, lev_manual = 1 WHERE id = ?').run(lev, pron.id);

  // Recalcular puntos de este pronóstico en base al nuevo LEV
  recalcularFecha(db, pron.fecha_id);

  const updated = db.prepare('SELECT * FROM pronosticos WHERE id = ?').get(pron.id);
  res.json(updated);
});

// POST /api/pronosticos - guardar pronóstico de un evento
router.post('/', authMiddleware, (req, res) => {
  const { evento_id, goles_local, goles_visitante, opcion_elegida } = req.body;
  if (!evento_id) return res.status(400).json({ error: 'evento_id es requerido' });

  const db = getDb();
  const evento = db.prepare(`
    SELECT e.*, f.estado FROM eventos e
    JOIN fechas f ON e.fecha_id = f.id
    WHERE e.id = ?
  `).get(evento_id);

  if (!evento) return res.status(404).json({ error: 'Evento no encontrado' });

  // Solo se puede cargar pronóstico si la fecha está abierta (o si es superadmin)
  if (evento.estado !== 'abierta' && req.user.role !== 'superadmin') {
    return res.status(400).json({ error: 'La fecha no está abierta para carga de pronósticos' });
  }

  let levPron = null;
  let puntos = 0;

  if (evento.tipo === 'partido') {
    const gl = parseInt(goles_local);
    const gv = parseInt(goles_visitante);
    if (isNaN(gl) || isNaN(gv) || gl < 0 || gv < 0) {
      return res.status(400).json({ error: 'Resultado inválido' });
    }
    levPron = calcularLEV(gl, gv);

    // Si ya hay resultado real, calcular puntos inmediatamente
    if (evento.lev_real) {
      puntos = calcularPuntosPronostico(evento, {
        lev_pronostico: levPron,
        goles_local: gl,
        goles_visitante: gv
      });
    }

    db.prepare(`
      INSERT INTO pronosticos (evento_id, user_id, goles_local, goles_visitante, lev_pronostico, puntos_obtenidos)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(evento_id, user_id) DO UPDATE SET
        goles_local = excluded.goles_local,
        goles_visitante = excluded.goles_visitante,
        lev_pronostico = excluded.lev_pronostico,
        puntos_obtenidos = excluded.puntos_obtenidos
    `).run(evento_id, req.user.id, gl, gv, levPron, puntos);
  } else if (evento.tipo === 'pregunta') {
    if (!opcion_elegida) return res.status(400).json({ error: 'opcion_elegida es requerida' });

    // Validar que sea una opción válida
    if (evento.opciones) {
      const opciones = JSON.parse(evento.opciones);
      if (!opciones.includes(opcion_elegida)) {
        return res.status(400).json({ error: 'Opción inválida' });
      }
    }

    if (evento.opcion_correcta) {
      puntos = opcion_elegida === evento.opcion_correcta ? (evento.pts_local || 0) : 0;
    }

    db.prepare(`
      INSERT INTO pronosticos (evento_id, user_id, opcion_elegida, puntos_obtenidos)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(evento_id, user_id) DO UPDATE SET
        opcion_elegida = excluded.opcion_elegida,
        puntos_obtenidos = excluded.puntos_obtenidos
    `).run(evento_id, req.user.id, opcion_elegida, puntos);
  }

  const saved = db.prepare('SELECT * FROM pronosticos WHERE evento_id = ? AND user_id = ?').get(evento_id, req.user.id);
  res.status(201).json(saved);
});

// POST /api/pronosticos/fecha/:fechaId/bulk - guardar múltiples pronósticos a la vez
router.post('/fecha/:fechaId/bulk', authMiddleware, (req, res) => {
  const { pronosticos } = req.body;
  if (!Array.isArray(pronosticos)) {
    return res.status(400).json({ error: 'Se espera un array de pronosticos' });
  }

  const db = getDb();
  const fecha = db.prepare(`SELECT * FROM fechas WHERE id = ?`).get(req.params.fechaId);
  if (!fecha) return res.status(404).json({ error: 'Fecha no encontrada' });

  if (fecha.estado !== 'abierta' && req.user.role !== 'superadmin') {
    return res.status(400).json({ error: 'La fecha no está abierta para carga de pronósticos' });
  }

  const upsertPartido = db.prepare(`
    INSERT INTO pronosticos (evento_id, user_id, goles_local, goles_visitante, lev_pronostico, lev_manual, puntos_obtenidos, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, datetime('now'))
    ON CONFLICT(evento_id, user_id) DO UPDATE SET
      goles_local = excluded.goles_local,
      goles_visitante = excluded.goles_visitante,
      lev_pronostico = excluded.lev_pronostico,
      lev_manual = excluded.lev_manual,
      puntos_obtenidos = 0,
      updated_at = datetime('now')
  `);

  // Para preguntas: al actualizar la respuesta se resetean los puntos a 0.
  // Esto es seguro porque el jugador solo puede guardar cuando la fecha está abierta,
  // y el admin corrige manualmente solo después de cerrar la fecha.
  const upsertPregunta = db.prepare(`
    INSERT INTO pronosticos (evento_id, user_id, opcion_elegida, puntos_obtenidos, updated_at)
    VALUES (?, ?, ?, 0, datetime('now'))
    ON CONFLICT(evento_id, user_id) DO UPDATE SET
      opcion_elegida = excluded.opcion_elegida,
      puntos_obtenidos = 0,
      updated_at = datetime('now')
  `);

  try {
    db.exec('BEGIN');
    for (const p of pronosticos) {
      const evento = db.prepare('SELECT * FROM eventos WHERE id = ? AND fecha_id = ?').get(p.evento_id, req.params.fechaId);
      if (!evento) continue;

      if (evento.tipo === 'partido' && p.goles_local !== undefined && p.goles_visitante !== undefined) {
        const gl = parseInt(p.goles_local);
        const gv = parseInt(p.goles_visitante);
        if (!isNaN(gl) && !isNaN(gv) && gl >= 0 && gv >= 0) {
          const levCalculado = calcularLEV(gl, gv);
          // Si viene lev_pronostico explícito y difiere del calculado → es manual
          const levFinal = p.lev_pronostico || levCalculado;
          const esManual = p.lev_pronostico && p.lev_pronostico !== levCalculado ? 1 : 0;
          upsertPartido.run(p.evento_id, req.user.id, gl, gv, levFinal, esManual);
        }
      } else if (evento.tipo === 'pregunta' && p.opcion_elegida !== undefined && p.opcion_elegida !== '') {
        upsertPregunta.run(p.evento_id, req.user.id, p.opcion_elegida);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  // Si hay resultados cargados, recalcular
  recalcularFecha(db, req.params.fechaId);

  const saved = db.prepare(`
    SELECT p.*, e.orden FROM pronosticos p
    JOIN eventos e ON p.evento_id = e.id
    WHERE e.fecha_id = ? AND p.user_id = ?
    ORDER BY e.orden
  `).all(req.params.fechaId, req.user.id);

  res.json(saved);
});

// GET /api/pronosticos/fecha/:fechaId/estado - cuántos pronósticos cargó el usuario
router.get('/fecha/:fechaId/estado', authMiddleware, (req, res) => {
  const db = getDb();
  const totalEventos = db.prepare('SELECT COUNT(*) as total FROM eventos WHERE fecha_id = ?').get(req.params.fechaId);
  const totalPronos = db.prepare(`
    SELECT COUNT(*) as total FROM pronosticos p
    JOIN eventos e ON p.evento_id = e.id
    WHERE e.fecha_id = ? AND p.user_id = ?
  `).get(req.params.fechaId, req.user.id);

  res.json({
    total_eventos: totalEventos.total,
    cargados: totalPronos.total,
    pendientes: totalEventos.total - totalPronos.total,
    completo: totalPronos.total === totalEventos.total
  });
});

module.exports = router;
