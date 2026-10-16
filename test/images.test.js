import assert from 'node:assert/strict';
import test from 'node:test';
import { readImage, imageEvidence } from '../src/images.js';

test('image evidence uses authenticated private downloads, deduplicates identical content and stays inline', async t => {
  const calls = [];
  const bytes = new Uint8Array([137, 80, 78, 71]);
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return new Response(bytes, { headers: { 'Content-Type': 'image/png' } });
  });
  const references = [{ key: 'F1', url: 'https://files.slack.com/files-pri/T-F1/photo.png' }, { key: 'F2', url: 'https://files.slack.com/files-pri/T-F2/photo.png' }];
  const images = await imageEvidence({ SLACK_USER_TOKEN: 'private-token' }, references, []);
  assert.equal(calls.length, 2);
  assert.equal(images.length, 1);
  assert.equal(images[0].key, 'F1, F2');
  assert.equal(images[0].dataUrl, 'data:image/png;base64,iVBORw==');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer private-token');
  assert.equal(calls[0].options.redirect, 'manual');
});

test('private image credentials cannot be sent to another origin or a redirected target', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('', { status: 302, headers: { Location: 'https://external.example/image' } }); });
  await assert.rejects(() => readImage('https://external.example/image', 'secret', 'Slack'), /Invalid Slack image URL/);
  assert.equal(calls, 0);
  await assert.rejects(() => readImage('https://files.slack.com/files-pri/T-F/image.jpg', 'secret', 'Slack'), /Slack image HTTP 302/);
  assert.equal(calls, 1);
});

test('new LINE image bytes can be reused for classification without downloading them twice', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected download'); });
  const images = await imageEvidence({}, [], [{ key: 'incoming', image: { bytes: new Uint8Array([1, 2, 3]), mime: 'image/jpeg' } }]);
  assert.equal(images[0].dataUrl, 'data:image/jpeg;base64,AQID');
});
