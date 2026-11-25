import {
  now,
  id,
  sha,
  mac,
  fault,
  input,
  json,
  str,
  local,
  limited,
  equalSecret,
  requireUser,
} from './common.js';
const cookieName = (dev) => (dev ? 'learn_local' : '__Host-learn_session');
const cookie = (dev, value, ttl) =>
  cookieName(dev) +
  '=' +
  value +
  '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' +
  ttl +
  (dev ? '' : '; Secure');
function emailAddress(value) {
  const e = str(value, 3, 200, '邮箱').toLowerCase();
  if (!/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(e)) fault(400, '请输入有效的邮箱地址');
  return e;
}
function sessionToken(req, dev) {
  return (req.headers.get('cookie') || '')
    .split(';')
    .map((x) => x.trim())
    .find((x) => x.startsWith(cookieName(dev) + '='))
    ?.slice(cookieName(dev).length + 1);
}
export async function userFor(req, env) {
  const token = sessionToken(req, local(req, env));
  if (!token) return null;
  return env.DB.prepare(
    'SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.hash=? AND s.expires>?',
  )
    .bind(await sha(token), now())
    .first();
}
export async function auth(req, env, path, user) {
  const dev = local(req, env),
    db = env.DB;
  if (path === 'logout') {
    const token = sessionToken(req, dev);
    if (token)
      await db
        .prepare('DELETE FROM sessions WHERE hash=?')
        .bind(await sha(token))
        .run();
    return json({ ok: true }, 200, { 'Set-Cookie': cookie(dev, '', 0) });
  }
  const data = await input(req);
  if (path === 'invite') {
    requireUser(user);
    await limited(db, 'invite:' + user.id, 8, 3600);
    if (!(await equalSecret(data.code?.trim(), dev ? 'CLASSROOM' : env.INVITE_CODE)))
      fault(403, '邀请码无效');
    await db.prepare('UPDATE users SET invited=1 WHERE id=? AND invited=0').bind(user.id).run();
    return json({ ok: true });
  }
  const email = emailAddress(data.email);
  const secret = env.AUTH_SECRET || (dev ? 'local-classroom-only' : '');
  if (!secret) fault(503, '登录服务尚未配置');
  if (path === 'code') {
    if (!dev && (!env.MAIL_API_KEY || !env.MAIL_FROM)) fault(503, '邮件服务尚未配置');
    await limited(db, 'mail:' + (await mac(secret, email)), 3, 600);
    await limited(
      db,
      'ip:' + (await mac(secret, req.headers.get('CF-Connecting-IP') || 'local')),
      18,
      600,
    );
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
    const hash = await mac(secret, email + '/' + code);
    await db
      .prepare('INSERT OR REPLACE INTO codes(email,hash,expires,attempts) VALUES(?,?,?,0)')
      .bind(email, hash, now() + 600)
      .run();
    if (!dev) {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + env.MAIL_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: env.MAIL_FROM,
          to: [email],
          subject: 'AI 视频课堂登录验证码',
          text: '你的验证码是 ' + code + '，10 分钟内有效。',
        }),
      });
      if (!response.ok) {
        await db.prepare('DELETE FROM codes WHERE email=? AND hash=?').bind(email, hash).run();
        fault(503, '验证码发送失败，请稍后重试');
      }
    }
    return json(dev ? { ok: true, localCode: code } : { ok: true });
  }
  const code = str(data.code, 6, 6, '验证码'),
    name = str(data.name || '学习者', 1, 24, '昵称');
  const row = await db
    .prepare(
      'UPDATE codes SET attempts=attempts+1 WHERE email=? AND expires>? AND attempts<6 RETURNING hash',
    )
    .bind(email, now())
    .first();
  if (!row || !(await equalSecret(row.hash, await mac(secret, email + '/' + code))))
    fault(400, '验证码无效或已过期');
  const used = await db
    .prepare('DELETE FROM codes WHERE email=? AND hash=? RETURNING email')
    .bind(email, row.hash)
    .first();
  if (!used) fault(400, '验证码已使用');
  const token = id() + id(),
    ttl = 30 * 86400;
  await db.batch([
    db
      .prepare(
        'INSERT INTO users(id,email,name,created) VALUES(?,?,?,?) ON CONFLICT(email) DO NOTHING',
      )
      .bind(id(), email, name, now()),
    db
      .prepare('INSERT INTO sessions VALUES(?,(SELECT id FROM users WHERE email=?),?)')
      .bind(await sha(token), email, now() + ttl),
  ]);
  return json({ ok: true }, 200, { 'Set-Cookie': cookie(dev, token, ttl) });
}
