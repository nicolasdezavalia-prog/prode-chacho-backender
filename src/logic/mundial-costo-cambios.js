/**
 * mundial-costo-cambios.js — Sprint costo por equipo (2026-06-25)
 *
 * Calcula el COSTO EN CUPOS de un cambio. Para multi_equipo, el costo es la
 * cantidad de equipos NUEVOS en la respuesta nueva que no estaban en la
 * anterior. Para el resto, costo = 1 si difiere, 0 si idéntica.
 *
 * Aplica para P32, P33, P34 (multi_equipo) del Mundial 2026:
 *   - tenia [A,B,C,D] → ahora [A,B,C,E]  → costo 1 (E es nuevo)
 *   - tenia [A,B,C,D] → ahora [E,F,G,H]  → costo 4 (todos nuevos)
 *   - tenia [A,B,C,D] → ahora [A,B,C,D]  → costo 0 (idéntica)
 *
 * El "anterior" se mide contra mundial_respuestas_usuario (la respuesta
 * vigente al abrir la ventana). Si el user pone un cambio y después vuelve
 * atrás, el costo NO se devuelve — paga cupos como cualquier otro cambio.
 *
 * Función pura, determinística, testeable. No toca DB.
 */

function safeParse(s) {
  if (s == null) return {};
  if (typeof s === 'object') return s;
  try { return JSON.parse(s) || {}; } catch { return {}; }
}

/** Devuelve true si las 2 respuestas son materialmente iguales. */
function respuestasIguales(tipo, anterior, nueva) {
  if (tipo === 'multi_equipo') {
    const a = Array.isArray(anterior?.equipos) ? [...anterior.equipos].sort() : [];
    const n = Array.isArray(nueva?.equipos)    ? [...nueva.equipos].sort()    : [];
    if (a.length !== n.length) return false;
    return a.every((v, i) => v === n[i]);
  }
  // Para los demás tipos: comparación por JSON ordenado (stable stringify simple).
  return JSON.stringify(anterior || {}) === JSON.stringify(nueva || {});
}

/**
 * Devuelve el costo en cupos del cambio. Entero >= 0.
 *
 * @param tipo  string tipo_pregunta.
 * @param respuestaAnterior  objeto o string JSON.
 * @param respuestaNueva     objeto o string JSON.
 * @returns number costo en cupos.
 */
function costoCambioEnCupos(tipo, respuestaAnterior, respuestaNueva) {
  const ant = safeParse(respuestaAnterior);
  const nue = safeParse(respuestaNueva);

  if (tipo === 'multi_equipo') {
    const anteriores = new Set(Array.isArray(ant.equipos) ? ant.equipos : []);
    const nuevos     = Array.isArray(nue.equipos) ? nue.equipos : [];
    // Cantidad de equipos NUEVOS que NO estaban en los anteriores.
    let costo = 0;
    for (const e of nuevos) if (!anteriores.has(e)) costo++;
    return costo;
  }

  // Resto: 1 si difiere, 0 si idéntica.
  return respuestasIguales(tipo, ant, nue) ? 0 : 1;
}

module.exports = { costoCambioEnCupos, respuestasIguales };
