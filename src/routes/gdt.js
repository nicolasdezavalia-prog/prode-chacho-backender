/**
 * Rutas del módulo Gran DT (GDT).
 */
const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');
const {
  SLOTS,
  SLOT_A_POSICION,
  normalizarNombre,
  levenshtein,
  buscarJugador,
  validarPosicionesEquipo,
  persistirEstadoEquipo,
  getEstadoEquipo,
  getEstadoGlobalJugadores,
  calcularResultadoGDT,
  recalcularGDTFecha,
  getJugadoresActivosTorneo,
  reevaluarEquiposConJugador,
  getJugadoresActivosFecha,
} = require('../logic/gdt');
const { recalcularCruces } = require('../logic/puntos');

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function getTorneoActivo(db) {
  return db.prepare("SELECT * FROM torneos WHERE activo = 1 ORDER BY id DESC LIMIT 1").get();
}

/**
 * Devuelve la liga GDT default para usar cuando una fecha no tiene gdt_liga_id asignado.
 * Prioridad: (1) liga con es_default=1 y activo=1, (2) primera liga activa, (3) null.
 */
function getGdtLigaDefault(db) {
  return (
    db.prepare("SELECT * FROM gdt_ligas WHERE es_default = 1 AND activo = 1 LIMIT 1").get() ||
    db.prepare("SELECT * FROM gdt_ligas WHERE activo = 1 ORDER BY id ASC LIMIT 1").get() ||
    null
  );
}

/**
 * Calcula el estado de participación del equipo a partir de sus dos niveles separados:
 *   - Nivel jugador: aprobados / pendientes / rechazados
 *   - Nivel equipo:  estado_equipo (valido / observado / requiere_correccion / null)
 *
 * Retorna campos listos para incluir en la respuesta del endpoint.
 * El frontend NO deduce nada: usa directamente puede_participar y motivos_no_participa.
 *
 * @param {number} aprobadosCount
 * @param {number} pendientesCount
 * @param {number} rechazadosCount
 * @param {number} totalCargados      - total de slots cargados (puede ser < 11 si el equipo está incompleto)
 * @param {string|null} estadoEquipo  - 'valido' | 'observado' | 'requiere_correccion' | null
 * @param {Array}  observaciones      - lista de mismatches de posición
 * @param {string|null} motivoAdmin
 * @returns {{ puede_participar: boolean, motivos_no_participa: string[] }}
 */
function buildParticipationStatus(aprobadosCount, pendientesCount, rechazadosCount, totalCargados, estadoEquipo, observaciones, motivoAdmin) {
  const motivos = [];

  // Nivel jugador: causas que impiden tener 11 aprobados
  if (pendientesCount > 0) {
    const s = pendientesCount > 1;
    motivos.push(`${pendientesCount} jugador${s ? 'es' : ''} pendiente${s ? 's' : ''} de aprobación`);
  }
  if (rechazadosCount > 0) {
    const s = rechazadosCount > 1;
    motivos.push(`${rechazadosCount} jugador${s ? 'es' : ''} rechazado${s ? 's' : ''} — reemplazalos en tu equipo`);
  }
  if (totalCargados < 11) {
    const faltantes = 11 - totalCargados;
    motivos.push(`Equipo incompleto — faltan ${faltantes} jugador${faltantes > 1 ? 'es' : ''}`);
  }

  // Nivel equipo: causas propias del plantel (solo cuando hay 11 aprobados)
  if (aprobadosCount === 11) {
    if (estadoEquipo === 'observado' && observaciones.length > 0) {
      const s = observaciones.length > 1;
      motivos.push(`${observaciones.length} mismatch${s ? 'es' : ''} de posición — revisá los slots`);
    }
    if (estadoEquipo === 'requiere_correccion') {
      motivos.push(motivoAdmin
        ? `Requiere corrección: ${motivoAdmin}`
        : 'El admin marcó el equipo para corrección');
    }
  }

  return {
    puede_participar: motivos.length === 0,
    motivos_no_participa: motivos,
  };
}

// ─── LIGAS GDT ───────────────────────────────────────────────────────────────

/**
 * GET /api/gdt/ligas
 * Lista todas las ligas GDT activas. Usada por AdminFecha para el selector de liga.
 * Orden: default primero, luego alfabético.
 */
router.get('/ligas', authMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const ligas = db.prepare(`
      SELECT id, nombre, descripcion, formato, pais_categoria, activo, es_default
      FROM gdt_ligas
      WHERE activo = 1
      ORDER BY es_default DESC, nombre ASC
    `).all();
    res.json(ligas);
  } catch (err) { next(err); }
});

// ─── CATÁLOGO DE EQUIPOS (ADMIN) ─────────────────────────────────────────────

/**
 * GET /api/gdt/catalogo?liga_id=X
 * Lista de equipos del catálogo del torneo activo, filtrado por liga GDT.
 * Si no se pasa liga_id, usa la liga default (es_default = 1).
 */
router.get('/catalogo', authMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const torneo = getTorneoActivo(db);
    if (!torneo) return res.json([]);

    const liga = req.query.liga_id
      ? db.prepare('SELECT id FROM gdt_ligas WHERE id = ? AND activo = 1').get(Number(req.query.liga_id))
      : getGdtLigaDefault(db);
    if (!liga) return res.json([]);

    const equipos = db.prepare(
      'SELECT * FROM gdt_equipos_catalogo WHERE torneo_id = ? AND gdt_liga_id = ? AND activo = 1 ORDER BY nombre'
    ).all(torneo.id, liga.id);

    res.json(equipos);
  } catch (err) { next(err); }
});

/**
 * POST /api/gdt/catalogo
 * Admin agrega un equipo al catálogo.
 * Body: { nombre, pais? }
 */
router.post('/catalogo', authMiddleware, adminMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const torneo = getTorneoActivo(db);
    if (!torneo) return res.status(400).json({ error: 'No hay torneo activo' });

    const { nombre, pais } = req.body;
    if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido' });

    const nombreNorm = normalizarNombre(nombre);

    const liga = getGdtLigaDefault(db);
    if (!liga) return res.status(400).json({ error: 'No hay liga GDT activa' });

    // Dedup: buscar por torneo_id + nombre_normalizado sin filtrar por liga
    const existenteAdmin = db.prepare(
      'SELECT * FROM gdt_equipos_catalogo WHERE torneo_id = ? AND nombre_normalizado = ? AND activo = 1'
    ).get(torneo.id, nombreNorm);

    if (existenteAdmin) {
      // Si tiene gdt_liga_id NULL, actualizarlo a la liga default
      if (existenteAdmin.gdt_liga_id === null || existenteAdmin.gdt_liga_id === undefined) {
        db.prepare('UPDATE gdt_equipos_catalogo SET gdt_liga_id = ? WHERE id = ?').run(liga.id, existenteAdmin.id);
      }
      return res.status(409).json({ error: `Ya existe un equipo con ese nombre: "${nombre.trim()}"` });
    }

    const result = db.prepare(`
      INSERT INTO gdt_equipos_catalogo (torneo_id, gdt_liga_id, nombre, nombre_normalizado, pais)
      VALUES (?, ?, ?, ?, ?)
    `).run(torneo.id, liga.id, nombre.trim(), nombreNorm, pais?.trim() || null);

    res.json({ ok: true, id: Number(result.lastInsertRowid) });
  } catch (err) { next(err); }
});

/**
 * DELETE /api/gdt/catalogo/:id
 * Admin desactiva un equipo del catálogo (soft delete).
 */
router.delete('/catalogo/:id', authMiddleware, adminMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    db.prepare('UPDATE gdt_equipos_catalogo SET activo = 0 WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── CATÁLOGO — USUARIO ──────────────────────────────────────────────────────

/**
 * POST /api/gdt/catalogo/usuario
 * Cualquier usuario autenticado puede crear un equipo en el catálogo.
 * Se usa durante el flujo de ventana de cambios cuando el equipo no existe.
 * Usa siempre la liga default. Normaliza el nombre para evitar duplicados simples.
 * Si ya existe un equipo con ese nombre normalizado en la liga, devuelve el existente.
 * Body: { nombre }
 */
router.post('/catalogo/usuario', authMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const torneo = getTorneoActivo(db);
    if (!torneo) return res.status(400).json({ error: 'No hay torneo activo' });

    const { nombre } = req.body;
    if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido' });

    const liga = getGdtLigaDefault(db);
    if (!liga) return res.status(400).json({ error: 'No hay liga GDT activa' });

    const nombreTrimmed = nombre.trim();
    const nombreNorm = normalizarNombre(nombreTrimmed);

    // Dedup: buscar por torneo_id + nombre_normalizado sin filtrar por liga
    // (la constraint UNIQUE no incluye gdt_liga_id, filas antiguas pueden tener gdt_liga_id NULL)
    const existente = db.prepare(
      'SELECT * FROM gdt_equipos_catalogo WHERE torneo_id = ? AND nombre_normalizado = ? AND activo = 1'
    ).get(torneo.id, nombreNorm);

    if (existente) {
      // Si tiene gdt_liga_id NULL, actualizarlo a la liga default
      if (existente.gdt_liga_id === null || existente.gdt_liga_id === undefined) {
        db.prepare('UPDATE gdt_equipos_catalogo SET gdt_liga_id = ? WHERE id = ?').run(liga.id, existente.id);
      }
      return res.json({ ok: true, id: existente.id, nombre: existente.nombre, ya_existia: true });
    }

    const result = db.prepare(
      'INSERT INTO gdt_equipos_catalogo (torneo_id, gdt_liga_id, nombre, nombre_normalizado) VALUES (?, ?, ?, ?)'
    ).run(torneo.id, liga.id, nombreTrimmed, nombreNorm);

    res.json({ ok: true, id: Number(result.lastInsertRowid), nombre: nombreTrimmed, ya_existia: false });
  } catch (err) { next(err); }
});

// ─── BÚSQUEDA DE JUGADORES ───────────────────────────────────────────────────

/**
 * GET /api/gdt/jugadores/buscar?nombre=Y&equipo_id=X (equipo_id opcional)
 * Busca un jugador en el catálogo con deduplicación.
 * Retorna: { exacto, similares }
 */
router.get('/jugadores/buscar', authMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const torneo = getTorneoActivo(db);
    if (!torneo) return res.json({ exacto: null, similares: [] });

    const { equipo_id, nombre } = req.query;
    if (!nombre) return res.json({ exacto: null, similares: [] });

    const resultado = buscarJugador(
      db,
      torneo.id,
      nombre,
      equipo_id ? Number(equipo_id) : null
    );
    res.json(resultado);
  } catch (err) { next(err); }
});

/**
 * GET /api/gdt/jugadores/todos?liga_id=X
 * (Admin) Listado completo de jugadores del torneo activo, filtrado por liga GDT.
 * Si no se pasa liga_id, usa la liga default.
 */
router.get('/jugadores/todos', authMiddleware, adminMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const torneo = getTorneoActivo(db);
    if (!torneo) return res.json([]);

    const liga = req.query.liga_id
      ? db.prepare('SELECT id FROM gdt_ligas WHERE id = ? AND activo = 1').get(Number(req.query.liga_id))
      : getGdtLigaDefault(db);
    if (!liga) return res.json([]);

    const jugadores = db.prepare(`
      SELECT gj.*,
             ec.pais as equipo_pais,
             COUNT(DISTINCT ge.user_id) as en_equipos,
             GROUP_CONCAT(DISTINCT u.nombre) as usuarios
      FROM gdt_jugadores gj
      LEFT JOIN gdt_equipos_catalogo ec ON gj.equipo_catalogo_id = ec.id
      LEFT JOIN gdt_equipos ge ON gj.id = ge.jugador_id AND ge.torneo_id = gj.torneo_id
      LEFT JOIN users u ON ge.user_id = u.id
      WHERE gj.torneo_id = ? AND gj.gdt_liga_id = ? AND gj.activo = 1
      GROUP BY gj.id
      ORDER BY gj.equipo_real, gj.nombre
    `).all(torneo.id, liga.id);

    res.json(jugadores.map(j => ({
      id: j.id,
      nombre: j.nombre,
      nombre_raw: j.nombre_raw,
      nombre_canonico: j.nombre_canonico,
      equipo_real: j.equipo_real,
      equipo_raw: j.equipo_raw,
      equipo_catalogo_id: j.equipo_catalogo_id,
      equipo_pais: j.pais || j.equipo_pais || null,
      posicion: j.posicion,
      estado: j.estado,
      en_equipos: j.en_equipos || 0,
      usuarios: j.usuarios ? j.usuarios.split(',') : [],
    })));
  } catch (err) { next(err); }
});

/**
 * PATCH /api/gdt/jugadores/:id
 * (Admin) Edita nombre, equipo, posición o estado de un jugador.
 * Body: { nombre?, equipo_real?, equipo_catalogo_id?, posicion?, estado? }
 */
router.patch('/jugadores/:id', authMiddleware, adminMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const torneo = getTorneoActivo(db);
    if (!torneo) return res.status(400).json({ error: 'No hay torneo activo' });

    const jugadorId = Number(req.params.id);
    const { nombre, equipo_real, equipo_catalogo_id, posicion, estado, pais } = req.body;

    const jugador = db.prepare('SELECT * FROM gdt_jugadores WHERE id = ? AND torneo_id = ?').get(jugadorId, torneo.id);
    if (!jugador) return res.status(404).json({ error: 'Jugador no encontrado' });

    const updates = {};

    if (nombre?.trim()) {
      updates.nombre = nombre.trim();
      updates.nombre_canonico = nombre.trim();
      updates.nombre_normalizado = normalizarNombre(nombre.trim());
    }
    if (equipo_real?.trim()) updates.equipo_real = equipo_real.trim();
    if (equipo_catalogo_id !== undefined) updates.equipo_catalogo_id = equipo_catalogo_id || null;
    if (posicion && ['ARQ','DEF','MED','DEL'].includes(posicion)) updates.posicion = posicion;
    if (pais !== undefined) updates.pais = pais?.trim() || null;
    if (estado && ['aprobado','pendiente','rechazado'].includes(estado)) {
      updates.estado = estado;
      updates.revisado_por = req.user.id;
      updates.revisado_at = new Date().toISOString();
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'Nada que actualizar' });
    }

    const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE gdt_jugadores SET ${setClauses} WHERE id = ?`)
      .run(...Object.values(updates), jugadorId);

    // Re-evaluar equipos afectados si cambió el estado
    if (estado) reevaluarEquiposConJugador(db, torneo.id, jugadorId);

    res.json({ ok: true });
  } catch (err) { next(err); }
});

/**
 * DELETE /api/gdt/jugadores/:id
 * (Admin) Baja lógica de un jugador. No elimina si tiene equipos activos.
 */
router.delete('/jugadores/:id', authMiddleware, adminMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const torneo = getTorneoActivo(db);
    if (!torneo) return res.status(400).json({ error: 'No hay torneo activo' });

    const jugadorId = Number(req.params.id);
    const enUso = db.prepare(
      'SELECT COUNT(*) as cnt FROM gdt_equipos WHERE jugador_id = ?'
    ).get(jugadorId);

    if (enUso?.cnt > 0) {
      return res.status(409).json({
        error: `Este jugador está en ${enUso.cnt} equipo(s). Primero unificalo o esperá a que los usuarios cambien su plantel.`
      });
    }

    db.prepare('UPDATE gdt_jugadores SET activo = 0 WHERE id = ? AND torneo_id = ?')
      .run(jugadorId, torneo.id);

    res.json({ ok: true });
  } catch (err) { next(err); }
});

/**
 * POST /api/gdt/jugadores/bulk-pais
 * (Admin) Setea el país a todos los jugadores que no lo tengan.
 * Body: { pais }
 */
router.post('/jugadores/bulk-pais', authMiddleware, adminMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const torneo = getTorneoActivo(db);
    if (!torneo) return res.status(400).json({ error: 'No hay torneo activo' });

    const { pais } = req.body;
    if (!pais?.trim()) return res.status(400).json({ error: 'El campo pais es requerido' });

    const result = db.prepare(`
      UPDATE gdt_jugadores SET pais = ?
      WHERE torneo_id = ? AND (pais IS NULL OR pais = '') AND activo = 1
    `).run(pais.trim(), torneo.id);

    res.json({ ok: true, actualizados: result.changes });
  } catch (err) { next(err); }
});

/**
 * GET /api/gdt/jugadores/estado
 * Estado global de jugadores + pendientes e invalidados en mi equipo.
 */
router.get('/jugadores/estado', authMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const torneo = getTorneoActivo(db);
    if (!torneo) return res.json({ bloqueados: [], eliminados: [], mi_equipo_invalidados: [], mi_equipo_pendientes: [] });

    const { bloqueados, eliminados, conteos } = getEstadoGlobalJugadores(db, torneo.id);
    const jugMap = new Map(
      db.prepare('SELECT * FROM gdt_jugadores WHERE torneo_id = ?').all(torneo.id).map(j => [j.id, j])
    );

    const bloqueadosList = [], eliminadosList = [];
    for (const [jId, cnt] of conteos.entries()) {
      const j = jugMap.get(jId);
      if (!j) continue;
      const entry = { jugador_id: jId, nombre: j.nombre, equipo_real: j.equipo_real, count: cnt };
      if (eliminados.has(jId)) eliminadosList.push(entry);
      else if (bloqueados.has(jId)) bloqueadosList.push(entry);
    }

    const miEquipo = db.prepare(`
      SELECT ge.slot, ge.jugador_id, gj.nombre, gj.equipo_real, gj.estado
      FROM gdt_equipos ge JOIN gdt_jugadores gj ON ge.jugador_id = gj.id
      WHERE ge.torneo_id = ? AND ge.user_id = ?
    `).all(torneo.id, req.user.id);

    const miEquipoInvalidados = miEquipo
      .filter(j => eliminados.has(j.jugador_id))
      .map(j => ({ slot: j.slot, jugador_id: j.jugador_id, nombre: j.nombre, equipo_real: j.equipo_real, estado: 'eliminado' }));

    const miEquipoPendientes = miEquipo
      .filter(j => j.estado === 'pendiente' || j.estado === 'rechazado')
      .map(j => ({ slot: j.slot, jugador_id: j.jugador_id, nombre: j.nombre, equipo_real: j.equipo_real, estado: j.estado }));

    res.json({ bloqueados: bloqueadosList, eliminados: eliminadosList, mi_equipo_invalidados: miEquipoInvalidados, mi_equipo_pendientes: miEquipoPendientes });
  } catch (err) { next(err); }
});

/**
 * GET /api/gdt/jugadores/duplicados?liga_id=X
 * (Admin) Lista de posibles duplicados por equipo (Levenshtein ≤ 2), filtrado por liga.
 * Si no se pasa liga_id, usa la liga default. Evita falsos positivos entre ligas distintas.
 */
router.get('/jugadores/duplicados', authMiddleware, adminMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const torneo = getTorneoActivo(db);
    if (!torneo) return res.json([]);

    const liga = req.query.liga_id
      ? db.prepare('SELECT id FROM gdt_ligas WHERE id = ? AND activo = 1').get(Number(req.query.liga_id))
      : getGdtLigaDefault(db);
    if (!liga) return res.json([]);

    const jugadores = db.prepare(
      "SELECT * FROM gdt_jugadores WHERE torneo_id = ? AND gdt_liga_id = ? AND activo = 1 AND estado != 'rechazado' ORDER BY equipo_real, nombre"
    ).all(torneo.id, liga.id);

    // Agrupar por equipo_real y detectar pares similares
    const porEquipo = {};
    for (const j of jugadores) {
      const k = j.equipo_real || 'Sin equipo';
      if (!porEquipo[k]) porEquipo[k] = [];
      porEquipo[k].push(j);
    }

    const duplicados = [];
    for (const [equipo, jugs] of Object.entries(porEquipo)) {
      const pares = [];
      for (let i = 0; i < jugs.length; i++) {
        for (let j = i + 1; j < jugs.length; j++) {
          const normA = jugs[i].nombre_normalizado || normalizarNombre(jugs[i].nombre);
          const normB = jugs[j].nombre_normalizado || normalizarNombre(jugs[j].nombre);
          if (normA.length > 4 && levenshtein(normA, normB) <= 2) {
            pares.push({ a: jugs[i], b: jugs[j] });
          }
        }
      }
      if (pares.length > 0) duplicados.push({ equipo, pares });
    }

    res.json(duplicados);
  } catch (err) { next(err); }
});

/**
 * POST /api/gdt/jugadores/merge
 * (Admin) Unifica dos jugadores: redirige referencias al canónico, desactiva el secundario.
 * Body: { keep_id, merge_id }
 */
router.post('/jugadores/merge', authMiddleware, adminMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const { keep_id, merge_id } = req.body;
    if (!keep_id || !merge_id || keep_id === merge_id) {
      return res.status(400).json({ error: 'keep_id y merge_id deben ser distintos' });
    }

    try {
      db.exec('BEGIN');
      // Si un usuario tiene AMBOS jugadores → eliminar el merge_id de ese usuario
      // (evita UNIQUE constraint violation al redirigir)
      db.prepare(`
        DELETE FROM gdt_equipos
        WHERE jugador_id = ?
          AND (torneo_id || '_' || user_id) IN (
            SELECT torneo_id || '_' || user_id FROM gdt_equipos WHERE jugador_id = ?
          )
      `).run(merge_id, keep_id);
      // Redirigir el resto
      db.prepare('UPDATE gdt_equipos SET jugador_id = ? WHERE jugador_id = ?').run(keep_id, merge_id);
      // Redirigir puntajes (sin pisar los que ya existen para ese fecha+jugador)
      db.prepare(`
        UPDATE gdt_puntajes_fecha SET jugador_id = ?
        WHERE jugador_id = ?
          AND fecha_id NOT IN (SELECT fecha_id FROM gdt_puntajes_fecha WHERE jugador_id = ?)
      `).run(keep_id, merge_id, keep_id);
      // Marcar como inactivo y merged
      db.prepare('UPDATE gdt_jugadores SET activo = 0, merged_into = ?, estado = ? WHERE id = ?').run(keep_id, 'rechazado', merge_id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── PENDIENTES (ADMIN) ───────────────────────────────────────────────────────

/**
 * GET /api/gdt/pendientes?liga_id=X
 * (Admin) Lista de jugadores con estado='pendiente', filtrado por liga GDT.
 * Si no se pasa liga_id, usa la liga default.
 */
router.get('/pendientes', authMiddleware, adminMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const torneo = getTorneoActivo(db);
    if (!torneo) return res.json({ pendientes: [], total: 0 });

    const liga = req.query.liga_id
      ? db.prepare('SELECT id FROM gdt_ligas WHERE id = ? AND activo = 1').get(Number(req.query.liga_id))
      : getGdtLigaDefault(db);
    if (!liga) return res.json({ pendientes: [], total: 0 });

    const jugadores = db.prepare(`
      SELECT gj.*, ec.nombre as equipo_catalogo_nombre
      FROM gdt_jugadores gj
      LEFT JOIN gdt_equipos_catalogo ec ON gj.equipo_catalogo_id = ec.id
      WHERE gj.torneo_id = ? AND gj.gdt_liga_id = ? AND gj.estado = 'pendiente' AND gj.activo = 1
      ORDER BY gj.equipo_real, gj.nombre
    `).all(torneo.id, liga.id);

    // Para cada jugador pendiente, qué usuarios lo tienen en su equipo
    const pendientes = jugadores.map(j => {
      const usuarios = db.prepare(`
        SELECT ge.user_id, ge.slot, u.nombre as usuario_nombre
        FROM gdt_equipos ge
        JOIN users u ON ge.user_id = u.id
        WHERE ge.torneo_id = ? AND ge.jugador_id = ?
        ORDER BY u.nombre
      `).all(torneo.id, j.id);

      return {
        id: j.id,
        nombre: j.nombre,
        nombre_raw: j.nombre_raw,
        nombre_normalizado: j.nombre_normalizado,
        nombre_canonico: j.nombre_canonico,
        equipo_real: j.equipo_real,
        equipo_raw: j.equipo_raw,
        equipo_catalogo_id: j.equipo_catalogo_id,
        equipo_catalogo_nombre: j.equipo_catalogo_nombre,
        posicion: j.posicion,
        estado: j.estado,
        usuarios,
      };
    });

    res.json({ pendientes, total: pendientes.length });
  } catch (err) { next(err); }
});

/**
 * POST /api/gdt/pendientes/:id/aprobar
 * (Admin) Aprueba un jugador pendiente.
 * Body (todo opcional): { nombre_canonico, equipo_catalogo_id, posicion }
 * Si se pasa nombre_canonico → se actualiza nombre y nombre_normalizado para display.
 * Si se pasa equipo_catalogo_id → se actualiza equipo_real al nombre del catálogo.
 */
router.post('/pendientes/:id/aprobar', authMiddleware, adminMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const jugadorId = Number(req.params.id);
    const torneo = getTorneoActivo(db);
    if (!torneo) return res.status(400).json({ error: 'No hay torneo activo' });

    const jugador = db.prepare('SELECT * FROM gdt_jugadores WHERE id = ? AND torneo_id = ?').get(jugadorId, torneo.id);
    if (!jugador) return res.status(404).json({ error: 'Jugador no encontrado' });

    const { nombre_canonico, equipo_catalogo_id, posicion } = req.body || {};

    // Construir actualizaciones
    const updates = {
      estado: 'aprobado',
      revisado_por: req.user.id,
      revisado_at: new Date().toISOString(),
    };

    if (nombre_canonico?.trim()) {
      updates.nombre_canonico = nombre_canonico.trim();
      // El nombre de display se actualiza al canónico
      updates.nombre = nombre_canonico.trim();
      updates.nombre_normalizado = normalizarNombre(nombre_canonico.trim());
    }

    if (equipo_catalogo_id) {
      const cat = db.prepare('SELECT nombre FROM gdt_equipos_catalogo WHERE id = ?').get(Number(equipo_catalogo_id));
      if (cat) {
        updates.equipo_catalogo_id = Number(equipo_catalogo_id);
        updates.equipo_real = cat.nombre;
      }
    }

    if (posicion && ['ARQ', 'DEF', 'MED', 'DEL'].includes(posicion)) {
      updates.posicion = posicion;
    }

    const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE gdt_jugadores SET ${setClauses} WHERE id = ?`)
      .run(...Object.values(updates), jugadorId);

    // Re-evaluar equipos afectados
    reevaluarEquiposConJugador(db, torneo.id, jugadorId);

    res.json({ ok: true });
  } catch (err) { next(err); }
});

/**
 * POST /api/gdt/pendientes/:id/rechazar
 * (Admin) Rechaza un jugador pendiente. El slot queda vacío en los duelos.
 */
router.post('/pendientes/:id/rechazar', authMiddleware, adminMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const jugadorId = Number(req.params.id);
    const torneo = getTorneoActivo(db);
    if (!torneo) return res.status(400).json({ error: 'No hay torneo activo' });

    db.prepare(`
      UPDATE gdt_jugadores SET
        estado = 'rechazado',
        revisado_por = ?,
        revisado_at = datetime('now')
      WHERE id = ? AND torneo_id = ?
    `).run(req.user.id, jugadorId, torneo.id);

    // Re-evaluar equipos afectados
    reevaluarEquiposConJugador(db, torneo.id, jugadorId);

    res.json({ ok: true });
  } catch (err) { next(err); }
});

/**
 * POST /api/gdt/pendientes/:id/unificar
 * (Admin) Unifica jugador pendiente con uno ya aprobado.
 * Redirige todas las referencias al jugador canónico.
 * Body: { keep_id }
 */
router.post('/pendientes/:id/unificar', authMiddleware, adminMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const mergeId = Number(req.params.id);
    const { keep_id } = req.body;
    const torneo = getTorneoActivo(db);
    if (!torneo) return res.status(400).json({ error: 'No hay torneo activo' });

    if (!keep_id || Number(keep_id) === mergeId) {
      return res.status(400).json({ error: 'keep_id debe ser distinto del jugador a unificar' });
    }

    const keepId = Number(keep_id);

    try {
      db.exec('BEGIN');
      // Redirigir gdt_equipos al jugador canónico
      db.prepare('UPDATE gdt_equipos SET jugador_id = ? WHERE jugador_id = ?').run(keepId, mergeId);
      // Redirigir puntajes (sin pisar los que ya existen para ese fecha)
      db.prepare(`
        UPDATE gdt_puntajes_fecha SET jugador_id = ?
        WHERE jugador_id = ?
          AND fecha_id NOT IN (SELECT fecha_id FROM gdt_puntajes_fecha WHERE jugador_id = ?)
      `).run(keepId, mergeId, keepId);
      // Marcar el jugador unificado como rechazado e inactivo
      db.prepare(`
        UPDATE gdt_jugadores SET
          activo = 0,
          estado = 'rechazado',
          merged_into = ?,
          revisado_por = ?,
          revisado_at = datetime('now')
        WHERE id = ?
      `).run(keepId, req.user.id, mergeId);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }

    // Re-evaluar equipos afectados por el jugador canónico (ahora apunta a keep)
    reevaluarEquiposConJugador(db, torneo.id, keepId);

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── EQUIPO DEL USUARIO ──────────────────────────────────────────────────────

/**
 * GET /api/gdt/equipo
 * Mi equipo en el torneo activo.
 *
 * Respuesta con dos niveles claramente separados:
 *   estado_equipo  → nivel equipo  ('valido' | 'observado' | 'requiere_correccion' | null)
 *   estado_jugador → nivel jugador por slot ('aprobado' → ok/bloqueado/eliminado | 'pendiente' | 'rechazado')
 *
 * Campos derivados pre-calculados (el frontend no deduce nada):
 *   puede_participar, motivos_no_participa, *_count
 */
router.get('/equipo', authMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const torneo = getTorneoActivo(db);
    if (!torneo) return res.json({
      equipo: [], torneo_id: null,
      estado_equipo: null, puede_participar: false,
      aprobados_count: 0, pendientes_count: 0, rechazados_count: 0,
      motivos_no_participa: ['No hay torneo activo'],
      observaciones: [], motivo_admin: null,
    });

    const jugadores = db.prepare(`
      SELECT ge.slot, ge.jugador_id, gj.nombre, gj.equipo_real, gj.equipo_raw, gj.posicion,
             gj.estado as estado_jugador,
             ec.nombre as equipo_catalogo_nombre
      FROM gdt_equipos ge
      JOIN gdt_jugadores gj ON ge.jugador_id = gj.id
      LEFT JOIN gdt_equipos_catalogo ec ON gj.equipo_catalogo_id = ec.id
      WHERE ge.torneo_id = ? AND ge.user_id = ?
      ORDER BY ge.slot
    `).all(torneo.id, req.user.id);

    const { bloqueados, eliminados } = getEstadoGlobalJugadores(db, torneo.id);

    // Nivel equipo: estado almacenado en gdt_equipo_estado (puede no existir = null)
    const estadoReg = db.prepare(
      'SELECT * FROM gdt_equipo_estado WHERE torneo_id = ? AND user_id = ?'
    ).get(torneo.id, req.user.id);
    const estadoEquipo = estadoReg?.estado || null;
    const observaciones = estadoReg?.observaciones ? JSON.parse(estadoReg.observaciones) : [];
    const motivoAdmin = estadoReg?.motivo_admin || null;

    // Nivel jugador: contar por estado
    const aprobadosCount  = jugadores.filter(j => j.estado_jugador === 'aprobado').length;
    const pendientesCount = jugadores.filter(j => j.estado_jugador === 'pendiente').length;
    const rechazadosCount = jugadores.filter(j => j.estado_jugador === 'rechazado').length;

    // Estado de participación derivado (pre-calculado, no mezcla niveles)
    const { puede_participar, motivos_no_participa } = buildParticipationStatus(
      aprobadosCount, pendientesCount, rechazadosCount,
      jugadores.length, estadoEquipo, observaciones, motivoAdmin
    );

    // Lista de slots con estado_jugador que el frontend renderiza directamente
    const equipo = jugadores.map(j => {
      // Los jugadores aprobados pueden tener estado de participación global (bloqueado/eliminado)
      const estadoJugador = j.estado_jugador === 'pendiente' ? 'pendiente'
                          : j.estado_jugador === 'rechazado' ? 'rechazado'
                          : eliminados.has(j.jugador_id) ? 'eliminado'
                          : bloqueados.has(j.jugador_id) ? 'bloqueado'
                          : 'ok';
      return {
        slot: j.slot,
        jugador_id: j.jugador_id,
        nombre: j.nombre,
        equipo_real: j.equipo_real,
        equipo_raw: j.equipo_raw,
        equipo_catalogo: j.equipo_catalogo_nombre,
        posicion: j.posicion,
        posicion_esperada: SLOT_A_POSICION[j.slot],
        estado_jugador: estadoJugador,
      };
    });

    res.json({
      torneo_id: torneo.id,
      equipo,
      // Nivel equipo (almacenado)
      estado_equipo: estadoEquipo,
      // Derivados pre-calculados
      puede_participar,
      aprobados_count: aprobadosCount,
      pendientes_count: pendientesCount,
      rechazados_count: rechazadosCount,
      motivos_no_participa,
      // Detalle de posición para el admin/usuario cuando estado_equipo = 'observado'
      observaciones,
      motivo_admin: motivoAdmin,
    });
  } catch (err) { next(err); }
});

/**
 * POST /api/gdt/equipo
 * Crear o reemplazar el equipo del usuario.
 * Body: { jugadores: [{ slot, nombre, equipo_raw, equipo_catalogo_id?, posicion? }] }
 *
 * El sistema:
 * 1. Normaliza nombre + equipo
 * 2. Busca jugador existente para dedup (cualquier estado)
 * 3. Si no existe → crea con estado='pendiente'
 * 4. Si existe → reutiliza (mantiene su estado actual)
 * 5. Valida posiciones (solo de aprobados)
 */
router.post('/equipo', authMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const torneo = getTorneoActivo(db);
    if (!torneo) return res.status(400).json({ error: 'No hay torneo activo' });

    const { jugadores } = req.body;
    if (!Array.isArray(jugadores) || jugadores.length !== 11) {
      return res.status(400).json({ error: 'El equipo debe tener exactamente 11 jugadores' });
    }

    // Validar slots completos y sin repetir
    const slotsEnviados = jugadores.map(j => j.slot);
    const slotsFaltantes = SLOTS.filter(s => !slotsEnviados.includes(s));
    if (slotsFaltantes.length > 0) {
      return res.status(400).json({ error: `Faltan slots: ${slotsFaltantes.join(', ')}` });
    }
    const slotsRepetidos = SLOTS.filter(s => slotsEnviados.filter(x => x === s).length > 1);
    if (slotsRepetidos.length > 0) {
      return res.status(400).json({ error: `Slots repetidos: ${slotsRepetidos.join(', ')}` });
    }

    // Validar que cada slot tenga al menos nombre y alguna forma de equipo
    for (const jug of jugadores) {
      if (!jug.nombre?.trim()) {
        return res.status(400).json({ error: `Slot ${jug.slot}: falta el nombre del jugador` });
      }
      if (!jug.equipo_catalogo_id && !jug.equipo_raw?.trim()) {
        return res.status(400).json({ error: `Slot ${jug.slot}: falta el equipo (escribí el nombre del equipo real)` });
      }
    }

    // Resolver jugador_ids con dedup
    const jugadoresResueltos = [];
    for (const jug of jugadores) {
      const nombre = jug.nombre.trim();
      const nombreNorm = normalizarNombre(nombre);
      const equipoCatalogoId = jug.equipo_catalogo_id ? Number(jug.equipo_catalogo_id) : null;
      const equipoRaw = jug.equipo_raw?.trim() || null;
      const posicion = jug.posicion || SLOT_A_POSICION[jug.slot] || null;

      // Determinar etiqueta de equipo para display y búsqueda
      let equipoLabel = equipoRaw;
      if (equipoCatalogoId) {
        const cat = db.prepare('SELECT nombre FROM gdt_equipos_catalogo WHERE id = ?').get(equipoCatalogoId);
        if (cat) equipoLabel = cat.nombre;
      }
      if (!equipoLabel) equipoLabel = equipoRaw || '';

      // Buscar jugador existente (por catálogo primero, luego por nombre+equipo)
      let jugadorId = null;
      let jugadorExistente = null;

      if (equipoCatalogoId) {
        jugadorExistente = db.prepare(`
          SELECT id, estado FROM gdt_jugadores
          WHERE torneo_id = ? AND equipo_catalogo_id = ? AND nombre_normalizado = ? AND activo = 1
        `).get(torneo.id, equipoCatalogoId, nombreNorm);
      }

      if (!jugadorExistente) {
        // Fallback: buscar por nombre_normalizado + equipo_real
        jugadorExistente = db.prepare(`
          SELECT id, estado FROM gdt_jugadores
          WHERE torneo_id = ? AND nombre_normalizado = ? AND equipo_real = ? AND activo = 1
          LIMIT 1
        `).get(torneo.id, nombreNorm, equipoLabel);
      }

      if (jugadorExistente) {
        jugadorId = jugadorExistente.id;
        // Actualizar equipo_catalogo_id si ahora viene del catálogo y antes no tenía
        if (equipoCatalogoId) {
          db.prepare(`
            UPDATE gdt_jugadores SET
              equipo_catalogo_id = COALESCE(equipo_catalogo_id, ?),
              posicion = COALESCE(posicion, ?)
            WHERE id = ?
          `).run(equipoCatalogoId, posicion, jugadorId);
        }
      } else {
        // Crear nuevo jugador como pendiente
        const result = db.prepare(`
          INSERT INTO gdt_jugadores
            (torneo_id, nombre, nombre_raw, nombre_normalizado, equipo_real, equipo_raw,
             equipo_catalogo_id, posicion, estado, activo)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pendiente', 1)
        `).run(torneo.id, nombre, nombre, nombreNorm, equipoLabel, equipoRaw, equipoCatalogoId, posicion);
        jugadorId = Number(result.lastInsertRowid);
      }

      jugadoresResueltos.push({ slot: jug.slot, jugador_id: jugadorId });
    }

    // Validar que no se repita el mismo jugador en el equipo
    const idsUsados = jugadoresResueltos.map(j => j.jugador_id);
    if (new Set(idsUsados).size !== idsUsados.length) {
      return res.status(400).json({ error: 'No podés repetir el mismo jugador en el plantel' });
    }

    // Persistir equipo
    try {
      db.exec('BEGIN');
      db.prepare('DELETE FROM gdt_equipos WHERE torneo_id = ? AND user_id = ?').run(torneo.id, req.user.id);
      for (const { slot, jugador_id } of jugadoresResueltos) {
        db.prepare(
          'INSERT INTO gdt_equipos (torneo_id, user_id, slot, jugador_id) VALUES (?, ?, ?, ?)'
        ).run(torneo.id, req.user.id, slot, jugador_id);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }

    // Contar estados de los jugadores recién guardados
    const estadosGuardados = jugadoresResueltos.map(jr =>
      db.prepare('SELECT estado FROM gdt_jugadores WHERE id = ?').get(jr.jugador_id)?.estado
    );
    const aprobadosCount  = estadosGuardados.filter(e => e === 'aprobado').length;
    const pendientesCount = estadosGuardados.filter(e => e === 'pendiente').length;
    const rechazadosCount = estadosGuardados.filter(e => e === 'rechazado').length;

    // Nivel equipo: solo se actualiza si hay 11 aprobados
    let estadoEquipo = null;
    let observaciones = [];
    if (aprobadosCount === 11) {
      observaciones = validarPosicionesEquipo(db, torneo.id, req.user.id);
      persistirEstadoEquipo(db, torneo.id, req.user.id, observaciones);
      const estadoReg = db.prepare(
        'SELECT estado FROM gdt_equipo_estado WHERE torneo_id = ? AND user_id = ?'
      ).get(torneo.id, req.user.id);
      estadoEquipo = estadoReg?.estado || 'valido';
    }

    // Respuesta con los dos niveles limpios + derivados
    const { puede_participar, motivos_no_participa } = buildParticipationStatus(
      aprobadosCount, pendientesCount, rechazadosCount,
      jugadoresResueltos.length, estadoEquipo, observaciones, null
    );

    res.json({
      ok: true,
      estado_equipo: estadoEquipo,
      puede_participar,
      aprobados_count: aprobadosCount,
      pendientes_count: pendientesCount,
      rechazados_count: rechazadosCount,
      motivos_no_participa,
      observaciones,
    });
  } catch (err) { next(err); }
});

// ─── EQUIPOS — VISTA ADMIN ───────────────────────────────────────────────────

/**
 * GET /api/gdt/equipos?liga_id=X
 * (Admin) Todos los equipos del torneo activo con estado de validación, filtrado por liga GDT.
 * Si no se pasa liga_id, usa la liga default.
 */
router.get('/equipos', authMiddleware, adminMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const torneo = getTorneoActivo(db);
    if (!torneo) return res.json({ equipos: [], estado_global: [] });

    const liga = req.query.liga_id
      ? db.prepare('SELECT id FROM gdt_ligas WHERE id = ? AND activo = 1').get(Number(req.query.liga_id))
      : getGdtLigaDefault(db);
    if (!liga) return res.json({ equipos: [], estado_global: [] });

    // Query 1: slots del equipo — filtra por liga en gdt_equipos (ge) y gdt_jugadores (gj)
    const filas = db.prepare(`
      SELECT ge.user_id, u.nombre as usuario, ge.slot, ge.jugador_id,
             gj.nombre, gj.equipo_real, gj.equipo_raw, gj.posicion, gj.estado as estado_jugador
      FROM gdt_equipos ge
      JOIN gdt_jugadores gj ON ge.jugador_id = gj.id
      JOIN users u ON ge.user_id = u.id
      WHERE ge.torneo_id = ? AND ge.gdt_liga_id = ?
      ORDER BY u.nombre, ge.slot
    `).all(torneo.id, liga.id);

    const { bloqueados, eliminados, conteos } = getEstadoGlobalJugadores(db, torneo.id);

    // Query 2: estados de validación — filtra por liga en gdt_equipo_estado
    const estados = db.prepare(
      'SELECT * FROM gdt_equipo_estado WHERE torneo_id = ? AND gdt_liga_id = ?'
    ).all(torneo.id, liga.id);
    const estadoMap = Object.fromEntries(estados.map(e => [e.user_id, e]));

    const porUsuario = {};
    for (const fila of filas) {
      if (!porUsuario[fila.user_id]) {
        const est = estadoMap[fila.user_id];
        porUsuario[fila.user_id] = {
          user_id: fila.user_id,
          usuario: fila.usuario,
          jugadores: [],
          estado: est?.estado || 'valido',
          observaciones: est?.observaciones ? JSON.parse(est.observaciones) : [],
          motivo_admin: est?.motivo_admin || null,
          pendientes_count: 0,
          rechazados_count: 0,
        };
      }

      const estadoJugador = fila.estado_jugador === 'pendiente' ? 'pendiente'
                           : fila.estado_jugador === 'rechazado' ? 'rechazado'
                           : eliminados.has(fila.jugador_id) ? 'eliminado'
                           : bloqueados.has(fila.jugador_id) ? 'bloqueado' : 'ok';

      if (estadoJugador === 'pendiente') porUsuario[fila.user_id].pendientes_count++;
      if (estadoJugador === 'rechazado') porUsuario[fila.user_id].rechazados_count++;

      porUsuario[fila.user_id].jugadores.push({
        slot: fila.slot,
        jugador_id: fila.jugador_id,
        nombre: fila.nombre,
        equipo_real: fila.equipo_real,
        equipo_raw: fila.equipo_raw,
        posicion: fila.posicion,
        posicion_esperada: SLOT_A_POSICION[fila.slot],
        estado_jugador: estadoJugador,
      });
    }

    // Incluir usuarios sin equipo que tengan estado registrado
    for (const est of estados) {
      if (!porUsuario[est.user_id]) {
        const u = db.prepare('SELECT nombre FROM users WHERE id = ?').get(est.user_id);
        porUsuario[est.user_id] = {
          user_id: est.user_id,
          usuario: u?.nombre,
          jugadores: [],
          estado: est.estado,
          observaciones: est.observaciones ? JSON.parse(est.observaciones) : [],
          motivo_admin: est.motivo_admin || null,
          pendientes_count: 0,
          rechazados_count: 0,
        };
      }
    }

    // Query 3: jugadores para estado_global — filtra por liga en gdt_jugadores
    const jugadoresDb = db.prepare('SELECT * FROM gdt_jugadores WHERE torneo_id = ? AND gdt_liga_id = ? AND activo = 1').all(torneo.id, liga.id);
    const estadoGlobal = jugadoresDb
      .filter(j => conteos.has(j.id))
      .map(j => ({
        ...j,
        count: conteos.get(j.id),
        estado: eliminados.has(j.id) ? 'eliminado' : bloqueados.has(j.id) ? 'bloqueado' : 'ok',
      }))
      .filter(j => j.estado !== 'ok');

    res.json({ torneo_id: torneo.id, equipos: Object.values(porUsuario), estado_global: estadoGlobal });
  } catch (err) { next(err); }
});

/**
 * PATCH /api/gdt/admin/equipo/:userId/slot
 * Admin reasigna un slot de un equipo a otro jugador.
 * Body: { slot, jugador_id } → asigna jugador existente
 *   OR  { slot, nombre, equipo_real, posicion } → crea jugador como aprobado y asigna
 */
router.patch('/admin/equipo/:userId/slot', authMiddleware, adminMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const torneo = getTorneoActivo(db);
    if (!torneo) return res.status(400).json({ error: 'No hay torneo activo' });

    const userId = Number(req.params.userId);
    const { slot, jugador_id, nombre, equipo_real, posicion } = req.body;

    if (!slot || !SLOTS.includes(slot)) {
      return res.status(400).json({ error: 'Slot inválido' });
    }

    let jId = jugador_id ? Number(jugador_id) : null;

    // Si no viene jugador_id, crear o encontrar por nombre+equipo
    if (!jId) {
      if (!nombre?.trim() || !equipo_real?.trim()) {
        return res.status(400).json({ error: 'Falta jugador_id o nombre+equipo_real' });
      }
      const nombreNorm = normalizarNombre(nombre.trim());
      const existing = db.prepare(`
        SELECT id FROM gdt_jugadores
        WHERE torneo_id = ? AND nombre_normalizado = ? AND equipo_real = ? AND activo = 1
        LIMIT 1
      `).get(torneo.id, nombreNorm, equipo_real.trim());

      if (existing) {
        jId = existing.id;
      } else {
        const pos = posicion || SLOT_A_POSICION[slot];
        const result = db.prepare(`
          INSERT INTO gdt_jugadores
            (torneo_id, nombre, nombre_raw, nombre_normalizado, equipo_real, equipo_raw, posicion, estado, activo)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'aprobado', 1)
        `).run(torneo.id, nombre.trim(), nombre.trim(), nombreNorm, equipo_real.trim(), equipo_real.trim(), pos);
        jId = Number(result.lastInsertRowid);
      }
    }

    // Actualizar el slot (upsert)
    db.prepare(`
      INSERT INTO gdt_equipos (torneo_id, user_id, slot, jugador_id)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(torneo_id, user_id, slot) DO UPDATE SET jugador_id = excluded.jugador_id
    `).run(torneo.id, userId, slot, jId);

    // Re-evaluar estado del equipo
    const obs = validarPosicionesEquipo(db, torneo.id, userId);
    const aprobados = db.prepare(`
      SELECT COUNT(*) as cnt FROM gdt_equipos ge
      JOIN gdt_jugadores gj ON ge.jugador_id = gj.id
      WHERE ge.torneo_id = ? AND ge.user_id = ? AND gj.estado = 'aprobado'
    `).get(torneo.id, userId);
    if (aprobados?.cnt >= 11) persistirEstadoEquipo(db, torneo.id, userId, obs);

    res.json({ ok: true, jugador_id: jId });
  } catch (err) { next(err); }
});

/**
 * POST /api/gdt/admin/equipo/:userId/validar
 * Admin hace override a 'valido'.
 */
router.post('/admin/equipo/:userId/validar', authMiddleware, adminMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const torneo = getTorneoActivo(db);
    if (!torneo) return res.status(400).json({ error: 'No hay torneo activo' });

    db.prepare(`
      INSERT INTO gdt_equipo_estado (torneo_id, user_id, estado, observaciones, motivo_admin, invalidado_por, updated_at)
      VALUES (?, ?, 'valido', NULL, NULL, NULL, datetime('now'))
      ON CONFLICT(torneo_id, user_id) DO UPDATE SET
        estado = 'valido',
        observaciones = NULL,
        motivo_admin = NULL,
        invalidado_por = NULL,
        updated_at = datetime('now')
    `).run(torneo.id, Number(req.params.userId));

    res.json({ ok: true });
  } catch (err) { next(err); }
});

/**
 * POST /api/gdt/admin/equipo/:userId/invalidar
 * Admin pasa a 'requiere_correccion' con motivo.
 * Body: { motivo }
 */
router.post('/admin/equipo/:userId/invalidar', authMiddleware, adminMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const torneo = getTorneoActivo(db);
    if (!torneo) return res.status(400).json({ error: 'No hay torneo activo' });

    const { motivo } = req.body;
    db.prepare(`
      INSERT INTO gdt_equipo_estado (torneo_id, user_id, estado, motivo_admin, invalidado_por, updated_at)
      VALUES (?, ?, 'requiere_correccion', ?, ?, datetime('now'))
      ON CONFLICT(torneo_id, user_id) DO UPDATE SET
        estado = 'requiere_correccion',
        motivo_admin = excluded.motivo_admin,
        invalidado_por = excluded.invalidado_por,
        updated_at = excluded.updated_at
    `).run(torneo.id, Number(req.params.userId), motivo || null, req.user.id);

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── PUNTAJES POR FECHA (ADMIN) ──────────────────────────────────────────────

/**
 * GET /api/gdt/puntajes/:fechaId
 * Lista de jugadores aprobados en equipos válidos + sus puntajes actuales.
 */
router.get('/puntajes/:fechaId', authMiddleware, adminMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const fechaId = Number(req.params.fechaId);
    const fecha = db.prepare('SELECT * FROM fechas WHERE id = ?').get(fechaId);
    if (!fecha) return res.status(404).json({ error: 'Fecha no encontrada' });

    const jugadoresActivos = getJugadoresActivosFecha(db, fechaId);
    const puntajesExistentes = db.prepare('SELECT * FROM gdt_puntajes_fecha WHERE fecha_id = ?').all(fechaId);
    const puntajesMap = new Map(puntajesExistentes.map(p => [p.jugador_id, p]));

    const jugadores = jugadoresActivos.map(j => {
      const p = puntajesMap.get(j.id);
      return {
        jugador_id: j.id,
        nombre: j.nombre,
        equipo_real: j.equipo_real,
        posicion: j.posicion,
        puntos: p ? p.puntos : null,
        jugo: p ? Boolean(p.jugo) : null,
        cargado: !!p,
      };
    });

    res.json({ fecha_id: fechaId, jugadores });
  } catch (err) { next(err); }
});

/**
 * POST /api/gdt/puntajes/:fechaId
 * Cargar/actualizar puntajes. Dispara recálculo GDT.
 * Body: { puntajes: [{ jugador_id, puntos, jugo }] }
 */
router.post('/puntajes/:fechaId', authMiddleware, adminMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const fechaId = Number(req.params.fechaId);
    const fecha = db.prepare('SELECT * FROM fechas WHERE id = ?').get(fechaId);
    if (!fecha) return res.status(404).json({ error: 'Fecha no encontrada' });

    const { puntajes } = req.body;
    if (!Array.isArray(puntajes)) return res.status(400).json({ error: 'puntajes debe ser un array' });

    try {
      db.exec('BEGIN');
      for (const p of puntajes) {
        if (p.jugador_id === undefined || p.puntos === undefined || p.jugo === undefined) continue;
        db.prepare(`
          INSERT INTO gdt_puntajes_fecha (torneo_id, fecha_id, jugador_id, puntos, jugo)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(fecha_id, jugador_id) DO UPDATE SET
            puntos = excluded.puntos,
            jugo   = excluded.jugo
        `).run(fecha.torneo_id, fechaId, p.jugador_id, p.puntos, p.jugo ? 1 : 0);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }

    recalcularGDTFecha(db, fechaId, recalcularCruces);
    res.json({ ok: true, message: 'Puntajes guardados y GDT recalculado' });
  } catch (err) { next(err); }
});

// ─── RESULTADO GDT POR CRUCE ─────────────────────────────────────────────────

/**
 * GET /api/gdt/resultado/:cruceId
 */
router.get('/resultado/:cruceId', authMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const cruceId = Number(req.params.cruceId);
    const cruce = db.prepare('SELECT * FROM cruces WHERE id = ?').get(cruceId);
    if (!cruce) return res.status(404).json({ error: 'Cruce no encontrado' });

    // Admins siempre pueden ver. Jugadores del cruce siempre pueden ver.
    // Otros jugadores pueden ver cuando la fecha está cerrada o finalizada.
    if (req.user.role !== 'admin' && cruce.user1_id !== req.user.id && cruce.user2_id !== req.user.id) {
      const fechaCruce = db.prepare('SELECT estado FROM fechas WHERE id = ?').get(cruce.fecha_id);
      if (!fechaCruce || (fechaCruce.estado !== 'cerrada' && fechaCruce.estado !== 'finalizada')) {
        return res.status(403).json({ error: 'No tenés acceso a este cruce' });
      }
    }

    const resultado = calcularResultadoGDT(db, cruceId);
    if (!resultado) return res.json({ disponible: false, message: 'Equipos no cargados' });

    const u1 = db.prepare('SELECT nombre FROM users WHERE id = ?').get(cruce.user1_id);
    const u2 = db.prepare('SELECT nombre FROM users WHERE id = ?').get(cruce.user2_id);

    let motivo_display = null;
    if (resultado.gdt_motivo) {
      if (resultado.gdt_motivo === 'forfeit_ambos') {
        motivo_display = 'Ambos equipos excluidos del GDT — ninguno suma puntos';
      } else if (resultado.gdt_motivo.startsWith('forfeit_u1')) {
        const razon = resultado.gdt_motivo.split(':')[1] || '';
        motivo_display = `Equipo de ${u1?.nombre} excluido del GDT (${razon})`;
      } else if (resultado.gdt_motivo.startsWith('forfeit_u2')) {
        const razon = resultado.gdt_motivo.split(':')[1] || '';
        motivo_display = `Equipo de ${u2?.nombre} excluido del GDT (${razon})`;
      }
    }

    res.json({
      disponible: true,
      cruce_id: cruceId,
      usuario_u1: u1?.nombre,
      usuario_u2: u2?.nombre,
      es_forfeit: !!resultado.gdt_motivo,
      motivo_display,
      ...resultado,
    });
  } catch (err) { next(err); }
});

// ─── VENTANAS DE CAMBIOS ─────────────────────────────────────────────────────

/**
 * GET /api/gdt/ventana/activa
 * Ventana abierta actualmente (si existe) + info del usuario:
 * cambios usados, cambios restantes, jugadores que soltó en esta ventana.
 */
router.get('/ventana/activa', authMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const torneo = getTorneoActivo(db);
    if (!torneo) return res.json({ ventana: null });

    const ventana = db.prepare(
      "SELECT * FROM gdt_ventanas WHERE torneo_id = ? AND estado = 'abierta' ORDER BY id DESC LIMIT 1"
    ).get(torneo.id);

    if (!ventana) return res.json({ ventana: null });

    // Cambios del usuario en esta ventana
    const cambiosUsuario = db.prepare(
      'SELECT * FROM gdt_cambios WHERE ventana_id = ? AND user_id = ? ORDER BY created_at'
    ).all(ventana.id, req.user.id);

    const cambiosUsados = cambiosUsuario.length;
    const cambiosRestantes = Math.max(0, ventana.cambios_por_usuario - cambiosUsados);

    // Jugadores que el usuario ya soltó en esta ventana (no puede volver a tomarlos)
    const soltadosIds = cambiosUsuario
      .filter(c => c.jugador_anterior_id)
      .map(c => c.jugador_anterior_id);

    res.json({
      ventana: {
        id: ventana.id,
        nombre: ventana.nombre,
        cambios_por_usuario: ventana.cambios_por_usuario,
        cambios_usados: cambiosUsados,
        cambios_restantes: cambiosRestantes,
        created_at: ventana.created_at,
      },
      soltados_ids: soltadosIds,
      cambios: cambiosUsuario,
    });
  } catch (err) { next(err); }
});

/**
 * GET /api/gdt/ventana/disponibles
 * Jugadores disponibles para tomar en la ventana activa.
 * Disponible = aprobado + no está en ningún equipo activo + no fue soltado por este usuario en esta ventana.
 */
router.get('/ventana/disponibles', authMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const torneo = getTorneoActivo(db);
    if (!torneo) return res.json([]);

    const ventana = db.prepare(
      "SELECT * FROM gdt_ventanas WHERE torneo_id = ? AND estado = 'abierta' ORDER BY id DESC LIMIT 1"
    ).get(torneo.id);
    if (!ventana) return res.json([]);

    // Jugadores que el usuario soltó en esta ventana (bloqueados para él)
    const soltadosPorMi = db.prepare(`
      SELECT jugador_anterior_id FROM gdt_cambios
      WHERE ventana_id = ? AND user_id = ? AND jugador_anterior_id IS NOT NULL
    `).all(ventana.id, req.user.id).map(r => r.jugador_anterior_id);

    // Jugadores que están en algún equipo activo
    const enEquipos = db.prepare(
      'SELECT DISTINCT jugador_id FROM gdt_equipos WHERE torneo_id = ?'
    ).all(torneo.id).map(r => r.jugador_id);

    const bloqueadosSet = new Set([...enEquipos, ...soltadosPorMi]);

    // Filtrar por liga default
    const liga = getGdtLigaDefault(db);
    if (!liga) return res.json([]);

    // Jugadores aprobados no bloqueados, de la liga default
    const disponibles = db.prepare(`
      SELECT id, nombre, equipo_real, posicion, pais
      FROM gdt_jugadores
      WHERE torneo_id = ? AND gdt_liga_id = ? AND estado = 'aprobado' AND activo = 1
      ORDER BY equipo_real, nombre
    `).all(torneo.id, liga.id).filter(j => !bloqueadosSet.has(j.id));

    res.json(disponibles);
  } catch (err) { next(err); }
});

/**
 * POST /api/gdt/ventana/cambio
 * Usuario hace un cambio: saca jugador de un slot y pone otro disponible.
 * Body (opción A): { slot, jugador_nuevo_id }
 * Body (opción B): { slot, nuevo_jugador: { nombre, equipo_real, equipo_catalogo_id?, posicion } }
 *   En opción B se crea o reutiliza el jugador (liga default, estado='pendiente' si es nuevo).
 */
router.post('/ventana/cambio', authMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const torneo = getTorneoActivo(db);
    if (!torneo) return res.status(400).json({ error: 'No hay torneo activo' });

    const ventana = db.prepare(
      "SELECT * FROM gdt_ventanas WHERE torneo_id = ? AND estado = 'abierta' ORDER BY id DESC LIMIT 1"
    ).get(torneo.id);
    if (!ventana) return res.status(400).json({ error: 'No hay ventana de cambios abierta' });

    const { slot, jugador_nuevo_id, nuevo_jugador } = req.body;
    if (!slot || !SLOTS.includes(slot)) return res.status(400).json({ error: 'Slot inválido' });
    if (!jugador_nuevo_id && !nuevo_jugador) return res.status(400).json({ error: 'Falta jugador_nuevo_id o nuevo_jugador' });

    let nuevoId;
    let jugadorPendiente = false;

    if (jugador_nuevo_id) {
      nuevoId = Number(jugador_nuevo_id);
    } else {
      // Crear o reusar jugador desde datos del formulario (opción B)
      const { nombre, equipo_real, equipo_catalogo_id, posicion } = nuevo_jugador;
      if (!nombre?.trim()) return res.status(400).json({ error: 'nuevo_jugador: falta nombre' });
      if (!equipo_real?.trim()) return res.status(400).json({ error: 'nuevo_jugador: falta equipo_real' });
      if (!posicion || !['ARQ', 'DEF', 'MED', 'DEL'].includes(posicion)) {
        return res.status(400).json({ error: 'nuevo_jugador: posición inválida (ARQ/DEF/MED/DEL)' });
      }

      const liga = getGdtLigaDefault(db);
      if (!liga) return res.status(400).json({ error: 'No hay liga GDT activa' });

      const nombreNorm = normalizarNombre(nombre.trim());
      const equipoReal = equipo_real.trim();

      // Dedup: buscar jugador existente por nombre + equipo + liga
      const existente = db.prepare(`
        SELECT id, estado FROM gdt_jugadores
        WHERE torneo_id = ? AND gdt_liga_id = ? AND nombre_normalizado = ? AND equipo_real = ? AND activo = 1
        LIMIT 1
      `).get(torneo.id, liga.id, nombreNorm, equipoReal);

      if (existente) {
        nuevoId = existente.id;
        jugadorPendiente = existente.estado === 'pendiente';
      } else {
        const catId = equipo_catalogo_id ? Number(equipo_catalogo_id) : null;
        const result = db.prepare(`
          INSERT INTO gdt_jugadores
            (torneo_id, gdt_liga_id, nombre, nombre_raw, nombre_normalizado,
             equipo_real, equipo_raw, equipo_catalogo_id, posicion, estado, activo)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendiente', 1)
        `).run(torneo.id, liga.id, nombre.trim(), nombre.trim(), nombreNorm,
               equipoReal, equipoReal, catId, posicion);
        nuevoId = Number(result.lastInsertRowid);
        jugadorPendiente = true;
      }
    }

    // Verificar cambios restantes
    const cambiosYa = db.prepare(
      'SELECT COUNT(*) as cnt FROM gdt_cambios WHERE ventana_id = ? AND user_id = ?'
    ).get(ventana.id, req.user.id);
    if (cambiosYa.cnt >= ventana.cambios_por_usuario) {
      return res.status(400).json({ error: `Ya usaste todos tus cambios (${ventana.cambios_por_usuario})` });
    }

    // Verificar que el jugador nuevo está disponible (no en ningún equipo activo, no soltado por el usuario)
    const enEquipo = db.prepare(
      'SELECT user_id FROM gdt_equipos WHERE torneo_id = ? AND jugador_id = ?'
    ).get(torneo.id, nuevoId);
    if (enEquipo) {
      return res.status(400).json({ error: 'Ese jugador ya está en otro equipo (bloqueado)' });
    }

    const soltadoPorMi = db.prepare(
      'SELECT id FROM gdt_cambios WHERE ventana_id = ? AND user_id = ? AND jugador_anterior_id = ?'
    ).get(ventana.id, req.user.id, nuevoId);
    if (soltadoPorMi) {
      return res.status(400).json({ error: 'Soltaste ese jugador en esta ventana, no podés volver a tomarlo' });
    }

    // Jugador anterior en ese slot
    const slotActual = db.prepare(
      'SELECT jugador_id FROM gdt_equipos WHERE torneo_id = ? AND user_id = ? AND slot = ?'
    ).get(torneo.id, req.user.id, slot);
    const jugadorAnteriorId = slotActual?.jugador_id || null;

    // Ejecutar el cambio
    try {
      db.exec('BEGIN');

      // Actualizar el slot (upsert)
      db.prepare(`
        INSERT INTO gdt_equipos (torneo_id, user_id, slot, jugador_id)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(torneo_id, user_id, slot) DO UPDATE SET jugador_id = excluded.jugador_id
      `).run(torneo.id, req.user.id, slot, nuevoId);

      // Registrar el cambio
      db.prepare(`
        INSERT INTO gdt_cambios (ventana_id, torneo_id, user_id, slot, jugador_anterior_id, jugador_nuevo_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(ventana.id, torneo.id, req.user.id, slot, jugadorAnteriorId, nuevoId);

      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }

    // Re-evaluar estado del equipo
    const obs = validarPosicionesEquipo(db, torneo.id, req.user.id);
    const aprobados = db.prepare(`
      SELECT COUNT(*) as cnt FROM gdt_equipos ge
      JOIN gdt_jugadores gj ON ge.jugador_id = gj.id
      WHERE ge.torneo_id = ? AND ge.user_id = ? AND gj.estado = 'aprobado'
    `).get(torneo.id, req.user.id);
    if (aprobados?.cnt >= 11) persistirEstadoEquipo(db, torneo.id, req.user.id, obs);

    // Verificar si el jugador nuevo llegó a 4+ equipos (eliminado)
    const totalConNuevo = db.prepare(
      'SELECT COUNT(*) as cnt FROM gdt_equipos WHERE torneo_id = ? AND jugador_id = ?'
    ).get(torneo.id, nuevoId);
    const esEliminado = totalConNuevo.cnt >= 4;

    const cambiosRestantes = ventana.cambios_por_usuario - (cambiosYa.cnt + 1);

    res.json({
      ok: true,
      cambios_restantes: cambiosRestantes,
      jugador_eliminado: esEliminado,
      jugador_pendiente: jugadorPendiente,
      mensaje: esEliminado
        ? `⚠️ Atención: 4 o más usuarios eligieron este jugador — queda ELIMINADO (0 pts en duelos)`
        : jugadorPendiente
        ? `⏳ Jugador creado. Queda pendiente de aprobación del admin. Tu equipo no participará en GDT hasta entonces.`
        : null,
    });
  } catch (err) { next(err); }
});

// ─── VENTANAS — ADMIN ─────────────────────────────────────────────────────────

/**
 * GET /api/gdt/admin/ventanas?liga_id=X
 * Historial de ventanas del torneo activo, filtrado por liga GDT.
 * Si no se pasa liga_id, usa la liga default.
 */
router.get('/admin/ventanas', authMiddleware, adminMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const torneo = getTorneoActivo(db);
    if (!torneo) return res.json([]);

    const liga = req.query.liga_id
      ? db.prepare('SELECT id FROM gdt_ligas WHERE id = ? AND activo = 1').get(Number(req.query.liga_id))
      : getGdtLigaDefault(db);
    if (!liga) return res.json([]);

    const ventanas = db.prepare(
      'SELECT v.*, u.nombre as abierta_por_nombre FROM gdt_ventanas v LEFT JOIN users u ON v.abierta_por = u.id WHERE v.torneo_id = ? AND v.gdt_liga_id = ? ORDER BY v.id DESC'
    ).all(torneo.id, liga.id);

    // Para cada ventana, stats de cambios
    const result = ventanas.map(v => {
      const stats = db.prepare(`
        SELECT user_id, COUNT(*) as cambios FROM gdt_cambios WHERE ventana_id = ? GROUP BY user_id
      `).all(v.id);
      const totalCambios = stats.reduce((s, r) => s + r.cambios, 0);
      const usuariosActivos = stats.length;
      return { ...v, total_cambios: totalCambios, usuarios_activos: usuariosActivos };
    });

    res.json(result);
  } catch (err) { next(err); }
});

/**
 * POST /api/gdt/admin/ventanas
 * Admin abre una nueva ventana de cambios.
 * Body: { nombre, cambios_por_usuario }
 */
router.post('/admin/ventanas', authMiddleware, adminMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const torneo = getTorneoActivo(db);
    if (!torneo) return res.status(400).json({ error: 'No hay torneo activo' });

    // Solo puede haber una ventana abierta a la vez
    const yaAbierta = db.prepare(
      "SELECT id FROM gdt_ventanas WHERE torneo_id = ? AND estado = 'abierta'"
    ).get(torneo.id);
    if (yaAbierta) return res.status(409).json({ error: 'Ya hay una ventana de cambios abierta' });

    const { nombre, cambios_por_usuario } = req.body;
    if (!nombre?.trim()) return res.status(400).json({ error: 'El nombre es requerido' });

    const result = db.prepare(`
      INSERT INTO gdt_ventanas (torneo_id, nombre, cambios_por_usuario, estado, abierta_por)
      VALUES (?, ?, ?, 'abierta', ?)
    `).run(torneo.id, nombre.trim(), Number(cambios_por_usuario) || 2, req.user.id);

    res.json({ ok: true, id: Number(result.lastInsertRowid) });
  } catch (err) { next(err); }
});

/**
 * POST /api/gdt/admin/ventanas/:id/cerrar
 * Admin cierra una ventana.
 */
router.post('/admin/ventanas/:id/cerrar', authMiddleware, adminMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    db.prepare(`
      UPDATE gdt_ventanas SET estado = 'cerrada', cerrada_at = datetime('now')
      WHERE id = ?
    `).run(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/**
 * GET /api/gdt/admin/ventanas/:id/detalle
 * Admin ve los cambios de una ventana específica.
 */
router.get('/admin/ventanas/:id/detalle', authMiddleware, adminMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const cambios = db.prepare(`
      SELECT c.*, u.nombre as usuario,
             ja.nombre as jugador_anterior, ja.equipo_real as equipo_anterior,
             jn.nombre as jugador_nuevo, jn.equipo_real as equipo_nuevo
      FROM gdt_cambios c
      JOIN users u ON c.user_id = u.id
      LEFT JOIN gdt_jugadores ja ON c.jugador_anterior_id = ja.id
      JOIN gdt_jugadores jn ON c.jugador_nuevo_id = jn.id
      WHERE c.ventana_id = ?
      ORDER BY u.nombre, c.created_at
    `).all(Number(req.params.id));

    res.json(cambios);
  } catch (err) { next(err); }
});

module.exports = router;
