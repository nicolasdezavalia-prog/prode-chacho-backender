/**
 * /api/permisos — gestión de permisos granulares.
 *
 * Solo superadmin puede modificar permisos.
 * Cualquier usuario autenticado puede consultar sus propios permisos.
 */

const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const { getDb } = require('../db');
const {
  PERMISOS,
  getPermisosDeUsuario,
  grantPermiso,
  revokePermiso,
  setPermisosDeUsuario,
} = require('../logic/permisos');

// Middleware: solo superadmin
function superadminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'Solo el superadmin puede gestionar permisos' });
  }
  next();
}

/**
 * GET /api/permisos/catalogo
 * Lista todos los permisos definidos en el sistema.
 */
router.get('/catalogo', authMiddleware, (req, res) => {
  res.json({ permisos: PERMISOS });
});

/**
 * GET /api/permisos/me
 * Devuelve los permisos del usuario autenticado.
 */
router.get('/me', authMiddleware, (req, res) => {
  const permisos = getPermisosDeUsuario(req.user.id, req.user.role);
  res.json({ user_id: req.user.id, role: req.user.role, permisos });
});

/**
 * GET /api/permisos/usuarios
 * Lista todos los usuarios (no-superadmin) con sus permisos actuales.
 * Solo superadmin.
 */
router.get('/usuarios', authMiddleware, superadminOnly, (req, res) => {
  const db = getDb();
  const usuarios = db.prepare(
    "SELECT id, nombre, email, role FROM users WHERE role != 'superadmin' ORDER BY nombre"
  ).all();

  const resultado = usuarios.map(u => ({
    ...u,
    permisos: getPermisosDeUsuario(u.id, u.role),
  }));

  res.json({ usuarios: resultado });
});

/**
 * GET /api/permisos/usuarios/:userId
 * Devuelve los permisos de un usuario específico.
 * Solo superadmin.
 */
router.get('/usuarios/:userId', authMiddleware, superadminOnly, (req, res) => {
  const db = getDb();
  const userId = parseInt(req.params.userId, 10);
  const user = db.prepare('SELECT id, nombre, email, role FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  const permisos = getPermisosDeUsuario(user.id, user.role);
  res.json({ ...user, permisos });
});

/**
 * PUT /api/permisos/usuarios/:userId
 * Reemplaza el set completo de permisos de un usuario.
 * Body: { permisos: ['crear_torneo', 'editar_fecha', ...] }
 * Solo superadmin.
 */
router.put('/usuarios/:userId', authMiddleware, superadminOnly, (req, res) => {
  const db = getDb();
  const userId = parseInt(req.params.userId, 10);
  const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  if (user.role === 'superadmin') {
    return res.status(400).json({ error: 'No se pueden modificar permisos de un superadmin' });
  }

  const { permisos } = req.body;
  if (!Array.isArray(permisos)) {
    return res.status(400).json({ error: 'Se esperaba un array de permisos' });
  }

  try {
    setPermisosDeUsuario(userId, permisos, req.user.id);
    const actualizados = getPermisosDeUsuario(userId, user.role);
    res.json({ user_id: userId, permisos: actualizados });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * POST /api/permisos/usuarios/:userId/grant
 * Otorga un permiso individual.
 * Body: { permiso: 'crear_torneo' }
 * Solo superadmin.
 */
router.post('/usuarios/:userId/grant', authMiddleware, superadminOnly, (req, res) => {
  const db = getDb();
  const userId = parseInt(req.params.userId, 10);
  const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  if (user.role === 'superadmin') {
    return res.status(400).json({ error: 'No se pueden modificar permisos de un superadmin' });
  }

  const { permiso } = req.body;
  if (!permiso) return res.status(400).json({ error: 'Falta el campo permiso' });

  try {
    grantPermiso(userId, permiso, req.user.id);
    const actualizados = getPermisosDeUsuario(userId, user.role);
    res.json({ user_id: userId, permisos: actualizados });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * POST /api/permisos/usuarios/:userId/revoke
 * Revoca un permiso individual.
 * Body: { permiso: 'crear_torneo' }
 * Solo superadmin.
 */
router.post('/usuarios/:userId/revoke', authMiddleware, superadminOnly, (req, res) => {
  const db = getDb();
  const userId = parseInt(req.params.userId, 10);
  const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  if (user.role === 'superadmin') {
    return res.status(400).json({ error: 'No se pueden modificar permisos de un superadmin' });
  }

  const { permiso } = req.body;
  if (!permiso) return res.status(400).json({ error: 'Falta el campo permiso' });

  try {
    revokePermiso(userId, permiso);
    const actualizados = getPermisosDeUsuario(userId, user.role);
    res.json({ user_id: userId, permisos: actualizados });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
