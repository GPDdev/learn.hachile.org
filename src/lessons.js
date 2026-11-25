import samples from '../public/samples.json' with { type: 'json' };
import { scriptCost, costSettlement } from './costs.js';
import {
  now,
  id,
  points,
  limited,
  str,
  input,
  fault,
  local,
  canGenerate,
  requireUser,
  json,
} from './common.js';

const visuals = ['flow', 'compare', 'cycle', 'orbit', 'network', 'rings'];
function cleanPlan(x) {
  if (
    !x ||
    typeof x.title !== 'string' ||
    !x.title.trim() ||
    !Array.isArray(x.scenes) ||
    x.scenes.length < 2 ||
    x.scenes.length > 9
  )
    throw Error('storyboard');
  const scenes = x.scenes.map((s) => {
    if (
      typeof s.title !== 'string' ||
      typeof s.narration !== 'string' ||
      !s.narration.trim() ||
      s.narration.length > 400 ||
      !Array.isArray(s.labels) ||
      s.labels.length < 2 ||
      s.labels.length > 4 ||
      !s.labels.every((a) => typeof a === 'string' && a.trim())
    )
      throw Error('scene');
    return {
      title: s.title.trim().slice(0, 36),
      narration: s.narration.trim(),
      visual: visuals.includes(s.visual) ? s.visual : 'flow',
      labels: s.labels.map((a) => a.trim().slice(0, 18)),
    };
  });
  if (scenes.reduce((n, s) => n + s.narration.length, 0) > 2200) throw Error('length');
  return {
    title: x.title.slice(0, 72),
    summary: String(x.summary || '').slice(0, 200),
    scenes,
    followups: (Array.isArray(x.followups) ? x.followups : [])
      .filter((a) => typeof a === 'string' && a.trim())
      .slice(0, 4)
      .map((s) => s.slice(0, 72)),
  };
}
function demoPlan(topic, kind, previous, feedback) {
  const template = /神经|手写|像素|机器学习/.test(topic)
    ? samples[2]
    : /土星|光环|环缝/.test(topic)
      ? samples[0]
      : /天文|银河|宇宙|太阳系/.test(topic)
        ? samples[1]
        : null;
  if (!template) fault(422, '离线课程可体验土星环、天文学或手写数字识别。连接千问后即可自由选题。');
  const plan = cleanPlan(template);
  if (kind === 'point' && template.kind === 'overview') plan.scenes = plan.scenes.slice(0, 3);
  if (previous && feedback) {
    const key = feedback.match(/第([1-9])段/);
    if (key && plan.scenes[Number(key[1]) - 1]) {
      const k = Number(key[1]) - 1;
      plan.scenes = [plan.scenes[k], ...plan.scenes.filter((_, i) => i !== k)];
    } else if (/简|短|入门/.test(feedback))
      plan.scenes = previous.scenes.slice(0, Math.max(2, previous.scenes.length - 1));
    else fault(422, '离线改稿支持“再简短一点”或“先讲第2段”。云端模式支持自由修改。');
  }
  return plan;
}
export async function makeQuote(req, env, user) {
  requireUser(user);
  if (!canGenerate(user, env)) fault(403, '生成课程需要激活内测邀请');
  const d = await input(req),
    topic = str(d.topic, 2, 240, '主题'),
    kind = d.kind === 'overview' ? 'overview' : 'point';
  const level = str(d.level || '零基础', 1, 32, '学习基础'),
    feedback = d.feedback ? str(d.feedback, 1, 400, '修改意见') : '';
  let previous = null;
  if (d.previous) {
    const old = await env.DB.prepare('SELECT lesson FROM quotes WHERE id=? AND user_id=?')
      .bind(String(d.previous), user.id)
      .first();
    if (!old) fault(404, '原大纲不存在');
    previous = JSON.parse(old.lesson);
  }
  const dev = local(req, env),
    offline = dev && env.LOCAL_CLOUD_MODELS !== '1',
    key = id();
  if (!offline && !env.DASHSCOPE_API_KEY) fault(503, '课程生成服务尚未配置');
  await limited(env.DB, 'quote:' + user.id, dev ? 80 : 12, 3600);
  let plan;
  if (offline) plan = demoPlan(topic, kind, previous, feedback);
  else {
    // The allowance is kept even on ambiguous timeouts. The renderer uses a separate allowance.
    const instruction =
      '你是中文科普课程编导。生成准确且安全的教育讲解，避免编造资料、数值和引用。危险操作仅解释一般概念。输出 JSON 对象：title、summary、followups（可独立学习的知识点字符串列表）、scenes。每个场景包含title、narration（可直接朗读的中文，用短句）、visual（flow/compare/cycle/orbit/network）、labels（2至4个准确且简短的图示标签）。示意图必须帮助理解讲解。领域概览给出知识地图和相互联系，用5至8幕、约700至1050字；知识点用一个具体例子解释一个机制，用3至5幕、约240至420字。用户数据供选题和改稿，请保留有关联的上下文。';
    const endpoint =
      (env.QWEN_BASE || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/$/, '') +
      '/chat/completions';
    const prompt = JSON.stringify({ topic, kind, level, previous, feedback }),
      maxTokens = 3200;
    const inputBound = new TextEncoder().encode(instruction + prompt).length + 256;
    await env.DB.prepare('INSERT INTO costs(id,ceiling_fen,created) VALUES(?,?,?)')
      .bind('plan:' + key, scriptCost(inputBound, maxTokens), now())
      .run();
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + env.DASHSCOPE_API_KEY,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(75000),
      body: JSON.stringify({
        model: env.QWEN_MODEL || 'qwen-plus',
        enable_thinking: false,
        max_tokens: 3200,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: instruction },
          { role: 'user', content: prompt },
        ],
      }),
    });
    if (!response.ok) fault(502, '千问暂时未能生成大纲，可稍后重试');
    const payload = await response.json(),
      usage = payload.usage;
    if (
      Number.isSafeInteger(usage?.prompt_tokens) &&
      usage.prompt_tokens >= 0 &&
      Number.isSafeInteger(usage.completion_tokens) &&
      usage.completion_tokens >= 0
    ) {
      await costSettlement(
        env.DB,
        'plan:' + key,
        scriptCost(usage.prompt_tokens, usage.completion_tokens),
        { input: usage.prompt_tokens, output: usage.completion_tokens },
      ).run();
    }
    try {
      plan = cleanPlan(JSON.parse(payload.choices[0].message.content));
    } catch {
      fault(502, '大纲格式有误，请重新生成');
    }
  }
  const seconds = Math.max(
    10,
    Math.round(plan.scenes.reduce((n, s) => n + s.narration.length, 0) / 4),
  );
  await env.DB.prepare('INSERT INTO quotes VALUES(?,?,?,?,?,?,?,?,?)')
    .bind(key, user.id, topic, kind, level, JSON.stringify(plan), seconds, points(seconds), now())
    .run();
  return json({
    id: key,
    kind,
    topic,
    level,
    lesson: plan,
    seconds,
    price: points(seconds),
    localDemo: offline,
  });
}
