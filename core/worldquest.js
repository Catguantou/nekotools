// 主线 / 支线：主线常驻一条，支线聚合成一条；都由模型自动推进，不给玩家做选择。

import { stBridge } from './st_bridge.js';
import { parseGameDate, daysBetween } from './worldfmt.js';

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
    return saveMain(bookName, merged);
}

/** 直接覆盖主线（手动编辑用） */
export async function saveMain(bookName, main) {
    const book = await stBridge.loadWorldInfoAsync(bookName, true);
    if (!book || !book.entries) return null;
    const entry = findEntry(book, MAIN_TITLE);
    const previous = entry ? parseMain(entry.content) : {};
    const merged = { ...(main || {}) };
    for (const key of MAIN_FIELDS) {
        if (merged[key] !== undefined) merged[key] = String(merged[key] ?? '').trim();
    }
    merged['进度'] = clampProgress(merged['进度']);

    stBridge.upsertEntryInBook(book, MAIN_TITLE, renderMain(merged), {
        isConstant: true,
        extra: { position: 0, depth: 0, order: 810, key: [] },
    });
    await stBridge.persistLorebook(bookName, book);
    // 只在第一次跨到 100% 时通知，手动再保存不会反复弹结局框
    if (typeof window !== 'undefined'
        && merged['进度'] >= 100
        && clampProgress(previous['进度']) < 100) {
        window.dispatchEvent(new CustomEvent('nekotool:main-complete', { detail: { bookName } }));
    }
    return merged;
}

const QUEST_BAD_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

export function parseQuests(content) {
    const out = {};
    for (const raw of String(content || '').split('\n')) {
        const line = raw.trim();
        const m = line.match(/^-\s*([^｜|]+)[｜|]([\s\S]*)$/);
        if (m) {
            const name = m[1].trim();
            if (name && !QUEST_BAD_NAMES.has(name)) out[name] = m[2].trim();
        }
    }
    return out;
}

/** 支线字段：类型｜目标｜状态｜期限｜失败条件｜钩子；兼容旧的四段格式 */
export function parseQuestValue(value) {
    const parts = String(value ?? '').split(/[｜|]/).map(s => s.trim());
    const p = { type: '', target: '', status: '', deadline: '', fail: '', hook: '' };
    if (parts.length >= 6) {
        [p.type, p.target, p.status, p.deadline, p.fail] = parts;
        p.hook = parts.slice(5).join('｜');
    } else if (parts.length === 5) {
        [p.type, p.target, p.status] = parts;
        if (parseGameDate(parts[3])) {
            p.deadline = parts[3];
            p.hook = parts[4];
        } else {
            p.hook = parts.slice(3).join('｜');
        }
    } else if (parts.length === 4) {
        [p.type, p.target, p.status] = parts;
        // 四段可能是旧格式（第4段是钩子），也可能是新格式漏了失败条件（第4段是期限）
        if (parseGameDate(parts[3])) p.deadline = parts[3];
        else p.hook = parts[3];
    } else {
        [p.type, p.target, p.status] = parts;
        p.hook = parts.slice(3).join('｜');
    }
    return p;
}

/** 支线是否该由插件删除：明确失败/过期，或限期已过且未完成 */
export function questFailed(value, todayText = '') {
    const q = parseQuestValue(value);
    const status = String(q.status || '').trim();
    if (/^(已)?失败$|^已?过期$|^(已)?放弃$|^(已)?取消$|^已失效$/.test(status)) return true;
    if (/^(已)?完成$|^(已)?成功$|^已达成$|^已解决$/.test(status)) return false;
    const today = parseGameDate(todayText);
    const deadline = parseGameDate(q.deadline);
    if (!today || !deadline) return false;
    return daysBetween(today, deadline) < 0;
}

function pruneQuestData(data, todayText) {
    const removed = [];
    for (const [name, value] of Object.entries(data)) {
        if (!questFailed(value, todayText)) continue;
        delete data[name];
        removed.push(name);
    }
    if (removed.length) console.log(`[worldquest] 自动删除失败/过期支线：${removed.join('、')}`);
    return removed;
}

/** 每轮轻量清理：没有失败/过期支线时不写盘 */
export async function pruneQuests(bookName, todayText = '') {
    if (!bookName) return [];
    const book = await stBridge.loadWorldInfoAsync(bookName, true);
    if (!book || !book.entries) return [];
    const entry = findEntry(book, QUEST_TITLE);
    if (!entry) return [];
    const data = parseQuests(entry.content);
    const removed = pruneQuestData(data, todayText);
    if (!removed.length) return [];
    stBridge.upsertEntryInBook(book, QUEST_TITLE, renderQuests(data), {
        isConstant: true,
        extra: { position: 0, depth: 0, order: 812, key: [] },
    });
    await stBridge.persistLorebook(bookName, book);
    return removed;
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

export async function applyQuests(bookName, raw, { today = '' } = {}) {
    if (!raw || typeof raw !== 'object') return null;
    const book = await stBridge.loadWorldInfoAsync(bookName, true);
    if (!book || !book.entries) return null;
    const entry = findEntry(book, QUEST_TITLE);
    let data = entry ? parseQuests(entry.content) : {};

    const ops = (raw.add && typeof raw.add === 'object')
        ? { add: raw.add, del: Array.isArray(raw.del) ? raw.del.map(String) : [] }
        : { add: raw, del: [] };

    for (const name of ops.del) delete data[name];
    for (const [name, value] of Object.entries(ops.add)) {
        const n = String(name || '').trim();
        if (!n || QUEST_BAD_NAMES.has(n)) continue;
        const text = String(value ?? '').trim();
        if (text) data[n] = text;
        else delete data[n];
    }
    pruneQuestData(data, today);

    stBridge.upsertEntryInBook(book, QUEST_TITLE, renderQuests(data), {
        isConstant: true,
        extra: { position: 0, depth: 0, order: 812, key: [] },
    });
    await stBridge.persistLorebook(bookName, book);
    return data;
}

/** 直接覆盖支线（手动编辑用） */
export async function saveQuests(bookName, quests) {
    const book = await stBridge.loadWorldInfoAsync(bookName, true);
    if (!book || !book.entries) return null;
    const data = {};
    for (const [name, value] of Object.entries(quests || {})) {
        const n = String(name || '').trim();
        if (!n || QUEST_BAD_NAMES.has(n)) continue;
        const text = String(value ?? '').trim();
        if (n && text) data[n] = text;
    }
    stBridge.upsertEntryInBook(book, QUEST_TITLE, renderQuests(data), {
        isConstant: true,
        extra: { position: 0, depth: 0, order: 812, key: [] },
    });
    await stBridge.persistLorebook(bookName, book);
    return data;
}
