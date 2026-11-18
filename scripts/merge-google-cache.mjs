#!/usr/bin/env node
/* v25 — Merge a fresh Google scrape into the maintained cache without losing
   previously verified fields when the new page has missing data or an error.
   Usage: node scripts/merge-google-cache.mjs <fresh.json> [target=data/google-maps-cache.json] */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [freshArg, targetArg] = process.argv.slice(2);
if (!freshArg) throw new Error('Usage: node scripts/merge-google-cache.mjs <fresh.json> [target.json]');
const freshPath = path.resolve(root, freshArg), targetPath = path.resolve(root, targetArg || 'data/google-maps-cache.json');
const fresh = JSON.parse(fs.readFileSync(freshPath, 'utf8')), target = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
const fields = ['address', 'phone', 'website', 'category', 'googleMapsUrl', 'reservable'];
const arrayFields = ['openingHours', 'photos'];
const genericNames = new Set(['结果', '清邁', '清迈', '赞助商', 'unnamed']);
const nonEmpty = value => Array.isArray(value) ? value.length > 0 : value !== null && value !== undefined && String(value).trim() !== '';

let added = 0, updated = 0, kept = 0;
for (const [id, freshRow] of Object.entries(fresh.items || {})) {
  if (freshRow.error || freshRow.unavailable) { kept++; continue; }
  // A generic search-results page is not a verified place: never clear an existing unavailable flag with it.
  if (genericNames.has(freshRow.name)) { kept++; continue; }
  const old = target.items?.[id];
  if (!old) { target.items[id] = freshRow; added++; continue; }
  let changed = false;
  // Scalars: only fill gaps, never overwrite a previously verified value.
  for (const field of fields) {
    if (nonEmpty(freshRow[field]) && !nonEmpty(old[field])) { old[field] = freshRow[field]; changed = true; }
  }
  // Arrays: keep whichever list carries more verified detail.
  for (const field of arrayFields) {
    const freshList = freshRow[field] || [], oldList = old[field] || [];
    if (freshList.length > oldList.length) { old[field] = freshList; changed = true; }
  }
  // Name: replace only when the stored name is a generic search-results label.
  if (nonEmpty(freshRow.name) && (!old.name || genericNames.has(old.name)) && !genericNames.has(freshRow.name)) { old.name = freshRow.name; changed = true; }
  old.refreshedAt = freshRow.scrapedAt || old.scrapedAt;
  if (changed) updated++; else kept++;
}
target.generatedAt = new Date().toISOString();
target.quality = { ...(target.quality || {}), lastMergedAt: target.generatedAt, mergeSource: path.basename(freshPath) };
fs.writeFileSync(targetPath, JSON.stringify(target, null, 2) + '\n');
console.log(JSON.stringify({ added, updated, kept, total: Object.keys(target.items).length, output: targetPath }, null, 2));
