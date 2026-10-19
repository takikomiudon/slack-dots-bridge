import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import worker, { BridgeObject } from '../src/index.js';

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const ctx = { storage: {
    sql: { exec(query, ...args) {
      const statement = db.prepare(query);
      let rows = [];
      if (statement.columns().length > 0) rows = statement.all(...args);
      else statement.run(...args);
      return { toArray: () => rows };
    } },
    transactionSync(callback) { db.exec('BEGIN'); const result = callback(); db.exec('COMMIT'); return result; },
    async setAlarm() {},
  } };
  const env = {
    SLACK_USER_TOKEN: 'user-token', SLACK_BOT_TOKEN: 'bot-token', SLACK_SIGNING_SECRET: 'signing-secret',
    SLACK_TEAM_ID: 'Tteam', SLACK_CHANNEL_ID: 'Cwork', SLACK_DM_CHANNEL_ID: 'Dinbox', SLACK_USER_ID: 'Uowner', DOTS_USER_ID: 'Udot', OPENAI_API_KEY: 'openai-key',
    LINE_CHANNEL_SECRET: 'legacy', LINE_CHANNEL_ACCESS_TOKEN: 'legacy', LINE_ALLOWED_USER_ID: 'legacy',
  };
  const object = new BridgeObject(ctx, env);
  env.BRIDGE = { getByName(name) { assert.equal(name, 'personal'); return f.object; } };
  const f = { db, ctx, env, object, calls: [], decisions: [], target: 'NEW', sequence: 0 };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === 'https://api.openai.com/v1/decisions') {
      f.decisions.push(JSON.parse(options.body));
      return Response.json({ answers: [{ type: 'choice', name: 'thread', choice: f.target, confidence: 0.9 }] }, { headers: { 'x-request-id': 'req_dm' } });
    }
    assert.ok(url.startsWith('https://slack.com/api/'), 'Unexpected external delivery: ' + url);
    const body = JSON.parse(options.body);
    f.calls.push({ url, body, token: options.headers.Authorization });
    assert.equal(url, 'https://slack.com/api/chat.postMessage');
    f.sequence++;
    return Response.json({ ok: true, channel: body.channel, ts: '200.' + String(f.sequence).padStart(6, '0') });
  });
  seed(f);
  return f;
}

function seed(f) {
  f.db.exec("INSERT OR IGNORE INTO threads VALUES ('100.000001')");
  f.object.context.markImported('100.000001');
  f.object.context.observe({ channel: 'Cwork', user: 'Uowner', ts: '100.000001', text: '<@Udot> 映画の予定' });
}

function dm(id, text = '新しい依頼') {
  return { type: 'event_callback', team_id: 'Tteam', event_id: id, event: { type: 'message', channel_type: 'im', channel: 'Dinbox', user: 'Uowner', ts: '150.' + id.length, text } };
}

function reply(id, text = '回答です', thread = '100.000001') {
  return { type: 'event_callback', team_id: 'Tteam', event_id: id, event: { type: 'message', channel: 'Cwork', user: 'Udot', ts: '160.' + id.length, thread_ts: thread, text, subtype: 'bot_message' } };
}

function signed(env, payload, path = '/slack', timestamp = String(Math.floor(Date.now() / 1000))) {
  let body = JSON.stringify(payload);
  if (path === '/slack/actions') body = new URLSearchParams({ payload: body }).toString();
  return new Request('https://bridge.test' + path, { method: 'POST', body, headers: {
    'Content-Type': 'application/json', 'x-slack-request-timestamp': timestamp,
    'x-slack-signature': 'v0=' + createHmac('sha256', env.SLACK_SIGNING_SECRET).update('v0:' + timestamp + ':' + body).digest('hex'),
  } });
}

function action(value, id = '1.001') {
  return { type: 'block_actions', team: { id: 'Tteam' }, user: { id: 'Uowner' }, channel: { id: 'Dinbox' }, actions: [{ action_id: 'route', action_ts: id, value }] };
}

test('a DM is classified once and forwarded to a new channel thread as the owner', async t => {
  const f = fixture(t);
  const event = dm('new');
  assert.equal((await worker.fetch(signed(f.env, event), f.env)).status, 200);
  await f.object.alarm();
  assert.equal(f.decisions.length, 1);
  assert.deepEqual(f.calls[0].body, { channel: 'Cwork', text: '<@Udot> 新しい依頼' });
  assert.equal(f.calls[0].token, 'Bearer user-token');
  assert.equal(f.db.prepare('SELECT thread FROM dm_messages WHERE ts = ?').get(event.event.ts).thread, '200.000001');
});

test('an ordinary DM continuation uses the selected existing thread without forwarding classifier evidence', async t => {
  const f = fixture(t); f.target = '100.000001';
  await worker.fetch(signed(f.env, dm('continue', 'その予定を30分早めて')), f.env);
  await f.object.alarm();
  assert.equal(f.decisions.length, 1);
  assert.deepEqual(f.calls[0].body, { channel: 'Cwork', text: '<@Udot> その予定を30分早めて', thread_ts: '100.000001' });
});

test('Dots replies return only to the inbox as the bridge bot with native Slack formatting', async t => {
  const f = fixture(t);
  const event = reply('response', '段落  続き');
  event.event.blocks = [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: '段落\n\n続き' }] }] }];
  await worker.fetch(signed(f.env, event), f.env);
  await f.object.alarm();
  assert.deepEqual(f.calls[0].body, { channel: 'Dinbox', text: event.event.text, blocks: event.event.blocks });
  assert.equal(f.calls[0].token, 'Bearer bot-token');
  assert.equal(f.db.prepare("SELECT thread FROM dm_messages WHERE ts = '200.000001'").get().thread, '100.000001');
});

test('a reply inside an inbox thread uses its exact stored destination without another classification', async t => {
  const f = fixture(t);
  await worker.fetch(signed(f.env, reply('first')), f.env); await f.object.alarm();
  const event = dm('explicit', '続きです'); event.event.thread_ts = '200.000001';
  await worker.fetch(signed(f.env, event), f.env); await f.object.alarm();
  assert.equal(f.decisions.length, 0);
  assert.equal(f.calls[1].body.thread_ts, '100.000001');
});

test('other users, DMs, teams, bot echoes and edits cannot invoke the router', async t => {
  const f = fixture(t);
  const wrongUser = dm('user'); wrongUser.event.user = 'Uother';
  const wrongDM = dm('channel'); wrongDM.event.channel = 'Dother';
  const wrongTeam = dm('team'); wrongTeam.team_id = 'Tother';
  const bot = dm('bot'); bot.event.bot_id = 'Bbridge';
  const edit = dm('edit'); edit.event.subtype = 'message_changed';
  for (const event of [wrongUser, wrongDM, wrongTeam, bot, edit]) await worker.fetch(signed(f.env, event), f.env);
  await f.object.alarm();
  assert.equal(f.decisions.length, 0); assert.equal(f.calls.length, 0);
});

test('duplicate inbox and Dots events are delivered exactly once', async t => {
  const f = fixture(t);
  for (let i = 0; i < 2; i++) await worker.fetch(signed(f.env, dm('duplicate')), f.env);
  await f.object.alarm(); await f.object.alarm();
  for (let i = 0; i < 2; i++) await worker.fetch(signed(f.env, reply('duplicate-reply')), f.env);
  await f.object.alarm(); await f.object.alarm();
  assert.equal(f.decisions.length, 1); assert.equal(f.calls.length, 2);
});

test('ambiguous input waits for inbox buttons and selection posts the original once', async t => {
  const f = fixture(t); f.target = 'CLARIFY';
  await worker.fetch(signed(f.env, dm('ambiguous', 'それお願い')), f.env); await f.object.alarm();
  assert.equal(f.calls.length, 0); await f.object.alarm();
  const buttons = f.calls[0].body.blocks.filter(block => block.type === 'actions').flatMap(block => block.elements);
  const choice = buttons.find(button => new URLSearchParams(button.value).get('target') === '100.000001');
  const input = action(choice.value);
  await worker.fetch(signed(f.env, input, '/slack/actions'), f.env); await f.object.alarm();
  await worker.fetch(signed(f.env, input, '/slack/actions'), f.env); await f.object.alarm();
  assert.equal(f.calls.length, 2); assert.equal(f.decisions.length, 1);
  assert.deepEqual(f.calls[1].body, { channel: 'Cwork', text: '<@Udot> それお願い', thread_ts: '100.000001' });
});

test('another user cannot approve a waiting selection', async t => {
  const f = fixture(t); f.target = 'CLARIFY';
  await worker.fetch(signed(f.env, dm('waiting')), f.env); await f.object.alarm(); await f.object.alarm();
  const button = f.calls[0].body.blocks.filter(block => block.type === 'actions').flatMap(block => block.elements)[0];
  const input = action(button.value); input.user.id = 'Uother';
  assert.equal((await worker.fetch(signed(f.env, input, '/slack/actions'), f.env)).status, 403);
  await f.object.alarm(); assert.equal(f.calls.length, 1);
});

test('unknown inbox thread references fail rather than guessing', async t => {
  const f = fixture(t); const event = dm('unknown'); event.event.thread_ts = '999.999';
  await worker.fetch(signed(f.env, event), f.env);
  await assert.rejects(() => f.object.alarm(), /Unknown inbox reply/);
  assert.equal(f.decisions.length, 0); assert.equal(f.calls.length, 0);
});

test('Slack failures remain identifiable and are not retried as a different route', async t => {
  const f = fixture(t);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: false, error: 'missing_scope' }));
  await worker.fetch(signed(f.env, reply('failed')), f.env);
  await assert.rejects(() => f.object.alarm(), /chat.postMessage.*missing_scope/);
  const row = f.db.prepare("SELECT status, error FROM jobs WHERE id = 'reply:failed'").get();
  assert.equal(row.status, 'failed'); assert.match(row.error, /missing_scope/);
  await f.object.alarm();
});

test('DM message mappings survive restarts', async t => {
  const f = fixture(t);
  await worker.fetch(signed(f.env, reply('before-restart')), f.env); await f.object.alarm();
  f.object = new BridgeObject(f.ctx, f.env);
  const event = dm('after-restart'); event.event.thread_ts = '200.000001';
  await worker.fetch(signed(f.env, event), f.env); await f.object.alarm();
  assert.equal(f.calls[1].body.thread_ts, '100.000001');
});

test('retiring LINE preserves conversations while preventing old outbound jobs', async t => {
  const f = fixture(t);
  f.object.enqueue('line:old-input', 'slack', { text: 'old input' });
  f.object.enqueue('slack:old-reply:0', 'line', { thread: '100.000001', messages: [] });
  f.object = new BridgeObject(f.ctx, f.env);
  await f.object.alarm();
  assert.equal(f.calls.length, 0);
  assert.equal(f.db.prepare("SELECT status FROM jobs WHERE id = 'line:old-input'").get().status, 'retired');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM threads').get().count, 1);
});

test('LINE endpoint is retired and Slack signatures still reject stale or tampered requests', async t => {
  const f = fixture(t);
  assert.equal((await worker.fetch(new Request('https://bridge.test/line', { method: 'POST', body: '{}' }), f.env)).status, 410);
  assert.equal((await worker.fetch(signed(f.env, dm('stale'), '/slack', '1'), f.env)).status, 401);
  const request = signed(f.env, dm('tampered')); request.headers.set('x-slack-signature', 'v0=' + '0'.repeat(64));
  assert.equal((await worker.fetch(request, f.env)).status, 401);
});
