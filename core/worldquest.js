// 主线 / 支线：主线常驻一条，支线聚合成一条；都由模型自动推进，不给玩家做选择。

import { stBridge } from './st_bridge.js';

export const MAIN_TITLE = '主线';
export const QUEST_TITLE = '支线';
const MAIN_FIELDS = ['标题', '目标', '阶段', '进度', '失败代价', '下一步'];

function findEntry(book, title) {
    if (!book || !book.entries) return null;
    return Object.values(book.entries).find(e => e && e.comment === title) || null;
}

export function parseMain(content) {
    const out = {};
    for (const raw of String(content || '').split('\n')) {
        const m = raw.trim().match(/^([^：:]{1,8})[：:]\s*(.*)$/);
        if (!m) continue;
        out[m[1].trim()] = m[2].trim();
    }
    return out;
}

export function renderMain(main) {
    const src = main && typeof main === 'object' ? main : {};
    const lines = ['【以下为主线】'];
    for (const key of MAIN_FIELDS) {
        const value = String(src[key] ?? '').trim();
        if (value) lines.push(`${key}：${value}`);
    }
    if (lines.length === 1) lines.push('（未生成）');
    return lines.join('\n');
}

export function mainHasContent(main) {
    return Boolean(main && (String(main['标题'] || '').trim() || String(main['目标'] || '').trim()));
}

export function clampProgress(value) {
    const n = parseInt(String(value ?? '').replace(/[^\d]/g, ''), 10);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(100, n));
}

export async function readMain(bookName) {
    if (!bookName) return {};
    const book = await stBridge.loadWorldInfoAsync(bookName, true);
    const entry = findEntry(book, MAIN_TITLE);
    return entry ? parseMain(entry.content) : {};
}

export async function applyMain(bookName, raw) {
    if (!raw) return null;
    const book = await stBridge.loadWorldInfoAsync(bookName, true);
    if (!book || !book.entries) return null;
    const entry = findEntry(book, MAIN_TITLE);
    const old = entry ? parseMain(entry.content) : {};
    const incoming = typeof raw === 'string' ? { '目标': raw } : raw;
    const merged = { ...old };
    for (const key of MAIN_FIELDS) {
        if (incoming[key] === undefined || incoming[key] === null) continue;
        const value = String(incoming[key]).trim();
        if (value) merged[key] = value;
    }
    merged['进度'] = clampProgress(merged['进度']);

    stBridge.upsertEntryInBook(book, MAIN_TITLE, renderMain(merged), {
        isConstant: true,
        extra: { position: 0, depth: 0, order: 810, key: [] },
    });
    await stBridge.persistLorebook(bookName, book);
    return merged;
}

export function parseQuests(content) {
    const out = {};
    for (const raw of String(content || '').split('\n')) {
        const line = raw.trim();
        const m = line.match(/^-\s*([^｜|]+)[｜|]([\s\S]*)$/);
        if (m) out[m[1].trim()] = m[2].trim();
    }
    return out;
}

export function renderQuests(quests) {
    const src = quests && typeof quests === 'object' ? quests : {};
    const names = Object.keys(src);
    const lines = ['【以下为支线】'];
    if (!names.length) lines.push('（暂无）');
    for (const name of names) {
        const value = String(src[name] ?? '').trim();
        if (value) lines.push(`- ${name}｜${value}`);
    }
    return lines.join('\n');
}

export async function readQuests(bookName) {
    if (!bookName) return {};
    const book = await stBridge.loadWorldInfoAsync(bookName, true);
    const entry = findEntry(book, QUEST_TITLE);
    return entry ? parseQuests(entry.content) : {};
}

export async function applyQuests(bookName, raw) {
    if (!raw || typeof raw !== 'object') return null;
    const book = await stBridge.loadWorldInfoAsync(bookName, true);
    if (!book || !book.entries) return null;
    const entry = findEntry(book, QUEST_TITLE);
    const data = entry ? parseQuests(entry.content) : {};

    const ops = (raw.add && typeof raw.add === 'object')
        ? { add: raw.add, del: Array.isArray(raw.del) ? raw.del.map(String) : [] }
        : { add: raw, del: [] };

    for (const name of ops.del) delete data[name];
    for (const [name, value] of Object.entries(ops.add)) {
        const n = String(name || '').trim();
        if (!n) continue;
        const text = String(value ?? '').trim();
        if (text) data[n] = text;
        else delete data[n];
    }

    stBridge.upsertEntryInBook(book, QUEST_TITLE, renderQuests(data), {
        isConstant: true,
        extra: { position: 0, depth: 0, order: 812, key: [] },
    });
    await stBridge.persistLorebook(bookName, book);
    return data;
}
