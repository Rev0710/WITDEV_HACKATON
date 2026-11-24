require('dotenv').config();
const http = require('http');
const express = require('express');
const mongoose = require('mongoose');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const cookie = require('cookie');
const routes = require('./routes');
const { User, ServiceRequest, ActivityLog } = require('./models');

const app = express();
const server = http.createServer(app);
const origins = (process.env.CLIENT_ORIGINS || 'http://localhost:5173').split(',').map(value => value.trim());
const allowOrigin = (origin, callback) => {
  if (!origin || origins.includes(origin)) return callback(null, true);
  return callback(new Error('Origin is not allowed.'));
};
app.disable('x-powered-by');
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: process.env.NODE_ENV === 'production' ? undefined : false }));
app.use(cors({ origin: allowOrigin, credentials: true, methods: ['GET', 'POST', 'PATCH', 'OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.use(cookieParser());
app.use((req, res, next) => {
  const origin = req.get('origin');
  const site = req.get('sec-fetch-site');
  if (origin && !origins.includes(origin)) return res.status(403).json({ error: 'Request origin is not allowed.' });
  if (['POST', 'PATCH', 'DELETE'].includes(req.method) && req.cookies?.stayflow_session && (site === 'cross-site' || (process.env.NODE_ENV === 'production' && !origin))) {
    return res.status(403).json({ error: 'Cross-site request blocked.' });
  }
  next();
});
app.use(express.json({ limit: '32kb', strict: true }));
app.use((req, res, next) => {
  let invalid = false;
  function inspect(value, depth = 0) {
    if (depth > 12) { invalid = true; return; }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key.startsWith('$') || key.includes('.') || key === '__proto__' || key === 'constructor') invalid = true;
      inspect(child, depth + 1);
    }
  }
  inspect(req.body);
  if (invalid) return res.status(400).json({ error: 'Request contains unsupported fields.' });
  next();
});
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: 'draft-7', legacyHeaders: false }));
app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'stayflow-api' }));
app.use('/api/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 12, standardHeaders: 'draft-7', legacyHeaders: false }));
app.use('/api/auth/signup', rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false }));
app.use('/api/public/reservations', rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: 'draft-7', legacyHeaders: false }));
app.use('/api', routes);
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large.' });
  if (process.env.NODE_ENV !== 'production') console.error('StayFlow request error:', err.name, err.message);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

const { Server } = require('socket.io');
const io = new Server(server, { cors: { origin: allowOrigin, credentials: true }, maxHttpBufferSize: 32 * 1024 });
app.set('io', io);
io.use(async (socket, next) => {
  try {
    const cookies = cookie.parse(socket.handshake.headers.cookie || '');
    const token = cookies.stayflow_session;
    if (!token) return next(new Error('Authentication required.'));
    const payload = jwt.verify(token, process.env.JWT_SECRET, { issuer: 'stayflow' });
    const user = await User.findOne({ _id: payload.sub, hotelId: payload.hotelId, active: true }).select('_id hotelId role');
    if (!user || user.role !== payload.role) return next(new Error('Authentication required.'));
    socket.user = user;
    next();
  } catch { next(new Error('Authentication required.')); }
});
io.on('connection', socket => {
  if (socket.user.role === 'guest') socket.join(`guest:${socket.user._id}`);
  else socket.join(`hotel:${socket.user.hotelId}:staff`);
});

async function escalateOverdue() {
  const due = await ServiceRequest.find({ status: { $in: ['Submitted', 'Assigned', 'Accepted', 'In Progress'] }, dueAt: { $lte: new Date() } }).select('_id hotelId category status guestId');
  for (const candidate of due) {
    const before = candidate.status;
    const updated = await ServiceRequest.findOneAndUpdate(
      { _id: candidate._id, hotelId: candidate.hotelId, status: before, dueAt: { $lte: new Date() } },
      { $set: { status: 'Escalated', escalatedAt: new Date() } }, { new: true }
    );
    if (!updated) continue;
    const admin = await User.findOne({ hotelId: candidate.hotelId, role: 'admin', active: true }).select('_id');
    if (admin) await ActivityLog.create({
      hotelId: candidate.hotelId, actorId: admin._id, actorName: 'StayFlow automation', actorRole: 'system',
      action: 'request.sla_escalated', entityType: 'request', entityId: String(candidate._id),
      summary: `Automatically escalated overdue ${candidate.category} request`, fromStatus: before, toStatus: 'Escalated'
    });
    io.to(`hotel:${candidate.hotelId}:staff`).emit('request:updated', { id: String(candidate._id), status: 'Escalated' });
    io.to(`guest:${candidate.guestId}`).emit('request:updated', { id: String(candidate._id), status: 'Escalated' });
  }
}

async function start() {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) throw new Error('Set JWT_SECRET to a random value with at least 32 characters.');
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stayflow');
  const port = Number(process.env.PORT) || 4000;
  server.listen(port, () => console.log(`StayFlow API listening on ${port}`));
  setInterval(() => escalateOverdue().catch(error => console.error('SLA escalation failed:', error.name)), 15000).unref();
}
start().catch(error => { console.error('StayFlow startup failed:', error.message); process.exit(1); });



