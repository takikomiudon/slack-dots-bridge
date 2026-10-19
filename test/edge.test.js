import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { Miniflare, Response, convertV4MiniflareOptions } from 'miniflare';

test('workerd routes a DM image and continuation, then returns native Slack blocks to the inbox', { timeout: 20000 }, async t => {
  const shared = Promise.withResolvers();
  const returned = Promise.withResolvers();
  const routed = Promise.withResolvers();
  const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const calls = [];
  const blocks = [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: '画像を確認しました\n\n続きです' }] }] }];
  const mf = new Miniflare(convertV4MiniflareOptions({
    name: 'dm-edge-test',
    modules: ['index', 'context', 'routing', 'images'].map(name => ({ type: 'ESModule', path: new URL('../src/' + name + '.js', import.meta.url).pathname })),
    modulesRoot: new URL('../', import.meta.url).pathname,
    compatibilityDate: '2026-10-15',
    durableObjects: { BRIDGE: { className: 'BridgeObject', useSQLite: true } },
    bindings: { SLACK_USER_TOKEN: 'user-token', SLACK_BOT_TOKEN: 'bot-token', SLACK_SIGNING_SECRET: 'secret', SLACK_USER_ID: 'owner', OPENAI_API_KEY: 'openai-token', SLACK_TEAM_ID: 'team', SLACK_CHANNEL_ID: 'private', SLACK_DM_CHANNEL_ID: 'inbox', DOTS_USER_ID: 'dot' },
    outboundService: async request => {
      const path = new URL(request.url).pathname; calls.push(path);
      if (path === '/api/files.info') {
        const id = new URLSearchParams(await request.text()).get('file');
        return Response.json({ ok: true, file: { id, name: 'photo.png', mimetype: 'image/png', url_private_download: 'https://files.slack.com/files-pri/T-' + id + '/photo.png' } });
      }
      if (path.startsWith('/files-pri/')) return new Response(bytes, { headers: { 'Content-Type': 'image/png' } });
      if (path === '/api/files.getUploadURLExternal') {
        assert.equal(request.headers.get('Content-Type'), 'application/x-www-form-urlencoded');
        assert.equal(new URLSearchParams(await request.text()).get('length'), String(bytes.length));
        return Response.json({ ok: true, file_id: 'copy', upload_url: 'https://files.slack.com/upload/v1/edge' });
      }
      if (path === '/upload/v1/edge') {
        assert.deepEqual(new Uint8Array(await request.arrayBuffer()), bytes);
        assert.equal(request.headers.has('Authorization'), false);
        return new Response();
      }
      if (path === '/api/files.completeUploadExternal') {
        const body = await request.json();
        assert.deepEqual(body, { files: [{ id: 'copy' }], channel_id: 'private', initial_comment: '<@dot>' });
        shared.resolve(body); return Response.json({ ok: true, files: [{ id: 'copy' }] });
      }
      if (path === '/v1/decisions') {
        const body = await request.json();
        assert.ok(body.input[0].content.some(part => part.type === 'input_image'));
        return Response.json({ answers: [{ name: 'thread', type: 'choice', choice: '123.000001', confidence: 0.97 }] }, { headers: { 'x-request-id': 'req_edge' } });
      }
      assert.equal(path, '/api/chat.postMessage');
      const body = await request.json();
      if (body.channel === 'inbox') {
        assert.equal(request.headers.get('Authorization'), 'Bearer bot-token');
        assert.deepEqual(body.blocks, blocks); returned.resolve(body);
        return Response.json({ ok: true, ts: '123.000004' });
      }
      assert.equal(request.headers.get('Authorization'), 'Bearer user-token');
      assert.deepEqual(body, { channel: 'private', text: '<@dot> この画像の続きです', thread_ts: '123.000001' });
      routed.resolve(body); return Response.json({ ok: true, ts: '123.000005' });
    },
  }));
  t.after(() => mf.dispose());
  async function send(id, event) {
    const body = JSON.stringify({ type: 'event_callback', team_id: 'team', event_id: id, event });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = 'v0=' + createHmac('sha256', 'secret').update('v0:' + timestamp + ':' + body).digest('hex');
    const response = await mf.dispatchFetch('https://bridge.test/slack', { method: 'POST', body, headers: { 'x-slack-request-timestamp': timestamp, 'x-slack-signature': signature } });
    assert.equal(response.status, 200, await response.text());
  }
  assert.equal((await mf.dispatchFetch('https://bridge.test/line')).status, 410);
  await send('dm-image', { type: 'message', channel_type: 'im', channel: 'inbox', user: 'owner', ts: '122.000001', text: '', files: [{ id: 'source' }] });
  await shared.promise;
  assert.equal(calls.filter(path => path === '/v1/decisions').length, 0);
  await send('early-reply', { type: 'message', channel: 'private', user: 'dot', ts: '123.000002', thread_ts: '123.000001', text: '画像を確認しました  続きです', blocks });
  await send('file-share', { type: 'message', channel: 'private', user: 'owner', ts: '123.000001', text: '<@dot>', files: [{ id: 'copy' }] });
  assert.deepEqual((await returned.promise).blocks, blocks);
  await send('dm-followup', { type: 'message', channel_type: 'im', channel: 'inbox', user: 'owner', ts: '124.000001', text: 'この画像の続きです' });
  assert.equal((await routed.promise).thread_ts, '123.000001');
  assert.equal(calls.filter(path => path === '/v1/decisions').length, 1);
});
