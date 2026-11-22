#!/usr/bin/env node
// 把小红书解析结果导入清迈生活手册收藏库。
// 用法见 skills/xhs-to-collection/SKILL.md
// 环境变量：IMPORT_TOKEN（必需，与服务端一致）；CM_BASE（可选，默认 https://cm.caishen.today）
import process from 'node:process';

const args = process.argv.slice(2);
const get = (name, fallback = '') => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

const base = (process.env.CM_BASE || 'https://cm.caishen.today').replace(/\/$/, '');
const token = process.env.IMPORT_TOKEN || '';

if (!token) { console.error('缺少 IMPORT_TOKEN 环境变量'); process.exit(2); }
if (args.includes('--help') || args.includes('-h')) {
  console.log(`用法: node scripts/import-from-xhs.mjs --title '店名' --maps 'Google地图链接' [选项]
  --title    店名 / 标题（必填，除非提供 --desc）
  --desc     正文描述
  --address  详细地址
  --maps     Google 地图链接（必填，仅接受 maps.app.goo.gl / google.com/maps）
  --category 分类（默认 推荐）
  --photos   图片 URL，多个用英文逗号分隔（最多 6 张）
  --source   小红书原文链接（溯源用）
  --reason   推荐原因短标签（默认取标题）`);
  process.exit(0);
}

const payload = {
  title: get('--title'),
  description: get('--desc'),
  address: get('--address'),
  mapsUrl: get('--maps'),
  category: get('--category', '推荐'),
  reasonTag: get('--reason'),
  sourceUrl: get('--source'),
  photos: get('--photos').split(',').map(x => x.trim()).filter(Boolean),
};

if (!payload.mapsUrl) { console.error('缺少 --maps（Google 地图链接）'); process.exit(2); }
if (!payload.title && !payload.description) { console.error('至少提供 --title 或 --desc'); process.exit(2); }

try {
  const res = await fetch(`${base}/api/import/place`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 201) {
    console.log(`✓ 已收藏：${data.item?.name || payload.title}`);
    console.log(`  分类：${data.item?.category || payload.category}`);
  } else if (res.status === 409) {
    console.log(`= 已存在，未重复导入：${payload.title}`);
  } else {
    console.error(`✗ 导入失败（HTTP ${res.status}）：${data.error || JSON.stringify(data)}`);
    process.exit(1);
  }
} catch (err) {
  console.error(`✗ 请求失败：${err.message}`);
  process.exit(1);
}
