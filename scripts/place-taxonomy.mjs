const clean = value => String(value || '').replace(/[\u200b\u200e\u200f]/g, '').replace(/\s+/g, ' ').trim();

const OLD_CITY = { lat: 18.7883, lng: 98.9853 };
const NIMMAN = { lat: 18.7967, lng: 98.9676 };

function distanceKm(a, b) {
  if (!Number.isFinite(Number(a?.lat)) || !Number.isFinite(Number(a?.lng))) return null;
  const rad = value => value * Math.PI / 180, dLat = rad(Number(a.lat) - b.lat), dLng = rad(Number(a.lng) - b.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(b.lat)) * Math.cos(rad(Number(a.lat))) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

const primaryRules = [
  [/咖啡|宁曼|大自然|落日|宝藏好喝/i, '咖啡'], [/Party|活动|Yuga/i, '活动'], [/市集/i, '市集'],
  [/自助|火锅|จิ้มจุ่ม/i, '火锅'], [/酒吧|DJ/i, '酒吧'], [/温泉|spa/i, '康养'],
  [/碳水|泰餐|Brunch|减脂|肉|蛋白质|中餐|巷子/i, '餐厅'], [/GYM|Fitness|按摩|Playing/i, '运动'],
  [/一小时|湄林|周边好玩/i, '周边游'], [/Hostels/i, '住宿'], [/租车/i, '租车'],
  [/换汇/i, '生活'], [/财绅在哪里/i, '收藏'], [/维修/i, '维修'], [/紧急/i, '应急'], [/手册/i, '攻略']
];

const secondaryRules = [
  [/宁曼|Nimman/i, '宁曼'], [/古城|Old\s*Town/i, '古城'], [/河边|萍河|Ping River/i, '河边'],
  [/长康|Chang Khlan/i, '长康'], [/塔佩|Tha Phae/i, '塔佩'], [/杭东|Hang Dong/i, '杭东'],
  [/湄林|Mae Rim/i, '湄林'], [/南奔|Lamphun/i, '南奔'], [/清道|Chiang Dao/i, '清道'],
  [/清迈大学|CMU|大学/i, '大学'], [/家后面|家附近|家门口/i, '家附近'], [/机场/i, '机场'],
  [/落日|日落|rooftop|楼顶|夜景/i, '落日'], [/花园|庭院|院子|大树|树林|自然|瀑布|湖|水库|山林/i, '自然'],
  [/DJ|live\s*music|livehouse|驻唱|音乐/i, '音乐'], [/办公|co.?working/i, '办公'], [/亲子|playground/i, '亲子'],
  [/日式|Japanese/i, '日式'], [/中餐|川菜|粤菜|广东|港式|麻辣/i, '中餐'], [/泰餐|Thai/i, '泰餐'],
  [/素食|减脂|Smoothie|salad/i, '轻食'], [/烧肉|烤肉|BBQ|牛肉|猪肉|鸡/i, '肉食'], [/按摩|Massage/i, '按摩'],
  [/瑜伽|Yoga|声浴|冥想/i, '疗愈'], [/夜市|市集|market/i, '市集'], [/面包|蛋糕|甜|dessert|bakery/i, '甜品']
];

export function primaryTag(category = '', text = '') {
  return primaryRules.find(([pattern]) => pattern.test(`${category} ${text}`))?.[1] || '推荐';
}

export function secondaryTag(text = '', primary = '推荐') {
  return secondaryRules.find(([pattern]) => pattern.test(text))?.[1] || ({ '咖啡': '休闲', '餐厅': '好吃', '活动': '体验', '酒吧': '夜生活', '运动': '健康', '周边游': '自然', '攻略': '实用' }[primary] || '实用');
}

export function shortMemoryLabel(value = '') {
  let text = clean(value).split(/\s*@\s*/)[0]
    .replace(/\d+(?:\.\d+)?\s*(?:公里|km|分钟|米)/ig, '')
    .replace(/\b(?:am|pm)\s*\d{1,2}(?::\d{1,2})?/ig, '')
    .replace(/[\p{Extended_Pictographic}\uFE0F]/gu, '').trim();
  const han = text.match(/[\p{Script=Han}\d]+/gu)?.join('') || '';
  const acronym = text.match(/^([A-Za-z]{1,3})(?=[^A-Za-z]|$)(?=.*\p{Script=Han})/u)?.[1] || '';
  if (han) return [...`${acronym}${han}`].slice(0, 6).join('') || '推荐';
  const thai = text.match(/[\p{Script=Thai}\d]+/gu)?.join('') || '';
  if (thai) return [...thai].slice(0, 6).join('');
  return [...text.replace(/[^A-Za-z0-9]+/g, '')].slice(0, 6).join('') || '推荐';
}

export function detailedCategory(item, context = '') {
  const base = primaryTag(item.category, context), details = String(context || ''), text = `${item.category || ''} ${details}`;
  if (base === '咖啡') {
    const oldCityDistance = distanceKm(item.location, OLD_CITY);
    const nimmanDistance = distanceKm(item.location, NIMMAN);
    if ((oldCityDistance !== null && oldCityDistance > 15) || /大自然|瀑布|山|森林|湖|水库|田野|花园|悬崖|落日/i.test(text)) return '自然咖啡';
    if (/宁曼|Nimman/i.test(text) || (nimmanDistance !== null && nimmanDistance <= 2.2)) return '宁曼咖啡';
    return '古城咖啡';
  }
  if (base === '餐厅' || base === '火锅') {
    if (/素食|纯素|vegan|vegetarian|plant.?based|\bเจ\b/i.test(details)) return '素食';
    if (/牛舌|烧肉|烤肉|yakiniku|horumon/i.test(details)) return '肉食';
    if (/火锅|自助|寿喜烧|shabu|sukiyaki|จิ้มจุ่ม/i.test(text)) return '火锅';
    if (/中餐|川菜|粤菜|广东|港式|麻辣|饺子|包子|牛肉面|兰州|Chinese/i.test(details)) return '中餐';
    if (/日式|日料|寿司|拉面|居酒屋|Japanese|sushi|ramen|izakaya|horumon/i.test(details)) return '日料';
    if (/泰餐|冬阴|打抛|泰北|Khao\s*Soi|Thai|\p{Script=Thai}/iu.test(details) && !/牛舌|烧肉|烤肉/i.test(details)) return '泰餐';
    if (/素食|减脂|沙拉|Brunch|salad|smoothie/i.test(details)) return '轻食';
    if (/甜品|面包|蛋糕|dessert|bakery/i.test(details)) return '甜品';
    if (/肉|蛋白质|牛|猪|鸡|烧肉|烤肉|牛舌|BBQ|steak|beef|pork|grill|yakiniku/i.test(details) || /肉｜蛋白质/.test(item.category || '')) return '肉食';
    if (/碳水|泰餐/.test(item.category || '')) return '泰餐';
    return '美食';
  }
  const rules = [
    [/酒吧/i, '酒吧'], [/温泉|spa/i, '康养'], [/GYM|Fitness/i, '健身'], [/按摩/i, '按摩'], [/市集/i, '市集'], [/活动|Yuga|Party/i, '活动'], [/周边|一小时|湄林/i, '周边'], [/Hostels/i, '住宿'], [/租车/i, '租车'], [/DJ/i, '音乐'], [/换汇/i, '换汇'], [/维修/i, '维修'], [/紧急/i, '应急'], [/手册/i, '攻略']
  ];
  return rules.find(([pattern]) => pattern.test(text))?.[1] || secondaryTag(text, base).slice(0, 3);
}

function onlyHan(value) {
  const parts = clean(value).match(/[\p{Script=Han}][\p{Script=Han}\d·・&.'’-]*/gu) || [];
  return clean(parts.join(' '));
}

function onlyLatin(value) {
  return clean(value.replace(/[\p{Script=Thai}]+/gu, ' ').replace(/[\p{Script=Han}]+/gu, ' ').replace(/\([^)]*[\p{Script=Thai}\p{Script=Han}][^)]*\)/gu, ' '));
}

export function shortPlaceName(value = '') {
  let name = clean(value).replace(/\s+\d{1,4}(?:[/.-]\d+)*\s+(?:Soi|ถนน|หมู่|Tambon|ตำบล|Mueang|Amphoe|Road|Rd\b).*$/iu, '');
  const han = onlyHan(name), hasLatin = /[A-Za-z]/.test(name), hasThai = /\p{Script=Thai}/u.test(name);
  if (han) return han.slice(0, 26);
  if (hasLatin) {
    name = onlyLatin(name)
      .replace(/\bChiang\s*Mai\b/ig, '').replace(/\b(?:Authentic\s+)?Thai\s+Food\s+Restaurant\b/ig, '')
      .replace(/\bCafe\s*&\s*Coffee\s*shop\b/ig, 'Cafe').replace(/\bCoffee\s*Shop\b/ig, '')
      .replace(/\bRestaurant\b$/i, '').replace(/\s*[-|:]{1,2}\s*$/g, '');
    return clean(name).slice(0, 42);
  }
  if (hasThai) return clean(name.replace(/เชียงใหม่/g, '')).split(' ').filter(Boolean).slice(0, 3).join(' ').slice(0, 30);
  return name.slice(0, 30) || '未命名地点';
}

export function googleNameFromResolvedUrl(value = '') {
  try {
    const url = new URL(value), raw = url.searchParams.get('q') || decodeURIComponent(url.pathname).match(/\/place\/([^/]+)/)?.[1] || '';
    const withoutAddress = clean(raw.replaceAll('+', ' ')).replace(/\s+\d{1,5}(?:[\s/-]+\d{1,5})?\s+(?=[\p{L}])/u, '\n').split('\n')[0];
    const parts = withoutAddress.split(',').map(clean).filter(Boolean);
    while (parts.length && /^[\d\s./-]+$/.test(parts[0])) parts.shift();
    return shortPlaceName(parts[0] || raw);
  } catch { return ''; }
}

export function normalizePlace(item, googleName = '') {
  const sourceTitle = clean(item.sourceTitle || item.title), rawParts = sourceTitle.split(/\s*(?:\/\/|\|\||‖)\s*/).map(clean).filter(Boolean), context = [sourceTitle, item.memoryKeyword, item.hint, item.description, item.name].filter(Boolean).join(' ');
  const rawName = rawParts.length >= 3 ? rawParts.slice(1, -1).join(' ') : rawParts.at(-1) || rawParts[0];
  const memoryKeyword = clean(item.memoryKeyword || rawParts[0] || item.hint), memoryLabel = shortMemoryLabel(memoryKeyword);
  let name = shortPlaceName(googleName || item.name || rawName);
  if (/\b(?:Sub-?district|District|Province|Tambon|Amphoe|Road|Rd)\b/i.test(name)) name = shortPlaceName(item.name || rawParts.at(-1) || rawParts[0]);
  if (!name || /^(?:Pm|Am)?\s*\d{1,2}(?::|\s*(?:Pm|Am)\b)/i.test(name)) name = shortPlaceName(rawParts.find(part => /[A-Za-z\p{Script=Thai}\p{Script=Han}]/u.test(part)) || sourceTitle);
  const type = detailedCategory({ ...item, name }, context);
  return { sourceTitle, memoryKeyword, memoryLabel, displayName: name, name, title: `${memoryLabel} // ${name} // ${type}`, tags: [memoryLabel, type], detailCategory: type };
}
