const jwt = require('jsonwebtoken');
const { hasPermiso } = require('../logic/permisos');

const JWT_SECRET = process.env.JWT_SECRET || 'prode-chacho-secret-2024';

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

function adminMiddleware(req, res, next) {
  if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'superadmin')) {
    return res.status(403).json({ error: 'Solo admins pueden realizar esta acción' });
  }
  next();
}

/**
 * Middleware de permiso granular.
 * Uso: router.post('/ruta', authMiddleware, requirePermiso('crear_torneo'), handler)
 *
 * - superadmin: pasa siempre.
 * - admin / user: consulta user_permisos. Si no tiene el permiso -> 403.
 *
 * @param {string} permiso
 */
function requirePermiso(permiso) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'No autorizado' });
    }
    if (hasPermiso(req.user.id, req.user.role, permiso)) {
      return next();
    }
    return res.status(403).json({
      error: 'Permiso insuficiente',
      permiso_requerido: permiso,
    });
  };
}

module.exports = { authMiddleware, adminMiddleware, requirePermiso, JWT_SECRET };
