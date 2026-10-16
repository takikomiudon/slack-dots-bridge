function text(value, label) {
  if (typeof value !== 'string') throw new Error('Invalid Slack ' + label);
  return value;
}

function elements(value) {
  if (!Array.isArray(value) || value.length === 0) throw new Error('Invalid Slack rich text elements');
  return value;
}

function inline(element) {
  if (element.type === 'text') return text(element.text, 'text element');
  if (element.type === 'link') {
    const url = text(element.url, 'link URL');
    if (!Object.hasOwn(element, 'text') || element.text === url) return url;
    return text(element.text, 'link label') + ' (' + url + ')';
  }
  if (element.type === 'emoji') {
    if (!Object.hasOwn(element, 'unicode')) return ':' + text(element.name, 'emoji name') + ':';
    const unicode = text(element.unicode, 'emoji Unicode');
    if (!/^[0-9a-f]+(-[0-9a-f]+)*$/i.test(unicode)) throw new Error('Invalid Slack emoji Unicode');
    return String.fromCodePoint(...unicode.split('-').map(part => Number.parseInt(part, 16)));
  }
  if (element.type === 'user') return '@' + text(element.user_id, 'user mention');
  if (element.type === 'channel') return '#' + text(element.channel_id, 'channel mention');
  if (element.type === 'usergroup') return '@' + text(element.usergroup_id, 'usergroup mention');
  if (element.type === 'broadcast') return '@' + text(element.range, 'broadcast mention');
  throw new Error('Unsupported Slack rich text element: ' + element.type);
}

function rich(element) {
  if (element.type === 'rich_text_section' || element.type === 'rich_text_preformatted') return elements(element.elements).map(inline).join('');
  if (element.type === 'rich_text_quote') return elements(element.elements).map(inline).join('').split('\n').map(line => '> ' + line).join('\n');
  if (element.type === 'rich_text_list') {
    if (!['bullet', 'ordered'].includes(element.style)) throw new Error('Invalid Slack list style');
    let indent = 0;
    let offset = 0;
    if (Object.hasOwn(element, 'indent')) indent = element.indent;
    if (Object.hasOwn(element, 'offset')) offset = element.offset;
    if (!Number.isInteger(indent) || indent < 0 || indent > 8 || !Number.isInteger(offset) || offset < 0) throw new Error('Invalid Slack list numbering');
    return elements(element.elements).map((item, index) => {
      if (item.type !== 'rich_text_section') throw new Error('Invalid Slack list item');
      let marker = '・';
      if (element.style === 'ordered') marker = String(offset + index + 1) + '. ';
      return '  '.repeat(indent) + marker + rich(item);
    }).join('\n');
  }
  throw new Error('Unsupported Slack rich text section: ' + element.type);
}

export function slackText(message) {
  if (!Object.hasOwn(message, 'blocks')) return text(message.text, 'message text');
  const result = elements(message.blocks).map(block => {
    if (block.type !== 'rich_text') throw new Error('Unsupported Slack message block: ' + block.type);
    return elements(block.elements).map(rich).join('\n');
  }).join('\n\n');
  if (result.length === 0) throw new Error('Empty Slack rich text message');
  return result;
}
