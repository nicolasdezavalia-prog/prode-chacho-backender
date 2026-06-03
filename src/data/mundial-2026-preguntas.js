/**
 * Dataset oficial de las 36 preguntas del Mundial 2026 — Fase 2.4.
 *
 * Fuente: `Mundial.xlsx` original (Excel del usuario). Las preguntas se
 * normalizaron a los 8 `tipo_pregunta` soportados por el backend. Decisiones:
 *
 *   - P5-P7 (Goleador / Balón de Oro / Guante de Oro): son JUGADORES, no
 *     equipos. Se usan como `respuesta_manual`. El admin asigna pts al cerrar
 *     el torneo (pts_max según Excel).
 *   - P11-P16 (instancia de eliminación por equipo): se normalizaron al shape
 *     estándar de 6 instancias [Grupos, 16°, 8°, 4°, Semis, Final]. El Excel
 *     tenía typos en P12-P14 y P16 (`8°; 30` en lugar de `8°: 30`); acá los
 *     corregimos.
 *   - P22 (Sumará puntos Haití?) usa `opcion_unica` con `pts_por_opcion`
 *     (asimétrico Sí=15, No=10) — exactamente el caso que diseñamos en Fase 2.3.
 *   - P35-P36 (más amarillas / más rojas): `equipo_categoria` con selector
 *     general (sin restriccion). pts=25 base; la asimetría "25 si entre todos /
 *     10 si entre nosotros" se evalúa por el admin al cierre (Fase 3).
 *   - Preguntas con `restriccion` filtran qué equipos del catálogo son
 *     respuestas válidas. El frontend filtra el dropdown; el backend rechaza
 *     con 400 si una respuesta no cumple.
 *
 * `aclaracion`: cada pregunta tiene una aclaración amigable que se muestra al
 * usuario debajo del enunciado en `/mundial/:torneoId`. Documenta cómo puntúa
 * la pregunta de forma legible.
 *
 * UPSERT por (torneo_id, numero) — re-ejecutar el seed actualiza los datos.
 */

// Shape estándar para instancia_eliminacion (P11-P16).
const INSTANCIA_STD = {
  instancias: ['Grupos', '16°', '8°', '4°', 'Semis', 'Final'],
  pts_por_instancia: { 'Grupos': 50, '16°': 40, '8°': 30, '4°': 20, 'Semis': 30, 'Final': 30 },
};
const INSTANCIA_ACLARACION = 'Grupos: 50 pts · 16°: 40 pts · 8°: 30 pts · 4°: 20 pts · Semis: 30 pts · Final: 30 pts';

// Top 4 / Top 8 (para P1-P4)
const TOP4 = ['BRA', 'ARG', 'FRA', 'ESP'];
const MID4 = ['ALE', 'ING', 'POR', 'HOL'];
const TOP8 = [...TOP4, ...MID4];

module.exports = [
  // ── P1-P4: Top final del torneo ─────────────────────────────────────────
  { numero: 1, enunciado: 'Campeón',
    aclaracion: 'BRA/ARG/FRA/ESP: 50 pts · ALE/ING/POR/HOL: 75 pts · Otro: 100 pts',
    tipo_pregunta: 'equipo_categoria',
    config_json: { categorias: [
      { label: 'top4', equipos: TOP4, pts: 50 },
      { label: 'mid4', equipos: MID4, pts: 75 },
      { label: 'otro', pts: 100, default: true },
    ] } },
  { numero: 2, enunciado: 'Subcampeón',
    aclaracion: 'BRA/ARG/FRA/ESP: 50 pts · ALE/ING/POR/HOL: 75 pts · Otro: 100 pts',
    tipo_pregunta: 'equipo_categoria',
    config_json: { categorias: [
      { label: 'top4', equipos: TOP4, pts: 50 },
      { label: 'mid4', equipos: MID4, pts: 75 },
      { label: 'otro', pts: 100, default: true },
    ] } },
  { numero: 3, enunciado: 'Tercero',
    aclaracion: 'BRA/ARG/FRA/ESP/ALE/ING/POR/HOL: 50 pts · Otro: 75 pts',
    tipo_pregunta: 'equipo_categoria',
    config_json: { categorias: [
      { label: 'top8', equipos: TOP8, pts: 50 },
      { label: 'otro', pts: 75, default: true },
    ] } },
  { numero: 4, enunciado: 'Cuarto',
    aclaracion: 'BRA/ARG/FRA/ESP/ALE/ING/POR/HOL: 50 pts · Otro: 75 pts',
    tipo_pregunta: 'equipo_categoria',
    config_json: { categorias: [
      { label: 'top8', equipos: TOP8, pts: 50 },
      { label: 'otro', pts: 75, default: true },
    ] } },

  // ── P5-P7: Premios individuales (jugadores) — respuesta_manual ──────────
  { numero: 5, enunciado: 'Goleador',
    aclaracion: 'Hasta 75 pts. El admin asigna el puntaje al cierre del torneo.',
    tipo_pregunta: 'respuesta_manual',
    config_json: { pts_max: 75, instrucciones: 'Nombre del jugador con más goles del Mundial.' } },
  { numero: 6, enunciado: 'Balón de Oro (mejor jugador)',
    aclaracion: 'Hasta 50 pts. El admin asigna el puntaje al cierre.',
    tipo_pregunta: 'respuesta_manual',
    config_json: { pts_max: 50, instrucciones: 'Nombre del jugador ganador del Balón de Oro.' } },
  { numero: 7, enunciado: 'Guante de Oro (mejor arquero)',
    aclaracion: 'Hasta 30 pts. El admin asigna el puntaje al cierre.',
    tipo_pregunta: 'respuesta_manual',
    config_json: { pts_max: 30, instrucciones: 'Nombre del arquero ganador del Guante de Oro.' } },

  // ── P8-P10: Premios de equipo — equipo_categoria 1 default ──────────────
  { numero: 8, enunciado: 'Fair Play',
    aclaracion: '20 pts si acertás el equipo.',
    tipo_pregunta: 'equipo_categoria',
    config_json: { categorias: [{ label: 'cualquiera', pts: 20, default: true }] } },
  { numero: 9, enunciado: 'Último del Mundial',
    aclaracion: '30 pts si acertás el equipo.',
    tipo_pregunta: 'equipo_categoria',
    config_json: { categorias: [{ label: 'cualquiera', pts: 30, default: true }] } },
  { numero: 10, enunciado: 'Mejor equipo asiático (AFC)',
    aclaracion: '20 pts si acertás el equipo. Solo equipos de la confederación AFC.',
    tipo_pregunta: 'equipo_categoria',
    config_json: {
      categorias: [{ label: 'cualquiera', pts: 20, default: true }],
      restriccion: { tipo: 'confederacion', confederacion: 'AFC' },
    } },

  // ── P11-P16: Instancia de eliminación por equipo ────────────────────────
  { numero: 11, enunciado: 'En qué instancia quedará afuera Inglaterra??',
    aclaracion: INSTANCIA_ACLARACION,
    tipo_pregunta: 'instancia_eliminacion',
    config_json: { equipo: 'ING', ...INSTANCIA_STD } },
  { numero: 12, enunciado: 'En qué instancia perderá Argentina??',
    aclaracion: INSTANCIA_ACLARACION,
    tipo_pregunta: 'instancia_eliminacion',
    config_json: { equipo: 'ARG', ...INSTANCIA_STD } },
  { numero: 13, enunciado: 'En qué instancia perderá Brasil??',
    aclaracion: INSTANCIA_ACLARACION,
    tipo_pregunta: 'instancia_eliminacion',
    config_json: { equipo: 'BRA', ...INSTANCIA_STD } },
  { numero: 14, enunciado: 'En qué instancia perderá España??',
    aclaracion: INSTANCIA_ACLARACION,
    tipo_pregunta: 'instancia_eliminacion',
    config_json: { equipo: 'ESP', ...INSTANCIA_STD } },
  { numero: 15, enunciado: 'En qué instancia perderá Alemania??',
    aclaracion: INSTANCIA_ACLARACION,
    tipo_pregunta: 'instancia_eliminacion',
    config_json: { equipo: 'ALE', ...INSTANCIA_STD } },
  { numero: 16, enunciado: 'En qué instancia perderá Francia??',
    aclaracion: INSTANCIA_ACLARACION,
    tipo_pregunta: 'instancia_eliminacion',
    config_json: { equipo: 'FRA', ...INSTANCIA_STD } },

  // ── P17-P20: Top de grupos / Segundo y Tercero Grupo A ──────────────────
  { numero: 17, enunciado: 'Equipo más goleador en Grupos',
    aclaracion: '30 pts si acertás el equipo.',
    tipo_pregunta: 'equipo_categoria',
    config_json: { categorias: [{ label: 'cualquiera', pts: 30, default: true }] } },
  { numero: 18, enunciado: 'Equipo más goleado en Grupos',
    aclaracion: '30 pts si acertás el equipo.',
    tipo_pregunta: 'equipo_categoria',
    config_json: { categorias: [{ label: 'cualquiera', pts: 30, default: true }] } },
  { numero: 19, enunciado: 'Segundo Grupo A',
    aclaracion: '10 pts si acertás el equipo. Solo equipos del Grupo A.',
    tipo_pregunta: 'equipo_categoria',
    config_json: {
      categorias: [{ label: 'cualquiera', pts: 10, default: true }],
      restriccion: { tipo: 'grupo', grupo: 'A' },
    } },
  { numero: 20, enunciado: 'Tercero Grupo A',
    aclaracion: '10 pts si acertás el equipo. Solo equipos del Grupo A.',
    tipo_pregunta: 'equipo_categoria',
    config_json: {
      categorias: [{ label: 'cualquiera', pts: 10, default: true }],
      restriccion: { tipo: 'grupo', grupo: 'A' },
    } },

  // ── P21, P23-P28: Posiciones específicas con favoritos (2 cats + restriccion) ──
  { numero: 21, enunciado: 'Cuarto Grupo B',
    aclaracion: 'BOS/SUI: 20 pts · Otro equipo del Grupo B: 10 pts',
    tipo_pregunta: 'equipo_categoria',
    config_json: {
      categorias: [
        { label: 'favorito', equipos: ['BOS', 'SUI'], pts: 20 },
        { label: 'otro', pts: 10, default: true },
      ],
      restriccion: { tipo: 'grupo', grupo: 'B' },
    } },

  // ── P22: Sumará puntos Haití — opcion_unica con pts_por_opcion ──────────
  { numero: 22, enunciado: 'Sumará puntos Haití (Grupo C)??',
    aclaracion: 'Sí: 15 pts · No: 10 pts',
    tipo_pregunta: 'opcion_unica',
    config_json: { opciones: ['Sí', 'No'], pts_por_opcion: { 'Sí': 15, 'No': 10 } } },

  { numero: 23, enunciado: 'Ganador Grupo D',
    aclaracion: 'AUS: 25 pts · Otro equipo del Grupo D: 10 pts',
    tipo_pregunta: 'equipo_categoria',
    config_json: {
      categorias: [
        { label: 'favorito', equipos: ['AUS'], pts: 25 },
        { label: 'otro', pts: 10, default: true },
      ],
      restriccion: { tipo: 'grupo', grupo: 'D' },
    } },
  { numero: 24, enunciado: 'Segundo Grupo E',
    aclaracion: 'CIV/ECU: 10 pts · Otro equipo del Grupo E: 25 pts',
    tipo_pregunta: 'equipo_categoria',
    config_json: {
      categorias: [
        { label: 'favorito', equipos: ['CIV', 'ECU'], pts: 10 },
        { label: 'otro', pts: 25, default: true },
      ],
      restriccion: { tipo: 'grupo', grupo: 'E' },
    } },
  { numero: 25, enunciado: 'Segundo Grupo F',
    aclaracion: 'HOL: 20 pts · Otro equipo del Grupo F: 10 pts',
    tipo_pregunta: 'equipo_categoria',
    config_json: {
      categorias: [
        { label: 'favorito', equipos: ['HOL'], pts: 20 },
        { label: 'otro', pts: 10, default: true },
      ],
      restriccion: { tipo: 'grupo', grupo: 'F' },
    } },
  { numero: 26, enunciado: 'Tercero Grupo G',
    aclaracion: 'BEL: 30 pts · Otro equipo del Grupo G: 10 pts',
    tipo_pregunta: 'equipo_categoria',
    config_json: {
      categorias: [
        { label: 'favorito', equipos: ['BEL'], pts: 30 },
        { label: 'otro', pts: 10, default: true },
      ],
      restriccion: { tipo: 'grupo', grupo: 'G' },
    } },
  { numero: 27, enunciado: 'Tercero Grupo H',
    aclaracion: 'ESP/URU: 30 pts · Otro equipo del Grupo H: 10 pts',
    tipo_pregunta: 'equipo_categoria',
    config_json: {
      categorias: [
        { label: 'favorito', equipos: ['ESP', 'URU'], pts: 30 },
        { label: 'otro', pts: 10, default: true },
      ],
      restriccion: { tipo: 'grupo', grupo: 'H' },
    } },
  { numero: 28, enunciado: 'Segundo Grupo I',
    aclaracion: 'FRA/IRQ: 30 pts · Otro equipo del Grupo I: 10 pts',
    tipo_pregunta: 'equipo_categoria',
    config_json: {
      categorias: [
        { label: 'favorito', equipos: ['FRA', 'IRQ'], pts: 30 },
        { label: 'otro', pts: 10, default: true },
      ],
      restriccion: { tipo: 'grupo', grupo: 'I' },
    } },

  // ── P29-P31: Números ────────────────────────────────────────────────────
  { numero: 29, enunciado: 'Cuántos goles recibirá Argentina en el Grupo J??',
    aclaracion: '0 a 2 goles: 10 pts · 3 o más goles: 25 pts',
    tipo_pregunta: 'numero_por_banda',
    config_json: { bandas: [
      { min: 0, max: 2, pts: 10 },
      { min: 3, pts: 25 },
    ] } },
  { numero: 30, enunciado: 'Cuántos empates habrá en el grupo K??',
    aclaracion: '10 pts si acertás el número exacto.',
    tipo_pregunta: 'numero_exacto',
    config_json: { pts_si_acierta: 10, pts_si_no_acierta: 0 } },
  { numero: 31, enunciado: 'Cuántos goles hará Panamá??',
    aclaracion: '0 a 2 goles: 10 pts · 3 o más goles: 20 pts',
    tipo_pregunta: 'numero_por_banda',
    config_json: { bandas: [
      { min: 0, max: 2, pts: 10 },
      { min: 3, pts: 20 },
    ] } },

  // ── P32-P34: Multi-equipo ───────────────────────────────────────────────
  { numero: 32, enunciado: '8 equipos que queden eliminados en 16°',
    aclaracion: '10 pts por cada equipo acertado (de hasta 8).',
    tipo_pregunta: 'multi_equipo',
    config_json: { n_equipos: 8, pts_por_acierto: 10 } },
  { numero: 33, enunciado: '4 equipos que queden eliminados en 8°',
    aclaracion: '10 pts por cada equipo acertado (de hasta 4).',
    tipo_pregunta: 'multi_equipo',
    config_json: { n_equipos: 4, pts_por_acierto: 10 } },
  { numero: 34, enunciado: '4 equipos que queden eliminados en 4°',
    aclaracion: '10 pts por cada equipo acertado (de hasta 4).',
    tipo_pregunta: 'multi_equipo',
    config_json: { n_equipos: 4, pts_por_acierto: 10 } },

  // ── P35-P36: Disciplina — equipo_categoria con scoring MANUAL ───────────
  // El user responde con dropdown normal de equipo, pero el scoring es 100%
  // manual: el admin asigna 25/10/0 por usuario desde Resultados (Fase 3.2).
  //   - 25 si acertó el equipo con más amarillas/rojas ENTRE TODOS los equipos
  //     del Mundial.
  //   - 10 si acertó el equipo con más amarillas/rojas solo ENTRE LOS EQUIPOS
  //     ELEGIDOS por los users del torneo.
  //   - 0 sino.
  // `scoring_manual: true` desactiva el auto-scoring del engine
  // (ver mundial-scoring.js §puntosEquipoCategoria).
  // `presets: [0, 10, 25]` controla los botones rápidos en la UI admin.
  // La categoría dummy existe solo para mantener el shape de config válido
  // contra el validador estándar de equipo_categoria.
  { numero: 35, enunciado: 'Equipo con mayor cantidad de amarillas',
    aclaracion: '25 pts si acertás entre todos los equipos del Mundial · 10 pts si acertás solo entre los equipos elegidos por nosotros · 0 sino. Admin asigna pts al cierre.',
    tipo_pregunta: 'equipo_categoria',
    config_json: {
      scoring_manual: true,
      presets: [0, 10, 25],
      categorias: [{ label: 'manual', pts: 0, default: true }],
    } },
  { numero: 36, enunciado: 'Equipo con mayor cantidad de rojas',
    aclaracion: '25 pts si acertás entre todos los equipos del Mundial · 10 pts si acertás solo entre los equipos elegidos por nosotros · 0 sino. Admin asigna pts al cierre.',
    tipo_pregunta: 'equipo_categoria',
    config_json: {
      scoring_manual: true,
      presets: [0, 10, 25],
      categorias: [{ label: 'manual', pts: 0, default: true }],
    } },
]
