const express = require('express');
const { getDb } = require('../db');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');
const { recalcularTablaTorneoCompleta } = require('../logic/puntos');

const router = express.Router();

// GET /api/torneos
router.get('/', authMiddleware, (req, res) => {
  const db = getDb();
  const torneos = db.prepare('SELECT * FROM torneos ORDER BY id DESC').all();
  res.json(torneos);
});

// POST /api/torneos
router.post('/', authMiddleware, adminMiddleware, (req, res) => {
  const { nombre, semestre } = req.body;
  if (!nombre || !semestre) {
    return res.status(400).json({ error: 'nombre y semestre son requeridos' });
  }

  const db = getDb();
  const result = db.prepare(
    'INSERT INTO torneos (nombre, semestre) VALUES (?, ?)'
  ).run(nombre, semestre);

  const torneo = db.prepare('SELECT * FROM torneos WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(torneo);
});

// GET /api/torneos/:id
router.get('/:id', authMiddleware, (req, res) => {
  const db = getDb();
  const torneo = db.prepare('SELECT * FROM torneos WHERE id = ?').get(req.params.id);
  if (!torneo) return res.status(404).json({ error: 'Torneo no encontrado' });

  const jugadores = db.prepare(`
    SELECT u.id, u.nombre, u.email, u.role
    FROM torneo_jugadores tj
    JOIN users u ON tj.user_id = u.id
    WHERE tj.torneo_id = ?
    ORDER BY u.nombre
  `).all(torneo.id);

  res.json({ ...torneo, jugadores });
});

// POST /api/torneos/:id/jugadores - agregar jugador al torneo
router.post('/:id/jugadores', authMiddleware, adminMiddleware, (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id requerido' });

  const db = getDb();
  const torneo = db.prepare('SELECT * FROM torneos WHERE id = ?').get(req.params.id);
  if (!torneo) return res.status(404).json({ error: 'Torneo no encontrado' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(user_id);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  try {
    db.prepare('INSERT INTO torneo_jugadores (torneo_id, user_id) VALUES (?, ?)').run(torneo.id, user_id);
    // Inicializar entrada en tabla_torneo
    db.prepare(`
      INSERT OR IGNORE INTO tabla_torneo (torneo_id, user_id) VALUES (?, ?)
    `).run(torneo.id, user_id);
    res.status(201).json({ message: 'Jugador agregado al torneo' });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'El jugador ya está en este torneo' });
    }
    throw err;
  }
});

// DELETE /api/torneos/:id/jugadores/:userId
router.delete('/:id/jugadores/:userId', authMiddleware, adminMiddleware, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM torneo_jugadores WHERE torneo_id = ? AND user_id = ?')
    .run(req.params.id, req.params.userId);
  res.json({ message: 'Jugador removido del torneo' });
});

// GET /api/torneos/:id/tabla
router.get('/:id/tabla', authMiddleware, (req, res) => {
  const db = getDb();
  const tabla = db.prepare(`
    SELECT tt.*, u.nombre, u.email
    FROM tabla_torneo tt
    JOIN users u ON tt.user_id = u.id
    WHERE tt.torneo_id = ?
    ORDER BY tt.puntos DESC, tt.victorias DESC, tt.bonus DESC
  `).all(req.params.id);
  res.json(tabla);
});

// GET /api/torneos/:id/tabla-mensual?mes=X&anio=Y
router.get('/:id/tabla-mensual', authMiddleware, (req, res) => {
  const { mes, anio } = req.query;
  if (!mes || !anio) {
    return res.status(400).json({ error: 'mes y anio son requeridos' });
  }

  const db = getDb();
  // Obtener todos los jugadores del torneo
  const jugadores = db.prepare(`
    SELECT u.id, u.nombre FROM torneo_jugadores tj
    JOIN users u ON tj.user_id = u.id
    WHERE tj.torneo_id = ?
  `).all(req.params.id);

  // Obtener cruces de fechas del mes/año especificado
  const cruces = db.prepare(`
    SELECT c.*, f.mes, f.anio
    FROM cruces c
    JOIN fechas f ON c.fecha_id = f.id
    WHERE f.torneo_id = ? AND f.mes = ? AND f.anio = ?
    AND c.ganador_fecha IS NOT NULL
  `).all(req.params.id, mes, anio);

  // Calcular tabla mensual
  const tablaMap = {};
  for (const j of jugadores) {
    tablaMap[j.id] = { user_id: j.id, nombre: j.nombre, puntos: 0, pj: 0, victorias: 0, empates: 0, derrotas: 0 };
  }

  for (const c of cruces) {
    if (tablaMap[c.user1_id]) {
      tablaMap[c.user1_id].pj++;
      if (c.ganador_fecha === 'user1') {
        tablaMap[c.user1_id].victorias++;
        tablaMap[c.user1_id].puntos += c.pts_torneo_u1;
      } else if (c.ganador_fecha === 'empate') {
        tablaMap[c.user1_id].empates++;
        tablaMap[c.user1_id].puntos += 1;
      } else {
        tablaMap[c.user1_id].derrotas++;
      }
    }
    if (tablaMap[c.user2_id]) {
      tablaMap[c.user2_id].pj++;
      if (c.ganador_fecha === 'user2') {
        tablaMap[c.user2_id].victorias++;
        tablaMap[c.user2_id].puntos += c.pts_torneo_u2;
      } else if (c.ganador_fecha === 'empate') {
        tablaMap[c.user2_id].empates++;
        tablaMap[c.user2_id].puntos += 1;
      } else {
        tablaMap[c.user2_id].derrotas++;
      }
    }
  }

  const tabla = Object.values(tablaMap).sort((a, b) => b.puntos - a.puntos || b.victorias - a.victorias);
  res.json(tabla);
});

// GET /api/torneos/:torneoId/h2h/:userId — estadísticas H2H de un jugador vs todos los demás
router.get('/:torneoId/h2h/:userId', authMiddleware, (req, res) => {
  const db = getDb();
  const { torneoId, userId } = req.params;

  // Todos los cruces del torneo donde participa este usuario
  const cruces = db.prepare(`
    SELECT c.*,
      f.nombre as fecha_nombre, f.numero as fecha_numero, f.mes, f.anio,
      u1.nombre as user1_nombre,
      u2.nombre as user2_nombre
    FROM cruces c
    JOIN fechas f ON c.fecha_id = f.id
    JOIN users u1 ON c.user1_id = u1.id
    JOIN users u2 ON c.user2_id = u2.id
    WHERE f.torneo_id = ?
      AND (c.user1_id = ? OR c.user2_id = ?)
      AND c.ganador_fecha IS NOT NULL
      AND f.estado = 'finalizada'
    ORDER BY f.numero ASC
  `).all(torneoId, userId, userId);

  // Agrupar por rival
  const rivalMap = {};

  for (const c of cruces) {
    const esUser1  = String(c.user1_id) === String(userId);
    const rivalId  = esUser1 ? c.user2_id   : c.user1_id;
    const rivalNom = esUser1 ? c.user2_nombre : c.user1_nombre;
    const ganadorFecha = c.ganador_fecha;
    const ganadorA     = c.ganador_tabla_a;
    const ganadorB     = c.ganador_tabla_b;
    const ganadorGDT   = c.ganador_gdt;
    const miRol        = esUser1 ? 'user1' : 'user2';

    if (!rivalMap[rivalId]) {
      rivalMap[rivalId] = {
        rival_id:     rivalId,
        rival_nombre: rivalNom,
        pj: 0, pg: 0, pe: 0, pp: 0,
        bloque_a: { g: 0, e: 0, p: 0 },
        bloque_b: { g: 0, e: 0, p: 0 },
        gdt:      { g: 0, e: 0, p: 0 },
        pts_torneo: 0,
        fechas: [],
      };
    }

    const r = rivalMap[rivalId];
    r.pj++;

    // Resultado global
    if (ganadorFecha === miRol)        { r.pg++; r.pts_torneo += esUser1 ? c.pts_torneo_u1 : c.pts_torneo_u2; }
    else if (ganadorFecha === 'empate') { r.pe++; r.pts_torneo += 1; }
    else                                { r.pp++; }

    // Bloque A
    if (ganadorA === miRol)        r.bloque_a.g++;
    else if (ganadorA === 'empate') r.bloque_a.e++;
    else if (ganadorA !== null)     r.bloque_a.p++;

    // Bloque B
    if (ganadorB === miRol)        r.bloque_b.g++;
    else if (ganadorB === 'empate') r.bloque_b.e++;
    else if (ganadorB !== null)     r.bloque_b.p++;

    // GDT
    if (ganadorGDT === miRol)        r.gdt.g++;
    else if (ganadorGDT === 'empate') r.gdt.e++;
    else if (ganadorGDT !== null)     r.gdt.p++;

    // Detalle por fecha
    r.fechas.push({
      fecha_nombre: c.fecha_nombre,
      fecha_numero: c.fecha_numero,
      mes: c.mes, anio: c.anio,
      resultado: ganadorFecha === miRol ? 'G' : ganadorFecha === 'empate' ? 'E' : 'P',
      bloque_a:  ganadorA  === miRol ? 'G' : ganadorA  === 'empate' ? 'E' : ganadorA  ? 'P' : '—',
      bloque_b:  ganadorB  === miRol ? 'G' : ganadorB  === 'empate' ? 'E' : ganadorB  ? 'P' : '—',
      gdt:       ganadorGDT === miRol ? 'G' : ganadorGDT === 'empate' ? 'E' : ganadorGDT ? 'P' : '—',
      pi_yo:     esUser1 ? c.puntos_internos_u1 : c.puntos_internos_u2,
      pi_rival:  esUser1 ? c.puntos_internos_u2 : c.puntos_internos_u1,
    });
  }

  const rivalArray = Object.values(rivalMap).sort((a, b) => b.pg - a.pg || a.pp - b.pp);
  res.json(rivalArray);
});

// POST /api/torneos/:id/recalcular-tabla — recalcula tabla_torneo completa desde cero
router.post('/:id/recalcular-tabla', authMiddleware, adminMiddleware, (req, res) => {
  const db = getDb();
  const torneo = db.prepare('SELECT * FROM torneos WHERE id = ?').get(req.params.id);
  if (!torneo) return res.status(404).json({ error: 'Torneo no encontrado' });

  recalcularTablaTorneoCompleta(db, torneo.id);
  res.json({ message: 'Tabla recalculada correctamente' });
});

// GET /api/users - listar todos los usuarios (para admin al armar torneo)
router.get('/usuarios/todos', authMiddleware, adminMiddleware, (req, res) => {
  const db = getDb();
  const users = db.prepare('SELECT id, nombre, email, role FROM users ORDER BY nombre').all();
  res.json(users);
});

// GET /api/torneos/:id/tabla-mensual-cierre?mes=X&anio=Y
// Devuelve el cierre manual si existe, o { manual: false } para que el frontend use los defaults.
router.get('/:id/tabla-mensual-cierre', authMiddleware, (req, res) => {
  const db = getDb();
  const torneoId = parseInt(req.params.id);
  const mes  = parseInt(req.query.mes);
  const anio = parseInt(req.query.anio);
  if (!mes || !anio) return res.status(400).json({ error: 'mes y anio requeridos' });

  const cierre = db.prepare(
    'SELECT * FROM tabla_mensual_cierre WHERE torneo_id = ? AND mes = ? AND anio = ?'
  ).get(torneoId, mes, anio);

  if (!cierre) return res.json({ manual: false });

  let ganadores = [];
  try {
    const ids = JSON.parse(cierre.ganadores_json || '[]');
    ganadores = ids.map(id => {
      const u = db.prepare('SELECT id, nombre FROM users WHERE id = ?').get(id);
      return u || { id, nombre: '(desconocido)' };
    });
  } catch (_) {}

  let organizador = null;
  if (cierre.organizador_user_id) {
    organizador = db.prepare('SELECT id, nombre FROM users WHERE id = ?').get(cierre.organizador_user_id) || null;
  }

  res.json({
    manual: true,
    ganadores,
    organizador,
    nota: cierre.nota || null,
    updated_at: cierre.updated_at,
  });
});

// PUT /api/torneos/:id/tabla-mensual-cierre — solo superadmin
router.put('/:id/tabla-mensual-cierre', authMiddleware, (req, res) => {
  if (req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'Solo el superadmin puede editar el cierre' });
  }
  const db = getDb();
  const torneoId = parseInt(req.params.id);
  const { mes, anio, ganadores_ids, organizador_user_id, nota } = req.body;
  if (!mes || !anio) return res.status(400).json({ error: 'mes y anio requeridos' });

  db.prepare(`
    INSERT INTO tabla_mensual_cierre
      (torneo_id, mes, anio, ganadores_json, organizador_user_id, nota, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(torneo_id, mes, anio) DO UPDATE SET
      ganadores_json      = excluded.ganadores_json,
      organizador_user_id = excluded.organizador_user_id,
      nota                = excluded.nota,
      updated_by          = excluded.updated_by,
      updated_at          = datetime('now')
  `).run(
    torneoId, mes, anio,
    JSON.stringify(ganadores_ids || []),
    organizador_user_id || null,
    nota || null,
    req.user.id
  );

  res.json({ ok: true });
});

module.exports = router;
