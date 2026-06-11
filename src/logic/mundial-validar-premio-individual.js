/**
 * mundial-validar-premio-individual.js — Sprint Final C6.
 *
 * Validador puro de premios individuales (mundial_premios_individuales).
 * Sin DB: equipo_codigo y pregunta_id los cross-checkea el endpoint.
 *
 * Semántica del bulk: UPSERT por `premio` (UNIQUE(torneo_id, premio) en el
 * schema C1 — un premio de cada tipo por torneo, incluido 'otro').
 * `jugador` es opcional: NULL hasta que el premio se otorgue.
 */

const PREMIOS_VALIDOS = ['balon_oro', 'guante_oro', 'bota_oro', 'fair_play', 'mejor_joven', 'otro'];

function validarPremioIndividual(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    return { ok: false, error: 'Cada premio debe ser un objeto' };
  }
  if (typeof p.premio !== 'string' || !PREMIOS_VALIDOS.includes(p.premio)) {
    return { ok: false, error: `\`premio\` inválido ("${p.premio}"). Válidos: ${PREMIOS_VALIDOS.join(', ')}` };
  }
  if (typeof p.titulo !== 'string' || !p.titulo.trim()) {
    return { ok: false, error: `Falta \`titulo\` para el premio ${p.premio}` };
  }
  if (p.titulo.trim().length > 100) {
    return { ok: false, error: `\`titulo\` admite hasta 100 caracteres (${p.premio})` };
  }
  let jugador = null;
  if (p.jugador !== undefined && p.jugador !== null && p.jugador !== '') {
    if (typeof p.jugador !== 'string' || p.jugador.trim().length > 100) {
      return { ok: false, error: `\`jugador\` debe ser string de hasta 100 caracteres (${p.premio})` };
    }
    jugador = p.jugador.trim();
  }
  let equipo_codigo = null;
  if (p.equipo_codigo !== undefined && p.equipo_codigo !== null && p.equipo_codigo !== '') {
    if (typeof p.equipo_codigo !== 'string') {
      return { ok: false, error: `\`equipo_codigo\` debe ser string (${p.premio})` };
    }
    equipo_codigo = p.equipo_codigo.trim();
  }
  let pregunta_id = null;
  if (p.pregunta_id !== undefined && p.pregunta_id !== null && p.pregunta_id !== '') {
    if (!Number.isInteger(p.pregunta_id) || p.pregunta_id <= 0) {
      return { ok: false, error: `\`pregunta_id\` debe ser entero positivo (${p.premio})` };
    }
    pregunta_id = p.pregunta_id;
  }
  let notas = null;
  if (p.notas !== undefined && p.notas !== null && p.notas !== '') {
    if (typeof p.notas !== 'string' || p.notas.length > 500) {
      return { ok: false, error: `\`notas\` debe ser string de hasta 500 caracteres (${p.premio})` };
    }
    notas = p.notas;
  }
  return {
    ok: true,
    valor: { premio: p.premio, titulo: p.titulo.trim(), jugador, equipo_codigo, pregunta_id, notas },
    codigos_referenciados: equipo_codigo ? [equipo_codigo] : [],
  };
}

function validarPremiosIndividualesBulk(body) {
  const { premios } = body || {};
  if (!Array.isArray(premios) || premios.length === 0) {
    return { ok: false, error: 'Se espera body.premios: array no vacío' };
  }
  if (premios.length > 20) {
    return { ok: false, error: 'Máximo 20 premios por bulk' };
  }
  const vistos = new Set();
  const out = [];
  const codigos = new Set();
  const preguntaIds = new Set();
  for (let i = 0; i < premios.length; i++) {
    const v = validarPremioIndividual(premios[i]);
    if (!v.ok) return { ok: false, error: v.error, index: i };
    if (vistos.has(v.valor.premio)) {
      return { ok: false, error: `Premio duplicado en el payload: ${v.valor.premio}`, index: i };
    }
    vistos.add(v.valor.premio);
    out.push(v.valor);
    for (const c of v.codigos_referenciados) codigos.add(c);
    if (v.valor.pregunta_id) preguntaIds.add(v.valor.pregunta_id);
  }
  return {
    ok: true,
    premios: out,
    codigos_referenciados: [...codigos],
    pregunta_ids_referenciados: [...preguntaIds],
  };
}

module.exports = { validarPremioIndividual, validarPremiosIndividualesBulk, PREMIOS_VALIDOS };
