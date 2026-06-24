#!/usr/bin/env node
/**
 * cargar-matriz-r32-fifa.js
 *
 * Convierte el CSV oficial del Anexo C del reglamento FIFA Mundial 2026
 * a la estructura JS que usa el frontend en `frontend/src/data/mundial-r32-matriz.js`.
 *
 * Formato esperado del CSV (separador ","):
 *   combo,1A,1B,1D,1E,1G,1I,1K,1L
 *   A-B-C-D-E-F-G-H,3X,3X,3X,3X,3X,3X,3X,3X
 *   ...
 *
 * Columnas:
 *   - combo: 8 letras de grupo (los que clasificaron terceros) ordenadas asc
 *     y separadas por "-". Ejemplo: A-C-D-E-F-H-I-J
 *   - 1A...1L: el "3X" que enfrenta a ese 1° de grupo (rival asignado por FIFA).
 *
 * Importante:
 *   - El orden de las columnas en el CSV oficial FIFA es 1A, 1B, 1D, 1E, 1G,
 *     1I, 1K, 1L. Las 4 columnas faltantes (1C, 1F, 1H, 1J) corresponden a
 *     primeros que NO enfrentan terceros — están emparejados con 2°s.
 *   - El script mapea cada columna a su slot interno THIRD_SLOT_vs_1X.
 *   - Valida que cada fila tenga 9 campos y que cada 3X esté en la lista
 *     de candidatos permitidos del slot. Si algo no cumple, lista el error
 *     y NO escribe el archivo de salida.
 *
 * Uso:
 *   node backend/scripts/cargar-matriz-r32-fifa.js <input.csv> [<output.js>]
 *
 *   Por default output = ../frontend/src/data/mundial-r32-matriz.js
 *
 * Ejemplo:
 *   node backend/scripts/cargar-matriz-r32-fifa.js anexo-c-fifa-2026.csv
 */

const fs = require('node:fs')
const path = require('node:path')

// Mapeo columna CSV → slot interno
const COL_TO_SLOT = {
  '1A': 'THIRD_SLOT_vs_1A',
  '1B': 'THIRD_SLOT_vs_1B',
  '1D': 'THIRD_SLOT_vs_1D',
  '1E': 'THIRD_SLOT_vs_1E',
  '1G': 'THIRD_SLOT_vs_1G',
  '1I': 'THIRD_SLOT_vs_1I',
  '1K': 'THIRD_SLOT_vs_1K',
  '1L': 'THIRD_SLOT_vs_1L',
}

// Candidatos permitidos por slot (los 3X posibles según el fixture oficial).
// Mismo dato que THIRD_SLOTS_CANDIDATOS en MundialDatosUtiles.jsx.
const CANDIDATOS = {
  THIRD_SLOT_vs_1E: ['3A','3B','3C','3D','3F'],
  THIRD_SLOT_vs_1I: ['3C','3D','3F','3G','3H'],
  THIRD_SLOT_vs_1A: ['3C','3E','3F','3H','3I'],
  THIRD_SLOT_vs_1L: ['3E','3H','3I','3J','3K'],
  THIRD_SLOT_vs_1G: ['3A','3E','3H','3I','3J'],
  THIRD_SLOT_vs_1D: ['3B','3E','3F','3I','3J'],
  THIRD_SLOT_vs_1B: ['3E','3F','3G','3I','3J'],
  THIRD_SLOT_vs_1K: ['3D','3E','3I','3J','3L'],
}

function fail(msg) {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

function parseCSV(raw) {
  const lines = raw.split(/\r?\n/).filter(l => l.trim() !== '')
  if (lines.length < 2) fail('CSV vacío o sin filas de datos')
  const header = lines[0].split(',').map(s => s.trim())
  const expected = ['combo','1A','1B','1D','1E','1G','1I','1K','1L']
  const ok = expected.length === header.length &&
             expected.every((h, i) => h === header[i])
  if (!ok) fail(`Header inesperado.\n  Esperado: ${expected.join(',')}\n  Recibido: ${header.join(',')}`)
  const errores = []
  const matriz = {}
  for (let li = 1; li < lines.length; li++) {
    const cells = lines[li].split(',').map(s => s.trim())
    if (cells.length !== 9) {
      errores.push(`Línea ${li + 1}: esperaba 9 columnas, vino ${cells.length}`)
      continue
    }
    const [combo, ...vals] = cells
    // Validar combo: 8 letras A-L, todas distintas, ordenadas asc.
    const grupos = combo.split('-')
    if (grupos.length !== 8) {
      errores.push(`Línea ${li + 1}: combo "${combo}" no tiene 8 grupos`)
      continue
    }
    if (!grupos.every(g => /^[A-L]$/.test(g))) {
      errores.push(`Línea ${li + 1}: combo "${combo}" contiene letras inválidas`)
      continue
    }
    const sorted = [...grupos].sort()
    if (sorted.join('-') !== combo) {
      errores.push(`Línea ${li + 1}: combo "${combo}" no está ordenado alfabético (debería ser "${sorted.join('-')}")`)
      continue
    }
    if (new Set(grupos).size !== 8) {
      errores.push(`Línea ${li + 1}: combo "${combo}" tiene grupos duplicados`)
      continue
    }
    // Construir asignación validando candidatos.
    const asignacion = {}
    let filaOk = true
    for (let ci = 0; ci < 8; ci++) {
      const col = header[ci + 1]    // '1A', '1B', ...
      const slot = COL_TO_SLOT[col]
      const valor = vals[ci]
      if (!/^3[A-L]$/.test(valor)) {
        errores.push(`Línea ${li + 1}: columna ${col} valor "${valor}" no parece un 3X válido`)
        filaOk = false
        continue
      }
      if (!CANDIDATOS[slot].includes(valor)) {
        errores.push(`Línea ${li + 1}: columna ${col} = "${valor}" no es un candidato válido del slot ${slot}. Permitidos: ${CANDIDATOS[slot].join('/')}`)
        filaOk = false
        continue
      }
      // El 3X debe pertenecer a uno de los 8 grupos del combo.
      const grupoDelTercero = valor[1]
      if (!grupos.includes(grupoDelTercero)) {
        errores.push(`Línea ${li + 1}: columna ${col} = "${valor}" pero el grupo ${grupoDelTercero} NO está en el combo "${combo}"`)
        filaOk = false
        continue
      }
      asignacion[slot] = valor
    }
    if (filaOk) matriz[combo] = asignacion
  }
  return { matriz, errores }
}

function renderJS(matriz) {
  const entries = Object.entries(matriz)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, asg]) => {
      // Orden fijo de slots para que el JS generado sea estable.
      const slots = ['THIRD_SLOT_vs_1E','THIRD_SLOT_vs_1I','THIRD_SLOT_vs_1A','THIRD_SLOT_vs_1L','THIRD_SLOT_vs_1G','THIRD_SLOT_vs_1D','THIRD_SLOT_vs_1B','THIRD_SLOT_vs_1K']
      const inner = slots.map(s => `${s}:'${asg[s]}'`).join(', ')
      return `  '${key}': { ${inner} },`
    })
    .join('\n')
  return `/**
 * MATRIZ_TERCEROS — Mundial 2026, asignación oficial de los 8 mejores
 * terceros a sus cruces de Round of 32 (Anexo C reglamento FIFA).
 *
 * Generado por backend/scripts/cargar-matriz-r32-fifa.js — NO editar a mano.
 * Para regenerar: \`node backend/scripts/cargar-matriz-r32-fifa.js <csv>\`
 *
 * Entradas: ${Object.keys(matriz).length} / 495 combinaciones.
 */

const MATRIZ_TERCEROS = {
${entries}
}

export default MATRIZ_TERCEROS
`
}

function main() {
  const argv = process.argv.slice(2)
  if (argv.length < 1) fail('Uso: node cargar-matriz-r32-fifa.js <input.csv> [<output.js>]')
  const inputPath = path.resolve(argv[0])
  const outputDefault = path.resolve(__dirname, '../../frontend/src/data/mundial-r32-matriz.js')
  const outputPath = argv[1] ? path.resolve(argv[1]) : outputDefault
  if (!fs.existsSync(inputPath)) fail(`No existe: ${inputPath}`)
  const raw = fs.readFileSync(inputPath, 'utf8')
  const { matriz, errores } = parseCSV(raw)
  if (errores.length > 0) {
    console.error(`⚠️ ${errores.length} error(es) encontrados:`)
    for (const e of errores) console.error(`  - ${e}`)
    fail('No se escribió el archivo de salida. Corregí el CSV y volvé a correr.')
  }
  const js = renderJS(matriz)
  fs.writeFileSync(outputPath, js, 'utf8')
  console.log(`✓ ${Object.keys(matriz).length} entradas cargadas en ${outputPath}`)
}

main()
