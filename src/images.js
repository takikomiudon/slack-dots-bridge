const limit = 10 * 1024 * 1024;
const extensions = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };

export async function readImage(address, token, service) {
  const url = new URL(address);
  let valid = false;
  if (service === 'Slack') valid = url.origin === 'https://files.slack.com' && url.pathname.startsWith('/files-pri/');
  if (!valid || url.username !== '' || url.password !== '') throw new Error('Invalid ' + service + ' image URL');
  const response = await fetch(url.href, { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(30000), redirect: 'manual' });
  if (response.status !== 200) throw new Error(service + ' image HTTP ' + response.status);
  if (!response.headers.has('Content-Type')) throw new Error('Missing ' + service + ' image Content-Type');
  const mime = response.headers.get('Content-Type').split(';')[0].trim();
  if (!Object.hasOwn(extensions, mime)) throw new Error('Unsupported ' + service + ' image content type: ' + mime);
  if (!response.body) throw new Error('Missing ' + service + ' image body');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error(service + ' image exceeds 10 MiB');
    }
    chunks.push(chunk.value);
  }
  if (size === 0) throw new Error('Empty ' + service + ' image');
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { bytes, mime, extension: extensions[mime] };
}

export async function imageEvidence(env, references, incoming) {
  const images = new Map();
  let size = 0;
  async function include(key, image) {
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', image.bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (images.has(hash)) { images.get(hash).key += ', ' + key; return; }
    size += image.bytes.byteLength;
    if (size > limit) throw new Error('Routing image evidence exceeds 10 MiB');
    const chunks = [];
    for (let offset = 0; offset < image.bytes.length; offset += 8192) chunks.push(String.fromCharCode(...image.bytes.subarray(offset, offset + 8192)));
    images.set(hash, { key, dataUrl: 'data:' + image.mime + ';base64,' + btoa(chunks.join('')) });
  }
  for (const item of incoming) await include(item.key, item.image);
  for (const file of references) await include(file.key, await readImage(file.url, env.SLACK_USER_TOKEN, 'Slack'));
  return [...images.values()];
}
