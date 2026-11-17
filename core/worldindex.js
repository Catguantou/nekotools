// 混合索引：常驻一条「索引」，只列绿灯条目的名字（角色/道具/伏笔），
// 详情仍走绿灯条目。这样模型永远知道"有什么"，又不为详情付常驻 token。

import { stBridge } from './st_bridge.js';
import { parseRosterLine } from './worldfmt.js';

export const INDEX_TITLE = '索引';
const SEC_CHARS = '【角色】';
const SEC_ITEMS = '【道具】';
const SEC_FORESHADOWS = '【伏笔】';

function emptySections() {
    return { chars: [], items: [], foreshadows: [] };
}

/** 从条目内容解析三段 */
export function parseIndex(content) {
    const out = emptySections();
    let section = null;

    for (const raw of String(content || '').split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        if (line === SEC_CHARS) { section = 'chars'; continue; }
        if (line === SEC_ITEMS) { section = 'items'; continue; }
        if (line === SEC_FORESHADOWS) { section = 'foreshadows'; continue; }
        if (!section) continue;

        if (section === 'chars') {
            if (line.startsWith('（') || line.startsWith('【')) continue;
            const parsed = parseRosterLine(line);
            if (parsed) out.chars.push(parsed);
            continue;
        }
        if (line.startsWith('（') || line.startsWith('【')) continue;
        for (const name of line.split(/[、,，]/).map(s => s.trim()).filter(Boolean)) {
            out[section].push(name);
        }
    }
    return out;
}

/** 生成索引内容 */
export function renderIndex(sections) {
    const s = { ...emptySections(), ...(sections || {}) };
    const lines = [SEC_CHARS];
    if (s.chars.length) {
        for (const c of s.chars) lines.push(c.raw || `- ${c.name}`);
    } else {
        lines.push('（暂无）');
    }
    lines.push(SEC_ITEMS, s.items.length ? s.items.join('、') : '（暂无）');
    lines.push(SEC_FORESHADOWS, s.foreshadows.length ? s.foreshadows.join('、') : '（暂无）');
    return lines.join('\n');
}

async function loadBook(bookName) {
    return stBridge.loadWorldInfoAsync(bookName, true);
}

function findEntry(book, title) {
    if (!book || !book.entries) return null;
    return Object.values(book.entries).find(e => e && e.comment === title) || null;
}

function readNames(content) {
    const out = [];
    for (const line of String(content || '').split('\n')) {
        const m = line.match(/^\s*-\s*([^｜|]+)[｜|]/);
        if (m) out.push(m[1].trim());
    }
    return out;
}

/** 读索引；没有「索引」时兼容旧的「角色索引」 */
export async function readIndex(bookName) {
    if (!bookName) return emptySections();
    const book = await loadBook(bookName);
    const entry = findEntry(book, INDEX_TITLE);
    if (entry) return parseIndex(entry.content);

    const old = findEntry(book, '角色索引');
    if (old) {
        return { chars: parseIndex(`${SEC_CHARS}\n${old.content}`).chars, items: [], foreshadows: [] };
    }
    return emptySections();
}

export async function writeIndex(bookName, sections) {
    if (!bookName) return false;
    const book = await loadBook(bookName);
    if (!book || !book.entries) return false;

    stBridge.upsertEntryInBook(book, INDEX_TITLE, renderIndex(sections), {
        isConstant: true,
        extra: { position: 0, depth: 0, order: 850, key: [] },
    });
    await stBridge.persistLorebook(bookName, book);
    return true;
}

/** 同步角色段：add = { 名字: "T2｜位置｜行动｜第 N 层" }，del = [名字] */
export async function syncChars(bookName, add = {}, del = []) {
    const sections = await readIndex(bookName);
    const map = new Map(sections.chars.map(c => [c.name, c.raw || `- ${c.name}`]));
    for (const name of del || []) map.delete(String(name));
    for (const [name, value] of Object.entries(add || {})) {
        const n = String(name || '').trim();
        if (!n) continue;
        map.set(n, `- ${n}｜${String(value || '').trim()}`);
    }
    sections.chars = [...map.entries()]
        .map(([, raw]) => parseRosterLine(raw))
        .filter(Boolean);
    return writeIndex(bookName, sections);
}

export async function addChar(bookName, name, value = 'T3') {
    return syncChars(bookName, { [name]: value }, []);
}

export async function removeChar(bookName, name) {
    return syncChars(bookName, {}, [name]);
}

/** 同步道具/伏笔段：只存名字 */
export async function syncNames(bookName, section, names = []) {
    if (section !== 'items' && section !== 'foreshadows') return false;
    const sections = await readIndex(bookName);
    sections[section] = [...new Set(names.map(s => String(s || '').trim()).filter(Boolean))];
    return writeIndex(bookName, sections);
}

/**
 * 旧档迁移：把「角色索引」并进「索引」，并从道具/伏笔详情补齐名字段。
 * 幂等，可以每次启动都跑。
 */
export async function migrateIndex(bookName) {
    if (!bookName) return false;
    const book = await loadBook(bookName);
    if (!book || !book.entries) return false;

    const entries = Object.values(book.entries);
    const oldEntry = entries.find(e => e && e.comment === '角色索引');
    const idxEntry = findEntry(book, INDEX_TITLE);
    let changed = false;

    const sections = idxEntry ? parseIndex(idxEntry.content) : emptySections();

    if (oldEntry) {
        const oldChars = parseIndex(`${SEC_CHARS}\n${oldEntry.content}`).chars;
        const map = new Map(sections.chars.map(c => [c.name, c.raw || `- ${c.name}`]));
        for (const c of oldChars) {
            if (!map.has(c.name)) map.set(c.name, c.raw || `- ${c.name}`);
        }
        sections.chars = [...map.entries()]
            .map(([, raw]) => parseRosterLine(raw))
            .filter(Boolean);
        for (const [uid, entry] of Object.entries(book.entries)) {
            if (entry && entry.comment === '角色索引') delete book.entries[uid];
        }
        changed = true;
    }

    const itemsEntry = entries.find(e => e && e.comment === '道具');
    if (itemsEntry) {
        const names = readNames(itemsEntry.content);
        if (JSON.stringify(names) !== JSON.stringify(sections.items)) {
            sections.items = names;
            changed = true;
        }
    }
    const foreEntry = entries.find(e => e && e.comment === '伏笔');
    if (foreEntry) {
        const names = readNames(foreEntry.content);
        if (JSON.stringify(names) !== JSON.stringify(sections.foreshadows)) {
            sections.foreshadows = names;
            changed = true;
        }
    }

    if (!idxEntry || changed) {
        stBridge.upsertEntryInBook(book, INDEX_TITLE, renderIndex(sections), {
            isConstant: true,
            extra: { position: 0, depth: 0, order: 850, key: [] },
        });
        await stBridge.persistLorebook(bookName, book);
    }
    return changed;
}
