/**
 * Dataset oficial de los 48 equipos del Mundial 2026.
 *
 * Fuente: sorteo oficial Mundial 2026, provisto por el usuario el 2026-06-01.
 * Cero plausibilidad ni placeholders: los 48 grupos están confirmados con
 * equipos reales.
 *
 * Este array es la SEMILLA del endpoint:
 *   POST /api/mundial/:torneoId/equipos/seed-mundial-2026
 *
 * Convención de códigos:
 *   - Spanish-friendly donde corresponde: ALE (Alemania), ING (Inglaterra),
 *     HOL (Países Bajos), JAP (Japón), COR (Corea), BOS (Bosnia), SUE (Suecia).
 *   - Códigos FIFA donde no hay alternativa Spanish más natural.
 *   - Propuestas para los ambiguos: CHE (Chequia, no CZE), CAB (Cabo Verde, no CPV).
 *   - RSA (Sudáfrica), KSA (Arabia Saudí) — preferidos por el usuario.
 *
 * Estructura por fila:
 *   - codigo:  string corto en MAYÚSCULAS (2-10 chars; en la práctica todos 3).
 *   - nombre:  nombre del país en español (tal como aparece en el sorteo).
 *   - emoji:   bandera (campo aparte, NO pegado al nombre ni al código).
 *   - grupo:   'A'..'L' (12 grupos × 4 equipos = 48).
 *   - activo:  1 (default); el admin lo puede pasar a 0 desde la UI.
 *
 * IMPORTANTE: esta SEMILLA es editable desde la UI admin mientras el torneo
 * esté en estado 'configuracion' o 'abierto'. No es verdad inmutable.
 */
module.exports = [
  // ── Grupo A ─────────────────────────────────────────────────────────────
  { codigo: 'MEX', nombre: 'México',              emoji: '🇲🇽', grupo: 'A', activo: 1 },
  { codigo: 'RSA', nombre: 'Sudáfrica',           emoji: '🇿🇦', grupo: 'A', activo: 1 },
  { codigo: 'COR', nombre: 'República de Corea',  emoji: '🇰🇷', grupo: 'A', activo: 1 },
  { codigo: 'CHE', nombre: 'República Checa',     emoji: '🇨🇿', grupo: 'A', activo: 1 },

  // ── Grupo B ─────────────────────────────────────────────────────────────
  { codigo: 'CAN', nombre: 'Canadá',                emoji: '🇨🇦', grupo: 'B', activo: 1 },
  { codigo: 'BOS', nombre: 'Bosnia y Herzegovina',  emoji: '🇧🇦', grupo: 'B', activo: 1 },
  { codigo: 'QAT', nombre: 'Catar',                 emoji: '🇶🇦', grupo: 'B', activo: 1 },
  { codigo: 'SUI', nombre: 'Suiza',                 emoji: '🇨🇭', grupo: 'B', activo: 1 },

  // ── Grupo C ─────────────────────────────────────────────────────────────
  { codigo: 'BRA', nombre: 'Brasil',     emoji: '🇧🇷',           grupo: 'C', activo: 1 },
  { codigo: 'MAR', nombre: 'Marruecos',  emoji: '🇲🇦',           grupo: 'C', activo: 1 },
  { codigo: 'HAI', nombre: 'Haití',      emoji: '🇭🇹',           grupo: 'C', activo: 1 },
  { codigo: 'SCO', nombre: 'Escocia',    emoji: '🏴󠁧󠁢󠁳󠁣󠁴󠁿',  grupo: 'C', activo: 1 },

  // ── Grupo D ─────────────────────────────────────────────────────────────
  { codigo: 'USA', nombre: 'Estados Unidos', emoji: '🇺🇸', grupo: 'D', activo: 1 },
  { codigo: 'PAR', nombre: 'Paraguay',       emoji: '🇵🇾', grupo: 'D', activo: 1 },
  { codigo: 'AUS', nombre: 'Australia',      emoji: '🇦🇺', grupo: 'D', activo: 1 },
  { codigo: 'TUR', nombre: 'Turquía',        emoji: '🇹🇷', grupo: 'D', activo: 1 },

  // ── Grupo E ─────────────────────────────────────────────────────────────
  { codigo: 'ALE', nombre: 'Alemania',         emoji: '🇩🇪', grupo: 'E', activo: 1 },
  { codigo: 'CUR', nombre: 'Curazao',          emoji: '🇨🇼', grupo: 'E', activo: 1 },
  { codigo: 'CIV', nombre: 'Costa de Marfil',  emoji: '🇨🇮', grupo: 'E', activo: 1 },
  { codigo: 'ECU', nombre: 'Ecuador',          emoji: '🇪🇨', grupo: 'E', activo: 1 },

  // ── Grupo F ─────────────────────────────────────────────────────────────
  { codigo: 'HOL', nombre: 'Países Bajos', emoji: '🇳🇱', grupo: 'F', activo: 1 },
  { codigo: 'JAP', nombre: 'Japón',        emoji: '🇯🇵', grupo: 'F', activo: 1 },
  { codigo: 'SUE', nombre: 'Suecia',       emoji: '🇸🇪', grupo: 'F', activo: 1 },
  { codigo: 'TUN', nombre: 'Túnez',        emoji: '🇹🇳', grupo: 'F', activo: 1 },

  // ── Grupo G ─────────────────────────────────────────────────────────────
  { codigo: 'BEL', nombre: 'Bélgica',         emoji: '🇧🇪', grupo: 'G', activo: 1 },
  { codigo: 'EGY', nombre: 'Egipto',          emoji: '🇪🇬', grupo: 'G', activo: 1 },
  { codigo: 'IRN', nombre: 'RI de Irán',      emoji: '🇮🇷', grupo: 'G', activo: 1 },
  { codigo: 'NZL', nombre: 'Nueva Zelanda',   emoji: '🇳🇿', grupo: 'G', activo: 1 },

  // ── Grupo H ─────────────────────────────────────────────────────────────
  { codigo: 'ESP', nombre: 'España',         emoji: '🇪🇸', grupo: 'H', activo: 1 },
  { codigo: 'CAB', nombre: 'Cabo Verde',     emoji: '🇨🇻', grupo: 'H', activo: 1 },
  { codigo: 'KSA', nombre: 'Arabia Saudí',   emoji: '🇸🇦', grupo: 'H', activo: 1 },
  { codigo: 'URU', nombre: 'Uruguay',        emoji: '🇺🇾', grupo: 'H', activo: 1 },

  // ── Grupo I ─────────────────────────────────────────────────────────────
  { codigo: 'FRA', nombre: 'Francia',  emoji: '🇫🇷', grupo: 'I', activo: 1 },
  { codigo: 'SEN', nombre: 'Senegal',  emoji: '🇸🇳', grupo: 'I', activo: 1 },
  { codigo: 'IRQ', nombre: 'Irak',     emoji: '🇮🇶', grupo: 'I', activo: 1 },
  { codigo: 'NOR', nombre: 'Noruega',  emoji: '🇳🇴', grupo: 'I', activo: 1 },

  // ── Grupo J ─────────────────────────────────────────────────────────────
  { codigo: 'ARG', nombre: 'Argentina', emoji: '🇦🇷', grupo: 'J', activo: 1 },
  { codigo: 'ALG', nombre: 'Argelia',   emoji: '🇩🇿', grupo: 'J', activo: 1 },
  { codigo: 'AUT', nombre: 'Austria',   emoji: '🇦🇹', grupo: 'J', activo: 1 },
  { codigo: 'JOR', nombre: 'Jordania',  emoji: '🇯🇴', grupo: 'J', activo: 1 },

  // ── Grupo K ─────────────────────────────────────────────────────────────
  { codigo: 'POR', nombre: 'Portugal',    emoji: '🇵🇹', grupo: 'K', activo: 1 },
  { codigo: 'COD', nombre: 'RD de Congo', emoji: '🇨🇩', grupo: 'K', activo: 1 },
  { codigo: 'UZB', nombre: 'Uzbekistán',  emoji: '🇺🇿', grupo: 'K', activo: 1 },
  { codigo: 'COL', nombre: 'Colombia',    emoji: '🇨🇴', grupo: 'K', activo: 1 },

  // ── Grupo L ─────────────────────────────────────────────────────────────
  { codigo: 'ING', nombre: 'Inglaterra', emoji: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', grupo: 'L', activo: 1 },
  { codigo: 'CRO', nombre: 'Croacia',    emoji: '🇭🇷',           grupo: 'L', activo: 1 },
  { codigo: 'GHA', nombre: 'Ghana',      emoji: '🇬🇭',           grupo: 'L', activo: 1 },
  { codigo: 'PAN', nombre: 'Panamá',     emoji: '🇵🇦',           grupo: 'L', activo: 1 },
]
