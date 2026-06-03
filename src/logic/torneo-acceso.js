/**
 * torneo-acceso.js — Helpers de visibilidad por torneo.
 *
 * Regla central:
 *   - admin/superadmin: bypass total. Ven todo y pueden entrar a cualquier torneo.
 *   - usuario común:    solo ve torneos donde está asignado en `torneo_jugadores`.
 *
 * Funciones puras (excepto por lectura de DB). Sin side-effects, sin throw.
 * Diseñadas para usarse desde rutas:
 *
 *   - usuarioPuedeAccederTorneo(db, torneoId, user): boolean — guard por endpoint.
 *   - torneoIdsAccesibles(db, user): Set<number> — para filtrar listados.
 *   - filtrarTorneosPorAcceso(torneos, db, user): array — convenience wrapper.
 *
 * No depende de middlewares ni express. Trabaja con (db, user) puros.
 *
 * NO se gestiona acceso a través de permisos genéricos (user_permisos): la
 * única fuente de verdad es la pivot torneo_jugadores. Si querés cambiar
 * eso en el futuro, modificás acá y se propaga.
 */

function esAdminOSuperadmin(user) {
  if (!user) return false;
  return user.role === 'admin' || user.role === 'superadmin';
}

/**
 * Devuelve true si el `user` puede ver/entrar al torneo `torneoId`.
 * Admin y superadmin siempre pueden. Resto: solo si está en torneo_jugadores.
 *
 * @param {*} db        instancia DatabaseSync
 * @param {number} torneoId
 * @param {object} user req.user (puede ser null/undefined)
 * @returns {boolean}
 */
function usuarioPuedeAccederTorneo(db, torneoId, user) {
  if (!user || !Number.isFinite(torneoId) || torneoId <= 0) return false;
  if (esAdminOSuperadmin(user)) return true;
  const row = db.prepare(
    'SELECT 1 FROM torneo_jugadores WHERE torneo_id = ? AND user_id = ? LIMIT 1'
  ).get(torneoId, user.id);
  return !!row;
}

/**
 * Devuelve un Set con los ids de torneos a los que el `user` puede acceder.
 * Para admin/superadmin devuelve null como señal "todos" (el caller decide
 * no filtrar). Para users comunes hace UN query y devuelve el set.
 *
 * El caller suele querer hacer algo como:
 *   const allowed = torneoIdsAccesibles(db, user);
 *   const lista   = (allowed == null) ? todos : todos.filter(t => allowed.has(t.id));
 *
 * @param {*} db
 * @param {object} user
 * @returns {Set<number>|null}  null = sin filtro (admin)
 */
function torneoIdsAccesibles(db, user) {
  if (!user) return new Set();
  if (esAdminOSuperadmin(user)) return null;
  const rows = db.prepare(
    'SELECT torneo_id FROM torneo_jugadores WHERE user_id = ?'
  ).all(user.id);
  return new Set(rows.map(r => r.torneo_id));
}

/**
 * Convenience: dado un array de torneos y un user, devuelve el subset visible.
 * Admin/superadmin: array sin cambios.
 *
 * @param {Array} torneos
 * @param {*} db
 * @param {object} user
 * @returns {Array}
 */
function filtrarTorneosPorAcceso(torneos, db, user) {
  if (!Array.isArray(torneos)) return [];
  const allowed = torneoIdsAccesibles(db, user);
  if (allowed === null) return torneos; // admin
  return torneos.filter(t => allowed.has(t.id));
}

module.exports = {
  usuarioPuedeAccederTorneo,
  torneoIdsAccesibles,
  filtrarTorneosPorAcceso,
  esAdminOSuperadmin,
};
