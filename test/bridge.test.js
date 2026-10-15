import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import worker, { BridgeObject } from '../src/index.js';

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const ctx = { storage: {
    sql: { exec(query, ...params) {
      const statement = db.prepare(query);
      let rows = [];
      if (statement.columns().length > 0) rows = statement.all(...params);
      else statement.run(...params);
      return { toArray: () => rows };
    } },
    transactionSync(callback) {
      db.exec('BEGIN');
      const value = callback();
      db.exec('COMMIT');
      return value;
    },
    async setAlarm(time) { ctx.nextAlarm = time; },
  } };
  const env = {
    SLACK_USER_TOKEN: 'test-user-token', SLACK_SIGNING_SECRET: 'test-slack-secret',
    LINE_CHANNEL_SECRET: 'test-line-secret', LINE_CHANNEL_ACCESS_TOKEN: 'test-line-token',
    LINE_ALLOWED_USER_ID: 'Ulineowner', SLACK_TEAM_ID: 'Tteam',
    SLACK_CHANNEL_ID: 'Cprivate', DOTS_USER_ID: 'Udot',
  };
  const object = new BridgeObject(ctx, env);
  env.BRIDGE = { getByName(name) { assert.equal(name, 'personal'); return object; } };
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body), headers: options.headers });
    if (url === 'https://slack.com/api/chat.postMessage') {
      return Response.json({ ok: true, channel: 'Cprivate', ts: '1792000000.000001' });
    }
    assert.equal(url, 'https://api.line.me/v2/bot/message/push');
    return Response.json({ sentMessages: [] });
  });
  return { db, ctx, env, object, calls };
}

function lineEvent(id, text = 'こんにちは', userId = 'Ulineowner') {
  return { type: 'message', webhookEventId: id, source: { type: 'user', userId }, message: { type: 'text', text } };
}
function slackEvent(id, text = '回答です', thread = '1792000000.000001') {
  return { type: 'event_callback', team_id: 'Tteam', event_id: id,
    event: { type: 'message', channel: 'Cprivate', user: 'Udot', thread_ts: thread, text, ts: '1792000001.000001', subtype: 'bot_message' } };
}
function signedLine(env, events) {
  const body = JSON.stringify({ events });
  return new Request('https://bridge.example/line', { method: 'POST', body,
    headers: { 'x-line-signature': createHmac('sha256', env.LINE_CHANNEL_SECRET).update(body).digest('base64') } });
}
function signedSlack(env, payload, timestamp = String(Math.floor(Date.now() / 1000))) {
  const body = JSON.stringify(payload);
  const signature = 'v0=' + createHmac('sha256', env.SLACK_SIGNING_SECRET).update('v0:' + timestamp + ':' + body).digest('hex');
  return new Request('https://bridge.example/slack', { method: 'POST', body,
    headers: { 'x-slack-request-timestamp': timestamp, 'x-slack-signature': signature } });
}
async function establishSession(f) {
  assert.equal((await worker.fetch(signedLine(f.env, [lineEvent('initial')]), f.env)).status, 200);
  await f.object.alarm();
}

test('health check validates configuration without exposing secrets', async t => {
  const f = fixture(t);
  const response = await worker.fetch(new Request('https://bridge.example/health'), f.env);
  assert.deepEqual(await response.json(), { status: 'ok' });
  delete f.env.LINE_CHANNEL_SECRET;
  await assert.rejects(async () => worker.fetch(new Request('https://bridge.example/health'), f.env), /LINE_CHANNEL_SECRET/);
});

test('LINE rejects missing and forged signatures before any delivery', async t => {
  const f = fixture(t);
  for (const headers of [{}, { 'x-line-signature': 'A'.repeat(43) + '=' }]) {
    const response = await worker.fetch(new Request('https://bridge.example/line', { method: 'POST', body: '{"events":[]}', headers }), f.env);
    assert.equal(response.status, 401);
  }
  assert.equal(f.calls.length, 0);
});

test('Slack rejects forged, missing, and stale signatures', async t => {
  const f = fixture(t);
  const missing = await worker.fetch(new Request('https://bridge.example/slack', { method: 'POST', body: '{}' }), f.env);
  assert.equal(missing.status, 401);
  const request = signedSlack(f.env, slackEvent('forged'));
  request.headers.set('x-slack-signature', 'v0=' + '0'.repeat(64));
  assert.equal((await worker.fetch(request, f.env)).status, 401);
  assert.equal((await worker.fetch(signedSlack(f.env, slackEvent('old'), '1'), f.env)).status, 401);
});

test('Slack URL verification responds only after signature verification', async t => {
  const f = fixture(t);
  const response = await worker.fetch(signedSlack(f.env, { type: 'url_verification', challenge: 'challenge-test' }), f.env);
  assert.deepEqual(await response.json(), { challenge: 'challenge-test' });
});

test('LINE verification with an empty event list succeeds', async t => {
  const f = fixture(t);
  assert.equal((await worker.fetch(signedLine(f.env, []), f.env)).status, 200);
  await f.object.alarm();
  assert.equal(f.calls.length, 0);
});

test('only the configured LINE owner can send text to Slack', async t => {
  const f = fixture(t);
  const image = lineEvent('image'); image.message = { type: 'image', id: 'image-id' };
  const group = lineEvent('group'); group.source.type = 'group';
  await worker.fetch(signedLine(f.env, [lineEvent('stranger', '秘密', 'Ustranger'), image, group]), f.env);
  await f.object.alarm();
  assert.equal(f.calls.length, 0);
});

test('LINE is acknowledged before delivery and duplicate events deliver once', async t => {
  const f = fixture(t);
  for (let i = 0; i < 2; i++) await worker.fetch(signedLine(f.env, [lineEvent('unique', '<@Uother> & 文')]), f.env);
  assert.equal(f.calls.length, 0);
  assert.equal(typeof f.ctx.nextAlarm, 'number');
  await f.object.alarm();
  await f.object.alarm();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].body, { channel: 'Cprivate', text: '<@Udot> &lt;@Uother&gt; &amp; 文' });
  assert.equal(f.calls[0].headers.Authorization, 'Bearer test-user-token');
});

test('later LINE messages continue in the persisted Slack thread after restart', async t => {
  const f = fixture(t);
  await establishSession(f);
  const restarted = new BridgeObject(f.ctx, f.env);
  f.env.BRIDGE.getByName = () => restarted;
  await worker.fetch(signedLine(f.env, [lineEvent('second', '続きです')]), f.env);
  await restarted.alarm();
  assert.equal(f.calls[1].body.thread_ts, '1792000000.000001');
});

test('only Dots replies in the linked thread are forwarded, without loops', async t => {
  const f = fixture(t);
  await establishSession(f);
  const wrongUser = slackEvent('user'); wrongUser.event.user = 'Uowner';
  const wrongChannel = slackEvent('channel'); wrongChannel.event.channel = 'Cother';
  const wrongTeam = slackEvent('team'); wrongTeam.team_id = 'Tother';
  const edited = slackEvent('edit'); edited.event.subtype = 'message_changed';
  for (const event of [wrongUser, wrongChannel, wrongTeam, edited, slackEvent('thread', '別スレッド', 'other-thread')]) {
    await worker.fetch(signedSlack(f.env, event), f.env);
  }
  await f.object.alarm();
  assert.equal(f.calls.length, 1);
  for (let i = 0; i < 2; i++) await worker.fetch(signedSlack(f.env, slackEvent('reply')), f.env);
  await f.object.alarm();
  await f.object.alarm();
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[1].body, { to: 'Ulineowner', messages: [{ type: 'text', text: '回答です' }] });
  assert.match(f.calls[1].headers['X-Line-Retry-Key'], /^[a-f0-9-]{36}$/);
});

test('long Unicode replies respect LINE limits without breaking characters', async t => {
  const f = fixture(t);
  await establishSession(f);
  const text = '😀'.repeat(15001);
  await worker.fetch(signedSlack(f.env, slackEvent('long', text)), f.env);
  await f.object.alarm();
  await f.object.alarm();
  const batches = f.calls.slice(1);
  assert.equal(batches.length, 2);
  const chunks = batches.flatMap(call => call.body.messages.map(message => message.text));
  assert.equal(chunks.join(''), text);
  for (const batch of batches) assert.ok(batch.body.messages.length <= 5);
  for (const chunk of chunks) { assert.ok(chunk.length <= 5000); assert.equal(chunk.isWellFormed(), true); }
  assert.notEqual(batches[0].headers['X-Line-Retry-Key'], batches[1].headers['X-Line-Retry-Key']);
});

test('Slack API errors are persisted and surfaced without duplicate retries', async t => {
  const f = fixture(t);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: false, error: 'missing_scope' }));
  await worker.fetch(signedLine(f.env, [lineEvent('error')]), f.env);
  await assert.rejects(async () => f.object.alarm(), /Slack.*missing_scope/);
  const [job] = f.db.prepare('SELECT status, error FROM jobs').all();
  assert.equal(job.status, 'failed');
  assert.match(job.error, /missing_scope/);
  await f.object.alarm();
});

test('network failures remain visible and persisted', async t => {
  const f = fixture(t);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('network unavailable'); });
  await worker.fetch(signedLine(f.env, [lineEvent('network')]), f.env);
  await assert.rejects(async () => f.object.alarm(), /network unavailable/);
  const [job] = f.db.prepare('SELECT status, error FROM jobs').all();
  assert.equal(job.status, 'failed');
  assert.match(job.error, /network unavailable/);
});

test('LINE API errors are persisted and surfaced', async t => {
  const f = fixture(t);
  await establishSession(f);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ message: 'monthly limit reached' }, { status: 429 }));
  await worker.fetch(signedSlack(f.env, slackEvent('limit')), f.env);
  await assert.rejects(async () => f.object.alarm(), /LINE.*429/);
});

test('LINE retry conflict is accepted only with accepted-request-id', async t => {
  const f = fixture(t);
  await establishSession(f);
  t.mock.method(globalThis, 'fetch', async () => Response.json({}, { status: 409, headers: { 'x-line-accepted-request-id': 'accepted' } }));
  await worker.fetch(signedSlack(f.env, slackEvent('accepted')), f.env);
  await f.object.alarm();
  const [job] = f.db.prepare("SELECT status FROM jobs WHERE id LIKE 'slack:%'").all();
  assert.equal(job.status, 'done');
});

test('Dots reply arriving before Slack HTTP response is retained and delivered', async t => {
  const f = fixture(t);
  const originalMock = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === 'https://slack.com/api/chat.postMessage') {
      await worker.fetch(signedSlack(f.env, slackEvent('early')), f.env);
    }
    return originalMock(url, options);
  });
  await worker.fetch(signedLine(f.env, [lineEvent('race')]), f.env);
  await f.object.alarm();
  await f.object.alarm();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].body.messages[0].text, '回答です');
});
