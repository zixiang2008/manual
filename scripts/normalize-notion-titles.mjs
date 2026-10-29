import fs from 'node:fs';
import path from 'node:path';

const token = process.env.NOTION_TOKEN;
const apply = process.argv.includes('--apply');
if (!token) throw new Error('NOTION_TOKEN is required');
const headers = { authorization: `Bearer ${token}`, 'notion-version': '2022-06-28', 'content-type': 'application/json' };
const data = JSON.parse(fs.readFileSync('data/places.json', 'utf8'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const backupDir = process.env.RUNTIME_DIR ? path.join(process.env.RUNTIME_DIR, 'notion-backups') : path.resolve('runtime/notion-backups');
fs.mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
fs.writeFileSync(path.join(backupDir, `titles-${stamp}.json`), JSON.stringify(data.items.map(({ id, sourceTitle, title, tags, memoryKeyword }) => ({ id, sourceTitle: sourceTitle || title, normalizedTitle: title, tags, memoryKeyword })), null, 2), { mode: 0o600 });

async function notion(url, options = {}) {
  await sleep(380);
  const response = await fetch(`https://api.notion.com/v1${url}`, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json().catch(() => ({}));
}

async function syncItem(item) {
  if (!apply) return;
  await notion(`/pages/${item.id}`, { method: 'PATCH', body: JSON.stringify({ properties: { title: { type: 'title', title: [{ type: 'text', text: { content: item.title } }] } } }) });
  const children = await notion(`/blocks/${item.id}/children?page_size=100`), marker = '🏷️ 手册标签：', text = `${marker}${item.tags.join('｜')}\n🧠 原记忆词：${item.memoryKeyword || '无'}`;
  const existing = children.results?.find(block => block.type === 'paragraph' && block.paragraph?.rich_text?.some(rich => rich.plain_text?.startsWith(marker)));
  if (existing) await notion(`/blocks/${existing.id}`, { method: 'PATCH', body: JSON.stringify({ paragraph: { rich_text: [{ type: 'text', text: { content: text } }] } }) });
  else await notion(`/blocks/${item.id}/children`, { method: 'PATCH', body: JSON.stringify({ children: [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: text } }] } }] }) });
}

console.log(`${apply ? 'Applying' : 'Dry run'} ${data.items.length} normalized titles`);
for (let index = 0; index < data.items.length; index++) { await syncItem(data.items[index]); if (apply) process.stdout.write(`${index + 1}/${data.items.length}\r`); }
console.log(`\n${apply ? 'Updated Notion' : 'No Notion writes'}; backup: ${backupDir}`);
