/**
 * import_fechas_resumidas.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Script de bootstrap para cargar fechas históricas resumidas (ej: fechas 1-11)
 * y la fecha 12 (abierta/simplificada) sin necesidad de cargar los 30 eventos.
 *
 * USO:
 *   node import_fechas_resumidas.js --file fechas_historicas.json [--dry-run]
 *
 * FORMATO DEL JSON:
 * {
 *   "torneo_id": 1,
 *   "fechas": [
 *     {
 *       "nombre": "Fecha 1",
 *       "numero": 1,
 *       "mes": 1,
 *       "anio": 2025,
 *       "estado": "cerrada",
 *       "bloque1_nombre": "Liga Argentina",
 *       "bloque2_nombre": "Juanmar",
 *       "cruces": [
 *         {
 *           "user1_nombre": "BIMBO",
 *           "user2_nombre": "GERMAN",
 *           "bloque_a": "user1",
 *           "bloque_b": "empate",
 *           "gdt": "user2"
 *         }
 *       ]
 *     }
 *   ]
 * }
 *
 * Valores válidos para bloque_a, bloque_b, gdt: "user1" | "user2" | "empate"
 * ─────────────────────────────────────────────────────────────────────────────
 */

const path = require('path');
const fs   = require('fs');

// Setear DB_PATH antes de importar db.js
process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, 'prode.db');

const { getDb } = require('./src/db');
const { calcularCruceResumido, recalcularTablaGeneral } = require('./src/logic/puntos');

// ─── Argumentos ──────────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const fileIdx = args.indexOf('--file');
const dryRun  = args.includes('--dry-run');

if (fileIdx === -1 || !args[fileIdx + 1]) {
  console.error('❌  Uso: node import_fechas_resumidas.js --file <ruta.json> [--dry-run]');
  process.exit(1);
}

const filePath = path.resolve(args[fileIdx + 1]);
if (!fs.existsSync(filePath)) {
  console.error(`❌  Archivo no encontrado: ${filePath}`);
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

if (!data.torneo_id || !Array.isArray(data.fechas)) {
  console.error('❌  El JSON debe tener { torneo_id, fechas: [...] }');
  process.exit(1);
}

// ─── Validaciones ────────────────────────────────────────────────────────────
const VALIDOS = ['user1', 'user2', 'empate'];

function validar(payload) {
  const errores = [];
  for (const [i, fecha] of payload.fechas.entries()) {
    if (!fecha.nombre || !fecha.numero || !fecha.mes || !fecha.anio) {
      errores.push(`Fecha[${i}]: faltan campos obligatorios (nombre, numero, mes, anio)`);
    }
    if (!Array.isArray(fecha.cruces) || fecha.cruces.length === 0) {
      errores.push(`Fecha[${i}] "${fecha.nombre}": sin cruces`);
      continue;
    }
    for (const [j, c] of fecha.cruces.entries()) {
      if (!c.user1_nombre || !c.user2_nombre) {
        errores.push(`Fecha[${i}] cruce[${j}]: falta user1_nombre o user2_nombre`);
      }
      for (const campo of ['bloque_a', 'bloque_b', 'gdt']) {
        if (!VALIDOS.includes(c[campo])) {
          errores.push(`Fecha[${i}] cruce[${j}] ${campo}: valor inválido "${c[campo]}" (debe ser user1|user2|empate)`);
        }
      }
    }
  }
  return errores;
}

// ─── Importar ────────────────────────────────────────────────────────────────
function importar(payload) {
  const db = getDb();

  // Verificar torneo
  const torneo = db.prepare('SELECT * FROM torneos WHERE id = ?').get(payload.torneo_id);
  if (!torneo) {
    console.error(`❌  Torneo ${payload.torneo_id} no encontrado`);
    process.exit(1);
  }
  console.log(`✅  Torneo: "${torneo.nombre}" (id=${torneo.id})`);

  // Obtener todos los usuarios del torneo (para resolver nombres)
  const jugadores = db.prepare(`
    SELECT u.id, u.nombre FROM users u
    JOIN torneo_jugadores tj ON tj.user_id = u.id
    WHERE tj.torneo_id = ?
  `).all(payload.torneo_id);

  const resolverUsuario = (nombre) => {
    const u = jugadores.find(j => j.nombre.toLowerCase() === nombre.toLowerCase());
    if (!u) throw new Error(`Usuario "${nombre}" no encontrado en el torneo`);
    return u.id;
  };

  const estadosPermitidos = ['borrador', 'abierta', 'cerrada', 'finalizada'];

  let fechasCreadas = 0, crucesCreados = 0, errores = 0;

  for (const fechaData of payload.fechas) {
    try {
      console.log(`\n📅  Procesando: ${fechaData.nombre}`);

      // Verificar si ya existe
      const existe = db.prepare(
        'SELECT id FROM fechas WHERE torneo_id = ? AND numero = ?'
      ).get(payload.torneo_id, fechaData.numero);

      let fechaId;

      if (existe) {
        console.log(`   ⚠️  Ya existe (id=${existe.id}), actualizando tipo y estado...`);
        if (!dryRun) {
          db.prepare(`
            UPDATE fechas SET tipo = 'resumida', estado = ?
            WHERE id = ?
          `).run(estadosPermitidos.includes(fechaData.estado) ? fechaData.estado : 'cerrada', existe.id);
        }
        fechaId = existe.id;
      } else {
        if (!dryRun) {
          const r = db.prepare(`
            INSERT INTO fechas (torneo_id, nombre, numero, mes, anio, estado, tipo, bloque1_nombre, bloque2_nombre)
            VALUES (?, ?, ?, ?, ?, ?, 'resumida', ?, ?)
          `).run(
            payload.torneo_id,
            fechaData.nombre,
            fechaData.numero,
            fechaData.mes,
            fechaData.anio,
            estadosPermitidos.includes(fechaData.estado) ? fechaData.estado : 'cerrada',
            fechaData.bloque1_nombre || 'Liga Argentina',
            fechaData.bloque2_nombre || 'Juanmar'
          );
          fechaId = r.lastInsertRowid;
        } else {
          fechaId = '(dry-run)';
        }
        fechasCreadas++;
        console.log(`   ✅  Fecha creada (id=${fechaId})`);
      }

      // Procesar cruces
      for (const cruceData of fechaData.cruces) {
        try {
          const user1Id = resolverUsuario(cruceData.user1_nombre);
          const user2Id = resolverUsuario(cruceData.user2_nombre);

          if (!dryRun) {
            // Upsert del cruce
            const cruceExiste = db.prepare(
              'SELECT id FROM cruces WHERE fecha_id = ? AND user1_id = ? AND user2_id = ?'
            ).get(fechaId, user1Id, user2Id);

            let cruceId;
            if (cruceExiste) {
              cruceId = cruceExiste.id;
              console.log(`   🔄  Cruce ${cruceData.user1_nombre} vs ${cruceData.user2_nombre}: actualizando`);
            } else {
              const r2 = db.prepare(
                'INSERT INTO cruces (fecha_id, user1_id, user2_id) VALUES (?, ?, ?)'
              ).run(fechaId, user1Id, user2Id);
              cruceId = r2.lastInsertRowid;
              crucesCreados++;
              console.log(`   ✅  Cruce ${cruceData.user1_nombre} vs ${cruceData.user2_nombre}: creado`);
            }

            calcularCruceResumido(db, cruceId, cruceData.bloque_a, cruceData.bloque_b, cruceData.gdt);
          } else {
            console.log(`   [dry] Cruce ${cruceData.user1_nombre} vs ${cruceData.user2_nombre}: ${cruceData.bloque_a} / ${cruceData.bloque_b} / ${cruceData.gdt}`);
          }
        } catch (e) {
          console.error(`   ❌  Error en cruce "${cruceData.user1_nombre}" vs "${cruceData.user2_nombre}": ${e.message}`);
          errores++;
        }
      }

      // Recalcular tabla después de procesar todos los cruces de la fecha
      if (!dryRun && typeof fechaId === 'number') {
        recalcularTablaGeneral(db, fechaId);
        console.log(`   📊  Tabla general recalculada`);
      }

    } catch (e) {
      console.error(`❌  Error en fecha "${fechaData.nombre}": ${e.message}`);
      errores++;
    }
  }

  console.log('\n─────────────────────────────────────────');
  if (dryRun) console.log('🔍  DRY RUN — no se escribió nada en la base de datos');
  console.log(`📅  Fechas creadas:  ${fechasCreadas}`);
  console.log(`🤝  Cruces creados:  ${crucesCreados}`);
  console.log(`❌  Errores:         ${errores}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
console.log('🏆  Import fechas resumidas — Prode Chacho');
console.log(`📄  Archivo: ${filePath}`);
if (dryRun) console.log('🔍  Modo: DRY RUN (sin escritura)');
console.log('');

const erroresValidacion = validar(data);
if (erroresValidacion.length > 0) {
  console.error('❌  Errores de validación:');
  erroresValidacion.forEach(e => console.error(`   • ${e}`));
  process.exit(1);
}

importar(data);
