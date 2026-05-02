const express = require('express');
const { getDb } = require('../db');
const { authMiddleware, adminMiddleware, requirePermiso } = require('../middleware/auth');
const { recalcularTablaTorneoCompleta } = require('../logic/puntos');

const router = express.Router();

// GET /api/torneos
router.get('/', authMiddleware, (req, res) => {
  const db = getDb();
  const torneos = db.prepare('SELECT * FROM torneos ORDER BY id DESC').all();
  res.json(torneos);
});

// POST /api/torneos
router.post('/', authMiddleware, adminMiddleware, requirePermiso('crear_torneo'), (req, res) => {
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

// PATCH /api/torneos/:id — editar nombre, semestre, bloque1/2_nombre, activo
router.patch('/:id', authMiddleware, adminMiddleware, (req, res) => {
  const db = getDb();
  const torneo = db.prepare('SELECT * FROM torneos WHERE id = ?').get(req.params.id);
  if (!torneo) return res.status(404).json({ error: 'Torneo no encontrado' });

  const allowed = ['nombre', 'semestre', 'bloque1_nombre', 'bloque2_nombre', 'activo'];
  const fields = [];
  const values = [];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      fields.push(`${key} = ?`);
      values.push(req.body[key]);
    }
  }
  if (fields.length === 0) return res.json(torneo);

  values.push(req.params.id);
  db.prepare(`UPDATE torneos SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  const updated = db.prepare('SELECT * FROM torneos WHERE id = ?').get(req.params.id);
  res.json(updated);
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
    AND f.estado = 'finalizada'
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

// GET /api/torneos/h2h-global/:userId — H2H histórico de un jugador vs todos, todos los torneos
router.get('/h2h-global/:userId', authMiddleware, (req, res) => {
  const db = getDb();
  const uid = parseInt(req.params.userId);

  // Todos los cruces finalizados de todos los torneos donde participó este usuario
  const cruces = db.prepare(`
    SELECT c.*,
      f.nombre as fecha_nombre, f.numero as fecha_numero, f.mes, f.anio,
      t.id as torneo_id, t.nombre as torneo_nombre, t.semestre as torneo_semestre,
      u1.nombre as user1_nombre,
      u2.nombre as user2_nombre
    FROM cruces c
    JOIN fechas f ON c.fecha_id = f.id
    JOIN torneos t ON f.torneo_id = t.id
    JOIN users u1 ON c.user1_id = u1.id
    JOIN users u2 ON c.user2_id = u2.id
    WHERE (c.user1_id = ? OR c.user2_id = ?)
      AND c.ganador_fecha IS NOT NULL
      AND f.estado = 'finalizada'
    ORDER BY t.id ASC, f.numero ASC
  `).all(uid, uid);

  const rivalMap = {};

  for (const c of cruces) {
    const esUser1    = c.user1_id === uid;
    const miRol      = esUser1 ? 'user1' : 'user2';
    const rivalId    = esUser1 ? c.user2_id    : c.user1_id;
    const rivalNom   = esUser1 ? c.user2_nombre : c.user1_nombre;
    const ganadorFecha = c.ganador_fecha;
    const ganadorA     = c.ganador_tabla_a;
    const ganadorB     = c.ganador_tabla_b;
    const ganadorGDT   = c.ganador_gdt;

    if (!rivalMap[rivalId]) {
      rivalMap[rivalId] = {
        rival_id:     rivalId,
        rival_nombre: rivalNom,
        pj: 0, pg: 0, pe: 0, pp: 0,
        bloque_a: { g: 0, e: 0, p: 0 },
        bloque_b: { g: 0, e: 0, p: 0 },
        gdt:      { g: 0, e: 0, p: 0 },
        pts_total: 0,
        fechas: [],
      };
    }

    const r = rivalMap[rivalId];
    r.pj++;

    if (ganadorFecha === miRol)        { r.pg++; r.pts_total += esUser1 ? (c.pts_torneo_u1 || 0) : (c.pts_torneo_u2 || 0); }
    else if (ganadorFecha === 'empate') { r.pe++; r.pts_total += 1; }
    else                                { r.pp++; }

    if (ganadorA === miRol)        r.bloque_a.g++;
    else if (ganadorA === 'empate') r.bloque_a.e++;
    else if (ganadorA !== null)     r.bloque_a.p++;

    if (ganadorB === miRol)        r.bloque_b.g++;
    else if (ganadorB === 'empate') r.bloque_b.e++;
    else if (ganadorB !== null)     r.bloque_b.p++;

    if (ganadorGDT === miRol)        r.gdt.g++;
    else if (ganadorGDT === 'empate') r.gdt.e++;
    else if (ganadorGDT !== null)     r.gdt.p++;

    r.fechas.push({
      torneo_id:       c.torneo_id,
      torneo_nombre:   c.torneo_nombre,
      torneo_semestre: c.torneo_semestre,
      fecha_nombre:    c.fecha_nombre,
      fecha_numero:    c.fecha_numero,
      mes: c.mes, anio: c.anio,
      resultado: ganadorFecha === miRol ? 'G' : ganadorFecha === 'empate' ? 'E' : 'P',
      bloque_a:  ganadorA  === miRol ? 'G' : ganadorA  === 'empate' ? 'E' : ganadorA  ? 'P' : '—',
      bloque_b:  ganadorB  === miRol ? 'G' : ganadorB  === 'empate' ? 'E' : ganadorB  ? 'P' : '—',
      gdt:       ganadorGDT === miRol ? 'G' : ganadorGDT === 'empate' ? 'E' : ganadorGDT ? 'P' : '—',
      pi_yo:    esUser1 ? c.puntos_internos_u1 : c.puntos_internos_u2,
      pi_rival: esUser1 ? c.puntos_internos_u2 : c.puntos_internos_u1,
    });
  }

  const rivalArray = Object.values(rivalMap).sort((a, b) => b.pg - a.pg || a.pp - b.pp);
  res.json(rivalArray);
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

// GET /api/torneos/:id/totales-bloque?fecha_id=X — puntos por bloque de una fecha específica
router.get('/:id/totales-bloque', authMiddleware, (req, res) => {
  const db = getDb();
  const torneoId = parseInt(req.params.id);
  const fechaId  = req.query.fecha_id ? parseInt(req.query.fecha_id) : null;

  // Nombres de los bloques desde el torneo (configurados a nivel torneo, no fecha)
  const nombresRow = db.prepare('SELECT bloque1_nombre, bloque2_nombre FROM torneos WHERE id = ?').get(torneoId);
  const bloqueANombre = nombresRow?.bloque1_nombre || 'Bloque 1';
  const bloqueBNombre = nombresRow?.bloque2_nombre || 'Bloque 2';

  // Todos los jugadores del torneo
  const jugadores = db.prepare(`
    SELECT u.id, u.nombre FROM torneo_jugadores tj
    JOIN users u ON tj.user_id = u.id
    WHERE tj.torneo_id = ?
  `).all(torneoId);

  // Sumar puntos por bloque, filtrado a la fecha si se provee
  const puntosRows = fechaId
    ? db.prepare(`
        SELECT p.user_id,
          SUM(CASE WHEN e.orden BETWEEN 1 AND 15 THEN COALESCE(p.puntos_obtenidos, 0) ELSE 0 END) AS pts_a,
          SUM(CASE WHEN e.orden BETWEEN 16 AND 30 THEN COALESCE(p.puntos_obtenidos, 0) ELSE 0 END) AS pts_b
        FROM pronosticos p
        JOIN eventos e ON p.evento_id = e.id
        WHERE e.fecha_id = ?
          AND p.puntos_obtenidos IS NOT NULL
        GROUP BY p.user_id
      `).all(fechaId)
    : db.prepare(`
        SELECT p.user_id,
          SUM(CASE WHEN e.orden BETWEEN 1 AND 15 THEN COALESCE(p.puntos_obtenidos, 0) ELSE 0 END) AS pts_a,
          SUM(CASE WHEN e.orden BETWEEN 16 AND 30 THEN COALESCE(p.puntos_obtenidos, 0) ELSE 0 END) AS pts_b
        FROM pronosticos p
        JOIN eventos e ON p.evento_id = e.id
        JOIN fechas f ON e.fecha_id = f.id
        WHERE f.torneo_id = ?
          AND p.puntos_obtenidos IS NOT NULL
        GROUP BY p.user_id
      `).all(torneoId);

  const puntosMap = {};
  for (const r of puntosRows) {
    puntosMap[r.user_id] = { pts_a: r.pts_a || 0, pts_b: r.pts_b || 0 };
  }

  const sortByTotal = (a, b) => b.total_pts - a.total_pts;

  const jugadoresA = jugadores.map(j => ({
    user_id: j.id, nombre: j.nombre,
    total_pts: puntosMap[j.id]?.pts_a || 0
  })).sort(sortByTotal);

  const jugadoresB = jugadores.map(j => ({
    user_id: j.id, nombre: j.nombre,
    total_pts: puntosMap[j.id]?.pts_b || 0
  })).sort(sortByTotal);

  res.json({
    bloque_a: { nombre: bloqueANombre, jugadores: jugadoresA },
    bloque_b: { nombre: bloqueBNombre, jugadores: jugadoresB },
  });
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

// PUT /api/torneos/:id/tabla-mensual-cierre
router.put('/:id/tabla-mensual-cierre', authMiddleware, requirePermiso('editar_tabla_mensual'), (req, res) => {
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


// GET /api/torneos/records — Records históricos globales (cross-torneos)
router.get('/records', authMiddleware, (req, res) => {
  const db = getDb();

  // 1. Tabla Acumulada General (suma de tabla_torneo de todos los torneos)
  const tablaRows = db.prepare(`
    SELECT
      u.id, u.nombre,
      SUM(tt.puntos)              AS p1,
      SUM(tt.bonus)               AS bonus,
      SUM(tt.puntos + tt.bonus)   AS p2,
      SUM(tt.pj)                  AS pj,
      SUM(tt.victorias)           AS pg,
      SUM(tt.empates)             AS pe,
      SUM(tt.derrotas)            AS pp
    FROM tabla_torneo tt
    JOIN users u ON tt.user_id = u.id
    GROUP BY u.id
    ORDER BY p2 DESC, pg DESC
  `).all();

  // 2. Top por Desafío — Bloque A, Bloque B, GDT
  const crucesFin = db.prepare(`
    SELECT c.user1_id, c.user2_id,
           c.ganador_tabla_a, c.ganador_tabla_b, c.ganador_gdt,
           c.pts_tabla_a_u1, c.pts_tabla_a_u2,
           c.pts_tabla_b_u1, c.pts_tabla_b_u2,
           c.gdt_duelos_u1,  c.gdt_duelos_u2
    FROM cruces c
    JOIN fechas f ON c.fecha_id = f.id
    WHERE c.ganador_fecha IS NOT NULL AND f.estado = 'finalizada'
  `).all();

  const desafio = {}; // { userId: { id, nombre, a:{pg,pts,pj}, b:{pg,pts,pj}, gdt:{pg,pts,pj} } }

  const ensure = (uid, nombre) => {
    if (!desafio[uid]) desafio[uid] = {
      id: uid, nombre,
      a:   { pg: 0, pts: 0, pj: 0 },
      b:   { pg: 0, pts: 0, pj: 0 },
      gdt: { pg: 0, pts: 0, pj: 0 },
    };
  };

  // Resolver nombres una vez
  const userMap = {};
  db.prepare('SELECT id, nombre FROM users').all().forEach(u => { userMap[u.id] = u.nombre; });

  for (const c of crucesFin) {
    const u1 = c.user1_id, u2 = c.user2_id;
    ensure(u1, userMap[u1] || '?');
    ensure(u2, userMap[u2] || '?');

    // Bloque A
    if (c.ganador_tabla_a) {
      desafio[u1].a.pj++; desafio[u2].a.pj++;
      desafio[u1].a.pts += (c.pts_tabla_a_u1 || 0);
      desafio[u2].a.pts += (c.pts_tabla_a_u2 || 0);
      if (c.ganador_tabla_a === 'user1') desafio[u1].a.pg++;
      else if (c.ganador_tabla_a === 'user2') desafio[u2].a.pg++;
    }
    // Bloque B
    if (c.ganador_tabla_b) {
      desafio[u1].b.pj++; desafio[u2].b.pj++;
      desafio[u1].b.pts += (c.pts_tabla_b_u1 || 0);
      desafio[u2].b.pts += (c.pts_tabla_b_u2 || 0);
      if (c.ganador_tabla_b === 'user1') desafio[u1].b.pg++;
      else if (c.ganador_tabla_b === 'user2') desafio[u2].b.pg++;
    }
    // GDT
    if (c.ganador_gdt) {
      desafio[u1].gdt.pj++; desafio[u2].gdt.pj++;
      desafio[u1].gdt.pts += (c.gdt_duelos_u1 || 0);
      desafio[u2].gdt.pts += (c.gdt_duelos_u2 || 0);
      if (c.ganador_gdt === 'user1') desafio[u1].gdt.pg++;
      else if (c.ganador_gdt === 'user2') desafio[u2].gdt.pg++;
    }
  }

  const desafioArr = Object.values(desafio);
  const sortTop = (key) => [...desafioArr]
    .filter(r => r[key].pj > 0)
    .sort((a, b) => b[key].pg - a[key].pg || b[key].pts - a[key].pts)
    .map(r => ({
      id: r.id, nombre: r.nombre,
      pg: r[key].pg, pts: r[key].pts, pj: r[key].pj,
      efect: r[key].pj ? Math.round(r[key].pg / r[key].pj * 100) : 0,
    }));

  const top_desafio = {
    gdt:     sortTop('gdt'),
    bloque_a: sortTop('a'),
    bloque_b: sortTop('b'),
  };

  // 3. Campeones y Últimos por torneo
  const torneos = db.prepare('SELECT id, nombre, semestre FROM torneos ORDER BY id').all();
  const campeones = [], ultimos = [];
  for (const t of torneos) {
    const filas = db.prepare(`
      SELECT tt.user_id, tt.puntos, tt.bonus, tt.victorias, tt.pj, u.nombre
      FROM tabla_torneo tt JOIN users u ON tt.user_id = u.id
      WHERE tt.torneo_id = ? AND tt.pj > 0
      ORDER BY (tt.puntos + tt.bonus) DESC, tt.victorias DESC
    `).all(t.id);
    if (filas.length === 0) continue;
    const base = { torneo_id: t.id, torneo_nombre: t.nombre, torneo_semestre: t.semestre };
    campeones.push({ ...base, jugador: { id: filas[0].user_id, nombre: filas[0].nombre, pts: filas[0].puntos + filas[0].bonus } });
    const last = filas[filas.length - 1];
    ultimos.push({ ...base, jugador: { id: last.user_id, nombre: last.nombre, pts: last.puntos + last.bonus } });
  }

  // 4. Eficiencia
  const eficiencia = tablaRows
    .filter(r => r.pj > 0)
    .map(r => ({ id: r.id, nombre: r.nombre, pg: r.pg, pe: r.pe, pp: r.pp, pj: r.pj, pct: Math.round(r.pg / r.pj * 100) }))
    .sort((a, b) => b.pct - a.pct);

  // 5. Coleccionista de bonus
  const bonus_top = tablaRows
    .filter(r => r.bonus > 0)
    .map(r => ({ id: r.id, nombre: r.nombre, bonus: r.bonus }))
    .sort((a, b) => b.bonus - a.bonus);

  // 6. Comidas ganadas (ganadores_json de tabla_mensual_cierre)
  const cierresAll = db.prepare('SELECT ganadores_json FROM tabla_mensual_cierre WHERE ganadores_json IS NOT NULL').all();
  const comidasMap = {};
  for (const c of cierresAll) {
    try {
      const ids = JSON.parse(c.ganadores_json || '[]');
      for (const id of ids) comidasMap[id] = (comidasMap[id] || 0) + 1;
    } catch (_) {}
  }
  const comidas_ganadas = Object.entries(comidasMap)
    .map(([id, count]) => ({ id: parseInt(id), nombre: userMap[parseInt(id)] || '?', count }))
    .sort((a, b) => b.count - a.count);

  // 7. Organizadores de comidas
  const orgRows = db.prepare(`
    SELECT organizador_user_id, COUNT(*) as count
    FROM comidas_mensuales
    WHERE organizador_user_id IS NOT NULL
    GROUP BY organizador_user_id
    ORDER BY count DESC
  `).all();
  const organizadores = orgRows.map(r => ({
    id: r.organizador_user_id,
    nombre: userMap[r.organizador_user_id] || '?',
    count: r.count,
  }));

  // 8. Racha actual por jugador (cross-torneos, orden cronológico por anio/mes/numero)
  const crucesCrono = db.prepare(`
    SELECT c.user1_id, c.user2_id, c.ganador_fecha,
           f.anio, f.mes, f.numero
    FROM cruces c
    JOIN fechas f ON c.fecha_id = f.id
    WHERE c.ganador_fecha IS NOT NULL AND f.estado = 'finalizada'
    ORDER BY f.anio ASC, f.mes ASC, f.numero ASC
  `).all();

  // Para cada usuario, recorrer en orden y calcular racha actual
  const rachaMap = {}; // { userId: { tipo: 'V'|'D'|'E', count } }
  for (const c of crucesCrono) {
    for (const [uid, side] of [[c.user1_id, 'user1'], [c.user2_id, 'user2']]) {
      const won = c.ganador_fecha === side;
      const lost = c.ganador_fecha !== side && c.ganador_fecha !== 'empate';
      const tipo = won ? 'V' : lost ? 'D' : 'E';
      if (!rachaMap[uid]) { rachaMap[uid] = { tipo, count: 1 }; continue; }
      if (rachaMap[uid].tipo === tipo) rachaMap[uid].count++;
      else rachaMap[uid] = { tipo, count: 1 };
    }
  }
  const rachas = Object.entries(rachaMap)
    .map(([uid, r]) => ({ id: parseInt(uid), nombre: userMap[parseInt(uid)] || '?', tipo: r.tipo, count: r.count }))
    .sort((a, b) => b.count - a.count);

  // 9. Promedio de puntos internos por fecha
  const piMap = {};
  for (const c of crucesFin) {
    for (const [uid, pts] of [[c.user1_id, c.pts_tabla_a_u1 + c.pts_tabla_b_u1], [c.user2_id, c.pts_tabla_a_u2 + c.pts_tabla_b_u2]]) {
      if (!piMap[uid]) piMap[uid] = { sum: 0, count: 0 };
      piMap[uid].sum += (pts || 0);
      piMap[uid].count++;
    }
  }
  const promPuntos = Object.entries(piMap)
    .filter(([, v]) => v.count > 0)
    .map(([uid, v]) => ({ id: parseInt(uid), nombre: userMap[parseInt(uid)] || '?', promedio: Math.round((v.sum / v.count) * 10) / 10, partidos: v.count }))
    .sort((a, b) => b.promedio - a.promedio);

  // 10. Récord en un solo cruce (mayor puntos_internos en una fecha)
  const recordCruces = db.prepare(`
    SELECT c.user1_id, c.user2_id, c.puntos_internos_u1, c.puntos_internos_u2,
           f.nombre as fecha_nombre, f.numero, t.nombre as torneo_nombre, t.semestre as torneo_semestre
    FROM cruces c
    JOIN fechas f ON c.fecha_id = f.id
    JOIN torneos t ON f.torneo_id = t.id
    WHERE c.ganador_fecha IS NOT NULL AND f.estado = 'finalizada'
    ORDER BY (c.puntos_internos_u1 + c.puntos_internos_u2) DESC
    LIMIT 5
  `).all();
  const topCruces = recordCruces.map(c => ({
    jugador1: { id: c.user1_id, nombre: userMap[c.user1_id] || '?', pts: c.puntos_internos_u1 },
    jugador2: { id: c.user2_id, nombre: userMap[c.user2_id] || '?', pts: c.puntos_internos_u2 },
    fecha_nombre: c.fecha_nombre,
    torneo_nombre: c.torneo_nombre,
    torneo_semestre: c.torneo_semestre,
    total: (c.puntos_internos_u1 || 0) + (c.puntos_internos_u2 || 0),
  }));

  // 11. Rivalidad más disputada (par con más partidos y resultado más parejo)
  const pares = {};
  for (const c of crucesFin) {
    const key = [Math.min(c.user1_id, c.user2_id), Math.max(c.user1_id, c.user2_id)].join('-');
    if (!pares[key]) pares[key] = { u1: Math.min(c.user1_id, c.user2_id), u2: Math.max(c.user1_id, c.user2_id), pj: 0, wins1: 0, wins2: 0 };
    pares[key].pj++;
    const winner_id = c.ganador_fecha === 'user1' ? c.user1_id : c.ganador_fecha === 'user2' ? c.user2_id : null;
    if (winner_id === pares[key].u1) pares[key].wins1++;
    else if (winner_id === pares[key].u2) pares[key].wins2++;
  }
  const rivalidades = Object.values(pares)
    .filter(p => p.pj >= 2)
    .map(p => ({
      jugador1: { id: p.u1, nombre: userMap[p.u1] || '?' },
      jugador2: { id: p.u2, nombre: userMap[p.u2] || '?' },
      pj: p.pj,
      wins1: p.wins1,
      wins2: p.wins2,
      diferencia: Math.abs(p.wins1 - p.wins2),
    }))
    .sort((a, b) => a.diferencia - b.diferencia || b.pj - a.pj)
    .slice(0, 5);

  // 12. Asistencia a comidas (jugadores con user_id, asistio=1)
  const asistenciaRows = db.prepare(`
    SELECT cp.user_id, COUNT(*) as count
    FROM comidas_participantes cp
    WHERE cp.user_id IS NOT NULL AND cp.asistio = 1
    GROUP BY cp.user_id
    ORDER BY count DESC
  `).all();
  const asistencia = asistenciaRows.map(r => ({
    id: r.user_id, nombre: userMap[r.user_id] || '?', count: r.count,
  }));

  // 13. Comida más concurrida
  const comidaMasConcurrida = db.prepare(`
    SELECT cm.id, cm.mes, cm.anio, cm.lugar,
           COUNT(cp.id) as asistentes
    FROM comidas_mensuales cm
    JOIN comidas_participantes cp ON cp.comida_id = cm.id AND cp.asistio = 1
    WHERE cm.estado = 'realizada'
    GROUP BY cm.id
    ORDER BY asistentes DESC
    LIMIT 1
  `).get();

  res.json({
    tabla_acumulada: tablaRows,
    top_desafio,
    campeones,
    ultimos,
    eficiencia,
    bonus_top,
    comidas_ganadas,
    organizadores,
    rachas,
    prom_puntos: promPuntos,
    top_cruces: topCruces,
    rivalidades,
    asistencia,
    comida_mas_concurrida: comidaMasConcurrida || null,
  });
});

module.exports = router;
