/**
 * mundial-validar-goleador.js — Sprint Final C5.
 *
 * Validador puro del shape de goleadores (mundial_goleadores). Sin DB:
 * la pertenencia de equipo_codigo al catálogo la cross-checkea el endpoint.
 *
 * Semántica del bulk: UPSERT por (jugador, equipo_codigo) — no borra filas;
 * las bajas van por DELETE /goleadores/:id. El admin mantiene el TOP de
 * goleadores (10-20 filas), no todos los goles del torneo.
 */

function validarGoleador(g) {
  if (!g || typeof g !== 'object' || Array.isArray(g)) {
    return { ok: false, error: 'Cada goleador debe ser un objeto' };
  }
  if (typeof g.jugador !== 'string' || !g.jugador.trim()) {
    return { ok: false, error: 'Falta `jugador` (string no vacío)' };
  }
  if (g.jugador.trim().length > 100) {
    return { ok: false, error: '`jugador` admite hasta 100 caracteres' };
  }
  if (typeof g.equipo_codigo !== 'string' || !g.equipo_codigo.trim()) {
    return { ok: false, error: `Falta \`equipo_codigo\` para "${g.jugador}"` };
  }
  if (!Number.isInteger(g.goles) || g.goles < 0) {
    return { ok: false, error: `\`goles\` debe ser entero >= 0 ("${g.jugador}")` };
  }
  let activo = 1;
  if (g.activo !== undefined && g.activo !== null) {
    if (g.activo === true || g.activo === 1) activo = 1;
    else if (g.activo === false || g.activo === 0) activo = 0;
    else return { ok: false, error: `\`activo\` debe ser boolean/0/1 ("${g.jugador}")` };
  }
  let orden_display = 0;
  if (g.orden_display !== undefined && g.orden_display !== null && g.orden_display !== '') {
    if (!Number.isInteger(g.orden_display) || g.orden_display < 0) {
      return { ok: false, error: `\`orden_display\` debe ser entero >= 0 ("${g.jugador}")` };
    }
    orden_display = g.orden_display;
  }
  let notas = null;
  if (g.notas !== undefined && g.notas !== null && g.notas !== '') {
    if (typeof g.notas !== 'string' || g.notas.length > 500) {
      return { ok: false, error: `\`notas\` debe ser string de hasta 500 caracteres ("${g.jugador}")` };
    }
    notas = g.notas;
  }
  return {
    ok: true,
    valor: {
      jugador: g.jugador.trim(),
      equipo_codigo: g.equipo_codigo.trim(),
      goles: g.goles,
      activo,
      orden_display,
      notas,
    },
    codigos_referenciados: [g.equipo_codigo.trim()],
  };
}

function validarGoleadoresBulk(body) {
  const { goleadores } = body || {};
  if (!Array.isArray(goleadores) || goleadores.length === 0) {
    return { ok: false, error: 'Se espera body.goleadores: array no vacío' };
  }
  if (goleadores.length > 100) {
    return { ok: false, error: 'Máximo 100 goleadores por bulk' };
  }
  const claves = new Set();
  const out = [];
  const codigos = new Set();
  for (let i = 0; i < goleadores.length; i++) {
    const v = validarGoleador(goleadores[i]);
    if (!v.ok) return { ok: false, error: v.error, index: i };
    const clave = `${v.valor.jugador.toLowerCase()}|${v.valor.equipo_codigo}`;
    if (claves.has(clave)) {
      return { ok: false, error: `Goleador duplicado en el payload: ${v.valor.jugador} (${v.valor.equipo_codigo})`, index: i };
    }
    claves.add(clave);
    out.push(v.valor);
    for (const c of v.codigos_referenciados) codigos.add(c);
  }
  return { ok: true, goleadores: out, codigos_referenciados: [...codigos] };
}

module.exports = { validarGoleador, validarGoleadoresBulk };
