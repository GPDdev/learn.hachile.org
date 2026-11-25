import { now, local, json, role, requireUser, fault, str, input, canGenerate } from './common.js';
import { auth, userFor } from './auth.js';
import { makeQuote } from './lessons.js';
import { createJob, browse, item, renderAPI } from './jobs.js';
import { notify, payReady, mockPay, createOrder, localPay, checkOrder } from './payments.js';
import { maintenance } from './dispatch.js';
async function wallet(db, u) {
  const { results } = await db
    .prepare('SELECT wallet,SUM(amount) AS n FROM ledger WHERE user_id=? GROUP BY wallet')
    .bind(u.id)
    .all();
  return {
    learn: results.find((r) => r.wallet === 'learn')?.n || 0,
    sandbox: results.find((r) => r.wallet === 'sandbox')?.n || 0,
  };
}
async function route(req, env, ctx) {
  const url = new URL(req.url),
    path = url.pathname,
    method = req.method,
    dev = local(req, env);
  if (!path.startsWith('/api/')) return env.ASSETS.fetch(req);
  if (path === '/api/payments/notify' && method === 'POST') return notify(req, env);
  const render = path.match(/^\/api\/internal\/render\/([\w-]+)\/(next|claim|upload|finish|fail)$/);
  if (render && method === 'POST') return renderAPI(req, env, render[1], render[2]);
  if (method === 'POST' && req.headers.get('Origin') !== (dev ? url.origin : env.APP_ORIGIN))
    fault(403, '请从本站发起操作');
  const u = await userFor(req, env);
  if (path === '/api/session' && method === 'GET')
    return json({
      local: dev,
      offline: dev && env.LOCAL_CLOUD_MODELS !== '1',
      mode: mockPay(req, env) ? 'local' : env.PAYMENT_MODE,
      paymentAvailable: dev || payReady(env),
      user: u
        ? {
            id: u.id,
            name: u.name,
            email: u.email,
            invited: !!u.invited,
            admin: role(u, env),
            canGenerate: canGenerate(u, env),
            balances: await wallet(env.DB, u),
          }
        : null,
    });
  if (/^\/api\/auth\/(code|verify|invite|logout)$/.test(path) && method === 'POST')
    return auth(req, env, path.split('/').pop(), u);
  if (path === '/api/quotes' && method === 'POST') return makeQuote(req, env, u);
  if (path === '/api/jobs' && method === 'POST') return createJob(req, env, u, ctx);
  if (['/api/library', '/api/community'].includes(path) && method === 'GET')
    return browse(env, u, path === '/api/library', url.searchParams.get('before'));
  const j = path.match(/^\/api\/jobs\/([\w-]+)(?:\/(media|publish|report))?$/);
  if (
    j &&
    ((['GET', 'HEAD'].includes(method) && (!j[2] || j[2] === 'media')) ||
      (method === 'POST' && ['publish', 'report'].includes(j[2])))
  )
    return item(req, env, u, j[1], j[2]);
  if (path === '/api/wallet' && method === 'GET') {
    requireUser(u);
    const [history, orders] = await env.DB.batch([
      env.DB.prepare(
        'SELECT wallet,amount,note,created FROM ledger WHERE user_id=? ORDER BY created DESC,rowid DESC LIMIT 50',
      ).bind(u.id),
      env.DB.prepare(
        'SELECT id,mode,fen,credits,state,created FROM orders WHERE user_id=? ORDER BY created DESC,rowid DESC LIMIT 20',
      ).bind(u.id),
    ]);
    return json({
      balances: await wallet(env.DB, u),
      history: history.results,
      orders: orders.results,
    });
  }
  if (path === '/api/orders' && method === 'POST') return createOrder(req, env, u);
  const order = path.match(/^\/api\/orders\/([a-f0-9]{32})\/(check|local-pay|local-cancel)$/);
  if (order && method === 'POST')
    return order[2] === 'check'
      ? checkOrder(req, env, u, order[1])
      : localPay(req, env, u, order[1], order[2] === 'local-cancel');
  if (path.startsWith('/api/admin/')) {
    if (!role(u, env)) fault(403, '需要管理权限');
    if (path === '/api/admin/reports' && method === 'GET') {
      const reports = await env.DB.prepare(
        'SELECT r.job_id,r.reason,r.created,q.lesson,j.blocked FROM reports r JOIN jobs j ON j.id=r.job_id JOIN quotes q ON q.id=j.quote_id ORDER BY r.created DESC LIMIT 100',
      ).all();
      return json({
        items: reports.results.map((r) => ({
          id: r.job_id,
          title: JSON.parse(r.lesson).title,
          reason: r.reason,
          blocked: !!r.blocked,
        })),
      });
    }
    if (path === '/api/admin/hide' && method === 'POST') {
      const d = await input(req);
      await env.DB.prepare('UPDATE jobs SET blocked=1,published=NULL WHERE id=?')
        .bind(str(d.id, 20, 80))
        .run();
      return json({ ok: true });
    }
  }
  fault(404, '接口不存在');
}
export default {
  async fetch(req, env, ctx) {
    try {
      return await route(req, env, ctx);
    } catch (e) {
      const msg = [e.message, e.cause?.message].join(' ');
      if (msg.includes('insufficient_credits')) return json({ error: '可用积分不足' }, 402);
      if (msg.includes('pilot_budget'))
        return json({ error: '本轮内测预算已达上限，新的生成已暂停' }, 429);
      if (!e.status) console.warn('Request failed', new URL(req.url).pathname, e.name);
      return json({ error: e.status ? e.message : '服务暂时无法完成请求' }, e.status || 500);
    }
  },
  async scheduled(_, env, ctx) {
    ctx.waitUntil(maintenance(env));
  },
};
