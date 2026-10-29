import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { googleNameFromResolvedUrl, normalizePlace } from './place-taxonomy.mjs';

const token = process.env.NOTION_TOKEN;
const pageId = (process.env.NOTION_PAGE_ID || '299be1e3471d8084bf4dfaca41a024e5').replaceAll('-', '');
const googleKey = process.env.GOOGLE_MAPS_API_KEY || '';
if (!token) { console.error('NOTION_TOKEN is required'); process.exit(1); }
const headers = { authorization: `Bearer ${token}`, 'notion-version': '2022-06-28', 'content-type': 'application/json' };
const MIN_GAP = Number(process.env.NOTION_MIN_GAP_MS || 400);
const mediaDir = path.resolve('public/media');
const geoPath = path.resolve('data/geo-cache.json');
const overrides = (() => { try { return JSON.parse(fs.readFileSync(path.resolve('config/place-overrides.json'), 'utf8')); } catch { return {}; } })();
fs.mkdirSync(mediaDir, { recursive: true });
fs.mkdirSync(path.dirname(geoPath), { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let lastReq = 0;

async function notion(apiPath) {
  for (let attempt = 0; ; attempt++) {
    const gap = MIN_GAP - (Date.now() - lastReq); if (gap > 0) await sleep(gap); lastReq = Date.now();
    const response = await fetch(`https://api.notion.com/v1${apiPath}`, { headers });
    if (response.status === 429) {
      const body = await response.json().catch(() => ({}));
      const retryAfter = Number(body?.additional_data?.retry_after || response.headers.get('retry-after') || 1);
      const delay = Math.max(retryAfter, 1) * 1000 + Math.floor(Math.random() * 250);
      if (attempt < 10) { console.error(`429 rate limited; retry ${attempt + 1} in ${delay}ms`); await sleep(delay); continue; }
      throw new Error('Notion 429: rate limited after retries');
    }
    if (!response.ok) throw new Error(`Notion ${response.status}: ${await response.text()}`);
    return response.json();
  }
}
async function children(id) { let out = [], cursor = ''; do { const j = await notion(`/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`); out.push(...j.results); cursor = j.has_more ? j.next_cursor : ''; } while (cursor); return out; }
const rich = parts => (parts || []).map(t => t.plain_text || '').join('');
const richLinks = parts => (parts || []).filter(t => t.href).map(t => ({ text: t.plain_text || t.href, url: t.href }));
function blockValue(block) { return block[block.type] || {}; }
function blockText(block) { const value = blockValue(block); return rich(value.rich_text || value.caption); }
function cleanText(text) { return String(text || '').replace(/\s*<br\s*\/?\s*>\s*/gi, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(); }
function allUrls(text) { return [...new Set(text.match(/https?:\/\/[^\s<)"']+/g) || [])]; }
function extFor(type, url) { const known = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/svg+xml': '.svg' }; if (known[type]) return known[type]; const ext = path.extname(new URL(url).pathname).toLowerCase(); return /^\.(jpe?g|png|webp|gif|svg)$/.test(ext) ? ext.replace('.jpeg', '.jpg') : '.jpg'; }
async function saveImage(url, stableId) {
  try {
    const cached = fs.readdirSync(mediaDir).find(name => name.startsWith(`${stableId}-`));
    if (cached) return `/media/${cached}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 25 * 1024 * 1024) throw new Error('invalid image size');
    const ext = extFor(response.headers.get('content-type') || '', url);
    const name = `${stableId}-${createHash('sha1').update(bytes).digest('hex').slice(0, 12)}${ext}`;
    const destination = path.join(mediaDir, name);
    if (!fs.existsSync(destination)) fs.writeFileSync(destination, bytes);
    return `/media/${name}`;
  } catch (error) { console.error(`image skipped ${stableId}: ${error.message}`); return null; }
}
function semanticType(block) {
  if (/^heading_[123]$/.test(block.type)) return 'heading';
  if (block.type === 'bulleted_list_item') return 'bullet';
  if (block.type === 'numbered_list_item') return 'number';
  if (block.type === 'to_do') return 'todo';
  if (['quote', 'callout', 'code', 'divider', 'bookmark', 'embed', 'video', 'file', 'pdf'].includes(block.type)) return block.type;
  return 'paragraph';
}
async function collectBlocks(blocks, pageKey, result, depth = 0) {
  for (const block of blocks) {
    const value = blockValue(block), text = cleanText(blockText(block));
    if (block.type === 'image') {
      const remote = value.type === 'file' ? value.file?.url : value.external?.url;
      if (remote) { const src = await saveImage(remote, `${pageKey}-${block.id.replaceAll('-', '').slice(0, 12)}`); if (src) { result.images.push({ src, caption: cleanText(rich(value.caption)), alt: cleanText(rich(value.caption)) || '地点照片' }); result.blocks.push({ type: 'image', src, caption: cleanText(rich(value.caption)) }); } }
    } else if (block.type === 'bookmark' || block.type === 'embed' || block.type === 'video' || block.type === 'file' || block.type === 'pdf') {
      const url = value.url || value.external?.url || value.file?.url;
      if (url) { result.links.push({ text: text || value.caption?.[0]?.plain_text || '相关链接', url }); result.blocks.push({ type: semanticType(block), text: text || '相关链接', url, depth }); }
    } else if (block.type === 'divider') result.blocks.push({ type: 'divider' });
    else if (text) {
      const inlineLinks = richLinks(value.rich_text); result.links.push(...inlineLinks);
      result.blocks.push({ type: semanticType(block), text, depth, level: Number(block.type.at(-1)) || undefined, checked: block.type === 'to_do' ? !!value.checked : undefined, language: block.type === 'code' ? value.language : undefined, links: inlineLinks });
    }
    if (block.has_children) await collectBlocks(await children(block.id), pageKey, result, depth + 1);
  }
}
async function geocode(item, cache) {
  const cached = cache[item.id];
  if (cached?.location && cached.nameVersion === 2) return cached;
  if (cached?.location && item.maps?.[0]) {
    try {
      const resolved = await fetch(item.maps[0], { redirect: 'follow', headers: { 'user-agent': 'ChiangMaiLifePWA/1.0' }, signal: AbortSignal.timeout(15000) });
      return { ...cached, displayName: googleNameFromResolvedUrl(resolved.url) || cached.displayName || item.name, googleMapsUri: item.maps[0], nameVersion: 2, resolvedAt: new Date().toISOString() };
    } catch { return { ...cached, displayName: cached.displayName || item.name, nameVersion: 2 }; }
  }
  if (cached?.location) return cached;
  if (googleKey) {
    await sleep(200);
    const response = await fetch('https://places.googleapis.com/v1/places:searchText', { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': googleKey, 'x-goog-fieldmask': 'places.id,places.displayName,places.location,places.googleMapsUri' }, body: JSON.stringify({ textQuery: `${item.name} ${item.hint} Chiang Mai Thailand`, languageCode: 'zh-CN', regionCode: 'TH', maxResultCount: 1 }) });
    if (!response.ok) { console.error(`Google geocode ${response.status} for ${item.id}`); return null; }
    const place = (await response.json()).places?.[0]; if (!place?.location) return null;
    return { provider: 'google-places', placeId: place.id, displayName: place.displayName?.text || item.name, location: { lat: place.location.latitude, lng: place.location.longitude }, googleMapsUri: place.googleMapsUri || item.maps[0] || null, resolvedAt: new Date().toISOString() };
  }
  if (!item.maps?.[0]) return null;
  try {
    const resolved = await fetch(item.maps[0], { redirect: 'follow', headers: { 'user-agent': 'ChiangMaiLifePWA/1.0' }, signal: AbortSignal.timeout(15000) });
    const finalUrl = new URL(resolved.url);
    const coordinateMatch = decodeURIComponent(finalUrl.href).match(/@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/)
      || decodeURIComponent(finalUrl.href).match(/!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/);
    if (coordinateMatch) {
      return { provider: 'google-link', displayName: googleNameFromResolvedUrl(finalUrl.href) || item.name, location: { lat: Number(coordinateMatch[1]), lng: Number(coordinateMatch[2]) }, googleMapsUri: item.maps[0], resolvedAt: new Date().toISOString() };
    }
    const resolvedQuery = finalUrl.searchParams.get('q');
    const queries = [...new Set([`${item.name} Chiang Mai Thailand`, resolvedQuery].filter(Boolean))];
    let hit = null;
    for (const query of queries) {
      await sleep(1100);
      const search = new URL('https://nominatim.openstreetmap.org/search'); search.searchParams.set('format', 'jsonv2'); search.searchParams.set('limit', '1'); search.searchParams.set('countrycodes', 'th'); search.searchParams.set('q', query);
      const response = await fetch(search, { headers: { 'user-agent': 'ChiangMaiLifePWA/1.0 (private travel guide)' }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) { console.error(`Nominatim ${response.status} for ${item.id}`); continue; }
      hit = (await response.json())[0]; if (hit) break;
    }
    if (!hit) return null;
    return { provider: 'google-link-address', displayName: hit.display_name || item.name, location: { lat: Number(hit.lat), lng: Number(hit.lon) }, googleMapsUri: item.maps[0], resolvedAt: new Date().toISOString() };
  } catch (error) { console.error(`map location skipped ${item.id}: ${error.message}`); return null; }
}
async function pageDetails(block, category, geoCache) {
  const page = await notion(`/pages/${block.id}`), key = block.id.replaceAll('-', ''), result = { blocks: [], images: [], links: [] };
  await collectBlocks(await children(block.id), key, result);
  const title = page.properties?.title?.title ? rich(page.properties.title.title) : (block.child_page?.title || '未命名');
  const marker = result.blocks.find(x => x.type === 'paragraph' && x.text?.startsWith('🏷️ 手册标签：'))?.text || '';
  const preservedMemory = cleanText(marker.match(/🧠 原记忆词：([^\n]+)/)?.[1] || '');
  result.blocks = result.blocks.filter(x => !(x.type === 'paragraph' && x.text?.startsWith('🏷️ 手册标签：')));
  const titleParts = title.split(/\s*(?:\/\/|\|\||‖)\s*/).map(cleanText).filter(Boolean), hint = titleParts[0], name = cleanText(titleParts.length >= 3 ? titleParts.slice(1, -1).join(' ') : titleParts.slice(1).join(' ')) || cleanText(hint);
  const description = result.blocks.filter(x => ['paragraph', 'quote', 'callout'].includes(x.type)).map(x => x.text).join('\n\n');
  result.links.push(...allUrls(description).map(url => ({ text: '相关链接', url })));
  result.links = [...new Map(result.links.filter(x => /^https?:\/\//.test(x.url || '')).map(x => [x.url, x])).values()];
  const maps = result.links.filter(x => /maps\.app\.goo\.gl|google\.com\/maps|goo\.gl\/maps/.test(x.url)).map(x => x.url);
  let cover = null; const coverRemote = page.cover?.type === 'external' ? page.cover.external.url : page.cover?.file?.url; if (coverRemote) cover = await saveImage(coverRemote, `${key}-cover`);
  const item = { id: key, sourceTitle: title, title, hint: cleanText(hint), memoryKeyword: preservedMemory || cleanText(hint), name, category, description, blocks: result.blocks, images: result.images, maps, links: result.links.filter(x => !maps.includes(x.url)), cover, lastEdited: page.last_edited_time, ...(overrides[key] || {}) };
  const geo = await geocode(item, geoCache); if (geo) { geoCache[item.id] = geo; item.location = geo.location; item.placeId = geo.placeId; if (!item.suppressMap && !item.maps.length && geo.googleMapsUri) item.maps = [geo.googleMapsUri]; }
  Object.assign(item, normalizePlace(item, item.nameOverride || geo?.displayName));
  return item;
}

const page = await notion(`/pages/${pageId}`), rootBlocks = await children(pageId), geoCache = (() => { try { return JSON.parse(fs.readFileSync(geoPath, 'utf8')); } catch { return {}; } })();
let category = '未分类', items = [];
for (const block of rootBlocks) {
  if (block.type === 'child_page') { items.push(await pageDetails(block, category, geoCache)); process.stdout.write('.'); }
  else { const text = cleanText(blockText(block)); if (text) category = text; }
}
const categories = [...new Set(items.map(x => x.category))];
const out = { source: { title: rich(page.properties?.title?.title) || '泰国手册', fetchedAt: new Date().toISOString(), lastEdited: page.last_edited_time, direction: 'notion-to-website' }, categories, items };
const dataTemp = 'data/places.json.tmp', geoTemp = `${geoPath}.tmp`;
fs.writeFileSync(dataTemp, JSON.stringify(out, null, 2)); fs.renameSync(dataTemp, 'data/places.json');
fs.writeFileSync(geoTemp, JSON.stringify(geoCache, null, 2)); fs.renameSync(geoTemp, geoPath);
console.log(`\nSynced ${items.length} items in ${categories.length} categories; ${items.reduce((n, x) => n + x.images.length, 0)} images; ${items.filter(x => x.location).length} geocoded`);
