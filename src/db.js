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
    db.exec("PRAGMA foreign_keys = ON");
    initSchema();
    runMigrations();
  }
  return db;
}

function runMigrations() {
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
      db.exec("PRAGMA foreign_keys = ON");
      console.log('[migration] users: added superadmin role');
    }
  } catch (e) {
    db.exec("PRAGMA foreign_keys = ON");
    if (!e.message?.includes('already exists')) console.warn('[migration] superadmin role:', e.message);
  }

  // Pronósticos: timestamp de último envío
  tryAdd('ALTER TABLE pronosticos ADD COLUMN updated_at TEXT', 'pronosticos.updated_at');

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
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin', 'user'))
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
      slot TEXT NOT NULL CHECK(slot IN ('ARQ','DEF1','DEF2','DEF3','DEF4','MED1','MED2','MED3','MED4','DEL1','DEL2')),
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
  `);
}

module.exports = { getDb };
