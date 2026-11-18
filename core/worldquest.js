// 主线 / 支线：主线常驻一条，支线聚合成一条；都由模型自动推进，不给玩家做选择。

import { stBridge } from './st_bridge.js';
import { parseGameDate, daysBetween } from './worldfmt.js';
import { deriveGreenKeys } from './worldkeys.js';

export const MAIN_TITLE = '主线';
export const QUEST_TITLE = '支线';
export const QUEST_HISTORY_TITLE = '支线历史';
const MAIN_FIELDS = ['标题', '目标', '阶段', '进度', '失败代价', '下一步'];

function findEntry(book, title) {
    if (!book || !book.entries) return null;
    return Object.values(book.entries).find(e => e && e.comment === title) || null;
}

/** 支线聚合条目的绿灯 key；关键词全被过滤时退回清理过的原始短名，避免 key=[] 永不激活 */
function questEntryKeys(data) {
    const names = Object.keys(data || {}).map(n => String(n || '').trim()).filter(Boolean);
    const keys = deriveGreenKeys(names);
    if (keys.length) return keys;
    return [...new Set(names
        .map(n => n.replace(/[「」『』【】\[\]《》<>"'“”‘’\s]/g, '').trim())
        .filter(n => n.length >= 2 && n.length <= 6))].slice(0, 6);
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
    if (!bookName) return null;
    // 面板/快捷菜单直接调用，写入前没有存在性校验：书被删掉后不能又写回来
    if (!(await stBridge.bookKnown(bookName))) {
        console.warn('[nekotools] 世界书不存在，跳过写入:', bookName);
        return null;
    }
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

function isExplicitFail(status) {
    return /^(已)?失败$|^已?过期$|^(已)?放弃$|^(已)?取消$|^已失效$/.test(String(status || '').trim());
}

function isDoneStatus(status) {
    return /^(已)?完成$|^(已)?成功$|^已达成$|^已解决$/.test(String(status || '').trim());
}

function withQuestStatus(value, status) {
    const q = parseQuestValue(value);
    return [q.type || '支线', q.target || '', status, q.deadline || '无', q.fail || '', q.hook || '']
        .join('｜');
}

/** 清理支线：明确失败直接删；超时未完成先标记「已过期」保留一轮，并写入支线历史 */
function pruneQuestData(data, todayText) {
    const removed = [];
    const marked = [];
    const archived = [];
    const today = parseGameDate(todayText);
    for (const [name, value] of Object.entries(data)) {
        const q = parseQuestValue(value);
        const status = String(q.status || '').trim();
        if (isExplicitFail(status)) {
            delete data[name];
            removed.push(name);
            // 「已过期」是插件上一轮写的标记，不再重复记历史
            if (status !== '已过期') archived.push({ name, reason: `状态：${status}` });
            continue;
        }
        if (isDoneStatus(status)) continue;
        const deadline = parseGameDate(q.deadline);
        if (today && deadline && daysBetween(today, deadline) < 0) {
            data[name] = withQuestStatus(value, '已过期');
            marked.push(name);
            archived.push({ name, reason: `超时（期限 ${q.deadline}）` });
        }
    }
    if (removed.length) console.log(`[worldquest] 归档失败/过期支线：${removed.join('、')}`);
    if (marked.length) console.log(`[worldquest] 支线超时，标记后下一轮归档：${marked.join('、')}`);
    return { removed, marked, archived };
}

export async function readQuestHistory(bookName) {
    if (!bookName) return [];
    const book = await stBridge.loadWorldInfoAsync(bookName, true);
    const entry = findEntry(book, QUEST_HISTORY_TITLE);
    if (!entry) return [];
    return String(entry.content || '').split('\n')
        .map(line => line.trim())
        .filter(line => line.startsWith('- '))
        .map(line => line.slice(2));
}

async function appendQuestHistory(bookName, records, todayText = '') {
    if (!bookName || !records.length) return;
    const book = await stBridge.loadWorldInfoAsync(bookName, true);
    if (!book || !book.entries) return;
    const entry = findEntry(book, QUEST_HISTORY_TITLE);
    const lines = entry
        ? String(entry.content || '').split('\n').map(l => l.trim()).filter(l => l.startsWith('- '))
        : [];
    const date = parseGameDate(todayText) ? todayText : '未知日期';
    for (const r of records) lines.push(`- ${date}｜${r.name}｜${r.reason}`);
    const kept = lines.slice(-50);
    stBridge.upsertEntryInBook(book, QUEST_HISTORY_TITLE, ['【支线历史】', ...kept].join('\n'), {
        isConstant: false,
        extra: { position: 0, depth: 0, order: 813, key: [] },
    });
    await stBridge.persistLorebook(bookName, book);
}

/** 每轮轻量清理：没有失败/过期支线时不写盘 */
export async function pruneQuests(bookName, todayText = '') {
    if (!bookName) return { removed: [], marked: [], archived: [] };
    const book = await stBridge.loadWorldInfoAsync(bookName, true);
    if (!book || !book.entries) return { removed: [], marked: [], archived: [] };
    const entry = findEntry(book, QUEST_TITLE);
    if (!entry) return { removed: [], marked: [], archived: [] };
    const data = parseQuests(entry.content);
    const result = pruneQuestData(data, todayText);
    if (!result.removed.length && !result.marked.length) return result;
    stBridge.upsertEntryInBook(book, QUEST_TITLE, renderQuests(data), {
        isConstant: false,
        keywords: questEntryKeys(data),
        extra: { position: 0, depth: 0, order: 812 },
    });
    await stBridge.persistLorebook(bookName, book);
    if (result.archived.length) await appendQuestHistory(bookName, result.archived, todayText);
    return result;
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
    if (!bookName) return null;
    // 快捷菜单「世界快照/请求更新」会直接调用这里：书被删掉后不能靠 /get 的假书又写回来
    if (!(await stBridge.bookKnown(bookName))) {
        console.warn('[nekotools] 世界书不存在，跳过写入:', bookName);
        return null;
    }
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

    stBridge.upsertEntryInBook(book, QUEST_TITLE, renderQuests(data), {
        isConstant: false,
        keywords: questEntryKeys(data),
        extra: { position: 0, depth: 0, order: 812 },
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
        isConstant: false,
        keywords: questEntryKeys(data),
        extra: { position: 0, depth: 0, order: 812 },
    });
    await stBridge.persistLorebook(bookName, book);
    return data;
}
