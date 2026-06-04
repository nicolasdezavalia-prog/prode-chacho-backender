/**
 * mundial-validar-cambio.js — Fase 5
 *
 * Validación de items que llegan en `PUT /api/mundial/:torneoId/mis-cambios`.
 * Es un wrapper finito alrededor de `mundial-validar-respuesta.js` (mismo
 * shape de respuesta_json) + checks adicionales:
 *
 *   1. La pregunta existe y pertenece al torneo.
 *   2. La pregunta está activa.
 *   3. La pregunta tiene cambio_habilitado = 1.
 *   4. El shape de respuesta_json es válido para el tipo (validarRespuesta).
 *   5. (cross-check de equipos contra catálogo lo hace el route handler, idem patrón
 *      de PUT /mis-respuestas, para reusar el mismo helper cumpleRestriccion).
 *
 * NO valida cupo (cambios_por_usuario), eso depende de cuántos cambios ya
 * cargó el user en la ventana — lo hace el handler con SELECT COUNT.
 * NO valida ventana abierta — lo hace el handler.
 *
 * Las funciones son puras: reciben (pregunta, respuestaJson) y devuelven
 * { ok, error?, codigos_referenciados? }.
 */

const { validarRespuesta } = require('./mundial-validar-respuesta');

/**
 * Valida UN item de cambio: { pregunta_id, respuesta_json }.
 *
 * @param {object} item                   — { pregunta_id, respuesta_json }
 * @param {object} pregunta               — fila de mundial_preguntas (incluye cambio_habilitado)
 * @returns {{ ok: true, codigos_referenciados?: string[] } | { ok: false, error: string, campo?: string }}
 */
function validarItemCambio(item, pregunta) {
  if (!item || typeof item !== 'object') {
    return { ok: false, error: 'cada item de cambio debe ser un objeto' };
  }
  if (!Number.isInteger(item.pregunta_id) || item.pregunta_id <= 0) {
    return { ok: false, error: '`pregunta_id` entero > 0 requerido', campo: 'pregunta_id' };
  }
  if (!pregunta) {
    return { ok: false, error: `pregunta_id ${item.pregunta_id} no encontrada en este torneo` };
  }
  if (!pregunta.activa) {
    return { ok: false, error: `pregunta ${pregunta.numero} está inactiva` };
  }
  if (pregunta.cambio_habilitado !== 1) {
    return {
      ok: false,
      error: `pregunta ${pregunta.numero} no es elegible para cambio (cambio_habilitado=0)`,
      campo: 'pregunta_id',
    };
  }
  if (!item.respuesta_json || typeof item.respuesta_json !== 'object' || Array.isArray(item.respuesta_json)) {
    return { ok: false, error: 'respuesta_json debe ser objeto', campo: 'respuesta_json' };
  }

  // Parsear config_json de la pregunta para pasar al validador.
  let configJson = {};
  try { configJson = JSON.parse(pregunta.config_json) || {}; }
  catch { /* config malformado: el validador devolverá lo correcto */ }

  // Reutilizamos el validador de respuesta — misma semántica que la carga inicial.
  const v = validarRespuesta(pregunta.tipo_pregunta, configJson, item.respuesta_json);
  if (!v.ok) return v;
  return { ok: true, codigos_referenciados: v.codigos_referenciados || [] };
}

module.exports = { validarItemCambio };
