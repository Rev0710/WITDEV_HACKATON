import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { io } from 'socket.io-client';
import { QRCodeSVG } from 'qrcode.react';
import { api } from './api';
import './style.css';

const departments = ['Housekeeping', 'Room Service', 'Maintenance', 'Guest Services', 'General'];
const statuses = ['All requests', 'Submitted', 'Assigned', 'Accepted', 'In Progress', 'Escalated', 'Completed', 'Closed'];
const time = (value) => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(value));
const localDate = (date = new Date()) => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
const dateTime = (value) => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value));

function App() {
  const [session, setSession] = useState(null);
  const [view, setView] = useState('requests');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [requests, setRequests] = useState([]);
  const [logs, setLogs] = useState([]);
  const [staff, setStaff] = useState([]);
  const [rooms, setRooms] = useState([]);
  const [metrics, setMetrics] = useState({ open: 0, overdue: 0, completedToday: 0, availableRooms: 0 });
  const [statusFilter, setStatusFilter] = useState('All requests');
  const [search, setSearch] = useState('');
  const [signup, setSignup] = useState(false);
  const [booking, setBooking] = useState(false);
  const [qrToken, setQrToken] = useState('');

  const notify = useCallback((message) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 3200);
  }, []);

  const refresh = useCallback(async () => {
    if (!session) return;
    try {
      if (session.user.role === 'guest') {
        const data = await api('/guest/requests');
        setRequests(data.requests);
      } else {
        const data = await api('/staff/requests');
        setRequests(data.requests);
        const roomData = await api('/staff/rooms');
        setRooms(roomData.rooms);
        if (session.user.role === 'admin') {
          const [summary, logData, staffData] = await Promise.all([api('/admin/summary'), api('/admin/logs'), api('/admin/staff')]);
          setMetrics(summary.metrics);
          setRequests(data.requests);
          setLogs(logData.logs);
          setStaff(staffData.staff);
        }
      }
    } catch (err) { setError(err.message); }
  }, [session]);

  useEffect(() => {
    let mounted = true;
    async function boot() {
      const url = new URL(window.location.href);
      const token = url.searchParams.get('token');
      if (window.location.pathname === '/guest/activate' && token) {
        try {
          const data = await api('/auth/guest-session', { method: 'POST', body: JSON.stringify({ token }) });
          window.history.replaceState({}, '', '/');
          if (mounted) { setSession(data); notify(`Welcome to ${data.hotel.name}`); }
        } catch (err) { if (mounted) { setError(err.message); window.history.replaceState({}, '', '/'); } }
      } else {
        try { const data = await api('/auth/me'); if (mounted) setSession(data); } catch { /* Signed out is the normal first-run state. */ }
      }
      if (mounted) setLoading(false);
    }
    boot();
    return () => { mounted = false; };
  }, [notify]);

  useEffect(() => { if (session) refresh(); }, [session, refresh]);
  useEffect(() => {
    if (!session) return undefined;
    const socket = io({ withCredentials: true });
    socket.on('request:new', refresh);
    socket.on('request:updated', refresh);
    socket.on('room:updated', refresh);
    socket.on('stay:ended', () => { setSession(null); setError('Your stay has ended. Contact the front desk if you need help.'); });
    return () => socket.disconnect();
  }, [session, refresh]);

  async function submitAuth(event) {
    event.preventDefault(); setError('');
    const form = new FormData(event.currentTarget);
    const body = Object.fromEntries(form.entries());
    try {
      const data = await api(signup ? '/auth/signup' : '/auth/login', { method: 'POST', body: JSON.stringify(body) });
      setSession(data); setView('requests'); notify(signup ? 'Hotel workspace created' : 'Welcome back');
    } catch (err) { setError(err.message); }
  }
  async function logout() {
    try { await api('/auth/logout', { method: 'POST' }); } catch { /* Clear the local view either way. */ }
    setSession(null); setRequests([]); setView('requests');
  }

  const filteredRequests = useMemo(() => requests.filter(item => {
    const matchesStatus = statusFilter === 'All requests' || item.status === statusFilter;
    const query = search.toLowerCase();
    const matchesSearch = !query || [item.guestName, item.roomNumber, item.category, item.description, item.status].join(' ').toLowerCase().includes(query);
    return matchesStatus && matchesSearch;
  }), [requests, statusFilter, search]);

  if (loading) return <main className="boot"><span className="brand-mark">S</span><p>Opening StayFlow…</p></main>;
  if (!session && booking) return <GuestBooking onBack={() => setBooking(false)} />;
  if (!session) return <AuthScreen signup={signup} setSignup={setSignup} error={error} onSubmit={submitAuth} onReserve={() => setBooking(true)} />;
  if (session.user.role === 'guest') return <GuestPortal session={session} requests={requests} refresh={refresh} notify={notify} error={error} logout={logout} toast={toast} />;

  const isAdmin = session.user.role === 'admin';
  const tabs = [{ id: 'requests', label: 'Requests', count: requests.filter(r => !['Closed', 'Completed'].includes(r.status)).length }, { id: 'frontdesk', label: 'Front desk' }, ...(isAdmin ? [{ id: 'team', label: 'Team' }, { id: 'activity', label: 'Activity log' }] : [])];
  return <div className="workspace">
    <aside className="rail">
      <div className="brand"><span className="brand-mark">S</span><span>StayFlow</span></div>
      <div className="workspace-name"><span className="hotel-dot" />{session.hotel?.name || 'Hotel workspace'}</div>
      <nav aria-label="Main navigation">
        <p className="nav-label">Workspace</p>
        {tabs.map(tab => <button key={tab.id} className={`nav-item ${view === tab.id ? 'active' : ''}`} onClick={() => setView(tab.id)}><span>{tab.label}</span>{tab.count > 0 && <span className="nav-count">{tab.count}</span>}</button>)}
      </nav>
      <div className="rail-bottom"><div className="signed-in"><span className="avatar">{session.user.name.slice(0, 1).toUpperCase()}</span><span><strong>{session.user.name}</strong><small>{isAdmin ? 'Hotel administrator' : session.user.department}</small></span></div><button className="text-button signout" onClick={logout}>Sign out</button></div>
    </aside>
    <main className="main-area">
      <header className="topbar"><div className="crumb">{isAdmin ? 'Hotel operations' : session.user.department}<span>/</span><b>{tabs.find(tab => tab.id === view)?.label}</b></div><div className="top-actions"><span className="live-dot" />Live updates <button className="avatar small" aria-label="Account">{session.user.name.slice(0, 1).toUpperCase()}</button></div></header>
      <div className="content">
        {error && <div className="notice error-notice" role="alert">{error}<button onClick={() => setError('')}>Dismiss</button></div>}
        {view === 'requests' && <>
          <div className="page-head"><div><p className="eyebrow">{session.hotel?.name}</p><h1>Service requests</h1><p className="subhead">Every guest request has an owner, a response target, and a clear next step.</p></div><button className="primary" onClick={() => setView('frontdesk')}>Check in a guest <span>↗</span></button></div>
          {isAdmin && <div className="metrics-row"><Metric label="Open requests" value={metrics.open} note="need staff attention" /><Metric label="Past response target" value={metrics.overdue} note="escalated automatically" alert={metrics.overdue > 0} /><Metric label="Completed today" value={metrics.completedToday} note="guest confirmation closes" /><Metric label="Rooms available" value={metrics.availableRooms} note="ready for check-in" /></div>}
          <section className="queue-panel" aria-label="Service request queue">
            <div className="queue-toolbar"><div><h2>Request queue</h2><p>{filteredRequests.length} {filteredRequests.length === 1 ? 'request' : 'requests'} shown</p></div><div className="filters"><label className="searchbox"><span aria-hidden="true">⌕</span><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search requests" aria-label="Search requests" /></label><select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} aria-label="Filter by status">{statuses.map(item => <option key={item}>{item}</option>)}</select></div></div>
            <div className="request-table-head"><span>Guest / request</span><span>Room</span><span>Department</span><span>Owner</span><span>Due</span><span>Status</span><span>Action</span></div>
            <div className="request-list">{filteredRequests.length ? filteredRequests.map(item => <RequestRow key={item.id} item={item} staff={staff} isAdmin={isAdmin} refresh={refresh} notify={notify} />) : <div className="empty-state"><div className="empty-mark">✓</div><strong>No requests in this view</strong><p>New room requests will appear here as soon as a guest sends one.</p></div>}</div>
          </section>
        </>}
        {view === 'frontdesk' && <FrontDesk rooms={rooms} refresh={refresh} notify={notify} isAdmin={isAdmin} canManageRooms={isAdmin || session.user.department === 'Housekeeping'} />}
        {view === 'team' && isAdmin && <Team staff={staff} refresh={refresh} notify={notify} />}
        {view === 'activity' && isAdmin && <Activity logs={logs} />}
      </div>
    </main>
    {toast && <div className="toast" role="status">{toast}</div>}
  </div>;
}

function Metric({ label, value, note, alert }) {
  return <div className={`metric ${alert ? 'metric-alert' : ''}`}><span>{label}</span><strong>{value}</strong><small>{note}</small></div>;
}

function GuestBooking({ onBack }) {
  const [hotels, setHotels] = useState([]);
  const [hotelSlug, setHotelSlug] = useState('');
  const [rooms, setRooms] = useState([]);
  const [roomNumber, setRoomNumber] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const today = localDate();
  const tomorrowDate = new Date(); tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrow = localDate(tomorrowDate);
  const [checkIn, setCheckIn] = useState(today);
  const [checkOut, setCheckOut] = useState(tomorrow);
  useEffect(() => { api('/public/hotels').then(data => setHotels(data.hotels)).catch(err => setError(err.message)); }, []);
  useEffect(() => {
    if (!hotelSlug || !checkIn || !checkOut) { setRooms([]); return; }
    api('/public/hotels/' + encodeURIComponent(hotelSlug) + '/rooms?checkIn=' + encodeURIComponent(checkIn) + '&checkOut=' + encodeURIComponent(checkOut))
      .then(data => { setRooms(data.rooms); setRoomNumber(current => data.rooms.some(room => room.roomNumber === current) ? current : ''); })
      .catch(err => setError(err.message));
  }, [hotelSlug, checkIn, checkOut]);
  async function reserve(event) {
    event.preventDefault(); const target = event.currentTarget; const form = new FormData(target); setError('');
    try { setResult(await api('/public/reservations', { method: 'POST', body: JSON.stringify(Object.fromEntries(form.entries())) })); target.reset(); }
    catch (err) { setError(err.message); }
  }
  return <main className="booking-shell"><header className="guest-header"><div className="brand"><span className="brand-mark">S</span><span>StayFlow</span></div><button className="text-button" onClick={onBack}>Back to staff sign in</button></header><div className="booking-content"><p className="eyebrow">PLAN YOUR STAY</p><h1>Find a room.<br />Know who to call.</h1><p className="booking-intro">Choose a hotel and dates. Your confirmation code will activate a private room service QR when you check in.</p>
    {result ? <section className="booking-confirmation"><span className="confirmation-check">✓</span><h2>Your room is reserved</h2><p>{result.reservation.hotel} · Room {result.reservation.roomNumber}</p><p>{new Date(result.reservation.checkIn).toLocaleDateString()} to {new Date(result.reservation.checkOut).toLocaleDateString()}</p><div className="confirmation-code"><span>Show this code at the front desk</span><strong>{result.confirmationCode}</strong></div><button className="secondary" onClick={() => { setResult(null); onBack(); }}>Done</button></section> : <form className="booking-form" onSubmit={reserve}>
      <label className="field"><span>Hotel</span><select name="hotelSlug" value={hotelSlug} onChange={e => setHotelSlug(e.target.value)} required><option value="">Choose a hotel</option>{hotels.map(hotel => <option key={hotel.slug} value={hotel.slug}>{hotel.name}</option>)}</select></label>
      <div className="booking-dates"><label className="field"><span>Check in</span><input type="date" name="checkIn" value={checkIn} min={today} onChange={e => setCheckIn(e.target.value)} required /></label><label className="field"><span>Check out</span><input type="date" name="checkOut" value={checkOut} min={checkIn || today} onChange={e => setCheckOut(e.target.value)} required /></label></div>
      <label className="field"><span>Available room</span><select name="roomNumber" value={roomNumber} onChange={e => setRoomNumber(e.target.value)} required><option value="">{hotelSlug ? (rooms.length ? 'Choose a room' : 'No rooms available for those dates') : 'Choose a hotel first'}</option>{rooms.map(room => <option key={room.roomNumber} value={room.roomNumber}>Room {room.roomNumber}</option>)}</select></label>
      <Field label="Guest name" name="guestName" placeholder="Name for the reservation" required maxLength={80} />
      <Field label="Email for your reservation" name="guestEmail" type="email" placeholder="you@example.com" required maxLength={254} />
      {error && <div className="inline-error" role="alert">{error}</div>}
      <button className="primary" type="submit">Reserve this room <span>→</span></button>
      <small className="booking-note">No payment is collected in this MVP. Keep your confirmation code private.</small>
    </form>}
  </div></main>;
}

function AuthScreen({ signup, setSignup, error, onSubmit, onReserve }) {
  return <main className="auth-shell">
    <section className="auth-story"><div className="brand brand-light"><span className="brand-mark">S</span><span>StayFlow</span></div><div className="story-copy"><p className="eyebrow">HOTEL SERVICE, IN SYNC</p><h1>Every request<br />has a way forward.</h1><p>One clear queue for room issues, staff handoffs, and guest updates.</p></div><div className="story-foot"><span className="live-dot" />Service desk ready for the next guest</div></section>
    <section className="auth-form-area"><form className="auth-form" onSubmit={onSubmit}>
      <div><h2>{signup ? 'Create a hotel workspace' : 'Sign in to StayFlow'}</h2><p>{signup ? 'Set up the hotel and administrator account.' : 'Use your hotel workspace and staff account.'}</p></div>
      {signup ? <>
        <Field label="Hotel name" name="hotelName" placeholder="e.g. The Harbor House" required maxLength={100} />
        <Field label="Workspace address" name="hotelSlug" placeholder="harbor-house" required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" maxLength={48} hint="Lowercase letters, numbers, and hyphens." />
        <Field label="Your name" name="name" placeholder="Name" required maxLength={80} />
      </> : <Field label="Hotel workspace" name="hotelSlug" placeholder="hotel-name" required maxLength={48} />}
      <Field label="Email" name="email" type="email" placeholder="you@hotel.com" required maxLength={254} />
      <Field label="Password" name="password" type="password" placeholder="At least 12 characters" required minLength={12} maxLength={128} />
      {signup && <p className="field-hint">Use upper and lower case, a number, and a symbol.</p>}
      {error && <div className="inline-error" role="alert">{error}</div>}
      <button className="primary auth-submit" type="submit">{signup ? 'Create workspace' : 'Sign in'} <span>→</span></button>
      <p className="auth-switch">{signup ? 'Already have a workspace?' : 'Setting up a new hotel?'} <button type="button" onClick={() => setSignup(!signup)}>{signup ? 'Sign in' : 'Create one'}</button></p>
      <button type="button" className="reserve-link" onClick={onReserve}>Looking for a room? Browse hotels and reserve</button><p className="privacy-note">Secure staff access · Guest service opens from a verified stay</p>
    </form></section>
  </main>;
}

function Field({ label, name, hint, ...props }) {
  return <label className="field"><span>{label}</span><input name={name} {...props} />{hint && <small>{hint}</small>}</label>;
}

function RequestRow({ item, staff, isAdmin, refresh, notify }) {
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const overdue = new Date(item.dueAt) < new Date() && !['Completed', 'Closed'].includes(item.status);
  async function change(action) {
    setBusy(true);
    try {
      if (isAdmin && action === 'escalate') await api(`/admin/requests/${item.id}/escalate`, { method: 'POST', body: JSON.stringify({ reason: 'Admin escalation' }) });
      else if (isAdmin && action.startsWith('assign:')) await api(`/admin/requests/${item.id}/assign`, { method: 'PATCH', body: JSON.stringify({ staffId: action.slice(7) }) });
      else await api(`/staff/requests/${item.id}/status`, { method: 'PATCH', body: JSON.stringify({ action, reason }) });
      setDeclining(false); setReason(''); await refresh(); notify(action === 'decline' ? 'Request returned to the department queue' : 'Request updated');
    } catch (err) { notify(err.message); }
    finally { setBusy(false); }
  }
  const action = (() => {
    if (isAdmin) return item.status !== 'Closed' && item.status !== 'Completed' ? 'admin' : 'none';
    if (['Submitted', 'Assigned', 'Escalated'].includes(item.status)) return 'accept';
    if (item.status === 'Accepted') return 'start';
    if (item.status === 'In Progress') return 'complete';
    return 'none';
  })();
  return <article className={`request-row ${overdue ? 'is-overdue' : ''}`}>
    <div className="request-main"><span className="request-priority">{item.priority === 'Urgent' && <i>Urgent</i>} {item.guestName || 'Guest'}</span><p>{item.description}</p><small>Created {dateTime(item.createdAt)} · {item.source === 'Phone' ? 'Phone call' : 'Room QR'}</small></div>
    <div className="room-cell"><strong>{item.roomNumber || '—'}</strong></div>
    <div className="category-cell">{item.category}</div>
    <div className="owner-cell">{item.ownerName || <span className="muted">Unassigned</span>}</div>
    <div className={`due-cell ${overdue ? 'late' : ''}`}>{['Completed', 'Closed'].includes(item.status) ? '—' : overdue ? 'Overdue' : time(item.dueAt)}</div>
    <div><Status status={item.status} /></div>
    <div className="row-action">
      {action === 'admin' && <div className="admin-actions"><select aria-label={`Assign ${item.category} request`} value={item.ownerId || ''} onChange={e => { if (e.target.value) change(`assign:${e.target.value}`); }}><option value="">Assign…</option>{staff.filter(person => person.department === item.category && person.active).map(person => <option key={person._id} value={person._id}>{person.name}</option>)}</select><button className="small-button" disabled={busy || item.status === 'Escalated'} onClick={() => change('escalate')}>Escalate</button></div>}
      {action === 'accept' && <><button className="small-button strong" disabled={busy} onClick={() => change('accept')}>Accept</button><button className="link-button" onClick={() => setDeclining(!declining)}>Decline</button></>}
      {action === 'start' && <button className="small-button strong" disabled={busy} onClick={() => change('start')}>Start work</button>}
      {action === 'complete' && <button className="small-button strong" disabled={busy} onClick={() => change('complete')}>Complete</button>}
      {action === 'none' && <span className="muted">{item.status === 'Completed' ? 'Awaiting guest' : '—'}</span>}
      {declining && <div className="decline-box"><label>Why are you returning this to the queue?<input value={reason} onChange={e => setReason(e.target.value)} maxLength={240} /></label><button className="small-button" disabled={busy || reason.trim().length < 3} onClick={() => change('decline')}>Return request</button></div>}
    </div>
  </article>;
}
function Status({ status }) { return <span className={`status status-${status.toLowerCase().replaceAll(' ', '-')}`}><i />{status}</span>; }

function FrontDesk({ rooms, refresh, notify, isAdmin, canManageRooms }) {
  const [guest, setGuest] = useState(null);
  const [error, setError] = useState('');
  async function checkIn(event) {
    event.preventDefault(); const target = event.currentTarget; setError(''); const form = new FormData(target);
    try { const result = await api('/staff/check-in', { method: 'POST', body: JSON.stringify(Object.fromEntries(form.entries())) }); setGuest(result); target.reset(); await refresh(); notify('Guest checked in · QR access created'); }
    catch (err) { setError(err.message); }
  }
  async function checkout(event) {
    event.preventDefault(); const target = event.currentTarget; const form = new FormData(target);
    try { const result = await api('/staff/check-out', { method: 'POST', body: JSON.stringify(Object.fromEntries(form.entries())) }); await refresh(); notify('Room ' + result.room.roomNumber + ' is marked for cleaning'); target.reset(); }
    catch (err) { setError(err.message); }
  }
  async function phoneRequest(event) {
    event.preventDefault(); const target = event.currentTarget; const form = new FormData(target);
    try { await api('/staff/phone-request', { method: 'POST', body: JSON.stringify(Object.fromEntries(form.entries())) }); target.reset(); await refresh(); notify('Phone request added to the tracked queue'); }
    catch (err) { setError(err.message); }
  }
  async function updateRoom(room) {
    const next = room.status === 'Needs Cleaning' ? 'Cleaning in Progress' : 'Ready for Check-in';
    try { await api('/staff/rooms/' + encodeURIComponent(room.roomNumber) + '/status', { method: 'PATCH', body: JSON.stringify({ status: next }) }); await refresh(); notify('Room ' + room.roomNumber + ' · ' + next.toLowerCase()); }
    catch (err) { setError(err.message); }
  }
  async function addRoom(event) {
    event.preventDefault(); const target = event.currentTarget; const form = new FormData(target);
    try { await api('/admin/rooms', { method: 'POST', body: JSON.stringify(Object.fromEntries(form.entries())) }); target.reset(); await refresh(); notify('Room added to this hotel'); }
    catch (err) { setError(err.message); }
  }
  return <><div className="page-head"><div><p className="eyebrow">RECEPTION</p><h1>Front desk</h1><p className="subhead">Verify reservations, record phone requests, and give each checked-in guest a private QR path.</p></div></div>
    {error && <div className="notice error-notice" role="alert">{error}<button onClick={() => setError('')}>Dismiss</button></div>}
    <div className="desk-grid">
      <section className="form-panel"><h2>Check in a guest</h2><p>Enter the reservation code, or use the walk-in fields for an unbooked guest. The QR token is private to this active stay.</p><form onSubmit={checkIn}><Field label="Reservation code" name="confirmationCode" placeholder="10-character code (optional)" maxLength={10} pattern="[A-Fa-f0-9]{10}" /><Field label="Walk-in guest name" name="guestName" placeholder="Only needed for a walk-in" maxLength={80} /><label className="field"><span>Walk-in room</span><select name="roomNumber" defaultValue=""><option value="">Use available room (walk-in only)</option>{rooms.filter(room => ['Available', 'Ready for Check-in'].includes(room.status)).map(room => <option key={room._id} value={room.roomNumber}>{room.roomNumber} · {room.status}</option>)}</select></label><button className="primary" type="submit">Activate stay <span>→</span></button></form></section>
      <section className="form-panel checkout-panel"><h2>Check out a guest</h2><p>Ends QR access and marks the room as needing cleaning.</p><form onSubmit={checkout}><label className="field"><span>Occupied room</span><select name="roomNumber" required defaultValue=""><option value="" disabled>Choose a room</option>{rooms.filter(room => room.status === 'Occupied').map(room => <option key={room._id} value={room.roomNumber}>{room.roomNumber}</option>)}</select></label><button className="secondary" type="submit">End stay</button></form></section>
      <section className="form-panel"><h2>Phone-to-ticket</h2><p>Record a call against an occupied room. It uses the same routing and status tracking as a QR request.</p><form onSubmit={phoneRequest}><label className="field"><span>Occupied room</span><select name="roomNumber" required defaultValue=""><option value="" disabled>Choose a room</option>{rooms.filter(room => room.status === 'Occupied').map(room => <option key={room._id} value={room.roomNumber}>{room.roomNumber}</option>)}</select></label><label className="field"><span>Department</span><select name="category">{departments.map(item => <option key={item}>{item}</option>)}</select></label><label className="field"><span>What did the guest report?</span><textarea name="description" rows="3" minLength="8" maxLength="600" required /></label><label className="priority-choice"><input type="checkbox" name="priority" value="Urgent" /><span><strong>Urgent</strong><small>Safety or essential room access issue.</small></span></label><button className="primary" type="submit">Create tracked request <span>→</span></button></form></section>
    </div>
    <section className="table-panel room-readiness"><h2>Room readiness</h2><div className="room-status-list">{rooms.map(room => <div className="room-status-row" key={room._id}><strong>Room {room.roomNumber}</strong><span>{room.status}</span>{canManageRooms && (room.status === 'Needs Cleaning' || room.status === 'Cleaning in Progress') && <button className="small-button" onClick={() => updateRoom(room)}>{room.status === 'Needs Cleaning' ? 'Start cleaning' : 'Mark ready'}</button>}</div>)}</div></section>
    {isAdmin && <section className="form-panel add-room-panel"><h2>Add a room</h2><p>Rooms are available to front desk staff in this hotel only.</p><form onSubmit={addRoom}><Field label="Room number" name="roomNumber" placeholder="e.g. 202" required maxLength={12} pattern="[A-Za-z0-9-]+" /><button className="secondary" type="submit">Add room</button></form></section>}
    {guest && <section className="qr-result"><div><p className="eyebrow">GUEST QR SESSION</p><h2>{guest.guest.name} · Room {guest.stay.roomNumber}</h2><p>Scan this private code to open the guest portal. Room details are only returned after the server verifies this active stay.</p><a href={guest.guestAccessUrl} target="_blank" rel="noreferrer">Open guest portal on this device ↗</a></div><div className="qr-card"><QRCodeSVG value={guest.guestAccessUrl} size={156} level="H" includeMargin /></div></section>}
  </>;
}

function Team({ staff, refresh, notify }) {
  const [error, setError] = useState('');
  async function add(event) {
    event.preventDefault(); const target = event.currentTarget; setError(''); const form = new FormData(target);
    try { await api('/admin/staff', { method: 'POST', body: JSON.stringify(Object.fromEntries(form.entries())) }); target.reset(); await refresh(); notify('Staff account added'); }
    catch (err) { setError(err.message); }
  }
  return <><div className="page-head"><div><p className="eyebrow">PEOPLE & ROUTING</p><h1>Team</h1><p className="subhead">Requests route by department, then to the staff member with the lightest open queue.</p></div></div><div className="team-layout"><section className="table-panel"><h2>Hotel staff</h2><div className="staff-list">{staff.map(person => <div className="staff-row" key={person._id}><span className="avatar">{person.name.slice(0,1)}</span><span><strong>{person.name}</strong><small>{person.email}</small></span><span className="department-tag">{person.department}</span><Status status={person.active ? 'Active' : 'Inactive'} /></div>)}{!staff.length && <p className="muted">No staff accounts yet. Add your first staff member.</p>}</div></section><section className="form-panel add-staff"><h2>Add staff account</h2><p>Give each team member one department for clear request routing.</p>{error && <div className="inline-error">{error}</div>}<form onSubmit={add}><Field label="Full name" name="name" required maxLength={80} /><Field label="Email" name="email" type="email" required maxLength={254} /><label className="field"><span>Department</span><select name="department">{departments.map(item => <option key={item}>{item}</option>)}</select></label><Field label="Temporary password" name="password" type="password" minLength={12} required maxLength={128} /><button className="primary" type="submit">Add to team <span>→</span></button></form></section></div></>;
}

function Activity({ logs }) {
  return <><div className="page-head"><div><p className="eyebrow">AUDIT TRAIL</p><h1>Activity log</h1><p className="subhead">A hotel-scoped record of check-ins, request handoffs, decisions, and escalation.</p></div><span className="log-count">Latest {logs.length} events</span></div><section className="activity-panel"><div className="activity-head"><span>Activity</span><span>Who</span><span>When</span></div>{logs.length ? logs.map(log => <div className="activity-row" key={log._id}><div><strong>{log.summary}</strong><small>{log.action.replaceAll('.', ' · ')}{log.reason ? ` · ${log.reason}` : ''}</small></div><span className="actor"><span className="avatar tiny">{log.actorName.slice(0,1)}</span>{log.actorName}<em>{log.actorRole}</em></span><time>{dateTime(log.createdAt)}</time></div>) : <div className="empty-state"><strong>No activity yet</strong><p>System actions will be recorded here.</p></div>}</section></>;
}

function GuestPortal({ session, requests, refresh, notify, error, logout, toast }) {
  const [formError, setFormError] = useState('');
  async function submit(event) {
    event.preventDefault(); const target = event.currentTarget; setFormError(''); const form = new FormData(target);
    try { await api('/guest/requests', { method: 'POST', body: JSON.stringify(Object.fromEntries(form.entries())) }); target.reset(); await refresh(); notify('Request sent to the hotel team'); }
    catch (err) { setFormError(err.message); }
  }
  async function close(id) {
    try { await api(`/guest/requests/${id}/close`, { method: 'PATCH', body: '{}' }); await refresh(); notify('Request closed · thank you'); }
    catch (err) { setFormError(err.message); }
  }
  return <main className="guest-shell"><header className="guest-header"><div className="brand"><span className="brand-mark">S</span><span>StayFlow</span></div><div className="guest-hotel"><span className="hotel-dot" />{session.hotel?.name} <span>·</span> Room {session.stay?.roomNumber}</div><button className="text-button" onClick={logout}>End session</button></header><div className="guest-content">
    <section className="guest-welcome"><div><p className="eyebrow">YOUR STAY, TAKEN CARE OF</p><h1>How can we help?</h1><p>Send a request directly to the right team. You’ll see who has it and when it’s been handled.</p></div><div className="stay-ticket"><span>ACTIVE STAY</span><strong>Room {session.stay?.roomNumber}</strong><small>Verified room access</small></div></section>
    {(error || formError) && <div className="notice error-notice" role="alert">{formError || error}<button onClick={() => setFormError('')}>Dismiss</button></div>}
    <div className="guest-grid"><section className="guest-form-panel"><h2>Request service</h2><p>Tell us what’s happening. Avoid including payment details or sensitive personal information.</p><form onSubmit={submit}><label className="field"><span>What do you need?</span><select name="category" required>{departments.map(item => <option key={item}>{item}</option>)}</select></label><label className="field"><span>Describe the issue</span><textarea name="description" rows="4" minLength="8" maxLength="600" placeholder="For example: the air conditioning is not cooling the room…" required /></label><label className="priority-choice"><input type="checkbox" name="priority" value="Urgent" /><span><strong>Urgent</strong><small>Use if the issue affects safety or essential room access.</small></span></label><button className="primary" type="submit">Send request <span>→</span></button></form></section>
    <section className="guest-tracking"><div className="tracking-head"><div><h2>Your requests</h2><p>Updates appear here as the hotel team responds.</p></div><span className="live-label"><i /> Live</span></div>{requests.length ? <div className="guest-request-list">{requests.map(item => <article className="guest-request" key={item.id}><div className="guest-request-top"><span className="guest-category">{item.category} · Room {item.roomNumber}</span><Status status={item.status} /></div><p>{item.description}</p><div className="guest-request-meta"><span>{item.ownerName ? `With ${item.ownerName}` : 'Waiting for a team member'}</span><time>{dateTime(item.createdAt)}</time></div>{item.status === 'Completed' && <button className="small-button strong" onClick={() => close(item.id)}>Confirm and close</button>}{item.status === 'Closed' && <small className="closed-thanks">Closed · Thank you for letting us know.</small>}</article>)}</div> : <div className="guest-empty"><span className="empty-mark">✓</span><strong>No open requests</strong><p>When you need help, the form on this page sends a tracked request to the right team.</p></div>}</section></div>
    <footer className="guest-footer">StayFlow keeps your requests visible to this hotel team during your active stay.</footer>
  </div>{toast && <div className="toast" role="status">{toast}</div>}</main>;
}

createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);

