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
  let slackCount = 0;
  let lineCount = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body), headers: options.headers });
    if (url === 'https://slack.com/api/chat.postMessage') {
      slackCount++;
      return Response.json({ ok: true, channel: 'Cprivate', ts: '1792000000.' + String(slackCount).padStart(6, '0') });
    }
    assert.equal(url, 'https://api.line.me/v2/bot/message/push');
    const sentMessages = JSON.parse(options.body).messages.map(() => { lineCount++; return { id: 'line-sent-' + lineCount }; });
    return Response.json({ sentMessages });
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

test('strangers, groups and unsupported LINE message types are ignored', async t => {
  const f = fixture(t);
  const video = lineEvent('video'); video.message = { type: 'video', id: 'video-id' };
  const image = lineEvent('stranger-image', '', 'Ustranger'); image.message = { type: 'image', id: '123', contentProvider: { type: 'line' } };
  const group = lineEvent('group'); group.source.type = 'group';
  await worker.fetch(signedLine(f.env, [lineEvent('stranger', '秘密', 'Ustranger'), image, video, group]), f.env);
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

test('unquoted LINE messages always start separate Slack threads', async t => {
  const f = fixture(t);
  await establishSession(f);
  await worker.fetch(signedLine(f.env, [lineEvent('second', '別件です')]), f.env);
  await f.object.alarm();
  assert.equal(Object.hasOwn(f.calls[1].body, 'thread_ts'), false);
  await worker.fetch(signedSlack(f.env, slackEvent('first-reply')), f.env);
  await f.object.alarm();
  await worker.fetch(signedSlack(f.env, slackEvent('second-reply', '別件の回答', '1792000000.000002')), f.env);
  await f.object.alarm();
  assert.equal(f.calls.length, 4);
  assert.equal(f.calls[2].body.messages[0].text, '回答です');
  assert.equal(f.calls[3].body.messages[0].text, '別件の回答');
});

test('LINE quotes select the original thread after another thread and restart', async t => {
  const f = fixture(t);
  await establishSession(f);
  await worker.fetch(signedSlack(f.env, slackEvent('first-reply')), f.env);
  await f.object.alarm();
  await worker.fetch(signedLine(f.env, [lineEvent('new-topic')]), f.env);
  await f.object.alarm();
  await worker.fetch(signedSlack(f.env, slackEvent('second-reply', '別件', '1792000000.000002')), f.env);
  await f.object.alarm();
  const restarted = new BridgeObject(f.ctx, f.env);
  f.env.BRIDGE.getByName = () => restarted;
  const firstQuote = lineEvent('quote-first', '最初の話の続き');
  firstQuote.message.quotedMessageId = 'line-sent-1';
  await worker.fetch(signedLine(f.env, [firstQuote]), f.env);
  await restarted.alarm();
  assert.equal(f.calls[4].body.thread_ts, '1792000000.000001');
  const secondQuote = lineEvent('quote-second', '別件の続き');
  secondQuote.message.quotedMessageId = 'line-sent-2';
  await worker.fetch(signedLine(f.env, [secondQuote]), f.env);
  await restarted.alarm();
  assert.equal(f.calls[5].body.thread_ts, '1792000000.000002');
  await worker.fetch(signedLine(f.env, [lineEvent('another-topic')]), f.env);
  await restarted.alarm();
  assert.equal(Object.hasOwn(f.calls[6].body, 'thread_ts'), false);
});

test('unknown LINE quotes fail explicitly without posting to a guessed thread', async t => {
  const f = fixture(t);
  await establishSession(f);
  const event = lineEvent('unknown-quote');
  event.message.quotedMessageId = 'unmapped-message';
  await worker.fetch(signedLine(f.env, [event]), f.env);
  await assert.rejects(async () => f.object.alarm(), /Unknown LINE quoted message: unmapped-message/);
  assert.equal(f.calls.length, 1);
  const [job] = f.db.prepare("SELECT status, error FROM jobs WHERE id = 'line:unknown-quote'").all();
  assert.equal(job.status, 'failed');
  assert.match(job.error, /unmapped-message/);
});

test('legacy thread stays eligible for Dots replies but normal sends start new threads', async t => {
  const f = fixture(t);
  f.db.exec("INSERT INTO session (id, thread) VALUES (1, 'legacy-thread')");
  const restarted = new BridgeObject(f.ctx, f.env);
  f.env.BRIDGE.getByName = () => restarted;
  await worker.fetch(signedSlack(f.env, slackEvent('legacy-reply', '以前の会話の新しい回答', 'legacy-thread')), f.env);
  await restarted.alarm();
  assert.equal(f.calls[0].body.messages[0].text, '以前の会話の新しい回答');
  const quote = lineEvent('legacy-quote'); quote.message.quotedMessageId = 'line-sent-1';
  await worker.fetch(signedLine(f.env, [quote]), f.env);
  await restarted.alarm();
  assert.equal(f.calls[1].body.thread_ts, 'legacy-thread');
  await worker.fetch(signedLine(f.env, [lineEvent('new-after-migration')]), f.env);
  await restarted.alarm();
  assert.equal(Object.hasOwn(f.calls[2].body, 'thread_ts'), false);
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
  const quote = lineEvent('quote-later-chunk'); quote.message.quotedMessageId = 'line-sent-6';
  await worker.fetch(signedLine(f.env, [quote]), f.env);
  await f.object.alarm();
  assert.equal(f.calls.at(-1).body.thread_ts, '1792000000.000001');
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
  t.mock.method(globalThis, 'fetch', async () => Response.json({ sentMessages: [{ id: 'already-sent' }] }, { status: 409, headers: { 'x-line-accepted-request-id': 'accepted' } }));
  await worker.fetch(signedSlack(f.env, slackEvent('accepted')), f.env);
  await f.object.alarm();
  const [job] = f.db.prepare("SELECT status FROM jobs WHERE id LIKE 'slack:%'").all();
  assert.equal(job.status, 'done');
  const quote = lineEvent('accepted-quote'); quote.message.quotedMessageId = 'already-sent';
  await worker.fetch(signedLine(f.env, [quote]), f.env);
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(JSON.parse(options.body).thread_ts, '1792000000.000001');
    return Response.json({ ok: true, ts: '1792000000.000002' });
  });
  await f.object.alarm();
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


test('LINE accepted response must include every sent message id', async t => {
  const f = fixture(t);
  await establishSession(f);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ sentMessages: [] }));
  await worker.fetch(signedSlack(f.env, slackEvent('missing-ids')), f.env);
  await assert.rejects(async () => f.object.alarm(), /LINE sentMessages/);
});

test('LINE 409 without accepted-request-id is an error', async t => {
  const f = fixture(t);
  await establishSession(f);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ message: 'conflict' }, { status: 409 }));
  await worker.fetch(signedSlack(f.env, slackEvent('unaccepted')), f.env);
  await assert.rejects(async () => f.object.alarm(), /LINE HTTP 409/);
});


function imageEvent(id) {
  const event = lineEvent(id);
  event.message = { type: 'image', id: '354718705033693859', contentProvider: { type: 'line' } };
  return event;
}

function imageFixture(t) {
  const f = fixture(t);
  const baseFetch = globalThis.fetch;
  f.bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  f.imageResponse = () => new Response(f.bytes, { headers: { 'Content-Type': 'image/png' } });
  f.uploadGrant = { ok: true, file_id: 'Fimage', upload_url: 'https://files.slack.com/upload/v1/test-upload' };
  f.uploadResponse = () => new Response('OK');
  f.completeResult = { ok: true, files: [{ id: 'Fimage' }] };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === 'https://api-data.line.me/v2/bot/message/354718705033693859/content') {
      f.calls.push({ url, headers: options.headers });
      return f.imageResponse();
    }
    if (url === 'https://slack.com/api/files.getUploadURLExternal') {
      assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded');
      f.calls.push({ url, body: Object.fromEntries(new URLSearchParams(options.body)), headers: options.headers });
      return Response.json(f.uploadGrant);
    }
    if (url === 'https://files.slack.com/upload/v1/test-upload') {
      f.calls.push({ url, body: new Uint8Array(options.body), headers: options.headers });
      return f.uploadResponse();
    }
    if (url === 'https://slack.com/api/files.completeUploadExternal') {
      f.calls.push({ url, body: JSON.parse(options.body), headers: options.headers });
      return Response.json(f.completeResult);
    }
    return baseFetch(url, options);
  });
  return f;
}

test('LINE image is queued, uploaded privately unchanged, then Dots is mentioned', async t => {
  const f = imageFixture(t);
  for (let i = 0; i < 2; i++) assert.equal((await worker.fetch(signedLine(f.env, [imageEvent('photo')]), f.env)).status, 200);
  assert.equal(f.calls.length, 0);
  await f.object.alarm();
  await f.object.alarm();
  assert.deepEqual(f.calls.map(c => c.url), [
    'https://api-data.line.me/v2/bot/message/354718705033693859/content',
    'https://slack.com/api/files.getUploadURLExternal',
    'https://files.slack.com/upload/v1/test-upload',
    'https://slack.com/api/chat.postMessage',
    'https://slack.com/api/files.completeUploadExternal',
    'https://slack.com/api/chat.postMessage',
  ]);
  assert.equal(f.calls[0].headers.Authorization, 'Bearer test-line-token');
  assert.equal(f.calls[1].headers.Authorization, 'Bearer test-user-token');
  assert.equal(f.calls[1].body.length, String(f.bytes.length));
  assert.match(f.calls[1].body.filename, /354718705033693859\.png$/);
  assert.deepEqual(f.calls[2].body, f.bytes);
  assert.equal(Object.hasOwn(f.calls[2].headers, 'Authorization'), false);
  assert.equal(f.calls[3].body.text.includes('<@Udot>'), false);
  assert.equal(Object.hasOwn(f.calls[3].body, 'thread_ts'), false);
  assert.deepEqual(f.calls[4].body, { files: [{ id: 'Fimage' }], channel_id: 'Cprivate', thread_ts: '1792000000.000001' });
  assert.equal(f.calls[5].body.thread_ts, '1792000000.000001');
  assert.match(f.calls[5].body.text, /<@Udot>/);
  assert.equal(f.db.prepare('SELECT payload FROM jobs').get().payload.includes('iVBOR'), false);
  await worker.fetch(signedSlack(f.env, slackEvent('photo-reply', '画像に赤い丸が見えます')), f.env);
  await f.object.alarm();
  assert.equal(f.calls.at(-1).body.messages[0].text, '画像に赤い丸が見えます');
});

test('image quote uses the exact existing thread without creating another root', async t => {
  const f = imageFixture(t);
  await establishSession(f);
  await worker.fetch(signedSlack(f.env, slackEvent('text-reply')), f.env);
  await f.object.alarm();
  f.calls.length = 0;
  const event = imageEvent('quoted-photo'); event.message.quotedMessageId = 'line-sent-1';
  await worker.fetch(signedLine(f.env, [event]), f.env);
  await f.object.alarm();
  const chats = f.calls.filter(c => c.url === 'https://slack.com/api/chat.postMessage');
  assert.equal(chats.length, 1);
  assert.equal(chats[0].body.thread_ts, '1792000000.000001');
  assert.equal(f.calls.find(c => c.url.endsWith('files.completeUploadExternal')).body.thread_ts, '1792000000.000001');
});

test('LINE missing image content is persisted as a failure without Slack posts', async t => {
  const f = imageFixture(t);
  f.imageResponse = () => new Response('Gone', { status: 410 });
  await worker.fetch(signedLine(f.env, [imageEvent('gone-photo')]), f.env);
  await assert.rejects(async () => f.object.alarm(), /LINE image HTTP 410/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.db.prepare('SELECT status FROM jobs').get().status, 'failed');
});

test('image transfer rejects unsupported MIME types before uploading', async t => {
  const f = imageFixture(t);
  f.imageResponse = () => new Response('not an image', { headers: { 'Content-Type': 'text/html' } });
  await worker.fetch(signedLine(f.env, [imageEvent('html-photo')]), f.env);
  await assert.rejects(async () => f.object.alarm(), /Unsupported LINE image content type/);
  assert.equal(f.calls.length, 1);
});

test('image transfer stops reading at 10 MiB and never uploads oversized bytes', async t => {
  const f = imageFixture(t);
  let cancelled = false;
  f.imageResponse = () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(10 * 1024 * 1024)); controller.enqueue(new Uint8Array(1)); },
    cancel() { cancelled = true; },
  }), { headers: { 'Content-Type': 'image/png' } });
  await worker.fetch(signedLine(f.env, [imageEvent('large-photo')]), f.env);
  await assert.rejects(async () => f.object.alarm(), /LINE image exceeds 10 MiB/);
  assert.equal(cancelled, true);
  assert.equal(f.calls.length, 1);
});

test('Slack missing file permission is explicit and does not post or mention Dots', async t => {
  const f = imageFixture(t); f.uploadGrant = { ok: false, error: 'missing_scope' };
  await worker.fetch(signedLine(f.env, [imageEvent('no-files-scope')]), f.env);
  await assert.rejects(async () => f.object.alarm(), /files.getUploadURLExternal.*missing_scope/);
  assert.equal(f.calls.length, 2);
});

test('upload grant cannot send image data or credentials to an unexpected host', async t => {
  const f = imageFixture(t); f.uploadGrant.upload_url = 'https://untrusted.example/upload';
  await worker.fetch(signedLine(f.env, [imageEvent('bad-upload-host')]), f.env);
  await assert.rejects(async () => f.object.alarm(), /Invalid Slack upload URL/);
  assert.equal(f.calls.length, 2);
});

test('failed binary upload never creates a Slack root or wakes Dots', async t => {
  const f = imageFixture(t); f.uploadResponse = () => new Response('failed', { status: 500 });
  await worker.fetch(signedLine(f.env, [imageEvent('upload-failed')]), f.env);
  await assert.rejects(async () => f.object.alarm(), /Slack image upload HTTP 500/);
  assert.equal(f.calls.length, 3);
});

test('failed file sharing never mentions Dots and remains visible', async t => {
  const f = imageFixture(t); f.completeResult = { ok: false, error: 'file_not_found' };
  await worker.fetch(signedLine(f.env, [imageEvent('share-failed')]), f.env);
  await assert.rejects(async () => f.object.alarm(), /files.completeUploadExternal.*file_not_found/);
  assert.equal(f.calls.length, 5);
  assert.equal(f.calls.at(-1).url.endsWith('files.completeUploadExternal'), true);
});

test('successful binary upload may have an empty response body', async t => {
  const f = imageFixture(t); f.uploadResponse = () => new Response();
  await worker.fetch(signedLine(f.env, [imageEvent('empty-upload-response')]), f.env);
  await f.object.alarm();
  assert.equal(f.calls.at(-1).url, 'https://slack.com/api/chat.postMessage');
  assert.match(f.calls.at(-1).body.text, /<@Udot>/);
});
