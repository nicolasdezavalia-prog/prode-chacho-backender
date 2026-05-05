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
  // Solo inserta si no existe ninguna liga con es_default = 1 (idempotente)
  try {
    const ligaDefaultExiste = db.prepare(
      "SELECT 1 FROM gdt_ligas WHERE es_default = 1 LIMIT 1"
    ).get();
    if (!ligaDefaultExiste) {
      db.prepare(
        "INSERT INTO gdt_ligas (nombre, descripcion, formato, pais_categoria, activo, es_default) VALUES (?, ?, ?, ?, 1, 1)"
      ).run('GDT Argentina', 'Liga GDT principal — Argentina', 'F11', 'Argentina');
      console.log('[migration] gdt_ligas: seed "GDT Argentina" creado como liga default');
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

    -- GDT: catálogo de equipos reales válidos (admin lo define por torneo)
    CREATE TABLE IF NOT EXISTS gdt_equipos_catalogo (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      torneo_id INTEGER NOT NULL,
      nombre TEXT NOT NULL,
      nombre_normalizado TEXT NOT NULL,
      pais TEXT,
      activo INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (torneo_id) REFERENCES torneos(id),
      UNIQUE(torneo_id, nombre_normalizado)
    );

    -- GDT: jugadores reales (normalizados por torneo, construido progresivamente)
    CREATE TABLE IF NOT EXISTS gdt_jugadores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      torneo_id INTEGER NOT NULL,
      nombre TEXT NOT NULL,
      equipo_real TEXT NOT NULL,
      FOREIGN KEY (torneo_id) REFERENCES torneos(id),
      UNIQUE(torneo_id, nombre, equipo_real)
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

    -- GDT: ligas / competencias (permite múltiples contextos GDT por torneo)
    -- Cada fecha puede elegir una liga; si no elige, se usa la que tiene es_default = 1.
    CREATE TABLE IF NOT EXISTS gdt_ligas (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre         TEXT NOT NULL,
      descripcion    TEXT,
      formato        TEXT NOT NULL DEFAULT 'F11'
                       CHECK(formato IN ('F5', 'F7', 'F11', 'otro')),
      pais_categoria TEXT,
      activo         INTEGER NOT NULL DEFAULT 1,
      es_default     INTEGER NOT NULL DEFAULT 0,
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
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
}

module.exports = { getDb };
