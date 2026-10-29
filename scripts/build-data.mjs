import fs from 'node:fs';
import path from 'node:path';

const root = JSON.parse(fs.readFileSync('work/notion-root.json', 'utf8'));
const lines = fs.readdirSync('work').filter(n => /^notion-pages-\d+\.ndjson$/.test(n)).sort()
  .flatMap(n => fs.readFileSync(path.join('work', n), 'utf8').trim().split('\n').filter(Boolean));
const pages = new Map();
for (const line of lines) {
  const row = JSON.parse(line);
  const raw = row.result?.content?.find?.(x => x.type === 'text')?.text;
  if (!raw) continue;
  try { const p = JSON.parse(raw); pages.set(row.url.replace(/\?.*$/, ''), p); } catch {}
}

const rootText = root.text || '';
const content = rootText.match(/<content>\n([\s\S]*?)\n<\/content>/)?.[1] || '';
const items = [];
let category = '未分类';
for (const line of content.split('\n')) {
  const page = line.match(/^<page url="([^"]+)">([\s\S]*?)<\/page>$/);
  if (!page) {
    const clean = line.replace(/<[^>]+>/g, '').trim();
    if (clean) category = clean;
    continue;
  }
  const url = page[1].replace(/\?.*$/, '');
  const data = pages.get(url) || {};
  const text = data.text || '';
  const body = text.match(/<content>\n([\s\S]*?)\n<\/content>/)?.[1] || '';
  const maps = [...new Set([...body.matchAll(/https?:\/\/(?:maps\.app\.goo\.gl|www\.google\.com\/maps|goo\.gl\/maps)[^\s<)"']+/g)].map(m => m[0].replace(/&amp;/g, '&')))];
  const links = [...new Set([...body.matchAll(/https?:\/\/[^\s<)"']+/g)].map(m => m[0].replace(/&amp;/g, '&')).filter(u => !u.startsWith('notion-file-block:')))];
  const images = [...body.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(m => m[1]);
  const plain = body
    .replace(/<empty-block\/>/g, '\n').replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '').replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\*\*/g, '').replace(/#{1,6}\s*/g, '')
    .replace(/\n{3,}/g, '\n\n').trim();
  const title = data.title || page[2].replace(/<[^>]+>/g, '').trim();
  const [hint, ...rest] = title.split('‖');
  items.push({
    id: url.split('/').pop(), title, hint: hint.trim(), name: rest.join('‖').trim() || hint.trim(), category,
    description: plain, maps, links, imageRefs: images, notionUrl: data.url || `${url}?pvs=204`,
    cover: data.cover?.external?.url || data.cover?.file?.url || null,
    lastEdited: data.page_last_edited_at || null
  });
}
const out = {source:{title:root.title, url:root.url, fetchedAt:new Date().toISOString(), lastEdited:root.page_last_edited_at || null}, categories:[...new Set(items.map(x=>x.category))], items};
fs.mkdirSync('data', {recursive:true});
fs.writeFileSync('data/places.json', JSON.stringify(out, null, 2));
console.log(`Built ${items.length} items in ${out.categories.length} categories`);
