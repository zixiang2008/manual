import test from 'node:test';
import assert from 'node:assert/strict';
import { detailedCategory, googleNameFromResolvedUrl, normalizePlace, shortMemoryLabel, shortPlaceName } from '../scripts/place-taxonomy.mjs';

test('Chinese name wins in a mixed-language Google name', () => {
  assert.equal(shortPlaceName('藏咖啡 Zang Cafe ร้านกาแฟ'), '藏咖啡');
});

test('English is retained and Thai is removed in a mixed name', () => {
  assert.equal(shortPlaceName('Transit Number ทรานซิท นัมเบอร์'), 'Transit Number');
});

test('meaningful leading digits in a brand name are preserved', () => {
  assert.equal(shortPlaceName('2STREETCOFFEECREW'), '2STREETCOFFEECREW');
  assert.equal(normalizePlace({ title: 'DJ咖啡‖2STREETCOFFEECREW', category: '咖啡馆', nameOverride: '2STREETCOFFEECREW' }, '2STREETCOFFEECREW').title, 'DJ咖啡 // 2STREETCOFFEECREW // 古城咖啡');
});

test('Thai-only names use the shortest main segment', () => {
  assert.equal(shortPlaceName('ร้านกาแฟ บ้านต้นไม้ เชียงใหม่ ประเทศไทย'), 'ร้านกาแฟ บ้านต้นไม้ ประเทศไทย');
});

test('normalization keeps the personal label first and detailed category last', () => {
  const item = normalizePlace({ title: '河边喝咖啡‖旧名称', category: '一，宝藏咖啡馆', hint: '河边喝咖啡', description: '萍河旁的花园' }, 'The Baristro x Ping River');
  assert.equal(item.title, '河边喝咖啡 // The Baristro x Ping River // 自然咖啡');
  assert.deepEqual(item.tags, ['河边喝咖啡', '自然咖啡']);
  assert.equal(item.memoryKeyword, '河边喝咖啡');
});

test('memory labels stay meaningful within six characters', () => {
  assert.equal(shortMemoryLabel('吴彦祖烤肉'), '吴彦祖烤肉');
  assert.equal(shortMemoryLabel('5分钟瀑布咖啡'), '瀑布咖啡');
  assert.equal(shortMemoryLabel('Super Soup 旁🇯🇵高级烤肉'), '旁高级烤肉');
});

test('restaurant and coffee categories are refined', () => {
  assert.equal(detailedCategory({ category: '七，肉｜蛋白质｜中餐饮食' }, '吴彦祖烤肉'), '肉食');
  assert.equal(detailedCategory({ category: '六，碳水&泰餐' }, '川菜馆'), '中餐');
  assert.equal(detailedCategory({ category: '咖啡馆', location: { lat: 18.7967, lng: 98.9676 } }, '咖啡'), '宁曼咖啡');
  assert.equal(detailedCategory({ category: '咖啡馆', location: { lat: 18.95, lng: 98.8 } }, '咖啡'), '自然咖啡');
});

test('Google query extraction stops before the street address', () => {
  const url = 'https://www.google.com/maps?q=%E0%B8%81%E0%B8%B0%E0%B9%80%E0%B8%9E%E0%B8%A3%E0%B8%B2%E0%B8%82%E0%B8%B5%E0%B9%89%E0%B9%80%E0%B8%A1%E0%B8%B2+%E0%B8%99%E0%B9%89%E0%B8%B3%E0%B8%A5%E0%B8%B5%E0%B9%89+222+12+Pa+Daet+Sub-district,+Mueang+Chiang+Mai';
  assert.equal(googleNameFromResolvedUrl(url), 'กะเพราขี้เมา น้ำลี้');
});
