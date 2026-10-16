import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { Miniflare, Response, convertV4MiniflareOptions } from 'miniflare';

test('workerd transfers an image through a real Durable Object alarm', { timeout: 20000 }, async t => {
  const shared = Promise.withResolvers();
  const returned = Promise.withResolvers();
  const routed = Promise.withResolvers();
  const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const calls = [];
  const mf = new Miniflare(convertV4MiniflareOptions({
    name: 'image-edge-test',
    modules: ['index', 'context', 'routing', 'images'].map(name => ({ type: 'ESModule', path: new URL('../src/' + name + '.js', import.meta.url).pathname })),
    modulesRoot: new URL('../', import.meta.url).pathname,
    compatibilityDate: '2026-10-15',
    durableObjects: { BRIDGE: { className: 'BridgeObject', useSQLite: true } },
    bindings: {
      SLACK_USER_TOKEN: 'slack-token', SLACK_SIGNING_SECRET: 'slack-secret',
      SLACK_USER_ID: 'owner', OPENAI_API_KEY: 'openai-test-token',
      LINE_CHANNEL_SECRET: 'line-secret', LINE_CHANNEL_ACCESS_TOKEN: 'line-token',
      LINE_ALLOWED_USER_ID: 'owner', SLACK_TEAM_ID: 'team', SLACK_CHANNEL_ID: 'private', DOTS_USER_ID: 'dot',
    },
    outboundService: async request => {
      const path = new URL(request.url).pathname;
      calls.push(path);
      if (path === '/v2/bot/message/123/content') return new Response(bytes, { headers: { 'Content-Type': 'image/png' } });
      if (path === '/api/files.getUploadURLExternal') {
        assert.equal(request.headers.get('Content-Type'), 'application/x-www-form-urlencoded');
        assert.equal(new URLSearchParams(await request.text()).get('length'), String(bytes.length));
        return Response.json({ ok: true, file_id: 'file', upload_url: 'https://files.slack.com/upload/v1/edge' });
      }
      if (path === '/upload/v1/edge') {
        assert.deepEqual(new Uint8Array(await request.arrayBuffer()), bytes);
        assert.equal(request.headers.has('Authorization'), false);
        return new Response();
      }
      if (path === '/api/files.completeUploadExternal') {
        const body = await request.json();
        assert.deepEqual(body, { files: [{ id: 'file' }], channel_id: 'private', initial_comment: '<@dot>' });
        shared.resolve(body);
        return Response.json({ ok: true, files: [{ id: 'file' }] });
      }
      if (path === '/api/files.info') return Response.json({ ok: true, file: { id: 'file', name: 'image.png', mimetype: 'image/png', url_private_download: 'https://files.slack.com/files-pri/T-file/image.png' } });
      if (path === '/files-pri/T-file/image.png') return new Response(bytes, { headers: { 'Content-Type': 'image/png' } });
      if (path === '/v1/decisions') {
        assert.equal(request.headers.get('Authorization'), 'Bearer openai-test-token');
        const body = await request.json();
        assert.ok(body.input[0].content.some(part => part.type === 'input_image' && part.image_url.startsWith('data:image/png;base64,')));
        return Response.json({ answers: [{ name: 'thread', type: 'choice', choice: '123.000001', confidence: 0.97 }] }, { headers: { 'x-request-id': 'req_edge' } });
      }
      if (path === '/api/chat.postMessage') {
        const body = await request.json();
        assert.deepEqual(body, { channel: 'private', text: '<@dot> これを予定に入れて', thread_ts: '123.000001' });
        routed.resolve(body);
        return Response.json({ ok: true, ts: '123.000003' });
      }
      assert.equal(path, '/v2/bot/message/push');
      returned.resolve(await request.json());
      return Response.json({ sentMessages: [{ id: 'line-reply' }] });
    },
  }));
  t.after(() => mf.dispose());
  const body = JSON.stringify({ events: [{ type: 'message', webhookEventId: 'edge-image', source: { type: 'user', userId: 'owner' }, message: { type: 'image', id: '123', contentProvider: { type: 'line' } } }] });
  const response = await mf.dispatchFetch('https://bridge.test/line', { method: 'POST', body, headers: { 'x-line-signature': createHmac('sha256', 'line-secret').update(body).digest('base64') } });
  assert.equal(response.status, 200);
  assert.equal((await shared.promise).initial_comment, '<@dot>');
  assert.deepEqual(calls, ['/v2/bot/message/123/content', '/api/files.getUploadURLExternal', '/upload/v1/edge', '/api/files.completeUploadExternal']);
  async function sendSlack(id, event) {
    const payload = JSON.stringify({ type: 'event_callback', team_id: 'team', event_id: id, event });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = 'v0=' + createHmac('sha256', 'slack-secret').update('v0:' + timestamp + ':' + payload).digest('hex');
    const response = await mf.dispatchFetch('https://bridge.test/slack', { method: 'POST', body: payload, headers: { 'x-slack-request-timestamp': timestamp, 'x-slack-signature': signature } });
    assert.equal(response.status, 200, await response.text());
  }
  await sendSlack('edge-reply', { type: 'message', channel: 'private', user: 'dot', ts: '123.000002', thread_ts: '123.000001', text: '画像を確認しました' });
  await sendSlack('edge-file', { type: 'message', channel: 'private', user: 'owner', ts: '123.000001', files: [{ id: 'file' }] });
  assert.deepEqual((await returned.promise).messages, [{ type: 'text', text: '画像を確認しました' }]);
  const followup = JSON.stringify({ events: [{ type: 'message', webhookEventId: 'image-followup', source: { type: 'user', userId: 'owner' }, message: { type: 'text', text: 'これを予定に入れて' } }] });
  assert.equal((await mf.dispatchFetch('https://bridge.test/line', { method: 'POST', body: followup, headers: { 'x-line-signature': createHmac('sha256', 'line-secret').update(followup).digest('base64') } })).status, 200);
  assert.equal((await routed.promise).thread_ts, '123.000001');
});
