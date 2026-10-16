import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ConversationContext } from '../src/context.js';

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const sql = { exec(query, ...args) {
    const statement = db.prepare(query);
    let rows = [];
    if (statement.columns().length > 0) rows = statement.all(...args);
    else statement.run(...args);
    return { toArray: () => rows };
  } };
  sql.exec('CREATE TABLE threads (thread TEXT PRIMARY KEY NOT NULL)');
  const context = new ConversationContext(sql, { SLACK_USER_ID: 'owner', DOTS_USER_ID: 'dot', SLACK_CHANNEL_ID: 'private' });
  return { db, sql, context };
}

test('routing context uses only registered threads and preserves raw conversation evidence', t => {
  const { sql, context } = fixture(t);
  sql.exec("INSERT INTO threads VALUES ('100.001')");
  context.observe({ channel: 'private', user: 'owner', ts: '100.001', text: '<@dot> &lt;映画&gt; &amp; 予定' });
  context.observe({ channel: 'private', user: 'dot', ts: '100.002', thread_ts: '100.001', text: '登録しました' });
  context.observe({ channel: 'private', user: 'owner', ts: '200.001', text: '登録していない別スレッド' });
  context.markImported('100.001');
  context.recordLine('user-1', 'user', '', { text: '30分早めて' });
  const built = context.build('user-1', { text: '30分早めて' });
  assert.equal(built.context.candidates.length, 1);
  assert.equal(built.context.candidates[0].messages[0].text, '<映画> & 予定');
  assert.equal(built.context.candidates[0].messages[1].role, 'assistant');
  assert.equal(JSON.stringify(built).includes('登録していない別スレッド'), false);
});

test('LINE delivery order is separate from Slack chronology and excludes later input', t => {
  const { context } = fixture(t);
  context.recordLine('a', 'assistant', 'movie', { text: '映画の予定を登録しました' });
  context.recordLine('b', 'assistant', 'essay', { text: 'ESを添削しました' });
  context.recordLine('incoming', 'user', '', { text: 'それを直して' });
  context.recordLine('future', 'assistant', 'movie', { text: '後から届いた映画の返答' });
  const { context: built } = context.build('incoming', { text: 'それを直して' });
  assert.deepEqual(built.lineHistory.map(x => x.thread), ['movie', 'essay']);
  assert.deepEqual(built.lineHistory.map(x => x.text), ['映画の予定を登録しました', 'ESを添削しました']);
});

test('missing history import fails explicitly instead of classifying incomplete evidence', t => {
  const { sql, context } = fixture(t);
  sql.exec("INSERT INTO threads VALUES ('100.001')");
  context.recordLine('incoming', 'user', '', { text: '続き' });
  assert.throws(() => context.build('incoming', { text: '続き' }), /Conversation import incomplete.*100.001/);
});

test('image context keeps private file references without storing image bytes', t => {
  const { sql, context } = fixture(t);
  sql.exec("INSERT INTO threads VALUES ('100.001')");
  context.markImported('100.001');
  const file = { id: 'Fimage', name: 'photo.jpg', mimetype: 'image/jpeg', url_private_download: 'https://files.slack.com/files-pri/T-F/download/photo.jpg' };
  context.observe({ channel: 'private', user: 'owner', ts: '100.001', text: '<@dot>', files: [{ id: 'Fimage' }] });
  context.recordFile(file);
  context.recordLine('incoming', 'user', '', { text: 'この予定を変更して' });
  const built = context.build('incoming', { text: 'この予定を変更して' });
  assert.deepEqual(built.context.candidates[0].messages[0].images, ['Fimage']);
  assert.equal(built.images[0].key, 'Fimage');
  assert.equal(built.images[0].url.startsWith('https://files.slack.com/'), true);
  assert.equal(JSON.stringify(built.context).includes('url_private'), false);
  assert.equal(JSON.stringify(built.context).includes('base64'), false);
});
