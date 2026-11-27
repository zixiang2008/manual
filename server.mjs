import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
const secret = process.env.SESSION_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'dev-only-change-me');
if (!secret) throw new Error('SESSION_SECRET is required in production');
const runtimeDir = process.env.RUNTIME_DIR || path.join(root, 'runtime');
const usersPath = path.join(runtimeDir, 'users.json');
const codesPath = path.join(runtimeDir, 'registration-codes.json');
const contributionsPath = path.join(runtimeDir, 'place-contributions.json');
const placeOverridesPath = path.join(runtimeDir, 'place-overrides.json');
const botSettingsPath = path.join(runtimeDir, 'bot-settings.json');
const communityMediaDir = path.join(runtimeDir, 'community-media');
const auditPath = process.env.AUDIT_LOG || path.join(runtimeDir, 'login-audit.ndjson');
const googleMapsKey = process.env.GOOGLE_MAPS_API_KEY || '';
// 外部导入令牌（小红书文案转收藏等自动化）。未配置时该端点禁用，安全默认。
const importToken = process.env.IMPORT_TOKEN || '';
fs.mkdirSync(runtimeDir, { recursive: true });
fs.mkdirSync(communityMediaDir, { recursive: true });
const attempts = new Map();
const revoked = new Set();
initializeStore();

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, value) { const temp = `${file}.${process.pid}.tmp`; fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 }); fs.renameSync(temp, file); }
function configuredUsers() { const raw = process.env.PIN_USERS_JSON || fs.readFileSync(path.join(root, 'config', 'users.example.json'), 'utf8'); return JSON.parse(raw); }
function initializeStore() { const now = new Date().toISOString(); const existing = readJson(usersPath, []); const byId = new Map(existing.map(u => [u.id, u])); for (const user of configuredUsers()) if (!byId.has(user.id)) byId.set(user.id, { ...user, status: user.status || 'active', createdAt: now, source: 'configured', stars: 0 }); writeJson(usersPath, [...byId.values()]); if (!fs.existsSync(codesPath)) writeJson(codesPath, []); if (!fs.existsSync(contributionsPath)) writeJson(contributionsPath, []); if (!fs.existsSync(placeOverridesPath)) writeJson(placeOverridesPath, {}); if (!fs.existsSync(botSettingsPath)) writeJson(botSettingsPath, { token: '', source: 'none', createdAt: null, updatedAt: null, lastImportAt: null }); }
function users() { return readJson(usersPath, []); }
function findUser(id) { return users().find(u => u.id === id); }
function publicUser(u) { return { id: u.id, name: u.name, admin: !!u.admin, coAdmin: !!u.coAdmin, stars: Number(u.stars || 0), status: u.status || 'active', createdAt: u.createdAt || null, lastLoginAt: u.lastLoginAt || null }; }
function json(res, status, data, headers = {}) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers }); res.end(JSON.stringify(data)); }
function readBody(req, maxBytes = 20000) { return new Promise((resolve, reject) => { let b = '', failed = false; req.on('data', c => { if (failed) return; b += c; if (Buffer.byteLength(b) > maxBytes) { failed = true; reject(new Error('上传内容过大')); req.destroy(); } }); req.on('end', () => { if (failed) return; try { resolve(JSON.parse(b || '{}')); } catch { reject(new Error('bad_json')); } }); req.on('error', reject); }); }
function ip(req) { return String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim().slice(0, 80); }
function sign(value) { return createHmac('sha256', secret).update(value).digest('base64url'); }
/* v25 public share tokens: signed, permanent, revocable by rotating SESSION_SECRET. Payload carries no private data. */
function shareToken(placeId) { const p = Buffer.from(JSON.stringify({ id: placeId, v: 1, n: randomBytes(6).toString('hex') })).toString('base64url'); return `${p}.${sign(`share:${p}`)}`; }
function verifyShareToken(token) { try { const [p, s] = String(token || '').split('.'); if (!p || !s) return null; const expected = Buffer.from(sign(`share:${p}`)), actual = Buffer.from(s); if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null; const d = JSON.parse(Buffer.from(p, 'base64url')); return d.v === 1 && typeof d.id === 'string' && d.id.length <= 64 ? d.id : null; } catch { return null; } }
function escHtml(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function safeHttpUrl(value) { try { const u = new URL(String(value)); return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : ''; } catch { return ''; } }
function allPlaces() { const guide = readJson(path.join(root, 'data', 'places.json'), { items: [] }), community = readJson(contributionsPath, []).filter(x => x.status !== 'removed').map(contributionItem), overrides = readJson(placeOverridesPath, {}); return [...community, ...guide.items].map(item => applyPlaceOverride(item, overrides[item.id])); }
/* Whitelist for public share: NEVER expose blocks, tags, memoryKeyword, description, contributor or notes. */
function sharePublicPlace(item) { const cache = readJson(path.join(root, 'data', 'google-maps-cache.json'), { items: {} }).items?.[item.id] || {}, c = item.contact || {}; const name = item.displayName || item.name || item.title || '清迈好地方'; const address = String(cache.address || '').slice(0, 240), phone = String(c.phone || cache.phone || '').slice(0, 40), website = safeHttpUrl(c.website || cache.website || ''); const hours = (c.openingHours?.length ? c.openingHours : cache.openingHours || []).slice(0, 14).map(line => String(line).slice(0, 120)); const own = [{ src: item.cover }, ...(item.images || [])].filter(x => x.src).map(x => x.src); const photos = [...new Set([...own, ...(cache.photos || [])])]; const remotelyVisible = photos.filter(src => /^https:\/\//.test(src)), locallyStored = photos.filter(src => String(src).startsWith('/media/')); return { name, address, phone, website, hours, photos: [...remotelyVisible, ...locallyStored].slice(0, 6), maps: safeHttpUrl(item.maps?.[0] || cache.googleMapsUrl || ''), category: String(item.detailCategory || item.category || '').slice(0, 40) }; }
function sharePageHtml(place, token, origin) {
  const shareUrl = `${origin}/s/${token}`, ogImage = place.photos.length ? `${origin}/s/${token}/photo/0` : `${origin}/icon.svg`;
  const hours = place.hours.map(line => `<li>${escHtml(line)}</li>`).join('');
  const addressLink = place.maps || (place.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${place.name} ${place.address}`)}` : '');
  const tel = place.phone.replace(/[^\d+]/g, '').slice(0, 20);
  const hostname = (() => { try { return new URL(place.website).hostname; } catch { return place.website; } })();
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${escHtml(place.name)} · 清迈生活手册</title><meta name="description" content="${escHtml(`${place.name}${place.address ? ' · ' + place.address : ''}${place.hours.length ? ' · 营业时间 ' + place.hours.join(' / ') : ''}`)}"><meta property="og:type" content="place"><meta property="og:title" content="${escHtml(place.name)} · 清迈生活手册"><meta property="og:description" content="${escHtml(`${place.address || '清迈好地方'}${place.hours.length ? ' · 营业时间 ' + place.hours[0] : ''}`)}"><meta property="og:image" content="${escHtml(ogImage)}"><meta property="og:url" content="${escHtml(shareUrl)}"><meta name="twitter:card" content="summary_large_image"><link rel="icon" href="/icon.svg" type="image/svg+xml"><style>*{box-sizing:border-box}body{margin:0;background:#f5f1e8;color:#17352f;font-family:Inter,"Noto Sans SC",system-ui,-apple-system,sans-serif}.wrap{max-width:680px;margin:auto;padding:24px 18px calc(40px + env(safe-area-inset-bottom))}.brand{font-size:.68rem;letter-spacing:.16em;font-weight:800;color:#dc6f43;margin:0 0 18px}h1{font:700 clamp(1.8rem,7vw,2.6rem)/1.18 Georgia,"Noto Serif SC",serif;margin:8px 0 10px}.chip{display:inline-block;background:#dfece3;color:#1f4f43;border-radius:99px;padding:5px 10px;font-size:.7rem;font-weight:800}.hero{width:100%;max-height:340px;object-fit:cover;border-radius:18px;margin:18px 0;box-shadow:0 12px 34px rgba(30,55,45,.12)}.facts{display:grid;gap:9px;margin:22px 0}.fact{display:grid;gap:6px;background:#fffdf8;border:1px solid #ddd8cc;border-radius:15px;padding:14px 15px;text-decoration:none;color:inherit}.fact.wide{grid-column:1/-1}.fact>span{font-size:.67rem;font-weight:800;color:#dc6f43;letter-spacing:.05em}.fact strong,.fact a{font-size:.88rem;line-height:1.55;color:#17352f;overflow-wrap:anywhere}.fact ul{margin:2px 0 0;padding:0;list-style:none;display:grid;gap:5px;font-size:.82rem;line-height:1.5}.gallery{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:20px 0}.gallery img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:13px;background:#ece8df}.actions{display:grid;gap:9px;margin-top:24px}.actions a{display:block;text-align:center;text-decoration:none;border-radius:14px;padding:14px;font-size:.85rem;font-weight:800}.actions .primary{background:#1f4f43;color:#fff}.actions .secondary{background:transparent;color:#1f4f43;border:1px solid #1f4f43}footer{margin-top:28px;padding-top:16px;border-top:1px solid #ddd8cc;text-align:center;color:#6e7771;font-size:.66rem;line-height:1.8}</style></head><body><main class="wrap"><p class="brand">CHIANG MAI · 财绅的清迈生活手册</p><h1>${escHtml(place.name)}</h1>${place.category ? `<span class="chip">${escHtml(place.category)}</span>` : ''}${place.photos.length ? `<img class="hero" src="/s/${token}/photo/0" alt="${escHtml(place.name)}" referrerpolicy="no-referrer">` : ''}<section class="facts">${place.address ? `<a class="fact" href="${escHtml(addressLink)}" target="_blank" rel="noreferrer"><span>地址 · ADDRESS</span><strong>${escHtml(place.address)} ↗</strong></a>` : ''}${place.phone ? `<a class="fact" href="tel:${escHtml(tel)}"><span>电话 · PHONE</span><strong>${escHtml(place.phone)}</strong></a>` : ''}${place.hours.length ? `<div class="fact wide"><span>营业时间 · OPENING HOURS</span><ul>${hours}</ul></div>` : ''}${place.website ? `<a class="fact" href="${escHtml(place.website)}" target="_blank" rel="noreferrer"><span>官网 / 预订 · WEBSITE</span><strong>${escHtml(hostname)} ↗</strong></a>` : ''}</section>${place.photos.length > 1 ? `<section class="gallery">${place.photos.slice(1).map((_, i) => `<img src="/s/${token}/photo/${i + 1}" alt="${escHtml(place.name)}" loading="lazy" referrerpolicy="no-referrer">`).join('')}</section>` : ''}<div class="actions">${place.maps ? `<a class="primary" href="${escHtml(place.maps)}" target="_blank" rel="noreferrer">在 Google 地图打开</a>` : ''}<a class="secondary" href="/">打开清迈生活手册（完整版需授权）</a></div><footer>清迈生活手册 · v25 · 公开信息 / 无需登录<br>信息来自 Google Maps 与财绅手册 · 仅展示关键公开信息</footer></main></body></html>`;
}
function clearCookie() { return 'cm_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'; }
function createSession(userId) { const p = Buffer.from(JSON.stringify({ u: userId, j: randomBytes(12).toString('hex'), e: Date.now() + 30 * 864e5 })).toString('base64url'); return `${p}.${sign(p)}`; }
function session(req) { const token = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('cm_session='))?.slice(11); if (!token) return null; const [p, s] = token.split('.'); if (!p || !s) return null; const expected = Buffer.from(sign(p)), actual = Buffer.from(s); if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null; try { const d = JSON.parse(Buffer.from(p, 'base64url')); const account = findUser(d.u); return d.e > Date.now() && !revoked.has(d.j) && account && account.status !== 'disabled' ? { ...d, account } : null; } catch { return null; } }
function hashSecret(value) { const salt = randomBytes(16); return `scrypt:${salt.toString('hex')}:${scryptSync(value, salt, 64).toString('hex')}`; }
function verifySecret(value, encoded) { try { const [, salt, hash] = encoded.split(':'); const got = scryptSync(value, Buffer.from(salt, 'hex'), 64), expected = Buffer.from(hash, 'hex'); return got.length === expected.length && timingSafeEqual(got, expected); } catch { return false; } }
function encryptCode(value) { const iv = randomBytes(12), key = createHash('sha256').update(secret).digest(), cipher = createCipheriv('aes-256-gcm', key, iv), encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return `gcm:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${encrypted.toString('base64url')}`; }
function decryptCode(encoded) { try { const [version, iv, tag, encrypted] = String(encoded || '').split(':'); if (version !== 'gcm') return null; const decipher = createDecipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), Buffer.from(iv, 'base64url')); decipher.setAuthTag(Buffer.from(tag, 'base64url')); return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8'); } catch { return null; } }
function pick(list) { return list[randomBytes(2).readUInt16BE() % list.length]; }
function memorableCode(style) { if (style === 'en') { const consonants = 'BCDFGHJKLMNPRSTVWZ', vowels = 'AEIOU'; return Array.from({ length: 3 }, () => pick(consonants) + pick(vowels)).join(''); } const names = ['财神', '清迈', '兰纳', '椰风', '象城', '星河', '暖阳', '咖啡', '稻香', '月光']; return `${pick(names)}${100 + randomBytes(2).readUInt16BE() % 900}`; }
function audit(event, req, extra = {}) { fs.appendFileSync(auditPath, JSON.stringify({ at: new Date().toISOString(), event, ip: ip(req), ua: String(req.headers['user-agent'] || '').slice(0, 240), ...extra }) + '\n', { mode: 0o600 }); }
function auditRows(limit = 300) { try { return fs.readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean).slice(-limit).reverse().map(x => JSON.parse(x)); } catch { return []; } }
function rateKey(req, user) { return `${ip(req)}:${user || '-'}`; }
function rateCheck(key) { const now = Date.now(); let a = attempts.get(key) || { n: 0, from: now, blocked: 0 }; if (now - a.from > 15 * 60e3) a = { n: 0, from: now, blocked: 0 }; if (a.blocked > now) return { ok: false, retry: Math.ceil((a.blocked - now) / 1000) }; return { ok: true, a }; }
function rateFail(key, a) { a.n++; if (a.n >= 5) a.blocked = Date.now() + Math.min(30 * 60e3, 30000 * 2 ** (a.n - 5)); attempts.set(key, a); }
function setLastLogin(id) { const list = users(), u = list.find(x => x.id === id); if (u) { u.lastLoginAt = new Date().toISOString(); writeJson(usersPath, list); } }
function originOkay(req) { const origin = req.headers.origin; if (!origin) return true; try { return new URL(origin).host === req.headers.host; } catch { return false; } }
function requireAuth(req, res, admin = false) { const s = session(req); if (!s) { json(res, 401, { error: '请重新登录' }); return null; } if (admin && !s.account.admin) { json(res, 403, { error: '仅管理员可操作' }); return null; } return s; }
function requireEditor(req, res) { const s = requireAuth(req, res); if (!s) return null; if (!s.account.admin && !s.account.coAdmin) { json(res, 403, { error: '仅管理员和联合管理员可编辑' }); return null; } return s; }
function loginCookie(token) { return `cm_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`; }
function characterCount(value) { return Array.from(String(value || '').trim()).length; }
function normalizeMapsUrl(value) { try { const url = new URL(String(value || '').trim()); const host = url.hostname.toLowerCase().replace(/^www\./, ''); const allowed = host === 'maps.app.goo.gl' || host === 'goo.gl' || host === 'google.com' || host.endsWith('.google.com'); if (!allowed || (!url.pathname.includes('/maps') && host !== 'maps.app.goo.gl' && host !== 'goo.gl')) return null; url.hash = ''; ['utm_source', 'utm_medium', 'utm_campaign', 'g_st', 'entry'].forEach(key => url.searchParams.delete(key)); return url.toString(); } catch { return null; } }
function placeNameFromMapsUrl(value) { try { const url = new URL(value), decoded = decodeURIComponent(url.pathname.replaceAll('+', ' ')), match = decoded.match(/\/place\/([^/]+)/); if (match) return match[1].trim().slice(0, 120); return String(url.searchParams.get('query') || url.searchParams.get('q') || '').trim().slice(0, 120); } catch { return ''; } }
function mapsUrlCoordinates(value) { try { const match = new URL(value).pathname.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/); if (!match) return null; const lat = Number(match[1]), lng = Number(match[2]); return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null; } catch { return null; } }
async function resolveMapsPlaceName(mapsUrl, fallback = '') { const direct = placeNameFromMapsUrl(mapsUrl); if (direct) return direct; try { const response = await fetch(mapsUrl, { redirect: 'follow', signal: AbortSignal.timeout(6000), headers: { 'user-agent': 'Mozilla/5.0 (compatible; ChiangMaiLifeBot/1.0)' } }); return placeNameFromMapsUrl(response.url || mapsUrl) || fallback; } catch { return fallback; } }
function botSettings() { return readJson(botSettingsPath, { token: '', source: 'none', createdAt: null, updatedAt: null, lastImportAt: null }); }
function botToken() { return String(botSettings().token || importToken || '').trim(); }
function botTokenSource() { return botSettings().token ? 'runtime' : importToken ? 'env' : 'none'; }
function maskToken(value) { const text = String(value || ''); return text.length <= 8 ? (text ? '••••' : '') : `${text.slice(0, 4)}…${text.slice(-4)}`; }
function tokenEqual(a, b) { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && x.length > 0 && timingSafeEqual(x, y); }
function requireBotToken(req, res) { const configured = botToken(), supplied = (String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i) || [])[1] || String(req.headers['x-bot-token'] || '').trim(); if (!configured || !tokenEqual(configured, supplied)) { json(res, 401, { error: 'Bot 令牌无效或未配置' }); return false; } return true; }
function botOverview() { const settings = botSettings(), configured = botToken(); const rows = readJson(contributionsPath, []).filter(x => x.imported || x.provider === 'bot').slice(-20).reverse().map(x => ({ id: `community-${x.id}`, placeName: x.placeName, reasonTag: x.reasonTag, category: x.category, createdAt: x.createdAt, sourceUrl: x.sourceUrl || '', externalId: x.externalId || '' })); return { configured: !!configured, source: botTokenSource(), token: configured, tokenMasked: maskToken(configured), endpoint: '/api/bot/places', legacyEndpoint: '/api/import/place', statusEndpoint: '/api/bot/status', authHeaders: ['Authorization: Bearer <token>', 'X-Bot-Token: <token>'], requiredFields: ['mapsUrl', 'title 或 description'], optionalFields: ['placeName', 'address', 'reasonTag', 'category', 'photos', 'sourceUrl', 'externalId'], duplicatePolicy: '同一 mapsUrl 或 externalId 返回 409 并附带已存在地点', createdAt: settings.createdAt || null, updatedAt: settings.updatedAt || null, lastImportAt: settings.lastImportAt || null, recentImports: rows }; }
function contributionItem(row) { const name = String(row.placeName || row.reasonTag || '朋友推荐').slice(0, 120), reason = String(row.reasonTag || '').slice(0, 60), searchText = [name, reason, row.category, row.address, row.description, row.sourceUrl, row.externalId].filter(Boolean).join(' '); return { id: `community-${row.id}`, title: name, name, displayName: name, memoryKeyword: reason, hint: row.description || reason, description: row.description || `朋友推荐：${reason}`, category: row.category, detailCategory: row.category, tags: [...new Set([reason, row.category].filter(Boolean))], cover: row.photos?.[0] || null, images: (row.photos || []).slice(1).map(src => ({ src, caption: '朋友分享照片' })), maps: [row.mapsUrl], links: [], blocks: row.description ? [{ type: 'paragraph', text: row.description }] : [], community: true, location: row.location || mapsUrlCoordinates(row.mapsUrl), address: row.address || '', sourceUrl: row.sourceUrl || '', externalId: row.externalId || '', imported: !!row.imported, provider: row.provider || (row.imported ? 'bot' : ''), searchText, contributedAt: row.createdAt, contributor: row.showSharer ? { name: row.sharerName } : null }; }
async function importBotPlace(req, res, b) {
  const mapsUrl = normalizeMapsUrl(b.mapsUrl || b.maps || b.googleMapsUrl), sourceUrl = safeHttpUrl(b.sourceUrl || b.url || '');
  const rawTitle = String(b.title || b.placeName || '').trim(), rawDesc = String(b.description || b.content || b.text || '').trim();
  const reasonTag = (String(b.reasonTag || b.tag || '').trim() || rawTitle || rawDesc).slice(0, 60);
  const category = String(b.category || '推荐').trim().slice(0, 40) || '推荐';
  const externalId = String(b.externalId || b.id || '').trim().slice(0, 120);
  const address = String(b.address || '').trim().slice(0, 240);
  const photos = (Array.isArray(b.photos) ? b.photos : []).map(x => safeHttpUrl(x)).filter(Boolean).slice(0, 6);
  if (!mapsUrl) return json(res, 400, { error: '请提供有效的 Google 地图链接（mapsUrl）' });
  if (!rawTitle && !rawDesc) return json(res, 400, { error: '请提供文案标题或描述（title / description）' });
  const rows = readJson(contributionsPath, []), guide = readJson(path.join(root, 'data', 'places.json'), { items: [] });
  const byExternal = externalId ? rows.find(x => x.status !== 'removed' && x.externalId === externalId) : null;
  const byMaps = rows.find(x => x.status !== 'removed' && normalizeMapsUrl(x.mapsUrl) === mapsUrl);
  const inGuide = guide.items.find(x => (x.maps || []).some(link => normalizeMapsUrl(link) === mapsUrl));
  if (byExternal || byMaps || inGuide) {
    audit('bot_import_duplicate', req, { externalId, mapsUrl });
    return json(res, 409, { error: '这个地点已经收藏，不会重复导入', item: byExternal || byMaps ? contributionItem(byExternal || byMaps) : inGuide });
  }
  const id = randomBytes(8).toString('hex'), now = new Date().toISOString(), placeName = String(b.placeName || rawTitle || await resolveMapsPlaceName(mapsUrl, '') || reasonTag).slice(0, 120);
  const description = [rawDesc || rawTitle, address ? `地址：${address}` : '', sourceUrl ? `原文：${sourceUrl}` : ''].filter(Boolean).join('\n\n');
  const row = { id, mapsUrl, placeName, address, location: mapsUrlCoordinates(mapsUrl), reasonTag, category, description, showSharer: false, sharerId: 'bot', sharerName: 'MausBot 自动导入', photos, sourceUrl, externalId, status: 'active', createdAt: now, imported: true, provider: 'bot', botName: String(b.botName || 'MausBot').slice(0, 60) };
  rows.push(row); writeJson(contributionsPath, rows);
  const settings = botSettings(); settings.lastImportAt = now; settings.updatedAt = now; writeJson(botSettingsPath, settings);
  audit('bot_place_added', req, { contributionId: id, externalId, category, source: !!sourceUrl });
  return json(res, 201, { ok: true, duplicate: false, importId: `community-${id}`, item: contributionItem(row) });
}
function applyPlaceOverride(item, override) { if (!override) return item; const title = override.displayName || item.displayName || item.name || item.title, photos = override.photos || []; return { ...item, displayName: title, title, name: override.name || item.name, memoryKeyword: override.memoryKeyword || item.memoryKeyword, category: override.category || item.category, detailCategory: override.category || item.detailCategory, tags: override.tags?.length ? override.tags : item.tags, description: override.description || item.description, hint: override.description || item.hint, blocks: override.description ? [{ type: 'paragraph', text: override.description }] : item.blocks, maps: override.mapsUrl ? [override.mapsUrl] : item.maps, cover: photos.length ? photos[0] : item.cover, images: photos.length ? photos.slice(1).map(src => ({ src, caption: '社区维护照片' })) : item.images, contact: { ...(item.contact || {}), phone: override.phone || null, website: override.website || null, openingHours: override.openingHours || [] }, maintainedBy: override.updatedByName || override.updatedBy, maintainedAt: override.updatedAt } }
function saveContributionPhotos(photos, id) { return (Array.isArray(photos) ? photos : []).slice(0, 3).map((value, index) => { const match = String(value || '').match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/); if (!match) throw new Error('照片格式仅支持 JPG、PNG 或 WebP'); const buffer = Buffer.from(match[2], 'base64'); if (!buffer.length || buffer.length > 2.5 * 1024 * 1024) throw new Error('每张照片需小于 2.5MB'); const ext = match[1] === 'jpeg' ? 'jpg' : match[1], filename = `${id}-${index + 1}.${ext}`; fs.writeFileSync(path.join(communityMediaDir, filename), buffer, { mode: 0o600 }); return `/media/community/${filename}`; }); }
function serve(res, pathname) { let f = pathname === '/' ? 'index.html' : pathname.slice(1); if (f.includes('..')) return false; const full = path.join(root, 'public', f); if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) return false; const ext = path.extname(full).toLowerCase(); const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }; res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream', 'cache-control': f === 'sw.js' || ext === '.html' ? 'no-cache' : 'public,max-age=86400', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; img-src 'self' https: data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-eval'; connect-src 'self' https://tile.openstreetmap.org; worker-src 'self' blob:; child-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" }); fs.createReadStream(full).pipe(res); return true; }

const server = http.createServer(async (req, res) => { try {
  const u = new URL(req.url, 'http://local');
  if (['POST', 'PATCH', 'DELETE'].includes(req.method) && !originOkay(req)) return json(res, 403, { error: '来源校验失败' });
  if (req.method === 'POST' && u.pathname === '/api/login') {
    const b = await readBody(req), userId = String(b.user || '').trim().toLowerCase(), pin = String(b.pin || ''), key = rateKey(req, userId), check = rateCheck(key);
    if (!check.ok) { audit('login_rate_limited', req, { user: userId }); return json(res, 429, { error: '尝试过多，请稍后再试', retryAfter: check.retry }, { 'retry-after': String(check.retry) }); }
    const account = findUser(userId);
    if (!account || !/^\d{4}$/.test(pin) || !verifySecret(pin, account.pinHash)) { rateFail(key, check.a); audit('login_failed', req, { user: userId }); return json(res, 401, { error: '名字或 PIN 不正确' }); }
    if (account.status === 'disabled') { audit('login_disabled', req, { user: userId }); return json(res, 403, { error: '此账户已停用，请联系管理员' }); }
    attempts.delete(key); setLastLogin(userId); audit('login_success', req, { user: userId }); return json(res, 200, { ok: true, user: publicUser(findUser(userId)) }, { 'set-cookie': loginCookie(createSession(userId)) });
  }
  if (req.method === 'POST' && u.pathname === '/api/register') {
    const b = await readBody(req), id = String(b.user || '').trim().toLowerCase(), name = String(b.name || b.user || '').trim(), pin = String(b.pin || ''), code = String(b.code || '').trim(), key = rateKey(req, `register:${id}`), check = rateCheck(key);
    if (!check.ok) return json(res, 429, { error: '尝试过多，请稍后再试', retryAfter: check.retry });
    if (!/^[a-z0-9_\u4e00-\u9fff-]{2,24}$/i.test(id)) return json(res, 400, { error: '名字需为 2–24 个中文、字母、数字、下划线或短横线' });
    if (!/^\d{4}$/.test(pin)) return json(res, 400, { error: 'PIN 必须是 4 位数字' });
    if (findUser(id)) return json(res, 409, { error: '这个名字已经注册' });
    const codes = readJson(codesPath, []), matched = codes.find(c => c.active && c.used < c.maxUses && verifySecret(code, c.codeHash));
    if (!matched) { rateFail(key, check.a); audit('register_failed', req, { user: id }); return json(res, 403, { error: '授权码无效或已用完' }); }
    const list = users(), now = new Date().toISOString(); list.push({ id, name, pinHash: hashSecret(pin), admin: false, coAdmin: false, stars: 0, status: 'active', createdAt: now, source: 'registration' }); writeJson(usersPath, list);
    matched.used++; matched.lastUsedAt = now; matched.usedBy = [...(matched.usedBy || []), id]; if (matched.used >= matched.maxUses) matched.active = false; writeJson(codesPath, codes);
    attempts.delete(key); audit('register_success', req, { user: id, codeId: matched.id }); return json(res, 201, { ok: true, user: publicUser(findUser(id)) }, { 'set-cookie': loginCookie(createSession(id)) });
  }
  if (req.method === 'POST' && u.pathname === '/api/logout') { const s = session(req); if (s) { revoked.add(s.j); audit('logout', req, { user: s.u }); } return json(res, 200, { ok: true }, { 'set-cookie': clearCookie() }); }
  if (req.method === 'GET' && u.pathname === '/api/session') { const s = session(req); if (!s) return json(res, 401, { authenticated: false }); return json(res, 200, { authenticated: true, user: publicUser(s.account) }); }
  if (req.method === 'GET' && u.pathname === '/api/places') { const s = requireAuth(req, res); if (!s) return; const data = readJson(path.join(root, 'data', 'places.json'), { source: {}, categories: [], items: [] }), community = readJson(contributionsPath, []).filter(x => x.status !== 'removed').map(contributionItem), overrides = readJson(placeOverridesPath, {}); data.items = [...community, ...data.items].map(item => applyPlaceOverride(item, overrides[item.id])); data.categories = [...new Set([...data.items.map(x => x.category), ...data.categories].filter(Boolean))]; if (s.account.status === 'restricted') data.items = data.items.map(x => ({ ...x, maps: [], links: [], restricted: true })); return json(res, 200, data); }
  if (req.method === 'POST' && u.pathname === '/api/contributions') {
    const s = requireAuth(req, res); if (!s) return;
    if (s.account.status === 'restricted') return json(res, 403, { error: '受限账户暂时不能分享地点' });
    const b = await readBody(req, 9 * 1024 * 1024), mapsUrl = normalizeMapsUrl(b.mapsUrl), reasonTag = String(b.reasonTag || '').trim(), category = String(b.category || '').trim(), description = String(b.description || '').trim(), showSharer = b.showSharer === true, providedName = String(b.placeName || '').trim().slice(0, 120), address = String(b.address || '').trim().slice(0, 240);
    if (!mapsUrl) return json(res, 400, { error: '请填写有效的 Google 地图地址' });
    if (characterCount(reasonTag) < 1 || characterCount(reasonTag) > 8) return json(res, 400, { error: '推荐原因请写成 1-8 个字的短标签' });
    if (characterCount(category) < 1 || characterCount(category) > 4) return json(res, 400, { error: '类别需要 1-4 个字' });
    if (characterCount(description) > 500) return json(res, 400, { error: '详细描述请控制在 500 字以内' });
    const rows = readJson(contributionsPath, []), guide = readJson(path.join(root, 'data', 'places.json'), { items: [] });
    if (rows.some(x => x.status !== 'removed' && normalizeMapsUrl(x.mapsUrl) === mapsUrl) || guide.items.some(x => (x.maps || []).some(link => normalizeMapsUrl(link) === mapsUrl))) return json(res, 409, { error: '这个地点已经收藏，不会重复计星' });
    const id = randomBytes(8).toString('hex'), photos = saveContributionPhotos(b.photos, id), now = new Date().toISOString(), placeName = providedName || await resolveMapsPlaceName(mapsUrl, reasonTag), row = { id, mapsUrl, placeName, address, location: mapsUrlCoordinates(mapsUrl), reasonTag, category, description, showSharer, sharerId: s.u, sharerName: s.account.name, photos, status: 'active', createdAt: now, provider: 'user' };
    rows.push(row); writeJson(contributionsPath, rows);
    const list = users(), account = list.find(x => x.id === s.u); account.stars = Number(account.stars || 0) + 5; let promoted = false; if (account.stars >= 30 && !account.admin) { account.admin = true; account.coAdmin = true; account.promotedAt = now; promoted = true; } account.updatedAt = now; writeJson(usersPath, list);
    audit('place_contributed', req, { user: s.u, contributionId: id, category, stars: account.stars, showSharer }); if (promoted) audit('coadmin_promoted', req, { user: s.u, stars: account.stars });
    return json(res, 201, { ok: true, item: contributionItem(row), user: publicUser(account), starsAdded: 5, promoted });
  }
  // ---- Bot / 外部导入端点：小红书文案与 MausBot 自动添加 -------------------
  // 主端点 /api/bot/places，旧端点 /api/import/place 保留兼容。
  // 鉴权：Authorization: Bearer <token> 或 X-Bot-Token: <token>。
  // token 优先取管理后台设置的 runtime token，其次取环境变量 IMPORT_TOKEN。
  // 安全底线：Google 地图域名白名单、http(s) 图片白名单、请求体限制、审计。
  if (req.method === 'POST' && (u.pathname === '/api/bot/places' || u.pathname === '/api/import/place')) {
    if (!requireBotToken(req, res)) return;
    const b = await readBody(req, 2 * 1024 * 1024);
    return importBotPlace(req, res, b);
  }
  if (req.method === 'GET' && u.pathname === '/api/bot/status') {
    if (!requireBotToken(req, res)) return;
    return json(res, 200, { ok: true, endpoint: '/api/bot/places', source: botTokenSource(), tokenMasked: maskToken(botToken()) });
  }
  const editPlaceMatch = u.pathname.match(/^\/api\/places\/([^/]+)$/);
  if (req.method === 'PATCH' && editPlaceMatch) {
    const s = requireEditor(req, res); if (!s) return;
    const placeId = decodeURIComponent(editPlaceMatch[1]), guide = readJson(path.join(root, 'data', 'places.json'), { items: [] }), community = readJson(contributionsPath, []).filter(x => x.status !== 'removed').map(contributionItem), original = [...community, ...guide.items].find(x => x.id === placeId);
    if (!original) return json(res, 404, { error: '地点不存在' });
    // v27：管理员/联合管理员在网页后台拥有最高编辑权。
    // 放开所有「业务约定」类限制（字数、个数、类别长度、电话/官网长度、照片数量），
    // 只保留「安全底线」：请求体大小、URL 协议白名单、Google 地图域名白名单、
    // 图片来源白名单、XSS 转义（输出层）、origin 校验、限流。
    const b = await readBody(req, 2 * 1024 * 1024), displayName = String(b.displayName ?? '').trim(), memoryKeyword = String(b.memoryKeyword ?? '').trim(), category = String(b.category ?? '').trim(), description = String(b.description ?? '').trim(), phone = String(b.phone ?? '').trim(), website = String(b.website ?? '').trim(), mapsUrl = String(b.mapsUrl ?? '').trim(), openingHours = Array.isArray(b.openingHours) ? b.openingHours.map(x => String(x).trim()).filter(Boolean) : String(b.openingHours ?? '').split('\n').map(x => x.trim()).filter(Boolean), tags = Array.isArray(b.tags) ? b.tags.map(x => String(x).trim()).filter(Boolean) : String(b.tags ?? '').split(/[,，]/).map(x => x.trim()).filter(Boolean), photos = Array.isArray(b.photos) ? b.photos.map(x => String(x).trim()).filter(x => /^(https:\/\/|\/media\/community\/)/.test(x)) : [];
    if (characterCount(displayName) < 1) return json(res, 400, { error: '显示名称不能为空' });
    if (!category) return json(res, 400, { error: '类别不能为空' });
    // website / mapsUrl / photos 保留协议与域名白名单（安全项，不可放开）：
    if (website && !safeHttpUrl(website)) return json(res, 400, { error: '官网链接需要是有效的 http(s) 地址' });
    if (mapsUrl && !normalizeMapsUrl(mapsUrl)) return json(res, 400, { error: '地图地址请填写有效的 Google 地图链接' });
    const now = new Date().toISOString(), overrides = readJson(placeOverridesPath, {}), row = { displayName, memoryKeyword, category, description, tags, phone, website: website ? safeHttpUrl(website) : '', mapsUrl: mapsUrl ? normalizeMapsUrl(mapsUrl) : '', openingHours, photos, updatedAt: now, updatedBy: s.u, updatedByName: s.account.name };
    overrides[placeId] = row; writeJson(placeOverridesPath, overrides); audit('place_display_updated', req, { user: s.u, placeId, category });
    return json(res, 200, { ok: true, item: applyPlaceOverride(original, row) });
  }
  const livePlaceMatch = u.pathname.match(/^\/api\/places\/([^/]+)\/live$/);
  if (req.method === 'GET' && livePlaceMatch) {
    const s = requireAuth(req, res); if (!s) return;
    if (s.account.status === 'restricted') return json(res, 403, { error: '当前账户无法查看外部地点信息' });
    const placeId = decodeURIComponent(livePlaceMatch[1]), item = allPlaces().find(x => x.id === placeId);
    if (!item) return json(res, 404, { error: '地点不存在' });
    if (item.community) return json(res, 200, { available: false, reason: 'community_place' });
    const browserCache = readJson(path.join(root, 'data', 'google-maps-cache.json'), { items: {} }).items?.[placeId];
    if (browserCache?.unavailable || browserCache?.error) return json(res, 200, { available: false, reason: browserCache.reason || 'browser_snapshot_unavailable' });
    if (browserCache) return json(res, 200, { available: true, provider: 'Google Maps browser snapshot', place: { id: browserCache.placeId || placeId, displayName: { text: browserCache.name || item.displayName || item.name }, formattedAddress: browserCache.address || null, nationalPhoneNumber: browserCache.phone || null, regularOpeningHours: browserCache.openingHours?.length ? { weekdayDescriptions: browserCache.openingHours } : null, websiteUri: browserCache.website || null, googleMapsUri: browserCache.googleMapsUrl || item.maps?.[0] || null, reservable: browserCache.reservable ?? null, photos: (browserCache.photos || []).slice(0, 3).map(url => ({ url, googleMapsUri: browserCache.googleMapsUrl || item.maps?.[0] || null, authorAttributions: [] })) } });
    if (!googleMapsKey) return json(res, 200, { available: false, reason: 'browser_snapshot_missing' });
    const fieldMask = 'places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.internationalPhoneNumber,places.regularOpeningHours,places.currentOpeningHours,places.websiteUri,places.googleMapsUri,places.photos,places.reservable';
    const body = { textQuery: `${item.displayName || item.name} Chiang Mai Thailand`, languageCode: String(u.searchParams.get('language') || 'zh-CN').slice(0, 10), regionCode: 'TH', maxResultCount: 1 };
    if (item.location?.lat && item.location?.lng) body.locationBias = { circle: { center: { latitude: item.location.lat, longitude: item.location.lng }, radius: 1500 } };
    const upstream = await fetch('https://places.googleapis.com/v1/places:searchText', { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': googleMapsKey, 'x-goog-fieldmask': fieldMask }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    if (!upstream.ok) return json(res, 502, { error: '暂时无法获取 Google 地点信息' });
    const place = (await upstream.json()).places?.[0]; if (!place) return json(res, 200, { available: false, reason: 'place_not_found' });
    place.photos = (place.photos || []).slice(0, 3).map(photo => ({ name: photo.name, widthPx: photo.widthPx, heightPx: photo.heightPx, authorAttributions: photo.authorAttributions || [], googleMapsUri: photo.googleMapsUri || place.googleMapsUri, flagContentUri: photo.flagContentUri || null }));
    return json(res, 200, { available: true, provider: 'Google Maps', place });
  }
  if (req.method === 'GET' && u.pathname === '/api/place-photo') {
    const s = requireAuth(req, res); if (!s) return;
    if (s.account.status === 'restricted') return json(res, 403, { error: '当前账户无法查看外部照片' });
    if (!googleMapsKey) return json(res, 503, { error: 'Google Maps 照片服务未配置' });
    const name = String(u.searchParams.get('name') || ''); if (!/^places\/[\w-]+\/photos\/[\w-]+$/.test(name)) return json(res, 400, { error: '无效照片参数' });
    const upstream = await fetch(`https://places.googleapis.com/v1/${name}/media?maxWidthPx=1200&maxHeightPx=900&key=${encodeURIComponent(googleMapsKey)}`, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
    if (!upstream.ok || !upstream.body) return json(res, 502, { error: '照片暂时无法载入' });
    res.writeHead(200, { 'content-type': upstream.headers.get('content-type') || 'image/jpeg', 'cache-control': 'private,no-store', 'x-content-type-options': 'nosniff' });
    Readable.fromWeb(upstream.body).pipe(res); return;
  }
  if (req.method === 'GET' && u.pathname === '/api/admin/overview') { const s = requireAuth(req, res, true); if (!s) return; const codes = readJson(codesPath, []).map(({ codeHash, codeCipher, ...c }) => ({ ...c, code: decryptCode(codeCipher) })); return json(res, 200, { users: users().map(publicUser), codes, contributions: readJson(contributionsPath, []), bot: botOverview(), audit: auditRows(Number(u.searchParams.get('limit') || 300)) }); }
  if (req.method === 'GET' && u.pathname === '/api/admin/bot/settings') { const s = requireAuth(req, res, true); if (!s) return; return json(res, 200, botOverview()); }
  if (req.method === 'POST' && u.pathname === '/api/admin/bot/token') { const s = requireAuth(req, res, true); if (!s) return; const b = await readBody(req), token = String(b.token || randomBytes(24).toString('hex')).trim(); if (token.length < 8 || token.length > 128) return json(res, 400, { error: 'Bot 令牌需为 8–128 个字符' }); const settings = botSettings(), now = new Date().toISOString(); settings.token = token; settings.source = 'runtime'; settings.createdAt = settings.createdAt || now; settings.updatedAt = now; writeJson(botSettingsPath, settings); audit('bot_token_rotated', req, { user: s.u }); return json(res, 200, botOverview()); }
  if (req.method === 'POST' && u.pathname === '/api/admin/bot/disable') { const s = requireAuth(req, res, true); if (!s) return; const settings = botSettings(), now = new Date().toISOString(); settings.token = ''; settings.source = 'none'; settings.updatedAt = now; writeJson(botSettingsPath, settings); audit('bot_disabled', req, { user: s.u }); return json(res, 200, botOverview()); }
  if (req.method === 'POST' && u.pathname === '/api/admin/codes') { const s = requireAuth(req, res, true); if (!s) return; const b = await readBody(req), maxUses = Math.max(1, Math.min(100, Number(b.maxUses || 1))), style = b.style === 'en' ? 'en' : 'zh', plain = memorableCode(style), codes = readJson(codesPath, []), row = { id: randomBytes(8).toString('hex'), label: String(b.label || '').trim().slice(0, 40) || '朋友授权码', style, codeHash: hashSecret(plain), codeCipher: encryptCode(plain), active: true, used: 0, maxUses, createdAt: new Date().toISOString(), createdBy: s.u }; codes.push(row); writeJson(codesPath, codes); audit('registration_code_created', req, { user: s.u, codeId: row.id, maxUses, style }); return json(res, 201, { code: plain, item: (({ codeHash, codeCipher, ...x }) => x)(row) }); }
  if (req.method === 'POST' && u.pathname === '/api/admin/codes/manual') {
    const s = requireAuth(req, res, true); if (!s) return;
    const b = await readBody(req), plain = String(b.code || '').trim(), maxUses = Math.max(1, Math.min(100, Number(b.maxUses || 1)));
    if (!/^[\p{L}\p{N}_-]{4,32}$/u.test(plain)) return json(res, 400, { error: '历史授权码需为 4–32 位中英文、数字、下划线或短横线' });
    const codes = readJson(codesPath, []);
    if (codes.some(code => verifySecret(plain, code.codeHash))) return json(res, 409, { error: '这个授权码已存在，无需重复增补' });
    const row = { id: randomBytes(8).toString('hex'), label: String(b.label || '').trim().slice(0, 40) || '历史授权码', style: 'manual', codeHash: hashSecret(plain), codeCipher: encryptCode(plain), active: true, used: 0, maxUses, createdAt: new Date().toISOString(), createdBy: s.u, source: 'manual' };
    codes.push(row); writeJson(codesPath, codes); audit('registration_code_imported', req, { user: s.u, codeId: row.id, maxUses });
    return json(res, 201, { code: plain, item: (({ codeHash, codeCipher, ...x }) => x)(row) });
  }
  const codeMatch = u.pathname.match(/^\/api\/admin\/codes\/([^/]+)$/);
  if (req.method === 'DELETE' && codeMatch) { const s = requireAuth(req, res, true); if (!s) return; const id = decodeURIComponent(codeMatch[1]), codes = readJson(codesPath, []), target = codes.find(x => x.id === id); if (!target) return json(res, 404, { error: '授权码不存在' }); target.active = false; target.maxUses = target.used; target.revokedAt = new Date().toISOString(); target.revokedBy = s.u; writeJson(codesPath, codes); audit('registration_code_revoked', req, { user: s.u, codeId: target.id }); return json(res, 200, { ok: true, item: (({ codeHash, codeCipher, ...x }) => x)(target) }); }
  const statusMatch = u.pathname.match(/^\/api\/admin\/users\/([^/]+)\/status$/);
  if (req.method === 'PATCH' && statusMatch) { const s = requireAuth(req, res, true); if (!s) return; const id = decodeURIComponent(statusMatch[1]), b = await readBody(req), status = String(b.status || ''); if (!['active', 'restricted', 'disabled'].includes(status)) return json(res, 400, { error: '无效状态' }); const list = users(), target = list.find(x => x.id === id); if (!target) return json(res, 404, { error: '用户不存在' }); if (target.id === s.u && status !== 'active') return json(res, 400, { error: '不能限制或停用当前管理员账户' }); target.status = status; target.updatedAt = new Date().toISOString(); writeJson(usersPath, list); audit('user_status_changed', req, { user: s.u, target: id, status }); return json(res, 200, { user: publicUser(target) }); }
  const roleMatch = u.pathname.match(/^\/api\/admin\/users\/([^/]+)\/admin$/);
  if (req.method === 'PATCH' && roleMatch) { const s = requireAuth(req, res, true); if (!s) return; const id = decodeURIComponent(roleMatch[1]), b = await readBody(req), makeAdmin = b.admin === true, list = users(), target = list.find(x => x.id === id); if (!target) return json(res, 404, { error: '用户不存在' }); if (target.id === s.u && !makeAdmin) return json(res, 400, { error: '不能取消当前管理员自己的权限' }); target.admin = makeAdmin; target.updatedAt = new Date().toISOString(); writeJson(usersPath, list); audit('user_admin_changed', req, { user: s.u, target: id, admin: makeAdmin }); return json(res, 200, { user: publicUser(target) }); }
  if (req.method === 'GET' && u.pathname.startsWith('/media/community/')) { const s = requireAuth(req, res); if (!s) return; const filename = path.basename(u.pathname), full = path.join(communityMediaDir, filename); if (!/^[a-f0-9]{16}-[1-3]\.(jpg|png|webp)$/.test(filename) || !fs.existsSync(full)) return json(res, 404, { error: '照片不存在' }); const ext = path.extname(filename), type = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'; res.writeHead(200, { 'content-type': type, 'cache-control': 'private,max-age=86400', 'x-content-type-options': 'nosniff' }); fs.createReadStream(full).pipe(res); return; }
  /* v25 — public share links: signed URL, no login, whitelisted fields only */
  if (req.method === 'POST' && /^\/api\/places\/[^/]+\/share$/.test(u.pathname)) {
    const s = requireAuth(req, res); if (!s) return;
    if (s.account.status === 'restricted') return json(res, 403, { error: '受限账户暂时不能生成公开链接' });
    const placeId = decodeURIComponent(u.pathname.split('/')[3]), item = allPlaces().find(x => x.id === placeId);
    if (!item) return json(res, 404, { error: '地点不存在' });
    const token = shareToken(placeId), host = String(req.headers.host || '').slice(0, 160) || 'cm.caishen.today';
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || (process.env.NODE_ENV === 'production' ? 'https' : 'http');
    const url = `${proto}://${host}/s/${token}`;
    audit('share_link_created', req, { user: s.u, placeId });
    return json(res, 200, { ok: true, url, title: item.displayName || item.name || item.title || '' });
  }
  const sharePhotoMatch = u.pathname.match(/^\/s\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\/photo\/(\d+)$/);
  if (req.method === 'GET' && sharePhotoMatch) {
    const placeId = verifyShareToken(sharePhotoMatch[1]);
    const item = placeId && allPlaces().find(x => x.id === placeId);
    const photos = item ? sharePublicPlace(item).photos : [];
    const start = Number(sharePhotoMatch[2]);
    let served = false;
    for (let offset = 0; offset < photos.length && !served; offset++) {
      const src = photos[(start + offset) % photos.length];
      if (/^https:\/\//.test(src)) { res.writeHead(302, { location: src, 'cache-control': 'public,max-age=86400' }); res.end(); served = true; break; }
      const filename = path.basename(src), full = src.startsWith('/media/community/') ? path.join(communityMediaDir, filename) : path.join(root, 'public', 'media', filename);
      if (!/^[\w-]+\.(jpg|jpeg|png|webp)$/i.test(filename) || !fs.existsSync(full)) continue;
      const ext = path.extname(filename).toLowerCase(), type = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      res.writeHead(200, { 'content-type': type, 'cache-control': 'public,max-age=86400', 'x-content-type-options': 'nosniff' }); fs.createReadStream(full).pipe(res); served = true;
    }
    if (!served) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Not found'); }
    return;
  }
  const shareMatch = u.pathname.match(/^\/s\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/);
  if (req.method === 'GET' && shareMatch) {
    const shareHeaders = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'self'" };
    const placeId = verifyShareToken(shareMatch[1]), item = placeId && allPlaces().find(x => x.id === placeId);
    if (!item) { res.writeHead(404, shareHeaders); res.end('<!doctype html><meta charset="utf-8"><title>链接已失效</title><p style="font:16px system-ui;padding:40px">这个分享链接无效或地点已移除。</p>'); return; }
    const host = String(req.headers.host || '').slice(0, 160) || 'cm.caishen.today';
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || (process.env.NODE_ENV === 'production' ? 'https' : 'http');
    res.writeHead(200, shareHeaders); res.end(sharePageHtml(sharePublicPlace(item), shareMatch[1], `${proto}://${host}`)); return;
  }
  if (u.pathname === '/healthz') return json(res, 200, { ok: true });
  if (serve(res, u.pathname)) return; res.writeHead(404); res.end('Not found');
} catch (e) { console.error(e); json(res, 400, { error: e.message || 'bad_request' }); } });

server.listen(port, () => console.log(`Chiang Mai Life listening on :${port}`));
const syncMinutes = Number(process.env.SYNC_INTERVAL_MINUTES || 0);
if (syncMinutes > 0 && process.env.NOTION_TOKEN) { let running = false; const run = () => { if (running) return; running = true; const p = spawn(process.execPath, ['scripts/sync-notion.mjs'], { cwd: root, env: process.env, stdio: 'inherit' }); p.on('error', e => console.error('Notion sync failed', e.message)); p.on('close', () => { running = false; }); }; run(); setInterval(run, syncMinutes * 60000).unref(); }
