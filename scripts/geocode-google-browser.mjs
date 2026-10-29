import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const dataPath = fileURLToPath(new URL('../data/places.json', import.meta.url));
const cachePath = fileURLToPath(new URL('../data/geo-cache.json', import.meta.url));
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const concurrency = Math.max(1, Math.min(3, Number(process.env.GEOCODE_CONCURRENCY || 2)));
const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
const cache = (() => { try { return JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch { return {}; } })();
const pending = data.items.filter(item => !item.location && item.maps?.[0]);

function atomicWrite(file, value) {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, file);
}
function persist() { atomicWrite(dataPath, data); atomicWrite(cachePath, cache); }

const browser = await puppeteer.launch({ headless: true, executablePath: chrome, args: ['--no-sandbox'] });
let cursor = 0, completed = 0;
async function worker(workerId) {
  while (cursor < pending.length) {
    const item = pending[cursor++];
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(30000);
    try {
      await page.goto(item.maps[0], { waitUntil: 'domcontentloaded' });
      await new Promise(resolve => setTimeout(resolve, 1800));
      await page.waitForFunction(() => !!window.APP_INITIALIZATION_STATE, { timeout: 10000 });
      const location = await page.evaluate(() => {
        const pairs = [];
        function walk(value) {
          if (!value || typeof value !== 'object') return;
          if (Array.isArray(value)) {
            for (let index = 0; index < value.length - 1; index++) {
              const a = Number(value[index]), b = Number(value[index + 1]);
              if (a >= 5 && a <= 22 && b >= 97 && b <= 106) pairs.push({ lat: a, lng: b });
              else if (a >= 97 && a <= 106 && b >= 5 && b <= 22) pairs.push({ lat: b, lng: a });
            }
            value.forEach(walk);
          } else Object.values(value).forEach(walk);
        }
        walk(window.APP_INITIALIZATION_STATE);
        return pairs[0] || null;
      });
      if (location) {
        item.location = location;
        cache[item.id] = { provider: 'google-maps-page', displayName: item.name, location, googleMapsUri: item.maps[0], resolvedAt: new Date().toISOString() };
      } else console.error(`[${workerId}] no coordinates: ${item.name}`);
    } catch (error) { console.error(`[${workerId}] failed ${item.name}: ${error.message}`); }
    finally { await page.close().catch(() => {}); }
    completed++;
    if (completed % 10 === 0) { persist(); console.log(`${completed}/${pending.length}`); }
  }
}

try { await Promise.all(Array.from({ length: concurrency }, (_, index) => worker(index + 1))); persist(); }
finally { await browser.close(); }
console.log(`Geocoded ${data.items.filter(item => item.location).length}/${data.items.length} places`);
