import assert from 'node:assert/strict';
import test from 'node:test';
import { slackText } from '../src/slack-text.js';

const section = text => ({ type: 'rich_text_section', elements: [{ type: 'text', text }] });
const message = elements => ({ text: '通知用', blocks: [{ type: 'rich_text', elements }] });

test('plain Slack messages preserve existing whitespace exactly', () => {
  assert.equal(slackText({ text: '段落\n\n次の段落\n  字下げ' }), '段落\n\n次の段落\n  字下げ');
});

test('Slack lists retain item boundaries, numbering offsets and indentation', () => {
  const event = message([
    section('予定'),
    { type: 'rich_text_list', style: 'bullet', elements: [section('映画'), section('夕食')] },
    { type: 'rich_text_list', style: 'ordered', offset: 2, indent: 1, elements: [section('予約確認'), section('出発')] },
  ]);
  assert.equal(slackText(event), '予定\n・映画\n・夕食\n  3. 予約確認\n  4. 出発');
});

test('quotes, preformatted text and block boundaries remain readable in LINE', () => {
  const event = message([
    { type: 'rich_text_quote', elements: [{ type: 'text', text: '引用\n2行目' }] },
    { type: 'rich_text_preformatted', elements: [{ type: 'text', text: 'a\n  b' }] },
  ]);
  event.blocks.push({ type: 'rich_text', elements: [section('最後の段落')] });
  assert.equal(slackText(event), '> 引用\n> 2行目\na\n  b\n\n最後の段落');
});

test('links, emoji and mentions preserve their information without extra API calls', () => {
  const event = message([{ type: 'rich_text_section', elements: [
    { type: 'link', url: 'https://example.com' },
    { type: 'text', text: '\n' },
    { type: 'emoji', name: 'smile', unicode: '1f604' },
    { type: 'emoji', name: 'custom' },
    { type: 'user', user_id: 'U123' },
    { type: 'channel', channel_id: 'C123' },
    { type: 'usergroup', usergroup_id: 'S123' },
    { type: 'broadcast', range: 'here' },
  ] }]);
  assert.equal(slackText(event), 'https://example.com\n😄:custom:@U123#C123@S123@here');
});

test('invalid or unsupported rich text fails explicitly without using notification text', () => {
  for (const event of [
    { text: '通知用', blocks: [] },
    { text: '通知用', blocks: [{ type: 'unknown', elements: [] }] },
    message([{ type: 'rich_text_section', elements: [{ type: 'unknown' }] }]),
    message([{ type: 'rich_text_list', style: 'invalid', elements: [section('項目')] }]),
    message([{ type: 'rich_text_section', elements: [{ type: 'text', text: 123 }] }]),
  ]) assert.throws(() => slackText(event), /Slack/);
});
