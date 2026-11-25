export const now = () => Math.floor(Date.now() / 1000);
export const id = () => crypto.randomUUID();
export const enc = new TextEncoder();
export const hex = (bytes) =>
  Array.from(new Uint8Array(bytes), (n) => n.toString(16).padStart(2, '0')).join('');
export async function sha(value) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(value)));
}
export async function mac(key, value) {
  const k = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(value)));
}
export function fault(status, message) {
  throw Object.assign(new Error(message), { status });
}
export function json(data, status = 200, headers = {}) {
  return Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers },
  });
}
export async function input(request, max = 12000) {
  if (Number(request.headers.get('content-length')) > max) fault(413, '内容过长');
  const s = await request.text();
  if (s.length > max) fault(413, '内容过长');
  try {
    const x = JSON.parse(s);
    if (x && typeof x === 'object' && !Array.isArray(x)) return x;
  } catch {}
  fault(400, '请输入有效内容');
}
export function str(s, min, max, label = '内容') {
  if (typeof s !== 'string' || s.trim().length < min || s.trim().length > max)
    fault(400, label + '长度不合适');
  return s.trim();
}
export const local = (req, env) =>
  env.LOCAL_DEMO === '1' && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(req.url).hostname);
export function role(user, env) {
  return (
    !!user &&
    (env.ADMIN_EMAILS || '')
      .toLowerCase()
      .split(',')
      .map((s) => s.trim())
      .includes(user.email)
  );
}
export async function limited(db, key, maximum, period) {
  const start = Math.floor(now() / period) * period;
  const row = await db
    .prepare(
      'INSERT INTO limits VALUES (?,?,?) ON CONFLICT(bucket) DO UPDATE SET hits=hits+1 WHERE hits<? RETURNING hits',
    )
    .bind(key + ':' + start, 1, start + period, maximum)
    .first();
  if (!row) fault(429, '请求较频繁，请稍后再试');
}
export async function equalSecret(a, b) {
  return !!a && !!b && (await sha(a)) === (await sha(b));
}
export function requireUser(u) {
  if (!u) fault(401, '请先登录');
}
export function canGenerate(u, e) {
  return !!u && (u.invited === 1 || (e.ACCESS_MODE === 'public' && e.PAYMENT_MODE === 'live'));
}
export const points = (seconds) => Math.ceil(seconds / 6);
