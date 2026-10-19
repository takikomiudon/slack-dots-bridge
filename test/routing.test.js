import assert from 'node:assert/strict';
import test from 'node:test';
import { classify, selectionMessage } from '../src/routing.js';

const context = {
  candidates: [{ thread: '123.001', messages: [{ role: 'user', text: '映画の予定を登録して' }] }],
  lineHistory: [{ role: 'assistant', thread: '123.001', text: '登録しました' }],
  incoming: { text: 'その予定を30分早めて' },
};

test('classification chooses a supplied thread in a single isolated Decisions request', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, ...options });
    return Response.json({ answers: [{ type: 'choice', name: 'thread', choice: '123.001', confidence: 0.98 }] }, { headers: { 'x-request-id': 'req_test' } });
  });
  const result = await classify({ OPENAI_API_KEY: 'secret' }, context, [{ key: 'new-image', dataUrl: 'data:image/png;base64,iVBORw==' }]);
  assert.equal(result.target, '123.001');
  assert.equal(result.requestId, 'req_test');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/decisions');
  assert.equal(calls[0].headers.Authorization, 'Bearer secret');
  const body = JSON.parse(calls[0].body);
  assert.equal(body.model, 'gpt-6-luna');
  assert.equal(body.questions.length, 1);
  assert.equal(body.questions[0].type, 'choice');
  assert.deepEqual(body.questions[0].choices.map(c => c.value), ['123.001', 'NEW', 'CLARIFY']);
  assert.deepEqual(JSON.parse(body.input[0].content[0].text), context);
  assert.deepEqual(body.input[0].content.at(-1), { type: 'input_image', image_url: 'data:image/png;base64,iVBORw==' });
});

test('empty conversation history starts a new thread without API cost', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected API request'); });
  assert.equal((await classify({ OPENAI_API_KEY: 'secret' }, { ...context, candidates: [] }, [])).target, 'NEW');
});

test('invalid choices, refusals and malformed answers fail without guessing', async t => {
  for (const answer of [
    { type: 'choice', name: 'thread', choice: 'invented-thread', confidence: 1 },
    { type: 'refusal', name: 'thread' },
    { type: 'choice', name: 'wrong-question', choice: 'NEW', confidence: 1 },
  ]) {
    t.mock.method(globalThis, 'fetch', async () => Response.json({ answers: [answer] }, { headers: { 'x-request-id': 'req_invalid' } }));
    await assert.rejects(() => classify({ OPENAI_API_KEY: 'secret' }, context, []), /Invalid Decisions answer/);
  }
});

test('Decisions failures include status and request ID without leaking API response bodies', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { code: 'insufficient_quota', message: 'secret-body' } }, { status: 429, headers: { 'x-request-id': 'req_quota' } }));
  await assert.rejects(() => classify({ OPENAI_API_KEY: 'secret' }, context, []), error => {
    assert.match(error.message, /429.*req_quota.*insufficient_quota/);
    assert.equal(error.message.includes('secret-body'), false);
    return true;
  });
});

test('clarification uses native Slack buttons with exact job-specific values and pagination', () => {
  const choices = Array.from({ length: 12 }, (_, i) => ({ thread: '123.' + i, label: '会話' + i + '😀'.repeat(50) }));
  const menu = selectionMessage('selection-token', choices, 'どの予定のこと？', 1);
  const actionBlocks = menu.blocks.filter(block => block.type === 'actions');
  const buttons = actionBlocks.flatMap(block => block.elements);
  assert.equal(new Set(buttons.map(button => button.action_id)).size, buttons.length);
  assert.ok(actionBlocks.every(block => block.elements.length <= 5));
  for (const button of buttons) {
    assert.ok(button.text.text.length <= 75);
    assert.equal(button.text.text.isWellFormed(), true);
    assert.equal(button.action_id, 'route');
    assert.equal(new URLSearchParams(button.value).get('selection'), 'selection-token');
  }
  const targets = buttons.map(button => new URLSearchParams(button.value).get('target'));
  assert.ok(targets.includes('123.5')); assert.ok(targets.includes('NEW')); assert.ok(targets.includes('CANCEL'));
  assert.ok(buttons.some(button => new URLSearchParams(button.value).get('page') === '0'));
  assert.ok(buttons.some(button => new URLSearchParams(button.value).get('page') === '2'));
  assert.throws(() => selectionMessage('token', choices, 'text', 99), /Invalid selection page/);
});
