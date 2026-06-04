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
const equiposSeedMundial2026   = require('../data/mundial-2026-equipos');
const preguntasSeedMundial2026 = require('../data/mundial-2026-preguntas');
const { validarConfigJson, TIPOS_PREGUNTA } = require('../logic/mundial-validar-config');
const { validarRespuesta } = require('../logic/mundial-validar-respuesta');
const { validarResultado } = require('../logic/mundial-validar-resultado');
const { calcularRanking, calcularMisPuntos } = require('../logic/mundial-scoring');
const { filtrarTorneosPorAcceso, usuarioPuedeAccederTorneo } = require('../logic/torneo-acceso');
const { validarItemCambio } = require('../logic/mundial-validar-cambio');

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
 * Variante del helper que incluye check de visibilidad por torneo. Para
 * endpoints "de usuario" (lectura/escritura no-admin) que requieren que el
 * caller esté asignado al torneo (admin/superadmin bypassean).
 * Devuelve 403 si el user no pertenece. Patrón idéntico a getTorneoMundial.
 */
function getTorneoMundialConAcceso(db, torneoId, user) {
  const base = getTorneoMundial(db, torneoId);
  if (base.error) return base;
  if (!usuarioPuedeAccederTorneo(db, base.torneo.id, user)) {
    return { error: { status: 403, msg: 'No tenés acceso a este torneo Mundial' } };
  }
  return base;
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

// ── Helpers preguntas (Fase 2.2) ────────────────────────────────────────────
// Guardia granular:
//   - 'configuracion': editable TODO (enunciado, aclaracion, tipo, config, activa, etc.).
//   - 'abierto':       editable PARCIAL (solo enunciado, aclaracion, activa).
//   - resto:           BLOQUEADO (409).
// Inmutable post-creación independientemente del estado:
//   - numero
//   - tipo_pregunta
const ESTADOS_PREGUNTAS_FULL    = new Set(['configuracion']);
// PATCH de preguntas: ahora también permitido en 'grupos_jugados' pero SOLO
// para el campo `cambio_habilitado`. Eso evita reabrir la carga normal.
const ESTADOS_PREGUNTAS_PATCH   = new Set(['configuracion', 'abierto', 'grupos_jugados']);
// `cambio_habilitado` (Fase 5) es un flag display/eligibilidad, no toca shape
// de la pregunta — editable en los mismos estados que enunciado/aclaracion.
const CAMPOS_PATCH_EN_ABIERTO   = new Set(['enunciado', 'aclaracion', 'activa', 'cambio_habilitado']);
const CAMPOS_PATCH_EN_CONFIG    = new Set(['enunciado', 'aclaracion', 'activa', 'config_json', 'orden_display', 'cambio_habilitado']);
// En 'grupos_jugados' SOLO se permite togglear cambio_habilitado. Cualquier
// otro campo en el body devuelve 409.
const CAMPOS_PATCH_EN_GRUPOS    = new Set(['cambio_habilitado']);

function getEstadoTorneo(db, torneoId) {
  const row = db.prepare('SELECT estado FROM mundial_config WHERE torneo_id = ?').get(torneoId);
  return row?.estado || 'configuracion';
}

function ensurePreguntasFullyEditable(db, torneoId) {
  const estado = getEstadoTorneo(db, torneoId);
  if (!ESTADOS_PREGUNTAS_FULL.has(estado)) {
    return {
      status: 409,
      msg: `Operación bloqueada: preguntas solo son totalmente editables en estado 'configuracion' (estado actual: '${estado}').`,
    };
  }
  return null;
}

function ensurePreguntasPatchable(db, torneoId) {
  const estado = getEstadoTorneo(db, torneoId);
  if (!ESTADOS_PREGUNTAS_PATCH.has(estado)) {
    return {
      status: 409,
      msg: `PATCH de preguntas bloqueado en estado '${estado}'. Permitido solo en 'configuracion', 'abierto' o 'grupos_jugados' (este último solo para 'cambio_habilitado').`,
      estado,
    };
  }
  return { status: null, estado };
}

function camposEditablesPatch(estado) {
  if (estado === 'configuracion')   return CAMPOS_PATCH_EN_CONFIG;
  if (estado === 'abierto')         return CAMPOS_PATCH_EN_ABIERTO;
  if (estado === 'grupos_jugados')  return CAMPOS_PATCH_EN_GRUPOS;
  return new Set();
}

/**
 * Cross-check warning. Dada una lista de códigos referenciados desde el config_json,
 * devuelve los que NO están en mundial_equipos_catalogo del torneo.
 * En Fase 2.2 es warning (no rompe POST/PATCH). En Fase 2.4 va a pasar a error.
 */
function equiposFaltantes(db, torneoId, codigosReferenciados) {
  if (!Array.isArray(codigosReferenciados) || codigosReferenciados.length === 0) return [];
  const placeholders = codigosReferenciados.map(() => '?').join(',');
  const found = db.prepare(
    `SELECT codigo FROM mundial_equipos_catalogo WHERE torneo_id = ? AND codigo IN (${placeholders})`
  ).all(torneoId, ...codigosReferenciados).map(r => r.codigo);
  return codigosReferenciados.filter(c => !found.includes(c));
}

// ────────────────────────────────────────────────────────────────────────────
// GET /api/mundial/torneos — lista de torneos de tipo Mundial
// ────────────────────────────────────────────────────────────────────────────
router.get('/torneos', authMiddleware, (req, res) => {
  const db = getDb();
  const todos = db.prepare(
    "SELECT * FROM torneos WHERE tipo = 'mundial_preguntas' ORDER BY id DESC"
  ).all();
  // Visibilidad por torneo: admin/superadmin ve todos; users comunes solo
  // ven los Mundial donde están asignados en torneo_jugadores.
  const visibles = filtrarTorneosPorAcceso(todos, db, req.user);
  res.json(visibles);
});

// ────────────────────────────────────────────────────────────────────────────
// GET /api/mundial/:torneoId/config — lee config (defaults si no existe)
// ────────────────────────────────────────────────────────────────────────────
router.get('/:torneoId/config', authMiddleware, (req, res) => {
  const db = getDb();
  const torneoId = parseInt(req.params.torneoId, 10);
  const { error } = getTorneoMundialConAcceso(db, torneoId, req.user);
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
    const nuevo  = req.body.estado;
    const forzar = req.body.force === true;
    if (!Object.prototype.hasOwnProperty.call(TRANSICIONES_ESTADO, nuevo)) {
      return res.status(400).json({ error: `Estado desconocido: ${nuevo}` });
    }
    if (nuevo !== cfg.estado) {
      // Fase preprod: admin con permiso puede saltar la máquina de estados
      // explícitamente con `force: true`. NO se borran respuestas/resultados;
      // es responsabilidad del admin si genera inconsistencias al retroceder.
      if (!forzar) {
        const permitidos = TRANSICIONES_ESTADO[cfg.estado] || [];
        if (!permitidos.includes(nuevo)) {
          return res.status(400).json({
            error: `Transición inválida: ${cfg.estado} → ${nuevo}. Para saltar la máquina enviá { force: true }.`,
            desde: cfg.estado,
            permitidos,
          });
        }
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
  const { error } = getTorneoMundialConAcceso(db, torneoId, req.user);
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

  const { codigo, nombre, emoji, grupo, confederacion } = req.body;
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
  const confNorm  = confederacion === undefined || confederacion === null || confederacion === ''
    ? null : String(confederacion).toUpperCase().trim();

  try {
    const r = db.prepare(
      'INSERT INTO mundial_equipos_catalogo (torneo_id, codigo, nombre, emoji, grupo, confederacion, activo) VALUES (?, ?, ?, ?, ?, ?, 1)'
    ).run(torneoId, codigoNorm, nombreNorm, emojiNorm, grupoNorm, confNorm);
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
      (torneo_id, codigo, nombre, emoji, grupo, confederacion, activo)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(torneo_id, codigo) DO UPDATE SET
      nombre        = excluded.nombre,
      emoji         = excluded.emoji,
      grupo         = excluded.grupo,
      confederacion = excluded.confederacion,
      activo        = excluded.activo
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
        eq.confederacion ?? null,
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
  if (req.body.confederacion !== undefined) {
    const c = req.body.confederacion === null || req.body.confederacion === ''
      ? null : String(req.body.confederacion).toUpperCase().trim();
    updates.push('confederacion = ?'); values.push(c);
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
// GET /api/mundial/:torneoId/preguntas — lista de preguntas del torneo
//   - Lectura abierta a cualquier user autenticado.
//   - Query param ?activa=1 → filtra solo las preguntas activas (uso de user).
//     Sin el filtro, devuelve todas (uso admin).
// ────────────────────────────────────────────────────────────────────────────
router.get('/:torneoId/preguntas', authMiddleware, (req, res) => {
  const db = getDb();
  const torneoId = parseInt(req.params.torneoId, 10);
  const { error } = getTorneoMundialConAcceso(db, torneoId, req.user);
  if (error) return res.status(error.status).json({ error: error.msg });

  const filtroActiva = req.query.activa === '1';
  const sql = filtroActiva
    ? 'SELECT * FROM mundial_preguntas WHERE torneo_id = ? AND activa = 1 ORDER BY numero ASC'
    : 'SELECT * FROM mundial_preguntas WHERE torneo_id = ? ORDER BY numero ASC';
  const preguntas = db.prepare(sql).all(torneoId);
  res.json(preguntas);
});

// ────────────────────────────────────────────────────────────────────────────
// POST /api/mundial/:torneoId/preguntas — crear pregunta individual
//   - Solo en 'configuracion' (ensurePreguntasFullyEditable).
//   - Valida config_json strict según tipo_pregunta.
//   - 409 si numero duplicado en el torneo.
//   - Devuelve { pregunta, warnings: [{ codigos_no_encontrados: [...] }] }.
//     warnings vacío si no hay códigos faltantes en mundial_equipos_catalogo.
// ────────────────────────────────────────────────────────────────────────────
router.post('/:torneoId/preguntas', authMiddleware, adminMiddleware, requirePermiso('gestionar_mundial'), (req, res) => {
  const db = getDb();
  const torneoId = parseInt(req.params.torneoId, 10);
  const { error } = getTorneoMundial(db, torneoId);
  if (error) return res.status(error.status).json({ error: error.msg });

  const stateErr = ensurePreguntasFullyEditable(db, torneoId);
  if (stateErr) return res.status(stateErr.status).json({ error: stateErr.msg });

  const { numero, enunciado, aclaracion, tipo_pregunta, config_json, orden_display, activa } = req.body || {};
  if (!Number.isInteger(numero) || numero <= 0) {
    return res.status(400).json({ error: 'numero entero positivo requerido', campo: 'numero' });
  }
  if (typeof enunciado !== 'string' || enunciado.trim().length === 0) {
    return res.status(400).json({ error: 'enunciado string no vacío requerido', campo: 'enunciado' });
  }
  if (!TIPOS_PREGUNTA.includes(tipo_pregunta)) {
    return res.status(400).json({
      error: `tipo_pregunta inválido. Permitidos: ${TIPOS_PREGUNTA.join(', ')}`,
      campo: 'tipo_pregunta',
    });
  }
  if (config_json === undefined || config_json === null) {
    return res.status(400).json({ error: 'config_json requerido', campo: 'config_json' });
  }

  const v = validarConfigJson(tipo_pregunta, config_json);
  if (!v.ok) return res.status(400).json({ error: v.error, campo: v.campo });

  const configStr = typeof config_json === 'string' ? config_json : JSON.stringify(config_json);
  const warnings  = [];
  const missing   = equiposFaltantes(db, torneoId, v.codigos_referenciados);
  if (missing.length > 0) warnings.push({ codigos_no_encontrados: missing });

  try {
    const r = db.prepare(`
      INSERT INTO mundial_preguntas
        (torneo_id, numero, enunciado, aclaracion, tipo_pregunta, config_json, orden_display, activa)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      torneoId,
      numero,
      String(enunciado).trim(),
      aclaracion === undefined || aclaracion === null || aclaracion === '' ? null : String(aclaracion).trim(),
      tipo_pregunta,
      configStr,
      Number.isInteger(orden_display) ? orden_display : 0,
      activa === undefined || activa === null ? 1 : (activa ? 1 : 0),
    );
    const created = db.prepare('SELECT * FROM mundial_preguntas WHERE id = ?').get(r.lastInsertRowid);
    res.status(201).json({ pregunta: created, warnings });
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: `Ya existe una pregunta con numero ${numero} en este torneo` });
    }
    throw err;
  }
});

// ────────────────────────────────────────────────────────────────────────────
// PUT /api/mundial/:torneoId/preguntas/bulk — UPSERT masivo
//   - Solo en 'configuracion'.
//   - Pre-valida TODAS las preguntas (fail-fast atómico): si una falla, ninguna
//     se persiste (transacción aborta).
//   - UPSERT por (torneo_id, numero): si existe, pisa todos los campos.
//   - Devuelve { creados, actualizados, total, warnings: [{ pregunta_numero, codigos_no_encontrados }] }.
// ────────────────────────────────────────────────────────────────────────────
router.put('/:torneoId/preguntas/bulk', authMiddleware, adminMiddleware, requirePermiso('gestionar_mundial'), (req, res) => {
  const db = getDb();
  const torneoId = parseInt(req.params.torneoId, 10);
  const { error } = getTorneoMundial(db, torneoId);
  if (error) return res.status(error.status).json({ error: error.msg });

  const stateErr = ensurePreguntasFullyEditable(db, torneoId);
  if (stateErr) return res.status(stateErr.status).json({ error: stateErr.msg });

  const { preguntas } = req.body || {};
  if (!Array.isArray(preguntas)) {
    return res.status(400).json({ error: 'Se espera body.preguntas: array' });
  }

  // Pre-validar TODAS antes de tocar la DB
  const items = [];
  const numerosVistos = new Set();
  for (let i = 0; i < preguntas.length; i++) {
    const p = preguntas[i];
    if (!p || typeof p !== 'object') {
      return res.status(400).json({ error: `Item ${i} debe ser objeto` });
    }
    if (!Number.isInteger(p.numero) || p.numero <= 0) {
      return res.status(400).json({ error: `Item ${i}: numero entero positivo requerido` });
    }
    if (numerosVistos.has(p.numero)) {
      return res.status(400).json({ error: `numero ${p.numero} duplicado en el body` });
    }
    numerosVistos.add(p.numero);
    if (typeof p.enunciado !== 'string' || p.enunciado.trim().length === 0) {
      return res.status(400).json({ error: `numero ${p.numero}: enunciado string no vacío requerido` });
    }
    if (!TIPOS_PREGUNTA.includes(p.tipo_pregunta)) {
      return res.status(400).json({
        error: `numero ${p.numero}: tipo_pregunta inválido. Permitidos: ${TIPOS_PREGUNTA.join(', ')}`,
      });
    }
    if (p.config_json === undefined || p.config_json === null) {
      return res.status(400).json({ error: `numero ${p.numero}: config_json requerido` });
    }
    const v = validarConfigJson(p.tipo_pregunta, p.config_json);
    if (!v.ok) {
      return res.status(400).json({ error: `numero ${p.numero}: ${v.error}`, campo: v.campo });
    }
    items.push({ p, v });
  }

  // Pre-cargar números existentes para clasificar creados vs actualizados.
  const existentes = new Set(
    db.prepare('SELECT numero FROM mundial_preguntas WHERE torneo_id = ?').all(torneoId).map(r => r.numero)
  );

  const upsert = db.prepare(`
    INSERT INTO mundial_preguntas
      (torneo_id, numero, enunciado, aclaracion, tipo_pregunta, config_json, orden_display, activa)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(torneo_id, numero) DO UPDATE SET
      enunciado     = excluded.enunciado,
      aclaracion    = excluded.aclaracion,
      tipo_pregunta = excluded.tipo_pregunta,
      config_json   = excluded.config_json,
      orden_display = excluded.orden_display,
      activa        = excluded.activa
  `);

  const warnings   = [];
  let creados      = 0;
  let actualizados = 0;

  try {
    db.exec('BEGIN');
    for (const { p, v } of items) {
      const configStr = typeof p.config_json === 'string' ? p.config_json : JSON.stringify(p.config_json);
      upsert.run(
        torneoId,
        p.numero,
        String(p.enunciado).trim(),
        p.aclaracion === undefined || p.aclaracion === null || p.aclaracion === '' ? null : String(p.aclaracion).trim(),
        p.tipo_pregunta,
        configStr,
        Number.isInteger(p.orden_display) ? p.orden_display : 0,
        p.activa === undefined || p.activa === null ? 1 : (p.activa ? 1 : 0),
      );
      if (existentes.has(p.numero)) actualizados++;
      else creados++;

      const missing = equiposFaltantes(db, torneoId, v.codigos_referenciados);
      if (missing.length > 0) {
        warnings.push({ pregunta_numero: p.numero, codigos_no_encontrados: missing });
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw err;
  }

  res.json({ creados, actualizados, total: items.length, warnings });
});

// ────────────────────────────────────────────────────────────────────────────
// POST /api/mundial/:torneoId/preguntas/seed-mundial-2026 — alta masiva (UPSERT)
//   - Inserta las 36 preguntas del Mundial 2026 desde data/mundial-2026-preguntas.js
//   - UPSERT por (torneo_id, numero): si no existe la crea; si existe pisa todos
//     los campos (enunciado, aclaracion, tipo, config, activa).
//   - Validación strict server-side de CADA pregunta del seed antes de tocar DB.
//     Si alguna falla → 500 con detalle (el dataset está mal — bug nuestro).
//   - Cross-check de equipos en catálogo (warnings, no errores; Fase 2.4 strict
//     aplica solo a respuestas de usuario, no a config).
//   - Solo en estado 'configuracion' (ensurePreguntasFullyEditable).
// ────────────────────────────────────────────────────────────────────────────
router.post('/:torneoId/preguntas/seed-mundial-2026', authMiddleware, adminMiddleware, requirePermiso('gestionar_mundial'), (req, res) => {
  const db = getDb();
  const torneoId = parseInt(req.params.torneoId, 10);
  const { error } = getTorneoMundial(db, torneoId);
  if (error) return res.status(error.status).json({ error: error.msg });

  const stateErr = ensurePreguntasFullyEditable(db, torneoId);
  if (stateErr) return res.status(stateErr.status).json({ error: stateErr.msg });

  // Pre-validar el dataset completo (defensa interna)
  const validaciones = [];
  for (const p of preguntasSeedMundial2026) {
    const v = validarConfigJson(p.tipo_pregunta, p.config_json);
    if (!v.ok) {
      return res.status(500).json({
        error: `Seed pregunta ${p.numero} inválida: ${v.error}`,
        campo: v.campo,
        pregunta_numero: p.numero,
      });
    }
    validaciones.push({ p, v });
  }

  // Pre-cargar números existentes para clasificar creados vs actualizados.
  const existentes = new Set(
    db.prepare('SELECT numero FROM mundial_preguntas WHERE torneo_id = ?').all(torneoId).map(r => r.numero)
  );

  const upsert = db.prepare(`
    INSERT INTO mundial_preguntas
      (torneo_id, numero, enunciado, aclaracion, tipo_pregunta, config_json, orden_display, activa)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(torneo_id, numero) DO UPDATE SET
      enunciado     = excluded.enunciado,
      aclaracion    = excluded.aclaracion,
      tipo_pregunta = excluded.tipo_pregunta,
      config_json   = excluded.config_json,
      orden_display = excluded.orden_display,
      activa        = excluded.activa
  `);

  const warnings = [];
  let creados      = 0;
  let actualizados = 0;
  try {
    db.exec('BEGIN');
    for (const { p, v } of validaciones) {
      upsert.run(
        torneoId,
        p.numero,
        String(p.enunciado).trim(),
        p.aclaracion ? String(p.aclaracion).trim() : null,
        p.tipo_pregunta,
        JSON.stringify(p.config_json),
        Number.isInteger(p.orden_display) ? p.orden_display : 0,
        1, // activa = 1
      );
      if (existentes.has(p.numero)) actualizados++;
      else                          creados++;

      const missing = equiposFaltantes(db, torneoId, v.codigos_referenciados);
      if (missing.length > 0) {
        warnings.push({ pregunta_numero: p.numero, codigos_no_encontrados: missing });
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw err;
  }

  res.json({ creados, actualizados, total: preguntasSeedMundial2026.length, warnings });
});

// ────────────────────────────────────────────────────────────────────────────
// PATCH /api/mundial/:torneoId/preguntas/:preguntaId — edición individual
//   - 'configuracion':  enunciado, aclaracion, activa, config_json, orden_display.
//   - 'abierto':        solo enunciado, aclaracion, activa.
//   - resto:            409.
//   - numero y tipo_pregunta inmutables post-creación (409 si llegan distintos).
//   - Si config_json se manda, se valida strict contra el tipo_pregunta existente.
// ────────────────────────────────────────────────────────────────────────────
router.patch('/:torneoId/preguntas/:preguntaId', authMiddleware, adminMiddleware, requirePermiso('gestionar_mundial'), (req, res) => {
  const db = getDb();
  const torneoId = parseInt(req.params.torneoId, 10);
  const preguntaId = parseInt(req.params.preguntaId, 10);
  const { error } = getTorneoMundial(db, torneoId);
  if (error) return res.status(error.status).json({ error: error.msg });

  const stateChk = ensurePreguntasPatchable(db, torneoId);
  if (stateChk.status) return res.status(stateChk.status).json({ error: stateChk.msg });
  const estado = stateChk.estado;

  const existing = db.prepare(
    'SELECT * FROM mundial_preguntas WHERE id = ? AND torneo_id = ?'
  ).get(preguntaId, torneoId);
  if (!existing) return res.status(404).json({ error: 'Pregunta no encontrada' });

  // Inmutabilidad post-creación
  if (req.body.numero !== undefined && req.body.numero !== existing.numero) {
    return res.status(409).json({ error: 'No se puede cambiar el numero de una pregunta. Borrá y creá una nueva.' });
  }
  if (req.body.tipo_pregunta !== undefined && req.body.tipo_pregunta !== existing.tipo_pregunta) {
    return res.status(409).json({ error: 'No se puede cambiar tipo_pregunta. Borrá y creá una nueva.' });
  }

  // Rechazar campos no permitidos por el estado actual
  const camposPermitidos = camposEditablesPatch(estado);
  const camposIgnorables = new Set(['numero', 'tipo_pregunta']);
  for (const campo of Object.keys(req.body)) {
    if (camposIgnorables.has(campo)) continue;
    if (!camposPermitidos.has(campo)) {
      return res.status(409).json({
        error: `Campo '${campo}' no editable en estado '${estado}'. Campos permitidos en este estado: ${[...camposPermitidos].join(', ') || '(ninguno)'}.`,
      });
    }
  }

  // Validar config_json si se manda (solo posible si estado='configuracion' por la guardia anterior)
  const warnings = [];
  let configStr = null;
  if (req.body.config_json !== undefined) {
    const v = validarConfigJson(existing.tipo_pregunta, req.body.config_json);
    if (!v.ok) return res.status(400).json({ error: v.error, campo: v.campo });
    configStr = typeof req.body.config_json === 'string' ? req.body.config_json : JSON.stringify(req.body.config_json);
    const missing = equiposFaltantes(db, torneoId, v.codigos_referenciados);
    if (missing.length > 0) warnings.push({ codigos_no_encontrados: missing });
  }

  const updates = [];
  const values  = [];

  if (req.body.enunciado !== undefined) {
    const n = String(req.body.enunciado).trim();
    if (n.length === 0) return res.status(400).json({ error: 'enunciado no puede ser vacío' });
    updates.push('enunciado = ?'); values.push(n);
  }
  if (req.body.aclaracion !== undefined) {
    const a = req.body.aclaracion === null || req.body.aclaracion === ''
      ? null
      : String(req.body.aclaracion).trim();
    updates.push('aclaracion = ?'); values.push(a);
  }
  if (req.body.activa !== undefined) {
    updates.push('activa = ?'); values.push(req.body.activa ? 1 : 0);
  }
  if (req.body.orden_display !== undefined) {
    if (!Number.isInteger(req.body.orden_display)) {
      return res.status(400).json({ error: 'orden_display debe ser entero' });
    }
    updates.push('orden_display = ?'); values.push(req.body.orden_display);
  }
  if (req.body.cambio_habilitado !== undefined) {
    // Acepta boolean, 0/1, o 'true'/'false' — normalizamos a INTEGER 0|1.
    const v = req.body.cambio_habilitado;
    const flag = (v === true || v === 1 || v === '1' || v === 'true') ? 1 : 0;
    updates.push('cambio_habilitado = ?'); values.push(flag);
  }
  if (configStr !== null) {
    updates.push('config_json = ?'); values.push(configStr);
  }

  if (updates.length === 0) {
    return res.json({ pregunta: existing, warnings });
  }

  values.push(preguntaId);
  db.prepare(`UPDATE mundial_preguntas SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  const updated = db.prepare('SELECT * FROM mundial_preguntas WHERE id = ?').get(preguntaId);
  res.json({ pregunta: updated, warnings });
});

// ────────────────────────────────────────────────────────────────────────────
// DELETE /api/mundial/:torneoId/preguntas/:preguntaId
//   - Solo en 'configuracion'.
//   - Fase 2.4 (futura): validar que no haya respuestas referenciando esta pregunta.
// ────────────────────────────────────────────────────────────────────────────
router.delete('/:torneoId/preguntas/:preguntaId', authMiddleware, adminMiddleware, requirePermiso('gestionar_mundial'), (req, res) => {
  const db = getDb();
  const torneoId = parseInt(req.params.torneoId, 10);
  const preguntaId = parseInt(req.params.preguntaId, 10);
  const { error } = getTorneoMundial(db, torneoId);
  if (error) return res.status(error.status).json({ error: error.msg });

  const stateErr = ensurePreguntasFullyEditable(db, torneoId);
  if (stateErr) return res.status(stateErr.status).json({ error: stateErr.msg });

  const ex = db.prepare(
    'SELECT id, numero FROM mundial_preguntas WHERE id = ? AND torneo_id = ?'
  ).get(preguntaId, torneoId);
  if (!ex) return res.status(404).json({ error: 'Pregunta no encontrada' });

  db.prepare('DELETE FROM mundial_preguntas WHERE id = ?').run(preguntaId);
  res.json({ ok: true, borrado: { id: ex.id, numero: ex.numero } });
});

// ────────────────────────────────────────────────────────────────────────────
// GET /api/mundial/:torneoId/mis-respuestas — respuestas del user autenticado
//   - Devuelve { pregunta_id, pregunta_numero, respuesta_json, updated_at }
//     para cada pregunta del torneo que el user respondió.
//   - Lectura abierta — cualquier user autenticado lee solo sus propias respuestas.
// ────────────────────────────────────────────────────────────────────────────
router.get('/:torneoId/mis-respuestas', authMiddleware, (req, res) => {
  const db = getDb();
  const torneoId = parseInt(req.params.torneoId, 10);
  const { error } = getTorneoMundialConAcceso(db, torneoId, req.user);
  if (error) return res.status(error.status).json({ error: error.msg });

  const respuestas = db.prepare(`
    SELECT r.pregunta_id, p.numero AS pregunta_numero, r.respuesta_json, r.updated_at
    FROM mundial_respuestas_usuario r
    JOIN mundial_preguntas p ON r.pregunta_id = p.id
    WHERE r.user_id = ? AND p.torneo_id = ?
    ORDER BY p.numero ASC
  `).all(req.user.id, torneoId);
  res.json(respuestas);
});

// ────────────────────────────────────────────────────────────────────────────
// PUT /api/mundial/:torneoId/mis-respuestas — bulk save atómico
//   Body: { respuestas: [{ pregunta_id, respuesta_json }, ...] }
//
//   Validaciones (en orden):
//   - 409 si estado del torneo no es 'abierto'.
//   - 409 si mundial_config.deadline_carga está vencido.
//   - 400 si alguna respuesta tiene shape inválido (validarRespuesta) — atómico.
//   - 400 si alguna referencia equipo no presente en mundial_equipos_catalogo
//     (strict — cross-check contra catálogo activo).
//   - 400 si pregunta_id no pertenece al torneo o está inactiva.
//
//   Devuelve { creadas, actualizadas, total }.
// ────────────────────────────────────────────────────────────────────────────
router.put('/:torneoId/mis-respuestas', authMiddleware, (req, res) => {
  const db = getDb();
  const torneoId = parseInt(req.params.torneoId, 10);
  const { error } = getTorneoMundialConAcceso(db, torneoId, req.user);
  if (error) return res.status(error.status).json({ error: error.msg });

  // Estado y deadline
  const cfg = db.prepare(
    'SELECT estado, deadline_carga FROM mundial_config WHERE torneo_id = ?'
  ).get(torneoId);
  const estado = cfg?.estado || 'configuracion';
  if (estado !== 'abierto') {
    return res.status(409).json({
      error: `Carga de respuestas no disponible en estado '${estado}'. Solo se aceptan respuestas mientras el torneo esté 'abierto'.`,
      estado,
    });
  }
  if (cfg?.deadline_carga) {
    const deadline = new Date(cfg.deadline_carga);
    if (!isNaN(deadline.getTime()) && new Date() > deadline) {
      return res.status(409).json({
        error: `Deadline de carga vencido (${cfg.deadline_carga}). No se pueden cargar más respuestas.`,
        deadline_carga: cfg.deadline_carga,
      });
    }
  }

  const { respuestas } = req.body || {};
  if (!Array.isArray(respuestas)) {
    return res.status(400).json({ error: 'Se espera body.respuestas: array' });
  }

  // Pre-cargar preguntas del torneo, indexadas por id
  const preguntasRows = db.prepare(
    'SELECT id, numero, tipo_pregunta, config_json, activa FROM mundial_preguntas WHERE torneo_id = ?'
  ).all(torneoId);
  const preguntasById = new Map(preguntasRows.map(p => [p.id, p]));

  // Catálogo: codigos activos + info de grupo y confederacion (para cross-check
  // de restricciones tipo "Mejor equipo asiático" o "Segundo Grupo D").
  const equiposCat = db.prepare(
    'SELECT codigo, grupo, confederacion FROM mundial_equipos_catalogo WHERE torneo_id = ? AND activo = 1'
  ).all(torneoId);
  const catalogoCodigos = new Set(equiposCat.map(r => r.codigo));
  const equiposByCodigo = new Map(equiposCat.map(r => [r.codigo, r]));

  // Helper: dado un equipo y una restriccion, devolver true si la cumple.
  function cumpleRestriccion(equipo, r) {
    if (!r || typeof r !== 'object') return true;
    if (r.tipo === 'grupo')          return equipo && equipo.grupo === r.grupo;
    if (r.tipo === 'confederacion')  return equipo && equipo.confederacion === r.confederacion;
    return true; // tipo desconocido → no aplicar restricción
  }

  // Pre-validar TODAS antes de tocar DB
  const items = [];
  const preguntaIdsVistos = new Set();
  for (let i = 0; i < respuestas.length; i++) {
    const r = respuestas[i];
    if (!r || typeof r !== 'object') {
      return res.status(400).json({ error: `Item ${i}: debe ser objeto` });
    }
    const preguntaId = parseInt(r.pregunta_id, 10);
    if (!Number.isInteger(preguntaId) || preguntaId <= 0) {
      return res.status(400).json({ error: `Item ${i}: pregunta_id entero positivo requerido` });
    }
    if (preguntaIdsVistos.has(preguntaId)) {
      return res.status(400).json({ error: `pregunta_id ${preguntaId} duplicado en el body` });
    }
    preguntaIdsVistos.add(preguntaId);

    const preg = preguntasById.get(preguntaId);
    if (!preg) {
      return res.status(400).json({ error: `pregunta_id ${preguntaId} no pertenece al torneo` });
    }
    if (!preg.activa) {
      return res.status(400).json({ error: `pregunta_numero ${preg.numero}: la pregunta está inactiva` });
    }
    if (r.respuesta_json === undefined || r.respuesta_json === null) {
      return res.status(400).json({ error: `pregunta_numero ${preg.numero}: respuesta_json requerida` });
    }

    // Validar shape
    const v = validarRespuesta(preg.tipo_pregunta, preg.config_json, r.respuesta_json);
    if (!v.ok) {
      return res.status(400).json({
        error: `pregunta_numero ${preg.numero}: ${v.error}`,
        pregunta_numero: preg.numero,
        campo: v.campo,
      });
    }

    // Cross-check estricto contra catálogo (Fase 2.4: error, no warning)
    if (v.codigos_referenciados.length > 0) {
      const faltantes = v.codigos_referenciados.filter(c => !catalogoCodigos.has(c));
      if (faltantes.length > 0) {
        return res.status(400).json({
          error: `pregunta_numero ${preg.numero}: códigos no encontrados en el catálogo: ${faltantes.join(', ')}`,
          pregunta_numero: preg.numero,
          codigos_no_encontrados: faltantes,
        });
      }
      // Cross-check de restriccion del config (si existe)
      let configPreg = {};
      try { configPreg = JSON.parse(preg.config_json); } catch (_) {}
      if (configPreg.restriccion) {
        const r = configPreg.restriccion;
        const invalidos = v.codigos_referenciados.filter(c => !cumpleRestriccion(equiposByCodigo.get(c), r));
        if (invalidos.length > 0) {
          let detalleR = '';
          if (r.tipo === 'grupo')         detalleR = `del Grupo ${r.grupo}`;
          else if (r.tipo === 'confederacion') detalleR = `de la confederación ${r.confederacion}`;
          return res.status(400).json({
            error: `pregunta_numero ${preg.numero}: estos códigos no cumplen la restricción (${detalleR}): ${invalidos.join(', ')}`,
            pregunta_numero: preg.numero,
            codigos_invalidos_por_restriccion: invalidos,
            restriccion: r,
          });
        }
      }
    }

    items.push({ preguntaId, respuestaNormalizada: v.respuestaNormalizada });
  }

  // Pre-cargar pregunta_ids que ya tienen respuesta del user (para clasificar
  // creadas vs actualizadas)
  const existentes = new Set(
    db.prepare(`
      SELECT r.pregunta_id
      FROM mundial_respuestas_usuario r
      JOIN mundial_preguntas p ON r.pregunta_id = p.id
      WHERE r.user_id = ? AND p.torneo_id = ?
    `).all(req.user.id, torneoId).map(r => r.pregunta_id)
  );

  const upsert = db.prepare(`
    INSERT INTO mundial_respuestas_usuario (pregunta_id, user_id, respuesta_json, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(pregunta_id, user_id) DO UPDATE SET
      respuesta_json = excluded.respuesta_json,
      updated_at     = excluded.updated_at
  `);

  let creadas = 0;
  let actualizadas = 0;
  try {
    db.exec('BEGIN');
    for (const item of items) {
      upsert.run(item.preguntaId, req.user.id, JSON.stringify(item.respuestaNormalizada));
      if (existentes.has(item.preguntaId)) actualizadas++;
      else                                  creadas++;
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw err;
  }

  res.json({ creadas, actualizadas, total: items.length });
});

// ────────────────────────────────────────────────────────────────────────────
// GET /api/mundial/:torneoId/premios
// ────────────────────────────────────────────────────────────────────────────
router.get('/:torneoId/premios', authMiddleware, (req, res) => {
  const db = getDb();
  const torneoId = parseInt(req.params.torneoId, 10);
  const { error } = getTorneoMundialConAcceso(db, torneoId, req.user);
  if (error) return res.status(error.status).json({ error: error.msg });

  const premios = db.prepare(
    'SELECT * FROM mundial_premios WHERE torneo_id = ? ORDER BY posicion ASC'
  ).all(torneoId);
  res.json(premios);
});

// ────────────────────────────────────────────────────────────────────────────
// PUT /api/mundial/:torneoId/premios/bulk
//   - Body: { premios: [{ posicion, usd, ars_manual?, comida_rol? }, ...] }
//   - Editable mientras estado != 'finalizado'
//   - Rechaza duplicados de 'posicion' en el body
//   - ars_manual nullable, sin validación cruzada con usd
//   - usd e ars_manual pueden ser negativos (premios negativos = paga al pozo)
//   - comida_rol (Fase 6.1): null | '' | 'gratis' | 'paga' | 'organiza'.
//     '' se normaliza a null. Cualquier otro valor → 400.
// ────────────────────────────────────────────────────────────────────────────
const COMIDA_ROL_VALIDOS = new Set(['gratis', 'paga', 'organiza']);

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
    // comida_rol: opcional, normalizar '' a null, validar contra whitelist.
    if (p.comida_rol !== undefined && p.comida_rol !== null && p.comida_rol !== '') {
      if (typeof p.comida_rol !== 'string' || !COMIDA_ROL_VALIDOS.has(p.comida_rol)) {
        return res.status(400).json({
          error: `Posición ${p.posicion}: comida_rol debe ser null, 'gratis', 'paga' u 'organiza'`,
        });
      }
    }
    if (posicionesVistas.has(p.posicion)) {
      return res.status(400).json({ error: `Posición ${p.posicion} duplicada en el body` });
    }
    posicionesVistas.add(p.posicion);
  }

  const upsert = db.prepare(`
    INSERT INTO mundial_premios (torneo_id, posicion, usd, ars_manual, comida_rol)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(torneo_id, posicion) DO UPDATE SET
      usd        = excluded.usd,
      ars_manual = excluded.ars_manual,
      comida_rol = excluded.comida_rol
  `);

  try {
    db.exec('BEGIN');
    for (const p of premios) {
      const ars = p.ars_manual === undefined ? null : p.ars_manual;
      // '' se normaliza a null para no romper la whitelist al releer.
      const rol = (p.comida_rol === undefined || p.comida_rol === '' || p.comida_rol === null)
        ? null
        : p.comida_rol;
      upsert.run(torneoId, p.posicion, p.usd, ars, rol);
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

// ────────────────────────────────────────────────────────────────────────────
// Fase 3 — Resultados + Ranking + Mis Puntos
//
// Visibilidad/edición acoplada al estado del torneo (forward-only state machine):
//   - estado ∈ {configuracion, abierto, cerrado}: resultados/ranking NO visibles
//     (leak prevention — los users aún están cargando o el torneo recién cerró).
//   - estado ∈ {grupos_jugados, cambios_abiertos, cambios_cerrados, resultados,
//     finalizado}: resultados/ranking visibles. Admin puede editar resultados
//     en cualquiera de estos estados.
// ────────────────────────────────────────────────────────────────────────────

const ESTADOS_RESULTADOS_VISIBLES = new Set([
  'grupos_jugados', 'cambios_abiertos', 'cambios_cerrados', 'resultados', 'finalizado',
]);

function resultadosVisiblesPara(estado) {
  return ESTADOS_RESULTADOS_VISIBLES.has(estado);
}

// ────────────────────────────────────────────────────────────────────────────
// GET /api/mundial/:torneoId/resultados
//   Lista los resultados cargados del torneo. Requiere autenticación.
//   Si estado < 'grupos_jugados' → 403 para evitar leak antes del cierre.
// ────────────────────────────────────────────────────────────────────────────
router.get('/:torneoId/resultados', authMiddleware, (req, res) => {
  const db = getDb();
  const torneoId = parseInt(req.params.torneoId, 10);
  const { error } = getTorneoMundialConAcceso(db, torneoId, req.user);
  if (error) return res.status(error.status).json({ error: error.msg });

  const cfg = db.prepare('SELECT estado FROM mundial_config WHERE torneo_id = ?').get(torneoId);
  const estado = cfg?.estado || 'configuracion';
  if (!resultadosVisiblesPara(estado)) {
    return res.status(403).json({
      error: `Resultados no disponibles en estado '${estado}'. Se publican a partir de 'grupos_jugados'.`,
      estado,
    });
  }

  const filas = db.prepare(`
    SELECT r.pregunta_id, p.numero AS pregunta_numero, p.tipo_pregunta,
           r.resultado_json, r.cargado_por, r.cargado_at
    FROM mundial_resultados r
    JOIN mundial_preguntas p ON p.id = r.pregunta_id
    WHERE p.torneo_id = ?
    ORDER BY p.numero ASC
  `).all(torneoId);
  res.json(filas);
});

// ────────────────────────────────────────────────────────────────────────────
// POST /api/mundial/:torneoId/resultados/:preguntaId
//   Upsert del resultado real de una pregunta.
//   - 409 si estado < 'grupos_jugados'
//   - 404 si pregunta no existe o no pertenece al torneo
//   - 400 si pregunta está inactiva
//   - 400 si resultado_json shape inválido
//   - 400 si referencia equipos no presentes en catálogo activo
// ────────────────────────────────────────────────────────────────────────────
router.post('/:torneoId/resultados/:preguntaId',
  authMiddleware, adminMiddleware, requirePermiso('gestionar_mundial'),
  (req, res) => {
    const db = getDb();
    const torneoId   = parseInt(req.params.torneoId, 10);
    const preguntaId = parseInt(req.params.preguntaId, 10);
    const { error } = getTorneoMundial(db, torneoId);
    if (error) return res.status(error.status).json({ error: error.msg });

    const cfg = ensureConfig(db, torneoId);
    if (!resultadosVisiblesPara(cfg.estado)) {
      return res.status(409).json({
        error: `Carga de resultados no disponible en estado '${cfg.estado}'. Se permite a partir de 'grupos_jugados'.`,
        estado: cfg.estado,
      });
    }

    const pregunta = db.prepare(
      'SELECT id, numero, tipo_pregunta, config_json, activa FROM mundial_preguntas WHERE id = ? AND torneo_id = ?'
    ).get(preguntaId, torneoId);
    if (!pregunta) return res.status(404).json({ error: 'Pregunta no encontrada en este torneo' });
    if (!pregunta.activa) return res.status(400).json({ error: 'Pregunta inactiva — no se puede cargar resultado' });

    const { resultado_json } = req.body || {};
    if (!resultado_json || typeof resultado_json !== 'object' || Array.isArray(resultado_json)) {
      return res.status(400).json({ error: 'Se espera body.resultado_json: objeto' });
    }

    let cfgJson = {};
    try { cfgJson = JSON.parse(pregunta.config_json) || {} } catch { /* deja {} */ }

    const v = validarResultado(pregunta.tipo_pregunta, cfgJson, resultado_json);
    if (!v.ok) return res.status(400).json({ error: v.error, pregunta_id: preguntaId });

    // Cross-check de equipos contra catálogo activo
    if (Array.isArray(v.codigos_referenciados) && v.codigos_referenciados.length > 0) {
      const cat = db.prepare(
        'SELECT codigo FROM mundial_equipos_catalogo WHERE torneo_id = ? AND activo = 1'
      ).all(torneoId);
      const setCat = new Set(cat.map(r => r.codigo));
      const faltantes = v.codigos_referenciados.filter(c => !setCat.has(c));
      if (faltantes.length > 0) {
        return res.status(400).json({
          error: `Códigos de equipo no presentes en catálogo activo: ${faltantes.join(', ')}`,
          codigos_invalidos: faltantes,
        });
      }
    }

    db.prepare(`
      INSERT INTO mundial_resultados (pregunta_id, resultado_json, cargado_por)
      VALUES (?, ?, ?)
      ON CONFLICT(pregunta_id) DO UPDATE SET
        resultado_json = excluded.resultado_json,
        cargado_por    = excluded.cargado_por,
        cargado_at     = datetime('now')
    `).run(preguntaId, JSON.stringify(resultado_json), req.user.id);

    const fila = db.prepare(`
      SELECT r.pregunta_id, p.numero AS pregunta_numero, p.tipo_pregunta,
             r.resultado_json, r.cargado_por, r.cargado_at
      FROM mundial_resultados r
      JOIN mundial_preguntas p ON p.id = r.pregunta_id
      WHERE r.pregunta_id = ?
    `).get(preguntaId);
    res.status(201).json(fila);
  }
);

// ────────────────────────────────────────────────────────────────────────────
// DELETE /api/mundial/:torneoId/resultados/:preguntaId
//   Borra el resultado cargado de una pregunta.
//   - 409 si estado < 'grupos_jugados'
//   - 404 si no había resultado
// ────────────────────────────────────────────────────────────────────────────
router.delete('/:torneoId/resultados/:preguntaId',
  authMiddleware, adminMiddleware, requirePermiso('gestionar_mundial'),
  (req, res) => {
    const db = getDb();
    const torneoId   = parseInt(req.params.torneoId, 10);
    const preguntaId = parseInt(req.params.preguntaId, 10);
    const { error } = getTorneoMundial(db, torneoId);
    if (error) return res.status(error.status).json({ error: error.msg });

    const cfg = ensureConfig(db, torneoId);
    if (!resultadosVisiblesPara(cfg.estado)) {
      return res.status(409).json({
        error: `Borrado de resultados no disponible en estado '${cfg.estado}'.`,
        estado: cfg.estado,
      });
    }

    // Verificar que la pregunta exista en el torneo (evita borrar de otro torneo)
    const pregunta = db.prepare(
      'SELECT id FROM mundial_preguntas WHERE id = ? AND torneo_id = ?'
    ).get(preguntaId, torneoId);
    if (!pregunta) return res.status(404).json({ error: 'Pregunta no encontrada en este torneo' });

    const r = db.prepare('DELETE FROM mundial_resultados WHERE pregunta_id = ?').run(preguntaId);
    if (r.changes === 0) return res.status(404).json({ error: 'No había resultado cargado para esta pregunta' });
    res.json({ ok: true, pregunta_id: preguntaId });
  }
);

// ────────────────────────────────────────────────────────────────────────────
// GET /api/mundial/:torneoId/ranking
//   Devuelve el ranking calculado on-the-fly.
//   Si estado < 'grupos_jugados' o no hay resultados cargados aún:
//     200 con { visible: false, motivo, ranking: [], ... }
//   El frontend puede usar `visible` para decidir si mostrar la tabla o un
//   placeholder amigable ("aún no hay resultados").
// ────────────────────────────────────────────────────────────────────────────
router.get('/:torneoId/ranking', authMiddleware, (req, res) => {
  const db = getDb();
  const torneoId = parseInt(req.params.torneoId, 10);
  const { error } = getTorneoMundialConAcceso(db, torneoId, req.user);
  if (error) return res.status(error.status).json({ error: error.msg });

  const cfg = db.prepare('SELECT estado FROM mundial_config WHERE torneo_id = ?').get(torneoId);
  const estado = cfg?.estado || 'configuracion';

  if (!resultadosVisiblesPara(estado)) {
    return res.json({
      visible: false,
      motivo: 'estado_no_apto',
      estado,
      ranking: [],
      preguntas_con_resultado: 0,
      total_preguntas: 0,
    });
  }

  const { ranking, preguntas_con_resultado, total_preguntas } = calcularRanking(db, torneoId);
  if (preguntas_con_resultado === 0) {
    return res.json({
      visible: false,
      motivo: 'sin_resultados',
      estado,
      ranking: [],
      preguntas_con_resultado: 0,
      total_preguntas,
    });
  }

  res.json({
    visible: true,
    estado,
    ranking,
    preguntas_con_resultado,
    total_preguntas,
  });
});

// ────────────────────────────────────────────────────────────────────────────
// GET /api/mundial/:torneoId/respuestas-publicas — Fase 3.3
//   Vista social: respuestas de todos los participantes una vez que la carga
//   ya está cerrada. Accesible a cualquier user autenticado del torneo.
//
//   Visibilidad:
//     - estado='abierto' Y deadline_carga NO vencido → visible:false
//                                                       motivo:'carga_abierta'
//     - estado='configuracion' (sin respuestas todavía) → visible:false (mismo
//       mensaje genérico — el frontend solo necesita "no aún", no el detalle).
//     - estado='cerrado'/'grupos_jugados'/.../'finalizado' OR
//       estado='abierto' con deadline vencido → visible:true con preguntas[].
// ────────────────────────────────────────────────────────────────────────────

const ESTADOS_RESPUESTAS_PUBLICAS_VISIBLES = new Set([
  'cerrado', 'grupos_jugados', 'cambios_abiertos', 'cambios_cerrados', 'resultados', 'finalizado',
]);

function respuestasPublicasVisibles(estado, deadlineCarga) {
  if (ESTADOS_RESPUESTAS_PUBLICAS_VISIBLES.has(estado)) return true;
  if (estado === 'abierto' && deadlineCarga) {
    const d = new Date(deadlineCarga);
    if (!isNaN(d.getTime()) && new Date() > d) return true;
  }
  return false;
}

router.get('/:torneoId/respuestas-publicas', authMiddleware, (req, res) => {
  const db = getDb();
  const torneoId = parseInt(req.params.torneoId, 10);
  const { error } = getTorneoMundialConAcceso(db, torneoId, req.user);
  if (error) return res.status(error.status).json({ error: error.msg });

  const cfg = db.prepare('SELECT estado, deadline_carga FROM mundial_config WHERE torneo_id = ?').get(torneoId);
  const estado = cfg?.estado || 'configuracion';

  if (!respuestasPublicasVisibles(estado, cfg?.deadline_carga)) {
    return res.json({
      visible: false,
      motivo: 'carga_abierta',
      mensaje: 'Las respuestas de otros participantes estarán disponibles cuando cierre la carga.',
    });
  }

  // Preguntas activas, ordenadas por número.
  const preguntas = db.prepare(`
    SELECT id, numero, enunciado, tipo_pregunta
    FROM mundial_preguntas
    WHERE torneo_id = ? AND activa = 1
    ORDER BY numero ASC
  `).all(torneoId);

  // Todas las respuestas del torneo en un solo query, joineado con users.
  const respuestasRows = db.prepare(`
    SELECT ru.pregunta_id, ru.user_id, u.nombre, ru.respuesta_json, ru.updated_at
    FROM mundial_respuestas_usuario ru
    JOIN users u             ON u.id = ru.user_id
    JOIN mundial_preguntas p ON p.id = ru.pregunta_id
    WHERE p.torneo_id = ?
    ORDER BY u.nombre COLLATE NOCASE ASC
  `).all(torneoId);

  // Agrupar por pregunta_id
  const porPregunta = new Map();
  for (const r of respuestasRows) {
    let lista = porPregunta.get(r.pregunta_id);
    if (!lista) { lista = []; porPregunta.set(r.pregunta_id, lista); }
    lista.push({
      user_id:        r.user_id,
      nombre:         r.nombre,
      respuesta_json: r.respuesta_json,
      updated_at:     r.updated_at,
    });
  }

  const items = preguntas.map(p => ({
    id:            p.id,
    numero:        p.numero,
    enunciado:     p.enunciado,
    tipo_pregunta: p.tipo_pregunta,
    respuestas:    porPregunta.get(p.id) || [],
  }));

  res.json({ visible: true, preguntas: items });
});

// ────────────────────────────────────────────────────────────────────────────
// GET /api/mundial/:torneoId/preguntas/:preguntaId/respuestas
//   Lista respuestas de TODOS los usuarios para una pregunta. Admin-only.
//   Pensado para el editor de overrides_pts de tipos texto (respuesta_manual /
//   regla_especial), donde el admin necesita ver qué escribió cada usuario
//   ('MESSI', 'L. MESSI', 'Lionel Messi', etc) y asignar pts a mano.
//
//   - 403 si estado < 'grupos_jugados' (mismo gate que /resultados; evita leak
//     de respuestas de otros usuarios mientras el torneo está abierto).
//   - 404 si pregunta no existe o no pertenece al torneo.
//   - Devuelve [] si nadie respondió esa pregunta todavía.
// ────────────────────────────────────────────────────────────────────────────
router.get('/:torneoId/preguntas/:preguntaId/respuestas',
  authMiddleware, adminMiddleware, requirePermiso('gestionar_mundial'),
  (req, res) => {
    const db = getDb();
    const torneoId   = parseInt(req.params.torneoId, 10);
    const preguntaId = parseInt(req.params.preguntaId, 10);
    const { error } = getTorneoMundial(db, torneoId);
    if (error) return res.status(error.status).json({ error: error.msg });

    const cfg = db.prepare('SELECT estado FROM mundial_config WHERE torneo_id = ?').get(torneoId);
    const estado = cfg?.estado || 'configuracion';
    if (!resultadosVisiblesPara(estado)) {
      return res.status(403).json({
        error: `Respuestas de otros usuarios no disponibles en estado '${estado}'. Se exponen a partir de 'grupos_jugados'.`,
        estado,
      });
    }

    const pregunta = db.prepare(
      'SELECT id FROM mundial_preguntas WHERE id = ? AND torneo_id = ?'
    ).get(preguntaId, torneoId);
    if (!pregunta) return res.status(404).json({ error: 'Pregunta no encontrada en este torneo' });

    const rows = db.prepare(`
      SELECT ru.user_id, u.nombre, ru.respuesta_json, ru.updated_at
      FROM mundial_respuestas_usuario ru
      JOIN users u ON u.id = ru.user_id
      WHERE ru.pregunta_id = ?
      ORDER BY u.nombre COLLATE NOCASE ASC
    `).all(preguntaId);

    res.json(rows);
  }
);

// ────────────────────────────────────────────────────────────────────────────
// GET /api/mundial/:torneoId/mis-puntos
//   Detalle por pregunta del usuario actual: respuesta, resultado (si está),
//   y pts obtenidos (null si no hay resultado cargado aún).
//   Si estado < 'grupos_jugados' → 200 con visible:false, items:[] (igual que ranking).
// ────────────────────────────────────────────────────────────────────────────
router.get('/:torneoId/mis-puntos', authMiddleware, (req, res) => {
  const db = getDb();
  const torneoId = parseInt(req.params.torneoId, 10);
  const { error } = getTorneoMundialConAcceso(db, torneoId, req.user);
  if (error) return res.status(error.status).json({ error: error.msg });

  const cfg = db.prepare('SELECT estado FROM mundial_config WHERE torneo_id = ?').get(torneoId);
  const estado = cfg?.estado || 'configuracion';

  if (!resultadosVisiblesPara(estado)) {
    return res.json({
      visible: false,
      motivo: 'estado_no_apto',
      estado,
      items: [],
      pts_totales: 0,
    });
  }

  const items = calcularMisPuntos(db, torneoId, req.user.id);
  const pts_totales = items.reduce((acc, it) => acc + (Number.isInteger(it.pts_obtenidos) ? it.pts_obtenidos : 0), 0);
  res.json({
    visible: true,
    estado,
    items,
    pts_totales,
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Fase 5 — Cambios post-grupos
//
// Modelo:
//   - mundial_ventanas_cambios:   ventanas por torneo (1 abierta a la vez).
//   - mundial_ventana_habilitados: lista explícita de users autorizados.
//   - mundial_cambios_respuesta:  cambios cargados. publicado=0 hasta publicar.
//   - mundial_preguntas.cambio_habilitado: flag elegibilidad por pregunta.
//
// Flujo:
//   1. Admin crea ventana (estado 'cerrada' por default).
//   2. Admin habilita users con POST /habilitados.
//   3. Admin abre ventana (PATCH estado='abierta').
//   4. Users habilitados cargan cambios (PUT /mis-cambios) sobre preguntas
//      con cambio_habilitado=1, sin exceder cambios_por_usuario de la ventana.
//      Los cambios viven en mundial_cambios_respuesta con publicado=0 —
//      invisibles al scoring/ranking público.
//   5. Admin cierra ventana (PATCH estado='cerrada') opcional.
//   6. Admin publica (POST /publicar): acción atómica que
//      - pisa mundial_respuestas_usuario con la respuesta_nueva,
//      - marca mundial_cambios_respuesta.publicado=1,
//      - cierra la ventana a estado 'publicada'.
//     A partir de acá, scoring/ranking refleja los cambios automáticamente
//     (lee mundial_respuestas_usuario, que ya está pisada).
//
// Permisos:
//   - Endpoints admin: authMiddleware + adminMiddleware + requirePermiso('gestionar_mundial').
//   - Endpoints user: authMiddleware + usuarioPuedeAccederTorneo (vía getTorneoMundialConAcceso).
//
// Estados máquina de ventana (CHECK en schema):
//   cerrada → abierta → cerrada (volver atrás OK)
//   abierta → publicada (irreversible)
// ════════════════════════════════════════════════════════════════════════════

const VENTANA_ESTADOS = ['cerrada', 'abierta', 'publicada'];

function getVentanaCambios(db, torneoId, ventanaId) {
  if (!Number.isFinite(ventanaId) || ventanaId <= 0) {
    return { error: { status: 400, msg: 'ventana_id inválido' } };
  }
  const v = db.prepare(
    'SELECT * FROM mundial_ventanas_cambios WHERE id = ? AND torneo_id = ?'
  ).get(ventanaId, torneoId);
  if (!v) return { error: { status: 404, msg: 'Ventana de cambios no encontrada en este torneo' } };
  return { ventana: v };
}

/** Devuelve la ventana actualmente en estado 'abierta' del torneo, o null. */
function getVentanaAbierta(db, torneoId) {
  return db.prepare(
    "SELECT * FROM mundial_ventanas_cambios WHERE torneo_id = ? AND estado = 'abierta'"
  ).get(torneoId) || null;
}

// ────────────────────────────────────────────────────────────────────────────
// GET /api/mundial/:torneoId/ventanas-cambios — admin
// ────────────────────────────────────────────────────────────────────────────
router.get('/:torneoId/ventanas-cambios',
  authMiddleware, adminMiddleware, requirePermiso('gestionar_mundial'),
  (req, res) => {
    const db = getDb();
    const torneoId = parseInt(req.params.torneoId, 10);
    const { error } = getTorneoMundial(db, torneoId);
    if (error) return res.status(error.status).json({ error: error.msg });

    const ventanas = db.prepare(`
      SELECT v.*,
        (SELECT COUNT(*) FROM mundial_ventana_habilitados h WHERE h.ventana_id = v.id) AS habilitados_count,
        (SELECT COUNT(DISTINCT user_id) FROM mundial_cambios_respuesta c WHERE c.ventana_id = v.id) AS users_con_cambios,
        (SELECT COUNT(*) FROM mundial_cambios_respuesta c WHERE c.ventana_id = v.id) AS total_cambios
      FROM mundial_ventanas_cambios v
      WHERE v.torneo_id = ?
      ORDER BY v.id DESC
    `).all(torneoId);
    res.json(ventanas);
  }
);

// ────────────────────────────────────────────────────────────────────────────
// POST /api/mundial/:torneoId/ventanas-cambios — admin: crear ventana
//   Body: { nombre?, costo_usd?, cambios_por_usuario? }
//   Defaults: nombre='Cambios post-grupos', costo_usd y cambios_por_usuario
//             del config global.
//   Crea con estado 'cerrada'. Admin la abre después con PATCH.
// ────────────────────────────────────────────────────────────────────────────
router.post('/:torneoId/ventanas-cambios',
  authMiddleware, adminMiddleware, requirePermiso('gestionar_mundial'),
  (req, res) => {
    const db = getDb();
    const torneoId = parseInt(req.params.torneoId, 10);
    const { error } = getTorneoMundial(db, torneoId);
    if (error) return res.status(error.status).json({ error: error.msg });

    const cfg = ensureConfig(db, torneoId);
    const nombre = typeof req.body.nombre === 'string' && req.body.nombre.trim()
      ? req.body.nombre.trim() : 'Cambios post-grupos';
    const costoUsd = req.body.costo_usd !== undefined
      ? parseInt(req.body.costo_usd, 10) : cfg.costo_cambio_usd;
    const cambiosPorUser = req.body.cambios_por_usuario !== undefined
      ? parseInt(req.body.cambios_por_usuario, 10) : cfg.cambios_por_usuario;
    if (!Number.isInteger(costoUsd) || costoUsd < 0) {
      return res.status(400).json({ error: 'costo_usd entero >= 0' });
    }
    if (!Number.isInteger(cambiosPorUser) || cambiosPorUser < 0) {
      return res.status(400).json({ error: 'cambios_por_usuario entero >= 0' });
    }

    const r = db.prepare(`
      INSERT INTO mundial_ventanas_cambios (torneo_id, nombre, costo_usd, cambios_por_usuario, estado)
      VALUES (?, ?, ?, ?, 'cerrada')
    `).run(torneoId, nombre, costoUsd, cambiosPorUser);

    const ventana = db.prepare('SELECT * FROM mundial_ventanas_cambios WHERE id = ?').get(r.lastInsertRowid);
    res.status(201).json(ventana);
  }
);

// ────────────────────────────────────────────────────────────────────────────
// PATCH /api/mundial/:torneoId/ventanas-cambios/:ventanaId — admin
//   Body: { estado?, nombre?, costo_usd?, cambios_por_usuario? }
//   - estado: 'cerrada' ↔ 'abierta' (cambiar libremente). NO permite ir a
//     'publicada' por acá — usar POST /publicar.
//   - MVP: solo 1 ventana 'abierta' por torneo. Rechaza si abrir colisiona.
//   - costo_usd / cambios_por_usuario / nombre editables solo si estado='cerrada'.
// ────────────────────────────────────────────────────────────────────────────
router.patch('/:torneoId/ventanas-cambios/:ventanaId',
  authMiddleware, adminMiddleware, requirePermiso('gestionar_mundial'),
  (req, res) => {
    const db = getDb();
    const torneoId  = parseInt(req.params.torneoId, 10);
    const ventanaId = parseInt(req.params.ventanaId, 10);
    const { error } = getTorneoMundial(db, torneoId);
    if (error) return res.status(error.status).json({ error: error.msg });
    const r = getVentanaCambios(db, torneoId, ventanaId);
    if (r.error) return res.status(r.error.status).json({ error: r.error.msg });
    const v = r.ventana;

    if (v.estado === 'publicada') {
      return res.status(409).json({ error: 'Ventana ya publicada — irreversible' });
    }

    const updates = [];
    const values  = [];

    if (req.body.estado !== undefined) {
      const nuevo = req.body.estado;
      if (nuevo === 'publicada') {
        return res.status(400).json({ error: 'Para publicar usá POST /publicar' });
      }
      if (!VENTANA_ESTADOS.includes(nuevo)) {
        return res.status(400).json({ error: `Estado desconocido: ${nuevo}` });
      }
      if (nuevo !== v.estado) {
        if (nuevo === 'abierta') {
          // MVP: una ventana abierta a la vez por torneo.
          const otra = getVentanaAbierta(db, torneoId);
          if (otra && otra.id !== ventanaId) {
            return res.status(409).json({
              error: `Ya hay una ventana abierta (id=${otra.id}). Cerrala primero.`,
              ventana_abierta_id: otra.id,
            });
          }
          updates.push("estado = 'abierta'");
          updates.push('abierta_at = datetime(\'now\')');
          updates.push('abierta_por = ?');
          values.push(req.user.id);
        } else if (nuevo === 'cerrada') {
          updates.push("estado = 'cerrada'");
          updates.push('cerrada_at = datetime(\'now\')');
        }
      }
    }

    // Campos editables solo si la ventana está cerrada (no abierta ni publicada).
    if (v.estado === 'cerrada') {
      if (req.body.nombre !== undefined) {
        const n = String(req.body.nombre).trim();
        if (n.length === 0) return res.status(400).json({ error: 'nombre no puede ser vacío' });
        updates.push('nombre = ?'); values.push(n);
      }
      if (req.body.costo_usd !== undefined) {
        const c = parseInt(req.body.costo_usd, 10);
        if (!Number.isInteger(c) || c < 0) return res.status(400).json({ error: 'costo_usd entero >= 0' });
        updates.push('costo_usd = ?'); values.push(c);
      }
      if (req.body.cambios_por_usuario !== undefined) {
        const c = parseInt(req.body.cambios_por_usuario, 10);
        if (!Number.isInteger(c) || c < 0) return res.status(400).json({ error: 'cambios_por_usuario entero >= 0' });
        updates.push('cambios_por_usuario = ?'); values.push(c);
      }
    } else {
      // Rechazar edición de campos no-estado si la ventana no está cerrada.
      for (const f of ['nombre', 'costo_usd', 'cambios_por_usuario']) {
        if (req.body[f] !== undefined) {
          return res.status(409).json({ error: `'${f}' solo editable con ventana en 'cerrada'` });
        }
      }
    }

    if (updates.length === 0) {
      return res.json(v);
    }

    values.push(ventanaId);
    db.prepare(`UPDATE mundial_ventanas_cambios SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    const updated = db.prepare('SELECT * FROM mundial_ventanas_cambios WHERE id = ?').get(ventanaId);
    res.json(updated);
  }
);

// ────────────────────────────────────────────────────────────────────────────
// POST /api/mundial/:torneoId/ventanas-cambios/:ventanaId/publicar — admin
//   Acción atómica:
//     1. Verifica ventana en estado 'abierta' o 'cerrada' (no 'publicada').
//     2. Para cada cambio publicable de la ventana (habilitado vigente):
//        UPSERT mundial_respuestas_usuario con respuesta_nueva_json.
//        Marca el cambio con publicado=1.
//     3. Marca la ventana con estado='publicada' + publicada_at + publicada_por.
//   Los cambios de users que fueron deshabilitados (no están en
//   mundial_ventana_habilitados al momento de publicar) NO se aplican y
//   quedan registrados con publicado=0 (auditoría).
// ────────────────────────────────────────────────────────────────────────────
router.post('/:torneoId/ventanas-cambios/:ventanaId/publicar',
  authMiddleware, adminMiddleware, requirePermiso('gestionar_mundial'),
  (req, res) => {
    const db = getDb();
    const torneoId  = parseInt(req.params.torneoId, 10);
    const ventanaId = parseInt(req.params.ventanaId, 10);
    const { error } = getTorneoMundial(db, torneoId);
    if (error) return res.status(error.status).json({ error: error.msg });
    const r = getVentanaCambios(db, torneoId, ventanaId);
    if (r.error) return res.status(r.error.status).json({ error: r.error.msg });
    const v = r.ventana;

    if (v.estado === 'publicada') {
      return res.status(409).json({ error: 'Ventana ya publicada' });
    }

    // Cambios publicables = de users que SIGUEN habilitados.
    const cambiosPublicables = db.prepare(`
      SELECT c.id, c.user_id, c.pregunta_id, c.respuesta_nueva_json
      FROM mundial_cambios_respuesta c
      JOIN mundial_ventana_habilitados h
        ON h.ventana_id = c.ventana_id AND h.user_id = c.user_id
      WHERE c.ventana_id = ?
    `).all(ventanaId);

    let upserts = 0;
    try {
      db.exec('BEGIN');
      const upsertResp = db.prepare(`
        INSERT INTO mundial_respuestas_usuario (pregunta_id, user_id, respuesta_json, updated_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(pregunta_id, user_id) DO UPDATE SET
          respuesta_json = excluded.respuesta_json,
          updated_at     = datetime('now')
      `);
      const marcarPublicado = db.prepare(
        'UPDATE mundial_cambios_respuesta SET publicado = 1 WHERE id = ?'
      );
      for (const c of cambiosPublicables) {
        upsertResp.run(c.pregunta_id, c.user_id, c.respuesta_nueva_json);
        marcarPublicado.run(c.id);
        upserts++;
      }
      db.prepare(`
        UPDATE mundial_ventanas_cambios
        SET estado = 'publicada',
            publicada_at = datetime('now'),
            publicada_por = ?
        WHERE id = ?
      `).run(req.user.id, ventanaId);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      return res.status(500).json({ error: `Publicación falló: ${e.message}` });
    }

    const ventana = db.prepare('SELECT * FROM mundial_ventanas_cambios WHERE id = ?').get(ventanaId);
    // no_publicados = cambios de esta ventana que quedaron con publicado=0,
    // independientemente de cuántos pasaron por el upsert. Cubre el caso de
    // users que cargaron cambio y después fueron deshabilitados: esos cambios
    // existen en DB con publicado=0 pero no se aplicaron. Auditoría limpia.
    const noPublicados = db.prepare(
      'SELECT COUNT(*) AS n FROM mundial_cambios_respuesta WHERE ventana_id = ? AND publicado = 0'
    ).get(ventanaId).n;
    res.json({
      ventana,
      publicados: upserts,
      no_publicados: noPublicados,
    });
  }
);

// ────────────────────────────────────────────────────────────────────────────
// Habilitados — listado + alta + baja (admin)
// ────────────────────────────────────────────────────────────────────────────
router.get('/:torneoId/ventanas-cambios/:ventanaId/habilitados',
  authMiddleware, adminMiddleware, requirePermiso('gestionar_mundial'),
  (req, res) => {
    const db = getDb();
    const torneoId  = parseInt(req.params.torneoId, 10);
    const ventanaId = parseInt(req.params.ventanaId, 10);
    const { error } = getTorneoMundial(db, torneoId);
    if (error) return res.status(error.status).json({ error: error.msg });
    const r = getVentanaCambios(db, torneoId, ventanaId);
    if (r.error) return res.status(r.error.status).json({ error: r.error.msg });

    const rows = db.prepare(`
      SELECT h.user_id, u.nombre, u.email, h.habilitado_at, h.habilitado_por,
        (SELECT COUNT(*) FROM mundial_cambios_respuesta c
         WHERE c.ventana_id = h.ventana_id AND c.user_id = h.user_id) AS cambios_cargados
      FROM mundial_ventana_habilitados h
      JOIN users u ON u.id = h.user_id
      WHERE h.ventana_id = ?
      ORDER BY u.nombre COLLATE NOCASE
    `).all(ventanaId);
    res.json(rows);
  }
);

router.post('/:torneoId/ventanas-cambios/:ventanaId/habilitados',
  authMiddleware, adminMiddleware, requirePermiso('gestionar_mundial'),
  (req, res) => {
    const db = getDb();
    const torneoId  = parseInt(req.params.torneoId, 10);
    const ventanaId = parseInt(req.params.ventanaId, 10);
    const { error } = getTorneoMundial(db, torneoId);
    if (error) return res.status(error.status).json({ error: error.msg });
    const r = getVentanaCambios(db, torneoId, ventanaId);
    if (r.error) return res.status(r.error.status).json({ error: r.error.msg });
    if (r.ventana.estado === 'publicada') {
      return res.status(409).json({ error: 'No se pueden agregar habilitados a una ventana publicada' });
    }

    const userId = parseInt(req.body.user_id, 10);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: 'user_id entero > 0 requerido' });
    }
    // Verificar user existe.
    const u = db.prepare('SELECT id, nombre FROM users WHERE id = ?').get(userId);
    if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
    // Recomendado: que el user sea participante del torneo (torneo_jugadores).
    // No bloqueamos en MVP — admin puede habilitar libremente, queda como warning.

    try {
      db.prepare(`
        INSERT INTO mundial_ventana_habilitados (ventana_id, user_id, habilitado_por)
        VALUES (?, ?, ?)
      `).run(ventanaId, userId, req.user.id);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        return res.status(409).json({ error: 'Usuario ya habilitado en esta ventana' });
      }
      throw e;
    }

    res.status(201).json({ ok: true, ventana_id: ventanaId, user_id: userId, nombre: u.nombre });
  }
);

router.delete('/:torneoId/ventanas-cambios/:ventanaId/habilitados/:userId',
  authMiddleware, adminMiddleware, requirePermiso('gestionar_mundial'),
  (req, res) => {
    const db = getDb();
    const torneoId  = parseInt(req.params.torneoId, 10);
    const ventanaId = parseInt(req.params.ventanaId, 10);
    const userId    = parseInt(req.params.userId, 10);
    const { error } = getTorneoMundial(db, torneoId);
    if (error) return res.status(error.status).json({ error: error.msg });
    const r = getVentanaCambios(db, torneoId, ventanaId);
    if (r.error) return res.status(r.error.status).json({ error: r.error.msg });
    if (r.ventana.estado === 'publicada') {
      return res.status(409).json({ error: 'No se puede modificar habilitados de una ventana publicada' });
    }

    // Cambios cargados por este user en la ventana (info para el admin).
    const cambios = db.prepare(
      'SELECT COUNT(*) AS n FROM mundial_cambios_respuesta WHERE ventana_id = ? AND user_id = ?'
    ).get(ventanaId, userId).n;

    const del = db.prepare(
      'DELETE FROM mundial_ventana_habilitados WHERE ventana_id = ? AND user_id = ?'
    ).run(ventanaId, userId);
    if (del.changes === 0) return res.status(404).json({ error: 'Usuario no estaba habilitado' });

    res.json({
      ok: true,
      ventana_id: ventanaId,
      user_id: userId,
      cambios_cargados_no_publicables: cambios,
    });
  }
);

// ────────────────────────────────────────────────────────────────────────────
// GET /api/mundial/:torneoId/ventanas-cambios/:ventanaId/cambios — admin
//   Historial de cambios cargados en la ventana (audit).
// ────────────────────────────────────────────────────────────────────────────
router.get('/:torneoId/ventanas-cambios/:ventanaId/cambios',
  authMiddleware, adminMiddleware, requirePermiso('gestionar_mundial'),
  (req, res) => {
    const db = getDb();
    const torneoId  = parseInt(req.params.torneoId, 10);
    const ventanaId = parseInt(req.params.ventanaId, 10);
    const { error } = getTorneoMundial(db, torneoId);
    if (error) return res.status(error.status).json({ error: error.msg });
    const r = getVentanaCambios(db, torneoId, ventanaId);
    if (r.error) return res.status(r.error.status).json({ error: r.error.msg });

    const rows = db.prepare(`
      SELECT c.id, c.user_id, u.nombre AS user_nombre,
             c.pregunta_id, p.numero AS pregunta_numero, p.enunciado AS pregunta_enunciado,
             c.respuesta_anterior_json, c.respuesta_nueva_json,
             c.costo_usd, c.publicado, c.created_at
      FROM mundial_cambios_respuesta c
      JOIN users u             ON u.id = c.user_id
      JOIN mundial_preguntas p ON p.id = c.pregunta_id
      WHERE c.ventana_id = ?
      ORDER BY u.nombre COLLATE NOCASE, p.numero
    `).all(ventanaId);
    res.json(rows);
  }
);

// ────────────────────────────────────────────────────────────────────────────
// GET /api/mundial/:torneoId/mis-cambios-disponibles — user
//   Devuelve:
//     { ventana, habilitado, cambios_usados, cambios_restantes, preguntas_habilitables }
//   Si no hay ventana abierta o el user no está habilitado, ventana=null y
//   habilitado=false. preguntas_habilitables siempre lista (puede estar vacía).
// ────────────────────────────────────────────────────────────────────────────
router.get('/:torneoId/mis-cambios-disponibles', authMiddleware, (req, res) => {
  const db = getDb();
  const torneoId = parseInt(req.params.torneoId, 10);
  const { error } = getTorneoMundialConAcceso(db, torneoId, req.user);
  if (error) return res.status(error.status).json({ error: error.msg });

  const ventana = getVentanaAbierta(db, torneoId);
  const preguntas = db.prepare(`
    SELECT id, numero, enunciado, aclaracion, tipo_pregunta, config_json
    FROM mundial_preguntas
    WHERE torneo_id = ? AND activa = 1 AND cambio_habilitado = 1
    ORDER BY numero
  `).all(torneoId);

  if (!ventana) {
    return res.json({
      ventana: null,
      habilitado: false,
      cambios_usados: 0,
      cambios_restantes: 0,
      costo_usd: 0,
      preguntas_habilitables: preguntas,
    });
  }

  const habilitado = !!db.prepare(
    'SELECT 1 FROM mundial_ventana_habilitados WHERE ventana_id = ? AND user_id = ?'
  ).get(ventana.id, req.user.id);

  const cambiosUsados = db.prepare(
    'SELECT COUNT(*) AS n FROM mundial_cambios_respuesta WHERE ventana_id = ? AND user_id = ?'
  ).get(ventana.id, req.user.id).n;

  res.json({
    ventana,
    habilitado,
    cambios_usados:   cambiosUsados,
    cambios_restantes: Math.max(0, ventana.cambios_por_usuario - cambiosUsados),
    costo_usd:        ventana.costo_usd,
    preguntas_habilitables: preguntas,
  });
});

// ────────────────────────────────────────────────────────────────────────────
// GET /api/mundial/:torneoId/mis-cambios — user
//   Cambios cargados por el user en la ventana abierta actual.
// ────────────────────────────────────────────────────────────────────────────
router.get('/:torneoId/mis-cambios', authMiddleware, (req, res) => {
  const db = getDb();
  const torneoId = parseInt(req.params.torneoId, 10);
  const { error } = getTorneoMundialConAcceso(db, torneoId, req.user);
  if (error) return res.status(error.status).json({ error: error.msg });

  const ventana = getVentanaAbierta(db, torneoId);
  if (!ventana) return res.json({ ventana: null, cambios: [] });

  const rows = db.prepare(`
    SELECT c.pregunta_id, p.numero AS pregunta_numero,
           c.respuesta_anterior_json, c.respuesta_nueva_json,
           c.costo_usd, c.created_at
    FROM mundial_cambios_respuesta c
    JOIN mundial_preguntas p ON p.id = c.pregunta_id
    WHERE c.ventana_id = ? AND c.user_id = ?
    ORDER BY p.numero
  `).all(ventana.id, req.user.id);
  res.json({ ventana, cambios: rows });
});

// ────────────────────────────────────────────────────────────────────────────
// PUT /api/mundial/:torneoId/mis-cambios — user: bulk UPSERT cambios
//   Body: { cambios: [{ pregunta_id, respuesta_json }] }
//
//   Validaciones (en orden):
//   - 409 si torneo no está en 'cambios_abiertos'.
//   - 409 si no hay ventana abierta.
//   - 403 si user no está en mundial_ventana_habilitados.
//   - 400 si shape inválido por pregunta (validarItemCambio).
//   - 400 si excede cambios_por_usuario teniendo en cuenta los items.
//   - 400 si refs equipo no presentes en catálogo activo.
//
//   Acción: UPSERT por (ventana_id, user_id, pregunta_id) en
//   mundial_cambios_respuesta. respuesta_anterior_json se toma de
//   mundial_respuestas_usuario al momento (si no hay, se usa '{}' como anterior).
//   costo_usd se toma de la ventana (no por item).
// ────────────────────────────────────────────────────────────────────────────
router.put('/:torneoId/mis-cambios', authMiddleware, (req, res) => {
  const db = getDb();
  const torneoId = parseInt(req.params.torneoId, 10);
  const { error } = getTorneoMundialConAcceso(db, torneoId, req.user);
  if (error) return res.status(error.status).json({ error: error.msg });

  // Estado del torneo debe ser 'cambios_abiertos' para aceptar cargas.
  const cfg = db.prepare('SELECT estado FROM mundial_config WHERE torneo_id = ?').get(torneoId);
  const estado = cfg?.estado || 'configuracion';
  if (estado !== 'cambios_abiertos') {
    return res.status(409).json({
      error: `Carga de cambios no disponible en estado '${estado}'. Requiere 'cambios_abiertos'.`,
      estado,
    });
  }

  const ventana = getVentanaAbierta(db, torneoId);
  if (!ventana) {
    return res.status(409).json({ error: 'No hay ventana de cambios abierta' });
  }

  const habilitado = db.prepare(
    'SELECT 1 FROM mundial_ventana_habilitados WHERE ventana_id = ? AND user_id = ? LIMIT 1'
  ).get(ventana.id, req.user.id);
  if (!habilitado) {
    return res.status(403).json({ error: 'No estás habilitado para esta ventana de cambios' });
  }

  const { cambios } = req.body || {};
  if (!Array.isArray(cambios)) {
    return res.status(400).json({ error: 'Se espera body.cambios: array' });
  }

  // Preguntas indexadas por id (con cambio_habilitado).
  const preguntasRows = db.prepare(
    'SELECT id, numero, tipo_pregunta, config_json, activa, cambio_habilitado FROM mundial_preguntas WHERE torneo_id = ?'
  ).all(torneoId);
  const preguntasById = new Map(preguntasRows.map(p => [p.id, p]));

  // Catálogo activo + helper de restricción (reuso del patrón existente).
  const equiposCat = db.prepare(
    'SELECT codigo, grupo, confederacion FROM mundial_equipos_catalogo WHERE torneo_id = ? AND activo = 1'
  ).all(torneoId);
  const catalogoCodigos = new Set(equiposCat.map(r => r.codigo));
  const equiposByCodigo = new Map(equiposCat.map(r => [r.codigo, r]));
  function cumpleRestriccion(equipo, r) {
    if (!r || typeof r !== 'object') return true;
    if (r.tipo === 'grupo')         return equipo && equipo.grupo === r.grupo;
    if (r.tipo === 'confederacion') return equipo && equipo.confederacion === r.confederacion;
    return true;
  }

  // Pre-validar todos los items antes de tocar DB.
  const items = [];
  const preguntaIdsVistos = new Set();
  for (let i = 0; i < cambios.length; i++) {
    const item = cambios[i];
    const pregunta = preguntasById.get(item?.pregunta_id);
    const v = validarItemCambio(item, pregunta);
    if (!v.ok) {
      return res.status(400).json({ error: v.error, campo: v.campo, indice: i, pregunta_id: item?.pregunta_id });
    }
    if (preguntaIdsVistos.has(item.pregunta_id)) {
      return res.status(400).json({ error: `pregunta_id ${item.pregunta_id} duplicado en el body`, indice: i });
    }
    preguntaIdsVistos.add(item.pregunta_id);

    // Cross-check equipos contra catálogo + restriccion del config.
    let cfgPregunta = {};
    try { cfgPregunta = JSON.parse(pregunta.config_json) || {}; } catch { /* deja {} */ }
    const codigos = v.codigos_referenciados || [];
    const faltantes = codigos.filter(c => !catalogoCodigos.has(c));
    if (faltantes.length > 0) {
      return res.status(400).json({
        error: `Códigos no en catálogo activo: ${faltantes.join(', ')}`,
        indice: i, pregunta_id: item.pregunta_id, codigos_invalidos: faltantes,
      });
    }
    if (cfgPregunta.restriccion && codigos.length > 0) {
      const noCumplen = codigos.filter(c => !cumpleRestriccion(equiposByCodigo.get(c), cfgPregunta.restriccion));
      if (noCumplen.length > 0) {
        return res.status(400).json({
          error: `Códigos no cumplen restricción ${JSON.stringify(cfgPregunta.restriccion)}: ${noCumplen.join(', ')}`,
          indice: i, pregunta_id: item.pregunta_id, codigos_invalidos_por_restriccion: noCumplen,
        });
      }
    }

    items.push({ pregunta_id: item.pregunta_id, respuesta_json: JSON.stringify(item.respuesta_json) });
  }

  // Calcular cupo: cambios actuales del user (sobre OTRAS preguntas) + nuevos
  // que se van a guardar (las preguntas del body — UPSERT, no acumulan).
  const cambiosExistentesEnOtras = db.prepare(`
    SELECT COUNT(*) AS n FROM mundial_cambios_respuesta
    WHERE ventana_id = ? AND user_id = ? AND pregunta_id NOT IN (${items.map(() => '?').join(',') || '0'})
  `).get(ventana.id, req.user.id, ...items.map(it => it.pregunta_id)).n;
  const cambiosResultantes = cambiosExistentesEnOtras + items.length;
  if (cambiosResultantes > ventana.cambios_por_usuario) {
    return res.status(400).json({
      error: `Excederías el cupo de cambios (${cambiosResultantes} > ${ventana.cambios_por_usuario})`,
      cupo: ventana.cambios_por_usuario,
      resultantes: cambiosResultantes,
    });
  }

  // UPSERT atómico
  let creados = 0, actualizados = 0;
  try {
    db.exec('BEGIN');
    const getAnterior = db.prepare(
      'SELECT respuesta_json FROM mundial_respuestas_usuario WHERE pregunta_id = ? AND user_id = ?'
    );
    const upsert = db.prepare(`
      INSERT INTO mundial_cambios_respuesta
        (ventana_id, torneo_id, user_id, pregunta_id, respuesta_anterior_json, respuesta_nueva_json, costo_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ventana_id, user_id, pregunta_id) DO UPDATE SET
        respuesta_nueva_json = excluded.respuesta_nueva_json,
        costo_usd            = excluded.costo_usd
    `);
    for (const it of items) {
      const prev = getAnterior.get(it.pregunta_id, req.user.id);
      const anteriorJson = prev ? prev.respuesta_json : '{}';
      const existia = db.prepare(
        'SELECT 1 FROM mundial_cambios_respuesta WHERE ventana_id = ? AND user_id = ? AND pregunta_id = ? LIMIT 1'
      ).get(ventana.id, req.user.id, it.pregunta_id);
      upsert.run(ventana.id, torneoId, req.user.id, it.pregunta_id, anteriorJson, it.respuesta_json, ventana.costo_usd);
      if (existia) actualizados++; else creados++;
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    return res.status(500).json({ error: `UPSERT cambios falló: ${e.message}` });
  }

  const cambiosUsados = db.prepare(
    'SELECT COUNT(*) AS n FROM mundial_cambios_respuesta WHERE ventana_id = ? AND user_id = ?'
  ).get(ventana.id, req.user.id).n;

  res.json({
    creados, actualizados,
    total: items.length,
    cambios_usados: cambiosUsados,
    cambios_restantes: Math.max(0, ventana.cambios_por_usuario - cambiosUsados),
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Fase Premios — modelo fijo por posición
//
// Modelo (decisión MVP — NO porcentual):
//   - Tabla `mundial_premios` ya existe: (torneo_id, posicion, usd, ars_manual).
//   - `usd` acepta negativos (premios castigo).
//   - Endpoints legacy `GET /premios` y `PUT /premios/bulk` cubren el CRUD.
//   - Acá solo agregamos `GET /premios-calculados` para cruzar con el ranking.
//
// `estimado` = true salvo estado === 'finalizado'.
//
// ROADMAP (post-MVP — NO implementar todavía):
//   - Desempates por compra de cambios: si dos users empatan en pts, el que
//     compró más cambios pagos tiene prioridad.
//   - Desempate por preguntas tardías: si sigue empate, comparar respuesta a
//     la última pregunta, luego la penúltima, etc (lectura inversa).
//   - Snapshot al finalizar: congelar premios en una tabla histórica para audit.
//   - ARS / TC Blue: agregar conversión si la economía lo requiere.
//   - Integración con Comidas/Economía (deudas, transferencias, MercadoPago).
//   - Fase Comida Post Mundial: top 5 come gratis si los 5 asisten; los 9
//     restantes pagan; el último organiza; ausente paga como si hubiera ido.
// ════════════════════════════════════════════════════════════════════════════

// ────────────────────────────────────────────────────────────────────────────
// GET /api/mundial/:torneoId/premios-calculados
//   Cruza las filas de `mundial_premios` (modelo fijo) con el ranking actual.
//   - Para cada posición configurada: usuario actual en esa pos del ranking.
//   - `estimado: true` salvo estado === 'finalizado'.
//   - `configurado: false` si no hay filas en mundial_premios todavía.
//   - `total_neto`: suma de todos los `usd` (info menor — con modelo fijo no
//     existe el concepto de "pozo"; es solo curiosidad de cuánto neto se
//     reparte: positivo si hay más premios que castigos, negativo si al revés).
// ────────────────────────────────────────────────────────────────────────────
router.get('/:torneoId/premios-calculados', authMiddleware, (req, res) => {
  const db = getDb();
  const torneoId = parseInt(req.params.torneoId, 10);
  const { error } = getTorneoMundialConAcceso(db, torneoId, req.user);
  if (error) return res.status(error.status).json({ error: error.msg });

  const filas = db.prepare(
    'SELECT posicion, usd, comida_rol FROM mundial_premios WHERE torneo_id = ? ORDER BY posicion ASC'
  ).all(torneoId);

  const { ranking } = calcularRanking(db, torneoId);

  let total_neto = 0;
  const premios = filas.map(f => {
    total_neto += f.usd;
    const u = ranking.find(r => r.posicion === f.posicion);
    return {
      posicion:   f.posicion,
      usd:        f.usd,
      comida_rol: f.comida_rol || null,
      usuario: u ? {
        user_id:  u.user_id,
        nombre:   u.nombre,
        puntos:   u.puntos_totales,
        aciertos: u.aciertos,
      } : null,
    };
  });

  const estado = db.prepare(
    'SELECT estado FROM mundial_config WHERE torneo_id = ?'
  ).get(torneoId)?.estado || 'configuracion';

  res.json({
    premios,
    total_neto,
    configurado: premios.length > 0,
    estimado:    estado !== 'finalizado',
    estado,
  });
});

module.exports = router;
