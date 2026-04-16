/**
 * Script de setup inicial: crea usuario admin y un torneo de prueba.
 *
 * Usa el mismo módulo de DB que el resto del backend (node:sqlite nativo).
 * No requiere dependencias externas adicionales.
 *
 * Correr con: node seed.js
 */
const { getDb } = require('./src/db');
const bcrypt = require('bcryptjs');

async function seed() {
  // getDb() inicializa el schema automáticamente si no existe
  const db = getDb();

  console.log('🌱 Iniciando seed...\n');

  // ── Admin ──────────────────────────────────────────────
  const adminPass = await bcrypt.hash('admin123', 10);
  try {
    const admin = db.prepare(
      "INSERT OR IGNORE INTO users (nombre, email, password, role) VALUES (?, ?, ?, 'admin')"
    ).run('Chacho (Admin)', 'admin@prode.com', adminPass);
    if (admin.changes) {
      console.log('✅ Admin creado:     admin@prode.com / admin123');
    } else {
      console.log('ℹ️  Admin ya existe');
    }
  } catch (e) {
    console.error('Error creando admin:', e.message);
  }

  // ── Jugadores de prueba ────────────────────────────────
  const jugadores = [
    { nombre: 'Nico',   email: 'nico@prode.com'   },
    { nombre: 'Teo',    email: 'teo@prode.com'    },
    { nombre: 'Marcos', email: 'marcos@prode.com' },
    { nombre: 'Lucas',  email: 'lucas@prode.com'  },
  ];

  const userPass = await bcrypt.hash('prode123', 10);
  const userIds = [];

  for (const j of jugadores) {
    try {
      const res = db.prepare(
        "INSERT OR IGNORE INTO users (nombre, email, password, role) VALUES (?, ?, ?, 'user')"
      ).run(j.nombre, j.email, userPass);
      if (res.changes) console.log(`✅ Jugador creado:   ${j.email} / prode123`);
    } catch (e) { /* ya existe */ }

    const u = db.prepare('SELECT id FROM users WHERE email = ?').get(j.email);
    if (u) userIds.push(Number(u.id));
  }

  // ── Torneo ─────────────────────────────────────────────
  let torneoId;
  const torneoExistente = db.prepare(
    "SELECT id FROM torneos WHERE nombre = 'Torneo 2025 Semestre 1'"
  ).get();

  if (!torneoExistente) {
    const t = db.prepare(
      "INSERT INTO torneos (nombre, semestre) VALUES ('Torneo 2025 Semestre 1', '2025-S1')"
    ).run();
    torneoId = Number(t.lastInsertRowid);
    console.log('\n✅ Torneo creado:    Torneo 2025 Semestre 1');
  } else {
    torneoId = Number(torneoExistente.id);
    console.log('\nℹ️  Torneo ya existe');
  }

  // ── Asociar jugadores al torneo ────────────────────────
  const adminUser = db.prepare("SELECT id FROM users WHERE email = 'admin@prode.com'").get();
  const todosIds = adminUser ? [Number(adminUser.id), ...userIds] : userIds;

  for (const uid of todosIds) {
    try {
      db.prepare(
        'INSERT OR IGNORE INTO torneo_jugadores (torneo_id, user_id) VALUES (?, ?)'
      ).run(torneoId, uid);
      db.prepare(
        'INSERT OR IGNORE INTO tabla_torneo (torneo_id, user_id) VALUES (?, ?)'
      ).run(torneoId, uid);
    } catch (e) { /* ya existe */ }
  }
  console.log(`✅ ${todosIds.length} jugadores en el torneo\n`);

  // ── Resumen ────────────────────────────────────────────
  console.log('🎉 Seed completado!\n');
  console.log('Credenciales:');
  console.log('  Admin:      admin@prode.com  / admin123');
  console.log('  Jugadores:  nico@prode.com   / prode123');
  console.log('              teo@prode.com    / prode123');
  console.log('              marcos@prode.com / prode123');
  console.log('              lucas@prode.com  / prode123');
  console.log('\nSiguiente paso: npm run dev\n');
}

seed().catch(console.error);
