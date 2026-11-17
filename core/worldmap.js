// 三级地图：大地图（区域/国家）→ 中地图（城市/地区）→ 小地点（可探索节点）。
// 「当前」由插件每轮从状态栏写入；层级节点由模型增删。

import { stBridge } from './st_bridge.js';

export const MAP_TITLE = '地图';
const CURRENT_HDR = '【当前】';
const REGIONS_HDR = '【大地图】';
const CITY_PREFIX = '【中地图·';
const SITE_PREFIX = '【小地点·';

function splitParts(line) {
    return String(line || '').split('｜').map(s => s.trim());
}

function parsePlaceDesc(desc) {
    const parts = splitParts(desc);
    const out = { direction: '', type: '', desc: '' };
    const rest = [];
    for (const part of parts) {
        if (!part) continue;
        if (part.startsWith('方位')) out.direction = part.replace(/^方位[：:]\s*/, '');
        else if (!out.type) out.type = part;
        else rest.push(part);
    }
    out.desc = rest.join('｜');
    return out;
}

function parseSiteDesc(desc) {
    const parts = splitParts(desc);
    const out = { direction: '', type: '', exits: [], interact: '', regulars: '' };
    for (const part of parts) {
        if (!part) continue;
        if (part.startsWith('方位')) {
            out.direction = part.replace(/^方位[：:]\s*/, '');
        } else if (part.startsWith('出口')) {
            out.exits = part.replace(/^出口[：:]\s*/, '').split(/[、,，]/).map(s => s.trim()).filter(Boolean);
        } else if (part.startsWith('可交互')) {
            out.interact = part.replace(/^可交互[：:]\s*/, '');
        } else if (part.startsWith('常驻')) {
            out.regulars = part.replace(/^常驻[：:]\s*/, '');
        } else if (!out.type) {
            out.type = part;
        }
    }
    return out;
}

export function parseMap(content) {
    const data = { current: '', regions: {}, cities: {}, sites: {} };
    let section = null;
    let parent = '';

    for (const raw of String(content || '').split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        if (line === CURRENT_HDR) { section = 'current'; continue; }
        if (line === REGIONS_HDR) { section = 'regions'; parent = ''; continue; }
        // 旧版平铺格式：地点直接挂在【地点】下
        if (line === '【地点】') { section = 'sites'; parent = '未命名城市'; continue; }
        if (line.startsWith(CITY_PREFIX)) {
            section = 'cities';
            parent = line.slice(CITY_PREFIX.length, -1).trim();
            continue;
        }
        if (line.startsWith(SITE_PREFIX)) {
            section = 'sites';
            parent = line.slice(SITE_PREFIX.length, -1).trim();
            continue;
        }
        if (line.startsWith('【')) continue;

        if (section === 'current') {
            data.current = line;
            continue;
        }

        const m = line.match(/^-\s*([^｜|]+)[｜|]([\s\S]*)$/);
        if (!m) continue;
        const name = m[1].trim();
        const rest = m[2].trim();

        if (section === 'regions') {
            data.regions[name] = parsePlaceDesc(rest);
        } else if (section === 'cities') {
            data.cities[name] = { region: parent, ...parsePlaceDesc(rest) };
        } else if (section === 'sites') {
            data.sites[name] = { city: parent, ...parseSiteDesc(rest) };
        }
    }
    return data;
}

export function renderMap(data) {
    const src = data && typeof data === 'object' ? data : {};
    const regions = src.regions || {};
    const cities = src.cities || {};
    const sites = src.sites || {};

    const lines = ['【以下为地图】', CURRENT_HDR, src.current || '（未定位）', REGIONS_HDR];
    const regionNames = Object.keys(regions);
    if (!regionNames.length) lines.push('（暂无）');
    for (const name of regionNames) {
        const r = regions[name] || {};
        lines.push(`- ${name}｜${r.direction ? `方位：${r.direction}｜` : ''}${r.type || ''}｜${r.desc || ''}`);
    }

    for (const regionName of regionNames) {
        const list = Object.keys(cities).filter(c => cities[c] && cities[c].region === regionName);
        lines.push(`${CITY_PREFIX}${regionName}】`);
        if (!list.length) lines.push('（暂无）');
        for (const cityName of list) {
            const c = cities[cityName] || {};
            lines.push(`- ${cityName}｜${c.direction ? `方位：${c.direction}｜` : ''}${c.type || ''}｜${c.desc || ''}`);
        }
    }

    for (const cityName of Object.keys(cities)) {
        const list = Object.keys(sites).filter(s => sites[s] && sites[s].city === cityName);
        lines.push(`${SITE_PREFIX}${cityName}】`);
        if (!list.length) lines.push('（暂无）');
        for (const siteName of list) {
            const s = sites[siteName] || {};
            const bits = [`- ${siteName}`];
            if (s.direction) bits.push(`方位：${s.direction}`);
            if (s.type) bits.push(s.type);
            if (s.exits && s.exits.length) bits.push(`出口：${s.exits.join('、')}`);
            if (s.interact) bits.push(`可交互：${s.interact}`);
            if (s.regulars) bits.push(`常驻：${s.regulars}`);
            lines.push(bits.join('｜'));
        }
    }

    return lines.join('\n');
}

export function mapHasStructure(data) {
    if (!data) return false;
    const realRegions = Object.keys(data.regions || {}).filter(n => n !== '未命名区域');
    const realCities = Object.keys(data.cities || {}).filter(n => n !== '未命名城市');
    return realRegions.length >= 1
        && realCities.length >= 1
        && Object.keys(data.sites || {}).length >= 3;
}

/** 当前地点属于哪个区域/城市 */
export function findPath(data, place) {
    const name = String(place || '').trim();
    if (!name) return {};
    if (data.sites && data.sites[name]) {
        const city = data.sites[name].city;
        const region = data.cities && data.cities[city] ? data.cities[city].region : '';
        return { region, city, site: name };
    }
    if (data.cities && data.cities[name]) {
        return { region: data.cities[name].region, city: name, site: '' };
    }
    if (data.regions && data.regions[name]) {
        return { region: name, city: '', site: '' };
    }
    return { region: '', city: '', site: name };
}

function findEntry(book) {
    if (!book || !book.entries) return null;
    return Object.values(book.entries).find(e => e && e.comment === MAP_TITLE) || null;
}

export async function readMap(bookName) {
    if (!bookName) return { current: '', regions: {}, cities: {}, sites: {} };
    const book = await stBridge.loadWorldInfoAsync(bookName, true);
    const entry = findEntry(book);
    return entry ? parseMap(entry.content) : { current: '', regions: {}, cities: {}, sites: {} };
}

export async function setCurrent(bookName, clock, layer = 0) {
    if (!bookName) return false;
    const book = await stBridge.loadWorldInfoAsync(bookName, true);
    if (!book || !book.entries) return false;

    const entry = findEntry(book);
    const data = parseMap(entry?.content);
    const place = clock && clock.place ? String(clock.place).trim() : '';
    const path = findPath(data, place);
    const bits = [];
    if (path.region) bits.push(path.region);
    if (path.city) bits.push(path.city);
    if (place) bits.push(place);
    if (clock && clock.time) bits.push(clock.time);
    if (clock && clock.weather) bits.push(clock.weather);
    if (layer > 0) bits.push(`第 ${layer} 层`);
    const next = bits.join('｜');

    if (data.current === next && entry) return false;
    data.current = next;
    stBridge.upsertEntryInBook(book, MAP_TITLE, renderMap(data), {
        isConstant: true,
        extra: { position: 0, depth: 0, order: 830, key: [] },
    });
    await stBridge.persistLorebook(bookName, book);
    return true;
}

function ensureRegion(data, regionName) {
    if (!data.regions[regionName]) data.regions[regionName] = { type: '', desc: '' };
    return data.regions[regionName];
}

function ensureCity(data, regionName, cityName) {
    ensureRegion(data, regionName);
    if (!data.cities[cityName]) data.cities[cityName] = { region: regionName, type: '', desc: '' };
    return data.cities[cityName];
}

/** 合并模型给的地图增量；regions/cities/sites 可嵌套，也兼容旧的 add/del 平铺 */
export async function applyMapOps(bookName, raw) {
    if (!raw || typeof raw !== 'object') return null;
    const book = await stBridge.loadWorldInfoAsync(bookName, true);
    if (!book || !book.entries) return null;

    const entry = findEntry(book);
    const data = parseMap(entry?.content);

    const regions = raw.regions && typeof raw.regions === 'object' ? raw.regions : {};
    const cities = raw.cities && typeof raw.cities === 'object' ? raw.cities : {};
    const sites = raw.sites && typeof raw.sites === 'object' ? raw.sites : {};
    const del = raw.del && typeof raw.del === 'object' ? raw.del : {};

    for (const [regionName, desc] of Object.entries(regions)) {
        data.regions[regionName] = parsePlaceDesc(desc);
    }
    for (const [regionName, cityBlock] of Object.entries(cities)) {
        if (!cityBlock || typeof cityBlock !== 'object' || Array.isArray(cityBlock)) continue;
        ensureRegion(data, regionName);
        for (const [cityName, desc] of Object.entries(cityBlock)) {
            data.cities[cityName] = { region: regionName, ...parsePlaceDesc(desc) };
        }
    }
    for (const [cityName, siteBlock] of Object.entries(sites)) {
        if (!siteBlock || typeof siteBlock !== 'object') continue;
        if (!data.cities[cityName]) ensureCity(data, Object.keys(data.regions)[0] || '未命名区域', cityName);
        for (const [siteName, desc] of Object.entries(siteBlock)) {
            data.sites[siteName] = { city: cityName, ...parseSiteDesc(desc) };
        }
    }

    for (const name of Array.isArray(del.regions) ? del.regions : []) {
        delete data.regions[name];
        const removedCities = new Set();
        for (const [cityName, city] of Object.entries(data.cities)) {
            if (city.region === name) {
                removedCities.add(cityName);
                delete data.cities[cityName];
            }
        }
        for (const [siteName, site] of Object.entries(data.sites)) {
            if (removedCities.has(site.city)) delete data.sites[siteName];
        }
    }
    for (const name of Array.isArray(del.cities) ? del.cities : []) {
        delete data.cities[name];
        for (const [siteName, site] of Object.entries(data.sites)) {
            if (site.city === name) delete data.sites[siteName];
        }
    }
    for (const name of Array.isArray(del.sites) ? del.sites : []) {
        delete data.sites[name];
    }

    // 旧平铺：add/del 的地点直接当小地点
    if (raw.add && typeof raw.add === 'object') {
        const cityName = Object.keys(data.cities)[0] || '未命名城市';
        if (!data.cities[cityName]) ensureCity(data, Object.keys(data.regions)[0] || '未命名区域', cityName);
        for (const [siteName, desc] of Object.entries(raw.add)) {
            data.sites[siteName] = { city: cityName, ...parseSiteDesc(desc) };
        }
    }
    for (const name of Array.isArray(raw.del) ? raw.del : []) delete data.sites[name];

    stBridge.upsertEntryInBook(book, MAP_TITLE, renderMap(data), {
        isConstant: true,
        extra: { position: 0, depth: 0, order: 830, key: [] },
    });
    await stBridge.persistLorebook(bookName, book);
    return data;
}

/** 旧版平铺地图迁移成三级结构 */
export async function migrateMap(bookName) {
    try {
        const book = await stBridge.loadWorldInfoAsync(bookName, true);
        if (!book || !book.entries) return;
        const entry = findEntry(book);
        if (!entry) return;
        const content = String(entry.content || '');
        if (content.includes(REGIONS_HDR)) return;

        const old = parseMap(content);
        const regionName = '未命名区域';
        const cityName = '未命名城市';
        const data = { current: old.current, regions: {}, cities: {}, sites: {} };
        data.regions[regionName] = { type: '区域', desc: '' };
        data.cities[cityName] = { region: regionName, type: '城市', desc: '' };
        for (const [siteName, site] of Object.entries(old.sites || {})) {
            data.sites[siteName] = { ...site, city: cityName };
        }
        stBridge.upsertEntryInBook(book, MAP_TITLE, renderMap(data), {
            isConstant: true,
            extra: { position: 0, depth: 0, order: 830, key: [] },
        });
        await stBridge.persistLorebook(bookName, book);
        console.log('[worldsim] 旧地图已迁移为 大地图/中地图/小地点');
    } catch (e) {
        console.warn('[worldsim] 地图迁移失败', e);
    }
}
