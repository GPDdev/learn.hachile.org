import {
  now,
  id,
  fault,
  json,
  input,
  str,
  canGenerate,
  requireUser,
  local,
  role,
  equalSecret,
  limited,
} from './common.js';
import { dispatch, renderToken, cloudRenderReady, expireJobs } from './dispatch.js';
import { renderCost, voiceUnits, costSettlement } from './costs.js';
const selectJob =
  'SELECT j.id,j.user_id,j.price,j.state,j.created,j.published,j.blocked,j.problem,j.duration,q.kind,q.seconds,q.lesson,u.name AS author FROM jobs j JOIN quotes q ON q.id=j.quote_id JOIN users u ON u.id=j.user_id ';
function card(r) {
  const p = JSON.parse(r.lesson);
  return {
    id: r.id,
    title: p.title,
    summary: p.summary,
    author: r.author,
    kind: r.kind,
    seconds: r.duration || r.seconds,
    state: r.state,
    price: r.price,
    published: r.published,
    blocked: !!r.blocked,
    problem: r.problem,
    created: r.created,
    followups: p.followups,
  };
}
export async function browse(env, u, mine, before) {
  if (mine) requireUser(u);
  // Stable two-column cursor, including releases in the same second.
  const [time, afterId] = String(before || '').split('.');
  const at = /^\d+$/.test(time) ? Number(time) : Number.MAX_SAFE_INTEGER;
  const field = mine ? 'j.created' : 'j.published';
  const where = mine
    ? 'j.user_id=?'
    : "j.state='ready' AND j.published IS NOT NULL AND j.blocked=0";
  const params = mine ? [u.id] : [];
  const { results } = await env.DB.prepare(
    selectJob +
      'WHERE ' +
      where +
      ' AND (' +
      field +
      '<? OR (' +
      field +
      '=? AND j.id<?)) ORDER BY ' +
      field +
      ' DESC,j.id DESC LIMIT 25',
  )
    .bind(...params, at, at, afterId || '~')
    .all();
  const items = results.slice(0, 24),
    last = items.at(-1);
  return json({
    items: items.map(card),
    next: results.length > 24 ? (mine ? last.created : last.published) + '.' + last.id : null,
  });
}
export async function createJob(req, env, u, ctx) {
  requireUser(u);
  if (!canGenerate(u, env)) fault(403, '请激活内测邀请');
  const q = String((await input(req)).quote || '');
  const quote = await env.DB.prepare('SELECT * FROM quotes WHERE id=? AND user_id=?')
    .bind(q, u.id)
    .first();
  if (!quote) fault(404, '大纲不存在');
  const existing = await env.DB.prepare('SELECT id,state FROM jobs WHERE quote_id=?')
    .bind(q)
    .first();
  if (existing) return json(existing);
  if (!local(req, env) && !cloudRenderReady(env)) fault(503, '渲染服务尚未配置');
  if (quote.created < now() - 86400) fault(409, '报价已过期，请重新生成大纲');
  const key = id(),
    t = now(),
    offline = local(req, env) && env.LOCAL_CLOUD_MODELS !== '1';
  await env.DB.prepare(
    'INSERT INTO jobs(id,quote_id,user_id,price,cost_fen,created,deadline) VALUES(?,?,?,?,?,?,?) ON CONFLICT(quote_id) DO NOTHING',
  )
    .bind(
      key,
      q,
      u.id,
      quote.price,
      offline ? 0 : renderCost(voiceUnits(JSON.parse(quote.lesson)), 900),
      t,
      t + 1800,
    )
    .run();
  const job = await env.DB.prepare('SELECT id,state FROM jobs WHERE quote_id=?').bind(q).first();
  if (!local(req, env)) ctx.waitUntil(dispatch(env, job.id));
  return json(job, 202);
}
export async function item(req, env, u, key, action) {
  const r = await env.DB.prepare(selectJob + 'WHERE j.id=?')
    .bind(key)
    .first();
  const own = !!u && r?.user_id === u.id,
    visible = r?.state === 'ready' && r.published && !r.blocked;
  if (!r || (!own && !visible && !role(u, env))) fault(404, '课程不存在或尚未公开');
  if (action === 'media') {
    if (r.state !== 'ready') fault(404, '视频尚未生成');
    const objKey = key + '/lesson.mp4',
      size = (await env.MEDIA.head(objKey))?.size;
    if (!size) fault(404, '视频文件不存在');
    const h = {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    };
    const range = req.headers.get('Range');
    let start = 0,
      end = size - 1;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!m || (!m[1] && !m[2]))
        return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + size } });
      start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
      end = m[1] && m[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        start >= size
      )
        return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + size } });
      h['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size;
    }
    h['Content-Length'] = String(end - start + 1);
    const obj =
      req.method === 'HEAD'
        ? null
        : await env.MEDIA.get(
            objKey,
            range ? { range: { offset: start, length: end - start + 1 } } : undefined,
          );
    return new Response(obj?.body || null, { status: range ? 206 : 200, headers: h });
  }
  if (action === 'publish') {
    requireUser(u);
    if (!own || r.blocked || r.state !== 'ready') fault(403, '该课程暂时无法发布');
    const data = await input(req);
    await env.DB.prepare('UPDATE jobs SET published=? WHERE id=? AND blocked=0')
      .bind(data.publish === true ? now() : null, key)
      .run();
    return json({ ok: true });
  }
  if (action === 'report') {
    requireUser(u);
    if (!visible) fault(404, '作品尚未公开');
    await limited(env.DB, 'report:' + u.id, 8, 3600);
    await env.DB.prepare('INSERT OR IGNORE INTO reports VALUES(?,?,?,?)')
      .bind(key, u.id, str((await input(req)).reason, 2, 160, '举报理由'), now())
      .run();
    return json({ ok: true });
  }
  return json({ ...card(r), own, chapters: JSON.parse(r.lesson).scenes.map((s) => s.title) });
}
export async function renderAPI(req, env, key, op) {
  const dev = local(req, env);
  if (!dev && !env.RENDER_SECRET) fault(503, '渲染未配置');
  const auth = req.headers.get('Authorization') || '';
  const bearer = dev ? env.LOCAL_RENDER_KEY : await renderToken(env, key);
  if (!bearer || !(await equalSecret(auth, 'Bearer ' + bearer))) fault(403, '渲染凭据无效');
  if (op === 'next' && dev) {
    await expireJobs(env.DB, now()).run();
    const row = await env.DB.prepare(
      "SELECT id FROM jobs WHERE state='queued' AND deadline>? ORDER BY created LIMIT 1",
    )
      .bind(now())
      .first();
    return json({ id: row?.id || null });
  }
  const j = await env.DB.prepare('SELECT * FROM jobs WHERE id=?').bind(key).first();
  if (!j) fault(404, '任务不存在');
  if (op === 'claim') {
    const run = str((await input(req)).run, 20, 80, '运行编号');
    const active = await env.DB.prepare(
      "UPDATE jobs SET state='rendering',run_id=? WHERE id=? AND deadline>? AND (state IN ('queued','dispatched') OR (state='rendering' AND run_id=?)) RETURNING quote_id",
    )
      .bind(run, key, now(), run)
      .first();
    if (!active) return json({ skip: true });
    const quote = await env.DB.prepare('SELECT lesson FROM quotes WHERE id=?')
      .bind(j.quote_id)
      .first();
    return json({ plan: JSON.parse(quote.lesson) });
  }
  if (!(await equalSecret(req.headers.get('X-Render-Run'), j.run_id))) fault(403, '任务归属无效');
  if (j.state === 'ready' && op === 'finish') return json({ ok: true });
  if (j.state !== 'rendering' || j.deadline <= now()) fault(409, '任务已结束');
  if (op === 'upload') {
    const length = Number(req.headers.get('content-length'));
    if (!Number.isSafeInteger(length) || length < 1000 || length > 65 * 1024 * 1024)
      fault(413, '视频大小不符合限制');
    await env.MEDIA.put(key + '/lesson.mp4', req.body, {
      httpMetadata: { contentType: 'video/mp4' },
    });
    return json({ ok: true });
  }
  if (op === 'finish') {
    const stats = await input(req),
      duration = Number(stats.duration),
      elapsed = Number(stats.elapsed),
      obj = await env.MEDIA.head(key + '/lesson.mp4');
    if (!obj || !Number.isFinite(duration) || duration <= 0 || duration > 900)
      fault(400, '媒体验证失败');
    const quote = await env.DB.prepare('SELECT lesson FROM quotes WHERE id=?')
      .bind(j.quote_id)
      .first();
    const bytes = voiceUnits(JSON.parse(quote.lesson));
    const operations = [
      env.DB.prepare(
        "UPDATE jobs SET state='ready',duration=?,media_bytes=? WHERE id=? AND state='rendering' AND deadline>? RETURNING id",
      ).bind(duration, obj.size, key, now()),
    ];
    const offline = dev && env.LOCAL_CLOUD_MODELS !== '1';
    if (Number.isFinite(elapsed) && elapsed > 0)
      operations.push(
        costSettlement(env.DB, 'render:' + key, offline ? 0 : renderCost(bytes, elapsed), {
          voice_bytes: bytes,
          elapsed_seconds: elapsed,
          local: offline,
        }),
      );
    const [saved] = await env.DB.batch(operations);
    if (!saved.results.length) fault(409, '任务已过期');
  } else if (op === 'fail') {
    await env.DB.prepare(
      "UPDATE jobs SET state='failed',problem='生成未完成，积分已退回' WHERE id=? AND state='rendering'",
    )
      .bind(key)
      .run();
  } else fault(404, '接口不存在');
  return json({ ok: true });
}
