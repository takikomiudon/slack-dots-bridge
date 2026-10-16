const imageTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

function text(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error('Invalid context ' + label);
  return value;
}

export class ConversationContext {
  constructor(sql, env) {
    this.sql = sql;
    this.env = env;
    sql.exec('CREATE TABLE IF NOT EXISTS routing_events (id TEXT PRIMARY KEY NOT NULL, thread TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, files TEXT NOT NULL)');
    sql.exec('CREATE INDEX IF NOT EXISTS routing_events_thread ON routing_events(thread, id)');
    sql.exec('CREATE TABLE IF NOT EXISTS routing_imports (thread TEXT PRIMARY KEY NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS routing_files (id TEXT PRIMARY KEY NOT NULL, mime TEXT NOT NULL, url TEXT NOT NULL, name TEXT NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS routing_line (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, role TEXT NOT NULL, thread TEXT NOT NULL, content TEXT NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS routing_decisions (job TEXT PRIMARY KEY NOT NULL, target TEXT NOT NULL, request_id TEXT NOT NULL, confidence REAL NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS routing_selections (token TEXT PRIMARY KEY NOT NULL, job TEXT UNIQUE NOT NULL, choices TEXT NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS routing_image_jobs (file_id TEXT PRIMARY KEY NOT NULL, job TEXT NOT NULL)');
  }

  observe(event) {
    if (event.channel !== this.env.SLACK_CHANNEL_ID || ![this.env.SLACK_USER_ID, this.env.DOTS_USER_ID].includes(event.user)) return [];
    if (Object.hasOwn(event, 'subtype') && !['bot_message', 'file_share'].includes(event.subtype)) return [];
    const id = text(event.ts, 'Slack timestamp');
    let thread = id;
    if (Object.hasOwn(event, 'thread_ts')) thread = text(event.thread_ts, 'Slack thread');
    let role = 'user';
    if (event.user === this.env.DOTS_USER_ID) role = 'assistant';
    let body = '';
    if (Object.hasOwn(event, 'text')) {
      if (typeof event.text !== 'string') throw new Error('Invalid context Slack text');
      body = event.text;
    }
    if (role === 'user') {
      const mention = '<@' + this.env.DOTS_USER_ID + '>';
      if (body.startsWith(mention)) body = body.slice(mention.length).replace(/^ /, '');
      body = body.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
    }
    const files = [];
    if (Array.isArray(event.files)) for (const file of event.files) files.push(text(file.id, 'file ID'));
    this.sql.exec('INSERT OR IGNORE INTO routing_events (id, thread, role, text, files) VALUES (?, ?, ?, ?, ?)', id, thread, role, body, JSON.stringify(files));
    return files;
  }

  recordFile(file) {
    this.sql.exec('INSERT OR IGNORE INTO routing_files (id, mime, url, name) VALUES (?, ?, ?, ?)', text(file.id, 'file ID'), text(file.mimetype, 'file MIME'), text(file.url_private_download, 'private file URL'), text(file.name, 'file name'));
  }

  markImported(thread) {
    this.sql.exec('INSERT OR IGNORE INTO routing_imports (thread) VALUES (?)', thread);
  }

  recordLine(id, role, thread, content) {
    this.sql.exec('INSERT OR IGNORE INTO routing_line (id, role, thread, content) VALUES (?, ?, ?, ?)', id, role, thread, JSON.stringify(content));
  }

  setThread(id, thread) {
    this.sql.exec('UPDATE routing_line SET thread = ? WHERE id = ?', thread, id);
  }

  missingImports() {
    return this.sql.exec('SELECT thread FROM threads WHERE thread NOT IN (SELECT thread FROM routing_imports) ORDER BY thread').toArray();
  }

  build(id, incoming) {
    const missing = this.missingImports();
    if (missing.length > 0) throw new Error('Conversation import incomplete: ' + missing.map(row => row.thread).join(', '));
    const current = this.sql.exec('SELECT sequence FROM routing_line WHERE id = ?', id).toArray();
    if (current.length !== 1) throw new Error('Missing LINE receive order: ' + id);
    const threads = this.sql.exec('SELECT thread FROM threads ORDER BY thread').toArray();
    const candidates = threads.map(row => ({ thread: row.thread, messages: [] }));
    const byThread = new Map(candidates.map(candidate => [candidate.thread, candidate]));
    const images = new Map();
    const files = new Map(this.sql.exec('SELECT * FROM routing_files').toArray().map(file => [file.id, file]));
    for (const event of this.sql.exec('SELECT e.* FROM routing_events e JOIN threads t ON e.thread = t.thread ORDER BY e.id').toArray()) {
      const message = { role: event.role, text: event.text, images: [] };
      for (const fileId of JSON.parse(event.files)) {
        if (!files.has(fileId)) throw new Error('File metadata import incomplete: ' + fileId);
        const file = files.get(fileId);
        if (imageTypes.has(file.mime)) {
          message.images.push(fileId);
          images.set(fileId, { key: fileId, url: file.url });
        }
      }
      byThread.get(event.thread).messages.push(message);
    }
    const lineHistory = this.sql.exec('SELECT role, thread, content FROM routing_line WHERE sequence < ? ORDER BY sequence', current[0].sequence).toArray().map(row => ({ role: row.role, thread: row.thread, ...JSON.parse(row.content) }));
    const choices = candidates.map((candidate, index) => {
      let label = String(index + 1) + '. 会話 ' + candidate.thread;
      if (candidate.messages.length > 0 && candidate.messages[0].text.length > 0) label = String(index + 1) + '. ' + candidate.messages[0].text;
      return { thread: candidate.thread, label };
    });
    return { context: { candidates, lineHistory, incoming }, images: [...images.values()], choices };
  }
}
