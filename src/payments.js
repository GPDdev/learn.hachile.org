import { fault, id, now, input, json, local, requireUser, limited } from './common.js';
const gateways = {
  sandbox: 'https://openapi-sandbox.dl.alipaydev.com/gateway.do',
  live: 'https://openapi.alipay.com/gateway.do',
};
export const alipayString = (fields, notify = false) =>
  Object.keys(fields)
    .filter(
      (k) =>
        k !== 'sign' && (!notify || k !== 'sign_type') && fields[k] !== '' && fields[k] != null,
    )
    .sort()
    .map((k) => k + '=' + fields[k])
    .join('&');
const from64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const to64 = (b) => btoa(String.fromCharCode(...new Uint8Array(b)));
const algo = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
const pem = (s) => from64(s.replace(/-----[^-]+-----|\s/g, ''));
async function sign(fields, env) {
  const key = await crypto.subtle.importKey('pkcs8', pem(env.ALIPAY_PRIVATE_KEY), algo, false, [
    'sign',
  ]);
  return to64(await crypto.subtle.sign(algo, key, new TextEncoder().encode(alipayString(fields))));
}
async function checkSignature(raw, signature, env) {
  try {
    const key = await crypto.subtle.importKey('spki', pem(env.ALIPAY_PUBLIC_KEY), algo, false, [
      'verify',
    ]);
    return await crypto.subtle.verify(algo, key, from64(signature), new TextEncoder().encode(raw));
  } catch {
    return false;
  }
}
export const payReady = (e) =>
  !!(
    e.ALIPAY_APP_ID &&
    e.ALIPAY_SELLER_ID &&
    e.ALIPAY_PUBLIC_KEY &&
    e.ALIPAY_PRIVATE_KEY &&
    gateways[e.PAYMENT_MODE]
  );
export const mockPay = (req, env) =>
  local(req, env) && (env.PAYMENT_MODE !== 'sandbox' || !payReady(env));
export function asFen(s) {
  if (!/^\d{1,8}(?:\.\d{1,2})?$/.test(String(s))) return -1;
  const [whole, fraction = ''] = String(s).split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}
function common(method, biz, env) {
  const timestamp = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
  return {
    app_id: env.ALIPAY_APP_ID,
    method,
    format: 'JSON',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp,
    version: '1.0',
    biz_content: JSON.stringify(biz),
  };
}
async function credit(db, order, trade) {
  if (!trade || trade.length > 128) fault(400, '交易号无效');
  await db
    .prepare("UPDATE orders SET state='paid',trade=? WHERE id=? AND state='pending'")
    .bind(trade, order.id)
    .run();
  const paid = await db.prepare('SELECT trade FROM orders WHERE id=?').bind(order.id).first();
  if (paid.trade !== trade) fault(409, '订单交易号不匹配');
}
export async function notify(req, env) {
  const no = (status = 400) => new Response('failure', { status });
  if (!payReady(env)) return no(503);
  const body = await req.text();
  if (body.length > 32000) return no();
  const params = new URLSearchParams(body);
  if (new Set(params.keys()).size !== Array.from(params.keys()).length) return no();
  const f = Object.fromEntries(params);
  if (
    f.sign_type !== 'RSA2' ||
    f.app_id !== env.ALIPAY_APP_ID ||
    f.seller_id !== env.ALIPAY_SELLER_ID ||
    !(await checkSignature(alipayString(f, true), f.sign, env))
  )
    return no();
  const order = await env.DB.prepare('SELECT * FROM orders WHERE id=?')
    .bind(f.out_trade_no || '')
    .first();
  if (!order || order.mode !== env.PAYMENT_MODE || order.fen !== asFen(f.total_amount)) return no();
  if (['TRADE_SUCCESS', 'TRADE_FINISHED'].includes(f.trade_status))
    await credit(env.DB, order, f.trade_no);
  return new Response('success');
}
export async function createOrder(req, env, user) {
  requireUser(user);
  const d = await input(req),
    yuan = Number(d.yuan);
  if (![5, 10, 30].includes(yuan)) fault(400, '请选择有效充值金额');
  const mock = mockPay(req, env),
    mode = mock ? 'local' : env.PAYMENT_MODE;
  if (!mock && !payReady(env)) fault(503, '支付宝商户尚未配置');
  await limited(env.DB, 'order:' + user.id, 24, 3600);
  const key = id().replaceAll('-', ''),
    amount = yuan.toFixed(2);
  let checkout = null;
  if (!mock) {
    const wap = d.device === 'mobile';
    const fields = common(
      wap ? 'alipay.trade.wap.pay' : 'alipay.trade.page.pay',
      {
        out_trade_no: key,
        total_amount: amount,
        subject: 'AI 视频课堂积分充值',
        product_code: wap ? 'QUICK_WAP_WAY' : 'FAST_INSTANT_TRADE_PAY',
        timeout_express: '15m',
      },
      env,
    );
    fields.notify_url = env.APP_ORIGIN + '/api/payments/notify';
    fields.return_url = env.APP_ORIGIN + '/wallet?order=' + key;
    fields.sign = await sign(fields, env);
    checkout = { url: gateways[mode], fields };
  }
  await env.DB.prepare(
    'INSERT INTO orders(id,user_id,mode,fen,credits,created) VALUES(?,?,?,?,?,?)',
  )
    .bind(key, user.id, mode, yuan * 100, yuan * 10, now())
    .run();
  return json({ id: key, mode, checkout });
}
export async function localPay(req, env, user, key, cancel = false) {
  requireUser(user);
  if (!local(req, env)) fault(404, '未找到页面');
  const order = await env.DB.prepare(
    "SELECT * FROM orders WHERE user_id=? AND id=? AND mode='local'",
  )
    .bind(user.id, key)
    .first();
  if (!order) fault(404, '找不到该测试订单');
  if (cancel) {
    await env.DB.prepare(
      "UPDATE orders SET state='cancelled' WHERE id=? AND mode='local' AND state='pending'",
    )
      .bind(key)
      .run();
    return json({ ok: true });
  }
  if (order.state === 'cancelled') fault(409, '该测试订单已取消');
  await credit(env.DB, order, 'test-' + key);
  return json({ ok: true });
}
// Verify the exact inner JSON bytes returned by Alipay, before using a query result to credit an order.
export function responseNode(raw, name) {
  const quoted = JSON.stringify(name),
    marker = raw.indexOf(quoted);
  if (marker < 0) return '';
  const start = raw.indexOf('{', raw.indexOf(':', marker + quoted.length) + 1);
  let inText = false,
    escaped = false,
    depth = 0;
  for (let i = start; i >= 0 && i < raw.length; i++) {
    const c = raw[i];
    if (inText) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inText = false;
    } else if (c === '"') inText = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return raw.slice(start, i + 1);
  }
  return '';
}
export async function checkOrder(req, env, user, key) {
  requireUser(user);
  const order = await env.DB.prepare('SELECT * FROM orders WHERE user_id=? AND id=?')
    .bind(user.id, key)
    .first();
  if (!order) fault(404, '找不到订单');
  if (
    order.state === 'pending' &&
    order.mode !== 'local' &&
    order.mode === env.PAYMENT_MODE &&
    payReady(env)
  ) {
    await limited(env.DB, 'query:' + key, 10, 60);
    const f = common('alipay.trade.query', { out_trade_no: key }, env);
    f.sign = await sign(f, env);
    const result = await fetch(gateways[order.mode], {
      method: 'POST',
      body: new URLSearchParams(f),
      signal: AbortSignal.timeout(12000),
    });
    const raw = await result.text(),
      data = JSON.parse(raw),
      name = 'alipay_trade_query_response';
    if (data[name]?.code === '10000') {
      if (!(await checkSignature(responseNode(raw, name), data.sign, env)))
        fault(502, '查单签名无效');
      const q = data[name];
      if (q.out_trade_no !== key || asFen(q.total_amount) !== order.fen)
        fault(502, '查单信息不匹配');
      if (['TRADE_SUCCESS', 'TRADE_FINISHED'].includes(q.trade_status)) {
        await credit(env.DB, order, q.trade_no);
        order.state = 'paid';
      }
    }
  }
  return json({ id: key, state: order.state, mode: order.mode });
}
