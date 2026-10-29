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
const communityMediaDir = path.join(runtimeDir, 'community-media');
const auditPath = process.env.AUDIT_LOG || path.join(runtimeDir, 'login-audit.ndjson');
const googleMapsKey = process.env.GOOGLE_MAPS_API_KEY || '';
fs.mkdirSync(runtimeDir, { recursive: true });
fs.mkdirSync(communityMediaDir, { recursive: true });
const attempts = new Map();
const revoked = new Set();
initializeStore();

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, value) { const temp = `${file}.${process.pid}.tmp`; fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 }); fs.renameSync(temp, file); }
function configuredUsers() { const raw = process.env.PIN_USERS_JSON || fs.readFileSync(path.join(root, 'config', 'users.example.json'), 'utf8'); return JSON.parse(raw); }
function initializeStore() { const now = new Date().toISOString(); const existing = readJson(usersPath, []); const byId = new Map(existing.map(u => [u.id, u])); for (const user of configuredUsers()) if (!byId.has(user.id)) byId.set(user.id, { ...user, status: user.status || 'active', createdAt: now, source: 'configured', stars: 0 }); writeJson(usersPath, [...byId.values()]); if (!fs.existsSync(codesPath)) writeJson(codesPath, []); if (!fs.existsSync(contributionsPath)) writeJson(contributionsPath, []); if (!fs.existsSync(placeOverridesPath)) writeJson(placeOverridesPath, {}); }
function users() { return readJson(usersPath, []); }
function findUser(id) { return users().find(u => u.id === id); }
function publicUser(u) { return { id: u.id, name: u.name, admin: !!u.admin, coAdmin: !!u.coAdmin, stars: Number(u.stars || 0), status: u.status || 'active', createdAt: u.createdAt || null, lastLoginAt: u.lastLoginAt || null }; }
function json(res, status, data, headers = {}) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers }); res.end(JSON.stringify(data)); }
function readBody(req, maxBytes = 20000) { return new Promise((resolve, reject) => { let b = '', failed = false; req.on('data', c => { if (failed) return; b += c; if (Buffer.byteLength(b) > maxBytes) { failed = true; reject(new Error('上传内容过大')); req.destroy(); } }); req.on('end', () => { if (failed) return; try { resolve(JSON.parse(b || '{}')); } catch { reject(new Error('bad_json')); } }); req.on('error', reject); }); }
function ip(req) { return String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim().slice(0, 80); }
function sign(value) { return createHmac('sha256', secret).update(value).digest('base64url'); }
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
function placeNameFromMapsUrl(value) { try { const url = new URL(value), match = decodeURIComponent(url.pathname).match(/\/place\/([^/]+)/); return match ? match[1].replaceAll('+', ' ').trim().slice(0, 80) : ''; } catch { return ''; } }
function contributionItem(row) { const name = row.placeName || row.reasonTag; return { id: `community-${row.id}`, title: `${row.reasonTag} // ${name} // ${row.category}`, name, displayName: `${row.reasonTag} // ${name} // ${row.category}`, memoryKeyword: row.reasonTag, hint: row.description || row.reasonTag, description: row.description || `朋友推荐：${row.reasonTag}`, category: row.category, detailCategory: row.category, tags: [row.reasonTag, row.category], cover: row.photos?.[0] || null, images: (row.photos || []).slice(1).map(src => ({ src, caption: '朋友分享照片' })), maps: [row.mapsUrl], links: [], blocks: row.description ? [{ type: 'paragraph', text: row.description }] : [], community: true, contributedAt: row.createdAt, contributor: row.showSharer ? { name: row.sharerName } : null }; }
function applyPlaceOverride(item, override) { if (!override) return item; const title = override.displayName || item.displayName || item.name || item.title, photos = override.photos || []; return { ...item, displayName: title, title, name: override.name || item.name, memoryKeyword: override.memoryKeyword || item.memoryKeyword, category: override.category || item.category, detailCategory: override.category || item.detailCategory, tags: override.tags?.length ? override.tags : item.tags, description: override.description || item.description, hint: override.description || item.hint, blocks: override.description ? [{ type: 'paragraph', text: override.description }] : item.blocks, maps: override.mapsUrl ? [override.mapsUrl] : item.maps, cover: photos.length ? photos[0] : item.cover, images: photos.length ? photos.slice(1).map(src => ({ src, caption: '社区维护照片' })) : item.images, contact: { ...(item.contact || {}), phone: override.phone || null, website: override.website || null, openingHours: override.openingHours || [] }, maintainedBy: override.updatedByName || override.updatedBy, maintainedAt: override.updatedAt } }
function saveContributionPhotos(photos, id) { return (Array.isArray(photos) ? photos : []).slice(0, 3).map((value, index) => { const match = String(value || '').match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/); if (!match) throw new Error('照片格式仅支持 JPG、PNG 或 WebP'); const buffer = Buffer.from(match[2], 'base64'); if (!buffer.length || buffer.length > 2.5 * 1024 * 1024) throw new Error('每张照片需小于 2.5MB'); const ext = match[1] === 'jpeg' ? 'jpg' : match[1], filename = `${id}-${index + 1}.${ext}`; fs.writeFileSync(path.join(communityMediaDir, filename), buffer, { mode: 0o600 }); return `/media/community/${filename}`; }); }
function serve(res, pathname) { let f = pathname === '/' ? 'index.html' : pathname.slice(1); if (f.includes('..')) return false; const full = path.join(root, 'public', f); if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) return false; const ext = path.extname(full).toLowerCase(); const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }; res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream', 'cache-control': ext === '.html' ? 'no-cache' : 'public,max-age=86400', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; img-src 'self' https: data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-eval'; connect-src 'self' https://tile.openstreetmap.org; worker-src 'self' blob:; child-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" }); fs.createReadStream(full).pipe(res); return true; }

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
    const b = await readBody(req, 9 * 1024 * 1024), mapsUrl = normalizeMapsUrl(b.mapsUrl), reasonTag = String(b.reasonTag || '').trim(), category = String(b.category || '').trim(), description = String(b.description || '').trim(), showSharer = b.showSharer === true;
    if (!mapsUrl) return json(res, 400, { error: '请填写有效的 Google 地图地址' });
    if (characterCount(reasonTag) < 1 || characterCount(reasonTag) > 8) return json(res, 400, { error: '推荐原因请写成 1-8 个字的短标签' });
    if (characterCount(category) < 1 || characterCount(category) > 4) return json(res, 400, { error: '类别需要 1-4 个字' });
    if (characterCount(description) > 500) return json(res, 400, { error: '详细描述请控制在 500 字以内' });
    const rows = readJson(contributionsPath, []), guide = readJson(path.join(root, 'data', 'places.json'), { items: [] });
    if (rows.some(x => x.status !== 'removed' && normalizeMapsUrl(x.mapsUrl) === mapsUrl) || guide.items.some(x => (x.maps || []).some(link => normalizeMapsUrl(link) === mapsUrl))) return json(res, 409, { error: '这个地点已经收藏，不会重复计星' });
    const id = randomBytes(8).toString('hex'), photos = saveContributionPhotos(b.photos, id), now = new Date().toISOString(), row = { id, mapsUrl, placeName: placeNameFromMapsUrl(mapsUrl) || reasonTag, reasonTag, category, description, showSharer, sharerId: s.u, sharerName: s.account.name, photos, status: 'active', createdAt: now };
    rows.push(row); writeJson(contributionsPath, rows);
    const list = users(), account = list.find(x => x.id === s.u); account.stars = Number(account.stars || 0) + 5; let promoted = false; if (account.stars >= 30 && !account.admin) { account.admin = true; account.coAdmin = true; account.promotedAt = now; promoted = true; } account.updatedAt = now; writeJson(usersPath, list);
    audit('place_contributed', req, { user: s.u, contributionId: id, category, stars: account.stars, showSharer }); if (promoted) audit('coadmin_promoted', req, { user: s.u, stars: account.stars });
    return json(res, 201, { ok: true, item: contributionItem(row), user: publicUser(account), starsAdded: 5, promoted });
  }
  const editPlaceMatch = u.pathname.match(/^\/api\/places\/([^/]+)$/);
  if (req.method === 'PATCH' && editPlaceMatch) {
    const s = requireEditor(req, res); if (!s) return;
    const placeId = decodeURIComponent(editPlaceMatch[1]), guide = readJson(path.join(root, 'data', 'places.json'), { items: [] }), community = readJson(contributionsPath, []).filter(x => x.status !== 'removed').map(contributionItem), original = [...community, ...guide.items].find(x => x.id === placeId);
    if (!original) return json(res, 404, { error: '地点不存在' });
    const b = await readBody(req, 100000), displayName = String(b.displayName || '').trim(), memoryKeyword = String(b.memoryKeyword || '').trim(), category = String(b.category || '').trim(), description = String(b.description || '').trim(), phone = String(b.phone || '').trim(), website = String(b.website || '').trim(), mapsUrl = String(b.mapsUrl || '').trim(), openingHours = Array.isArray(b.openingHours) ? b.openingHours.map(x => String(x).trim()).filter(Boolean).slice(0, 14) : String(b.openingHours || '').split('\n').map(x => x.trim()).filter(Boolean).slice(0, 14), tags = Array.isArray(b.tags) ? b.tags.map(x => String(x).trim()).filter(Boolean).slice(0, 6) : String(b.tags || '').split(/[,，]/).map(x => x.trim()).filter(Boolean).slice(0, 6), photos = Array.isArray(b.photos) ? b.photos.map(x => String(x).trim()).filter(x => /^(https:\/\/|\/media\/community\/)/.test(x)).slice(0, 3) : [];
    if (characterCount(displayName) < 1 || characterCount(displayName) > 100) return json(res, 400, { error: '显示名称需要 1-100 个字' });
    if (characterCount(memoryKeyword) > 12) return json(res, 400, { error: '记忆标签请控制在 12 个字内' });
    if (characterCount(category) < 1 || characterCount(category) > 8) return json(res, 400, { error: '类别需要 1-8 个字' });
    if (characterCount(description) > 1200) return json(res, 400, { error: '详细描述请控制在 1200 字内' });
    if (website && !/^https:\/\//i.test(website)) return json(res, 400, { error: '官网需要以 https:// 开头' });
    if (mapsUrl && !normalizeMapsUrl(mapsUrl)) return json(res, 400, { error: '请填写有效的 Google 地图地址' });
    const now = new Date().toISOString(), overrides = readJson(placeOverridesPath, {}), row = { displayName, memoryKeyword, category, description, tags, phone: phone.slice(0, 40), website: website.slice(0, 500), mapsUrl: mapsUrl ? normalizeMapsUrl(mapsUrl) : '', openingHours, photos, updatedAt: now, updatedBy: s.u, updatedByName: s.account.name };
    overrides[placeId] = row; writeJson(placeOverridesPath, overrides); audit('place_display_updated', req, { user: s.u, placeId, category });
    return json(res, 200, { ok: true, item: applyPlaceOverride(original, row) });
  }
  const livePlaceMatch = u.pathname.match(/^\/api\/places\/([^/]+)\/live$/);
  if (req.method === 'GET' && livePlaceMatch) {
    const s = requireAuth(req, res); if (!s) return;
    if (s.account.status === 'restricted') return json(res, 403, { error: '当前账户无法查看外部地点信息' });
    const placeId = decodeURIComponent(livePlaceMatch[1]), guide = readJson(path.join(root, 'data', 'places.json'), { items: [] }), item = guide.items.find(x => x.id === placeId);
    if (!item) return json(res, 404, { error: '地点不存在' });
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
  if (req.method === 'GET' && u.pathname === '/api/admin/overview') { const s = requireAuth(req, res, true); if (!s) return; const codes = readJson(codesPath, []).map(({ codeHash, codeCipher, ...c }) => ({ ...c, code: decryptCode(codeCipher) })); return json(res, 200, { users: users().map(publicUser), codes, contributions: readJson(contributionsPath, []), audit: auditRows(Number(u.searchParams.get('limit') || 300)) }); }
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
  if (u.pathname === '/healthz') return json(res, 200, { ok: true });
  if (serve(res, u.pathname)) return; res.writeHead(404); res.end('Not found');
} catch (e) { console.error(e); json(res, 400, { error: e.message || 'bad_request' }); } });

server.listen(port, () => console.log(`Chiang Mai Life listening on :${port}`));
const syncMinutes = Number(process.env.SYNC_INTERVAL_MINUTES || 0);
if (syncMinutes > 0 && process.env.NOTION_TOKEN) { let running = false; const run = () => { if (running) return; running = true; const p = spawn(process.execPath, ['scripts/sync-notion.mjs'], { cwd: root, env: process.env, stdio: 'inherit' }); p.on('error', e => console.error('Notion sync failed', e.message)); p.on('close', () => { running = false; }); }; run(); setInterval(run, syncMinutes * 60000).unref(); }
