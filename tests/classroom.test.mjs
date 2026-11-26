import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import worker from '../src/worker.js';
import { points, now } from '../src/common.js';
import { alipayString, asFen, responseNode } from '../src/payments.js';
import { scriptCost, renderCost } from '../src/costs.js';

function classroom() {
  const sqlite = new DatabaseSync(':memory:'),
    dir = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(dir)
    .filter((x) => x.endsWith('.sql'))
    .sort())
    sqlite.exec(readFileSync(new URL(file, dir), 'utf8'));
  const db = {
    prepare(sql, ...params) {
      const stmt = sqlite.prepare(sql);
      return {
        bind: (...p) => db.prepare(sql, ...p),
        first: async () => stmt.get(...params) || null,
        run: async () => stmt.run(...params),
        all: async () => ({ results: stmt.all(...params) }),
      };
    },
    async batch(ops) {
      sqlite.exec('BEGIN');
      try {
        const rows = [];
        for (const op of ops) rows.push(await op.all());
        sqlite.exec('COMMIT');
        return rows;
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
    },
  };
  const env = {
    DB: db,
    LOCAL_DEMO: '1',
    LOCAL_RENDER_KEY: 'local-worker-test',
    APP_ORIGIN: 'https://learn.hachile.org',
    PAYMENT_MODE: 'sandbox',
  };
  const origin = 'http://127.0.0.1:8787',
    ctx = { waitUntil() {} };
  async function call(path, data, token, headers = {}, method) {
    return worker.fetch(
      new Request(origin + '/api/' + path, {
        method: method || (data === undefined ? 'GET' : 'POST'),
        headers: {
          Origin: origin,
          'Content-Type': 'application/json',
          ...(token ? { Cookie: token } : {}),
          ...headers,
        },
        body: data === undefined ? undefined : JSON.stringify(data),
      }),
      env,
      ctx,
    );
  }
  async function member(email = 'class@classroom.test') {
    const { localCode } = await (await call('auth/code', { email })).json();
    const login = await call('auth/verify', { email, code: localCode, name: '甲' });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('Set-Cookie').split(';')[0];
    assert.equal((await call('auth/verify', { email, code: localCode })).status, 400);
    return cookie;
  }
  return { env, sqlite, call, member };
}

test('quotes lock a prorated integer price, and malformed currency never converts', () => {
  assert.deepEqual([1, 6, 7, 60, 90, 91].map(points), [1, 1, 2, 10, 15, 16]);
  assert.deepEqual(
    ['5', '5.0', '5.01', '5.001', '5e2', '-1', ''].map(asFen),
    [500, 500, 501, -1, -1, -1, -1],
  );
  assert.ok(renderCost(4000, 900) > renderCost(4000, 40));
  assert.ok(scriptCost(3000, 3200) > scriptCost(3000, 100));
});

test('one-time login, invitation, bounded offline topics, revision, idempotent reservation and failure release', async () => {
  const { call, member, sqlite } = classroom(),
    user = await member();
  const balances = async () => (await (await call('wallet', undefined, user)).json()).balances;
  assert.equal((await call('quotes', { topic: '天文学', kind: 'overview' }, user)).status, 403);
  for (let i = 0; i < 2; i++)
    assert.equal((await call('auth/invite', { code: 'CLASSROOM' }, user)).status, 200);
  assert.equal((await balances()).learn, 60);
  assert.equal((await call('quotes', { topic: '电影艺术' }, user)).status, 422);
  const draft = await (
    await call('quotes', { topic: '天文学入门', kind: 'overview' }, user)
  ).json();
  const revision = await (
    await call(
      'quotes',
      { topic: '天文学入门', previous: draft.id, feedback: '再简短一点', kind: 'overview' },
      user,
    )
  ).json();
  assert.ok(revision.lesson.scenes.length < draft.lesson.scenes.length);
  const create = () => call('jobs', { quote: draft.id, price: 0 }, user);
  const job = await (await create()).json(),
    repeat = await (await create()).json();
  assert.ok(job.id);
  assert.equal(job.id, repeat.id);
  assert.equal((await balances()).learn, 60 - draft.price);
  assert.equal((await call('jobs/' + job.id)).status, 404);
  const head = { Authorization: 'Bearer local-worker-test' },
    run = 'unique-test-lease-12345';
  const endpoint = 'internal/render/' + job.id + '/';
  assert.ok((await (await call(endpoint + 'claim', { run }, null, head)).json()).plan);
  assert.ok(
    (
      await (
        await call(endpoint + 'claim', { run: 'different-lease-123456789' }, null, head)
      ).json()
    ).skip,
  );
  await call(endpoint + 'fail', {}, null, { ...head, 'X-Render-Run': run });
  await call(endpoint + 'fail', {}, null, { ...head, 'X-Render-Run': run });
  assert.equal((await balances()).learn, 60);
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS n FROM ledger WHERE id LIKE 'release:%'").get().n,
    1,
  );
});

test('insufficient funds and spent pilot budget roll back the entire new job', async () => {
  const { call, member, sqlite, env } = classroom(),
    user = await member();
  await call('auth/invite', { code: 'CLASSROOM' }, user);
  const draft = await (await call('quotes', { topic: '土星环' }, user)).json();
  env.LOCAL_CLOUD_MODELS = '1';
  sqlite.prepare('UPDATE cost_budget SET cap_fen=1').run();
  assert.equal((await call('jobs', { quote: draft.id }, user)).status, 429);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 0);
  assert.equal(sqlite.prepare('SELECT SUM(amount) AS n FROM ledger').get().n, 60);
  sqlite.prepare('UPDATE cost_budget SET cap_fen=5000').run();
  const uid = sqlite.prepare('SELECT id FROM users').get().id;
  sqlite
    .prepare('INSERT INTO ledger VALUES(?,?,?,?,?,?)')
    .run('other', uid, 'learn', -60, 'previous usage', now());
  assert.equal((await call('jobs', { quote: draft.id }, user)).status, 402);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM costs').get().n, 0);
});

test('expired jobs release a hold only once, even on repeated maintenance', async () => {
  const { call, member, sqlite, env } = classroom(),
    user = await member();
  await call('auth/invite', { code: 'CLASSROOM' }, user);
  const draft = await (await call('quotes', { topic: '土星环' }, user)).json();
  await call('jobs', { quote: draft.id }, user);
  sqlite.prepare('UPDATE jobs SET deadline=0').run();
  for (let i = 0; i < 2; i++) {
    let task;
    await worker.scheduled({}, env, {
      waitUntil(p) {
        task = p;
      },
    });
    await task;
  }
  assert.equal(sqlite.prepare('SELECT state FROM jobs').get().state, 'failed');
  assert.equal(sqlite.prepare('SELECT SUM(amount) AS n FROM ledger').get().n, 60);
});

test('verified Alipay callbacks credit the matching sandbox order exactly once', async () => {
  const { env, member, sqlite } = classroom();
  await member();
  const keys = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  Object.assign(env, {
    ALIPAY_APP_ID: 'sandbox-app',
    ALIPAY_SELLER_ID: 'sandbox-seller',
    ALIPAY_PRIVATE_KEY: 'configured',
    ALIPAY_PUBLIC_KEY: Buffer.from(await crypto.subtle.exportKey('spki', keys.publicKey)).toString(
      'base64',
    ),
  });
  const user = sqlite.prepare('SELECT id FROM users').get().id;
  sqlite
    .prepare(
      "INSERT INTO orders(id,user_id,mode,fen,credits,created) VALUES('order',?,'sandbox',1000,100,?)",
    )
    .run(user, now());
  async function notify(extra) {
    const fields = {
      app_id: 'sandbox-app',
      seller_id: 'sandbox-seller',
      sign_type: 'RSA2',
      out_trade_no: 'order',
      trade_no: 'provider-trade',
      trade_status: 'TRADE_SUCCESS',
      total_amount: '10.00',
      ...extra,
    };
    fields.sign = Buffer.from(
      await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        keys.privateKey,
        new TextEncoder().encode(alipayString(fields, true)),
      ),
    ).toString('base64');
    return worker.fetch(
      new Request(env.APP_ORIGIN + '/api/payments/notify', {
        method: 'POST',
        body: new URLSearchParams(fields),
      }),
      env,
      {},
    );
  }
  assert.equal((await notify({ total_amount: '0.01' })).status, 400);
  assert.equal((await notify({ seller_id: 'other' })).status, 400);
  assert.equal((await notify({ trade_status: 'TRADE_CLOSED' })).status, 200);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM ledger').get().n, 0);
  for (let i = 0; i < 2; i++) assert.equal((await notify({})).status, 200);
  assert.deepEqual(
    { ...sqlite.prepare('SELECT wallet,amount FROM ledger').get() },
    { wallet: 'sandbox', amount: 100 },
  );
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM ledger').get().n, 1);
  assert.equal(
    responseNode(
      '{"alipay_trade_query_response": { "x":"a}b", "q":{} } ,"sign":"s"}',
      'alipay_trade_query_response',
    ),
    '{ "x":"a}b", "q":{} }',
  );
});

test('localhost-only development login, payment, and renderer credentials stay separate from hosted routes', async () => {
  const { env, call } = classroom();
  assert.equal(
    (
      await call('auth/code', { email: 'ab@classroom.test' }, null, {
        Origin: 'https://different.example',
      })
    ).status,
    403,
  );
  const r = await worker.fetch(
    new Request(env.APP_ORIGIN + '/api/auth/code', {
      method: 'POST',
      headers: { Origin: env.APP_ORIGIN },
      body: JSON.stringify({ email: 'ab@classroom.test' }),
    }),
    env,
    {},
  );
  assert.equal(r.status, 503);
  assert.ok(!(await r.text()).includes('localCode'));
  const wrongRenderer = await call('internal/render/local/next', {}, null, {
    Authorization: 'Bearer different',
  });
  assert.equal(wrongRenderer.status, 403);
});
test('public preview allows browsing and never opens a login, rendering or payment operation', async () => {
  const { env, call, sqlite } = classroom();
  env.PUBLIC_PREVIEW = '1';
  const session = await (await call('session')).json();
  assert.equal(session.preview, true);
  assert.equal(session.paymentAvailable, false);
  assert.equal(session.local, false);
  const catalog = await (await call('community')).json();
  assert.deepEqual(catalog.items.map((item) => item.id), ['rings', 'cosmos', 'network']);
  assert.ok(catalog.items.every((item) => item.sample));
  assert.equal(catalog.next, null);
  for (const path of ['auth/code', 'quotes', 'jobs', 'orders', 'payments/notify', 'internal/render/local/next']) {
    assert.equal((await call(path, {})).status, 503);
  }
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM ledger').get().n, 0);
});

test('bundled videos serve playable byte ranges when static storage only returns whole files', async () => {
  const content = '0123456789';
  const env = {
    ASSETS: {
      async fetch(req) {
        assert.equal(req.headers.has('Range'), false);
        return new Response(req.method === 'HEAD' ? null : content, {
          headers: { 'Content-Type': 'video/mp4', 'Content-Length': '10', ETag: '"lesson"' },
        });
      },
    },
  };
  const get = (headers, method = 'GET') => worker.fetch(
    new Request('https://learn.hachile.org/media/rings.mp4', { headers, method }), env, {},
  );
  for (const [range, start, end] of [['bytes=0-2', 0, 2], ['bytes=6-', 6, 9], ['bytes=-2', 8, 9]]) {
    const response = await get({ Range: range });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('Content-Range'), `bytes ${start}-${end}/10`);
    assert.equal(await response.text(), content.slice(start, end + 1));
  }
  const invalid = await get({ Range: 'bytes=12-' });
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get('Content-Range'), 'bytes */10');
  const changed = await get({ Range: 'bytes=0-2', 'If-Range': '"outdated"' });
  assert.equal(changed.status, 200);
  assert.equal(await changed.text(), content);
  const head = await get({}, 'HEAD');
  assert.equal(head.headers.get('Accept-Ranges'), 'bytes');
  assert.equal(await head.text(), '');
});

test('hosted planning uses a provider response for a new topic and settles actual token usage', async (t) => {
  const { env, member, sqlite } = classroom(),
    cookie = await member();
  sqlite.prepare('UPDATE users SET invited=1').run();
  env.DASHSCOPE_API_KEY = 'test-only';
  const topic = '为何彩虹有不同颜色？';
  const response = {
    title: '光的折射与色散',
    summary: '追踪光通过水滴的路径。',
    followups: ['为什么雨后常见彩虹？'],
    scenes: [
      {
        title: '进入水滴',
        narration: '光从空气进入水滴时会发生折射。',
        visual: 'flow',
        labels: ['入射光', '水滴'],
      },
      {
        title: '颜色分离',
        narration: '不同波长的光折射角度略有不同。',
        visual: 'compare',
        labels: ['红光', '紫光'],
      },
    ],
  };
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.ok(String(url).endsWith('/chat/completions'));
    assert.equal(JSON.parse(init.body).messages[1].content.includes(topic), true);
    return Response.json({
      choices: [{ message: { content: JSON.stringify(response) } }],
      usage: { prompt_tokens: 410, completion_tokens: 320 },
    });
  });
  const r = await worker.fetch(
    new Request(env.APP_ORIGIN + '/api/quotes', {
      method: 'POST',
      headers: {
        Origin: env.APP_ORIGIN,
        Cookie: cookie.replace('learn_local=', '__Host-learn_session='),
      },
      body: JSON.stringify({ topic, kind: 'point' }),
    }),
    env,
    {},
  );
  assert.equal(r.status, 200);
  const draft = await r.json();
  assert.equal(draft.lesson.title, response.title);
  assert.equal(draft.localDemo, false);
  const cost = sqlite.prepare('SELECT * FROM costs').get();
  assert.equal(cost.settled_fen, scriptCost(410, 320));
  assert.ok(cost.ceiling_fen >= cost.settled_fen);
  assert.equal(JSON.parse(cost.usage).output, 320);
});

test('a restored callback and an upfront budget overrun cannot open a second credit or budget window', async () => {
  const { sqlite } = classroom();
  sqlite
    .prepare('INSERT INTO costs(id,ceiling_fen,created) VALUES(?,?,?)')
    .run('example', 20, now());
  sqlite.prepare('UPDATE costs SET settled_fen=21 WHERE id=?').run('example');
  assert.equal(sqlite.prepare('SELECT paused FROM cost_budget').get().paused, 1);
  assert.throws(
    () =>
      sqlite
        .prepare('INSERT INTO costs(id,ceiling_fen,created) VALUES(?,?,?)')
        .run('another', 1, now()),
    /pilot_budget/,
  );
});
