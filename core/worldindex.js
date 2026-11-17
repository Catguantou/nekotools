// 混合索引：常驻「索引」只列绿灯条目的名字/简略内容，
// 详情仍走绿灯条目。这样模型永远知道"有什么"，又不为详情付常驻 token。

import { stBridge } from './st_bridge.js';
import { parseRosterLine, formatRosterLine } from './worldfmt.js';

export const INDEX_TITLE = '索引';
const SEC_CHARS = '【角色】';
const SEC_ITEMS = '【道具】';
const SEC_FORESHADOWS = '【伏笔】';
const BRIEF_ORDER = ['支线', '计划', '伏笔', '道具', '国家', '势力', '新闻', '地图'];

function emptySections() {
    return { chars: [], items: [], foreshadows: [], briefs: {} };
}

function briefLine(name, text, max = 70) {
    const n = String(name || '').trim();
    const t = String(text || '').trim().replace(/\s+/g, ' ');
    if (!n || !t) return '';
    const shown = n.length > 14 ? `${n.slice(0, 14)}…` : n;
    return `- ${shown}｜${t.slice(0, max)}`;
}

/** 从条目内容提取「- 名称｜内容」 */
function entryLines(content) {
    const out = [];
    for (const line of String(content || '').split('\n')) {
        const m = line.trim().match(/^-\s*([^｜|]+)[｜|]([\s\S]*)$/);
        if (m) out.push({ name: m[1].trim(), value: m[2].trim() });
    }
    return out;
}

/** 从当前追踪书重建所有绿灯条目的简称（索引用，不写详情） */
export function buildBriefs(book) {
    const entries = book && book.entries ? Object.values(book.entries) : [];
    const find = (title) => entries.find(e => e && e.comment === title);
    const briefs = {};

    const quests = entryLines(find('支线')?.content);
    if (quests.length) {
        briefs['支线'] = [];
        for (const q of quests) {
            const parts = q.value.split(/[｜|]/).map(s => s.trim());
            const status = parts[2] || '进行中';
            const deadline = parts[3] && parts[3] !== '无' ? `｜${parts[3]}` : '';
            briefs['支线'].push(briefLine(q.name, `${status}${deadline}`, 44));
        }
        briefs['支线'] = briefs['支线'].filter(Boolean);
    }

    const plans = entryLines(find('计划')?.content);
    if (plans.length) briefs['计划'] = plans.map(p => briefLine(p.name, p.value, 60)).filter(Boolean);

    const fores = entryLines(find('伏笔')?.content);
    if (fores.length) briefs['伏笔'] = fores.map(p => briefLine(p.name, p.value, 60)).filter(Boolean);

    const items = entryLines(find('道具')?.content);
    if (items.length) briefs['道具'] = items.map(p => briefLine(p.name, p.value, 60)).filter(Boolean);

    const worldSections = [
        ['世界·国家', '国家'],
        ['世界·势力', '势力'],
    ];
    for (const [title, key] of worldSections) {
        const lines = entryLines(find(title)?.content);
        if (lines.length) briefs[key] = lines.map(p => briefLine(p.name, p.value, 64)).filter(Boolean);
    }
    const news = entryLines(find('社会新闻')?.content);
    if (news.length) briefs['新闻'] = news.map(p => briefLine(p.name, p.value, 64)).filter(Boolean);

    const mapContent = String(find('地图')?.content || '');
    const cur = mapContent.match(/【当前】\s*([^\n]+)/);
    if (cur) briefs['地图'] = [briefLine('当前', cur[1], 100)].filter(Boolean);

    return briefs;
}

/** 从条目内容解析索引 */
export function parseIndex(content) {
    const out = emptySections();
    let section = null;
    let briefKey = '';

    for (const raw of String(content || '').split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        if (line === SEC_CHARS) { section = 'chars'; briefKey = ''; continue; }
        if (line.startsWith('【') && line.endsWith('】')) {
            const name = line.slice(1, -1).trim();
            if (BRIEF_ORDER.includes(name)) {
                section = 'briefs';
                briefKey = name;
                if (!out.briefs[briefKey]) out.briefs[briefKey] = [];
                continue;
            }
        }
        if (!section) continue;

        if (section === 'chars') {
            if (line.startsWith('（') || line.startsWith('【')) continue;
            const parsed = parseRosterLine(line);
            if (parsed) out.chars.push(parsed);
            continue;
        }
        if (section === 'briefs') {
            if (/^-\s*/.test(line)) out.briefs[briefKey].push(line);
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
    const briefs = s.briefs && typeof s.briefs === 'object' ? s.briefs : {};
    const lines = [SEC_CHARS];
    if (s.chars.length) {
        for (const c of s.chars) lines.push(c.raw || `- ${c.name}`);
    } else {
        lines.push('（暂无）');
    }
    for (const key of BRIEF_ORDER) {
        const rows = Array.isArray(briefs[key]) ? briefs[key].filter(Boolean) : [];
        const legacy = key === '道具' ? s.items : key === '伏笔' ? s.foreshadows : [];
        lines.push(`【${key}】`);
        if (rows.length) lines.push(...rows);
        else if (legacy.length) lines.push(legacy.join('、'));
        else lines.push('（暂无）');
    }
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

/** 从当前世界书重建索引里的所有简略段（支线/计划/伏笔/道具/国家/势力/新闻/地图） */
export async function refreshBriefs(bookName, book = null) {
    if (!bookName) return false;
    const target = book || await loadBook(bookName);
    if (!target || !target.entries) return false;
    const entry = findEntry(target, INDEX_TITLE);
    const sections = parseIndex(entry?.content || '');
    sections.briefs = buildBriefs(target);
    const next = renderIndex(sections);
    if (entry && String(entry.content || '') === next) return false;
    return writeIndex(bookName, sections);
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

/** 只刷新某个角色在索引里的位置/行动/更新时间，不动等级 */
export async function refreshChar(bookName, name, patch = {}) {
    if (!bookName || !name) return false;
    const sections = await readIndex(bookName);
    let found = false;
    sections.chars = sections.chars.map(c => {
        if (c.name !== name) return c;
        found = true;
        return { ...c, ...patch };
    });
    if (!found) sections.chars.push({ name, tier: 'T3', ...patch });
    sections.chars = sections.chars.map(c => ({ ...c, raw: formatRosterLine(c) }));
    return writeIndex(bookName, sections);
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

    // 修复模型把「T1核心」写进位置、把真实地点写进行动的情况
    for (const c of sections.chars) {
        const loc = String(c.location || '').trim();
        const action = String(c.action || '').trim();
        if (/^(T\d|核心|重要|次要|主要)/i.test(loc)
            && /([·街城鎮村区市巷广场酒馆王都]|市场|广场)/.test(action)) {
            c.location = action;
            c.action = loc;
            c.raw = formatRosterLine(c);
            changed = true;
        }
    }

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

    const briefs = buildBriefs(book);
    if (JSON.stringify(briefs) !== JSON.stringify(sections.briefs || {})) {
        sections.briefs = briefs;
        changed = true;
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
