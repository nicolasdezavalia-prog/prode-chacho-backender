/**
 * mundial-pusieron.js — Fase B (lo pusieron / dashboard cross con respuestas)
 *
 * Cruza items del dashboard de Datos útiles con las respuestas de los users
 * para mostrar "lo pusieron: NEGRO, TEO". El cruce vive en backend para no
 * duplicar la lógica de match en frontend.
 *
 * MAPPING hardcoded sección → pregunta del torneo Mundial:
 *   goleadores_item  → numero = 5  (¿Quién será el goleador del Mundial?)
 *   top_amarillas    → numero = 35 (¿Equipo con más amarillas?)
 *   top_rojas        → numero = 36 (¿Equipo con más rojas?)
 *
 * El torneo Mundial 2026 es único e irrepetible (decisión 2026-06-04).
 * Si en algún torneo futuro reciclamos esta lógica con otros números, hay
 * que mover el MAPPING a `mundial_config` (columnas pregunta_id_*) y leerlas
 * desde DB. Para Mundial 2026 alcanza con esto.
 *
 * Si la pregunta no existe en el torneo (todavía no fue creada / fue
 * eliminada), `loadContexto` devuelve null y `loPusieron*` devuelve [].
 * Cero errores en runtime, sin acoplar el dashboard a la disponibilidad
 * de preguntas.
 *
 * SIN gate temporal: el usuario explicitó que se muestra siempre, juego
 * ya está abierto, ningún tipo de "ocultar antes del cierre".
 */

const { normalizarTexto } = require('./mundial-scoring');

const MAPPING = {
  goleadores_item: { numero: 5  },  // items manuales tipo 'goleadores'
  top_amarillas:   { numero: 35 },  // top calculado de la matriz Fase 2
  top_rojas:       { numero: 36 },
};

function safeParse(s) {
  if (!s) return null;
  if (typeof s === 'object') return s;
  try { return JSON.parse(s) || null; } catch { return null; }
}

// Match para items de texto (goleadores). Compara texto normalizado:
// lowercase + sin tildes + trim (mismo helper que scoring).
// Solo aplica si la pregunta es de tipo `respuesta_manual` o `regla_especial`.
// Strings vacíos no matchean (evita falsos positivos masivos).
function matchTexto(textoBuscado, tipoPregunta, respuestaJson) {
  if (tipoPregunta !== 'respuesta_manual' && tipoPregunta !== 'regla_especial') return false;
  const r = safeParse(respuestaJson);
  if (!r || typeof r.texto !== 'string') return false;
  const a = normalizarTexto(textoBuscado || '');
  const b = normalizarTexto(r.texto);
  return a !== '' && a === b;
}

// Match para items de equipo (top amarillas/rojas). Acepta tipos:
//   - equipo_categoria: respuesta tiene { equipo: 'ARG' }.
//   - multi_equipo:     respuesta tiene { equipos: ['ARG','BRA',...] }.
// Cualquier otro tipo devuelve false (defensivo — el mapping podría
// apuntar a una pregunta de tipo inesperado por error humano).
function matchEquipo(equipoCodigo, tipoPregunta, respuestaJson) {
  if (!equipoCodigo) return false;
  const r = safeParse(respuestaJson);
  if (!r) return false;
  switch (tipoPregunta) {
    case 'equipo_categoria': return r.equipo === equipoCodigo;
    case 'multi_equipo':     return Array.isArray(r.equipos) && r.equipos.includes(equipoCodigo);
    default: return false;
  }
}

// Carga UNA vez la pregunta del MAPPING + todas sus respuestas con
// nombre del user. El endpoint la reusa para todos los items de su
// sección. Devuelve null si:
//   - la sección no está en MAPPING;
//   - la pregunta no existe en el torneo (todavía no creada o fue borrada).
function loadContexto(db, torneoId, seccionKey) {
  const cfg = MAPPING[seccionKey];
  if (!cfg) return null;
  const pregunta = db.prepare(`
    SELECT id, tipo_pregunta
    FROM mundial_preguntas
    WHERE torneo_id = ? AND numero = ?
  `).get(torneoId, cfg.numero);
  if (!pregunta) return null;
  const respuestas = db.prepare(`
    SELECT ru.user_id, u.nombre, ru.respuesta_json
    FROM mundial_respuestas_usuario ru
    JOIN users u ON u.id = ru.user_id
    WHERE ru.pregunta_id = ?
    ORDER BY u.nombre COLLATE NOCASE ASC
  `).all(pregunta.id);
  return { pregunta, respuestas };
}

// Lo pusieron para un item de goleador. Prueba MATCH contra:
//   1. item.jugador  (preferido si está cargado)
//   2. item.titulo   (fallback)
// Si cualquiera de los dos matchea, el user se considera puesto.
// Esto absorbe variaciones del admin (ej. "Messi" en titulo y
// "L. Messi" en jugador) — basta con que el user haya escrito alguno.
function loPusieronGoleador(ctx, item) {
  if (!ctx) return [];
  const candidatos = [];
  if (typeof item?.jugador === 'string' && item.jugador.trim() !== '') candidatos.push(item.jugador);
  if (typeof item?.titulo  === 'string' && item.titulo.trim()  !== '') candidatos.push(item.titulo);
  if (candidatos.length === 0) return [];
  const out = [];
  for (const r of ctx.respuestas) {
    const hit = candidatos.some(c => matchTexto(c, ctx.pregunta.tipo_pregunta, r.respuesta_json));
    if (hit) out.push({ user_id: r.user_id, nombre: r.nombre });
  }
  return out;
}

// Lo pusieron para un equipo del top (amarillas o rojas).
// Solo necesita el codigo del equipo + el contexto correspondiente.
function loPusieronEquipo(ctx, equipoCodigo) {
  if (!ctx || !equipoCodigo) return [];
  const out = [];
  for (const r of ctx.respuestas) {
    if (matchEquipo(equipoCodigo, ctx.pregunta.tipo_pregunta, r.respuesta_json)) {
      out.push({ user_id: r.user_id, nombre: r.nombre });
    }
  }
  return out;
}

module.exports = {
  MAPPING,
  matchTexto,
  matchEquipo,
  loadContexto,
  loPusieronGoleador,
  loPusieronEquipo,
};
