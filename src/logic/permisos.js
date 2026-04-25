/**
 * permisos.js — lógica de permisos granulares por usuario.
 *
 * Reglas:
 *  - superadmin siempre tiene acceso total (no consulta la tabla).
 *  - admin / user: se consulta user_permisos.
 *  - La tabla user_permisos es la fuente de verdad para roles no-superadmin.
 *
 * Permisos disponibles:
 *  crear_torneo        — crear nuevos torneos
 *  editar_fecha        — editar/abrir/cerrar fechas
 *  cargar_resultados   — cargar resultados de eventos
 *  editar_tabla_mensual — editar cierre de tabla mensual
 *  gestionar_multas    — crear/editar movimientos económicos (multas)
 *  gestionar_comidas   — todas las acciones admin del módulo Comidas
 */

const { getDb } = require('../db');

const PERMISOS = [
  'crear_torneo',
  'editar_fecha',
  'cargar_resultados',
  'editar_tabla_mensual',
  'gestionar_multas',
  'gestionar_comidas',
];

/**
 * Devuelve true si el usuario tiene el permiso indicado.
 * @param {number} userId
 * @param {string} role  — 'superadmin' | 'admin' | 'user'
 * @param {string} permiso
 * @returns {boolean}
 */
function hasPermiso(userId, role, permiso) {
  if (role === 'superadmin') return true;
  const db = getDb();
  const row = db.prepare(
    'SELECT 1 FROM user_permisos WHERE user_id = ? AND permiso = ? LIMIT 1'
  ).get(userId, permiso);
  return !!row;
}

/**
 * Devuelve todos los permisos activos de un usuario.
 * Para superadmin devuelve todos los permisos definidos.
 * @param {number} userId
 * @param {string} role
 * @returns {string[]}
 */
function getPermisosDeUsuario(userId, role) {
  if (role === 'superadmin') return [...PERMISOS];
  const db = getDb();
  const rows = db.prepare(
    'SELECT permiso FROM user_permisos WHERE user_id = ?'
  ).all(userId);
  return rows.map(r => r.permiso);
}

/**
 * Otorga un permiso a un usuario.
 * @param {number} userId
 * @param {string} permiso
 * @param {number|null} grantedBy  — id del superadmin que lo otorga
 */
function grantPermiso(userId, permiso, grantedBy = null) {
  if (!PERMISOS.includes(permiso)) {
    throw new Error(`Permiso desconocido: ${permiso}`);
  }
  const db = getDb();
  db.prepare(
    'INSERT OR IGNORE INTO user_permisos (user_id, permiso, granted_by) VALUES (?, ?, ?)'
  ).run(userId, permiso, grantedBy);
}

/**
 * Revoca un permiso de un usuario.
 * @param {number} userId
 * @param {string} permiso
 */
function revokePermiso(userId, permiso) {
  if (!PERMISOS.includes(permiso)) {
    throw new Error(`Permiso desconocido: ${permiso}`);
  }
  const db = getDb();
  db.prepare(
    'DELETE FROM user_permisos WHERE user_id = ? AND permiso = ?'
  ).run(userId, permiso);
}

/**
 * Reemplaza el set completo de permisos de un usuario.
 * @param {number} userId
 * @param {string[]} nuevosPermisos
 * @param {number|null} grantedBy
 */
function setPermisosDeUsuario(userId, nuevosPermisos, grantedBy = null) {
  const invalidos = nuevosPermisos.filter(p => !PERMISOS.includes(p));
  if (invalidos.length) {
    throw new Error(`Permisos desconocidos: ${invalidos.join(', ')}`);
  }
  const db = getDb();
  const del = db.prepare('DELETE FROM user_permisos WHERE user_id = ?');
  const ins = db.prepare(
    'INSERT OR IGNORE INTO user_permisos (user_id, permiso, granted_by) VALUES (?, ?, ?)'
  );
  try {
    db.exec('BEGIN');
    del.run(userId);
    for (const p of nuevosPermisos) {
      ins.run(userId, p, grantedBy);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = {
  PERMISOS,
  hasPermiso,
  getPermisosDeUsuario,
  grantPermiso,
  revokePermiso,
  setPermisosDeUsuario,
};
