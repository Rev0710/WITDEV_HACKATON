const jwt = require('jsonwebtoken');
const { User, Stay } = require('./models');

function signSession(user) {
  return jwt.sign({ sub: String(user._id), hotelId: String(user.hotelId), role: user.role }, process.env.JWT_SECRET, { expiresIn: '8h', issuer: 'stayflow' });
}

async function requireSession(req, res, next) {
  try {
    const token = req.cookies.stayflow_session;
    if (!token) return res.status(401).json({ error: 'Sign in to continue.' });
    const payload = jwt.verify(token, process.env.JWT_SECRET, { issuer: 'stayflow' });
    const user = await User.findOne({ _id: payload.sub, hotelId: payload.hotelId, active: true }).select('_id hotelId name email role department');
    if (!user || user.role !== payload.role) return res.status(401).json({ error: 'Your session is no longer active.' });
    req.user = user;
    if (user.role === 'guest') {
      const stay = await Stay.findOne({ hotelId: user.hotelId, guestId: user._id, status: 'Active' }).select('_id roomId');
      if (!stay) return res.status(403).json({ error: 'There is no active stay for this guest session.' });
      req.stay = stay;
    }
    next();
  } catch {
    res.clearCookie('stayflow_session', { path: '/' });
    return res.status(401).json({ error: 'Your session expired. Please sign in again.' });
  }
}

function allowRoles(...roles) {
  return (req, res, next) => roles.includes(req.user?.role) ? next() : res.status(403).json({ error: 'You do not have access to this action.' });
}

function setSessionCookie(res, user) {
  res.cookie('stayflow_session', signSession(user), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'strict',
    path: '/',
    maxAge: 8 * 60 * 60 * 1000
  });
}

module.exports = { requireSession, allowRoles, setSessionCookie };
