const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getDb } = require('../db');
const { authMiddleware, adminMiddleware, JWT_SECRET } = require('../middleware/auth');

const router = express.Router();

// POST /api/auth/register
// Pre-prod (Fase pre-salida): el endpoint queda restringido a admin para
// evitar registro público abierto. El flujo recomendado para alta de
// usuarios es ahora POST /api/usuarios (gestionado desde Admin → Usuarios).
// Se mantiene este endpoint por compatibilidad — el frontend no lo invoca
// (verificado con grep: api.register declarado pero no usado).
router.post('/register', authMiddleware, adminMiddleware, async (req, res) => {
  const { nombre, email, password, role } = req.body;
  if (!nombre || !email || !password) {
    return res.status(400).json({ error: 'Faltan campos requeridos' });
  }

  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    return res.status(409).json({ error: 'El email ya está registrado' });
  }

  const hash = await bcrypt.hash(password, 10);
  const userRole = role === 'admin' ? 'admin' : 'user';

  const result = db.prepare(
    'INSERT INTO users (nombre, email, password, role) VALUES (?, ?, ?, ?)'
  ).run(nombre, email, hash, userRole);

  res.status(201).json({ id: result.lastInsertRowid, nombre, email, role: userRole });
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email y password requeridos' });
  }

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) {
    return res.status(401).json({ error: 'Credenciales incorrectas' });
  }

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) {
    return res.status(401).json({ error: 'Credenciales incorrectas' });
  }

  const token = jwt.sign(
    { id: user.id, nombre: user.nombre, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: '7d' }
  );

  res.json({
    token,
    user: { id: user.id, nombre: user.nombre, email: user.email, role: user.role }
  });
});

// GET /api/auth/me
// Lee datos frescos de DB (no del JWT) para que cambios de nombre/email/role
// hechos por admin se vean reflejados aunque el JWT aún tenga datos viejos.
// Shape de respuesta sin cambios: { user: { id, nombre, email, role } }.
router.get('/me', authMiddleware, (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT id, nombre, email, role FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  res.json({ user });
});

// Regex básica de email (alineada con la de routes/usuarios.js).
const EMAIL_RE_AUTH    = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_MIN_AUTH = 6;

// PATCH /api/auth/me/password — el usuario cambia su propia contraseña.
//   Body: { current_password, new_password }
//   - 401 si current_password no coincide.
//   - 400 si new_password < PASSWORD_MIN_AUTH.
//   - Invalida magic links pendientes (higiene).
//   - JWT actual sigue válido (no se invalida — MVP simple).
router.patch('/me/password', authMiddleware, async (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (typeof current_password !== 'string' || current_password.length === 0) {
    return res.status(400).json({ error: 'current_password requerido' });
  }
  if (typeof new_password !== 'string' || new_password.length < PASSWORD_MIN_AUTH) {
    return res.status(400).json({ error: `new_password debe tener al menos ${PASSWORD_MIN_AUTH} caracteres` });
  }

  const db = getDb();
  const user = db.prepare('SELECT id, password FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  const valido = await bcrypt.compare(current_password, user.password);
  if (!valido) return res.status(401).json({ error: 'Contraseña actual incorrecta' });

  const hash = await bcrypt.hash(new_password, 10);
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, user.id);
  // Higiene: invalidar magic links pendientes (mismo patrón que admin reset).
  try {
    db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE user_id = ?').run(user.id);
  } catch (_) { /* tabla puede no existir en setups viejos — ignorar */ }

  res.json({ ok: true, message: 'Contraseña actualizada' });
});

// PATCH /api/auth/me/email — el usuario cambia su propio email.
//   Body: { new_email, current_password }
//   - current_password obligatoria (confirmación de identidad).
//   - new_email validado por regex + unicidad case-insensitive.
//   - Devuelve JWT nuevo con el email actualizado en el payload — el frontend
//     debe pisar su token para que /me y login futuro funcionen.
router.patch('/me/email', authMiddleware, async (req, res) => {
  const { new_email, current_password } = req.body || {};
  if (typeof new_email !== 'string' || !EMAIL_RE_AUTH.test(new_email)) {
    return res.status(400).json({ error: 'new_email inválido' });
  }
  if (typeof current_password !== 'string' || current_password.length === 0) {
    return res.status(400).json({ error: 'current_password requerido para confirmar identidad' });
  }
  const emailNorm = new_email.trim().toLowerCase();

  const db = getDb();
  const user = db.prepare('SELECT id, password FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  const valido = await bcrypt.compare(current_password, user.password);
  if (!valido) return res.status(401).json({ error: 'Contraseña actual incorrecta' });

  // Check de unicidad (case-insensitive) excluyendo al user actual.
  const dup = db.prepare(
    'SELECT id FROM users WHERE LOWER(email) = ? AND id != ?'
  ).get(emailNorm, user.id);
  if (dup) return res.status(409).json({ error: 'Ese email ya está en uso por otro usuario' });

  db.prepare('UPDATE users SET email = ? WHERE id = ?').run(emailNorm, user.id);

  // JWT nuevo con el email actualizado en el payload.
  const fresh = db.prepare('SELECT id, nombre, email, role FROM users WHERE id = ?').get(user.id);
  const token = jwt.sign(
    { id: fresh.id, nombre: fresh.nombre, email: fresh.email, role: fresh.role },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
  res.json({ ok: true, message: 'Email actualizado', user: fresh, token });
});

// POST /api/auth/reset-password — usar token magic link para cambiar contraseña (público)
router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password || password.length < 4) {
    return res.status(400).json({ error: 'Token y contraseña (mín. 4 caracteres) requeridos' });
  }

  const db = getDb();
  const record = db.prepare(
    "SELECT * FROM password_reset_tokens WHERE token = ? AND used = 0"
  ).get(token);

  if (!record) return res.status(400).json({ error: 'Token inválido o ya usado' });
  if (new Date(record.expires_at) < new Date()) {
    return res.status(400).json({ error: 'El link expiró. Pedile al admin uno nuevo.' });
  }

  const hash = await bcrypt.hash(password, 10);
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, record.user_id);
  db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE id = ?').run(record.id);

  const user = db.prepare('SELECT id, nombre, email, role FROM users WHERE id = ?').get(record.user_id);
  const jwtToken = jwt.sign(
    { id: user.id, nombre: user.nombre, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: '7d' }
  );

  res.json({ message: 'Contraseña actualizada', token: jwtToken, user });
});

// POST /api/auth/reset-all — endpoint temporal, eliminar después de usar
router.post('/reset-all', async (req, res) => {
  const { secret, password } = req.body;
  if (secret !== 'chacho-reset-2025') {
    return res.status(403).json({ error: 'No autorizado' });
  }
  const db = getDb();
  const hash = await bcrypt.hash(password || 'prode123', 10);
  const result = db.prepare('UPDATE users SET password = ?').run(hash);
  res.json({ actualizados: result.changes, mensaje: `Contraseña reseteada a "${password || 'prode123'}" para todos los usuarios` });
});

module.exports = router;
