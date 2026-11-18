#!/usr/bin/env node
/* v25 — Audit the "every imported place shows at least 2 photos" rule.
   Read only: prints a summary and, with --out, writes a JSON report.
   Usage: npm run check:media -- [--out docs/media-coverage.json] */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const places = JSON.parse(fs.readFileSync(path.join(root, 'data', 'places.json'), 'utf8'));
const cache = JSON.parse(fs.readFileSync(path.join(root, 'data', 'google-maps-cache.json'), 'utf8'));
const args = process.argv.slice(2), outIndex = args.indexOf('--out');
const rows = [];

for (const item of places.items || []) {
  const own = [...new Set([item.cover, ...(item.images || []).map(x => x.src)].filter(Boolean))];
  const live = (cache.items?.[item.id]?.photos || []).filter(Boolean);
  const visible = [...new Set([...own, ...live])];
  const hours = cache.items?.[item.id]?.openingHours || [];
  rows.push({
    id: item.id,
    name: item.displayName || item.name || item.title,
    ownPhotos: own.length,
    googlePhotos: live.length,
    visiblePhotos: visible.length,
    openingHours: hours.length,
    needsGoogleFallback: own.length < 2,
    meetsTwoPhotoRule: visible.length >= 2
  });
}
const summary = {
  generatedAt: new Date().toISOString(),
  places: rows.length,
  ownPhotosAtLeast2: rows.filter(r => r.ownPhotos >= 2).length,
  visiblePhotosAtLeast2: rows.filter(r => r.meetsTwoPhotoRule).length,
  stillShort: rows.filter(r => !r.meetsTwoPhotoRule).map(r => r.id),
  withOpeningHours: rows.filter(r => r.openingHours > 0).length,
  withoutOpeningHours: rows.filter(r => r.openingHours === 0).length
};
console.log(JSON.stringify(summary, null, 2));
if (outIndex >= 0 && args[outIndex + 1]) {
  const target = path.resolve(root, args[outIndex + 1]);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({ summary, rows }, null, 2));
  console.log(`Report written to ${target}`);
}
