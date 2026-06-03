const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { getDb } = require('../db');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

const router = express.Router();

// Regex básica de email. No pretende cubrir todos los edge cases del RFC,
// solo descartar formatos obviamente inválidos.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_MIN_LEN = 6;

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

// POST /api/usuarios — crear usuario (admin only)
//   Body: { nombre, email, password, role? }
//   - nombre:   string trim no vacío
//   - email:    formato básico válido, único (case-insensitive)
//   - password: mínimo PASSWORD_MIN_LEN caracteres
//   - role:     opcional, default 'user'. Si se especifica, solo 'user' o 'admin'
//               (superadmin NO se asigna por este endpoint — se sube por el
//               cycle existente PATCH /:id/role).
//   Respuesta: { id, nombre, email, role } — sin password.
router.post('/', authMiddleware, adminMiddleware, async (req, res) => {
  const { nombre, email, password, role } = req.body || {};

  if (typeof nombre !== 'string' || nombre.trim().length === 0) {
    return res.status(400).json({ error: 'nombre requerido' });
  }
  if (typeof email !== 'string' || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'email inválido' });
  }
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LEN) {
    return res.status(400).json({ error: `password debe tener al menos ${PASSWORD_MIN_LEN} caracteres` });
  }
  let roleFinal = 'user';
  if (role !== undefined) {
    if (role !== 'user' && role !== 'admin') {
      return res.status(400).json({ error: 'role solo puede ser "user" o "admin"' });
    }
    roleFinal = role;
  }

  const emailNormalizado = email.trim().toLowerCase();
  const db = getDb();
  // Check de unicidad case-insensitive. Esquema actual: email es UNIQUE pero
  // case-sensitive en SQLite por default; chequeamos manualmente para evitar
  // duplicados con diferente capitalización.
  const existing = db.prepare(
    'SELECT id FROM users WHERE LOWER(email) = ?'
  ).get(emailNormalizado);
  if (existing) {
    return res.status(409).json({ error: 'El email ya está registrado' });
  }

  const hash = await bcrypt.hash(password, 10);
  const result = db.prepare(
    'INSERT INTO users (nombre, email, password, role) VALUES (?, ?, ?, ?)'
  ).run(nombre.trim(), emailNormalizado, hash, roleFinal);

  res.status(201).json({
    id: result.lastInsertRowid,
    nombre: nombre.trim(),
    email: emailNormalizado,
    role: roleFinal,
  });
});

// POST /api/usuarios/:id/password — cambiar password directamente (admin only)
//   Body: { password }
//   - password: mínimo PASSWORD_MIN_LEN caracteres.
//   404 si user no existe. Devuelve { ok, id, nombre, email } — sin hash ni password.
router.post('/:id/password', authMiddleware, adminMiddleware, async (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  if (!Number.isFinite(targetId) || targetId <= 0) {
    return res.status(400).json({ error: 'id inválido' });
  }
  const { password } = req.body || {};
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LEN) {
    return res.status(400).json({ error: `password debe tener al menos ${PASSWORD_MIN_LEN} caracteres` });
  }

  const db = getDb();
  const user = db.prepare('SELECT id, nombre, email FROM users WHERE id = ?').get(targetId);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  const hash = await bcrypt.hash(password, 10);
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, targetId);

  // Invalidar magic links pendientes de este user (si los hubiera) por higiene.
  // Si la tabla no existe (esquema parcial), ignoramos el error silenciosamente.
  try {
    db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE user_id = ?').run(targetId);
  } catch (_) { /* tabla puede no existir en setups viejos — ignorar */ }

  res.json({ ok: true, id: user.id, nombre: user.nombre, email: user.email });
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

// PATCH /api/usuarios/:id — editar campos básicos del usuario (admin only).
//   Por ahora solo soporta `nombre` (nombre visible). NO toca email/role/password.
//   Body: { nombre }
//   - nombre: string trim length 1..100
//   404 si user no existe.
const NOMBRE_MAX_LEN = 100;
router.patch('/:id', authMiddleware, adminMiddleware, (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  if (!Number.isFinite(targetId) || targetId <= 0) {
    return res.status(400).json({ error: 'id inválido' });
  }
  const { nombre } = req.body || {};
  if (typeof nombre !== 'string' || nombre.trim().length === 0) {
    return res.status(400).json({ error: 'nombre requerido (string no vacío)' });
  }
  const nombreLimpio = nombre.trim();
  if (nombreLimpio.length > NOMBRE_MAX_LEN) {
    return res.status(400).json({ error: `nombre demasiado largo (máx ${NOMBRE_MAX_LEN} caracteres)` });
  }

  const db = getDb();
  const user = db.prepare('SELECT id, nombre, email, role FROM users WHERE id = ?').get(targetId);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  db.prepare('UPDATE users SET nombre = ? WHERE id = ?').run(nombreLimpio, targetId);
  res.json({ id: user.id, nombre: nombreLimpio, email: user.email, role: user.role });
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
