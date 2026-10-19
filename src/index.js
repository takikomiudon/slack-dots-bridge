import { ConversationContext } from './context.js';
import { classify, selectionMessage } from './routing.js';
import { readImage, imageEvidence } from './images.js';

const encoder = new TextEncoder();
const settings = ['SLACK_USER_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'SLACK_TEAM_ID', 'SLACK_CHANNEL_ID', 'SLACK_DM_CHANNEL_ID', 'SLACK_USER_ID', 'DOTS_USER_ID', 'OPENAI_API_KEY'];
function requireText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error('Missing or invalid ' + label);
  return value;
}
async function verifySignature(request, body, env) {
  if (!request.headers.has('x-slack-signature') || !request.headers.has('x-slack-request-timestamp')) return false;
  const encoded = request.headers.get('x-slack-signature');
  const timestamp = request.headers.get('x-slack-request-timestamp');
  if (!/^v0=[0-9a-f]{64}$/.test(encoded) || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const signature = Uint8Array.from(encoded.slice(3).match(/../g), pair => Number.parseInt(pair, 16));
  const key = await crypto.subtle.importKey('raw', encoder.encode(env.SLACK_SIGNING_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, signature, encoder.encode('v0:' + timestamp + ':' + body));
}
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/line') return new Response('LINE integration retired', { status: 410 });
    for (const name of settings) requireText(env[name], name);
    if (path === '/health' && request.method === 'GET') return Response.json({ status: 'ok' });
    if (!['/slack', '/slack/actions'].includes(path)) return new Response('Not found', { status: 404 });
    if (request.method !== 'POST') return new Response('POST required', { status: 405 });
    const body = await request.text();
    if (encoder.encode(body).length > 262144) return new Response('Payload too large', { status: 413 });
    if (!await verifySignature(request, body, env)) return new Response('Invalid signature', { status: 401 });
    let payload;
    if (path === '/slack/actions') payload = JSON.parse(requireText(new URLSearchParams(body).get('payload'), 'Slack action payload'));
    else payload = JSON.parse(body);
    if (path === '/slack' && payload.type === 'url_verification') return Response.json({ challenge: requireText(payload.challenge, 'Slack challenge') });
    return env.BRIDGE.getByName('personal').fetch(new Request('https://internal' + path, { method: 'POST', body: JSON.stringify(payload) }));
  }
};

export class BridgeObject {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env; this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, retry_key TEXT NOT NULL, status TEXT NOT NULL, error TEXT NOT NULL, created INTEGER NOT NULL)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(status, created, id)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS session (id INTEGER PRIMARY KEY CHECK(id = 1), thread TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS threads (thread TEXT PRIMARY KEY NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS pending_image_roots (file_id TEXT PRIMARY KEY NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS dm_messages (ts TEXT PRIMARY KEY NOT NULL, thread TEXT NOT NULL)');
    this.sql.exec('INSERT OR IGNORE INTO threads (thread) SELECT thread FROM session');
    this.context = new ConversationContext(this.sql, env);
    this.sql.exec("UPDATE jobs SET status = 'retired', error = 'LINE integration retired' WHERE (kind IN ('line', 'line_control') OR id LIKE 'line:%' OR id LIKE 'selection:line:%') AND status NOT IN ('done', 'failed', 'cancelled', 'retired')");
    this.sql.exec("DELETE FROM pending_image_roots WHERE file_id IN (SELECT i.file_id FROM routing_image_jobs i JOIN jobs j ON i.job = j.id WHERE j.status = 'retired')");
    this.sql.exec("DELETE FROM routing_image_jobs WHERE job IN (SELECT id FROM jobs WHERE status = 'retired')");
    for (const row of this.context.missingImports()) this.enqueue('context:' + row.thread + ':0', 'context_import', { thread: row.thread, page: 0, cursor: '' });
  }
  enqueue(id, kind, payload, status = 'queued') {
    this.sql.exec("INSERT OR IGNORE INTO jobs (id, kind, payload, retry_key, status, error, created) VALUES (?, ?, ?, ?, ?, '', ?)", id, kind, JSON.stringify(payload), crypto.randomUUID(), status, Date.now());
  }
  nextJobs() {
    return this.sql.exec("SELECT * FROM jobs WHERE status = 'queued' AND (kind != 'slack' OR NOT EXISTS (SELECT 1 FROM routing_image_jobs i JOIN jobs j ON i.job = j.id WHERE j.status IN ('sending', 'waiting_image_root'))) ORDER BY CASE WHEN kind = 'context_import' THEN 0 ELSE 1 END, created, id LIMIT 1").toArray();
  }
  registerThread(thread) {
    this.sql.exec('INSERT OR IGNORE INTO threads (thread) VALUES (?)', thread);
    this.sql.exec("UPDATE jobs SET status = 'queued' WHERE status = 'waiting_thread' AND json_extract(payload, '$.thread') = ?", thread);
  }
  mapInput(job, thread) {
    const input = JSON.parse(job.payload);
    this.sql.exec('INSERT OR IGNORE INTO dm_messages (ts, thread) VALUES (?, ?)', requireText(input.dmTs, 'inbox timestamp'), thread);
    this.context.setThread(job.id, thread);
  }
  acceptInput(payload) {
    const event = payload.event;
    if (event.channel_type !== 'im' || event.user !== this.env.SLACK_USER_ID || Object.hasOwn(event, 'bot_id')) return;
    if (Object.hasOwn(event, 'subtype') && event.subtype !== 'file_share') return;
    const input = { text: '', dmTs: requireText(event.ts, 'inbox timestamp'), files: [] };
    if (Object.hasOwn(event, 'text')) {
      if (typeof event.text !== 'string') throw new Error('Invalid inbox text');
      input.text = event.text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
    }
    if (Object.hasOwn(event, 'files')) {
      if (!Array.isArray(event.files) || event.files.length > 10) throw new Error('Invalid inbox files: maximum 10');
      for (const file of event.files) input.files.push(requireText(file.id, 'inbox file ID'));
    }
    if (input.text.length === 0 && input.files.length === 0) throw new Error('Empty inbox message');
    if (Object.hasOwn(event, 'thread_ts')) input.replyTs = requireText(event.thread_ts, 'inbox reply timestamp');
    const id = 'dm:' + requireText(payload.event_id, 'Slack event ID');
    this.enqueue(id, 'slack', input);
    this.context.recordMessage(id, 'user', '', { text: input.text, images: input.files });
  }
  acceptSelection(payload) {
    if (payload.type !== 'block_actions' || payload.team.id !== this.env.SLACK_TEAM_ID || payload.user.id !== this.env.SLACK_USER_ID || payload.channel.id !== this.env.SLACK_DM_CHANNEL_ID) return new Response('Invalid selection owner', { status: 403 });
    if (!Array.isArray(payload.actions) || payload.actions.length !== 1) throw new Error('Invalid routing action');
    const action = payload.actions[0];
    const data = new URLSearchParams(requireText(action.value, 'routing action value'));
    let expectedAction;
    if (data.has('target')) expectedAction = 'route:target:' + requireText(data.get('target'), 'selection target');
    else expectedAction = 'route:page:' + requireText(data.get('page'), 'selection page');
    if (action.action_id !== expectedAction) throw new Error('Invalid routing action ID');
    const rows = this.sql.exec('SELECT * FROM routing_selections WHERE token = ?', requireText(data.get('selection'), 'selection token')).toArray();
    if (rows.length !== 1) throw new Error('Invalid routing selection token');
    const selection = rows[0];
    const [job] = this.sql.exec('SELECT * FROM jobs WHERE id = ?', selection.job).toArray();
    if (job.status !== 'awaiting_selection') return Response.json({ ok: true });
    const choices = JSON.parse(selection.choices);
    const input = JSON.parse(job.payload);
    let preview = '画像';
    if (input.text.length > 0) preview = input.text;
    if (data.has('page') && !data.has('target')) {
      const page = requireText(data.get('page'), 'selection page');
      if (!/^\d+$/.test(page)) throw new Error('Invalid selection page');
      this.enqueue('action:' + requireText(action.action_ts, 'action timestamp'), 'dm_control', selectionMessage(selection.token, choices, preview, Number(page)));
      return Response.json({ ok: true });
    }
    const target = requireText(data.get('target'), 'selection target');
    if (!['NEW', 'CANCEL', ...choices.map(choice => choice.thread)].includes(target)) throw new Error('Invalid selection target');
    if (target === 'CANCEL') this.sql.exec("UPDATE jobs SET status = 'cancelled' WHERE id = ?", job.id);
    else {
      this.sql.exec("UPDATE routing_decisions SET target = ?, request_id = 'user-selection', confidence = 1 WHERE job = ?", target, job.id);
      this.sql.exec("UPDATE jobs SET status = 'queued' WHERE id = ?", job.id);
    }
    return Response.json({ ok: true });
  }
  acceptChannel(payload) {
    const event = payload.event;
    this.context.observe(event);
    if (Array.isArray(event.files)) for (const file of event.files) {
      const pending = this.sql.exec('SELECT job FROM routing_image_jobs WHERE file_id = ?', requireText(file.id, 'shared file ID')).toArray();
      if (pending.length === 0) continue;
      let thread = requireText(event.ts, 'image timestamp');
      if (Object.hasOwn(event, 'thread_ts')) thread = requireText(event.thread_ts, 'image thread');
      const [job] = this.sql.exec('SELECT * FROM jobs WHERE id = ?', pending[0].job).toArray();
      const [decision] = this.sql.exec('SELECT target FROM routing_decisions WHERE job = ?', job.id).toArray();
      if (decision.target !== 'NEW' && decision.target !== thread) throw new Error('Unexpected image routing thread');
      if (decision.target === 'NEW') { this.registerThread(thread); this.context.markImported(thread); }
      this.mapInput(job, thread);
      this.sql.exec('DELETE FROM routing_image_jobs WHERE file_id = ?', file.id);
      this.sql.exec('DELETE FROM pending_image_roots WHERE file_id = ?', file.id);
      if (this.sql.exec('SELECT file_id FROM routing_image_jobs WHERE job = ?', job.id).toArray().length === 0) this.sql.exec("UPDATE jobs SET status = 'done' WHERE id = ? AND status = 'waiting_image_root'", job.id);
      console.info(JSON.stringify({ event: 'image_thread_registered', job: job.id, thread }));
    }
    if (event.user !== this.env.DOTS_USER_ID) return;
    if (Object.hasOwn(event, 'subtype') && event.subtype !== 'bot_message') return;
    const thread = requireText(event.thread_ts, 'Dots thread');
    const message = { text: requireText(event.text, 'Dots reply'), thread };
    if (Object.hasOwn(event, 'blocks')) {
      if (!Array.isArray(event.blocks)) throw new Error('Invalid Dots blocks');
      message.blocks = event.blocks;
    }
    let status = 'queued';
    if (this.sql.exec('SELECT thread FROM threads WHERE thread = ?', thread).toArray().length === 0) status = 'waiting_thread';
    this.enqueue('reply:' + requireText(payload.event_id, 'Slack event ID'), 'dm', message, status);
  }
  async fetch(request) {
    const payload = await request.json();
    let response = Response.json({ ok: true });
    this.ctx.storage.transactionSync(() => {
      if (new URL(request.url).pathname === '/slack/actions') { response = this.acceptSelection(payload); return; }
      if (payload.type !== 'event_callback' || payload.team_id !== this.env.SLACK_TEAM_ID) return;
      const event = payload.event;
      if (event.type !== 'message') return;
      if (event.channel === this.env.SLACK_DM_CHANNEL_ID) this.acceptInput(payload);
      if (event.channel === this.env.SLACK_CHANNEL_ID) this.acceptChannel(payload);
    });
    if (this.nextJobs().length > 0) await this.ctx.storage.setAlarm(Date.now());
    return response;
  }
  async alarm() {
    const jobs = this.nextJobs();
    if (jobs.length === 0) return;
    const job = jobs[0];
    this.sql.exec("UPDATE jobs SET status = 'sending' WHERE id = ?", job.id);
    const [outcome] = await Promise.allSettled([this.deliver(job)]);
    if (outcome.status === 'rejected') {
      this.sql.exec("UPDATE jobs SET status = 'failed', error = ? WHERE id = ?", String(outcome.reason), job.id);
      console.error(JSON.stringify({ event: 'delivery_failed', job: job.id, error: String(outcome.reason) }));
    } else {
      let status = 'done';
      if (outcome.value === 'awaiting_selection') status = 'awaiting_selection';
      if (outcome.value === 'waiting_image_root' && this.sql.exec('SELECT file_id FROM routing_image_jobs WHERE job = ?', job.id).toArray().length > 0) status = 'waiting_image_root';
      this.sql.exec('UPDATE jobs SET status = ? WHERE id = ?', status, job.id);
      console.info(JSON.stringify({ event: 'delivery_state', job: job.id, status }));
    }
    if (this.nextJobs().length > 0) await this.ctx.storage.setAlarm(Date.now());
    // shortcut: reconcile ambiguous external failures before retrying to avoid duplicate posts.
    if (outcome.status === 'rejected') throw new Error('Delivery failed for ' + job.id + ': ' + String(outcome.reason));
  }
  async slackApi(method, body, token = this.env.SLACK_USER_TOKEN) {
    let contentType = 'application/json; charset=utf-8';
    let encoded;
    if (body instanceof URLSearchParams) { contentType = 'application/x-www-form-urlencoded'; encoded = body.toString(); }
    else encoded = JSON.stringify(body);
    const response = await fetch('https://slack.com/api/' + method, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': contentType }, body: encoded, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error('Slack ' + method + ' HTTP ' + response.status);
    const result = await response.json();
    if (result.ok !== true) throw new Error('Slack ' + method + ' API ' + requireText(result.error, 'Slack error'));
    return result;
  }
  async importContext(input) {
    const params = new URLSearchParams({ channel: this.env.SLACK_CHANNEL_ID, ts: input.thread, limit: '100' });
    if (input.cursor.length > 0) params.set('cursor', input.cursor);
    const result = await this.slackApi('conversations.replies', params);
    if (!Array.isArray(result.messages) || typeof result.has_more !== 'boolean') throw new Error('Invalid Slack conversation import');
    for (const message of result.messages) this.context.observe({ ...message, channel: this.env.SLACK_CHANNEL_ID });
    if (result.has_more) this.enqueue('context:' + input.thread + ':' + (input.page + 1), 'context_import', { thread: input.thread, page: input.page + 1, cursor: requireText(result.response_metadata.next_cursor, 'import cursor') });
    else this.context.markImported(input.thread);
  }
  async resolveRoute(job, input) {
    let target = '';
    if (Object.hasOwn(input, 'replyTs')) {
      const rows = this.sql.exec('SELECT thread FROM dm_messages WHERE ts = ?', input.replyTs).toArray();
      if (rows.length !== 1) throw new Error('Unknown inbox reply: ' + input.replyTs);
      target = rows[0].thread;
    }
    const decisions = this.sql.exec('SELECT target FROM routing_decisions WHERE job = ?', job.id).toArray();
    if (decisions.length === 1 && decisions[0].target !== 'CLARIFY') target = decisions[0].target;
    const incoming = [];
    let size = 0;
    for (const id of input.files) {
      const result = await this.slackApi('files.info', new URLSearchParams({ file: id }));
      if (result.file.id !== id) throw new Error('Unexpected inbox file ID');
      const image = await readImage(result.file.url_private_download, this.env.SLACK_USER_TOKEN, 'Slack');
      size += image.bytes.byteLength;
      if (size > 10 * 1024 * 1024) throw new Error('Inbox images exceed 10 MiB');
      incoming.push({ key: id, image });
    }
    if (target.length > 0) {
      this.sql.exec("INSERT OR IGNORE INTO routing_decisions (job, target, request_id, confidence) VALUES (?, ?, 'explicit-reply', 1)", job.id, target);
      return { target, incoming, choices: [] };
    }
    const missing = this.sql.exec('SELECT DISTINCT f.value AS id FROM routing_events e JOIN threads t ON e.thread = t.thread, json_each(e.files) f WHERE f.value NOT IN (SELECT id FROM routing_files)').toArray();
    for (const file of missing) {
      const result = await this.slackApi('files.info', new URLSearchParams({ file: file.id }));
      if (result.file.id !== file.id) throw new Error('Unexpected context file ID');
      this.context.recordFile(result.file);
    }
    const built = this.context.build(job.id, { text: input.text, images: incoming.map(image => image.key) });
    let evidence = [];
    if (built.context.candidates.length > 0) evidence = await imageEvidence(this.env, built.images, incoming);
    const result = await classify(this.env, built.context, evidence);
    this.sql.exec('INSERT INTO routing_decisions (job, target, request_id, confidence) VALUES (?, ?, ?, ?)', job.id, result.target, result.requestId, result.confidence);
    console.info(JSON.stringify({ event: 'route_selected', job: job.id, target: result.target, requestId: result.requestId, confidence: result.confidence }));
    return { target: result.target, incoming, choices: built.choices };
  }
  async deliverImages(job, body, incoming) {
    const files = [];
    for (const { key, image } of incoming) {
      const grant = await this.slackApi('files.getUploadURLExternal', new URLSearchParams({ filename: 'dm-image-' + key + '.' + image.extension, length: String(image.bytes.byteLength) }));
      const id = requireText(grant.file_id, 'upload file ID');
      const address = new URL(requireText(grant.upload_url, 'upload URL'));
      if (address.origin !== 'https://files.slack.com' || !address.pathname.startsWith('/upload/') || address.username !== '' || address.password !== '') throw new Error('Invalid Slack upload URL');
      const uploaded = await fetch(address.href, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: image.bytes, signal: AbortSignal.timeout(30000), redirect: 'manual' });
      if (uploaded.status !== 200) throw new Error('Slack image upload HTTP ' + uploaded.status);
      await uploaded.text();
      files.push({ id });
    }
    const share = { files, channel_id: body.channel, initial_comment: body.text };
    if (Object.hasOwn(body, 'thread_ts')) share.thread_ts = body.thread_ts;
    for (const file of files) this.sql.exec('INSERT INTO routing_image_jobs (file_id, job) VALUES (?, ?)', file.id, job.id);
    const shared = await this.slackApi('files.completeUploadExternal', share);
    if (!Array.isArray(shared.files) || shared.files.length !== files.length || files.some(file => !shared.files.some(item => item.id === file.id))) throw new Error('Invalid completed image files');
  }
  async deliver(job) {
    const input = JSON.parse(job.payload);
    if (job.kind === 'context_import') { await this.importContext(input); return; }
    if (job.kind === 'slack') {
      const route = await this.resolveRoute(job, input);
      if (route.target === 'CLARIFY') {
        const token = crypto.randomUUID();
        this.sql.exec('INSERT INTO routing_selections (token, job, choices) VALUES (?, ?, ?)', token, job.id, JSON.stringify(route.choices));
        let preview = '画像'; if (input.text.length > 0) preview = input.text;
        this.enqueue('selection:' + job.id, 'dm_control', selectionMessage(token, route.choices, preview, 0));
        return 'awaiting_selection';
      }
      const body = { channel: this.env.SLACK_CHANNEL_ID, text: '<@' + this.env.DOTS_USER_ID + '>' };
      if (input.text.length > 0) body.text += ' ' + input.text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
      if (route.target !== 'NEW') body.thread_ts = route.target;
      if (route.incoming.length > 0) { await this.deliverImages(job, body, route.incoming); return 'waiting_image_root'; }
      const result = await this.slackApi('chat.postMessage', body);
      let thread = requireText(result.ts, 'posted timestamp');
      if (Object.hasOwn(body, 'thread_ts')) thread = body.thread_ts;
      else { this.registerThread(thread); this.context.markImported(thread); }
      this.mapInput(job, thread);
      this.context.observe({ channel: body.channel, user: this.env.SLACK_USER_ID, ts: result.ts, thread_ts: thread, text: body.text });
      return;
    }
    if (job.kind !== 'dm' && job.kind !== 'dm_control') throw new Error('Unknown delivery kind: ' + job.kind);
    const body = { channel: this.env.SLACK_DM_CHANNEL_ID, text: requireText(input.text, 'inbox response') };
    if (Object.hasOwn(input, 'blocks')) body.blocks = input.blocks;
    const result = await this.slackApi('chat.postMessage', body, this.env.SLACK_BOT_TOKEN);
    const ts = requireText(result.ts, 'inbox response timestamp');
    if (job.kind === 'dm') {
      this.sql.exec('INSERT OR IGNORE INTO dm_messages (ts, thread) VALUES (?, ?)', ts, input.thread);
      this.context.recordMessage('sent:' + ts, 'assistant', input.thread, { text: input.text });
    }
  }
}
