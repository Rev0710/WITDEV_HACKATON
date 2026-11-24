const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { body, param, query, validationResult } = require('express-validator');
const { Hotel, User, Room, Stay, ServiceRequest, Reservation, ActivityLog } = require('./models');
const { requireSession, allowRoles, setSessionCookie } = require('./auth');
const { audit } = require('./audit');

const router = express.Router();
const departments = ['Housekeeping', 'Room Service', 'Maintenance', 'Guest Services', 'General'];
const categories = new Set(departments);
const activeStatuses = ['Submitted', 'Assigned', 'Accepted', 'In Progress', 'Escalated'];
const role = (...roles) => [requireSession, allowRoles(...roles)];
const validate = (rules) => async (req, res, next) => {
  await Promise.all(rules.map(rule => rule.run(req)));
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
  next();
};
const clean = (value) => String(value || '').trim();
const noMarkup = (value) => typeof value === 'string' && !/[<>\u0000-\u001f]/.test(value);
const passwordRule = body('password').isString().isLength({ min: 12, max: 128 }).matches(/[a-z]/).matches(/[A-Z]/).matches(/[0-9]/).matches(/[^A-Za-z0-9]/).withMessage('Use 12+ characters with upper and lower case, a number, and a symbol.');

function publicUser(user) {
  return { id: String(user._id), name: user.name, email: user.email, role: user.role, department: user.department || null, hotelId: String(user.hotelId) };
}
function publicRequest(request) {
  return {
    id: String(request._id), ownerId: request.ownerId ? String(request.ownerId._id || request.ownerId) : null, category: request.category, description: request.description,
    priority: request.priority, source: request.source, status: request.status, roomNumber: request.roomId?.roomNumber || '',
    guestName: request.guestId?.name || '', ownerName: request.ownerId?.name || '',
    dueAt: request.dueAt, createdAt: request.createdAt, updatedAt: request.updatedAt
  };
}
async function emitHotel(req, name, payload) {
  req.app.get('io')?.to(`hotel:${req.user.hotelId}:staff`).emit(name, payload);
}
async function emitGuest(req, name, payload) {
  req.app.get('io')?.to(`guest:${req.user._id}`).emit(name, payload);
}
async function pickLeastLoaded(hotelId, department, omitId) {
  const staff = await User.find({ hotelId, role: 'staff', department, active: true, ...(omitId ? { _id: { $ne: omitId } } : {}) }).select('_id');
  if (!staff.length) return null;
  const counts = await Promise.all(staff.map(async person => ({
    person,
    count: await ServiceRequest.countDocuments({ hotelId, ownerId: person._id, status: { $in: activeStatuses } })
  })));
  counts.sort((a, b) => a.count - b.count);
  return counts[0].person._id;
}

router.get('/public/hotels', async (_req, res, next) => {
  try { res.json({ hotels: await Hotel.find().select('name slug').sort({ name: 1 }).limit(100).lean() }); } catch (error) { next(error); }
});
router.get('/public/hotels/:slug/rooms', validate([
  param('slug').isString().matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).isLength({ max: 48 }),
  query('checkIn').optional().matches(/^\d{4}-\d{2}-\d{2}$/),
  query('checkOut').optional().matches(/^\d{4}-\d{2}-\d{2}$/)
]), async (req, res, next) => {
  try {
    const hotel = await Hotel.findOne({ slug: req.params.slug }).select('_id');
    if (!hotel) return res.status(404).json({ error: 'Hotel not found.' });
    let rooms = await Room.find({ hotelId: hotel._id, status: { $in: ['Available', 'Ready for Check-in'] } }).select('roomNumber').sort({ roomNumber: 1 }).lean();
    if (req.query.checkIn || req.query.checkOut) {
      if (!req.query.checkIn || !req.query.checkOut) return res.status(400).json({ error: 'Provide both check-in and check-out dates.' });
      const checkIn = new Date(req.query.checkIn + 'T00:00:00.000Z');
      const checkOut = new Date(req.query.checkOut + 'T00:00:00.000Z');
      if (Number.isNaN(checkIn.valueOf()) || Number.isNaN(checkOut.valueOf()) || checkIn.toISOString().slice(0, 10) !== req.query.checkIn || checkOut.toISOString().slice(0, 10) !== req.query.checkOut || checkOut <= checkIn) return res.status(400).json({ error: 'Choose a valid date range.' });
      const booked = await Reservation.find({ hotelId: hotel._id, status: { $in: ['Reserved', 'Checked-in'] }, checkIn: { $lt: checkOut }, checkOut: { $gt: checkIn } }).distinct('roomId');
      const bookedIds = new Set(booked.map(String));
      rooms = rooms.filter(room => !bookedIds.has(String(room._id)));
    }
    res.json({ rooms });
  } catch (error) { next(error); }
});
router.post('/public/reservations', validate([
  body('hotelSlug').isString().matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).isLength({ min: 3, max: 48 }),
  body('guestName').isString().isLength({ min: 2, max: 80 }).custom(noMarkup),
  body('guestEmail').isEmail().normalizeEmail(),
  body('roomNumber').isString().matches(/^[A-Za-z0-9-]+$/).isLength({ min: 1, max: 12 }),
  body('checkIn').matches(/^\d{4}-\d{2}-\d{2}$/),
  body('checkOut').matches(/^\d{4}-\d{2}-\d{2}$/)
]), async (req, res, next) => {
  let lockedRoomId = null, lock = null;
  try {
    const checkIn = new Date(req.body.checkIn + 'T00:00:00.000Z');
    const checkOut = new Date(req.body.checkOut + 'T00:00:00.000Z');
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    if (Number.isNaN(checkIn.valueOf()) || Number.isNaN(checkOut.valueOf()) || checkIn.toISOString().slice(0, 10) !== req.body.checkIn || checkOut.toISOString().slice(0, 10) !== req.body.checkOut || checkIn < today || checkOut <= checkIn || checkIn.getTime() > today.getTime() + 365 * 86400000) return res.status(400).json({ error: 'Choose valid check-in and check-out dates within the next year.' });
    const hotel = await Hotel.findOne({ slug: clean(req.body.hotelSlug).toLowerCase() }).select('_id name slug');
    if (!hotel) return res.status(404).json({ error: 'Hotel not found.' });
    lock = crypto.randomUUID();
    const room = await Room.findOneAndUpdate({
      hotelId: hotel._id, roomNumber: clean(req.body.roomNumber), status: { $in: ['Available', 'Ready for Check-in'] },
      $or: [{ bookingLockUntil: null }, { bookingLockUntil: { $lt: new Date() } }]
    }, { $set: { bookingLock: lock, bookingLockUntil: new Date(Date.now() + 30000) } }, { new: true });
    if (!room) return res.status(409).json({ error: 'That room is not available right now.' });
    lockedRoomId = room._id;
    const overlap = await Reservation.exists({ hotelId: hotel._id, roomId: room._id, status: { $in: ['Reserved', 'Checked-in'] }, checkIn: { $lt: checkOut }, checkOut: { $gt: checkIn } });
    if (overlap) return res.status(409).json({ error: 'That room has already been reserved for those dates.' });
    const code = crypto.randomBytes(5).toString('hex').toUpperCase();
    const reservation = await Reservation.create({ hotelId: hotel._id, roomId: room._id, guestName: clean(req.body.guestName), guestEmail: clean(req.body.guestEmail).toLowerCase(), checkIn, checkOut, confirmationHash: crypto.createHash('sha256').update(code).digest('hex') });
    const admin = await User.findOne({ hotelId: hotel._id, role: 'admin', active: true }).select('_id');
    if (admin) await ActivityLog.create({ hotelId: hotel._id, actorId: admin._id, actorName: 'Guest booking portal', actorRole: 'system', action: 'reservation.created', entityType: 'reservation', entityId: String(reservation._id), summary: 'New room reservation for room ' + room.roomNumber });
    res.status(201).json({ reservation: { id: String(reservation._id), hotel: hotel.name, roomNumber: room.roomNumber, guestName: reservation.guestName, checkIn: reservation.checkIn, checkOut: reservation.checkOut, status: reservation.status }, confirmationCode: code });
  } catch (error) { next(error); }
  finally { if (lockedRoomId && lock) await Room.updateOne({ _id: lockedRoomId, bookingLock: lock }, { $set: { bookingLock: null, bookingLockUntil: null } }).catch(() => {}); }
});

router.post('/auth/signup', validate([
  body('hotelName').isString().isLength({ min: 2, max: 100 }).custom(noMarkup),
  body('hotelSlug').isString().matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).isLength({ min: 3, max: 48 }),
  body('name').isString().isLength({ min: 2, max: 80 }).custom(noMarkup),
  body('email').isEmail().normalizeEmail(), passwordRule
]), async (req, res, next) => {
  try {
    const hotel = await Hotel.create({ name: clean(req.body.hotelName), slug: clean(req.body.hotelSlug).toLowerCase() });
    const user = await User.create({ hotelId: hotel._id, name: clean(req.body.name), email: clean(req.body.email).toLowerCase(), passwordHash: await bcrypt.hash(req.body.password, 12), role: 'admin' });
    await Room.create({ hotelId: hotel._id, roomNumber: '101', status: 'Available' });
    setSessionCookie(res, user);
    req.user = user;
    await audit(req, { action: 'hotel.created', entityType: 'hotel', entityId: hotel._id, summary: `Created hotel workspace ${hotel.name}` });
    res.status(201).json({ user: publicUser(user), hotel: { name: hotel.name, slug: hotel.slug } });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ error: 'That hotel URL is already in use.' });
    next(error);
  }
});

router.post('/auth/login', validate([
  body('hotelSlug').isString().matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).isLength({ max: 48 }),
  body('email').isEmail().normalizeEmail(), body('password').isString().isLength({ max: 128 })
]), async (req, res, next) => {
  try {
    const hotel = await Hotel.findOne({ slug: clean(req.body.hotelSlug).toLowerCase() }).select('_id name slug');
    const user = hotel ? await User.findOne({ hotelId: hotel._id, email: clean(req.body.email).toLowerCase(), role: { $in: ['admin', 'staff'] }, active: true }) : null;
    if (!user || !user.passwordHash || !(await bcrypt.compare(req.body.password, user.passwordHash))) return res.status(401).json({ error: 'Hotel, email, or password did not match.' });
    setSessionCookie(res, user);
    res.json({ user: publicUser(user), hotel: { name: hotel.name, slug: hotel.slug } });
  } catch (error) { next(error); }
});

router.get('/auth/me', requireSession, async (req, res) => {
  const hotel = await Hotel.findById(req.user.hotelId).select('name slug');
  res.json({ user: publicUser(req.user), hotel });
});
router.post('/auth/guest-session', validate([body('token').isString().matches(/^[a-f0-9]{64}$/)]), async (req, res, next) => {
  try {
    const tokenHash = crypto.createHash('sha256').update(req.body.token).digest('hex');
    const stay = await Stay.findOne({ accessTokenHash: tokenHash, status: 'Active' }).select('+accessTokenHash roomId hotelId guestId');
    if (!stay) return res.status(401).json({ error: 'This room QR session has expired. Ask the front desk to help.' });
    const guest = await User.findOne({ _id: stay.guestId, hotelId: stay.hotelId, role: 'guest', active: true });
    const room = await Room.findOne({ _id: stay.roomId, hotelId: stay.hotelId }).select('roomNumber');
    const hotel = await Hotel.findById(stay.hotelId).select('name');
    if (!guest || !room || !hotel) return res.status(401).json({ error: 'This room QR session is no longer active.' });
    setSessionCookie(res, guest);
    res.json({ user: publicUser(guest), hotel, stay: { roomNumber: room.roomNumber } });
  } catch (error) { next(error); }
});
router.post('/auth/logout', (req, res) => {
  res.clearCookie('stayflow_session', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'strict', path: '/' });
  res.status(204).end();
});

router.get('/staff/rooms', ...role('staff', 'admin'), async (req, res, next) => {
  try { res.json({ rooms: await Room.find({ hotelId: req.user.hotelId }).sort({ roomNumber: 1 }).select('roomNumber status') }); } catch (error) { next(error); }
});
router.patch('/staff/rooms/:roomNumber/status', ...role('staff', 'admin'), validate([
  param('roomNumber').isString().matches(/^[A-Za-z0-9-]+$/).isLength({ max: 12 }),
  body('status').isIn(['Cleaning in Progress', 'Ready for Check-in'])
]), async (req, res, next) => {
  try {
    if (req.user.role === 'staff' && req.user.department !== 'Housekeeping') return res.status(403).json({ error: 'Only housekeeping staff can update room readiness.' });
    const room = await Room.findOne({ hotelId: req.user.hotelId, roomNumber: clean(req.params.roomNumber) });
    if (!room) return res.status(404).json({ error: 'Room not found.' });
    const allowed = (room.status === 'Needs Cleaning' && req.body.status === 'Cleaning in Progress') || (room.status === 'Cleaning in Progress' && req.body.status === 'Ready for Check-in');
    if (!allowed) return res.status(409).json({ error: 'That room status change is not allowed.' });
    const before = room.status; room.status = req.body.status; await room.save();
    await audit(req, { action: 'room.readiness_updated', entityType: 'room', entityId: room._id, summary: 'Room ' + room.roomNumber + ' marked ' + room.status.toLowerCase(), fromStatus: before, toStatus: room.status });
    req.app.get('io')?.to('hotel:' + req.user.hotelId + ':staff').emit('room:updated', { roomNumber: room.roomNumber, status: room.status });
    res.json({ room: { roomNumber: room.roomNumber, status: room.status } });
  } catch (error) { next(error); }
});

router.post('/staff/check-out', ...role('staff', 'admin'), validate([
  body('roomNumber').isString().matches(/^[A-Za-z0-9-]+$/).isLength({ max: 12 })
]), async (req, res, next) => {
  try {
    const room = await Room.findOne({ hotelId: req.user.hotelId, roomNumber: clean(req.body.roomNumber), status: 'Occupied' });
    if (!room) return res.status(404).json({ error: 'No occupied room with that number was found.' });
    const stay = await Stay.findOne({ hotelId: req.user.hotelId, roomId: room._id, status: 'Active' });
    if (!stay) return res.status(404).json({ error: 'No active guest stay was found for this room.' });
    stay.status = 'Ended'; stay.checkedOutAt = new Date(); stay.accessTokenHash = undefined; await stay.save();
    room.status = 'Needs Cleaning'; await room.save();
    await audit(req, { action: 'stay.checked_out', entityType: 'stay', entityId: stay._id, summary: `Checked out room ${room.roomNumber}; room needs cleaning` });
    req.app.get('io')?.to(`guest:${stay.guestId}`).emit('stay:ended', {});
    res.json({ room: { roomNumber: room.roomNumber, status: room.status } });
  } catch (error) { next(error); }
});
router.post('/staff/check-in', ...role('staff', 'admin'), validate([
  body('guestName').optional().isString().isLength({ min: 2, max: 80 }).custom(noMarkup),
  body('roomNumber').optional().isString().isLength({ min: 1, max: 12 }).matches(/^[A-Za-z0-9-]+$/),
  body('confirmationCode').optional().isString().matches(/^[A-F0-9]{10}$/)
]), async (req, res, next) => {
  try {
    let room, reservation = null, guestName = clean(req.body.guestName);
    if (req.body.confirmationCode) {
      const codeHash = crypto.createHash('sha256').update(req.body.confirmationCode.toUpperCase()).digest('hex');
      reservation = await Reservation.findOne({ hotelId: req.user.hotelId, confirmationHash: codeHash, status: 'Reserved' }).select('+confirmationHash');
      if (!reservation) return res.status(404).json({ error: 'Reservation code not found or already used.' });
      const today = new Date(); today.setUTCHours(0, 0, 0, 0);
      if (reservation.checkIn > today || reservation.checkOut <= today) return res.status(409).json({ error: 'This reservation is outside its check-in dates.' });
      room = await Room.findOne({ _id: reservation.roomId, hotelId: req.user.hotelId, status: { $in: ['Available', 'Ready for Check-in'] }, $or: [{ bookingLockUntil: null }, { bookingLockUntil: { $lt: new Date() } }] });
      guestName = reservation.guestName;
    } else {
      if (!guestName || !req.body.roomNumber) return res.status(400).json({ error: 'Use a reservation code or provide a guest name and available room.' });
      room = await Room.findOne({ hotelId: req.user.hotelId, roomNumber: clean(req.body.roomNumber), status: { $in: ['Available', 'Ready for Check-in'] }, $or: [{ bookingLockUntil: null }, { bookingLockUntil: { $lt: new Date() } }] });
    }
    if (!room) return res.status(409).json({ error: 'That room is unavailable or does not exist.' });
    const guest = await User.create({ hotelId: req.user.hotelId, name: guestName, role: 'guest' });
    const accessToken = crypto.randomBytes(32).toString('hex');
    const stay = await Stay.create({ hotelId: req.user.hotelId, roomId: room._id, guestId: guest._id, status: 'Active', accessTokenHash: crypto.createHash('sha256').update(accessToken).digest('hex') });
    room.status = 'Occupied'; await room.save();
    if (reservation) { reservation.status = 'Checked-in'; reservation.stayId = stay._id; await reservation.save(); }
    await audit(req, { action: 'stay.checked_in', entityType: 'stay', entityId: stay._id, summary: 'Checked in guest to room ' + room.roomNumber });
    if (reservation) await audit(req, { action: 'reservation.checked_in', entityType: 'stay', entityId: reservation._id, summary: 'Verified reservation and activated its room QR session' });
    const appUrl = (process.env.CLIENT_APP_URL || 'http://localhost:5173').replace(/\/$/, '');
    res.status(201).json({ guest: publicUser(guest), stay: { id: String(stay._id), roomNumber: room.roomNumber, checkedInAt: stay.checkedInAt }, guestAccessUrl: appUrl + '/guest/activate?token=' + accessToken });
  } catch (error) { next(error); }
});

router.post('/guest/requests', ...role('guest'), validate([
  body('category').isString().isIn(departments),
  body('description').isString().isLength({ min: 8, max: 600 }).custom(noMarkup),
  body('priority').optional().isIn(['Normal', 'Urgent'])
]), async (req, res, next) => {
  try {
    const room = await Room.findOne({ _id: req.stay.roomId, hotelId: req.user.hotelId }).select('roomNumber');
    if (!room) return res.status(403).json({ error: 'The room session could not be verified.' });
    const ownerId = await pickLeastLoaded(req.user.hotelId, req.body.category);
    const dueAt = new Date(Date.now() + (req.body.priority === 'Urgent' ? 10 : 30) * 60 * 1000);
    const ticket = await ServiceRequest.create({
      hotelId: req.user.hotelId, stayId: req.stay._id, guestId: req.user._id, roomId: room._id,
      category: req.body.category, description: clean(req.body.description), priority: req.body.priority || 'Normal',
      status: ownerId ? 'Assigned' : 'Submitted', ownerId, dueAt
    });
    await audit(req, { action: 'request.submitted', entityType: 'request', entityId: ticket._id, summary: `New ${ticket.category} request for room ${room.roomNumber}`, toStatus: ticket.status });
    const dto = publicRequest(await ticket.populate([{ path: 'roomId', select: 'roomNumber' }, { path: 'guestId', select: 'name' }, { path: 'ownerId', select: 'name' }]));
    req.app.get('io')?.to(`hotel:${req.user.hotelId}:staff`).emit('request:new', dto);
    await emitGuest(req, 'request:updated', dto);
    res.status(201).json({ request: dto });
  } catch (error) { next(error); }
});
router.get('/guest/requests', ...role('guest'), async (req, res, next) => {
  try {
    const rows = await ServiceRequest.find({ hotelId: req.user.hotelId, guestId: req.user._id }).sort({ createdAt: -1 }).populate('roomId', 'roomNumber').populate('ownerId', 'name');
    res.json({ requests: rows.map(publicRequest) });
  } catch (error) { next(error); }
});
router.patch('/guest/requests/:id/close', ...role('guest'), validate([param('id').isMongoId()]), async (req, res, next) => {
  try {
    const ticket = await ServiceRequest.findOne({ _id: req.params.id, hotelId: req.user.hotelId, guestId: req.user._id });
    if (!ticket) return res.status(404).json({ error: 'Request not found.' });
    if (ticket.status !== 'Completed') return res.status(409).json({ error: 'Only a completed request can be closed.' });
    ticket.status = 'Closed'; ticket.closedAt = new Date(); await ticket.save();
    await audit(req, { action: 'request.closed', entityType: 'request', entityId: ticket._id, summary: 'Guest confirmed the service and closed the request', fromStatus: 'Completed', toStatus: 'Closed' });
    req.app.get('io')?.to(`hotel:${req.user.hotelId}:staff`).emit('request:updated', { id: String(ticket._id), status: ticket.status });
    res.json({ request: { id: String(ticket._id), status: ticket.status } });
  } catch (error) { next(error); }
});

router.post('/staff/phone-request', ...role('staff', 'admin'), validate([
  body('roomNumber').isString().matches(/^[A-Za-z0-9-]+$/).isLength({ min: 1, max: 12 }),
  body('category').isString().isIn(departments),
  body('description').isString().isLength({ min: 8, max: 600 }).custom(noMarkup),
  body('priority').optional().isIn(['Normal', 'Urgent'])
]), async (req, res, next) => {
  try {
    const room = await Room.findOne({ hotelId: req.user.hotelId, roomNumber: clean(req.body.roomNumber), status: 'Occupied' }).select('roomNumber');
    if (!room) return res.status(409).json({ error: 'Phone requests need an occupied room with an active stay.' });
    const stay = await Stay.findOne({ hotelId: req.user.hotelId, roomId: room._id, status: 'Active' }).select('_id guestId');
    if (!stay) return res.status(409).json({ error: 'No active guest stay was found for this room.' });
    const ownerId = await pickLeastLoaded(req.user.hotelId, req.body.category);
    const ticket = await ServiceRequest.create({ hotelId: req.user.hotelId, stayId: stay._id, guestId: stay.guestId, roomId: room._id, category: req.body.category, description: clean(req.body.description), priority: req.body.priority || 'Normal', source: 'Phone', status: ownerId ? 'Assigned' : 'Submitted', ownerId, dueAt: new Date(Date.now() + (req.body.priority === 'Urgent' ? 10 : 30) * 60000) });
    await audit(req, { action: 'request.phone_intake', entityType: 'request', entityId: ticket._id, summary: 'Front desk recorded a phone request for room ' + room.roomNumber, toStatus: ticket.status });
    const dto = publicRequest(await ticket.populate([{ path: 'roomId', select: 'roomNumber' }, { path: 'guestId', select: 'name' }, { path: 'ownerId', select: 'name' }]));
    req.app.get('io')?.to('hotel:' + req.user.hotelId + ':staff').emit('request:new', dto);
    req.app.get('io')?.to('guest:' + stay.guestId).emit('request:updated', dto);
    res.status(201).json({ request: dto });
  } catch (error) { next(error); }
});

router.get('/staff/requests', ...role('staff', 'admin'), async (req, res, next) => {
  try {
    const scope = { hotelId: req.user.hotelId };
    if (req.user.role === 'staff') scope.$or = [{ ownerId: req.user._id }, { ownerId: null, category: req.user.department }];
    if (req.query.status && ['Submitted', 'Assigned', 'Accepted', 'In Progress', 'Completed', 'Closed', 'Declined', 'Escalated'].includes(req.query.status)) scope.status = req.query.status;
    const rows = await ServiceRequest.find(scope).sort({ priority: -1, createdAt: -1 }).limit(150).populate('roomId', 'roomNumber').populate('guestId', 'name').populate('ownerId', 'name');
    res.json({ requests: rows.map(publicRequest) });
  } catch (error) { next(error); }
});
router.patch('/staff/requests/:id/status', ...role('staff'), validate([
  param('id').isMongoId(), body('action').isIn(['accept', 'start', 'complete', 'decline']),
  body('reason').optional().isString().isLength({ max: 240 }).custom(noMarkup)
]), async (req, res, next) => {
  try {
    const ticket = await ServiceRequest.findOne({ _id: req.params.id, hotelId: req.user.hotelId, category: req.user.department });
    if (!ticket) return res.status(404).json({ error: 'Request not found in your department.' });
    if (ticket.ownerId && String(ticket.ownerId) !== String(req.user._id)) return res.status(403).json({ error: 'This request belongs to another staff member.' });
    const before = ticket.status;
    const action = req.body.action;
    if (action === 'accept' && ['Submitted', 'Assigned', 'Escalated'].includes(before)) { ticket.ownerId = req.user._id; ticket.status = 'Accepted'; }
    else if (action === 'start' && before === 'Accepted' && String(ticket.ownerId) === String(req.user._id)) ticket.status = 'In Progress';
    else if (action === 'complete' && before === 'In Progress' && String(ticket.ownerId) === String(req.user._id)) ticket.status = 'Completed';
    else if (action === 'decline' && ['Submitted', 'Assigned', 'Accepted', 'Escalated'].includes(before)) {
      if (!clean(req.body.reason)) return res.status(400).json({ error: 'Add a reason so the request can be reassigned.' });
      ticket.ownerId = await pickLeastLoaded(req.user.hotelId, ticket.category, req.user._id);
      ticket.status = ticket.ownerId ? 'Assigned' : 'Submitted';
    } else return res.status(409).json({ error: 'That status change is not allowed.' });
    await ticket.save();
    await audit(req, { action: `request.${action}`, entityType: 'request', entityId: ticket._id, summary: ({ accept: 'Accepted', start: 'Started', complete: 'Completed', decline: 'Declined' }[action] + ' request ' + String(ticket._id).slice(-6)), reason: req.body.reason, fromStatus: before, toStatus: ticket.status });
    await emitHotel(req, 'request:updated', { id: String(ticket._id), status: ticket.status });
    req.app.get('io')?.to(`guest:${ticket.guestId}`).emit('request:updated', { id: String(ticket._id), status: ticket.status });
    res.json({ request: { id: String(ticket._id), status: ticket.status, ownerId: ticket.ownerId } });
  } catch (error) { next(error); }
});

router.get('/admin/staff', ...role('admin'), async (req, res, next) => {
  try { res.json({ staff: await User.find({ hotelId: req.user.hotelId, role: 'staff' }).select('_id name email department active').sort({ name: 1 }) }); } catch (error) { next(error); }
});
router.post('/admin/staff', ...role('admin'), validate([
  body('name').isString().isLength({ min: 2, max: 80 }).custom(noMarkup), body('email').isEmail().normalizeEmail(),
  body('department').isIn(departments), passwordRule
]), async (req, res, next) => {
  try {
    const user = await User.create({ hotelId: req.user.hotelId, name: clean(req.body.name), email: clean(req.body.email).toLowerCase(), passwordHash: await bcrypt.hash(req.body.password, 12), role: 'staff', department: req.body.department });
    await audit(req, { action: 'staff.created', entityType: 'staff', entityId: user._id, summary: `Added ${user.name} to ${user.department}` });
    res.status(201).json({ staff: publicUser(user) });
  } catch (error) { if (error.code === 11000) return res.status(409).json({ error: 'That email is already used in this hotel.' }); next(error); }
});
router.post('/admin/rooms', ...role('admin'), validate([body('roomNumber').isString().matches(/^[A-Za-z0-9-]+$/).isLength({ min: 1, max: 12 })]), async (req, res, next) => {
  try {
    const room = await Room.create({ hotelId: req.user.hotelId, roomNumber: clean(req.body.roomNumber), status: 'Available' });
    await audit(req, { action: 'room.created', entityType: 'room', entityId: room._id, summary: `Added room ${room.roomNumber}` });
    res.status(201).json({ room });
  } catch (error) { if (error.code === 11000) return res.status(409).json({ error: 'That room already exists.' }); next(error); }
});
router.patch('/admin/requests/:id/assign', ...role('admin'), validate([param('id').isMongoId(), body('staffId').isMongoId()]), async (req, res, next) => {
  try {
    const ticket = await ServiceRequest.findOne({ _id: req.params.id, hotelId: req.user.hotelId });
    const staff = await User.findOne({ _id: req.body.staffId, hotelId: req.user.hotelId, role: 'staff', active: true });
    if (!ticket || !staff) return res.status(404).json({ error: 'Request or staff member not found.' });
    if (staff.department !== ticket.category) return res.status(400).json({ error: 'Assign this request to someone in its department.' });
    const before = ticket.status; ticket.ownerId = staff._id; ticket.status = 'Assigned'; ticket.escalatedAt = undefined; await ticket.save();
    await audit(req, { action: 'request.reassigned', entityType: 'request', entityId: ticket._id, summary: `Assigned request to ${staff.name}`, fromStatus: before, toStatus: ticket.status });
    await emitHotel(req, 'request:updated', { id: String(ticket._id), status: ticket.status });
    res.json({ request: { id: String(ticket._id), status: ticket.status, ownerName: staff.name } });
  } catch (error) { next(error); }
});
router.post('/admin/requests/:id/escalate', ...role('admin'), validate([param('id').isMongoId(), body('reason').optional().isString().isLength({ max: 240 }).custom(noMarkup)]), async (req, res, next) => {
  try {
    const ticket = await ServiceRequest.findOne({ _id: req.params.id, hotelId: req.user.hotelId });
    if (!ticket || !activeStatuses.includes(ticket.status)) return res.status(409).json({ error: 'Only an open request can be escalated.' });
    const before = ticket.status; ticket.status = 'Escalated'; ticket.escalatedAt = new Date(); await ticket.save();
    await audit(req, { action: 'request.escalated', entityType: 'request', entityId: ticket._id, summary: `Escalated request ${String(ticket._id).slice(-6)}`, reason: req.body.reason, fromStatus: before, toStatus: ticket.status });
    await emitHotel(req, 'request:updated', { id: String(ticket._id), status: ticket.status });
    res.json({ request: { id: String(ticket._id), status: ticket.status } });
  } catch (error) { next(error); }
});
router.get('/admin/logs', ...role('admin'), async (req, res, next) => {
  try {
    const logs = await ActivityLog.find({ hotelId: req.user.hotelId }).sort({ createdAt: -1 }).limit(250).lean();
    res.json({ logs });
  } catch (error) { next(error); }
});
router.get('/admin/summary', ...role('admin'), async (req, res, next) => {
  try {
    const [open, overdue, completedToday, rooms, requests] = await Promise.all([
      ServiceRequest.countDocuments({ hotelId: req.user.hotelId, status: { $in: activeStatuses } }),
      ServiceRequest.countDocuments({ hotelId: req.user.hotelId, status: { $in: activeStatuses }, dueAt: { $lt: new Date() } }),
      ServiceRequest.countDocuments({ hotelId: req.user.hotelId, status: { $in: ['Completed', 'Closed'] }, updatedAt: { $gte: new Date(new Date().setHours(0,0,0,0)) } }),
      Room.countDocuments({ hotelId: req.user.hotelId, status: { $in: ['Available', 'Ready for Check-in'] } }),
      ServiceRequest.find({ hotelId: req.user.hotelId }).sort({ createdAt: -1 }).limit(12).populate('roomId', 'roomNumber').populate('guestId', 'name').populate('ownerId', 'name')
    ]);
    res.json({ metrics: { open, overdue, completedToday, availableRooms: rooms }, requests: requests.map(publicRequest) });
  } catch (error) { next(error); }
});

module.exports = router;





