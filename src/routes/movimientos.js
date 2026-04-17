const express = require('express');
const { getDb } = require('../db');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

const router = express.Router();

/**
 * GET /api/movimientos/resumen-home
 * Movimientos del usuario autenticado (pendientes y pagados), con info de acreedor.
 */
router.get('/resumen-home', authMiddleware, (req, res) => {
  const db = getDb();
  const userId = req.user.id;

  const movimientos = db.prepare(`
    SELECT m.*,
      f.nombre AS fecha_nombre, f.mes, f.anio, f.numero AS fecha_numero,
      ua.nombre AS acreedor_nombre
    FROM movimientos_economicos m
    LEFT JOIN fechas f ON m.fecha_id = f.id
    LEFT JOIN users ua ON m.acreedor_user_id = ua.id
    WHERE m.user_id = ?
    ORDER BY m.pagado ASC, f.numero DESC, m.created_at DESC
  `).all(userId);

  const pendientes = movimientos.filter(m => !m.pagado);
  const totalPendiente = pendientes.reduce((s, m) => s + m.importe, 0);

  // Agrupar pendientes por fecha_id
  const porFecha = {};
  for (const m of pendientes) {
    if (!m.fecha_id) continue;
    if (!porFecha[m.fecha_id]) porFecha[m.fecha_id] = { fecha_nombre: m.fecha_nombre, mes: m.mes, anio: m.anio, total: 0, items: [] };
    porFecha[m.fecha_id].items.push(m);
    porFecha[m.fecha_id].total += m.importe;
  }

  res.json({ movimientos, totalPendiente, porFecha });
});

/**
 * GET /api/movimientos/fecha/:fechaId
 * Todos los movimientos de una fecha (admin o participantes).
 */
router.get('/fecha/:fechaId', authMiddleware, (req, res) => {
  const db = getDb();
  const { fechaId } = req.params;

  const movimientos = db.prepare(`
    SELECT m.*, u.nombre AS user_nombre, up.nombre AS pagado_por_nombre
    FROM movimientos_economicos m
    JOIN users u ON m.user_id = u.id
    LEFT JOIN users up ON m.pagado_por = up.id
    WHERE m.fecha_id = ?
    ORDER BY m.created_at ASC
  `).all(fechaId);

  const total = movimientos.reduce((s, m) => s + (m.signo === '+' ? m.importe : 0), 0);
  const pagado = movimientos.filter(m => m.pagado && m.signo === '+').reduce((s, m) => s + m.importe, 0);

  res.json({ movimientos, total, pagado, pendiente: total - pagado });
});

/**
 * GET /api/movimientos/pozo-mensual?torneo_id=&mes=&anio=
 * Resumen del pozo acumulado en el mes para el sidebar de Tabla Mensual.
 */
router.get('/pozo-mensual', authMiddleware, (req, res) => {
  const db = getDb();
  const { torneo_id, mes, anio } = req.query;

  if (!torneo_id || !mes || !anio) {
    return res.status(400).json({ error: 'Faltan parámetros: torneo_id, mes, anio' });
  }

  const movimientos = db.prepare(`
    SELECT m.*, u.nombre AS user_nombre, f.nombre AS fecha_nombre, f.numero AS fecha_numero
    FROM movimientos_economicos m
    JOIN users u ON m.user_id = u.id
    JOIN fechas f ON m.fecha_id = f.id
    WHERE f.torneo_id = ? AND f.mes = ? AND f.anio = ?
      AND m.tipo = 'empate_pozo' AND m.signo = '+'
    ORDER BY f.numero ASC, m.user_id ASC
  `).all(torneo_id, mes, anio);

  const total = movimientos.reduce((s, m) => s + m.importe, 0);
  const pagado = movimientos.filter(m => m.pagado).reduce((s, m) => s + m.importe, 0);
  const pendiente = total - pagado;

  // Agrupar por fecha para breakdown
  const porFecha = {};
  for (const m of movimientos) {
    if (!porFecha[m.fecha_id]) {
      porFecha[m.fecha_id] = { fecha_nombre: m.fecha_nombre, fecha_numero: m.fecha_numero, importe: m.importe, usuarios: [] };
    }
    porFecha[m.fecha_id].usuarios.push({ user_nombre: m.user_nombre, pagado: m.pagado });
  }

  res.json({ movimientos, total, pagado, pendiente, porFecha: Object.values(porFecha) });
});

/**
 * POST /api/movimientos/manual
 * Admin crea un movimiento manual (ej. pago de premio, deuda extra, etc).
 */
router.post('/manual', authMiddleware, adminMiddleware, (req, res) => {
  const db = getDb();
  const { torneo_id, fecha_id, user_id, concepto, importe, signo } = req.body;

  if (!torneo_id || !user_id || !concepto || !importe) {
    return res.status(400).json({ error: 'Faltan campos: torneo_id, user_id, concepto, importe' });
  }
  if (isNaN(parseInt(importe)) || parseInt(importe) <= 0) {
    return res.status(400).json({ error: 'importe debe ser un entero positivo' });
  }

  const signoFinal = signo === '-' ? '-' : '+';

  const result = db.prepare(`
    INSERT INTO movimientos_economicos
      (torneo_id, fecha_id, user_id, tipo, concepto, importe, signo, created_by)
    VALUES (?, ?, ?, 'manual', ?, ?, ?, ?)
  `).run(
    torneo_id,
    fecha_id || null,
    user_id,
    concepto,
    parseInt(importe),
    signoFinal,
    req.user.id
  );

  const mov = db.prepare('SELECT * FROM movimientos_economicos WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(mov);
});

/**
 * GET /api/movimientos/deudores?torneo_id=
 * Cuadro completo de deudas (admin). Muestra todos los movimientos agrupados por usuario.
 */
router.get('/deudores', authMiddleware, adminMiddleware, (req, res) => {
  const db = getDb();
  const { torneo_id } = req.query;

  let query = `
    SELECT m.*,
      u.nombre AS user_nombre,
      ua.nombre AS acreedor_nombre,
      f.nombre AS fecha_nombre, f.mes, f.anio, f.numero AS fecha_numero
    FROM movimientos_economicos m
    JOIN users u ON m.user_id = u.id
    LEFT JOIN users ua ON m.acreedor_user_id = ua.id
    LEFT JOIN fechas f ON m.fecha_id = f.id
  `;
  const params = [];
  if (torneo_id) { query += ' WHERE f.torneo_id = ?'; params.push(torneo_id); }
  query += ' ORDER BY m.pagado ASC, u.nombre ASC, f.numero DESC';

  const movimientos = db.prepare(query).all(...params);

  // Agrupar por usuario
  const porUsuario = {};
  for (const m of movimientos) {
    if (!porUsuario[m.user_id]) {
      porUsuario[m.user_id] = { user_id: m.user_id, user_nombre: m.user_nombre, pendiente: 0, pagado: 0, items: [] };
    }
    porUsuario[m.user_id].items.push(m);
    if (m.pagado) porUsuario[m.user_id].pagado += m.importe;
    else          porUsuario[m.user_id].pendiente += m.importe;
  }

  res.json({ movimientos, porUsuario: Object.values(porUsuario) });
});

/**
 * PATCH /api/movimientos/:id/pagar
 * - Usuarios: solo pueden marcar SUS PROPIOS movimientos como pagados (no desmarcar)
 * - Admins: pueden toggle cualquier movimiento
 */
router.patch('/:id/pagar', authMiddleware, (req, res) => {
  const db = getDb();
  const mov = db.prepare('SELECT * FROM movimientos_economicos WHERE id = ?').get(req.params.id);
  if (!mov) return res.status(404).json({ error: 'Movimiento no encontrado' });

  const esAdmin = req.user.role === 'admin' || req.user.role === 'superadmin';
  const esPropietario = mov.user_id === req.user.id;

  if (!esAdmin && !esPropietario) {
    return res.status(403).json({ error: 'Solo podés marcar tus propios pagos' });
  }
  if (!esAdmin && mov.pagado) {
    return res.status(400).json({ error: 'No podés desmarcar un pago ya confirmado' });
  }

  const nuevoPagado = esAdmin ? (mov.pagado ? 0 : 1) : 1;

  db.prepare(`UPDATE movimientos_economicos SET pagado = ?, pagado_at = ?, pagado_por = ? WHERE id = ?`)
    .run(nuevoPagado, nuevoPagado ? new Date().toISOString() : null, nuevoPagado ? req.user.id : null, mov.id);

  const updated = db.prepare('SELECT * FROM movimientos_economicos WHERE id = ?').get(mov.id);
  res.json(updated);
});

/**
 * DELETE /api/movimientos/:id
 * Eliminar un movimiento manual (no empate_pozo automático). Solo admin.
 */
router.delete('/:id', authMiddleware, adminMiddleware, (req, res) => {
  const db = getDb();
  const mov = db.prepare('SELECT * FROM movimientos_economicos WHERE id = ?').get(req.params.id);
  if (!mov) return res.status(404).json({ error: 'Movimiento no encontrado' });
  if (mov.tipo !== 'manual') {
    return res.status(400).json({ error: 'Solo se pueden eliminar movimientos manuales' });
  }

  db.prepare('DELETE FROM movimientos_economicos WHERE id = ?').run(mov.id);
  res.json({ message: 'Movimiento eliminado' });
});

module.exports = router;
