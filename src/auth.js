import bcrypt from 'bcryptjs';
import { randomToken, sha256 } from './security.js';

const COOKIE_NAME = 'gate_one_session';
const SESSION_DAYS = 7;

export async function login(db, email, password) {
  const result = await db.query(
    'SELECT id, name, email, password_hash, role FROM users WHERE lower(email) = lower($1) AND active = true',
    [email]
  );
  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) return null;

  const token = randomToken();
  await db.query(
    `INSERT INTO sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + interval '${SESSION_DAYS} days')`,
    [user.id, sha256(token)]
  );
  return { token, user: { id: user.id, name: user.name, email: user.email, role: user.role } };
}

export async function authenticate(db, request) {
  const token = request.cookies[COOKIE_NAME];
  if (!token) return null;
  const result = await db.query(
    `SELECT u.id, u.name, u.email, u.role
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active = true`,
    [sha256(token)]
  );
  if (!result.rows[0]) return null;
  await db.query('UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1', [sha256(token)]);
  return result.rows[0];
}

export async function logout(db, request) {
  const token = request.cookies[COOKIE_NAME];
  if (token) await db.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
}

export function setSessionCookie(reply, token, secure) {
  reply.setCookie(COOKIE_NAME, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: SESSION_DAYS * 24 * 60 * 60
  });
}

export function clearSessionCookie(reply) {
  reply.clearCookie(COOKIE_NAME, { path: '/' });
}
