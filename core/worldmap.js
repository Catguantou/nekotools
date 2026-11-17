// 地图条目：当前地点 + 地点节点（类型/出口/可交互/常驻人物）。
// 地点由模型从世界书总结并推演；「当前」由插件每轮从状态栏写入。

import { stBridge } from './st_bridge.js';

export const MAP_TITLE = '地图';
const CURRENT_HDR = '【当前】';
const PLACES_HDR = '【地点】';

export function parseMap(content) {
    const out = { current: '', places: {} };
    let section = null;
    for (const raw of String(content || '').split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        if (line === CURRENT_HDR) { section = 'current'; continue; }
        if (line === PLACES_HDR) { section = 'places'; continue; }
        if (line.startsWith('【')) continue;

        if (section === 'current') {
            out.current = line;
            continue;
        }
        if (section === 'places') {
            const m = line.match(/^-\s*([^｜|]+)[｜|]([\s\S]*)$/);
            if (m) out.places[m[1].trim()] = m[2].trim();
        }
    }
    return out;
}

export function renderMap(data) {
    const src = data && typeof data === 'object' ? data : {};
    const lines = ['【以下为地图】', CURRENT_HDR, src.current || '（未定位）', PLACES_HDR];
    const places = src.places && typeof src.places === 'object' ? src.places : {};
    const names = Object.keys(places);
    if (!names.length) lines.push('（暂无）');
    for (const name of names) {
        const desc = String(places[name] ?? '').trim();
        if (desc) lines.push(`- ${name}｜${desc}`);
    }
    return lines.join('\n');
}

export function mapHasStructure(data) {
    return Boolean(data) && Object.keys(data.places || {}).length >= 3;
}

function findEntry(book) {
    if (!book || !book.entries) return null;
    return Object.values(book.entries).find(e => e && e.comment === MAP_TITLE) || null;
}

export async function readMap(bookName) {
    if (!bookName) return { current: '', places: {} };
    const book = await stBridge.loadWorldInfoAsync(bookName, true);
    const entry = findEntry(book);
    return entry ? parseMap(entry.content) : { current: '', places: {} };
}

/** 合并模型给的地图增量；只改地点段，不动「当前」 */
export async function applyMapOps(bookName, raw) {
    if (!raw || typeof raw !== 'object') return null;
    const book = await stBridge.loadWorldInfoAsync(bookName, true);
    if (!book || !book.entries) return null;

    const entry = findEntry(book);
    const data = parseMap(entry?.content);

    const ops = (raw.add && typeof raw.add === 'object')
        ? { add: raw.add, del: Array.isArray(raw.del) ? raw.del.map(String) : [] }
        : { add: raw, del: [] };

    for (const name of ops.del) delete data.places[name];
    for (const [name, value] of Object.entries(ops.add)) {
        const n = String(name || '').trim();
        if (!n) continue;
        const text = String(value ?? '').trim();
        if (text) data.places[n] = text;
        else delete data.places[n];
    }

    stBridge.upsertEntryInBook(book, MAP_TITLE, renderMap(data), {
        isConstant: true,
        extra: { position: 0, depth: 0, order: 830, key: [] },
    });
    await stBridge.persistLorebook(bookName, book);
    return data;
}

/** 更新「当前」行（地点/时间/层号），其余不动 */
export async function setCurrent(bookName, current) {
    if (!bookName) return false;
    const book = await stBridge.loadWorldInfoAsync(bookName, true);
    if (!book || !book.entries) return false;
    const entry = findEntry(book);
    const data = parseMap(entry?.content);
    const next = String(current || '').trim();
    if (data.current === next && entry) return false;

    data.current = next;
    stBridge.upsertEntryInBook(book, MAP_TITLE, renderMap(data), {
        isConstant: true,
        extra: { position: 0, depth: 0, order: 830, key: [] },
    });
    await stBridge.persistLorebook(bookName, book);
    return true;
}
