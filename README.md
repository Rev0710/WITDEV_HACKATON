# StayFlow

StayFlow is a multi-hotel guest service MVP. Guests enter through a verified room QR, submit a request, and see its progress. Staff work from department queues; administrators can assign or escalate work and review a hotel-scoped audit log.

## What is implemented

- Three roles: guest, hotel staff, and hotel administrator.
- Public hotel browse and date-aware room reservations with a one-time confirmation code.
- Admin room inventory page: add room numbers/types and control bookable status; available rooms show in guest search when dates are clear.
- Hotel workspace signup, rooms, staff accounts, and department routing.
- Front-desk check-in creates an active stay and a private QR link for the guest.
- Guest service requests by QR or front-desk phone intake, staff accept/decline/start/complete flow, and guest confirmation before a request closes.
- Least-loaded staff assignment within the matching department; requests without staff stay in the department queue.
- Response targets: 30 minutes for normal requests and 10 minutes for urgent requests. Overdue active requests escalate automatically and appear in the admin log.
- Real-time queue and guest status updates with Socket.IO.
- Admin dashboard with open/overdue/completed/room counts, staff management, request reassignment, escalation, and activity log.
- Check-out ends QR access and marks the room as needing cleaning; housekeeping staff can move the room through cleaning to ready for check-in.
- Forgot-password flow: 15-minute, single-use email links over SMTP or optional SMS links through Twilio; reset revokes previous sessions.
- Guest feedback: guests rate completed requests from 1–5 and can leave a short note when they confirm the request is closed.
- Lost & Found: active guests can report lost or found items; staff and administrators track reports through located, returned, or closed status.

## Run locally

Requirements: Node.js 20+ and MongoDB 6+ (local MongoDB or an Atlas connection string).

1. Copy `server/.env.example` to `server/.env`.
2. Set `MONGODB_URI` and replace `JWT_SECRET` with a random secret of at least 32 characters. Configure the SMTP fields in `server/.env` for email resets. To enable SMS, set `SMS_PROVIDER=twilio` and the Twilio credentials/from-number.
3. In one terminal, run `cd server`, `npm install`, then `npm run dev`.
4. In another terminal, run `cd client`, `npm install`, then `npm run dev`.
5. Open `http://localhost:5173`. Create the hotel workspace and administrator account. Add staff from **Team**, then add room numbers and types from the admin **Rooms** page. Rooms marked available or ready appear to guests when their selected dates do not overlap a reservation.

The Vite development server proxies API and Socket.IO traffic to port 4000. The API health page is `http://localhost:4000/api/health`.

## Production deployment

The Vercel client is a static web app; it does not run the Express API in `server/`. Deploy `server/` as a separate Node.js service with a MongoDB connection, then set `VITE_API_URL` in the Vercel client project to the API origin only (for example, `https://api.example.com`, with no `/api` suffix). Redeploy the Vercel client after setting the variable. Verify the backend first at `https://<api-origin>/api/health`, which should return JSON with `service: "stayflow-api"`.

On the backend, set `CLIENT_ORIGINS` to the exact Vercel site origin, set `CLIENT_APP_URL` to that site origin, and configure the production database URL and JWT secret. Use HTTPS for both sites. A custom frontend/API domain under the same site is the most reliable way to keep sign-in cookies working across browsers; browsers may block cookies when the app and API are on unrelated sites.

## Security controls

- Every hotel-owned query is scoped by the authenticated `hotelId`; request and room identifiers are always paired with that tenant scope.
- Passwords use bcrypt. Staff/admin sign-in and password recovery are rate limited. Session JWTs live in HttpOnly cookies for up to eight hours; the browser never reads the JWT.
- Cookies are `SameSite=Strict` in local development. Production cookies use `Secure` and `SameSite=None` so a separately hosted frontend can call the API; production writes require an allowed `Origin`, and CORS accepts only `CLIENT_ORIGINS`.
- Helmet security headers, a 32 KB request-body limit, role guards, server-side status transition checks, and rate limits are enabled.
- NoSQL injection: JSON payloads containing MongoDB operator keys (`$...`), dotted keys, prototype keys, or excessive nesting are rejected. Routes validate primitive values and construct MongoDB filters from server-owned fields; client input is never accepted as a Mongo query.
- SQL injection: this version uses MongoDB/Mongoose and has no SQL driver or SQL statements. User text is stored in schema-typed string fields and is never concatenated into a database query. If SQL is added later, use parameterized statements.
- DOM XSS: the React UI renders guest and staff text as text, never through `dangerouslySetInnerHTML` or `innerHTML`. User text fields reject HTML delimiters and control characters, are length-limited, and are rendered with React's escaping.
- Password-reset tokens and room QR tokens are generated from cryptographic random bytes and stored only as SHA-256 hashes. Reset tokens expire in 15 minutes and are one-use; resetting a password invalidates existing sessions. QR links reveal no room details before verification and stop working at check-out. The guest activation page removes the token from the visible URL after use.
- Admin-visible activity records include workspace creation, check-in/out, request submission and status changes, decline reasons, reassignment, staff/room changes, and automatic/manual escalation. Audit reads are hotel-scoped.

## Environment

See `server/.env.example`. For deployment, set a strong `JWT_SECRET`, set `NODE_ENV=production`, use an Atlas URI with network access restricted to the server, and set `CLIENT_ORIGINS` to the exact deployed frontend origin. If the frontend and API are on unrelated sites, the browser must allow third-party cookies; a same-site domain or reverse proxy is more reliable.

## MVP boundaries

Online payments, photo uploads, room QR printing, MFA and hotel self-service configuration for routing rules are not included yet. Password recovery by SMS requires a configured Twilio account; SMTP and SMS credentials are not included in the repository. Before using this with real guest data, add contact verification for recovery channels, MFA, operational backups, a privacy/retention policy, and a security review. Reservation dates currently use UTC date boundaries and should be aligned to each hotel's local timezone before production.
