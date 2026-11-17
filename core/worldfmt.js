// 纯函数：存档位命名规则 + 存档文件格式。
// 不碰 DOM、不碰世界书、不碰 ST 内部对象，方便 tools/check.mjs 直接跑样例。
//
// 命名规则：
//   第 1 档：【NEKOTOOL世界加载器·角色名】
//   第 N 档：【NEKOTOOL世界加载器·角色名·N】   (N >= 2)
// 解析只认结尾的「·数字」，角色名中间带 · 不会误伤。
//
// 两个必须守住的边界：
//   1. 同一角色所有档的「角色名部分」必须完全一致，否则 isSlotOf 会漏档；
//   2. ST 后端按 255 字节截文件名，这里按 UTF-8 字节截，避免中文长名对不上磁盘。

export const TRACKER_PREFIX = '【NEKOTOOL世界加载器·';
export const TRACKER_SUFFIX = '】';
export const SLOT_SEP = '·';
export const SAVE_VERSION = 1;

// 世界书文件名预算：ST 后端上限 255 字节，留一点余量
const MAX_WORLD_BYTES = 220;
// 所有档共用同一段角色名预算；后缀按最大四位数预留，保证各档角色名部分一致
const SLOT_ROOM = `${SLOT_SEP}9999`;

export function sanitizeWorldName(name) {
    return String(name ?? '')
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
}

function byteLength(str) {
    let n = 0;
    for (const ch of String(str)) {
        const code = ch.codePointAt(0);
        if (code <= 0x7f) n += 1;
        else if (code <= 0x7ff) n += 2;
        else if (code <= 0xffff) n += 3;
        else n += 4;
    }
    return n;
}

/** 按 UTF-8 字节数截断，不会切坏字符 */
export function truncateWorldName(str, maxBytes = MAX_WORLD_BYTES) {
    let used = 0;
    let out = '';
    for (const ch of String(str ?? '')) {
        const b = byteLength(ch);
        if (used + b > maxBytes) break;
        used += b;
        out += ch;
    }
    return out;
}

function composeTrackerName(charName, suffix = '') {
    const safe = sanitizeWorldName(charName);
    if (!safe) return '';
    const fixedBytes = byteLength(TRACKER_PREFIX) + byteLength(`${SLOT_ROOM}${TRACKER_SUFFIX}`);
    const room = MAX_WORLD_BYTES - fixedBytes;
    if (room <= 0) return '';
    // 角色名部分对所有档用同一预算，保证 isSlotOf 能对上
    const charPart = truncateWorldName(safe, room);
    if (!charPart) return '';
    return `${TRACKER_PREFIX}${charPart}${suffix}${TRACKER_SUFFIX}`;
}

/** 第 1 档（基础名）；没有角色名时返回空串 */
export function slotBaseName(charName) {
    return composeTrackerName(charName, '');
}

/** 第 n 档书名；n <= 1 时就是基础名，不带后缀 */
export function slotName(charName, n) {
    const base = slotBaseName(charName);
    if (!base) return '';
    const num = Math.floor(Number(n));
    if (!Number.isFinite(num) || num <= 1) return base;
    return composeTrackerName(charName, `${SLOT_SEP}${num}`);
}

/** 解析书名 → { charName, slot }；不是本插件的追踪书返回 null */
export function parseSlotName(name) {
    const s = String(name ?? '');
    if (!s.startsWith(TRACKER_PREFIX) || !s.endsWith(TRACKER_SUFFIX)) return null;

    const inner = s.slice(TRACKER_PREFIX.length, s.length - TRACKER_SUFFIX.length);
    if (!inner) return null;

    let charName = inner;
    let slot = 1;
    const m = inner.match(/^(.*)·(\d+)$/);
    if (m && m[1]) {
        const num = Number(m[2]);
        if (Number.isInteger(num) && num >= 1) {
            charName = m[1];
            slot = num;
        }
    }
    if (!charName) return null;
    return { charName, slot };
}

/** 书名是第几档；不是追踪书返回 0 */
export function slotNumber(name) {
    const parsed = parseSlotName(name);
    return parsed ? parsed.slot : 0;
}

/**
 * 这本书是否属于某个角色。
 * 用「基础名前缀」比较，避免长角色名被截断后重算基础名对不上。
 * 角色名本身以 ·数字 结尾时存在歧义（极少见），以当前角色名为准优先匹配。
 */
export function isSlotOf(name, charName) {
    const base = slotBaseName(charName);
    if (!base || typeof name !== 'string') return false;
    const prefix = base.slice(0, -TRACKER_SUFFIX.length);
    return name === base || name.startsWith(`${prefix}${SLOT_SEP}`);
}

// ========== 角色索引 ==========

/**
 * 解析角色索引的一行：
 *   - 名字｜T2｜位置｜最近行动｜第 37 层
 * 返回 { name, tier, location, action, layer, raw }；空行返回 null。
 */
export function parseRosterLine(line) {
    const raw = String(line ?? '').trim();
    if (!raw) return null;
    const body = raw.replace(/^[-·]\s*/, '');
    const parts = body.split('｜').map(s => s.trim());
    if (!parts[0]) return null;

    let layer = 0;
    const tail = parts[parts.length - 1] || '';
    const m = tail.match(/第\s*(\d+)\s*层/);
    if (m) layer = Number(m[1]);
    const fields = m ? parts.slice(0, -1) : parts;

    return {
        name: fields[0] || '',
        tier: fields[1] || '',
        location: fields[2] || '',
        action: fields[3] || '',
        layer,
        raw,
    };
}

/** 生成角色索引的一行；layer > 0 时追加「第 N 层」 */
export function formatRosterLine({ name, tier = 'T3', location = '', action = '', layer = 0 }) {
    const parts = [String(name || '').trim(), tier || 'T3'];
    if (location) parts.push(location);
    else if (action) parts.push('');
    if (action) parts.push(action);
    if (layer > 0) parts.push(`第 ${layer} 层`);
    return `- ${parts.join('｜')}`;
}

/** 从一行里去掉旧的「第 N 层」，方便重新打时间戳 */
export function stripRosterLayer(value) {
    return String(value ?? '').replace(/｜\s*第\s*\d+\s*层\s*$/, '').trim();
}

/** 存档列表里的显示名 */
export function slotLabel(n) {
    const num = Math.max(1, Math.floor(Number(n)) || 1);
    return `第 ${num} 档`;
}

// ========== 状态栏 / 世界时钟 ==========

function parseFieldMap(text) {
    const map = {};
    for (const part of String(text ?? '').split(/[|｜\n]/)) {
        const m = part.match(/^\s*([^:：]+)[:：]([\s\S]*)$/);
        if (m) map[m[1].trim()] = m[2].trim();
    }
    return map;
}

/**
 * 解析状态栏文本（模型输出的 `<ws_status>` 内容）。
 * 例：时间: 2026年11月17日 | 地点: 酒馆 | 天气: 雨 | 温度: 18℃
 * 返回 { time, place, weather, temperature }；没有时间也没有地点时返回 null。
 */
export function parseStatusFields(raw) {
    const text = String(raw ?? '').trim();
    if (!text) return null;

    const map = parseFieldMap(text);
    if (!map['时间'] && !map['地点']) return null;
    return {
        time: map['时间'] || '',
        place: map['地点'] || '',
        weather: map['天气'] || '',
        temperature: map['温度'] || '',
    };
}

function daysInMonth(year, month) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return days[month - 1] || 0;
}

/** 从文本里抠出剧情日期 { y, m, d }；没有或日期非法返回 null */
export function parseGameDate(text) {
    const m = String(text ?? '').match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (y < 1000 || y > 9999) return null;
    if (mo < 1 || mo > 12) return null;
    if (d < 1 || d > daysInMonth(y, mo)) return null;
    return { y, m: mo, d };
}

function gameDayNumber(date) {
    return Math.floor(Date.UTC(date.y, date.m - 1, date.d) / 86400000);
}

/** 两个剧情日期相差几天（b - a）；任一无效返回 0 */
export function daysBetween(a, b) {
    if (!a || !b) return 0;
    return gameDayNumber(b) - gameDayNumber(a);
}

/**
 * 生成存档文件对象。
 * book 传 ST 原样的世界书对象（{ entries: {...} }），内部深拷贝，避免调用方后续改动污染。
 */
export function buildSaveFile({ card, slot = 1, book, exportedAt } = {}) {
    const name = String(card ?? '').trim();
    if (!name) throw new Error('缺少角色名');
    if (!book || typeof book !== 'object' || !book.entries || typeof book.entries !== 'object' || Array.isArray(book.entries)) {
        throw new Error('缺少世界书内容');
    }
    const num = Math.max(1, Math.floor(Number(slot)) || 1);
    return {
        __nekotool_save: true,
        version: SAVE_VERSION,
        exportedAt: exportedAt || new Date().toISOString(),
        card: name,
        slot: num,
        book: JSON.parse(JSON.stringify(book)),
    };
}

/**
 * 校验并解析存档文件。
 * 传入字符串或已解析对象；不合法直接抛错（调用方负责 toast 提示）。
 */
export function parseSaveFile(input) {
    let obj = input;
    if (typeof input === 'string') {
        try {
            obj = JSON.parse(input);
        } catch {
            throw new Error('不是合法的 JSON 文件');
        }
    }
    if (!obj || typeof obj !== 'object') throw new Error('存档内容为空');
    if (obj.__nekotool_save !== true) throw new Error('不是 NEKOTOOL 存档文件');
    if (!obj.book || typeof obj.book !== 'object') throw new Error('存档里没有世界书内容');
    if (!obj.book.entries || typeof obj.book.entries !== 'object' || Array.isArray(obj.book.entries)) {
        throw new Error('存档里没有世界书内容');
    }

    const version = Number(obj.version) || 0;
    if (version > SAVE_VERSION) throw new Error('存档版本比插件新，先升级插件再导入');

    for (const [key, entry] of Object.entries(obj.book.entries)) {
        if (!entry || typeof entry !== 'object') throw new Error(`存档条目 ${key} 格式不对`);
        if (entry.uid !== undefined && String(entry.uid) !== String(key)) {
            throw new Error(`存档条目 ${key} 的 uid 对不上`);
        }
    }

    const card = String(obj.card ?? '').trim();
    if (!card) throw new Error('存档缺少角色名');

    return {
        card,
        slot: Math.max(1, Math.floor(Number(obj.slot)) || 1),
        book: obj.book,
        exportedAt: String(obj.exportedAt || ''),
        version,
    };
}
