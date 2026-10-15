const encoder = new TextEncoder();
const secretNames = ['SLACK_USER_TOKEN', 'SLACK_SIGNING_SECRET', 'LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN', 'LINE_ALLOWED_USER_ID', 'SLACK_TEAM_ID', 'SLACK_CHANNEL_ID', 'DOTS_USER_ID'];

function requireText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error('Missing or invalid ' + label);
  return value;
}

async function verifySignature(request, body, env, path) {
  let signature;
  let content;
  let secret;
  if (path === '/line') {
    if (!request.headers.has('x-line-signature')) return false;
    const encoded = request.headers.get('x-line-signature');
    if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) return false;
    signature = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
    content = body;
    secret = env.LINE_CHANNEL_SECRET;
  } else {
    if (!request.headers.has('x-slack-signature') || !request.headers.has('x-slack-request-timestamp')) return false;
    const encoded = request.headers.get('x-slack-signature');
    const timestamp = request.headers.get('x-slack-request-timestamp');
    if (!/^v0=[0-9a-f]{64}$/.test(encoded) || !/^\d+$/.test(timestamp)) return false;
    if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
    signature = Uint8Array.from(encoded.slice(3).match(/../g), pair => Number.parseInt(pair, 16));
    content = 'v0:' + timestamp + ':' + body;
    secret = env.SLACK_SIGNING_SECRET;
  }
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, signature, encoder.encode(content));
}

function lineBatches(text) {
  const chunks = [];
  let chunk = '';
  for (const character of text) {
    if (chunk.length + character.length > 5000) {
      chunks.push({ type: 'text', text: chunk });
      chunk = '';
    }
    chunk += character;
  }
  if (chunk.length > 0) chunks.push({ type: 'text', text: chunk });
  const batches = [];
  for (let index = 0; index < chunks.length; index += 5) batches.push(chunks.slice(index, index + 5));
  return batches;
}

export default {
  async fetch(request, env) {
    for (const name of secretNames) requireText(env[name], name);
    const path = new URL(request.url).pathname;
    if (path === '/health' && request.method === 'GET') return Response.json({ status: 'ok' });
    if (path !== '/line' && path !== '/slack') return new Response('Not found', { status: 404 });
    if (request.method !== 'POST') return new Response('POST required', { status: 405 });
    const body = await request.text();
    if (encoder.encode(body).length > 262144) return new Response('Payload too large', { status: 413 });
    if (!await verifySignature(request, body, env, path)) return new Response('Invalid signature', { status: 401 });
    const payload = JSON.parse(body);
    if (path === '/slack' && payload.type === 'url_verification') {
      return Response.json({ challenge: requireText(payload.challenge, 'Slack challenge') });
    }
    return env.BRIDGE.getByName('personal').fetch(new Request('https://internal' + path, { method: 'POST', body }));
  }
};

export class BridgeObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, retry_key TEXT NOT NULL, status TEXT NOT NULL, error TEXT NOT NULL, created INTEGER NOT NULL)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(status, created, id)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS session (id INTEGER PRIMARY KEY CHECK(id = 1), thread TEXT NOT NULL)');
  }

  enqueue(id, kind, payload) {
    this.sql.exec("INSERT OR IGNORE INTO jobs (id, kind, payload, retry_key, status, error, created) VALUES (?, ?, ?, ?, 'queued', '', ?)", id, kind, JSON.stringify(payload), crypto.randomUUID(), Date.now());
  }

  async fetch(request) {
    const payload = await request.json();
    this.ctx.storage.transactionSync(() => {
      if (new URL(request.url).pathname === '/line') {
        if (!Array.isArray(payload.events)) throw new Error('Invalid LINE events');
        for (const event of payload.events) {
          if (event.type !== 'message' || event.source.type !== 'user' || event.source.userId !== this.env.LINE_ALLOWED_USER_ID || event.message.type !== 'text') continue;
          this.enqueue('line:' + requireText(event.webhookEventId, 'LINE webhookEventId'), 'slack', { text: requireText(event.message.text, 'LINE text') });
        }
      } else {
        if (payload.type !== 'event_callback' || payload.team_id !== this.env.SLACK_TEAM_ID) return;
        const event = payload.event;
        if (event.type !== 'message' || event.channel !== this.env.SLACK_CHANNEL_ID || event.user !== this.env.DOTS_USER_ID) return;
        if (Object.hasOwn(event, 'subtype') && event.subtype !== 'bot_message') return;
        requireText(event.thread_ts, 'Dots reply thread');
        const batches = lineBatches(requireText(event.text, 'Dots reply text'));
        for (let index = 0; index < batches.length; index++) {
          this.enqueue('slack:' + requireText(payload.event_id, 'Slack event_id') + ':' + index, 'line', { thread: event.thread_ts, messages: batches[index] });
        }
      }
    });
    const pending = this.sql.exec("SELECT id FROM jobs WHERE status = 'queued' LIMIT 1").toArray();
    if (pending.length > 0) await this.ctx.storage.setAlarm(Date.now());
    return Response.json({ ok: true });
  }

  async alarm() {
    const jobs = this.sql.exec("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created, id LIMIT 1").toArray();
    if (jobs.length === 0) return;
    const job = jobs[0];
    this.sql.exec("UPDATE jobs SET status = 'sending' WHERE id = ?", job.id);
    const [outcome] = await Promise.allSettled([this.deliver(job)]);
    if (outcome.status === 'rejected') {
      const error = String(outcome.reason);
      this.sql.exec("UPDATE jobs SET status = 'failed', error = ? WHERE id = ?", error, job.id);
      console.error(JSON.stringify({ event: 'delivery_failed', job: job.id, error }));
    } else {
      this.sql.exec("UPDATE jobs SET status = 'done' WHERE id = ?", job.id);
      console.info(JSON.stringify({ event: 'delivery_done', job: job.id }));
    }
    const pending = this.sql.exec("SELECT id FROM jobs WHERE status = 'queued' LIMIT 1").toArray();
    if (pending.length > 0) await this.ctx.storage.setAlarm(Date.now());
    // shortcut: ambiguous external delivery is retained as failed/sending; reconcile before retrying to avoid duplicate Slack posts.
    if (outcome.status === 'rejected') throw new Error('Delivery failed for ' + job.id + ': ' + String(outcome.reason));
  }

  async deliver(job) {
    const payload = JSON.parse(job.payload);
    if (job.kind === 'slack') {
      const text = payload.text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
      const body = { channel: this.env.SLACK_CHANNEL_ID, text: '<@' + this.env.DOTS_USER_ID + '> ' + text };
      const sessions = this.sql.exec('SELECT thread FROM session WHERE id = 1').toArray();
      if (sessions.length > 0) body.thread_ts = sessions[0].thread;
      const response = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST', headers: { Authorization: 'Bearer ' + this.env.SLACK_USER_TOKEN, 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error('Slack HTTP ' + response.status);
      const result = await response.json();
      if (result.ok !== true) throw new Error('Slack API ' + requireText(result.error, 'Slack error'));
      requireText(result.ts, 'Slack message timestamp');
      if (sessions.length === 0) this.sql.exec('INSERT INTO session (id, thread) VALUES (1, ?)', result.ts);
      return;
    }
    if (job.kind !== 'line') throw new Error('Unknown delivery kind');
    const sessions = this.sql.exec('SELECT thread FROM session WHERE id = 1').toArray();
    if (sessions.length === 0 || payload.thread !== sessions[0].thread) return;
    const response = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + this.env.LINE_CHANNEL_ACCESS_TOKEN, 'Content-Type': 'application/json', 'X-Line-Retry-Key': job.retry_key },
      body: JSON.stringify({ to: this.env.LINE_ALLOWED_USER_ID, messages: payload.messages }), signal: AbortSignal.timeout(15000),
    });
    if (response.status === 409 && response.headers.has('x-line-accepted-request-id')) return;
    if (!response.ok) throw new Error('LINE HTTP ' + response.status + ': ' + await response.text());
  }
}
