const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { authMiddleware, requirePermiso } = require('../middleware/auth');

/**
 * GET /api/comidas?torneo_id=X&mes=Y&anio=Z
 * Devuelve la comida mensual del torneo/mes/año.
 * Todos los usuarios autenticados pueden ver.
 */
router.get('/', authMiddleware, (req, res) => {
  const { torneo_id, mes, anio } = req.query;
  if (!torneo_id || !mes || !anio) {
    return res.status(400).json({ error: 'Parámetros requeridos: torneo_id, mes, anio' });
  }

  const db = getDb();
  try {
    const comida = db.prepare(`
      SELECT
        c.*,
        u.nombre AS organizador_nombre
      FROM comidas_mensuales c
      LEFT JOIN users u ON u.id = c.organizador_user_id
      WHERE c.torneo_id = ? AND c.mes = ? AND c.anio = ?
    `).get(parseInt(torneo_id), parseInt(mes), parseInt(anio));

    // Si no existe aún, devolvemos null (el cliente maneja el estado vacío)
    return res.json(comida || null);
  } catch (err) {
    console.error('[comidas GET]', err.message);
    return res.status(500).json({ error: 'Error interno', detail: err.message });
  }
});

/**
 * PUT /api/comidas
 * Upsert de comida mensual por torneo_id + mes + anio.
 * Requiere permiso editar_tabla_mensual (o superadmin).
 *
 * Body: { torneo_id, mes, anio, organizador_user_id, lugar, fecha_comida, google_maps_url, nota, estado }
 */
router.put('/', authMiddleware, requirePermiso('editar_tabla_mensual'), (req, res) => {
  const {
    torneo_id,
    mes,
    anio,
    organizador_user_id,
    lugar,
    fecha_comida,
    google_maps_url,
    nota,
    estado,
  } = req.body;

  if (!torneo_id || !mes || !anio) {
    return res.status(400).json({ error: 'Campos requeridos: torneo_id, mes, anio' });
  }

  const ESTADOS_VALIDOS = ['pendiente', 'confirmada', 'realizada'];
  const estadoFinal = ESTADOS_VALIDOS.includes(estado) ? estado : 'pendiente';

  const db = getDb();
  try {
    db.prepare(`
      INSERT INTO comidas_mensuales
        (torneo_id, mes, anio, organizador_user_id, lugar, fecha_comida, google_maps_url, nota, estado, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(torneo_id, mes, anio) DO UPDATE SET
        organizador_user_id = excluded.organizador_user_id,
        lugar               = excluded.lugar,
        fecha_comida        = excluded.fecha_comida,
        google_maps_url     = excluded.google_maps_url,
        nota                = excluded.nota,
        estado              = excluded.estado,
        updated_by          = excluded.updated_by,
        updated_at          = datetime('now')
    `).run(
      parseInt(torneo_id),
      parseInt(mes),
      parseInt(anio),
      organizador_user_id ? parseInt(organizador_user_id) : null,
      lugar?.trim() || null,
      fecha_comida?.trim() || null,
      google_maps_url?.trim() || null,
      nota?.trim() || null,
      estadoFinal,
      req.user.id,
    );

    // Devolver el registro actualizado con el nombre del organizador
    const comida = db.prepare(`
      SELECT c.*, u.nombre AS organizador_nombre
      FROM comidas_mensuales c
      LEFT JOIN users u ON u.id = c.organizador_user_id
      WHERE c.torneo_id = ? AND c.mes = ? AND c.anio = ?
    `).get(parseInt(torneo_id), parseInt(mes), parseInt(anio));

    return res.json(comida);
  } catch (err) {
    console.error('[comidas PUT]', err.message);
    return res.status(500).json({ error: 'Error interno', detail: err.message });
  }
});

/**
 * GET /api/comidas/:comidaId/participantes
 * Devuelve los participantes de una comida.
 * Todos los usuarios autenticados pueden ver.
 */
router.get('/:comidaId/participantes', authMiddleware, (req, res) => {
  const comidaId = parseInt(req.params.comidaId);
  if (!comidaId) return res.status(400).json({ error: 'comidaId inválido' });

  const db = getDb();
  try {
    const rows = db.prepare(`
      SELECT
        cp.id,
        cp.user_id,
        cp.nombre,
        cp.es_jugador,
        cp.puede_votar,
        cp.asistio
      FROM comidas_participantes cp
      WHERE cp.comida_id = ?
      ORDER BY cp.es_jugador DESC, cp.nombre ASC
    `).all(comidaId);

    const jugadores = rows.filter(r => r.es_jugador);
    const externos  = rows.filter(r => !r.es_jugador);

    return res.json({ jugadores, externos });
  } catch (err) {
    console.error('[comidas participantes GET]', err.message);
    return res.status(500).json({ error: 'Error interno', detail: err.message });
  }
});

/**
 * PUT /api/comidas/:comidaId/participantes
 * Reemplaza todos los participantes de una comida (sync completo).
 * Requiere permiso editar_tabla_mensual (o superadmin).
 *
 * Body:
 *   jugadores: [{ user_id, nombre, asistio }]  — jugadores del torneo marcados como asistentes
 *   externos:  [{ nombre }]                    — invitados externos sin usuario
 */
router.put('/:comidaId/participantes', authMiddleware, requirePermiso('editar_tabla_mensual'), (req, res) => {
  const comidaId = parseInt(req.params.comidaId);
  if (!comidaId) return res.status(400).json({ error: 'comidaId inválido' });

  const { jugadores = [], externos = [] } = req.body;

  // Validaciones básicas
  if (!Array.isArray(jugadores) || !Array.isArray(externos)) {
    return res.status(400).json({ error: 'jugadores y externos deben ser arrays' });
  }

  const db = getDb();
  try {
    // Verificar que la comida existe
    const comida = db.prepare('SELECT id FROM comidas_mensuales WHERE id = ?').get(comidaId);
    if (!comida) return res.status(404).json({ error: 'Comida no encontrada' });

    // Sync completo: borrar todos los participantes anteriores e insertar los nuevos
    db.prepare('DELETE FROM comidas_participantes WHERE comida_id = ?').run(comidaId);

    const insertStmt = db.prepare(`
      INSERT INTO comidas_participantes
        (comida_id, user_id, nombre, es_jugador, puede_votar, asistio)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const j of jugadores) {
      if (!j.user_id || !j.nombre) continue;
      insertStmt.run(
        comidaId,
        parseInt(j.user_id),
        String(j.nombre).trim(),
        1,  // es_jugador
        1,  // puede_votar
        j.asistio ? 1 : 0
      );
    }

    for (const e of externos) {
      const nombre = String(e.nombre || '').trim();
      if (!nombre) continue;
      insertStmt.run(
        comidaId,
        null,   // user_id = null
        nombre,
        0,      // es_jugador
        0,      // puede_votar
        1       // asistio (siempre asiste si está en la lista)
      );
    }

    // Devolver los participantes actualizados
    const rows = db.prepare(`
      SELECT id, user_id, nombre, es_jugador, puede_votar, asistio
      FROM comidas_participantes
      WHERE comida_id = ?
      ORDER BY es_jugador DESC, nombre ASC
    `).all(comidaId);

    return res.json({
      jugadores: rows.filter(r => r.es_jugador),
      externos:  rows.filter(r => !r.es_jugador),
    });
  } catch (err) {
    console.error('[comidas participantes PUT]', err.message);
    return res.status(500).json({ error: 'Error interno', detail: err.message });
  }
});


/**
 * GET /api/comidas/:comidaId/fotos
 * Devuelve la lista de fotos de una comida.
 * Todos los usuarios autenticados pueden ver.
 */
router.get('/:comidaId/fotos', authMiddleware, (req, res) => {
  const comidaId = parseInt(req.params.comidaId);
  if (!comidaId) return res.status(400).json({ error: 'comidaId inválido' });

  const db = getDb();
  try {
    const fotos = db.prepare(
      'SELECT id, url, created_at FROM comidas_fotos WHERE comida_id = ? ORDER BY created_at ASC'
    ).all(comidaId);
    return res.json(fotos);
  } catch (err) {
    console.error('[comidas fotos GET]', err.message);
    return res.status(500).json({ error: 'Error interno', detail: err.message });
  }
});

/**
 * POST /api/comidas/:comidaId/fotos
 * Inserta una foto (base64) en una comida.
 * Requiere permiso editar_tabla_mensual (o superadmin).
 * Body: { url: string }  — base64 data URI
 */
router.post('/:comidaId/fotos', authMiddleware, requirePermiso('editar_tabla_mensual'), (req, res) => {
  const comidaId = parseInt(req.params.comidaId);
  if (!comidaId) return res.status(400).json({ error: 'comidaId inválido' });

  const { url } = req.body;
  if (!url || typeof url !== 'string' || !url.startsWith('data:image/')) {
    return res.status(400).json({ error: 'url debe ser un data URI de imagen (base64)' });
  }

  const db = getDb();
  try {
    const comida = db.prepare('SELECT id FROM comidas_mensuales WHERE id = ?').get(comidaId);
    if (!comida) return res.status(404).json({ error: 'Comida no encontrada' });

    const result = db.prepare(
      'INSERT INTO comidas_fotos (comida_id, url) VALUES (?, ?)'
    ).run(comidaId, url);

    const foto = db.prepare(
      'SELECT id, url, created_at FROM comidas_fotos WHERE id = ?'
    ).get(result.lastInsertRowid);

    return res.status(201).json(foto);
  } catch (err) {
    console.error('[comidas fotos POST]', err.message);
    return res.status(500).json({ error: 'Error interno', detail: err.message });
  }
});


const DEFAULT_VOTACION_ITEMS = [{"nombre":"Comida","peso":40},{"nombre":"Precio/Calidad","peso":30},{"nombre":"Servicio","peso":20},{"nombre":"Ambiente","peso":10}];

/**
 * GET /api/comidas/config/:torneoId
 * Devuelve la configuración de votación del torneo.
 * Si no existe, devuelve la config default sin persistirla.
 */
router.get('/config/:torneoId', authMiddleware, (req, res) => {
  const torneoId = parseInt(req.params.torneoId);
  if (!torneoId) return res.status(400).json({ error: 'torneoId inválido' });

  const db = getDb();
  try {
    const row = db.prepare(
      'SELECT items_json, updated_at FROM comidas_votacion_config WHERE torneo_id = ?'
    ).get(torneoId);

    if (!row) {
      return res.json({ torneo_id: torneoId, items: DEFAULT_VOTACION_ITEMS, is_default: true });
    }

    let items;
    try { items = JSON.parse(row.items_json); } catch (_) { items = DEFAULT_VOTACION_ITEMS; }
    return res.json({ torneo_id: torneoId, items, updated_at: row.updated_at, is_default: false });
  } catch (err) {
    console.error('[comidas config GET]', err.message);
    return res.status(500).json({ error: 'Error interno', detail: err.message });
  }
});

/**
 * PUT /api/comidas/config/:torneoId
 * Guarda (upsert) la configuración de votación del torneo.
 * Requiere permiso editar_tabla_mensual o superadmin.
 *
 * Body: { items: [{ nombre: string, peso: number }] }
 * Validaciones:
 *   - items debe ser array no vacío
 *   - cada item debe tener nombre (no vacío) y peso (número > 0)
 *   - suma de pesos debe ser exactamente 100
 */
router.put('/config/:torneoId', authMiddleware, requirePermiso('editar_tabla_mensual'), (req, res) => {
  const torneoId = parseInt(req.params.torneoId);
  if (!torneoId) return res.status(400).json({ error: 'torneoId inválido' });

  const { items } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items debe ser un array no vacío' });
  }

  for (const item of items) {
    if (!item.nombre || typeof item.nombre !== 'string' || !item.nombre.trim()) {
      return res.status(400).json({ error: 'Cada ítem debe tener un nombre no vacío' });
    }
    if (typeof item.peso !== 'number' || item.peso <= 0) {
      return res.status(400).json({ error: 'Cada ítem debe tener un peso mayor a 0' });
    }
  }

  const total = items.reduce((sum, i) => sum + i.peso, 0);
  if (Math.round(total) !== 100) {
    return res.status(400).json({ error: `Los pesos deben sumar 100 (suma actual: ${total})` });
  }

  const cleanItems = items.map(i => ({ nombre: i.nombre.trim(), peso: i.peso }));

  const db = getDb();
  try {
    db.prepare(`
      INSERT INTO comidas_votacion_config (torneo_id, items_json, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(torneo_id) DO UPDATE SET
        items_json = excluded.items_json,
        updated_at = datetime('now')
    `).run(torneoId, JSON.stringify(cleanItems));

    return res.json({ torneo_id: torneoId, items: cleanItems });
  } catch (err) {
    console.error('[comidas config PUT]', err.message);
    return res.status(500).json({ error: 'Error interno', detail: err.message });
  }
});


/**
 * GET /api/comidas/:comidaId/votos/me
 * Devuelve los votos del usuario actual para esa comida.
 */
router.get('/:comidaId/votos/me', authMiddleware, (req, res) => {
  const comidaId = parseInt(req.params.comidaId);
  if (!comidaId) return res.status(400).json({ error: 'comidaId inválido' });

  const db = getDb();
  try {
    const votos = db.prepare(
      'SELECT item, puntaje FROM comidas_votos WHERE comida_id = ? AND user_id = ?'
    ).all(comidaId, req.user.id);
    return res.json(votos);
  } catch (err) {
    console.error('[comidas votos GET me]', err.message);
    return res.status(500).json({ error: 'Error interno', detail: err.message });
  }
});

/**
 * PUT /api/comidas/:comidaId/votos
 * Guarda o actualiza los votos del usuario para una comida.
 * Solo si el usuario está en participantes y puede_votar = true.
 *
 * Body: { votos: [{ item: string, puntaje: number }] }
 */
router.put('/:comidaId/votos', authMiddleware, (req, res) => {
  const comidaId = parseInt(req.params.comidaId);
  if (!comidaId) return res.status(400).json({ error: 'comidaId inválido' });

  const { votos } = req.body;
  if (!Array.isArray(votos) || votos.length === 0) {
    return res.status(400).json({ error: 'votos debe ser un array no vacío' });
  }

  for (const v of votos) {
    if (!v.item || typeof v.item !== 'string' || !v.item.trim()) {
      return res.status(400).json({ error: 'Cada voto debe tener un item válido' });
    }
    const p = Number(v.puntaje);
    if (!Number.isInteger(p) || p < 1 || p > 10) {
      return res.status(400).json({ error: `Puntaje fuera de rango (1-10): ${v.item}` });
    }
  }

  const db = getDb();
  try {
    // Verificar que la comida existe
    const comida = db.prepare('SELECT id, organizador_user_id FROM comidas_mensuales WHERE id = ?').get(comidaId);
    if (!comida) return res.status(404).json({ error: 'Comida no encontrada' });

    // El organizador no puede votar su propia comida
    if (comida.organizador_user_id && comida.organizador_user_id === req.user.id) {
      return res.status(403).json({ error: 'El organizador no puede votar su propia comida' });
    }

    // Verificar que el usuario es participante con puede_votar = true
    const participante = db.prepare(
      'SELECT id FROM comidas_participantes WHERE comida_id = ? AND user_id = ? AND puede_votar = 1'
    ).get(comidaId, req.user.id);
    if (!participante) {
      return res.status(403).json({ error: 'No tenés permiso para votar en esta comida' });
    }

    // Upsert de cada voto (BEGIN/COMMIT manual)
    const upsert = db.prepare(`
      INSERT INTO comidas_votos (comida_id, user_id, item, puntaje)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(comida_id, user_id, item) DO UPDATE SET
        puntaje    = excluded.puntaje,
        created_at = datetime('now')
    `);

    db.prepare('BEGIN').run();
    try {
      for (const v of votos) {
        upsert.run(comidaId, req.user.id, v.item.trim(), Number(v.puntaje));
      }
      db.prepare('COMMIT').run();
    } catch (txErr) {
      db.prepare('ROLLBACK').run();
      throw txErr;
    }

    // Devolver los votos actualizados
    const updated = db.prepare(
      'SELECT item, puntaje FROM comidas_votos WHERE comida_id = ? AND user_id = ?'
    ).all(comidaId, req.user.id);

    return res.json(updated);
  } catch (err) {
    console.error('[comidas votos PUT]', err.message);
    return res.status(500).json({ error: 'Error interno', detail: err.message });
  }
});


/**
 * GET /api/comidas/:comidaId/votacion-status
 * Devuelve el estado de votación de una comida.
 * voto_completo = tiene votos para TODOS los ítems configurados para el torneo.
 * Requiere permiso editar_tabla_mensual o superadmin.
 */
router.get('/:comidaId/votacion-status', authMiddleware, requirePermiso('editar_tabla_mensual'), (req, res) => {
  const comidaId = parseInt(req.params.comidaId);
  if (!comidaId) return res.status(400).json({ error: 'comidaId inválido' });

  const db = getDb();
  try {
    // Obtener la comida y su torneo
    const comida = db.prepare('SELECT id, torneo_id, votacion_estado, organizador_user_id FROM comidas_mensuales WHERE id = ?').get(comidaId);
    if (!comida) return res.status(404).json({ error: 'Comida no encontrada' });

    // Obtener config de votación del torneo para saber los ítems requeridos
    const cfg = db.prepare(
      'SELECT items_json FROM comidas_votacion_config WHERE torneo_id = ?'
    ).get(comida.torneo_id);

    const DEFAULT_ITEMS = ['Comida', 'Precio/Calidad', 'Servicio', 'Ambiente'];
    let itemsRequeridos;
    try {
      itemsRequeridos = cfg ? JSON.parse(cfg.items_json).map(i => i.nombre) : DEFAULT_ITEMS;
    } catch (_) {
      itemsRequeridos = DEFAULT_ITEMS;
    }
    const totalItems = itemsRequeridos.length;

    // Obtener participantes con puede_votar = true
    const participantes = db.prepare(`
      SELECT user_id, nombre, es_jugador
      FROM comidas_participantes
      WHERE comida_id = ? AND puede_votar = 1
      ORDER BY es_jugador DESC, nombre ASC
    `).all(comidaId);

    // Obtener votos existentes agrupados por user_id
    const votosRows = db.prepare(`
      SELECT user_id, COUNT(*) as cant
      FROM comidas_votos
      WHERE comida_id = ?
      GROUP BY user_id
    `).all(comidaId);

    const votosPorUsuario = {};
    for (const r of votosRows) {
      if (r.user_id !== null) votosPorUsuario[r.user_id] = r.cant;
    }

    // Construir detalle — el organizador se separa (no vota)
    const detalle = participantes.map(p => {
      const esOrganizador = comida.organizador_user_id && p.user_id === comida.organizador_user_id;
      return {
        nombre: p.nombre,
        tipo: p.es_jugador ? 'jugador' : 'invitado',
        es_organizador: !!esOrganizador,
        voto_completo: !esOrganizador && p.user_id !== null
          ? (votosPorUsuario[p.user_id] || 0) >= totalItems
          : false,  // organizador e invitados sin user_id no cuentan como votantes
      };
    });

    // Total y pendientes excluyen al organizador
    const votantes    = detalle.filter(d => !d.es_organizador);
    const votaron     = votantes.filter(d => d.voto_completo).length;
    const pendientes  = votantes.filter(d => !d.voto_completo).length;

    return res.json({
      total:     votantes.length,
      votaron,
      pendientes,
      detalle,
      estado_votacion: comida.votacion_estado || 'abierta',
    });
  } catch (err) {
    console.error('[comidas votacion-status GET]', err.message);
    return res.status(500).json({ error: 'Error interno', detail: err.message });
  }
});


/**
 * PUT /api/comidas/:comidaId/votacion-cerrar
 * Cierra manualmente la votación de una comida.
 * Requiere permiso editar_tabla_mensual o superadmin.
 */
router.put('/:comidaId/votacion-cerrar', authMiddleware, requirePermiso('editar_tabla_mensual'), (req, res) => {
  const comidaId = parseInt(req.params.comidaId);
  if (!comidaId) return res.status(400).json({ error: 'comidaId inválido' });

  const db = getDb();
  try {
    const comida = db.prepare('SELECT id, votacion_estado FROM comidas_mensuales WHERE id = ?').get(comidaId);
    if (!comida) return res.status(404).json({ error: 'Comida no encontrada' });

    db.prepare(
      `UPDATE comidas_mensuales SET votacion_estado = 'cerrada', updated_at = datetime('now') WHERE id = ?`
    ).run(comidaId);

    return res.json({ id: comidaId, votacion_estado: 'cerrada' });
  } catch (err) {
    console.error('[comidas votacion-cerrar PUT]', err.message);
    return res.status(500).json({ error: 'Error interno', detail: err.message });
  }
});


/**
 * GET /api/comidas/torneo/:torneoId/historico
 * Lista todas las comidas del torneo con promedios por ítem y puntuación total.
 * Los resultados se ocultan si el torneo está activo (activo = 1).
 */
router.get('/torneo/:torneoId/historico', authMiddleware, requirePermiso('editar_tabla_mensual'), (req, res) => {
  const torneoId = parseInt(req.params.torneoId);
  if (!torneoId) return res.status(400).json({ error: 'torneoId inválido' });

  const db = getDb();
  try {
    // Verificar torneo y su estado
    const torneo = db.prepare('SELECT id, activo FROM torneos WHERE id = ?').get(torneoId);
    if (!torneo) return res.status(404).json({ error: 'Torneo no encontrado' });

    const torneoCerrado = !torneo.activo; // activo=0 → cerrado → mostrar resultados

    // Obtener configuración de ítems con pesos
    const cfg = db.prepare(
      'SELECT items_json FROM comidas_votacion_config WHERE torneo_id = ?'
    ).get(torneoId);

    const DEFAULT_ITEMS = [
      { nombre: 'Comida', peso: 40 },
      { nombre: 'Precio/Calidad', peso: 30 },
      { nombre: 'Servicio', peso: 20 },
      { nombre: 'Ambiente', peso: 10 },
    ];
    let itemsConfig;
    try {
      itemsConfig = cfg ? JSON.parse(cfg.items_json) : DEFAULT_ITEMS;
    } catch (_) {
      itemsConfig = DEFAULT_ITEMS;
    }

    // Obtener todas las comidas del torneo
    const comidas = db.prepare(`
      SELECT
        c.id AS comida_id,
        c.mes,
        c.anio,
        c.lugar,
        c.votacion_estado,
        u.nombre AS organizador
      FROM comidas_mensuales c
      LEFT JOIN users u ON u.id = c.organizador_user_id
      WHERE c.torneo_id = ?
      ORDER BY c.anio DESC, c.mes DESC
    `).all(torneoId);

    // Para cada comida calcular promedios si el torneo está cerrado
    const resultado = comidas.map(c => {
      if (!torneoCerrado) {
        return {
          comida_id:        c.comida_id,
          mes:              c.mes,
          anio:             c.anio,
          lugar:            c.lugar,
          organizador:      c.organizador,
          votacion_estado:  c.votacion_estado || 'abierta',
          puntuacion_total: null,
          items:            [],
          votos:            [],
        };
      }

      // Calcular promedios por ítem
      const promediosRows = db.prepare(`
        SELECT item, AVG(puntaje) AS promedio
        FROM comidas_votos
        WHERE comida_id = ?
        GROUP BY item
      `).all(c.comida_id);

      const promedioMap = {};
      for (const r of promediosRows) {
        promedioMap[r.item] = r.promedio;
      }

      const items = itemsConfig.map(ic => ({
        item:    ic.nombre,
        promedio: promedioMap[ic.nombre] != null
          ? Math.round(promedioMap[ic.nombre] * 10) / 10
          : null,
      }));

      // Puntuación total ponderada (solo si hay votos para todos los ítems)
      let puntuacion_total = null;
      const todosConVotos = items.every(i => i.promedio !== null);
      if (todosConVotos && items.length > 0) {
        let total = 0;
        for (const ic of itemsConfig) {
          const prom = promedioMap[ic.nombre] || 0;
          total += prom * (ic.peso / 100);
        }
        puntuacion_total = Math.round(total * 10) / 10;
      }

      // Votos individuales agrupados por votante
      const votosRows = db.prepare(`
        SELECT
          v.user_id,
          COALESCE(u.nombre, 'Invitado') AS votante,
          v.item,
          v.puntaje
        FROM comidas_votos v
        LEFT JOIN users u ON u.id = v.user_id
        WHERE v.comida_id = ?
        ORDER BY votante, v.item
      `).all(c.comida_id);

      // Agrupar por votante
      const votantesMap = {};
      for (const r of votosRows) {
        const key = r.user_id !== null ? `u_${r.user_id}` : `n_${r.votante}`;
        if (!votantesMap[key]) {
          votantesMap[key] = { votante: r.votante, items: {} };
        }
        votantesMap[key].items[r.item] = r.puntaje;
      }

      const votos = Object.values(votantesMap).map(v => {
        // Calcular resultado ponderado individual
        let resultado_total = null;
        const tieneAll = itemsConfig.every(ic => v.items[ic.nombre] != null);
        if (tieneAll && itemsConfig.length > 0) {
          let total = 0;
          for (const ic of itemsConfig) {
            total += v.items[ic.nombre] * (ic.peso / 100);
          }
          resultado_total = Math.round(total * 10) / 10;
        }
        return {
          votante: v.votante,
          resultado_total,
          items: itemsConfig.map(ic => ({
            item:    ic.nombre,
            puntaje: v.items[ic.nombre] ?? null,
          })),
        };
      });

      return {
        comida_id:        c.comida_id,
        mes:              c.mes,
        anio:             c.anio,
        lugar:            c.lugar,
        organizador:      c.organizador,
        votacion_estado:  c.votacion_estado || 'abierta',
        puntuacion_total,
        items,
        votos,
      };
    });

    return res.json(resultado);
  } catch (err) {
    console.error('[comidas historico GET]', err.message);
    return res.status(500).json({ error: 'Error interno', detail: err.message });
  }
});

/**
 * GET /api/comidas/torneo/:torneoId/lista
 * Devuelve la lista de comidas existentes para un torneo.
 * Accesible para todos los usuarios autenticados (sin permiso admin).
 * Incluye cantidades de fotos y participantes.
 * No incluye votos ni puntajes (eso lo maneja el historico admin).
 */
router.get('/torneo/:torneoId/lista', authMiddleware, (req, res) => {
  const torneoId = parseInt(req.params.torneoId);
  if (!torneoId) return res.status(400).json({ error: 'torneoId inválido' });

  const db = getDb();
  try {
    const comidas = db.prepare(`
      SELECT
        c.id,
        c.mes,
        c.anio,
        c.lugar,
        c.google_maps_url,
        c.fecha_comida,
        c.nota,
        c.estado,
        c.votacion_estado,
        c.organizador_user_id,
        u.nombre AS organizador_nombre,
        (SELECT COUNT(*) FROM comidas_fotos f WHERE f.comida_id = c.id)         AS fotos_count,
        (SELECT COUNT(*) FROM comidas_participantes p WHERE p.comida_id = c.id) AS participantes_count
      FROM comidas_mensuales c
      LEFT JOIN users u ON u.id = c.organizador_user_id
      WHERE c.torneo_id = ?
      ORDER BY c.anio DESC, c.mes DESC
    `).all(torneoId);

    return res.json(comidas);
  } catch (err) {
    console.error('[comidas lista GET]', err.message);
    return res.status(500).json({ error: 'Error interno', detail: err.message });
  }
});

/**
 * GET /api/comidas/:comidaId
 * Devuelve una comida por ID con datos completos.
 * Si el torneo está cerrado: incluye puntuacion_total e items con promedios.
 * Accesible para todos los usuarios autenticados.
 */
router.get('/:comidaId', authMiddleware, (req, res) => {
  const comidaId = parseInt(req.params.comidaId);
  if (!comidaId) return res.status(400).json({ error: 'comidaId inválido' });

  const db = getDb();
  try {
    const comida = db.prepare(`
      SELECT
        c.*,
        u.nombre     AS organizador_nombre,
        t.activo     AS torneo_activo,
        t.nombre     AS torneo_nombre,
        t.semestre   AS torneo_semestre,
        (SELECT COUNT(*) FROM comidas_fotos      f WHERE f.comida_id = c.id) AS fotos_count,
        (SELECT COUNT(*) FROM comidas_participantes p WHERE p.comida_id = c.id) AS participantes_count
      FROM comidas_mensuales c
      LEFT JOIN users   u ON u.id = c.organizador_user_id
      LEFT JOIN torneos t ON t.id = c.torneo_id
      WHERE c.id = ?
    `).get(comidaId);

    if (!comida) return res.status(404).json({ error: 'Comida no encontrada' });

    const torneoCerrado = !comida.torneo_activo;

    // Configuración de ítems
    const cfg = db.prepare(
      'SELECT items_json FROM comidas_votacion_config WHERE torneo_id = ?'
    ).get(comida.torneo_id);

    const DEFAULT_ITEMS = [
      { nombre: 'Comida', peso: 40 },
      { nombre: 'Precio/Calidad', peso: 30 },
      { nombre: 'Servicio', peso: 20 },
      { nombre: 'Ambiente', peso: 10 },
    ];
    let itemsConfig;
    try { itemsConfig = cfg ? JSON.parse(cfg.items_json) : DEFAULT_ITEMS; }
    catch (_) { itemsConfig = DEFAULT_ITEMS; }

    // Resultados: solo si torneo cerrado
    let puntuacion_total = null;
    let items = [];

    if (torneoCerrado) {
      const promediosRows = db.prepare(`
        SELECT item, AVG(puntaje) AS promedio
        FROM comidas_votos
        WHERE comida_id = ?
        GROUP BY item
      `).all(comidaId);

      const promedioMap = {};
      for (const r of promediosRows) promedioMap[r.item] = r.promedio;

      items = itemsConfig.map(ic => ({
        item:    ic.nombre,
        peso:    ic.peso,
        promedio: promedioMap[ic.nombre] != null
          ? Math.round(promedioMap[ic.nombre] * 10) / 10
          : null,
      }));

      const todosConVotos = items.every(i => i.promedio !== null);
      if (todosConVotos && items.length > 0) {
        let total = 0;
        for (const ic of itemsConfig) {
          total += (promedioMap[ic.nombre] || 0) * (ic.peso / 100);
        }
        puntuacion_total = Math.round(total * 10) / 10;
      }
    }

    return res.json({
      ...comida,
      torneo_activo:    !!comida.torneo_activo,
      items_config:     itemsConfig,
      puntuacion_total,
      items,
    });
  } catch (err) {
    console.error('[comidas byId GET]', err.message);
    return res.status(500).json({ error: 'Error interno', detail: err.message });
  }
});

module.exports = router;






