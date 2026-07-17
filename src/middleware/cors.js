const cors = require('cors');

const allowed = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const corsOptions = {
  origin(origin, callback) {
    // Allow server-to-server / curl requests with no Origin header (e.g. health checks)
    if (!origin) return callback(null, true);
    if (allowed.includes('*') || allowed.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`Origin ${origin} not allowed by CORS`));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  credentials: false,
  maxAge: 600
};

module.exports = cors(corsOptions);
