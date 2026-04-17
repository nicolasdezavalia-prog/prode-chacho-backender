const express = require('express');
const cors = require('cors');
const { getDb } = require('./db');

const authRoutes = require('./routes/auth');
const torneosRoutes = require('./routes/torneos');
const fechasRoutes = require('./routes/fechas');
const eventosRoutes = require('./routes/eventos');
const pronosticosRoutes = require('./routes/pronosticos');
const crucesRoutes = require('./routes/cruces');
const usuariosRoutes = require('./routes/usuarios');
const gdtRoutes = require('./routes/gdt');

const app = express();
const PORT = process.env.PORT || 3001;

// Middlewares
const allowedOrigins = [
  'http://localhost:5173',
  process.env.FRONTEND_URL,
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    // Permitir requests sin origin (curl, mobile apps, etc.)
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origen no permitido — ${origin}`));
  },
  credentials: true
}));
app.use(express.json());

// Inicializar DB al arrancar
getDb();

// Rutas
app.use('/api/auth', authRoutes);
app.use('/api/torneos', torneosRoutes);
app.use('/api/fechas', fechasRoutes);
app.use('/api/eventos', eventosRoutes);
app.use('/api/pronosticos', pronosticosRoutes);
app.use('/api/cruces', crucesRoutes);
app.use('/api/usuarios', usuariosRoutes);
app.use('/api/gdt', gdtRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handler global
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
});

app.listen(PORT, () => {
  console.log(`\n🚀 Prode Chacho Backend corriendo en http://localhost:${PORT}`);
  console.log(`📊 DB: /data/prode.db\n`);
});
