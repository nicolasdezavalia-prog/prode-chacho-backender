/**
 * Router del módulo Mundial — Fase 1.
 *
 * Endpoints mínimos read-only/admin para configuración inicial.
 * NO incluye Fase 1:
 *   - carga de respuestas de usuarios
 *   - importador desde Excel
 *   - scoring / recálculo
 *   - ranking ni desempate
 *   - flujo operativo de ventanas/cambios
 *   - liquidación ni comida
 *
 * Aislamiento total: cero referencias a eventos/pronosticos/cruces/tabla_torneo/gdt_*.
 * Decisiones: sin TC Blue, torneos.tipo inmutable post-creación, seed restrictivo.
 */

const express = require('express');
const { getDb } = require('../db');
const { authMiddleware, adminMiddleware, requirePermiso } = require('../middleware/auth');
const equiposSeedMundial2026 = require('../data/mundial-2026-equipos');

const router = express.Router();

// Máquina de estados forward-only (Fase 1). Superadmin podrá forzar correcciones
// en una fase futura — no incluido todavía.
const TRANSICIONES_ESTADO = {
  configuracion:    ['abierto'],
  abierto:          ['cerrado'],
  cerrado:          ['grupos_jugados'],
  grupos_jugados:   ['cambios_abiertos'],
  cambios_abiertos: ['cambios_cerrados'],
  cambios_cerrados: ['resultados'],
  resultados:       ['finalizado'],
  finalizado:       [],
};

// Estados en los que se pueden editar campos no-estado del config.
// Después de 'abierto' el config queda congelado (excepto cambio de estado).
const ESTADOS_CONFIG_EDITABLE = new Set(['configuracion', 'abierto']);

// Campos prohibidos en el body de PUT /config (TC Blue fuera del alcance).
const CAMPOS_PROHIBIDOS_CONFIG = ['tc_blue_ars', 'tc_blue_ars_snapshot', 'tc', 'tc_blue'];

/**
 * Valida que el torneo exista y sea de tipo 'mundial_preguntas'.
 * Devuelve { torneo } si OK, o { error: { status, msg } } si falla.
 */
function getTorneoMundial(db, torneoId) {
  if (!Number.isFinite(torneoId) || torneoId <= 0) {
    return { error: { status: 400, msg: 'torneoId inválido' } };
  }
  const torneo = db.prepare('SELECT * FROM torneos WHERE id = ?').get(torneoId);
  if (!torneo) return { error: { status: 404, msg: 'Torneo no encontrado' } };
  if (torneo.tipo !== 'mundial_preguntas') {
    return { error: { status: 400, msg: 'El torneo no es de tipo Mundial' } };
  }
  return { torneo };
}

/**
 * Defaults del config cuando el torneo todavía no tiene fila en mundial_config.
 * Refleja los DEFAULT del schema (db.js).
 */
function getConfigDefaults(torneoId) {
  return {
    torneo_id: torneoId,
    estado: 'configuracion',
    costo_cambio_usd: 30,
    cambios_por_usuario: 3,
    deadline_carga: null,
    reglas_json: null,
    updated_by: null,
    updated_at: null,
  };
}

/**
 * UPSERT del config: si no existe la fila, la inserta con defaults.
 * Solo se llama desde endpoints de escritura (no contamina lecturas).
 */
function ensureConfig(db, torneoId) {
  db.prepare(
    'INSERT OR IGNORE INTO mundial_config (torneo_id) VALUES (?)'
  ).run(torneoId);
  return db.prepare('SELECT * FROM mundial_config WHERE torneo_id = ?').get(torneoId);
}

/**
 * Valida que el catálogo de equipos esté editable según el estado del torneo.
 * Solo editable en 'configuracion' o 'abierto'. Si no, devuelve { status: 409, msg }.
 * Devuelve null si está OK.
 *
 * Si el torneo no tiene fila en mundial_config todavía, se asume 'configuracion'
 * (default del schema), por lo tanto editable.
 */
function ensureCatalogoEditable(db, torneoId) {
  const row = db.prepare('SELECT estado FROM mundial_config WHERE torneo_id = ?').get(torneoId);
  const estado = row?.estado || 'configuracion';
  if (!ESTADOS_CONFIG_EDITABLE.has(estado)) {
    return {
      status: 409,
      msg: `Catálogo de equipos no editable en estado '${estado}'. Solo se permite en 'configuracion' o 'abierto'.`,
    };
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// GET /api/mundial/torneos — lista de torneos de tipo Mundial
// ────────────────────────────────────────────────────────────────────────────
router.get('/torneos', authMiddleware, (req, res) => {
  const db = getDb();
  const torneos = db.prepare(
    "SELECT * FROM torneos WHERE tipo = 'mundial_preguntas' ORDER BY id DESC"
  ).all();
  res.json(torneos);
});

// ────────────────────────────────────────────────────────────────────────────
// GET /api/mundial/:torneoId/config — lee config (defaults si no existe)
// ────────────────────────────────────────────────────────────────────────────
router.get('/:torneoId/config', authMiddleware, (req, res) => {
  const db = getDb();
  const torneoId = parseInt(req.params.torneoId, 10);
  const { error } = getTorneoMundial(db, torneoId);
  if (error) return res.status(error.status).json({ error: error.msg });

  // Lectura pura: no crea fila si no existe (devuelve defaults).
  const existing = db.prepare(
    'SELECT * FROM mundial_config WHERE torneo_id = ?'
  ).get(torneoId);
  res.json(existing || getConfigDefaults(torneoId));
});

// ────────────────────────────────────────────────────────────────────────────
// PUT /api/mundial/:torneoId/config — edita config (admin + permiso)
//   - estado: transiciones forward-only (TRANSICIONES_ESTADO)
//   - costo_cambio_usd / cambios_por_usuario / deadline_carga: editables solo
//     mientras estado ∈ {'configuracion', 'abierto'}
//   - reglas_json: idem
//   - rechaza tc_blue_ars y variantes (TC fuera del alcance)
// ────────────────────────────────────────────────────────────────────────────
router.put('/:torneoId/config', authMiddleware, adminMiddleware, requirePermiso('gestionar_mundial'), (req, res) => {
  const db = getDb();
  const torneoId = parseInt(req.params.torneoId, 10);
  const { error } = getTorneoMundial(db, torneoId);
  if (error) return res.status(error.status).json({ error: error.msg });

  // Defensa: rechazar campos prohibidos antes de cualquier escritura
  for (const c of CAMPOS_PROHIBIDOS_CONFIG) {
    if (c in req.body) {
      return res.status(400).json({ error: `Campo no soportado: ${c}` });
    }
  }

  const cfg = ensureConfig(db, torneoId);
  const updates = [];
  const values = [];

  // Transición de estado
  if (req.body.estado !== undefined) {
    const nuevo = req.body.estado;
    if (!Object.prototype.hasOwnProperty.call(TRANSICIONES_ESTADO, nuevo)) {
      return res.status(400).json({ error: `Estado desconocido: ${nuevo}` });
    }
    if (nuevo !== cfg.estado) {
      const permitidos = TRANSICIONES_ESTADO[cfg.estado] || [];
      if (!permitidos.includes(nuevo)) {
        return res.status(400).json({
          error: `Transición inválida: ${cfg.estado} → ${nuevo}`,
          desde: cfg.estado,
          permitidos,
        });
      }
      updates.push('estado = ?');
      values.push(nuevo);
    }
  }

  // Campos no-estado editables solo en estados tempranos
  const camposEditables = [
    { key: 'costo_cambio_usd',    cast: (v) => parseInt(v, 10) },
    { key: 'cambios_por_usuario', cast: (v) => parseInt(v, 10) },
    { key: 'deadline_carga',      cast: (v) => (v === '' || v === null ? null : String(v)) },
    { key: 'reglas_json',         cast: (v) => (v === '' || v === null ? null : (typeof v === 'string' ? v : JSON.stringify(v))) },
  ];

  const bloqueado = !ESTADOS_CONFIG_EDITABLE.has(cfg.estado);
  for (const { key, cast } of camposEditables) {
    if (req.body[key] !== undefined) {
      if (bloqueado) {
        return res.status(409).json({
          error: `Campo '${key}' no editable en estado '${cfg.estado}'`,
        });
      }
      const v = cast(req.body[key]);
      if ((key === 'costo_cambio_usd' || key === 'cambios_por_usuario') && (!Number.isInteger(v) || v < 0)) {
        return res.status(400).json({ error: `${key} debe ser entero ≥ 0` });
      }
      updates.push(`${key} = ?`);
      values.push(v);
    }
  }

  if (updates.length === 0) {
    return res.json(cfg);
  }

  updates.push('updated_by = ?');
  values.push(req.user.id);
  updates.push("updated_at = datetime('now')");
  values.push(torneoId);

  db.prepare(`UPDATE mundial_config SET ${updates.join(', ')} WHERE torneo_id = ?`).run(...values);
  res.json(db.prepare('SELECT * FROM mundial_config WHERE torneo_id = ?').get(torneoId));
});

// ────────────────────────────────────────────────────────────────────────────
// GET /api/mundial/:torneoId/equipos — catálogo de equipos del torneo
// ────────────────────────────────────────────────────────────────────────────
router.get('/:torneoId/equipos', authMiddleware, (req, res) => {
  const db = getDb();
  const torneoId = parseInt(req.params.torneoId, 10);
  const { error } = getTorneoMundial(db, torneoId);
  if (error) return res.status(error.status).json({ error: error.msg });

  const equipos = db.prepare(`
    SELECT * FROM mundial_equipos_catalogo
    WHERE torneo_id = ?
    ORDER BY COALESCE(grupo, 'ZZ') ASC, codigo ASC
  `).all(torneoId);
  res.json(equipos);
});

// ────────────────────────────────────────────────────────────────────────────
// POST /api/mundial/:torneoId/equipos — crear equipo en el catálogo
//   - codigo: normaliza a MAYÚSCULAS y trim; 2-10 caracteres
//   - emoji: opcional (bandera del país); nullable
//   - 409 si codigo duplicado
//   - 409 si el torneo no está en 'configuracion' o 'abierto'
// ────────────────────────────────────────────────────────────────────────────
router.post('/:torneoId/equipos', authMiddleware, adminMiddleware, requirePermiso('gestionar_mundial'), (req, res) => {
  const db = getDb();
  const torneoId = parseInt(req.params.torneoId, 10);
  const { error } = getTorneoMundial(db, torneoId);
  if (error) return res.status(error.status).json({ error: error.msg });

  const stateErr = ensureCatalogoEditable(db, torneoId);
  if (stateErr) return res.status(stateErr.status).json({ error: stateErr.msg });

  const { codigo, nombre, emoji, grupo } = req.body;
  if (!codigo || !nombre) {
    return res.status(400).json({ error: 'codigo y nombre son requeridos' });
  }
  const codigoNorm = String(codigo).toUpperCase().trim();
  if (codigoNorm.length < 2 || codigoNorm.length > 10) {
    return res.status(400).json({ error: 'codigo debe tener entre 2 y 10 caracteres' });
  }
  const nombreNorm = String(nombre).trim();
  if (nombreNorm.length === 0) {
    return res.status(400).json({ error: 'nombre no puede ser vacío' });
  }
  const grupoNorm = grupo === undefined || grupo === null || grupo === '' ? null : String(grupo).toUpperCase().trim();
  const emojiNorm = emoji === undefined || emoji === null || emoji === '' ? null : String(emoji).trim();

  try {
    const r = db.prepare(
      'INSERT INTO mundial_equipos_catalogo (torneo_id, codigo, nombre, emoji, grupo, activo) VALUES (?, ?, ?, ?, ?, 1)'
    ).run(torneoId, codigoNorm, nombreNorm, emojiNorm, grupoNorm);
    const eq = db.prepare('SELECT * FROM mundial_equipos_catalogo WHERE id = ?').get(r.lastInsertRowid);
    res.status(201).json(eq);
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: `Ya existe un equipo con código ${codigoNorm} en este torneo` });
    }
    throw err;
  }
});

// ────────────────────────────────────────────────────────────────────────────
// POST /api/mundial/:torneoId/equipos/seed-mundial-2026 — alta masiva (UPSERT)
//   - Inserta los 48 equipos del Mundial 2026 desde data/mundial-2026-equipos.js
//   - UPSERT: si no existe lo inserta; si existe (mismo torneo + código) actualiza
//     nombre, emoji, grupo, activo. Idempotente y re-sincronizable.
//   - Devuelve resumen: { creados, actualizados, total }
//   - 409 si el torneo no está en 'configuracion' o 'abierto'
//
// Notas:
//   - Pre-cargamos los códigos existentes en un Set para clasificar creados vs
//     actualizados sin necesidad de un extra check por fila (1 SELECT + 48 upserts).
//   - El UPSERT NO toca el `id` ni cambia el `codigo` — solo los campos derivados.
// ────────────────────────────────────────────────────────────────────────────
router.post('/:torneoId/equipos/seed-mundial-2026', authMiddleware, adminMiddleware, requirePermiso('gestionar_mundial'), (req, res) => {
  const db = getDb();
  const torneoId = parseInt(req.params.torneoId, 10);
  const { error } = getTorneoMundial(db, torneoId);
  if (error) return res.status(error.status).json({ error: error.msg });

  const stateErr = ensureCatalogoEditable(db, torneoId);
  if (stateErr) return res.status(stateErr.status).json({ error: stateErr.msg });

  // Pre-cargar códigos existentes para clasificar creados vs actualizados.
  const existentes = new Set(
    db.prepare('SELECT codigo FROM mundial_equipos_catalogo WHERE torneo_id = ?')
      .all(torneoId)
      .map(r => r.codigo)
  );

  const upsert = db.prepare(`
    INSERT INTO mundial_equipos_catalogo
      (torneo_id, codigo, nombre, emoji, grupo, activo)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(torneo_id, codigo) DO UPDATE SET
      nombre = excluded.nombre,
      emoji  = excluded.emoji,
      grupo  = excluded.grupo,
      activo = excluded.activo
  `);

  let creados = 0;
  let actualizados = 0;
  try {
    db.exec('BEGIN');
    for (const eq of equiposSeedMundial2026) {
      upsert.run(
        torneoId,
        eq.codigo,
        eq.nombre,
        eq.emoji ?? null,
        eq.grupo,
        eq.activo ?? 1,
      );
      if (existentes.has(eq.codigo)) actualizados++;
      else creados++;
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw err;
  }

  res.json({ creados, actualizados, total: equiposSeedMundial2026.length });
});

// ────────────────────────────────────────────────────────────────────────────
// PATCH /api/mundial/:torneoId/equipos/:equipoId — editar nombre/emoji/grupo/activo
//   - NO permite cambiar codigo (immutable para no romper referencias futuras)
//   - 409 si el torneo no está en 'configuracion' o 'abierto'
// ────────────────────────────────────────────────────────────────────────────
router.patch('/:torneoId/equipos/:equipoId', authMiddleware, adminMiddleware, requirePermiso('gestionar_mundial'), (req, res) => {
  const db = getDb();
  const torneoId = parseInt(req.params.torneoId, 10);
  const equipoId = parseInt(req.params.equipoId, 10);
  const { error } = getTorneoMundial(db, torneoId);
  if (error) return res.status(error.status).json({ error: error.msg });

  const stateErr = ensureCatalogoEditable(db, torneoId);
  if (stateErr) return res.status(stateErr.status).json({ error: stateErr.msg });

  const eq = db.prepare(
    'SELECT * FROM mundial_equipos_catalogo WHERE id = ? AND torneo_id = ?'
  ).get(equipoId, torneoId);
  if (!eq) return res.status(404).json({ error: 'Equipo no encontrado' });

  if (req.body.codigo !== undefined && String(req.body.codigo).toUpperCase().trim() !== eq.codigo) {
    return res.status(409).json({ error: 'No se puede cambiar el código de un equipo. Borralo y creá uno nuevo.' });
  }

  const updates = [];
  const values = [];

  if (req.body.nombre !== undefined) {
    const n = String(req.body.nombre).trim();
    if (n.length === 0) return res.status(400).json({ error: 'nombre no puede ser vacío' });
    updates.push('nombre = ?'); values.push(n);
  }
  if (req.body.emoji !== undefined) {
    const e = req.body.emoji === null || req.body.emoji === '' ? null : String(req.body.emoji).trim();
    updates.push('emoji = ?'); values.push(e);
  }
  if (req.body.grupo !== undefined) {
    const g = req.body.grupo === null || req.body.grupo === '' ? null : String(req.body.grupo).toUpperCase().trim();
    updates.push('grupo = ?'); values.push(g);
  }
  if (req.body.activo !== undefined) {
    updates.push('activo = ?'); values.push(req.body.activo ? 1 : 0);
  }

  if (updates.length === 0) return res.json(eq);

  values.push(equipoId);
  db.prepare(`UPDATE mundial_equipos_catalogo SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  res.json(db.prepare('SELECT * FROM mundial_equipos_catalogo WHERE id = ?').get(equipoId));
});

// ────────────────────────────────────────────────────────────────────────────
// DELETE /api/mundial/:torneoId/equipos/:equipoId — borrar equipo del catálogo
//   - 409 si el torneo no está en 'configuracion' o 'abierto'
//   - Fase 2.1: no hay respuestas de usuarios todavía, borrado seguro
//   - Fase 2.4 (futura): validar que no haya respuestas que referencien el código
// ────────────────────────────────────────────────────────────────────────────
router.delete('/:torneoId/equipos/:equipoId', authMiddleware, adminMiddleware, requirePermiso('gestionar_mundial'), (req, res) => {
  const db = getDb();
  const torneoId = parseInt(req.params.torneoId, 10);
  const equipoId = parseInt(req.params.equipoId, 10);
  const { error } = getTorneoMundial(db, torneoId);
  if (error) return res.status(error.status).json({ error: error.msg });

  const stateErr = ensureCatalogoEditable(db, torneoId);
  if (stateErr) return res.status(stateErr.status).json({ error: stateErr.msg });

  const eq = db.prepare(
    'SELECT id, codigo FROM mundial_equipos_catalogo WHERE id = ? AND torneo_id = ?'
  ).get(equipoId, torneoId);
  if (!eq) return res.status(404).json({ error: 'Equipo no encontrado' });

  db.prepare('DELETE FROM mundial_equipos_catalogo WHERE id = ?').run(equipoId);
  res.json({ ok: true, borrado: { id: eq.id, codigo: eq.codigo } });
});

// ────────────────────────────────────────────────────────────────────────────
// GET /api/mundial/:torneoId/preguntas — read-only en Fase 1
//   - Bulk-upsert e importador Excel quedan para Fase 2.
// ────────────────────────────────────────────────────────────────────────────
router.get('/:torneoId/preguntas', authMiddleware, (req, res) => {
  const db = getDb();
  const torneoId = parseInt(req.params.torneoId, 10);
  const { error } = getTorneoMundial(db, torneoId);
  if (error) return res.status(error.status).json({ error: error.msg });

  const preguntas = db.prepare(
    'SELECT * FROM mundial_preguntas WHERE torneo_id = ? ORDER BY numero ASC'
  ).all(torneoId);
  res.json(preguntas);
});

// ────────────────────────────────────────────────────────────────────────────
// GET /api/mundial/:torneoId/premios
// ────────────────────────────────────────────────────────────────────────────
router.get('/:torneoId/premios', authMiddleware, (req, res) => {
  const db = getDb();
  const torneoId = parseInt(req.params.torneoId, 10);
  const { error } = getTorneoMundial(db, torneoId);
  if (error) return res.status(error.status).json({ error: error.msg });

  const premios = db.prepare(
    'SELECT * FROM mundial_premios WHERE torneo_id = ? ORDER BY posicion ASC'
  ).all(torneoId);
  res.json(premios);
});

// ────────────────────────────────────────────────────────────────────────────
// PUT /api/mundial/:torneoId/premios/bulk
//   - Body: { premios: [{ posicion, usd, ars_manual? }, ...] }
//   - Editable mientras estado != 'finalizado'
//   - Rechaza duplicados de 'posicion' en el body
//   - ars_manual nullable, sin validación cruzada con usd
//   - usd e ars_manual pueden ser negativos (premios negativos = paga al pozo)
// ────────────────────────────────────────────────────────────────────────────
router.put('/:torneoId/premios/bulk', authMiddleware, adminMiddleware, requirePermiso('gestionar_mundial'), (req, res) => {
  const db = getDb();
  const torneoId = parseInt(req.params.torneoId, 10);
  const { error } = getTorneoMundial(db, torneoId);
  if (error) return res.status(error.status).json({ error: error.msg });

  const cfg = ensureConfig(db, torneoId);
  if (cfg.estado === 'finalizado') {
    return res.status(409).json({ error: 'No se pueden editar premios con torneo finalizado' });
  }

  const { premios } = req.body || {};
  if (!Array.isArray(premios)) {
    return res.status(400).json({ error: 'Se espera body.premios: array' });
  }

  // Validar cada item + duplicados de posicion
  const posicionesVistas = new Set();
  for (const p of premios) {
    if (!p || typeof p !== 'object') {
      return res.status(400).json({ error: 'Cada premio debe ser un objeto' });
    }
    if (!Number.isInteger(p.posicion) || p.posicion <= 0) {
      return res.status(400).json({ error: 'Cada premio requiere posicion entero positivo' });
    }
    if (!Number.isInteger(p.usd)) {
      return res.status(400).json({ error: `Posición ${p.posicion}: usd debe ser entero (puede ser negativo)` });
    }
    if (p.ars_manual !== undefined && p.ars_manual !== null && !Number.isInteger(p.ars_manual)) {
      return res.status(400).json({ error: `Posición ${p.posicion}: ars_manual debe ser entero o null` });
    }
    if (posicionesVistas.has(p.posicion)) {
      return res.status(400).json({ error: `Posición ${p.posicion} duplicada en el body` });
    }
    posicionesVistas.add(p.posicion);
  }

  const upsert = db.prepare(`
    INSERT INTO mundial_premios (torneo_id, posicion, usd, ars_manual)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(torneo_id, posicion) DO UPDATE SET
      usd = excluded.usd,
      ars_manual = excluded.ars_manual
  `);

  try {
    db.exec('BEGIN');
    for (const p of premios) {
      const ars = p.ars_manual === undefined ? null : p.ars_manual;
      upsert.run(torneoId, p.posicion, p.usd, ars);
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw e;
  }

  const rows = db.prepare(
    'SELECT * FROM mundial_premios WHERE torneo_id = ? ORDER BY posicion ASC'
  ).all(torneoId);
  res.json(rows);
});

module.exports = router;
