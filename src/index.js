import { ConversationContext } from './context.js';
import { classify, selectionMessage } from './routing.js';
import { readImage, imageEvidence } from './images.js';
import { slackText } from './slack-text.js';

const encoder = new TextEncoder();
const secretNames = ['SLACK_USER_TOKEN', 'SLACK_SIGNING_SECRET', 'LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN', 'LINE_ALLOWED_USER_ID', 'SLACK_TEAM_ID', 'SLACK_CHANNEL_ID', 'SLACK_USER_ID', 'DOTS_USER_ID', 'OPENAI_API_KEY'];

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
    this.sql.exec('CREATE TABLE IF NOT EXISTS threads (thread TEXT PRIMARY KEY NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS line_messages (id TEXT PRIMARY KEY NOT NULL, thread TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS pending_image_roots (file_id TEXT PRIMARY KEY NOT NULL)');
    // Keep replies to the existing conversation eligible after upgrading from the single-thread version.
    this.sql.exec('INSERT OR IGNORE INTO threads (thread) SELECT thread FROM session');
    this.context = new ConversationContext(this.sql, env);
    for (const row of this.context.missingImports()) this.enqueue('context:' + row.thread + ':0', 'context_import', { thread: row.thread, page: 0, cursor: '' });
  }

  enqueue(id, kind, payload, status = 'queued') {
    this.sql.exec("INSERT OR IGNORE INTO jobs (id, kind, payload, retry_key, status, error, created) VALUES (?, ?, ?, ?, ?, '', ?)", id, kind, JSON.stringify(payload), crypto.randomUUID(), status, Date.now());
  }

  registerThread(thread) {
    this.sql.exec('INSERT OR IGNORE INTO threads (thread) VALUES (?)', thread);
    this.sql.exec("UPDATE jobs SET status = 'queued' WHERE status = 'waiting_thread' AND json_extract(payload, '$.thread') = ?", thread);
  }

  nextJobs() {
    return this.sql.exec("SELECT * FROM jobs WHERE status = 'queued' AND (kind NOT IN ('slack', 'slack_image') OR NOT EXISTS (SELECT 1 FROM routing_image_jobs i JOIN jobs j ON i.job = j.id WHERE j.status IN ('sending', 'waiting_image_root'))) ORDER BY CASE WHEN kind = 'context_import' THEN 0 ELSE 1 END, created, id LIMIT 1").toArray();
  }

  acceptSelection(event, id) {
    const data = new URLSearchParams(requireText(event.postback.data, 'LINE postback data'));
    const rows = this.sql.exec('SELECT * FROM routing_selections WHERE token = ?', requireText(data.get('selection'), 'routing selection token')).toArray();
    if (rows.length !== 1) throw new Error('Invalid routing selection token');
    const selection = rows[0];
    const [job] = this.sql.exec('SELECT * FROM jobs WHERE id = ?', selection.job).toArray();
    if (job.status !== 'awaiting_selection') return;
    const choices = JSON.parse(selection.choices);
    const payload = JSON.parse(job.payload);
    let preview = '画像';
    if (payload.text.length > 0) preview = payload.text;
    if (data.has('page') && !data.has('target')) {
      const page = requireText(data.get('page'), 'selection page');
      if (!/^\d+$/.test(page)) throw new Error('Invalid routing selection page');
      this.enqueue(id, 'line_control', { messages: [selectionMessage(selection.token, choices, preview, Number(page))] });
      return;
    }
    const target = requireText(data.get('target'), 'routing selection target');
    if (!['NEW', 'CANCEL', ...choices.map(choice => choice.thread)].includes(target)) throw new Error('Invalid routing selection target');
    if (target === 'CANCEL') {
      this.sql.exec("UPDATE jobs SET status = 'cancelled' WHERE id = ?", job.id);
      return;
    }
    this.sql.exec("UPDATE routing_decisions SET target = ?, request_id = 'user-selection', confidence = 1 WHERE job = ?", target, job.id);
    this.sql.exec("UPDATE jobs SET status = 'queued' WHERE id = ?", job.id);
  }

  async fetch(request) {
    const payload = await request.json();
    this.ctx.storage.transactionSync(() => {
      if (new URL(request.url).pathname === '/line') {
        if (!Array.isArray(payload.events)) throw new Error('Invalid LINE events');
        for (const event of payload.events) {
          if (event.source.type !== 'user' || event.source.userId !== this.env.LINE_ALLOWED_USER_ID) continue;
          if (event.type === 'postback') {
            this.acceptSelection(event, 'line:' + requireText(event.webhookEventId, 'LINE webhookEventId'));
            continue;
          }
          if (event.type !== 'message') continue;
          let kind;
          let message;
          if (event.message.type === 'text') {
            kind = 'slack';
            message = { text: requireText(event.message.text, 'LINE text') };
          } else if (event.message.type === 'image') {
            if (event.message.contentProvider.type !== 'line') throw new Error('Unsupported LINE image content provider');
            const imageId = requireText(event.message.id, 'LINE image id');
            if (!/^\d+$/.test(imageId)) throw new Error('Invalid LINE image id');
            kind = 'slack_image';
            message = { imageId, text: '' };
          } else continue;
          if (Object.hasOwn(event.message, 'quotedMessageId')) message.quotedMessageId = requireText(event.message.quotedMessageId, 'LINE quotedMessageId');
          const id = 'line:' + requireText(event.webhookEventId, 'LINE webhookEventId');
          this.enqueue(id, kind, message);
          this.context.recordLine(id, 'user', '', message);
        }
      } else {
        if (payload.type !== 'event_callback' || payload.team_id !== this.env.SLACK_TEAM_ID) return;
        const event = payload.event;
        if (event.type !== 'message' || event.channel !== this.env.SLACK_CHANNEL_ID) return;
        this.context.observe(event);
        // File completion returns no thread timestamp; match the signed share event by the exact file ID.
        if (Array.isArray(event.files)) {
          for (const file of event.files) {
            const pending = this.sql.exec('SELECT file_id FROM pending_image_roots WHERE file_id = ?', requireText(file.id, 'Slack shared file id')).toArray();
            if (pending.length === 0) continue;
            const thread = requireText(event.ts, 'Slack image root timestamp');
            if (Object.hasOwn(event, 'thread_ts') && event.thread_ts !== thread) throw new Error('Unexpected threaded image root');
            this.registerThread(thread);
            this.context.markImported(thread);
            this.sql.exec('DELETE FROM pending_image_roots WHERE file_id = ?', file.id);
          }
          for (const file of event.files) {
            const images = this.sql.exec('SELECT job FROM routing_image_jobs WHERE file_id = ?', file.id).toArray();
            if (images.length === 0) continue;
            let thread = requireText(event.ts, 'Slack image timestamp');
            if (Object.hasOwn(event, 'thread_ts')) thread = requireText(event.thread_ts, 'Slack image thread');
            const [decision] = this.sql.exec('SELECT target FROM routing_decisions WHERE job = ?', images[0].job).toArray();
            if (decision.target !== 'NEW' && decision.target !== thread) throw new Error('Unexpected image routing thread');
            this.context.setThread(images[0].job, thread);
            this.sql.exec("UPDATE jobs SET status = 'done' WHERE id = ? AND status = 'waiting_image_root'", images[0].job);
            this.sql.exec('DELETE FROM routing_image_jobs WHERE file_id = ?', file.id);
            console.info(JSON.stringify({ event: 'image_thread_registered', job: images[0].job, thread }));
          }
        }
        if (event.user !== this.env.DOTS_USER_ID) return;
        if (Object.hasOwn(event, 'subtype') && event.subtype !== 'bot_message') return;
        requireText(event.thread_ts, 'Dots reply thread');
        let status = 'queued';
        if (this.sql.exec('SELECT thread FROM threads WHERE thread = ?', event.thread_ts).toArray().length === 0) status = 'waiting_thread';
        const batches = lineBatches(requireText(slackText(event), 'Dots reply text'));
        for (let index = 0; index < batches.length; index++) {
          this.enqueue('slack:' + requireText(payload.event_id, 'Slack event_id') + ':' + index, 'line', { thread: event.thread_ts, messages: batches[index] }, status);
        }
      }
    });
    const pending = this.nextJobs();
    if (pending.length > 0) await this.ctx.storage.setAlarm(Date.now());
    return Response.json({ ok: true });
  }

  async alarm() {
    const jobs = this.nextJobs();
    if (jobs.length === 0) return;
    const job = jobs[0];
    this.sql.exec("UPDATE jobs SET status = 'sending' WHERE id = ?", job.id);
    const [outcome] = await Promise.allSettled([this.deliver(job)]);
    if (outcome.status === 'rejected') {
      const error = String(outcome.reason);
      this.sql.exec("UPDATE jobs SET status = 'failed', error = ? WHERE id = ?", error, job.id);
      console.error(JSON.stringify({ event: 'delivery_failed', job: job.id, error }));
    } else {
      let status = 'done';
      if (outcome.value === 'awaiting_selection') status = 'awaiting_selection';
      if (outcome.value === 'waiting_image_root' && this.sql.exec('SELECT file_id FROM routing_image_jobs WHERE job = ?', job.id).toArray().length > 0) status = 'waiting_image_root';
      this.sql.exec('UPDATE jobs SET status = ? WHERE id = ?', status, job.id);
      let event = 'delivery_done';
      if (status !== 'done') event = 'routing_waiting';
      console.info(JSON.stringify({ event, job: job.id, status }));
    }
    const pending = this.nextJobs();
    if (pending.length > 0) await this.ctx.storage.setAlarm(Date.now());
    // shortcut: ambiguous external delivery is retained as failed/sending; reconcile before retrying to avoid duplicate Slack posts.
    if (outcome.status === 'rejected') throw new Error('Delivery failed for ' + job.id + ': ' + String(outcome.reason));
  }

  async slackApi(method, body) {
    let contentType = 'application/json; charset=utf-8';
    let encoded;
    if (body instanceof URLSearchParams) {
      contentType = 'application/x-www-form-urlencoded';
      encoded = body.toString();
    } else encoded = JSON.stringify(body);
    const response = await fetch('https://slack.com/api/' + method, {
      method: 'POST', headers: { Authorization: 'Bearer ' + this.env.SLACK_USER_TOKEN, 'Content-Type': contentType },
      body: encoded, signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error('Slack ' + method + ' HTTP ' + response.status);
    const result = await response.json();
    if (result.ok !== true) throw new Error('Slack ' + method + ' API ' + requireText(result.error, 'Slack error'));
    return result;
  }

  async importContext(job, payload) {
    const parameters = new URLSearchParams({ channel: this.env.SLACK_CHANNEL_ID, ts: payload.thread, limit: '100' });
    if (payload.cursor.length > 0) parameters.set('cursor', payload.cursor);
    const result = await this.slackApi('conversations.replies', parameters);
    if (!Array.isArray(result.messages) || typeof result.has_more !== 'boolean') throw new Error('Invalid Slack conversation import');
    for (const message of result.messages) this.context.observe({ ...message, channel: this.env.SLACK_CHANNEL_ID });
    if (result.has_more) {
      const cursor = requireText(result.response_metadata.next_cursor, 'Slack import cursor');
      this.enqueue('context:' + payload.thread + ':' + (payload.page + 1), 'context_import', { thread: payload.thread, page: payload.page + 1, cursor });
    } else this.context.markImported(payload.thread);
  }

  async resolveRoute(job, payload) {
    let target = '';
    if (Object.hasOwn(payload, 'quotedMessageId')) {
      const messages = this.sql.exec('SELECT thread FROM line_messages WHERE id = ?', payload.quotedMessageId).toArray();
      if (messages.length !== 1) throw new Error('Unknown LINE quoted message: ' + payload.quotedMessageId);
      target = messages[0].thread;
    }
    const decisions = this.sql.exec('SELECT target FROM routing_decisions WHERE job = ?', job.id).toArray();
    if (decisions.length === 1 && decisions[0].target !== 'CLARIFY') target = decisions[0].target;
    const incomingImages = [];
    if (job.kind === 'slack_image') incomingImages.push({ key: 'incoming-image', image: await readImage('https://api-data.line.me/v2/bot/message/' + payload.imageId + '/content', this.env.LINE_CHANNEL_ACCESS_TOKEN, 'LINE') });
    if (target.length > 0) {
      this.sql.exec("INSERT OR IGNORE INTO routing_decisions (job, target, request_id, confidence) VALUES (?, ?, 'explicit-quote', 1)", job.id, target);
      return { target, incomingImages, choices: [] };
    }
    const missingFiles = this.sql.exec('SELECT DISTINCT f.value AS id FROM routing_events e JOIN threads t ON e.thread = t.thread, json_each(e.files) f WHERE f.value NOT IN (SELECT id FROM routing_files)').toArray();
    for (const file of missingFiles) {
      const result = await this.slackApi('files.info', new URLSearchParams({ file: file.id }));
      if (result.file.id !== file.id) throw new Error('Unexpected Slack context file ID');
      this.context.recordFile(result.file);
    }
    const incoming = { text: payload.text, images: incomingImages.map(image => image.key) };
    const built = this.context.build(job.id, incoming);
    let evidence = [];
    if (built.context.candidates.length > 0) evidence = await imageEvidence(this.env, built.images, incomingImages);
    const result = await classify(this.env, built.context, evidence);
    this.sql.exec('INSERT INTO routing_decisions (job, target, request_id, confidence) VALUES (?, ?, ?, ?)', job.id, result.target, result.requestId, result.confidence);
    console.info(JSON.stringify({ event: 'route_selected', job: job.id, target: result.target, requestId: result.requestId, confidence: result.confidence }));
    return { target: result.target, incomingImages, choices: built.choices };
  }

  async deliverImage(job, payload, message, image) {
    const { bytes, extension } = image;
    const grant = await this.slackApi('files.getUploadURLExternal', new URLSearchParams({ filename: 'line-image-' + payload.imageId + '.' + extension, length: String(bytes.byteLength) }));
    const fileId = requireText(grant.file_id, 'Slack upload file id');
    const upload = new URL(requireText(grant.upload_url, 'Slack upload URL'));
    if (upload.origin !== 'https://files.slack.com' || !upload.pathname.startsWith('/upload/') || upload.username !== '' || upload.password !== '') throw new Error('Invalid Slack upload URL');
    const uploaded = await fetch(upload.href, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes,
      signal: AbortSignal.timeout(30000), redirect: 'manual',
    });
    if (uploaded.status !== 200) throw new Error('Slack image upload HTTP ' + uploaded.status);
    await uploaded.text();
    const share = { files: [{ id: fileId }], channel_id: this.env.SLACK_CHANNEL_ID, initial_comment: message.text };
    this.sql.exec('INSERT INTO routing_image_jobs (file_id, job) VALUES (?, ?)', fileId, job.id);
    if (Object.hasOwn(message, 'thread_ts')) share.thread_ts = message.thread_ts;
    else this.sql.exec('INSERT INTO pending_image_roots (file_id) VALUES (?)', fileId);
    const shared = await this.slackApi('files.completeUploadExternal', share);
    if (!Array.isArray(shared.files) || shared.files.length !== 1 || shared.files[0].id !== fileId) throw new Error('Invalid Slack completed file');
  }

  async deliver(job) {
    const payload = JSON.parse(job.payload);
    if (job.kind === 'context_import') {
      await this.importContext(job, payload);
      return;
    }
    if (job.kind === 'slack' || job.kind === 'slack_image') {
      const route = await this.resolveRoute(job, payload);
      if (route.target === 'CLARIFY') {
        const token = crypto.randomUUID();
        this.sql.exec('INSERT INTO routing_selections (token, job, choices) VALUES (?, ?, ?)', token, job.id, JSON.stringify(route.choices));
        let preview = '画像';
        if (payload.text.length > 0) preview = payload.text;
        this.enqueue('selection:' + job.id, 'line_control', { messages: [selectionMessage(token, route.choices, preview, 0)] });
        return 'awaiting_selection';
      }
      const text = payload.text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
      const body = { channel: this.env.SLACK_CHANNEL_ID, text: '<@' + this.env.DOTS_USER_ID + '>' };
      if (text.length > 0) body.text += ' ' + text;
      if (route.target !== 'NEW') body.thread_ts = route.target;
      if (job.kind === 'slack_image') {
        await this.deliverImage(job, payload, body, route.incomingImages[0].image);
        return 'waiting_image_root';
      }
      const response = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST', headers: { Authorization: 'Bearer ' + this.env.SLACK_USER_TOKEN, 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error('Slack HTTP ' + response.status);
      const result = await response.json();
      if (result.ok !== true) throw new Error('Slack API ' + requireText(result.error, 'Slack error'));
      requireText(result.ts, 'Slack message timestamp');
      let thread = result.ts;
      if (Object.hasOwn(body, 'thread_ts')) thread = body.thread_ts;
      else {
        this.registerThread(thread);
        this.context.markImported(thread);
      }
      this.context.observe({ channel: this.env.SLACK_CHANNEL_ID, user: this.env.SLACK_USER_ID, ts: result.ts, thread_ts: thread, text: body.text });
      this.context.setThread(job.id, thread);
      return;
    }
    if (job.kind !== 'line' && job.kind !== 'line_control') throw new Error('Unknown delivery kind');
    if (job.kind === 'line') {
      const threads = this.sql.exec('SELECT thread FROM threads WHERE thread = ?', payload.thread).toArray();
      if (threads.length === 0) return;
    }
    const response = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + this.env.LINE_CHANNEL_ACCESS_TOKEN, 'Content-Type': 'application/json', 'X-Line-Retry-Key': job.retry_key },
      body: JSON.stringify({ to: this.env.LINE_ALLOWED_USER_ID, messages: payload.messages }), signal: AbortSignal.timeout(15000),
    });
    const acceptedRetry = response.status === 409 && response.headers.has('x-line-accepted-request-id');
    if (!response.ok && !acceptedRetry) throw new Error('LINE HTTP ' + response.status + ': ' + await response.text());
    const result = await response.json();
    if (!Array.isArray(result.sentMessages) || result.sentMessages.length !== payload.messages.length) throw new Error('Invalid LINE sentMessages: expected one id per message');
    const ids = result.sentMessages.map(message => requireText(message.id, 'LINE sentMessages id'));
    if (job.kind === 'line') this.ctx.storage.transactionSync(() => {
      for (let index = 0; index < ids.length; index++) {
        this.sql.exec('INSERT OR IGNORE INTO line_messages (id, thread) VALUES (?, ?)', ids[index], payload.thread);
        this.context.recordLine('sent:' + ids[index], 'assistant', payload.thread, { text: payload.messages[index].text });
      }
    });
  }
}
