/**
 * Base de datos SQLite usando el módulo nativo de Node.js (node:sqlite).
 * Disponible desde Node.js v22.5 — no requiere instalación de paquetes nativos.
 * Node.js v24 lo tiene estable.
 */
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'prode.db');

let db;

function getDb() {
  if (!db) {
    db = new DatabaseSync(DB_PATH);
    try { db.exec("PRAGMA journal_mode = WAL"); } catch (_) { /* WAL no soportado en este FS, usa default */ }
    // FK enforcement deshabilitado: el schema tiene referencias rotas a users_old
    // por un bug de SQLite 3.26+ que auto-actualiza FK refs al renombrar tablas.
    // La app no depende de FK enforcement (toda la integridad es manejada por código).
    // IMPORTANTE: node:sqlite (nativo de Node 22+) default-ea foreign_keys=ON
    // (a diferencia del sqlite3 CLI que es OFF). Hay que apagarlo explícitamente,
    // si no, DELETE FROM cruces/fechas falla cuando hay movimientos_economicos
    // apuntando al cruce vía cruce_id (sin CASCADE definido).
    db.exec("PRAGMA foreign_keys = OFF");
    initSchema();
    runMigrations();
  }
  return db;
}

function runMigrations() {
  // Limpiar tabla users_old si quedó por una migración interrumpida o corrompida
  try { db.exec("DROP TABLE IF EXISTS users_old"); } catch(e) {}

  // Agrega columna 'evento' si no existe (idempotente — para DBs creadas antes de este cambio)
  const tryAdd = (sql, col) => {
    try { db.exec(sql); }
    catch (e) {
      if (!e.message?.includes('duplicate column name'))
        console.warn(`[migration] ${col}:`, e.message);
    }
  };
  tryAdd('ALTER TABLE eventos ADD COLUMN evento TEXT',        'evento');
  tryAdd('ALTER TABLE eventos ADD COLUMN config_json TEXT',   'config_json');
  tryAdd('ALTER TABLE eventos ADD COLUMN resultado_json TEXT','resultado_json');

  // GDT: columnas nuevas en gdt_jugadores (migraciones aditivas)
  tryAdd('ALTER TABLE gdt_jugadores ADD COLUMN nombre_normalizado TEXT',       'gdt_jug.nombre_normalizado');
  tryAdd('ALTER TABLE gdt_jugadores ADD COLUMN equipo_catalogo_id INTEGER',    'gdt_jug.equipo_catalogo_id');
  tryAdd('ALTER TABLE gdt_jugadores ADD COLUMN posicion TEXT',                 'gdt_jug.posicion');
  tryAdd('ALTER TABLE gdt_jugadores ADD COLUMN activo INTEGER NOT NULL DEFAULT 1', 'gdt_jug.activo');
  tryAdd('ALTER TABLE gdt_jugadores ADD COLUMN merged_into INTEGER',           'gdt_jug.merged_into');

  // GDT: flujo de aprobación de jugadores
  // DEFAULT 'aprobado' para compatibilidad con datos anteriores al sistema de revisión.
  // Los nuevos jugadores se insertan explícitamente con estado='pendiente'.
  tryAdd("ALTER TABLE gdt_jugadores ADD COLUMN estado TEXT NOT NULL DEFAULT 'aprobado'", 'gdt_jug.estado');
  tryAdd('ALTER TABLE gdt_jugadores ADD COLUMN nombre_raw TEXT',               'gdt_jug.nombre_raw');
  tryAdd('ALTER TABLE gdt_jugadores ADD COLUMN equipo_raw TEXT',               'gdt_jug.equipo_raw');
  tryAdd('ALTER TABLE gdt_jugadores ADD COLUMN nombre_canonico TEXT',          'gdt_jug.nombre_canonico');
  tryAdd('ALTER TABLE gdt_jugadores ADD COLUMN revisado_por INTEGER',          'gdt_jug.revisado_por');
  tryAdd('ALTER TABLE gdt_jugadores ADD COLUMN revisado_at TEXT',              'gdt_jug.revisado_at');

  tryAdd('ALTER TABLE gdt_jugadores ADD COLUMN pais TEXT', 'gdt_jug.pais');

  // Fechas: tipo de carga (completa = normal, resumida = solo ganadores de bloque)
  tryAdd("ALTER TABLE fechas ADD COLUMN tipo TEXT NOT NULL DEFAULT 'completa'", 'fechas.tipo');

  // Pronósticos: flag para LEV seteado manualmente (no recalcular desde goles)
  tryAdd('ALTER TABLE pronosticos ADD COLUMN lev_manual INTEGER NOT NULL DEFAULT 0', 'pronosticos.lev_manual');

  // GDT: motivo de resultado en cruces (forfeit / exclusión)
  tryAdd('ALTER TABLE cruces ADD COLUMN gdt_motivo TEXT', 'cruces.gdt_motivo');

  // Migration: añadir rol 'superadmin' (SQLite no soporta ALTER CHECK, hay que recrear la tabla)
  try {
    const userSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
    if (userSchema && !userSchema.sql.includes('superadmin')) {
      db.exec("PRAGMA foreign_keys = OFF");
      db.exec("PRAGMA legacy_alter_table = ON"); // evita que SQLite actualice FKs de otras tablas
      db.exec("DROP TABLE IF EXISTS users_old");
      db.exec("ALTER TABLE users RENAME TO users_old");
      db.exec(`
        CREATE TABLE users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          nombre TEXT NOT NULL,
          email TEXT UNIQUE NOT NULL,
          password TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin', 'user', 'superadmin'))
        )
      `);
      db.exec("INSERT INTO users SELECT id, nombre, email, password, role FROM users_old");
      db.exec("DROP TABLE users_old");
      db.exec("PRAGMA legacy_alter_table = OFF");
      db.exec("PRAGMA foreign_keys = ON");
      console.log('[migration] users: added superadmin role');
    }
  } catch (e) {
    try { db.exec("PRAGMA legacy_alter_table = OFF"); } catch(_) {}
    try { db.exec("PRAGMA foreign_keys = ON"); } catch(_) {}
    if (!e.message?.includes('already exists')) console.warn('[migration] superadmin role:', e.message);
  }

  // Torneos: nombres de bloques (antes estaban en fechas, ahora en torneo)
  tryAdd("ALTER TABLE torneos ADD COLUMN bloque1_nombre TEXT NOT NULL DEFAULT 'Bloque 1'", 'torneos.bloque1_nombre');
  tryAdd("ALTER TABLE torneos ADD COLUMN bloque2_nombre TEXT NOT NULL DEFAULT 'Bloque 2'", 'torneos.bloque2_nombre');

  // Data migration: si el torneo tiene bloque1_nombre='Bloque 1' (default), copiar desde la primera fecha del torneo que tenga nombres
  try {
    const torneos = db.prepare("SELECT id FROM torneos WHERE bloque1_nombre = 'Bloque 1' AND bloque2_nombre = 'Bloque 2'").all();
    for (const t of torneos) {
      const fechaNombres = db.prepare(`
        SELECT bloque1_nombre, bloque2_nombre FROM fechas
        WHERE torneo_id = ? AND bloque1_nombre != 'Bloque 1' AND bloque2_nombre != 'Bloque 2'
        ORDER BY numero ASC LIMIT 1
      `).get(t.id);
      if (fechaNombres) {
        db.prepare('UPDATE torneos SET bloque1_nombre = ?, bloque2_nombre = ? WHERE id = ?')
          .run(fechaNombres.bloque1_nombre, fechaNombres.bloque2_nombre, t.id);
      }
    }
  } catch(e) { console.warn('[migration] torneo bloque names copy:', e.message); }

  // Pronósticos: timestamp de último envío
  tryAdd('ALTER TABLE pronosticos ADD COLUMN updated_at TEXT', 'pronosticos.updated_at');

  // Movimientos económicos (apuesta por fecha)
  tryAdd('ALTER TABLE fechas ADD COLUMN importe_apuesta INTEGER', 'fechas.importe_apuesta');

  // Deadline de pronósticos (fecha + hora, opcional)
  tryAdd('ALTER TABLE fechas ADD COLUMN deadline TEXT', 'fechas.deadline');

  // GDT Ligas: columna en fechas para asociar una liga GDT específica por fecha
  // NULL = usar la liga default (retrocompatibilidad total con fechas existentes)
  tryAdd('ALTER TABLE fechas ADD COLUMN gdt_liga_id INTEGER REFERENCES gdt_ligas(id)', 'fechas.gdt_liga_id');

  // GDT Ligas: seed de liga default "GDT Argentina"
  // Solo inserta si no existe ninguna liga con es_default = 1 (idempotente).
  // Per-torneo: necesita un torneo al cual asociar. Si no hay torneos, no siembra
  // (el admin tendrá que crear su primer torneo y luego sus ligas explícitamente).
  try {
    const ligaDefaultExiste = db.prepare(
      "SELECT 1 FROM gdt_ligas WHERE es_default = 1 LIMIT 1"
    ).get();
    if (!ligaDefaultExiste) {
      const primerTorneo = db.prepare("SELECT id FROM torneos ORDER BY id ASC LIMIT 1").get();
      if (primerTorneo) {
        // Tras Fase 5, gdt_ligas tiene torneo_id NOT NULL. Si Fase 5 aún no corrió,
        // el INSERT puede tirar si la columna no existe; lo manejamos en el catch.
        try {
          db.prepare(
            "INSERT INTO gdt_ligas (torneo_id, nombre, descripcion, formato, pais_categoria, activo, es_default) VALUES (?, ?, ?, ?, ?, 1, 1)"
          ).run(primerTorneo.id, 'GDT Argentina', 'Liga GDT principal — Argentina', 'F11', 'Argentina');
          console.log('[migration] gdt_ligas: seed "GDT Argentina" creado como liga default del torneo id=' + primerTorneo.id);
        } catch (e) {
          // Schema pre-Fase 5 (sin torneo_id): caer al INSERT legacy; la Fase 5 hará backfill.
          if (e.message?.includes('no column named torneo_id')) {
            db.prepare(
              "INSERT INTO gdt_ligas (nombre, descripcion, formato, pais_categoria, activo, es_default) VALUES (?, ?, ?, ?, 1, 1)"
            ).run('GDT Argentina', 'Liga GDT principal — Argentina', 'F11', 'Argentina');
            console.log('[migration] gdt_ligas: seed "GDT Argentina" creado (schema pre-Fase 5)');
          } else { throw e; }
        }
      } else {
        console.log('[migration] gdt_ligas: no hay torneos todavía, seed diferido (el admin debe crear torneo + liga)');
      }
    }
  } catch(e) {
    console.warn('[migration] gdt_ligas seed:', e.message);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS movimientos_economicos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      torneo_id INTEGER NOT NULL,
      fecha_id INTEGER REFERENCES fechas(id),
      cruce_id INTEGER REFERENCES cruces(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      acreedor_user_id INTEGER REFERENCES users(id),
      tipo TEXT NOT NULL CHECK(tipo IN ('empate_pozo', 'deuda_rival', 'manual')),
      concepto TEXT NOT NULL,
      importe INTEGER NOT NULL,
      signo TEXT NOT NULL DEFAULT '+' CHECK(signo IN ('+', '-')),
      pagado INTEGER NOT NULL DEFAULT 0,
      pagado_at TEXT,
      pagado_por INTEGER REFERENCES users(id),
      created_by INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Migración: añadir acreedor_user_id y tipo 'deuda_rival' si la tabla ya existía sin ellos
  try {
    const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='movimientos_economicos'").get();
    if (schema && !schema.sql.includes('deuda_rival')) {
      db.exec("PRAGMA legacy_alter_table = ON");
      db.exec("DROP TABLE IF EXISTS movimientos_economicos_old");
      db.exec("ALTER TABLE movimientos_economicos RENAME TO movimientos_economicos_old");
      db.exec(`
        CREATE TABLE movimientos_economicos (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          torneo_id INTEGER NOT NULL,
          fecha_id INTEGER REFERENCES fechas(id),
          cruce_id INTEGER REFERENCES cruces(id),
          user_id INTEGER NOT NULL REFERENCES users(id),
          acreedor_user_id INTEGER REFERENCES users(id),
          tipo TEXT NOT NULL CHECK(tipo IN ('empate_pozo', 'deuda_rival', 'manual')),
          concepto TEXT NOT NULL,
          importe INTEGER NOT NULL,
          signo TEXT NOT NULL DEFAULT '+' CHECK(signo IN ('+', '-')),
          pagado INTEGER NOT NULL DEFAULT 0,
          pagado_at TEXT,
          pagado_por INTEGER REFERENCES users(id),
          created_by INTEGER REFERENCES users(id),
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);
      db.exec(`
        INSERT INTO movimientos_economicos
          (id, torneo_id, fecha_id, cruce_id, user_id, acreedor_user_id, tipo, concepto, importe, signo, pagado, pagado_at, pagado_por, created_by, created_at)
        SELECT id, torneo_id, fecha_id, cruce_id, user_id, NULL, tipo, concepto, importe, signo, pagado, pagado_at, pagado_por, created_by, created_at
        FROM movimientos_economicos_old
      `);
      db.exec("DROP TABLE movimientos_economicos_old");
      db.exec("PRAGMA legacy_alter_table = OFF");
      console.log('[migration] movimientos_economicos: added deuda_rival + acreedor_user_id');
    }
  } catch(e) {
    try { db.exec("PRAGMA legacy_alter_table = OFF"); } catch(_) {}
    if (!e.message?.includes('already exists')) console.warn('[migration] movimientos_economicos v2:', e.message);
  }

  // Migración: añadir 'multa_deadline' al CHECK de tipo en movimientos_economicos
  // Debe correr DESPUÉS del CREATE TABLE y de la migración de deuda_rival.
  try {
    const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='movimientos_economicos'").get();
    if (schema && !schema.sql.includes('multa_deadline')) {
      db.exec("PRAGMA legacy_alter_table = ON");
      db.exec("DROP TABLE IF EXISTS movimientos_economicos_old2");
      db.exec("ALTER TABLE movimientos_economicos RENAME TO movimientos_economicos_old2");
      db.exec(`
        CREATE TABLE movimientos_economicos (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          torneo_id INTEGER NOT NULL,
          fecha_id INTEGER REFERENCES fechas(id),
          cruce_id INTEGER REFERENCES cruces(id),
          user_id INTEGER NOT NULL REFERENCES users(id),
          acreedor_user_id INTEGER REFERENCES users(id),
          tipo TEXT NOT NULL CHECK(tipo IN ('empate_pozo', 'deuda_rival', 'manual', 'multa_deadline')),
          concepto TEXT NOT NULL,
          importe INTEGER NOT NULL,
          signo TEXT NOT NULL DEFAULT '+' CHECK(signo IN ('+', '-')),
          pagado INTEGER NOT NULL DEFAULT 0,
          pagado_at TEXT,
          pagado_por INTEGER REFERENCES users(id),
          created_by INTEGER REFERENCES users(id),
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);
      db.exec(`
        INSERT INTO movimientos_economicos
          (id, torneo_id, fecha_id, cruce_id, user_id, acreedor_user_id, tipo, concepto, importe, signo, pagado, pagado_at, pagado_por, created_by, created_at)
        SELECT id, torneo_id, fecha_id, cruce_id, user_id, acreedor_user_id, tipo, concepto, importe, signo, pagado, pagado_at, pagado_por, created_by, created_at
        FROM movimientos_economicos_old2
      `);
      db.exec("DROP TABLE movimientos_economicos_old2");
      db.exec("PRAGMA legacy_alter_table = OFF");
      console.log('[migration] movimientos_economicos: added multa_deadline tipo');
    }
  } catch(e) {
    try { db.exec("PRAGMA legacy_alter_table = OFF"); } catch(_) {}
    if (!e.message?.includes('already exists')) console.warn('[migration] movimientos_economicos multa_deadline:', e.message);
  }

  // Cleanup: borrar movimientos pendientes (empate_pozo / deuda_rival) de fechas que
  // no están finalizadas. Las deudas solo deben existir una vez finalizada la fecha.
  // Se preservan los pagos ya confirmados como histórico.
  try {
    const res = db.prepare(`
      DELETE FROM movimientos_economicos
      WHERE pagado = 0
        AND tipo IN ('empate_pozo', 'deuda_rival')
        AND fecha_id IN (SELECT id FROM fechas WHERE estado != 'finalizada')
    `).run();
    if (res.changes > 0) {
      console.log(`[cleanup] eliminados ${res.changes} movimientos pendientes de fechas no finalizadas`);
    }
  } catch(e) {
    console.warn('[cleanup] movimientos fechas no finalizadas:', e.message);
  }

  // Cierre mensual: ganadores y organizador (con posible override manual por superadmin)
  db.exec(`
    CREATE TABLE IF NOT EXISTS tabla_mensual_cierre (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      torneo_id INTEGER NOT NULL,
      mes INTEGER NOT NULL,
      anio INTEGER NOT NULL,
      ganadores_json TEXT,
      organizador_user_id INTEGER,
      nota TEXT,
      updated_by INTEGER REFERENCES users(id),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(torneo_id, mes, anio)
    )
  `);

  // Comidas mensuales (módulo comidas — Fase 1)
  db.exec(`
    CREATE TABLE IF NOT EXISTS comidas_mensuales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      torneo_id INTEGER NOT NULL,
      mes INTEGER NOT NULL,
      anio INTEGER NOT NULL,
      organizador_user_id INTEGER REFERENCES users(id),
      lugar TEXT,
      fecha_comida TEXT,
      google_maps_url TEXT,
      nota TEXT,
      estado TEXT NOT NULL DEFAULT 'pendiente'
        CHECK(estado IN ('pendiente', 'confirmada', 'realizada')),
      updated_by INTEGER REFERENCES users(id),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(torneo_id, mes, anio)
    )
  `);

  // Participantes de comidas — Fase 2 (jugadores + invitados externos)
  db.exec(`
    CREATE TABLE IF NOT EXISTS comidas_participantes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      comida_id INTEGER NOT NULL REFERENCES comidas_mensuales(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id),
      nombre TEXT NOT NULL,
      es_jugador INTEGER NOT NULL DEFAULT 0,
      puede_votar INTEGER NOT NULL DEFAULT 0,
      asistio INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Fotos de comidas (Fase 3)
  db.exec(`
    CREATE TABLE IF NOT EXISTS comidas_fotos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      comida_id INTEGER NOT NULL,
      url TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (comida_id) REFERENCES comidas_mensuales(id)
    )
  `);

  // Configuración de votación de comidas por torneo
  db.exec(`
    CREATE TABLE IF NOT EXISTS comidas_votacion_config (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      torneo_id  INTEGER NOT NULL UNIQUE REFERENCES torneos(id),
      items_json TEXT    NOT NULL DEFAULT '[]',
      updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Votos de usuarios en comidas mensuales
  db.exec(`
    CREATE TABLE IF NOT EXISTS comidas_votos (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      comida_id        INTEGER NOT NULL REFERENCES comidas_mensuales(id) ON DELETE CASCADE,
      user_id          INTEGER REFERENCES users(id),
      nombre_invitado  TEXT,
      item             TEXT    NOT NULL,
      puntaje          INTEGER NOT NULL CHECK(puntaje >= 1 AND puntaje <= 10),
      created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(comida_id, user_id, item)
    )
  `);

  // Migración: agregar votacion_estado a comidas_mensuales (idempotente)
  try {
    db.exec(`ALTER TABLE comidas_mensuales ADD COLUMN votacion_estado TEXT NOT NULL DEFAULT 'abierta'`);
  } catch (_) {
    // Columna ya existe — ignorar
  }

  // Tokens para restablecimiento de contraseña (magic links)
  db.exec(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      token TEXT UNIQUE NOT NULL,
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Permisos granulares por usuario
  // superadmin siempre tiene acceso total (no requiere filas en esta tabla).
  // Los admins existentes reciben todos los permisos por retrocompatibilidad.
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_permisos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      permiso TEXT NOT NULL CHECK(permiso IN (
        'crear_torneo',
        'editar_fecha',
        'cargar_resultados',
        'editar_tabla_mensual',
        'gestionar_multas',
        'gestionar_comidas'
      )),
      granted_by INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, permiso)
    )
  `);

  // Seed: todos los admins existentes que no tengan permisos aún reciben el set completo.
  try {
    const TODOS_LOS_PERMISOS = [
      'crear_torneo',
      'editar_fecha',
      'cargar_resultados',
      'editar_tabla_mensual',
      'gestionar_multas',
      'gestionar_comidas'
    ];
    const admins = db.prepare("SELECT id FROM users WHERE role = 'admin'").all();
    const insert = db.prepare(
      "INSERT OR IGNORE INTO user_permisos (user_id, permiso) VALUES (?, ?)"
    );
    for (const admin of admins) {
      const tieneAlguno = db.prepare(
        "SELECT 1 FROM user_permisos WHERE user_id = ? LIMIT 1"
      ).get(admin.id);
      if (!tieneAlguno) {
        for (const permiso of TODOS_LOS_PERMISOS) {
          insert.run(admin.id, permiso);
        }
      }
    }
    if (admins.length > 0) {
      console.log(`[migration] user_permisos: seed aplicado a ${admins.length} admin(s)`);
    }
  } catch(e) {
    console.warn('[migration] user_permisos seed:', e.message);
  }

  // Migración: agregar 'gestionar_comidas' al CHECK de user_permisos y seedear retrocompatibilidad.
  // SQLite no soporta ALTER TABLE ADD CHECK, hay que recrear la tabla.
  try {
    const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='user_permisos'").get();
    if (schema && !schema.sql.includes('gestionar_comidas')) {
      db.exec("PRAGMA legacy_alter_table = ON");
      db.exec("DROP TABLE IF EXISTS user_permisos_old");
      db.exec("ALTER TABLE user_permisos RENAME TO user_permisos_old");
      db.exec(`
        CREATE TABLE user_permisos (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          permiso TEXT NOT NULL CHECK(permiso IN (
            'crear_torneo',
            'editar_fecha',
            'cargar_resultados',
            'editar_tabla_mensual',
            'gestionar_multas',
            'gestionar_comidas'
          )),
          granted_by INTEGER REFERENCES users(id),
          created_at TEXT DEFAULT (datetime('now')),
          UNIQUE(user_id, permiso)
        )
      `);
      db.exec("INSERT INTO user_permisos SELECT * FROM user_permisos_old");
      db.exec("DROP TABLE user_permisos_old");
      db.exec("PRAGMA legacy_alter_table = OFF");
      // Retrocompatibilidad: dar gestionar_comidas a quien ya tiene editar_tabla_mensual
      const conTabla = db.prepare(
        "SELECT DISTINCT user_id FROM user_permisos WHERE permiso = 'editar_tabla_mensual'"
      ).all();
      const ins = db.prepare(
        "INSERT OR IGNORE INTO user_permisos (user_id, permiso) VALUES (?, 'gestionar_comidas')"
      );
      for (const row of conTabla) ins.run(row.user_id);
      console.log(`[migration] user_permisos: gestionar_comidas agregado (${conTabla.length} usuario(s))`);
    }
  } catch(e) {
    try { db.exec("PRAGMA legacy_alter_table = OFF"); } catch(_) {}
    if (!e.message?.includes('already exists')) console.warn('[migration] user_permisos gestionar_comidas:', e.message);
  }

  // ── Fase 2A: gdt_liga_id en tablas GDT ──────────────────────────────────────
  // Agrega la columna a cada tabla GDT. Idempotente: tryAdd ignora "duplicate column name".
  // No cambia UNIQUE constraints todavía — eso es Fase 2B.
  tryAdd('ALTER TABLE gdt_equipos_catalogo ADD COLUMN gdt_liga_id INTEGER REFERENCES gdt_ligas(id)', 'gdt_equipos_catalogo.gdt_liga_id');
  tryAdd('ALTER TABLE gdt_jugadores        ADD COLUMN gdt_liga_id INTEGER REFERENCES gdt_ligas(id)', 'gdt_jugadores.gdt_liga_id');
  tryAdd('ALTER TABLE gdt_equipos          ADD COLUMN gdt_liga_id INTEGER REFERENCES gdt_ligas(id)', 'gdt_equipos.gdt_liga_id');
  tryAdd('ALTER TABLE gdt_equipo_estado    ADD COLUMN gdt_liga_id INTEGER REFERENCES gdt_ligas(id)', 'gdt_equipo_estado.gdt_liga_id');
  tryAdd('ALTER TABLE gdt_ventanas         ADD COLUMN gdt_liga_id INTEGER REFERENCES gdt_ligas(id)', 'gdt_ventanas.gdt_liga_id');
  // GDT: flag para distinguir cambios de corrección (no consumen cupo de cambios_por_usuario)
  tryAdd('ALTER TABLE gdt_cambios ADD COLUMN es_correccion INTEGER NOT NULL DEFAULT 0', 'gdt_cambios.es_correccion');
  // GDT Ligas: trazabilidad de importación (nullable — null = liga creada desde cero)
  tryAdd('ALTER TABLE gdt_ligas ADD COLUMN importada_de_liga_id INTEGER REFERENCES gdt_ligas(id)', 'gdt_ligas.importada_de_liga_id');
  // Fase 3A: gdt_liga_id en gdt_cambios — cada cambio queda asociado a la liga de su ventana
  tryAdd('ALTER TABLE gdt_cambios ADD COLUMN gdt_liga_id INTEGER REFERENCES gdt_ligas(id)', 'gdt_cambios.gdt_liga_id');

  // Data migration: asignar liga default a todos los registros existentes sin liga.
  // Solo corre si existe al menos una liga default. Idempotente: WHERE gdt_liga_id IS NULL.
  try {
    const ligaDefault = db.prepare(
      "SELECT id FROM gdt_ligas WHERE es_default = 1 AND activo = 1 LIMIT 1"
    ).get();
    if (ligaDefault) {
      const tablas = [
        'gdt_equipos_catalogo',
        'gdt_jugadores',
        'gdt_equipos',
        'gdt_equipo_estado',
        'gdt_ventanas',
      ];
      for (const tabla of tablas) {
        const r = db.prepare(
          `UPDATE ${tabla} SET gdt_liga_id = ? WHERE gdt_liga_id IS NULL`
        ).run(ligaDefault.id);
        if (r.changes > 0) {
          console.log(`[migration] ${tabla}: ${r.changes} fila(s) asignadas a liga default (id=${ligaDefault.id})`);
        }
      }
    }
  } catch(e) {
    console.warn('[migration] gdt_liga_id data migration:', e.message);
  }

  // Fase 3A backfill: gdt_cambios.gdt_liga_id derivado de la ventana a la que pertenece.
  // COALESCE: si la ventana también tenía gdt_liga_id NULL (pre-Fase 2A), usa liga default.
  // Idempotente: WHERE gdt_liga_id IS NULL.
  try {
    const ligaDefault = db.prepare("SELECT id FROM gdt_ligas WHERE es_default = 1 AND activo = 1 LIMIT 1").get();
    const r = db.prepare(`
      UPDATE gdt_cambios
      SET gdt_liga_id = COALESCE(
        (SELECT gdt_liga_id FROM gdt_ventanas WHERE id = gdt_cambios.ventana_id),
        ?
      )
      WHERE gdt_liga_id IS NULL
    `).run(ligaDefault?.id ?? null);
    if (r.changes > 0) console.log(`[migration] gdt_cambios: ${r.changes} fila(s) backfilled con gdt_liga_id`);
  } catch(e) {
    console.warn('[migration] gdt_cambios.gdt_liga_id backfill:', e.message);
  }

  // GDT Liga Slots: seed de slots F11 estándar para toda liga existente sin slots definidos.
  // Corre después del seed de gdt_ligas, por lo que la liga default siempre existe.
  // Idempotente: solo inserta si esa liga no tiene ningún slot en gdt_liga_slots.
  // La fuente de verdad del formato de cada liga es gdt_liga_slots (no la columna `formato`).
  try {
    const ligasSinSlots = db.prepare(`
      SELECT l.id FROM gdt_ligas l
      WHERE NOT EXISTS (
        SELECT 1 FROM gdt_liga_slots s WHERE s.gdt_liga_id = l.id
      )
    `).all();

    if (ligasSinSlots.length > 0) {
      const SLOTS_F11 = [
        { slot: 'ARQ',  posicion: 'ARQ', orden: 1  },
        { slot: 'DEF1', posicion: 'DEF', orden: 2  },
        { slot: 'DEF2', posicion: 'DEF', orden: 3  },
        { slot: 'DEF3', posicion: 'DEF', orden: 4  },
        { slot: 'DEF4', posicion: 'DEF', orden: 5  },
        { slot: 'MED1', posicion: 'MED', orden: 6  },
        { slot: 'MED2', posicion: 'MED', orden: 7  },
        { slot: 'MED3', posicion: 'MED', orden: 8  },
        { slot: 'MED4', posicion: 'MED', orden: 9  },
        { slot: 'DEL1', posicion: 'DEL', orden: 10 },
        { slot: 'DEL2', posicion: 'DEL', orden: 11 },
      ];
      const stmtSlot = db.prepare(
        'INSERT OR IGNORE INTO gdt_liga_slots (gdt_liga_id, slot, posicion, orden) VALUES (?, ?, ?, ?)'
      );
      for (const liga of ligasSinSlots) {
        for (const s of SLOTS_F11) {
          stmtSlot.run(liga.id, s.slot, s.posicion, s.orden);
        }
        console.log(`[migration] gdt_liga_slots: 11 slots F11 creados para liga id=${liga.id}`);
      }
    }
  } catch(e) {
    console.warn('[migration] gdt_liga_slots seed:', e.message);
  }

  // ── Migración: gdt_equipos CHECK de slots con comillas internas ───────────────
  // La tabla fue creada con CHECK(slot IN ('"ARQ"',...)) con comillas internas.
  // SQLite no permite ALTER TABLE DROP CONSTRAINT: hay que recrear la tabla.
  // Idempotente: solo corre si sqlite_master muestra el CHECK viejo.
  // Debe ejecutarse DESPUES de Fase 2A para que gdt_liga_id ya exista en gdt_equipos_old.
  try {
    const eqSchema = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='gdt_equipos'"
    ).get();
    if (eqSchema && eqSchema.sql.includes('\'"ARQ"\'')) {
      console.log('[migration] gdt_equipos: corrigiendo CHECK de slots con comillas internas...');
      db.exec('PRAGMA legacy_alter_table = ON');
      try {
        db.exec('ALTER TABLE gdt_equipos RENAME TO gdt_equipos_old');
        db.exec(`
          CREATE TABLE gdt_equipos (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            torneo_id   INTEGER NOT NULL,
            user_id     INTEGER NOT NULL,
            slot        TEXT NOT NULL,
            jugador_id  INTEGER NOT NULL,
            gdt_liga_id INTEGER REFERENCES gdt_ligas(id),
            FOREIGN KEY (torneo_id)  REFERENCES torneos(id),
            FOREIGN KEY (user_id)    REFERENCES users(id),
            FOREIGN KEY (jugador_id) REFERENCES gdt_jugadores(id),
            UNIQUE(torneo_id, user_id, slot),
            UNIQUE(torneo_id, user_id, jugador_id)
          )
        `);
        db.exec(`
          INSERT INTO gdt_equipos (id, torneo_id, user_id, slot, jugador_id, gdt_liga_id)
          SELECT                   id, torneo_id, user_id, slot, jugador_id, gdt_liga_id
          FROM gdt_equipos_old
        `);
        db.exec('DROP TABLE gdt_equipos_old');
        const cnt = db.prepare('SELECT COUNT(*) as n FROM gdt_equipos').get();
        console.log(`[migration] gdt_equipos: OK — ${cnt.n} fila(s) preservadas, CHECK eliminado`);
      } finally {
        db.exec('PRAGMA legacy_alter_table = OFF');
      }
    }
  } catch(e) {
    try { db.exec('PRAGMA legacy_alter_table = OFF'); } catch(_) {}
    console.warn('[migration] gdt_equipos CHECK fix:', e.message);
  }

  // ── Fase 2B: UNIQUE constraints multi-liga ────────────────────────────────────
  // Permite un equipo por (torneo + usuario + liga GDT).
  // Prerequisito: Fase 2A corrió, backfill corrió, gdt_liga_id IS NOT NULL.

  // F6a-1: Verificación + backfill defensivo antes de migrar.
  // Si el backfill previo falló o no hubo liga default en ese momento, lo reintenta aquí.
  try {
    const ligaDefault2B = db.prepare(
      "SELECT id FROM gdt_ligas WHERE es_default = 1 AND activo = 1 LIMIT 1"
    ).get();
    if (ligaDefault2B) {
      const nullsEq = db.prepare("SELECT COUNT(*) as n FROM gdt_equipos      WHERE gdt_liga_id IS NULL").get().n;
      const nullsEs = db.prepare("SELECT COUNT(*) as n FROM gdt_equipo_estado WHERE gdt_liga_id IS NULL").get().n;
      if (nullsEq > 0 || nullsEs > 0) {
        console.warn(`[migration Fase2B] NULLs detectados — gdt_equipos: ${nullsEq}, gdt_equipo_estado: ${nullsEs}. Corriendo backfill adicional...`);
        db.prepare("UPDATE gdt_equipos       SET gdt_liga_id = ? WHERE gdt_liga_id IS NULL").run(ligaDefault2B.id);
        db.prepare("UPDATE gdt_equipo_estado SET gdt_liga_id = ? WHERE gdt_liga_id IS NULL").run(ligaDefault2B.id);
        console.log(`[migration Fase2B] Backfill adicional OK (liga_id=${ligaDefault2B.id})`);
      } else {
        console.log('[migration Fase2B] Verificación OK — sin NULLs en gdt_equipos ni gdt_equipo_estado');
      }
    } else {
      console.warn('[migration Fase2B] Sin liga default activa — Fase 2B postergada');
    }
  } catch(e) {
    console.warn('[migration Fase2B] Error en verificación:', e.message);
  }

  // F6a-2: Migrar gdt_equipo_estado — UNIQUE(torneo_id, user_id) → UNIQUE(torneo_id, user_id, gdt_liga_id)
  // Idempotente: solo corre si el schema actual NO tiene el nuevo UNIQUE.
  try {
    const estadoSchema = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='gdt_equipo_estado'"
    ).get();
    if (estadoSchema && !estadoSchema.sql.includes('UNIQUE(torneo_id, user_id, gdt_liga_id)')) {
      console.log('[migration Fase2B] gdt_equipo_estado: actualizando UNIQUE → (torneo_id, user_id, gdt_liga_id)...');
      const cntAntes = db.prepare('SELECT COUNT(*) as n FROM gdt_equipo_estado').get().n;
      db.exec('PRAGMA legacy_alter_table = ON');
      try {
        db.exec('ALTER TABLE gdt_equipo_estado RENAME TO gdt_equipo_estado_old');
        db.exec(`
          CREATE TABLE gdt_equipo_estado (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            torneo_id      INTEGER NOT NULL,
            user_id        INTEGER NOT NULL,
            gdt_liga_id    INTEGER REFERENCES gdt_ligas(id),
            estado         TEXT NOT NULL DEFAULT 'valido'
                             CHECK(estado IN ('valido', 'observado', 'requiere_correccion')),
            observaciones  TEXT,
            motivo_admin   TEXT,
            invalidado_por INTEGER REFERENCES users(id),
            updated_at     TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (torneo_id) REFERENCES torneos(id),
            FOREIGN KEY (user_id)   REFERENCES users(id),
            UNIQUE(torneo_id, user_id, gdt_liga_id)
          )
        `);
        db.exec(`
          INSERT INTO gdt_equipo_estado
            (id, torneo_id, user_id, gdt_liga_id, estado, observaciones, motivo_admin, invalidado_por, updated_at)
          SELECT
            id, torneo_id, user_id, gdt_liga_id, estado, observaciones, motivo_admin, invalidado_por, updated_at
          FROM gdt_equipo_estado_old
        `);
        db.exec('DROP TABLE gdt_equipo_estado_old');
        const cntDespues = db.prepare('SELECT COUNT(*) as n FROM gdt_equipo_estado').get().n;
        if (cntAntes !== cntDespues) {
          console.error(`[migration Fase2B] gdt_equipo_estado: ALERTA — filas antes=${cntAntes}, después=${cntDespues}`);
        } else {
          console.log(`[migration Fase2B] gdt_equipo_estado: OK — ${cntDespues} fila(s) preservadas`);
        }
      } finally {
        db.exec('PRAGMA legacy_alter_table = OFF');
      }
    }
  } catch(e) {
    try { db.exec('PRAGMA legacy_alter_table = OFF'); } catch(_) {}
    console.warn('[migration Fase2B] gdt_equipo_estado:', e.message);
  }

  // F6a-4: Migrar gdt_equipos — UNIQUE sin liga → UNIQUE(torneo_id, user_id, gdt_liga_id, slot/jugador_id)
  // Idempotente: solo corre si el schema actual NO tiene el nuevo UNIQUE.
  try {
    const eqSchema = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='gdt_equipos'"
    ).get();
    if (eqSchema && !eqSchema.sql.includes('UNIQUE(torneo_id, user_id, gdt_liga_id, slot)')) {
      console.log('[migration Fase2B] gdt_equipos: actualizando UNIQUE → incluir gdt_liga_id...');
      const cntAntes = db.prepare('SELECT COUNT(*) as n FROM gdt_equipos').get().n;
      db.exec('PRAGMA legacy_alter_table = ON');
      try {
        db.exec('ALTER TABLE gdt_equipos RENAME TO gdt_equipos_old');
        db.exec(`
          CREATE TABLE gdt_equipos (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            torneo_id   INTEGER NOT NULL,
            user_id     INTEGER NOT NULL,
            slot        TEXT NOT NULL,
            jugador_id  INTEGER NOT NULL,
            gdt_liga_id INTEGER REFERENCES gdt_ligas(id),
            FOREIGN KEY (torneo_id)  REFERENCES torneos(id),
            FOREIGN KEY (user_id)    REFERENCES users(id),
            FOREIGN KEY (jugador_id) REFERENCES gdt_jugadores(id),
            UNIQUE(torneo_id, user_id, gdt_liga_id, slot),
            UNIQUE(torneo_id, user_id, gdt_liga_id, jugador_id)
          )
        `);
        db.exec(`
          INSERT INTO gdt_equipos (id, torneo_id, user_id, slot, jugador_id, gdt_liga_id)
          SELECT                   id, torneo_id, user_id, slot, jugador_id, gdt_liga_id
          FROM gdt_equipos_old
        `);
        db.exec('DROP TABLE gdt_equipos_old');
        const cntDespues = db.prepare('SELECT COUNT(*) as n FROM gdt_equipos').get().n;
        if (cntAntes !== cntDespues) {
          console.error(`[migration Fase2B] gdt_equipos: ALERTA — filas antes=${cntAntes}, después=${cntDespues}`);
        } else {
          console.log(`[migration Fase2B] gdt_equipos: OK — ${cntDespues} fila(s) preservadas`);
        }
      } finally {
        db.exec('PRAGMA legacy_alter_table = OFF');
      }
    }
  } catch(e) {
    try { db.exec('PRAGMA legacy_alter_table = OFF'); } catch(_) {}
    console.warn('[migration Fase2B] gdt_equipos:', e.message);
  }

  // ── Fase 4: UNIQUE per-liga en gdt_equipos_catalogo y gdt_jugadores ─────────
  // Objetivo:
  //   gdt_equipos_catalogo: UNIQUE(torneo_id, gdt_liga_id, nombre_normalizado)
  //   gdt_jugadores:        UNIQUE(torneo_id, gdt_liga_id, nombre_normalizado, equipo_real)
  //
  // Fail-loud: si detecta duplicados que romperían el nuevo UNIQUE, NO recrea la tabla
  // (loguea console.error y deja todo como estaba). Idempotente: solo corre si el
  // schema actual NO tiene el UNIQUE objetivo.

  // F4-0: backfill defensivo de gdt_liga_id NULL (refuerzo de Fase 2A)
  try {
    const ligaDefF4 = db.prepare(
      "SELECT id FROM gdt_ligas WHERE es_default = 1 AND activo = 1 LIMIT 1"
    ).get();
    if (ligaDefF4) {
      for (const tabla of ['gdt_equipos_catalogo', 'gdt_jugadores']) {
        const r = db.prepare(
          `UPDATE ${tabla} SET gdt_liga_id = ? WHERE gdt_liga_id IS NULL`
        ).run(ligaDefF4.id);
        if (r.changes > 0) console.log(`[migration Fase4] ${tabla}: backfill liga_id en ${r.changes} fila(s)`);
      }
    }
  } catch (e) {
    console.warn('[migration Fase4] backfill liga_id:', e.message);
  }

  // F4-1: migrar gdt_equipos_catalogo
  try {
    const catSchema = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='gdt_equipos_catalogo'"
    ).get();
    if (catSchema && !catSchema.sql.includes('UNIQUE(torneo_id, gdt_liga_id, nombre_normalizado)')) {
      const dups = db.prepare(`
        SELECT COUNT(*) AS n FROM (
          SELECT 1 FROM gdt_equipos_catalogo
          GROUP BY torneo_id, gdt_liga_id, nombre_normalizado
          HAVING COUNT(*) > 1
        )
      `).get();
      if (dups.n > 0) {
        console.error(`[migration Fase4] gdt_equipos_catalogo: ${dups.n} grupo(s) de duplicados — ABORTANDO (la tabla queda como estaba). Correr backend/diagnostico-fase4.js para detalle.`);
      } else {
        const cntAntes = db.prepare('SELECT COUNT(*) AS n FROM gdt_equipos_catalogo').get().n;
        db.exec('PRAGMA legacy_alter_table = ON');
        try {
          db.exec('DROP TABLE IF EXISTS gdt_equipos_catalogo_old');
          db.exec('ALTER TABLE gdt_equipos_catalogo RENAME TO gdt_equipos_catalogo_old');
          db.exec(`
            CREATE TABLE gdt_equipos_catalogo (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              torneo_id INTEGER NOT NULL,
              gdt_liga_id INTEGER REFERENCES gdt_ligas(id),
              nombre TEXT NOT NULL,
              nombre_normalizado TEXT NOT NULL,
              pais TEXT,
              activo INTEGER NOT NULL DEFAULT 1,
              FOREIGN KEY (torneo_id) REFERENCES torneos(id),
              UNIQUE(torneo_id, gdt_liga_id, nombre_normalizado)
            )
          `);
          db.exec(`
            INSERT INTO gdt_equipos_catalogo
              (id, torneo_id, gdt_liga_id, nombre, nombre_normalizado, pais, activo)
            SELECT
              id, torneo_id, gdt_liga_id, nombre, nombre_normalizado, pais, activo
            FROM gdt_equipos_catalogo_old
          `);
          db.exec('DROP TABLE gdt_equipos_catalogo_old');
          const cntDespues = db.prepare('SELECT COUNT(*) AS n FROM gdt_equipos_catalogo').get().n;
          if (cntAntes !== cntDespues) {
            console.error(`[migration Fase4] gdt_equipos_catalogo: ALERTA filas antes=${cntAntes} después=${cntDespues}`);
          } else {
            console.log(`[migration Fase4] gdt_equipos_catalogo: OK — ${cntDespues} fila(s) preservadas`);
          }
        } finally {
          db.exec('PRAGMA legacy_alter_table = OFF');
        }
      }
    }
  } catch (e) {
    try { db.exec('PRAGMA legacy_alter_table = OFF'); } catch(_) {}
    console.error('[migration Fase4] gdt_equipos_catalogo:', e.message);
  }

  // F4-2: migrar gdt_jugadores (todas las columnas actuales preservadas, ids estables)
  try {
    const jugSchema = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='gdt_jugadores'"
    ).get();
    if (jugSchema && !jugSchema.sql.includes('UNIQUE(torneo_id, gdt_liga_id, nombre_normalizado, equipo_real)')) {
      const dups = db.prepare(`
        SELECT COUNT(*) AS n FROM (
          SELECT 1 FROM gdt_jugadores WHERE activo = 1
          GROUP BY torneo_id, gdt_liga_id, nombre_normalizado, equipo_real
          HAVING COUNT(*) > 1
        )
      `).get();
      if (dups.n > 0) {
        console.error(`[migration Fase4] gdt_jugadores: ${dups.n} grupo(s) de duplicados — ABORTANDO (la tabla queda como estaba). Correr backend/diagnostico-fase4.js para detalle.`);
      } else {
        const cntAntes = db.prepare('SELECT COUNT(*) AS n FROM gdt_jugadores').get().n;
        db.exec('PRAGMA legacy_alter_table = ON');
        try {
          db.exec('DROP TABLE IF EXISTS gdt_jugadores_old');
          db.exec('ALTER TABLE gdt_jugadores RENAME TO gdt_jugadores_old');
          db.exec(`
            CREATE TABLE gdt_jugadores (
              id                  INTEGER PRIMARY KEY AUTOINCREMENT,
              torneo_id           INTEGER NOT NULL,
              gdt_liga_id         INTEGER REFERENCES gdt_ligas(id),
              nombre              TEXT NOT NULL,
              nombre_raw          TEXT,
              nombre_canonico     TEXT,
              nombre_normalizado  TEXT,
              equipo_real         TEXT NOT NULL,
              equipo_raw          TEXT,
              equipo_catalogo_id  INTEGER,
              posicion            TEXT,
              pais                TEXT,
              activo              INTEGER NOT NULL DEFAULT 1,
              estado              TEXT NOT NULL DEFAULT 'aprobado',
              merged_into         INTEGER,
              revisado_por        INTEGER,
              revisado_at         TEXT,
              FOREIGN KEY (torneo_id) REFERENCES torneos(id),
              UNIQUE(torneo_id, gdt_liga_id, nombre_normalizado, equipo_real)
            )
          `);
          db.exec(`
            INSERT INTO gdt_jugadores
              (id, torneo_id, gdt_liga_id, nombre, nombre_raw, nombre_canonico, nombre_normalizado,
               equipo_real, equipo_raw, equipo_catalogo_id, posicion, pais, activo, estado,
               merged_into, revisado_por, revisado_at)
            SELECT
               id, torneo_id, gdt_liga_id, nombre, nombre_raw, nombre_canonico, nombre_normalizado,
               equipo_real, equipo_raw, equipo_catalogo_id, posicion, pais, activo, estado,
               merged_into, revisado_por, revisado_at
            FROM gdt_jugadores_old
          `);
          db.exec('DROP TABLE gdt_jugadores_old');
          const cntDespues = db.prepare('SELECT COUNT(*) AS n FROM gdt_jugadores').get().n;
          if (cntAntes !== cntDespues) {
            console.error(`[migration Fase4] gdt_jugadores: ALERTA filas antes=${cntAntes} después=${cntDespues}`);
          } else {
            console.log(`[migration Fase4] gdt_jugadores: OK — ${cntDespues} fila(s) preservadas`);
          }
        } finally {
          db.exec('PRAGMA legacy_alter_table = OFF');
        }
      }
    }
  } catch (e) {
    try { db.exec('PRAGMA legacy_alter_table = OFF'); } catch(_) {}
    console.error('[migration Fase4] gdt_jugadores:', e.message);
  }

  // ── Fase 5: ligas GDT per-torneo ─────────────────────────────────────────────
  // Objetivo:
  //   gdt_ligas pasa de "global" a "per-torneo": agrega columna torneo_id NOT NULL
  //   + UNIQUE(torneo_id, nombre).
  //
  // Backfill: asigna todas las ligas existentes al torneo más antiguo del sistema
  // (en setups con un único torneo activo, esto es trivial y seguro).
  // Si NO hay torneos en la DB, no migra (aborta limpio, no rompe la tabla).
  // Idempotente: solo corre si el schema actual NO tiene la columna torneo_id.

  // F5-0: agregar columna torneo_id como nullable (no rompe inserts existentes).
  tryAdd('ALTER TABLE gdt_ligas ADD COLUMN torneo_id INTEGER REFERENCES torneos(id)', 'gdt_ligas.torneo_id');

  // F5-1: backfill defensivo — asigna ligas con torneo_id IS NULL al torneo más antiguo
  try {
    const nullsCount = db.prepare("SELECT COUNT(*) AS n FROM gdt_ligas WHERE torneo_id IS NULL").get().n;
    if (nullsCount > 0) {
      const primerTorneo = db.prepare("SELECT id FROM torneos ORDER BY id ASC LIMIT 1").get();
      if (primerTorneo) {
        const r = db.prepare(
          "UPDATE gdt_ligas SET torneo_id = ? WHERE torneo_id IS NULL"
        ).run(primerTorneo.id);
        console.log(`[migration Fase5] gdt_ligas: backfill torneo_id en ${r.changes} fila(s) → torneo id=${primerTorneo.id}`);
      } else {
        console.warn(`[migration Fase5] gdt_ligas: ${nullsCount} fila(s) con torneo_id NULL pero no hay torneos en la DB — Fase 5 postergada`);
      }
    }
  } catch (e) {
    console.warn('[migration Fase5] backfill torneo_id:', e.message);
  }

  // F5-2: migrar tabla a NOT NULL + UNIQUE(torneo_id, nombre)
  try {
    const ligSchema = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='gdt_ligas'"
    ).get();
    if (ligSchema && !ligSchema.sql.includes('UNIQUE(torneo_id, nombre)')) {
      // Verificación previa: que no queden NULLs (sino el INSERT...SELECT viola NOT NULL)
      const nullsPost = db.prepare("SELECT COUNT(*) AS n FROM gdt_ligas WHERE torneo_id IS NULL").get().n;
      if (nullsPost > 0) {
        console.error(`[migration Fase5] gdt_ligas: ${nullsPost} fila(s) con torneo_id NULL — ABORTANDO (creá un torneo primero o resolvé manualmente).`);
      } else {
        // Verificación duplicados que romperían el nuevo UNIQUE
        const dups = db.prepare(`
          SELECT COUNT(*) AS n FROM (
            SELECT 1 FROM gdt_ligas
            GROUP BY torneo_id, nombre
            HAVING COUNT(*) > 1
          )
        `).get();
        if (dups.n > 0) {
          console.error(`[migration Fase5] gdt_ligas: ${dups.n} grupo(s) de duplicados (torneo_id, nombre) — ABORTANDO.`);
        } else {
          const cntAntes = db.prepare('SELECT COUNT(*) AS n FROM gdt_ligas').get().n;
          db.exec('PRAGMA legacy_alter_table = ON');
          try {
            db.exec('DROP TABLE IF EXISTS gdt_ligas_old');
            db.exec('ALTER TABLE gdt_ligas RENAME TO gdt_ligas_old');
            db.exec(`
              CREATE TABLE gdt_ligas (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                torneo_id      INTEGER NOT NULL REFERENCES torneos(id),
                nombre         TEXT NOT NULL,
                descripcion    TEXT,
                formato        TEXT NOT NULL DEFAULT 'F11'
                                 CHECK(formato IN ('F5', 'F7', 'F11', 'otro')),
                pais_categoria TEXT,
                activo         INTEGER NOT NULL DEFAULT 1,
                es_default     INTEGER NOT NULL DEFAULT 0,
                importada_de_liga_id INTEGER REFERENCES gdt_ligas(id),
                created_at     TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(torneo_id, nombre)
              )
            `);
            db.exec(`
              INSERT INTO gdt_ligas
                (id, torneo_id, nombre, descripcion, formato, pais_categoria,
                 activo, es_default, importada_de_liga_id, created_at)
              SELECT
                 id, torneo_id, nombre, descripcion, formato, pais_categoria,
                 activo, es_default, importada_de_liga_id, created_at
              FROM gdt_ligas_old
            `);
            db.exec('DROP TABLE gdt_ligas_old');
            const cntDespues = db.prepare('SELECT COUNT(*) AS n FROM gdt_ligas').get().n;
            if (cntAntes !== cntDespues) {
              console.error(`[migration Fase5] gdt_ligas: ALERTA filas antes=${cntAntes} después=${cntDespues}`);
            } else {
              console.log(`[migration Fase5] gdt_ligas: OK — ${cntDespues} fila(s) preservadas (per-torneo)`);
            }
          } finally {
            db.exec('PRAGMA legacy_alter_table = OFF');
          }
        }
      }
    }
  } catch (e) {
    try { db.exec('PRAGMA legacy_alter_table = OFF'); } catch (_) {}
    console.error('[migration Fase5] gdt_ligas:', e.message);
  }

  // Fase 3 — Rondas de corrección automáticas
  // gdt_ventanas: agregar tipo para distinguir ventanas libres de ventanas de corrección
  tryAdd(
    "ALTER TABLE gdt_ventanas ADD COLUMN tipo TEXT NOT NULL DEFAULT 'libre' CHECK(tipo IN ('libre','correccion'))",
    'gdt_ventanas.tipo'
  );

  // gdt_equipo_presentacion: rastrea qué usuarios confirmaron su equipo (trigger para rondas)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS gdt_equipo_presentacion (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        torneo_id    INTEGER NOT NULL REFERENCES torneos(id),
        user_id      INTEGER NOT NULL REFERENCES users(id),
        liga_id      INTEGER NOT NULL REFERENCES gdt_ligas(id),
        presentado_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(torneo_id, user_id, liga_id)
      )
    `);
  } catch (e) {
    console.warn('[migration Fase3] gdt_equipo_presentacion:', e.message);
  }

  // ── Fase 1 Mundial ────────────────────────────────────────────────────────
  // torneos.tipo: 'prode_semestral' (default) | 'mundial_preguntas'.
  // SQLite no soporta ALTER TABLE ADD CHECK — validación se hace en backend.
  // Backfill automático: filas existentes quedan en 'prode_semestral' por DEFAULT.
  tryAdd(
    "ALTER TABLE torneos ADD COLUMN tipo TEXT NOT NULL DEFAULT 'prode_semestral'",
    'torneos.tipo'
  );

  // user_permisos: ampliar CHECK para incluir 'gestionar_mundial'.
  // SIN seed automático: solo superadmin tendrá el permiso por bypass en hasPermiso.
  // Admins que necesiten operar Mundial se asignan a mano desde /admin/permisos.
  // Idempotente: solo recrea si el CHECK actual NO incluye 'gestionar_mundial'.
  // Mismo patrón que la migración de 'gestionar_comidas' (líneas 451-489) pero sin seed.
  try {
    const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='user_permisos'").get();
    if (schema && !schema.sql.includes('gestionar_mundial')) {
      db.exec("PRAGMA legacy_alter_table = ON");
      db.exec("DROP TABLE IF EXISTS user_permisos_old_mundial");
      db.exec("ALTER TABLE user_permisos RENAME TO user_permisos_old_mundial");
      db.exec(`
        CREATE TABLE user_permisos (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          permiso TEXT NOT NULL CHECK(permiso IN (
            'crear_torneo',
            'editar_fecha',
            'cargar_resultados',
            'editar_tabla_mensual',
            'gestionar_multas',
            'gestionar_comidas',
            'gestionar_mundial'
          )),
          granted_by INTEGER REFERENCES users(id),
          created_at TEXT DEFAULT (datetime('now')),
          UNIQUE(user_id, permiso)
        )
      `);
      db.exec("INSERT INTO user_permisos SELECT * FROM user_permisos_old_mundial");
      db.exec("DROP TABLE user_permisos_old_mundial");
      db.exec("PRAGMA legacy_alter_table = OFF");
      console.log('[migration Fase1 Mundial] user_permisos: gestionar_mundial agregado al CHECK (sin seed automático)');
    }
  } catch(e) {
    try { db.exec("PRAGMA legacy_alter_table = OFF"); } catch(_) {}
    if (!e.message?.includes('already exists')) console.warn('[migration Fase1 Mundial] user_permisos gestionar_mundial:', e.message);
  }
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin', 'user', 'superadmin'))
    );

    CREATE TABLE IF NOT EXISTS torneos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      semestre TEXT NOT NULL,
      activo INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS torneo_jugadores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      torneo_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      FOREIGN KEY (torneo_id) REFERENCES torneos(id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(torneo_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS fechas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      torneo_id INTEGER NOT NULL,
      nombre TEXT NOT NULL,
      numero INTEGER NOT NULL,
      mes INTEGER NOT NULL,
      anio INTEGER NOT NULL,
      estado TEXT NOT NULL DEFAULT 'borrador'
        CHECK(estado IN ('borrador', 'abierta', 'cerrada', 'finalizada')),
      bloque1_nombre TEXT NOT NULL DEFAULT 'Bloque 1',
      bloque2_nombre TEXT NOT NULL DEFAULT 'Bloque 2',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (torneo_id) REFERENCES torneos(id)
    );

    CREATE TABLE IF NOT EXISTS eventos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fecha_id INTEGER NOT NULL,
      orden INTEGER NOT NULL CHECK(orden >= 1 AND orden <= 30),
      tipo TEXT NOT NULL DEFAULT 'partido' CHECK(tipo IN ('partido', 'pregunta')),
      evento TEXT,
      torneo_contexto TEXT,
      config_json TEXT,
      resultado_json TEXT,
      local TEXT,
      visitante TEXT,
      condicion TEXT,
      pts_local INTEGER NOT NULL DEFAULT 0,
      pts_empate INTEGER NOT NULL DEFAULT 0,
      pts_visitante INTEGER NOT NULL DEFAULT 0,
      pts_exacto INTEGER NOT NULL DEFAULT 0,
      resultado_local INTEGER,
      resultado_visitante INTEGER,
      lev_real TEXT CHECK(lev_real IN ('L', 'E', 'V') OR lev_real IS NULL),
      pregunta_texto TEXT,
      opciones TEXT,
      opcion_correcta TEXT,
      FOREIGN KEY (fecha_id) REFERENCES fechas(id),
      UNIQUE(fecha_id, orden)
    );

    CREATE TABLE IF NOT EXISTS pronosticos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      evento_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      goles_local INTEGER,
      goles_visitante INTEGER,
      lev_pronostico TEXT CHECK(lev_pronostico IN ('L', 'E', 'V') OR lev_pronostico IS NULL),
      opcion_elegida TEXT,
      puntos_obtenidos INTEGER DEFAULT 0,
      FOREIGN KEY (evento_id) REFERENCES eventos(id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(evento_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS cruces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fecha_id INTEGER NOT NULL,
      user1_id INTEGER NOT NULL,
      user2_id INTEGER NOT NULL,
      pts_tabla_a_u1 INTEGER DEFAULT 0,
      pts_tabla_a_u2 INTEGER DEFAULT 0,
      pts_tabla_b_u1 INTEGER DEFAULT 0,
      pts_tabla_b_u2 INTEGER DEFAULT 0,
      ganador_tabla_a TEXT,
      ganador_tabla_b TEXT,
      gdt_duelos_u1 INTEGER,
      gdt_duelos_u2 INTEGER,
      ganador_gdt TEXT,
      puntos_internos_u1 INTEGER DEFAULT 0,
      puntos_internos_u2 INTEGER DEFAULT 0,
      ganador_fecha TEXT,
      pts_torneo_u1 INTEGER DEFAULT 0,
      pts_torneo_u2 INTEGER DEFAULT 0,
      FOREIGN KEY (fecha_id) REFERENCES fechas(id),
      FOREIGN KEY (user1_id) REFERENCES users(id),
      FOREIGN KEY (user2_id) REFERENCES users(id),
      UNIQUE(fecha_id, user1_id, user2_id)
    );

    CREATE TABLE IF NOT EXISTS tabla_torneo (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      torneo_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      puntos INTEGER DEFAULT 0,
      pj INTEGER DEFAULT 0,
      victorias INTEGER DEFAULT 0,
      empates INTEGER DEFAULT 0,
      derrotas INTEGER DEFAULT 0,
      bonus INTEGER DEFAULT 0,
      FOREIGN KEY (torneo_id) REFERENCES torneos(id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(torneo_id, user_id)
    );

    -- GDT: catálogo de equipos reales válidos (admin lo define por torneo + liga GDT).
    -- Per-liga: el mismo equipo puede existir como filas independientes en distintas ligas.
    CREATE TABLE IF NOT EXISTS gdt_equipos_catalogo (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      torneo_id INTEGER NOT NULL,
      gdt_liga_id INTEGER REFERENCES gdt_ligas(id),
      nombre TEXT NOT NULL,
      nombre_normalizado TEXT NOT NULL,
      pais TEXT,
      activo INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (torneo_id) REFERENCES torneos(id),
      UNIQUE(torneo_id, gdt_liga_id, nombre_normalizado)
    );

    -- GDT: jugadores reales (per-torneo + per-liga, construido progresivamente).
    -- Per-liga: el mismo jugador (nombre + equipo_real) puede existir como filas
    -- independientes en distintas ligas. UNIQUE usa nombre_normalizado para dedup
    -- consistente con la lógica del código.
    CREATE TABLE IF NOT EXISTS gdt_jugadores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      torneo_id INTEGER NOT NULL,
      gdt_liga_id INTEGER REFERENCES gdt_ligas(id),
      nombre TEXT NOT NULL,
      nombre_normalizado TEXT,
      equipo_real TEXT NOT NULL,
      FOREIGN KEY (torneo_id) REFERENCES torneos(id),
      UNIQUE(torneo_id, gdt_liga_id, nombre_normalizado, equipo_real)
    );

    -- GDT: equipo de cada usuario (11 slots, uno por torneo)
    CREATE TABLE IF NOT EXISTS gdt_equipos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      torneo_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      slot TEXT NOT NULL,
      jugador_id INTEGER NOT NULL,
      FOREIGN KEY (torneo_id) REFERENCES torneos(id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (jugador_id) REFERENCES gdt_jugadores(id),
      UNIQUE(torneo_id, user_id, slot),
      UNIQUE(torneo_id, user_id, jugador_id)
    );

    -- GDT: estado de validación del equipo de cada usuario
    CREATE TABLE IF NOT EXISTS gdt_equipo_estado (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      torneo_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      estado TEXT NOT NULL DEFAULT 'valido'
        CHECK(estado IN ('valido', 'observado', 'requiere_correccion')),
      observaciones TEXT,
      motivo_admin TEXT,
      invalidado_por INTEGER REFERENCES users(id),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (torneo_id) REFERENCES torneos(id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(torneo_id, user_id)
    );

    -- GDT: puntajes de jugadores por fecha (cargados por admin)
    CREATE TABLE IF NOT EXISTS gdt_puntajes_fecha (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      torneo_id INTEGER NOT NULL,
      fecha_id INTEGER NOT NULL,
      jugador_id INTEGER NOT NULL,
      puntos INTEGER NOT NULL DEFAULT 0,
      jugo INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (torneo_id) REFERENCES torneos(id),
      FOREIGN KEY (fecha_id) REFERENCES fechas(id),
      FOREIGN KEY (jugador_id) REFERENCES gdt_jugadores(id),
      UNIQUE(fecha_id, jugador_id)
    );

    -- GDT: ventanas de cambios (admin abre/cierra)
    CREATE TABLE IF NOT EXISTS gdt_ventanas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      torneo_id INTEGER NOT NULL,
      nombre TEXT NOT NULL,
      cambios_por_usuario INTEGER NOT NULL DEFAULT 2,
      estado TEXT NOT NULL DEFAULT 'cerrada' CHECK(estado IN ('abierta', 'cerrada')),
      abierta_por INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now')),
      cerrada_at TEXT,
      FOREIGN KEY (torneo_id) REFERENCES torneos(id)
    );

    -- GDT: registro de cada cambio individual en una ventana
    -- Un "cambio" = sacar un jugador de un slot y poner otro.
    -- jugador_anterior_id puede ser NULL si el slot estaba vacío.
    CREATE TABLE IF NOT EXISTS gdt_cambios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ventana_id INTEGER NOT NULL REFERENCES gdt_ventanas(id),
      torneo_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id),
      slot TEXT NOT NULL,
      jugador_anterior_id INTEGER REFERENCES gdt_jugadores(id),
      jugador_nuevo_id INTEGER NOT NULL REFERENCES gdt_jugadores(id),
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (torneo_id) REFERENCES torneos(id)
    );

    -- GDT: ligas / competencias (PER-TORNEO). Cada torneo puede tener varias ligas.
    -- Cada fecha puede elegir una liga del torneo; si no, se usa la default (es_default = 1)
    -- DEL TORNEO. Cuando empieza un torneo nuevo, hay que crear sus ligas explícitamente.
    CREATE TABLE IF NOT EXISTS gdt_ligas (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      torneo_id      INTEGER NOT NULL REFERENCES torneos(id),
      nombre         TEXT NOT NULL,
      descripcion    TEXT,
      formato        TEXT NOT NULL DEFAULT 'F11'
                       CHECK(formato IN ('F5', 'F7', 'F11', 'otro')),
      pais_categoria TEXT,
      activo         INTEGER NOT NULL DEFAULT 1,
      es_default     INTEGER NOT NULL DEFAULT 0,
      importada_de_liga_id INTEGER REFERENCES gdt_ligas(id),
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(torneo_id, nombre)
    );

    -- GDT: configuración de slots por liga (ad hoc — reemplaza formatos hardcodeados).
    -- Cada fila define un slot válido para una liga: nombre, posición esperada y orden de display.
    -- El total de jugadores de una liga = COUNT(*) en esta tabla para ese gdt_liga_id.
    -- Los slots no se pueden modificar si la liga ya tiene equipos/snapshots/puntajes/cambios.
    -- La columna formato de gdt_ligas queda como campo legacy ignorado.
    CREATE TABLE IF NOT EXISTS gdt_liga_slots (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      gdt_liga_id INTEGER NOT NULL REFERENCES gdt_ligas(id),
      slot        TEXT NOT NULL,
      posicion    TEXT NOT NULL CHECK(posicion IN ('ARQ', 'DEF', 'MED', 'DEL')),
      orden       INTEGER NOT NULL DEFAULT 0,
      UNIQUE(gdt_liga_id, slot)
    );

    -- GDT: snapshot del equipo de cada usuario al momento de una fecha.
    -- Se crea la primera vez que se calculan resultados GDT de esa fecha.
    -- Inmutable: una vez creado, nunca se sobrescribe (idempotente).
    -- Garantiza que cambios de ventanas posteriores no alteren resultados historicos.
    CREATE TABLE IF NOT EXISTS gdt_equipos_snapshot (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      fecha_id    INTEGER NOT NULL REFERENCES fechas(id),
      torneo_id   INTEGER NOT NULL REFERENCES torneos(id),
      gdt_liga_id INTEGER REFERENCES gdt_ligas(id),
      user_id     INTEGER NOT NULL REFERENCES users(id),
      slot        TEXT NOT NULL,
      jugador_id  INTEGER REFERENCES gdt_jugadores(id),
      created_at  TEXT DEFAULT (datetime('now')),
      UNIQUE(fecha_id, user_id, slot)
    );
  `);

  // ── Fase 1 Mundial: tablas del módulo Mundial ────────────────────────────
  // Todo el módulo Mundial vive en tablas con prefijo 'mundial_*'.
  // Aislamiento total: no comparte tablas con el Prode (eventos, pronosticos,
  // cruces, tabla_torneo, gdt_*, comidas_*).
  // Sin TC Blue: la liquidación es en USD; ARS por premio es manual y nullable.
  db.exec(`
    -- Config global por torneo Mundial (un row por torneo).
    -- Máquina de estados forward-only en Fase 1:
    --   configuracion → abierto → cerrado → grupos_jugados → cambios_abiertos →
    --   cambios_cerrados → resultados → finalizado
    CREATE TABLE IF NOT EXISTS mundial_config (
      torneo_id           INTEGER PRIMARY KEY REFERENCES torneos(id),
      estado              TEXT NOT NULL DEFAULT 'configuracion'
        CHECK(estado IN (
          'configuracion','abierto','cerrado',
          'grupos_jugados','cambios_abiertos','cambios_cerrados',
          'resultados','finalizado'
        )),
      costo_cambio_usd    INTEGER NOT NULL DEFAULT 30,
      cambios_por_usuario INTEGER NOT NULL DEFAULT 3,
      deadline_carga      TEXT,
      reglas_json         TEXT,
      updated_by          INTEGER REFERENCES users(id),
      updated_at          TEXT DEFAULT (datetime('now'))
    );

    -- Catálogo de equipos del Mundial (per-torneo).
    -- Permite autocomplete y valida que las respuestas con equipo apunten a uno real.
    CREATE TABLE IF NOT EXISTS mundial_equipos_catalogo (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      torneo_id INTEGER NOT NULL REFERENCES torneos(id),
      codigo    TEXT NOT NULL,
      nombre    TEXT NOT NULL,
      grupo     TEXT,
      activo    INTEGER NOT NULL DEFAULT 1,
      UNIQUE(torneo_id, codigo)
    );

    -- Preguntas del torneo Mundial (N configurable, no hardcoded a 36).
    -- config_json define shape y puntajes según tipo_pregunta (ver doc Fase 1).
    CREATE TABLE IF NOT EXISTS mundial_preguntas (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      torneo_id     INTEGER NOT NULL REFERENCES torneos(id),
      numero        INTEGER NOT NULL,
      enunciado     TEXT NOT NULL,
      aclaracion    TEXT,
      tipo_pregunta TEXT NOT NULL
        CHECK(tipo_pregunta IN (
          'opcion_unica',
          'equipo_categoria',
          'instancia_eliminacion',
          'numero_exacto',
          'numero_por_banda',
          'multi_equipo',
          'respuesta_manual',
          'regla_especial'
        )),
      config_json   TEXT NOT NULL,
      orden_display INTEGER NOT NULL DEFAULT 0,
      activa        INTEGER NOT NULL DEFAULT 1,
      UNIQUE(torneo_id, numero)
    );

    -- Resultados reales cargados por admin (uno por pregunta).
    CREATE TABLE IF NOT EXISTS mundial_resultados (
      pregunta_id    INTEGER PRIMARY KEY REFERENCES mundial_preguntas(id),
      resultado_json TEXT NOT NULL,
      cargado_por    INTEGER REFERENCES users(id),
      cargado_at     TEXT DEFAULT (datetime('now'))
    );

    -- Respuestas de usuarios (una por pregunta+user).
    CREATE TABLE IF NOT EXISTS mundial_respuestas_usuario (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      pregunta_id    INTEGER NOT NULL REFERENCES mundial_preguntas(id),
      user_id        INTEGER NOT NULL REFERENCES users(id),
      respuesta_json TEXT NOT NULL,
      updated_at     TEXT DEFAULT (datetime('now')),
      UNIQUE(pregunta_id, user_id)
    );

    -- Premios por posición.
    -- usd puede ser negativo (premio negativo = paga al pozo).
    -- ars_manual es opcional y nullable: el admin lo carga libremente.
    -- SIN cálculo automático desde TC (decisión explícita: sin TC Blue).
    CREATE TABLE IF NOT EXISTS mundial_premios (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      torneo_id  INTEGER NOT NULL REFERENCES torneos(id),
      posicion   INTEGER NOT NULL,
      usd        INTEGER NOT NULL,
      ars_manual INTEGER,
      UNIQUE(torneo_id, posicion)
    );

    -- Ventana de cambios post-grupos.
    -- Estados:
    --   cerrada   = aún no se abrió (default)
    --   abierta   = users habilitados cargan cambios; cambios NO visibles a otros
    --   publicada = cambios visibles a todos; mundial_respuestas_usuario ya pisado
    CREATE TABLE IF NOT EXISTS mundial_ventanas_cambios (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      torneo_id           INTEGER NOT NULL REFERENCES torneos(id),
      nombre              TEXT NOT NULL DEFAULT 'Cambios post-grupos',
      costo_usd           INTEGER NOT NULL,
      cambios_por_usuario INTEGER NOT NULL,
      estado              TEXT NOT NULL DEFAULT 'cerrada'
        CHECK(estado IN ('cerrada','abierta','publicada')),
      abierta_at          TEXT,
      cerrada_at          TEXT,
      publicada_at        TEXT,
      abierta_por         INTEGER REFERENCES users(id),
      publicada_por       INTEGER REFERENCES users(id)
    );

    -- Habilitación de usuarios a una ventana de cambios.
    -- No todos los users tienen derecho — el admin habilita explícitamente.
    CREATE TABLE IF NOT EXISTS mundial_ventana_habilitados (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      ventana_id     INTEGER NOT NULL REFERENCES mundial_ventanas_cambios(id),
      user_id        INTEGER NOT NULL REFERENCES users(id),
      habilitado_por INTEGER NOT NULL REFERENCES users(id),
      habilitado_at  TEXT DEFAULT (datetime('now')),
      UNIQUE(ventana_id, user_id)
    );

    -- Trazabilidad de cambios individuales.
    -- publicado=0 mientras la ventana está abierta o cerrada (no visible).
    -- publicado=1 cuando la ventana pasa a 'publicada' (visible a todos y aplicado).
    CREATE TABLE IF NOT EXISTS mundial_cambios_respuesta (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      ventana_id              INTEGER NOT NULL REFERENCES mundial_ventanas_cambios(id),
      torneo_id               INTEGER NOT NULL REFERENCES torneos(id),
      user_id                 INTEGER NOT NULL REFERENCES users(id),
      pregunta_id             INTEGER NOT NULL REFERENCES mundial_preguntas(id),
      respuesta_anterior_json TEXT NOT NULL,
      respuesta_nueva_json    TEXT NOT NULL,
      costo_usd               INTEGER NOT NULL,
      publicado               INTEGER NOT NULL DEFAULT 0,
      created_at              TEXT DEFAULT (datetime('now'))
    );
  `);
}

module.exports = { getDb };
