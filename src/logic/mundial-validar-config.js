/**
 * Validador puro de `config_json` por `tipo_pregunta` — Fase 2.2.
 *
 * - Sin DB. Sin red. Testeable en aislamiento.
 * - Acepta `configRaw` como string JSON o como objeto ya parseado.
 * - Devuelve `{ ok: true, codigos_referenciados: [string] }` o
 *           `{ ok: false, error: string, campo?: string }`.
 * - `codigos_referenciados` es la lista de códigos de equipo (3+ chars MAYÚSCULAS)
 *   que aparecen en el config. La route los usa para hacer un cross-check contra
 *   `mundial_equipos_catalogo` y emitir warnings (Fase 2.2) o errores (Fase 2.4).
 *   El validador NO consulta DB; solo extrae los códigos.
 *
 * Tipos soportados (Fase 2.2):
 *   - opcion_unica
 *   - equipo_categoria
 *   - instancia_eliminacion
 *   - numero_exacto
 *   - numero_por_banda
 *   - multi_equipo
 *   - respuesta_manual
 *   - regla_especial   (escape hatch — solo valida `scoring_manual: true`)
 */

function asConfigObject(configRaw) {
  if (configRaw == null) {
    return { error: 'config_json es requerido (string JSON o objeto)' };
  }
  if (typeof configRaw === 'string') {
    try {
      const parsed = JSON.parse(configRaw);
      if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { error: 'config_json debe ser objeto JSON' };
      }
      return { config: parsed };
    } catch {
      return { error: 'config_json no es JSON parseable' };
    }
  }
  if (typeof configRaw === 'object' && !Array.isArray(configRaw)) {
    return { config: configRaw };
  }
  return { error: 'config_json debe ser objeto o string JSON' };
}

const failResult = (error, campo) => campo
  ? { ok: false, error, campo }
  : { ok: false, error };
const okResult = (codigos = []) => ({ ok: true, codigos_referenciados: codigos });

// ── Validadores por tipo ────────────────────────────────────────────────────

function validarOpcionUnica(c) {
  if (!Array.isArray(c.opciones) || c.opciones.length === 0) {
    return failResult('opcion_unica: `opciones` debe ser array no vacío', 'opciones');
  }
  if (!c.opciones.every(o => typeof o === 'string' && o.trim().length > 0)) {
    return failResult('opcion_unica: cada opción debe ser string no vacío', 'opciones');
  }
  const set = new Set(c.opciones.map(o => o.trim()));
  if (set.size !== c.opciones.length) {
    return failResult('opcion_unica: hay opciones duplicadas', 'opciones');
  }
  if (!Number.isInteger(c.pts) || c.pts < 0) {
    return failResult('opcion_unica: `pts` debe ser entero ≥ 0', 'pts');
  }
  return okResult();
}

function validarEquipoCategoria(c) {
  if (!Array.isArray(c.categorias) || c.categorias.length === 0) {
    return failResult('equipo_categoria: `categorias` debe ser array no vacío', 'categorias');
  }
  let defaultCount = 0;
  const codigosUsados = new Set();
  const codigosRef    = new Set();
  for (let i = 0; i < c.categorias.length; i++) {
    const cat = c.categorias[i];
    const path = `categorias[${i}]`;
    if (!cat || typeof cat !== 'object' || Array.isArray(cat)) {
      return failResult(`equipo_categoria: ${path} debe ser objeto`, path);
    }
    if (typeof cat.label !== 'string' || cat.label.trim().length === 0) {
      return failResult(`equipo_categoria: ${path} requiere \`label\` string no vacío`, `${path}.label`);
    }
    if (!Number.isInteger(cat.pts) || cat.pts < 0) {
      return failResult(`equipo_categoria: categoría '${cat.label}' \`pts\` debe ser entero ≥ 0`, `${path}.pts`);
    }
    if (cat.default === true) {
      if (cat.equipos !== undefined) {
        return failResult(`equipo_categoria: categoría '${cat.label}' con \`default: true\` no puede tener \`equipos\``, `${path}.equipos`);
      }
      defaultCount++;
    } else {
      if (!Array.isArray(cat.equipos) || cat.equipos.length === 0) {
        return failResult(`equipo_categoria: categoría '${cat.label}' requiere \`equipos\` array no vacío (o \`default: true\`)`, `${path}.equipos`);
      }
      for (const codigo of cat.equipos) {
        if (typeof codigo !== 'string' || codigo.trim().length === 0) {
          return failResult(`equipo_categoria: categoría '${cat.label}': los códigos deben ser strings no vacíos`, `${path}.equipos`);
        }
        const upper = codigo.toUpperCase().trim();
        if (codigosUsados.has(upper)) {
          return failResult(`equipo_categoria: código '${upper}' aparece en más de una categoría`, `${path}.equipos`);
        }
        codigosUsados.add(upper);
        codigosRef.add(upper);
      }
    }
  }
  if (defaultCount !== 1) {
    return failResult(`equipo_categoria: debe haber exactamente 1 categoría con \`default: true\` (encontradas: ${defaultCount})`);
  }
  return okResult([...codigosRef]);
}

function validarInstanciaEliminacion(c) {
  if (typeof c.equipo !== 'string' || c.equipo.trim().length === 0) {
    return failResult('instancia_eliminacion: `equipo` (código) requerido', 'equipo');
  }
  if (!Array.isArray(c.instancias) || c.instancias.length === 0) {
    return failResult('instancia_eliminacion: `instancias` array no vacío requerido', 'instancias');
  }
  if (!c.instancias.every(i => typeof i === 'string' && i.trim().length > 0)) {
    return failResult('instancia_eliminacion: cada instancia debe ser string no vacío', 'instancias');
  }
  const setIns = new Set(c.instancias);
  if (setIns.size !== c.instancias.length) {
    return failResult('instancia_eliminacion: instancias duplicadas', 'instancias');
  }
  if (!c.pts_por_instancia || typeof c.pts_por_instancia !== 'object' || Array.isArray(c.pts_por_instancia)) {
    return failResult('instancia_eliminacion: `pts_por_instancia` objeto requerido', 'pts_por_instancia');
  }
  const keys = Object.keys(c.pts_por_instancia);
  if (keys.length !== c.instancias.length || !c.instancias.every(i => i in c.pts_por_instancia)) {
    return failResult('instancia_eliminacion: `pts_por_instancia` debe tener exactamente las mismas keys que `instancias`', 'pts_por_instancia');
  }
  for (const k of keys) {
    const v = c.pts_por_instancia[k];
    if (!Number.isInteger(v) || v < 0) {
      return failResult(`instancia_eliminacion: pts_por_instancia['${k}'] debe ser entero ≥ 0`, `pts_por_instancia.${k}`);
    }
  }
  return okResult([c.equipo.toUpperCase().trim()]);
}

function validarNumeroExacto(c) {
  if (!Number.isInteger(c.pts_si_acierta) || c.pts_si_acierta < 0) {
    return failResult('numero_exacto: `pts_si_acierta` entero ≥ 0 requerido', 'pts_si_acierta');
  }
  if (c.pts_si_no_acierta !== undefined && (!Number.isInteger(c.pts_si_no_acierta) || c.pts_si_no_acierta < 0)) {
    return failResult('numero_exacto: `pts_si_no_acierta` debe ser entero ≥ 0 (default 0)', 'pts_si_no_acierta');
  }
  return okResult();
}

function validarNumeroPorBanda(c) {
  if (!Array.isArray(c.bandas) || c.bandas.length === 0) {
    return failResult('numero_por_banda: `bandas` array no vacío requerido', 'bandas');
  }
  // Validar shape de cada banda
  for (let i = 0; i < c.bandas.length; i++) {
    const b = c.bandas[i];
    const path = `bandas[${i}]`;
    if (!b || typeof b !== 'object' || Array.isArray(b)) {
      return failResult(`numero_por_banda: ${path} debe ser objeto`, path);
    }
    if (!Number.isInteger(b.min)) {
      return failResult(`numero_por_banda: ${path} requiere \`min\` entero`, `${path}.min`);
    }
    if (b.max !== undefined && (!Number.isInteger(b.max) || b.max < b.min)) {
      return failResult(`numero_por_banda: ${path} \`max\` debe ser entero ≥ min`, `${path}.max`);
    }
    if (!Number.isInteger(b.pts) || b.pts < 0) {
      return failResult(`numero_por_banda: ${path} \`pts\` debe ser entero ≥ 0`, `${path}.pts`);
    }
  }
  // Validar cobertura continua: ni solapamientos ni huecos.
  // Bandas adyacentes son OK ([0..2] + [3..5]); huecos no ([0..2] + [5..]).
  // Si una banda tiene max=Infinity (abierta superior), no puede haber otra banda
  // después suyo (su rango ya cubre hasta el infinito; cualquier siguiente solaparía).
  const ordenadas = c.bandas
    .map((b, i) => ({ min: b.min, max: b.max ?? Infinity, _i: i }))
    .sort((a, b) => a.min - b.min);
  for (let i = 1; i < ordenadas.length; i++) {
    const prev = ordenadas[i - 1];
    const cur  = ordenadas[i];
    if (cur.min <= prev.max) {
      return failResult(`numero_por_banda: bandas se solapan entre la fila ${prev._i} y la ${cur._i}`);
    }
    if (cur.min !== prev.max + 1) {
      return failResult(
        `numero_por_banda: hueco entre la banda ${prev._i} (max=${prev.max}) y la ${cur._i} (min=${cur.min}). Las bandas deben cubrir un rango continuo (adyacentes sin gaps).`
      );
    }
  }
  return okResult();
}

function validarMultiEquipo(c) {
  if (!Number.isInteger(c.n_equipos) || c.n_equipos < 1) {
    return failResult('multi_equipo: `n_equipos` entero ≥ 1 requerido', 'n_equipos');
  }
  if (!Number.isInteger(c.pts_por_acierto) || c.pts_por_acierto < 0) {
    return failResult('multi_equipo: `pts_por_acierto` entero ≥ 0 requerido', 'pts_por_acierto');
  }
  if (c.penalizar_falso_positivo !== undefined && typeof c.penalizar_falso_positivo !== 'boolean') {
    return failResult('multi_equipo: `penalizar_falso_positivo` debe ser boolean (default false)', 'penalizar_falso_positivo');
  }
  return okResult();
}

function validarRespuestaManual(c) {
  if (!Number.isInteger(c.pts_max) || c.pts_max < 0) {
    return failResult('respuesta_manual: `pts_max` entero ≥ 0 requerido', 'pts_max');
  }
  if (c.instrucciones !== undefined && typeof c.instrucciones !== 'string') {
    return failResult('respuesta_manual: `instrucciones` debe ser string (opcional)', 'instrucciones');
  }
  return okResult();
}

function validarReglaEspecial(c) {
  // Escape hatch — exigimos la flag de scoring manual + una descripción humana
  // obligatoria que documente la regla. El resto del objeto puede ser libre.
  if (c.scoring_manual !== true) {
    return failResult('regla_especial: debe tener `scoring_manual: true` para activar scoring manual', 'scoring_manual');
  }
  if (typeof c.descripcion !== 'string' || c.descripcion.trim().length === 0) {
    return failResult('regla_especial: `descripcion` string no vacío requerido (documentación humana de la regla)', 'descripcion');
  }
  return okResult();
}

// ── Tabla de tipos soportados ───────────────────────────────────────────────

const VALIDADORES = {
  opcion_unica:          validarOpcionUnica,
  equipo_categoria:      validarEquipoCategoria,
  instancia_eliminacion: validarInstanciaEliminacion,
  numero_exacto:         validarNumeroExacto,
  numero_por_banda:      validarNumeroPorBanda,
  multi_equipo:          validarMultiEquipo,
  respuesta_manual:      validarRespuestaManual,
  regla_especial:        validarReglaEspecial,
};

const TIPOS_PREGUNTA = Object.freeze(Object.keys(VALIDADORES));

/**
 * Entrada principal del validador.
 *
 * @param {string} tipoPregunta — uno de TIPOS_PREGUNTA
 * @param {string|object} configRaw — string JSON o objeto ya parseado
 * @returns {{ ok: true, codigos_referenciados: string[] } | { ok: false, error: string, campo?: string }}
 */
function validarConfigJson(tipoPregunta, configRaw) {
  if (typeof tipoPregunta !== 'string' || !VALIDADORES[tipoPregunta]) {
    return failResult(
      `tipo_pregunta desconocido: '${tipoPregunta}'. Valores válidos: ${TIPOS_PREGUNTA.join(', ')}`,
      'tipo_pregunta'
    );
  }
  const { config, error } = asConfigObject(configRaw);
  if (error) return failResult(error, 'config_json');
  return VALIDADORES[tipoPregunta](config);
}

module.exports = {
  validarConfigJson,
  TIPOS_PREGUNTA,
};
