# StayFlow

StayFlow is a multi-hotel guest service MVP. Guests enter through a verified room QR, submit a request, and see its progress. Staff work from department queues; administrators can assign or escalate work and review a hotel-scoped audit log.

## What is implemented

- Three roles: guest, hotel staff, and hotel administrator.
- Public hotel browse and date-aware room reservations with a one-time confirmation code.
- Hotel workspace signup, rooms, staff accounts, and department routing.
- Front-desk check-in creates an active stay and a private QR link for the guest.
- Guest service requests by QR or front-desk phone intake, staff accept/decline/start/complete flow, and guest confirmation before a request closes.
- Least-loaded staff assignment within the matching department; requests without staff stay in the department queue.
- Response targets: 30 minutes for normal requests and 10 minutes for urgent requests. Overdue active requests escalate automatically and appear in the admin log.
- Real-time queue and guest status updates with Socket.IO.
- Admin dashboard with open/overdue/completed/room counts, staff management, request reassignment, escalation, and activity log.
- Check-out ends QR access and marks the room as needing cleaning; housekeeping staff can move the room through cleaning to ready for check-in.

## Run locally

Requirements: Node.js 20+ and MongoDB 6+ (local MongoDB or an Atlas connection string).

1. Copy `server/.env.example` to `server/.env`.
2. Set `MONGODB_URI` and replace `JWT_SECRET` with a random secret of at least 32 characters.
3. In one terminal, run `cd server`, `npm install`, then `npm run dev`.
4. In another terminal, run `cd client`, `npm install`, then `npm run dev`.
5. Open `http://localhost:5173`. Create the hotel workspace and administrator account. Add staff from **Team**, then create rooms from **Front desk** if you need more than the starter room 101.

The Vite development server proxies API and Socket.IO traffic to port 4000. The API health page is `http://localhost:4000/api/health`.

## Security controls

- Every hotel-owned query is scoped by the authenticated `hotelId`; request and room identifiers are always paired with that tenant scope.
- Passwords use bcrypt. Staff/admin sign-in is rate limited. Session JWTs live in HttpOnly cookies for up to eight hours; the browser never reads the JWT.
- Cookies are `SameSite=Strict` in local development. Production cookies use `Secure` and `SameSite=None` so a separately hosted frontend can call the API; production writes require an allowed `Origin`, and CORS accepts only `CLIENT_ORIGINS`.
- Helmet security headers, a 32 KB request-body limit, role guards, server-side status transition checks, and rate limits are enabled.
- NoSQL injection: JSON payloads containing MongoDB operator keys (`$...`), dotted keys, prototype keys, or excessive nesting are rejected. Routes validate primitive values and construct MongoDB filters from server-owned fields; client input is never accepted as a Mongo query.
- SQL injection: this version uses MongoDB/Mongoose and has no SQL driver or SQL statements. User text is stored in schema-typed string fields and is never concatenated into a database query. If SQL is added later, use parameterized statements.
- DOM XSS: the React UI renders guest and staff text as text, never through `dangerouslySetInnerHTML` or `innerHTML`. User text fields reject HTML delimiters and control characters, are length-limited, and are rendered with React's escaping.
- Room QR tokens are generated from cryptographic random bytes, stored as SHA-256 hashes, reveal no room details before server verification, and stop working at check-out. The guest activation page removes the token from the visible URL after use.
- Admin-visible activity records include workspace creation, check-in/out, request submission and status changes, decline reasons, reassignment, staff/room changes, and automatic/manual escalation. Audit reads are hotel-scoped.

## Environment

See `server/.env.example`. For deployment, set a strong `JWT_SECRET`, set `NODE_ENV=production`, use an Atlas URI with network access restricted to the server, and set `CLIENT_ORIGINS` to the exact deployed frontend origin. If the frontend and API are on unrelated sites, the browser must allow third-party cookies; a same-site domain or reverse proxy is more reliable.

## MVP boundaries

This first build focuses on the guest request problem and staff/admin operations. Online payments, photo uploads, feedback ratings, Lost & Found, room QR printing, MFA, password recovery, and hotel self-service configuration for routing rules are not included yet. Before using this with real guest data, add account recovery and MFA options, operational backups, a privacy/retention policy, and a security review. Reservation dates currently use UTC date boundaries and should be aligned to each hotel's local timezone before production.
