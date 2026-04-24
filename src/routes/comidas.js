const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { authMiddleware, requirePermiso } = require('../middleware/auth');

/**
 * GET /api/comidas?torneo_id=X&mes=Y&anio=Z
 * Devuelve la comida mensual del torneo/mes/año.
 * Todos los usuarios autenticados pueden ver.
 */
router.get('/', authMiddleware, (req, res) => {
  const { torneo_id, mes, anio } = req.query;
  if (!torneo_id || !mes || !anio) {
    return res.status(400).json({ error: 'Parámetros requeridos: torneo_id, mes, anio' });
  }

  const db = getDb();
  try {
    const comida = db.prepare(`
      SELECT
        c.*,
        u.nombre AS organizador_nombre
      FROM comidas_mensuales c
      LEFT JOIN users u ON u.id = c.organizador_user_id
      WHERE c.torneo_id = ? AND c.mes = ? AND c.anio = ?
    `).get(parseInt(torneo_id), parseInt(mes), parseInt(anio));

    // Si no existe aún, devolvemos null (el cliente maneja el estado vacío)
    return res.json(comida || null);
  } catch (err) {
    console.error('[comidas GET]', err.message);
    return res.status(500).json({ error: 'Error interno', detail: err.message });
  }
});

/**
 * PUT /api/comidas
 * Upsert de comida mensual por torneo_id + mes + anio.
 * Requiere permiso editar_tabla_mensual (o superadmin).
 *
 * Body: { torneo_id, mes, anio, organizador_user_id, lugar, fecha_comida, google_maps_url, nota, estado }
 */
router.put('/', authMiddleware, requirePermiso('editar_tabla_mensual'), (req, res) => {
  const {
    torneo_id,
    mes,
    anio,
    organizador_user_id,
    lugar,
    fecha_comida,
    google_maps_url,
    nota,
    estado,
  } = req.body;

  if (!torneo_id || !mes || !anio) {
    return res.status(400).json({ error: 'Campos requeridos: torneo_id, mes, anio' });
  }

  const ESTADOS_VALIDOS = ['pendiente', 'confirmada', 'realizada'];
  const estadoFinal = ESTADOS_VALIDOS.includes(estado) ? estado : 'pendiente';

  const db = getDb();
  try {
    db.prepare(`
      INSERT INTO comidas_mensuales
        (torneo_id, mes, anio, organizador_user_id, lugar, fecha_comida, google_maps_url, nota, estado, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(torneo_id, mes, anio) DO UPDATE SET
        organizador_user_id = excluded.organizador_user_id,
        lugar               = excluded.lugar,
        fecha_comida        = excluded.fecha_comida,
        google_maps_url     = excluded.google_maps_url,
        nota                = excluded.nota,
        estado              = excluded.estado,
        updated_by          = excluded.updated_by,
        updated_at          = datetime('now')
    `).run(
      parseInt(torneo_id),
      parseInt(mes),
      parseInt(anio),
      organizador_user_id ? parseInt(organizador_user_id) : null,
      lugar?.trim() || null,
      fecha_comida?.trim() || null,
      google_maps_url?.trim() || null,
      nota?.trim() || null,
      estadoFinal,
      req.user.id,
    );

    // Devolver el registro actualizado con el nombre del organizador
    const comida = db.prepare(`
      SELECT c.*, u.nombre AS organizador_nombre
      FROM comidas_mensuales c
      LEFT JOIN users u ON u.id = c.organizador_user_id
      WHERE c.torneo_id = ? AND c.mes = ? AND c.anio = ?
    `).get(parseInt(torneo_id), parseInt(mes), parseInt(anio));

    return res.json(comida);
  } catch (err) {
    console.error('[comidas PUT]', err.message);
    return res.status(500).json({ error: 'Error interno', detail: err.message });
  }
});

module.exports = router;
