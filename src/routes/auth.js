const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getDb } = require('../db');
const { authMiddleware, JWT_SECRET } = require('../middleware/auth');

const router = express.Router();

// POST /api/auth/register
router.post('/register', async (req, res) => {
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
router.get('/me', authMiddleware, (req, res) => {
  res.json({ user: req.user });
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
