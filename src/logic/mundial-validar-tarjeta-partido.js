/**
 * mundial-validar-tarjeta-partido.js — Datos útiles Fase 2 (Tarjetas)
 *
 * Validador puro para PUT bulk de `mundial_tarjetas_partido`. No toca DB:
 * recibe los códigos válidos del catálogo por argumento.
 *
 * Reglas por celda:
 *   - equipo_codigo string no vacío, debe existir en el catálogo del torneo.
 *   - partido_num entero >= 1.
 *   - amarillas entero >= 0 (default 0 si viene undefined).
 *   - rojas     entero >= 0 (default 0 si viene undefined).
 *   - observacion opcional, string o null.
 *
 * Reglas a nivel bulk:
 *   - body.celdas debe ser array.
 *   - No duplicar (equipo_codigo, partido_num) dentro del mismo body.
 *
 * API:
 *   validarTarjetasBulk(body, { equiposCodigos: Set<string> })
 *     → { ok: true, celdas: [<normalizadas>] }
 *     → { ok: false, error, campo?, index? }
 *
 * `index` se incluye cuando el error es de una celda específica del array
 * para que el caller pueda apuntar al ítem culpable en el body.
 */

const fail = (error, extra = {}) => ({ ok: false, error, ...extra });

function asStringNoVacio(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

function validarTarjetasBulk(body, ctx = {}) {
  const equiposCodigos = ctx.equiposCodigos instanceof Set ? ctx.equiposCodigos : new Set();

  if (!body || typeof body !== 'object') return fail('Body requerido');
  const celdas = body.celdas;
  if (!Array.isArray(celdas)) return fail('Se espera body.celdas: array', { campo: 'celdas' });

  const vistas = new Set(); // (equipo_codigo|partido_num)
  const out = [];
  for (let i = 0; i < celdas.length; i++) {
    const c = celdas[i];
    if (!c || typeof c !== 'object') {
      return fail('Cada celda debe ser un objeto', { index: i });
    }

    // equipo_codigo
    const eq = asStringNoVacio(c.equipo_codigo);
    if (!eq) return fail('equipo_codigo requerido (string no vacío)', { campo: 'equipo_codigo', index: i });
    if (equiposCodigos.size > 0 && !equiposCodigos.has(eq)) {
      return fail(`equipo_codigo '${eq}' no existe en el catálogo del torneo`, { campo: 'equipo_codigo', index: i });
    }

    // partido_num
    if (!Number.isInteger(c.partido_num) || c.partido_num < 1) {
      return fail('partido_num debe ser entero >= 1', { campo: 'partido_num', index: i });
    }
    const partido_num = c.partido_num;

    // amarillas / rojas — undefined → 0; integer >= 0 obligatorio
    const norm = (v, nombre) => {
      if (v === undefined || v === null) return 0;
      if (!Number.isInteger(v) || v < 0) {
        return { _err: `${nombre} debe ser entero >= 0` };
      }
      return v;
    };
    const amarillas = norm(c.amarillas, 'amarillas');
    if (typeof amarillas === 'object') return fail(amarillas._err, { campo: 'amarillas', index: i });
    const rojas = norm(c.rojas, 'rojas');
    if (typeof rojas === 'object') return fail(rojas._err, { campo: 'rojas', index: i });

    // observacion — opcional, string o null
    let observacion = null;
    if (c.observacion !== undefined && c.observacion !== null && c.observacion !== '') {
      if (typeof c.observacion !== 'string') {
        return fail('observacion debe ser string o null', { campo: 'observacion', index: i });
      }
      const o = c.observacion.trim();
      observacion = o === '' ? null : o;
    }

    // Duplicado dentro del body
    const key = `${eq}|${partido_num}`;
    if (vistas.has(key)) {
      return fail(`Celda duplicada en el body: equipo=${eq}, partido=${partido_num}`, { index: i });
    }
    vistas.add(key);

    out.push({ equipo_codigo: eq, partido_num, amarillas, rojas, observacion });
  }

  return { ok: true, celdas: out };
}

module.exports = { validarTarjetasBulk };
