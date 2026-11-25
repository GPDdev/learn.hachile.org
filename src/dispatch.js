import { now, mac, sha } from './common.js';
export const cloudRenderReady = (e) =>
  !!(
    e.FC_ENDPOINT &&
    e.FC_FUNCTION &&
    e.FC_ACCESS_KEY_ID &&
    e.FC_ACCESS_KEY_SECRET &&
    e.RENDER_SECRET
  );
export const renderToken = (env, id) => mac(env.RENDER_SECRET, 'learn/render/v1/' + id);
export function expireJobs(db, t) {
  return db
    .prepare(
      "UPDATE jobs SET state='failed',problem='任务已超时，积分已退回' WHERE deadline<=? AND state IN ('queued','dispatched','rendering')",
    )
    .bind(t);
}
async function submitFC(env, job) {
  const endpoint = new URL(env.FC_ENDPOINT);
  if (endpoint.protocol !== 'https:') throw Error('Invalid FC endpoint');
  const url = new URL(
    '/2023-03-30/functions/' + encodeURIComponent(env.FC_FUNCTION) + '/invocations',
    endpoint,
  );
  const event = JSON.stringify({ job_id: job.id, token: await renderToken(env, job.id) });
  const h = {
    host: url.host,
    'content-type': 'application/json',
    'x-acs-action': 'InvokeFunction',
    'x-acs-version': '2023-03-30',
    'x-acs-date': new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    'x-acs-signature-nonce': crypto.randomUUID(),
    'x-acs-content-sha256': await sha(event),
    'x-fc-invocation-type': 'Async',
    'x-fc-async-task-id': job.id,
  };
  const keys = Object.keys(h)
      .filter((name) => name === 'host' || name === 'content-type' || name.startsWith('x-acs-'))
      .sort(),
    names = keys.join(';');
  const canonical = [
    'POST',
    url.pathname,
    '',
    keys.map((k) => k + ':' + h[k] + '\n').join(''),
    names,
    h['x-acs-content-sha256'],
  ].join('\n');
  h.Authorization =
    'ACS3-HMAC-SHA256 Credential=' +
    env.FC_ACCESS_KEY_ID +
    ',SignedHeaders=' +
    names +
    ',Signature=' +
    (await mac(env.FC_ACCESS_KEY_SECRET, 'ACS3-HMAC-SHA256\n' + (await sha(canonical))));
  const res = await fetch(url, {
    method: 'POST',
    headers: h,
    body: event,
    signal: AbortSignal.timeout(12000),
  });
  if (res.ok) return;
  if (res.status === 409 && /task.*(exist|duplicat)|already.*exist/i.test(await res.text())) return;
  throw Error('FC failed ' + res.status);
}
export async function dispatch(env, key) {
  if (!cloudRenderReady(env)) return;
  const t = now();
  const job = await env.DB.prepare(
    "UPDATE jobs SET sent=? WHERE id=? AND state='queued' AND sent<? AND deadline>? RETURNING id",
  )
    .bind(t, key, t - 45, t)
    .first();
  if (!job) return;
  try {
    await submitFC(env, job);
    await env.DB.prepare("UPDATE jobs SET state='dispatched' WHERE id=? AND state='queued'")
      .bind(key)
      .run();
  } catch {
    console.warn('Queued render will retry', key);
  }
}
export async function maintenance(env) {
  const t = now(),
    db = env.DB;
  await db.batch([
    expireJobs(db, t),
    db.prepare('DELETE FROM codes WHERE expires<?').bind(t),
    db.prepare('DELETE FROM sessions WHERE expires<?').bind(t),
    db.prepare('DELETE FROM limits WHERE expires<?').bind(t),
  ]);
  if (cloudRenderReady(env)) {
    const { results } = await db
      .prepare("SELECT id FROM jobs WHERE state='queued' AND sent<? ORDER BY created LIMIT 12")
      .bind(t - 45)
      .all();
    for (const job of results) await dispatch(env, job.id);
  }
}
