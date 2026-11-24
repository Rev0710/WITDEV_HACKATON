const mongoose = require('mongoose');

const hotelSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 100 },
  slug: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 48 },
  createdAt: { type: Date, default: Date.now }
}, { timestamps: true });

const userSchema = new mongoose.Schema({
  hotelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hotel', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 80 },
  email: { type: String, lowercase: true, trim: true, maxlength: 254 },
  passwordHash: { type: String },
  role: { type: String, enum: ['guest', 'staff', 'admin'], required: true, index: true },
  department: { type: String, enum: ['Housekeeping', 'Room Service', 'Maintenance', 'Guest Services', 'General'] },
  active: { type: Boolean, default: true }
}, { timestamps: true });
userSchema.index({ hotelId: 1, email: 1 }, { unique: true, partialFilterExpression: { email: { $type: 'string' } } });

const roomSchema = new mongoose.Schema({
  hotelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hotel', required: true, index: true },
  roomNumber: { type: String, required: true, trim: true, maxlength: 12 },
  status: { type: String, enum: ['Available', 'Occupied', 'Needs Cleaning', 'Cleaning in Progress', 'Ready for Check-in'], default: 'Available' },
  bookingLock: String,
  bookingLockUntil: Date
}, { timestamps: true });
roomSchema.index({ hotelId: 1, roomNumber: 1 }, { unique: true });

const staySchema = new mongoose.Schema({
  hotelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hotel', required: true, index: true },
  roomId: { type: mongoose.Schema.Types.ObjectId, ref: 'Room', required: true },
  guestId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  status: { type: String, enum: ['Active', 'Ended'], default: 'Active', index: true },
  accessTokenHash: { type: String, select: false },
  checkedInAt: { type: Date, default: Date.now },
  checkedOutAt: Date
}, { timestamps: true });

const requestSchema = new mongoose.Schema({
  hotelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hotel', required: true, index: true },
  stayId: { type: mongoose.Schema.Types.ObjectId, ref: 'Stay', required: true },
  guestId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  roomId: { type: mongoose.Schema.Types.ObjectId, ref: 'Room', required: true },
  category: { type: String, enum: ['Housekeeping', 'Room Service', 'Maintenance', 'Guest Services', 'General'], required: true },
  description: { type: String, required: true, trim: true, maxlength: 600 },
  priority: { type: String, enum: ['Normal', 'Urgent'], default: 'Normal' },
  source: { type: String, enum: ['QR', 'Phone'], default: 'QR' },
  status: { type: String, enum: ['Submitted', 'Assigned', 'Accepted', 'In Progress', 'Completed', 'Closed', 'Declined', 'Escalated'], default: 'Submitted', index: true },
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  dueAt: { type: Date, required: true, index: true },
  escalatedAt: Date,
  closedAt: Date
}, { timestamps: true });
requestSchema.index({ hotelId: 1, status: 1, createdAt: -1 });
requestSchema.index({ hotelId: 1, guestId: 1, createdAt: -1 });

const reservationSchema = new mongoose.Schema({
  hotelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hotel', required: true, index: true },
  roomId: { type: mongoose.Schema.Types.ObjectId, ref: 'Room', required: true },
  guestName: { type: String, required: true, trim: true, maxlength: 80 },
  guestEmail: { type: String, required: true, lowercase: true, trim: true, maxlength: 254 },
  checkIn: { type: Date, required: true },
  checkOut: { type: Date, required: true },
  confirmationHash: { type: String, required: true, select: false },
  status: { type: String, enum: ['Reserved', 'Checked-in', 'Cancelled', 'Completed'], default: 'Reserved', index: true },
  stayId: { type: mongoose.Schema.Types.ObjectId, ref: 'Stay' }
}, { timestamps: true });
reservationSchema.index({ hotelId: 1, roomId: 1, checkIn: 1, checkOut: 1, status: 1 });
reservationSchema.index({ hotelId: 1, confirmationHash: 1 }, { unique: true });

const activitySchema = new mongoose.Schema({
  hotelId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hotel', required: true, index: true },
  actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  actorName: { type: String, required: true, maxlength: 80 },
  actorRole: { type: String, enum: ['guest', 'staff', 'admin', 'system'], required: true },
  action: { type: String, required: true, maxlength: 64 },
  entityType: { type: String, enum: ['request', 'room', 'stay', 'staff', 'hotel', 'reservation'], required: true },
  entityId: { type: String, required: true, maxlength: 48 },
  summary: { type: String, required: true, maxlength: 240 },
  reason: { type: String, maxlength: 240 },
  fromStatus: { type: String, maxlength: 32 },
  toStatus: { type: String, maxlength: 32 },
  createdAt: { type: Date, default: Date.now, immutable: true, index: true }
}, { versionKey: false, strict: 'throw' });
activitySchema.index({ hotelId: 1, createdAt: -1 });

module.exports = {
  Hotel: mongoose.model('Hotel', hotelSchema),
  User: mongoose.model('User', userSchema),
  Room: mongoose.model('Room', roomSchema),
  Stay: mongoose.model('Stay', staySchema),
  ServiceRequest: mongoose.model('ServiceRequest', requestSchema),
  Reservation: mongoose.model('Reservation', reservationSchema),
  ActivityLog: mongoose.model('ActivityLog', activitySchema)
};



