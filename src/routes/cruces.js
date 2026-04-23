const express = require('express');
const { getDb } = require('../db');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');
const { recalcularCruces, calcularCruceResumido, recalcularTablaGeneral } = require('../logic/puntos');

// ─── MODO RESUMIDO ────────────────────────────────────────────────────────────

const router = express.Router();

// GET /api/cruces/fecha/:fechaId - obtener cruces de una fecha
router.get('/fecha/:fechaId', authMiddleware, (req, res) => {
  const db = getDb();
  const fechaId = req.params.fechaId;
  const cruces = db.prepare(`
    SELECT c.*,
      u1.nombre as user1_nombre,
      u2.nombre as user2_nombre,
      env1.envio as envio_u1,
      env2.envio as envio_u2
    FROM cruces c
    JOIN users u1 ON c.user1_id = u1.id
    JOIN users u2 ON c.user2_id = u2.id
    LEFT JOIN (
      SELECT p.user_id, MAX(p.updated_at) as envio
      FROM pronosticos p
      JOIN eventos e ON p.evento_id = e.id
      WHERE e.fecha_id = ?
      GROUP BY p.user_id
    ) env1 ON env1.user_id = c.user1_id
    LEFT JOIN (
      SELECT p.user_id, MAX(p.updated_at) as envio
      FROM pronosticos p
      JOIN eventos e ON p.evento_id = e.id
      WHERE e.fecha_id = ?
      GROUP BY p.user_id
    ) env2 ON env2.user_id = c.user2_id
    WHERE c.fecha_id = ?
    ORDER BY c.id
  `).all(fechaId, fechaId, fechaId);

  res.json(cruces);
});

// GET /api/cruces/fecha/:fechaId/mio - obtener el cruce del usuario actual en esta fecha
router.get('/fecha/:fechaId/mio', authMiddleware, (req, res) => {
  const db = getDb();
  const userId = req.user.id;

  const cruce = db.prepare(`
    SELECT c.*,
      u1.nombre as user1_nombre,
      u2.nombre as user2_nombre
    FROM cruces c
    JOIN users u1 ON c.user1_id = u1.id
    JOIN users u2 ON c.user2_id = u2.id
    WHERE c.fecha_id = ? AND (c.user1_id = ? OR c.user2_id = ?)
  `).get(req.params.fechaId, userId, userId);

  if (!cruce) return res.status(404).json({ error: 'No hay cruce asignado para esta fecha' });

  // Determinar cuál es "yo" y cuál es "rival"
  const esUser1 = cruce.user1_id === userId;
  const resultado = {
    ...cruce,
    yo_id: userId,
    rival_id: esUser1 ? cruce.user2_id : cruce.user1_id,
    yo_nombre: esUser1 ? cruce.user1_nombre : cruce.user2_nombre,
    rival_nombre: esUser1 ? cruce.user2_nombre : cruce.user1_nombre,
    yo_pts_tabla_a: esUser1 ? cruce.pts_tabla_a_u1 : cruce.pts_tabla_a_u2,
    rival_pts_tabla_a: esUser1 ? cruce.pts_tabla_a_u2 : cruce.pts_tabla_a_u1,
    yo_pts_tabla_b: esUser1 ? cruce.pts_tabla_b_u1 : cruce.pts_tabla_b_u2,
    rival_pts_tabla_b: esUser1 ? cruce.pts_tabla_b_u2 : cruce.pts_tabla_b_u1,
    yo_ganador_tabla_a: cruce.ganador_tabla_a === (esUser1 ? 'user1' : 'user2'),
    yo_ganador_tabla_b: cruce.ganador_tabla_b === (esUser1 ? 'user1' : 'user2'),
    yo_puntos_internos: esUser1 ? cruce.puntos_internos_u1 : cruce.puntos_internos_u2,
    rival_puntos_internos: esUser1 ? cruce.puntos_internos_u2 : cruce.puntos_internos_u1,
    yo_ganador_gdt: cruce.ganador_gdt === (esUser1 ? 'user1' : 'user2'),
    yo_gdt_duelos: esUser1 ? cruce.gdt_duelos_u1 : cruce.gdt_duelos_u2,
    rival_gdt_duelos: esUser1 ? cruce.gdt_duelos_u2 : cruce.gdt_duelos_u1,
    yo_ganador_fecha: cruce.ganador_fecha === (esUser1 ? 'user1' : 'user2') ||
                      (cruce.ganador_fecha === 'empate' ? 'empate' : false),
    yo_pts_torneo: esUser1 ? cruce.pts_torneo_u1 : cruce.pts_torneo_u2,
    yo_es_user1: esUser1,
  };

  res.json(resultado);
});

// GET /api/cruces/torneo/:torneoId/mios - todos los cruces del usuario en el torneo
router.get('/torneo/:torneoId/mios', authMiddleware, (req, res) => {
  const db = getDb();
  const userId = req.user.id;

  const cruces = db.prepare(`
    SELECT c.*,
      f.nombre AS fecha_nombre, f.numero AS fecha_numero,
      f.mes, f.anio, f.estado AS fecha_estado,
      u1.nombre AS user1_nombre,
      u2.nombre AS user2_nombre
    FROM cruces c
    JOIN fechas f ON c.fecha_id = f.id
    JOIN users u1 ON c.user1_id = u1.id
    JOIN users u2 ON c.user2_id = u2.id
    WHERE f.torneo_id = ? AND (c.user1_id = ? OR c.user2_id = ?)
    ORDER BY f.numero DESC
  `).all(req.params.torneoId, userId, userId);

  const resultado = cruces.map(c => {
    const esUser1 = c.user1_id === userId;
    return {
      ...c,
      yo_id:                userId,
      rival_id:             esUser1 ? c.user2_id : c.user1_id,
      yo_nombre:            esUser1 ? c.user1_nombre : c.user2_nombre,
      rival_nombre:         esUser1 ? c.user2_nombre : c.user1_nombre,
      yo_pts_tabla_a:       esUser1 ? c.pts_tabla_a_u1 : c.pts_tabla_a_u2,
      rival_pts_tabla_a:    esUser1 ? c.pts_tabla_a_u2 : c.pts_tabla_a_u1,
      yo_pts_tabla_b:       esUser1 ? c.pts_tabla_b_u1 : c.pts_tabla_b_u2,
      rival_pts_tabla_b:    esUser1 ? c.pts_tabla_b_u2 : c.pts_tabla_b_u1,
      yo_ganador_tabla_a:   c.ganador_tabla_a === (esUser1 ? 'user1' : 'user2'),
      yo_ganador_tabla_b:   c.ganador_tabla_b === (esUser1 ? 'user1' : 'user2'),
      yo_puntos_internos:   esUser1 ? c.puntos_internos_u1 : c.puntos_internos_u2,
      rival_puntos_internos: esUser1 ? c.puntos_internos_u2 : c.puntos_internos_u1,
      yo_gdt_duelos:        esUser1 ? c.gdt_duelos_u1 : c.gdt_duelos_u2,
      rival_gdt_duelos:     esUser1 ? c.gdt_duelos_u2 : c.gdt_duelos_u1,
      yo_ganador_gdt:       c.ganador_gdt === (esUser1 ? 'user1' : 'user2'),
      yo_pts_torneo:        esUser1 ? c.pts_torneo_u1 : c.pts_torneo_u2,
      yo_ganador_fecha:     c.ganador_fecha === (esUser1 ? 'user1' : 'user2'),
      yo_es_user1:          esUser1,
    };
  });

  res.json(resultado);
});

// POST /api/cruces/fecha/:fechaId - definir fixture de cruces (admin)
router.post('/fecha/:fechaId', authMiddleware, adminMiddleware, (req, res) => {
  const { cruces } = req.body;
  // cruces: [{user1_id, user2_id}, ...]
  if (!Array.isArray(cruces)) {
    return res.status(400).json({ error: 'Se espera un array de cruces' });
  }

  const db = getDb();
  const fecha = db.prepare('SELECT * FROM fechas WHERE id = ?').get(req.params.fechaId);
  if (!fecha) return res.status(404).json({ error: 'Fecha no encontrada' });

  // Validar que no se repitan usuarios
  const usuariosEnCruces = cruces.flatMap(c => [c.user1_id, c.user2_id]);
  const unique = new Set(usuariosEnCruces);
  if (unique.size !== usuariosEnCruces.length) {
    return res.status(400).json({ error: 'Un usuario no puede estar en más de un cruce por fecha' });
  }

  const insert = db.prepare(
    'INSERT INTO cruces (fecha_id, user1_id, user2_id) VALUES (?, ?, ?)'
  );

  // DELETE + INSERT atómicos: si algo falla, preservamos los cruces previos.
  // Además limpiamos movimientos no pagados asociados a los cruces viejos
  // (deuda_rival / empate_pozo) — esos se regeneran al recalcular.
  // Los movimientos ya pagados se preservan como historial.
  try {
    db.exec('BEGIN');
    db.prepare(`
      DELETE FROM movimientos_economicos
      WHERE pagado = 0
        AND cruce_id IN (SELECT id FROM cruces WHERE fecha_id = ?)
    `).run(req.params.fechaId);
    db.prepare('DELETE FROM cruces WHERE fecha_id = ?').run(req.params.fechaId);
    for (const c of cruces) {
      insert.run(req.params.fechaId, c.user1_id, c.user2_id);
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw err;
  }

  const result = db.prepare(`
    SELECT c.*, u1.nombre as user1_nombre, u2.nombre as user2_nombre
    FROM cruces c
    JOIN users u1 ON c.user1_id = u1.id
    JOIN users u2 ON c.user2_id = u2.id
    WHERE c.fecha_id = ?
  `).all(req.params.fechaId);

  res.status(201).json(result);
});

// POST /api/cruces/fecha/:fechaId/recalcular
router.post('/fecha/:fechaId/recalcular', authMiddleware, adminMiddleware, (req, res) => {
  const db = getDb();
  recalcularCruces(db, req.params.fechaId);
  res.json({ message: 'Cruces recalculados' });
});

/**
 * GET /api/cruces/fecha/:fechaId/resumido
 * Cruces de una fecha resumida con sus resultados actuales.
 */
router.get('/fecha/:fechaId/resumido', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const db = getDb();
    const cruces = db.prepare(`
      SELECT c.id, c.user1_id, c.user2_id,
             u1.nombre as user1_nombre, u2.nombre as user2_nombre,
             c.ganador_tabla_a, c.ganador_tabla_b, c.ganador_gdt,
             c.puntos_internos_u1, c.puntos_internos_u2,
             c.ganador_fecha, c.pts_torneo_u1, c.pts_torneo_u2
      FROM cruces c
      JOIN users u1 ON c.user1_id = u1.id
      JOIN users u2 ON c.user2_id = u2.id
      WHERE c.fecha_id = ?
      ORDER BY c.id
    `).all(req.params.fechaId);
    res.json(cruces);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * POST /api/cruces/fecha/:fechaId/resumido
 * Guarda los resultados de todos los cruces en modo resumido y recalcula tabla.
 * Body: { resultados: [{ cruce_id, bloque_a, bloque_b, gdt }] }
 * Valores válidos para cada bloque: 'user1' | 'user2' | 'empate'
 */
router.post('/fecha/:fechaId/resumido', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const db = getDb();
    const fechaId = Number(req.params.fechaId);
    const { resultados } = req.body;

    if (!Array.isArray(resultados) || resultados.length === 0) {
      return res.status(400).json({ error: 'resultados debe ser un array no vacío' });
    }

    const validos = ['user1', 'user2', 'empate'];
    for (const r of resultados) {
      if (!validos.includes(r.bloque_a) || !validos.includes(r.bloque_b) || !validos.includes(r.gdt)) {
        return res.status(400).json({ error: `Valores inválidos en cruce ${r.cruce_id}` });
      }
    }

    const fecha = db.prepare('SELECT * FROM fechas WHERE id = ?').get(fechaId);

    db.exec('BEGIN');
    try {
      for (const r of resultados) {
        calcularCruceResumido(db, r.cruce_id, r.bloque_a, r.bloque_b, r.gdt, fecha);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }

    // Recalcular tabla general (usa los cruces ya actualizados)
    recalcularTablaGeneral(db, fechaId);

    res.json({ ok: true, procesados: resultados.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/cruces/torneo/:torneoId/mios — todos los cruces del usuario en el torneo
router.get('/torneo/:torneoId/mios', authMiddleware, (req, res) => {
  const db = getDb();
  const userId = req.user.id;

  const cruces = db.prepare(`
    SELECT c.*,
      u1.nombre AS user1_nombre,
      u2.nombre AS user2_nombre,
      f.nombre  AS fecha_nombre,
      f.numero  AS fecha_numero,
      f.estado  AS fecha_estado
    FROM cruces c
    JOIN fechas f  ON c.fecha_id  = f.id
    JOIN users  u1 ON c.user1_id  = u1.id
    JOIN users  u2 ON c.user2_id  = u2.id
    WHERE f.torneo_id = ? AND (c.user1_id = ? OR c.user2_id = ?)
    ORDER BY f.numero
  `).all(req.params.torneoId, userId, userId);

  const resultado = cruces.map(c => {
    const esU1 = c.user1_id === userId;
    return {
      fecha_id:             c.fecha_id,
      fecha_nombre:         c.fecha_nombre,
      fecha_numero:         c.fecha_numero,
      fecha_estado:         c.fecha_estado,
      rival_nombre:         esU1 ? c.user2_nombre : c.user1_nombre,
      yo_pts_tabla_a:       esU1 ? c.pts_tabla_a_u1 : c.pts_tabla_a_u2,
      rival_pts_tabla_a:    esU1 ? c.pts_tabla_a_u2 : c.pts_tabla_a_u1,
      yo_pts_tabla_b:       esU1 ? c.pts_tabla_b_u1 : c.pts_tabla_b_u2,
      rival_pts_tabla_b:    esU1 ? c.pts_tabla_b_u2 : c.pts_tabla_b_u1,
      yo_puntos_internos:   esU1 ? c.puntos_internos_u1 : c.puntos_internos_u2,
      rival_puntos_internos:esU1 ? c.puntos_internos_u2 : c.puntos_internos_u1,
      ganador_tabla_a:      c.ganador_tabla_a,
      ganador_tabla_b:      c.ganador_tabla_b,
      yo_ganador_tabla_a:   c.ganador_tabla_a === (esU1 ? 'user1' : 'user2'),
      yo_ganador_tabla_b:   c.ganador_tabla_b === (esU1 ? 'user1' : 'user2'),
      ganador_fecha:        c.ganador_fecha,
      yo_gano:              c.ganador_fecha === (esU1 ? 'user1' : 'user2'),
      yo_pts_torneo:        esU1 ? c.pts_torneo_u1 : c.pts_torneo_u2,
    };
  });

  res.json(resultado);
});

module.exports = router;
