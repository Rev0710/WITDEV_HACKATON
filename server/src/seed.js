require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { Hotel, User, Room } = require('./models');

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('Set MONGODB_URI before running the seed script.');
  if (!process.env.DEMO_ADMIN_EMAIL || !process.env.DEMO_ADMIN_PASSWORD) throw new Error('Set DEMO_ADMIN_EMAIL and DEMO_ADMIN_PASSWORD to create the demo admin.');
  if (process.env.DEMO_ADMIN_PASSWORD.length < 12) throw new Error('DEMO_ADMIN_PASSWORD must be at least 12 characters.');
  await mongoose.connect(process.env.MONGODB_URI);
  const slug = process.env.DEMO_HOTEL_SLUG || 'stayflow-demo';
  let hotel = await Hotel.findOne({ slug });
  if (!hotel) hotel = await Hotel.create({ name: process.env.DEMO_HOTEL_NAME || 'StayFlow Demo Hotel', slug });
  let admin = await User.findOne({ hotelId: hotel._id, email: process.env.DEMO_ADMIN_EMAIL.toLowerCase() });
  if (!admin) admin = await User.create({ hotelId: hotel._id, name: 'Hotel Administrator', email: process.env.DEMO_ADMIN_EMAIL.toLowerCase(), passwordHash: await bcrypt.hash(process.env.DEMO_ADMIN_PASSWORD, 12), role: 'admin' });
  for (const roomNumber of ['101', '102', '201']) {
    await Room.updateOne({ hotelId: hotel._id, roomNumber }, { $setOnInsert: { hotelId: hotel._id, roomNumber, status: 'Available' } }, { upsert: true });
  }
  console.log(`Seeded ${hotel.slug} with administrator ${admin.email}.`);
  await mongoose.disconnect();
}
main().catch(error => { console.error(error.message); process.exit(1); });
