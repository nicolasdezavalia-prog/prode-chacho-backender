const express = require('express');
const crypto = require('crypto');
const { getDb } = require('../db');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

const router = express.Router();

// GET /api/usuarios/lista - solo id+nombre, accesible a todos los usuarios autenticados
router.get('/lista', authMiddleware, (req, res) => {
  const db = getDb();
  const users = db.prepare('SELECT id, nombre FROM users ORDER BY nombre').all();
  res.json(users);
});

// GET /api/usuarios - listar todos (admin)
router.get('/', authMiddleware, adminMiddleware, (req, res) => {
  const db = getDb();
  // Seleccionamos role para incluir 'superadmin'
  const users = db.prepare('SELECT id, nombre, email, role FROM users ORDER BY nombre').all();
  res.json(users);
});

// GET /api/usuarios/:id
router.get('/:id', authMiddleware, (req, res) => {
  const db = getDb();
  // Solo admin puede ver otros usuarios
  if (parseInt(req.params.id) !== req.user.id && req.user.role !== 'admin' && req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'No autorizado' });
  }
  const user = db.prepare('SELECT id, nombre, email, role FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  res.json(user);
});

// PATCH /api/usuarios/:id/role — cambiar rol (admin only, no puede quitarse a sí mismo)
router.patch('/:id/role', authMiddleware, adminMiddleware, (req, res) => {
  const targetId = parseInt(req.params.id);
  if (targetId === req.user.id) {
    return res.status(400).json({ error: 'No podés cambiar tu propio rol' });
  }
  const db = getDb();
  const user = db.prepare('SELECT id, nombre, email, role FROM users WHERE id = ?').get(targetId);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  // Ciclo: user → admin → superadmin → user
  const ciclo = { 'user': 'admin', 'admin': 'superadmin', 'superadmin': 'user' };
  const nuevoRol = ciclo[user.role] || 'user';
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(nuevoRol, targetId);

  res.json({ id: targetId, nombre: user.nombre, email: user.email, role: nuevoRol });
});

// POST /api/usuarios/:id/reset-link — generar magic link para resetear contraseña (admin only)
router.post('/:id/reset-link', authMiddleware, adminMiddleware, (req, res) => {
  const targetId = parseInt(req.params.id);
  const db = getDb();
  const user = db.prepare('SELECT id, nombre, email FROM users WHERE id = ?').get(targetId);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  // Invalidar tokens anteriores de este usuario
  db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE user_id = ?').run(targetId);

  // Generar token único de 32 bytes
  const token = crypto.randomBytes(32).toString('hex');
  // Expira en 48 horas
  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

  db.prepare(
    'INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, ?)'
  ).run(targetId, token, expiresAt);

  // La URL base viene del header Origin o del env
  const baseUrl = req.headers.origin || process.env.FRONTEND_URL || 'http://localhost:5173';
  const link = `${baseUrl}/reset-password?token=${token}`;

  res.json({ token, link, expires_at: expiresAt, usuario: user.nombre });
});

module.exports = router;
