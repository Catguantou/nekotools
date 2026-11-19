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
    if (!body || /^【.*】$/.test(body)) return null;
    const parts = body.split(/[|｜]/).map(s => s.trim());
    if (!parts[0]) return null;

    let layer = 0;
    const tail = parts[parts.length - 1] || '';
    if (/^第\s*\d+\s*层$/.test(tail)) {
        layer = Number((tail.match(/\d+/) || ['0'])[0]);
        parts.pop();
    }

    const [name, second = '', third = '', fourth = ''] = parts;
    let tier = '';
    let location = '';
    let action = '';
    if (/^T[1-4]$/i.test(second)) {
        tier = second.toUpperCase();
        location = third;
        action = fourth;
    } else if (parts.length >= 3) {
        // 没写等级但有位置/行动
        location = second;
        action = third;
    } else {
        // 两段旧格式：第二段当备注/最近行动
        action = second;
    }

    return { name, tier, location, action, layer, raw };
}

/** 生成角色索引的一行；layer > 0 时追加「第 N 层」 */
export function formatRosterLine({ name, tier = 'T3', location = '', action = '', layer = 0 }) {
    const clean = s => String(s ?? '').replace(/[|｜]/g, '/').trim();
    const parts = [clean(name), tier || 'T3'];
    if (location) parts.push(clean(location));
    else if (action) parts.push('');
    if (action) parts.push(clean(action));
    if (layer > 0) parts.push(`第 ${layer} 层`);
    return `- ${parts.join('｜')}`;
}

/** 从一行里去掉旧的「第 N 层」，方便重新打时间戳 */
export function stripRosterLayer(value) {
    return String(value ?? '').replace(/[|｜]\s*第\s*\d+\s*层\s*$/, '').trim();
}

// ========== 角色档案（YAML 子集） ==========

const CHAR_BASE_FIELDS = [
    '姓名', '性别', '外貌', '身份', '位置', '心情',
    '日程', '当前行动', '下一步', '长期目标', '近期打算',
    '状态', '后台运行', '关键记忆', '特殊变化',
    '人际关系', '已知', '秘密', '关键词', '更新于',
];

function yamlQuote(value) {
    return JSON.stringify(String(value ?? ''));
}

function yamlUnquote(value) {
    const s = String(value ?? '').trim();
    if (s.startsWith('"') && s.endsWith('"')) {
        try { return JSON.parse(s); } catch (_) {}
    }
    return s;
}

/** 关键记忆统一成字符串数组；模型给字符串时按换行拆 */
export function normalizeMemories(value) {
    if (Array.isArray(value)) return value.map(x => String(x).trim()).filter(Boolean);
    const s = String(value ?? '').trim();
    if (!s) return [];
    return s.split('\n').map(x => x.trim()).filter(Boolean);
}

/** 人际关系统一成 { 对方: "好感 X｜信任 Y｜标签：原因" } */
export function normalizeRelationships(value) {
    if (!value) return {};
    if (Array.isArray(value)) {
        const out = {};
        for (const item of value) {
            const s = String(item ?? '').trim();
            const m = s.match(/^([^:：]+)[:：]([\s\S]*)$/);
            if (m) out[m[1].trim()] = m[2].trim();
        }
        return out;
    }
    if (typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            const key = String(k ?? '').trim();
            const val = String(v ?? '').trim();
            if (key && val) out[key] = val;
        }
        return out;
    }
    return {};
}

/** 角色档案写成 YAML：姓名必写，关键记忆用列表，人际关系用映射 */
export function formatCharacterYaml(name, info = {}) {
    const src = info && typeof info === 'object' ? info : {};
    const lines = [`姓名: ${yamlQuote(name)}`];
    const used = new Set(['姓名']);

    for (const key of CHAR_BASE_FIELDS) {
        if (key === '姓名') continue;
        const v = src[key];
        if (key === '人际关系' || key === '日程') {
            const rel = normalizeRelationships(v);
            used.add(key);
            const keys = Object.keys(rel);
            if (!keys.length) continue;
            lines.push(`${key}:`);
            for (const person of keys) lines.push(`  ${yamlQuote(person)}: ${yamlQuote(rel[person])}`);
            continue;
        }
        if (key === '关键记忆' || key === '已知' || key === '关键词') {
            const list = normalizeMemories(v);
            used.add(key);
            if (!list.length) continue;
            lines.push(`${key}:`);
            for (const item of list) lines.push(`  - ${yamlQuote(item)}`);
            continue;
        }
        if (key === '秘密') {
            used.add(key);
            const list = normalizeMemories(v);
            if (!list.length) continue;
            if (list.length === 1) lines.push(`秘密: ${yamlQuote(list[0])}`);
            else {
                lines.push('秘密:');
                for (const item of list) lines.push(`  - ${yamlQuote(item)}`);
            }
            continue;
        }
        if (v === undefined || v === null || !String(v).trim()) continue;
        lines.push(`${key}: ${yamlQuote(v)}`);
        used.add(key);
    }

    for (const [key, v] of Object.entries(src)) {
        if (used.has(key) || v === undefined || v === null) continue;
        if (Array.isArray(v)) {
            const list = v.map(x => String(x).trim()).filter(Boolean);
            if (!list.length) continue;
            lines.push(`${key}:`);
            for (const item of list) lines.push(`  - ${yamlQuote(item)}`);
        } else if (String(v).trim()) {
            lines.push(`${key}: ${yamlQuote(v)}`);
        }
    }
    return lines.join('\n');
}

/** 解析角色档案：新 YAML 子集 + 兼容旧的「- 字段：值」格式 */
export function parseCharacterYaml(content) {
    const text = String(content ?? '').trim();
    const out = {};
    if (!text) return out;

    const firstLine = text.split('\n')[0].trim();
    if (/^-\s*[^:：\n]+[:：]/.test(firstLine)) {
        for (const line of text.split('\n')) {
            const m = line.match(/^\s*-\s*([^：:]+)[：:]([\s\S]*)$/);
            if (m) out[m[1].trim()] = m[2].trim();
        }
        return out;
    }

    let current = null;
    for (const rawLine of text.split('\n')) {
        const line = rawLine.replace(/\r$/, '');
        const item = line.match(/^\s{2,}-\s*(.*)$/);
        if (item && current) {
            const arr = Array.isArray(out[current]) ? out[current] : [];
            arr.push(yamlUnquote(item[1]));
            out[current] = arr;
            continue;
        }
        const mapItem = line.match(/^\s{2,}([^:：]+)[:：]\s*(.*)$/);
        if (mapItem && current) {
            const holder = out[current];
            if (holder && typeof holder === 'object' && !Array.isArray(holder)) {
                holder[yamlUnquote(mapItem[1].trim())] = yamlUnquote(mapItem[2].trim());
                continue;
            }
        }
        const kv = line.match(/^([^:：]+)[:：]\s*(.*)$/);
        if (!kv) continue;
        const key = kv[1].trim();
        const value = kv[2].trim();
        current = key;
        if (!value) out[key] = (key === '人际关系' || key === '日程') ? {} : [];
        else out[key] = yamlUnquote(value);
    }
    return out;
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

// ========== 玩家档案 / 声望 / 定性关系 ==========
// 世界模拟 2.0：玩家档案存「玩家档案」条目（禁注入），声望存「声望」条目（绿灯）。
// 解析一律容错：空值/坏数据返回空结构，不抛异常。

export const PLAYER_PROFILE_TITLE = '玩家档案';
export const REPUTATION_TITLE = '声望';
/** 当前声望固定等级：从最差到最好，只能选一个 */
export const REPUTATION_LEVELS = ['仇恨', '敌视', '冷淡', '中立', '友善', '尊敬', '崇拜'];
const REPUTATION_ALIASES = {
    仇视: '仇恨', 憎恨: '仇恨', 仇恨: '仇恨',
    敌对: '敌视', 敌意: '敌视', 厌恶: '敌视', 反感: '敌视', 敌视: '敌视',
    疏远: '冷淡', 冷漠: '冷淡', 冷淡: '冷淡',
    中立: '中立', 中性: '中立', 普通: '中立', 无感: '中立',
    友好: '友善', 友善: '友善', 好感: '友善', 亲近: '友善',
    敬重: '尊敬', 尊敬: '尊敬', 尊重: '尊敬', 认可: '尊敬',
    崇敬: '崇拜', 崇拜: '崇拜', 仰慕: '崇拜', 敬畏: '崇拜',
};

/** 把 AI 写的声望看法归一到固定等级；认不出返回空串 */
export function normalizeReputationLevel(value) {
    const text = profileText(value);
    if (!text) return '';
    for (const level of REPUTATION_LEVELS) {
        if (text.includes(level)) return level;
    }
    for (const [alias, level] of Object.entries(REPUTATION_ALIASES)) {
        if (text.includes(alias)) return level;
    }
    return '';
}

/** 只认字符串/数字，其余（对象、数组）当空串，避免拼出 [object Object] */
function profileText(value) {
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return '';
}

/** 字符串/数组 → 去重后的字符串数组（字符串按换行、顿号、逗号拆） */
function profileList(value) {
    if (Array.isArray(value)) {
        return [...new Set(value.map(profileText).filter(Boolean))];
    }
    const text = profileText(value);
    if (!text) return [];
    return [...new Set(text.split(/[\n、,，;；]+/).map(s => s.trim()).filter(Boolean))];
}

/** 钱/数量：抠出数字，钳到 >= 0；坏数据归 0 */
function profileAmount(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? Math.max(0, value) : 0;
    const text = String(value ?? '').replace(/[^\d.\-]/g, '');
    if (!text) return 0;
    const num = Number(text);
    return Number.isFinite(num) ? Math.max(0, num) : 0;
}

/** 数量取整（>=0）；钱保留小数 */
function profileCount(value) {
    return Math.floor(profileAmount(value));
}

/** 取第一个存在（非 undefined/null）的键值，用来兼容中文/英文两套键 */
function profilePick(obj, keys) {
    if (!obj || typeof obj !== 'object') return undefined;
    for (const key of keys) {
        const value = obj[key];
        if (value !== undefined && value !== null) return value;
    }
    return undefined;
}

function mergeUniqueList(base, extra) {
    const out = Array.isArray(base) ? [...base] : [];
    for (const item of Array.isArray(extra) ? extra : []) {
        if (item && !out.includes(item)) out.push(item);
    }
    return out;
}

function itemEntry(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const name = profileText(profilePick(raw, ['名称', 'name']));
    if (!name) return null;
    return {
        name,
        count: profileCount(profilePick(raw, ['数量', 'count'])),
        place: profileText(profilePick(raw, ['位置', 'place', '地点'])),
        state: profileText(profilePick(raw, ['状态', 'state', 'status'])),
        note: profileText(profilePick(raw, ['备注', 'note'])),
    };
}

function assetEntry(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const name = profileText(profilePick(raw, ['名称', 'name']));
    if (!name) return null;
    return {
        name,
        state: profileText(profilePick(raw, ['状态', 'state', 'status'])),
        income: profileText(profilePick(raw, ['产出', 'income', 'output'])),
        note: profileText(profilePick(raw, ['备注', 'note'])),
    };
}

function relationEntry(raw) {
    if (Array.isArray(raw)) {
        const name = profileText(raw[0]);
        if (!name) return null;
        return {
            name,
            tag: profileText(raw[1]),
            reason: profileText(raw[2]),
            debt: profileText(raw[3]),
        };
    }
    if (!raw || typeof raw !== 'object') return null;
    const name = profileText(profilePick(raw, ['对象', 'name', 'target']));
    if (!name) return null;
    return {
        name,
        tag: profileText(profilePick(raw, ['标签', 'tag'])),
        reason: profileText(profilePick(raw, ['原因', 'reason'])),
        debt: profileText(profilePick(raw, ['欠', 'debt'])),
    };
}

function promiseEntry(raw) {
    if (Array.isArray(raw)) {
        const who = profileText(raw[0]);
        if (!who) return null;
        return {
            who,
            what: profileText(raw[1]),
            due: profileText(raw[2]),
            status: profileText(raw[3]),
        };
    }
    if (!raw || typeof raw !== 'object') return null;
    const who = profileText(profilePick(raw, ['谁', 'who']));
    if (!who) return null;
    return {
        who,
        what: profileText(profilePick(raw, ['什么', 'what'])),
        due: profileText(profilePick(raw, ['期限', 'due'])),
        status: profileText(profilePick(raw, ['状态', 'status'])),
    };
}

function achievementEntry(raw) {
    if (Array.isArray(raw)) {
        const name = profileText(raw[0]);
        if (!name) return null;
        return {
            name,
            reason: profileText(raw[1]),
            note: profileText(raw[2]),
            known: profileText(raw[3]),
        };
    }
    if (!raw || typeof raw !== 'object') return null;
    const name = profileText(profilePick(raw, ['名称', 'name']));
    if (!name) return null;
    return {
        name,
        reason: profileText(profilePick(raw, ['原因', 'reason'])),
        note: profileText(profilePick(raw, ['备注', 'note'])),
        known: profileText(profilePick(raw, ['谁知道', 'known', 'knownBy'])),
    };
}

function reputationEntry(raw) {
    if (Array.isArray(raw)) {
        const target = profileText(raw[0]);
        if (!target) return null;
        return makeReputation(target, raw[1], raw[2]);
    }
    if (!raw || typeof raw !== 'object') return null;
    const target = profileText(profilePick(raw, ['对象', '地区', '势力', 'target', 'name']));
    if (!target) return null;
    return makeReputation(
        target,
        profilePick(raw, ['等级', 'level', '看法', 'view']),
        profilePick(raw, ['原因', 'reason']),
    );
}

/** 声望记录：等级归一，原因单独保留；旧的两段式「看法」也能读 */
function makeReputation(target, levelRaw, reasonRaw) {
    const rawLevel = profileText(levelRaw);
    const level = normalizeReputationLevel(rawLevel) || normalizeReputationLevel(reasonRaw);
    let reason = profileText(reasonRaw);
    if (!level) {
        // 旧数据是自由文本：整段作为看法保留，不强行改成中立
        return { target, level: '', reason: '', view: rawLevel || reason };
    }
    if (!reason && rawLevel && rawLevel !== level) {
        const cleaned = rawLevel.replace(/^(等级|看法)\s*[:：]?\s*/, '');
        const m = cleaned.match(/^[^：:｜|]+[：:｜|]([\s\S]+)$/);
        reason = (m ? m[1] : cleaned).trim();
    }
    return {
        target,
        level,
        reason,
        view: reason ? `${level}｜${reason}` : level,
    };
}

/** 统一玩家档案：中文/英文键都认，输出规范英文键 */
export function normalizePlayerProfile(raw) {
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const profile = {
        name: profileText(profilePick(src, ['名字', 'name'])),
        identity: profileText(profilePick(src, ['身份', 'identity'])),
        status: profileList(profilePick(src, ['状态', 'status'])),
        money: profileAmount(profilePick(src, ['钱', 'money'])),
        assets: [],
        items: [],
        relations: [],
        promises: [],
        knowledge: profileList(profilePick(src, ['知识', 'knowledge'])),
    };

    const items = profilePick(src, ['道具', 'items']);
    if (Array.isArray(items)) {
        for (const raw of items) {
            const item = itemEntry(raw);
            if (item) profile.items.push(item);
        }
    }
    const assets = profilePick(src, ['资产', 'assets']);
    if (Array.isArray(assets)) {
        for (const raw of assets) {
            const asset = assetEntry(raw);
            if (asset) profile.assets.push(asset);
        }
    }
    const relations = profilePick(src, ['关系', 'relations']);
    if (Array.isArray(relations)) {
        for (const raw of relations) {
            const rel = relationEntry(raw);
            if (rel) profile.relations.push(rel);
        }
    }
    const promises = profilePick(src, ['承诺', 'promises']);
    if (Array.isArray(promises)) {
        for (const raw of promises) {
            const promise = promiseEntry(raw);
            if (promise) profile.promises.push(promise);
        }
    }
    return profile;
}

/**
 * 合并玩家档案增量（AI 声明用中文键）。
 * 名字/身份：有值才覆盖；钱/数量：钳到 >=0；道具/资产/关系/承诺按名字合并；
 * 状态/知识按集合追加去重；「删除道具」按名字删。
 */
export function mergePlayerProfile(base, delta) {
    const current = normalizePlayerProfile(base);
    const src = delta && typeof delta === 'object' && !Array.isArray(delta) ? delta : {};
    if (!Object.keys(src).length) return current;

    const money = profilePick(src, ['钱', 'money']);
    const next = {
        name: profileText(profilePick(src, ['名字', 'name'])) || current.name,
        identity: profileText(profilePick(src, ['身份', 'identity'])) || current.identity,
        status: mergeUniqueList(current.status, profileList(profilePick(src, ['状态', 'status']))),
        money: money === undefined ? current.money : profileAmount(money),
        assets: current.assets.map(a => ({ ...a })),
        items: current.items.map(i => ({ ...i })),
        relations: current.relations.map(r => ({ ...r })),
        promises: current.promises.map(p => ({ ...p })),
        knowledge: mergeUniqueList(current.knowledge, profileList(profilePick(src, ['知识', 'knowledge']))),
    };
    // 状态可以显式移除（伤好了/醉醒了），不做只增不减
    const removeStatus = profileList(profilePick(src, ['移除状态', 'removeStatus']));
    if (removeStatus.length) {
        next.status = next.status.filter(s => !removeStatus.includes(s));
    }

    const items = profilePick(src, ['道具', 'items']);
    if (Array.isArray(items)) {
        for (const raw of items) {
            const incoming = itemEntry(raw);
            if (!incoming) continue;
            let item = next.items.find(i => i.name === incoming.name);
            if (!item) {
                item = { name: incoming.name, count: 0, place: '', state: '', note: '' };
                next.items.push(item);
            }
            const count = profilePick(raw, ['数量', 'count']);
            if (count !== undefined && count !== null && String(count).trim() !== '') {
                item.count = profileCount(count);
            }
            if (incoming.place) item.place = incoming.place;
            if (incoming.state) item.state = incoming.state;
            if (incoming.note) item.note = incoming.note;
        }
    }
    for (const name of profileList(profilePick(src, ['删除道具', 'deleteItems']))) {
        next.items = next.items.filter(i => i.name !== name);
    }

    const assets = profilePick(src, ['资产', 'assets']);
    if (Array.isArray(assets)) {
        for (const raw of assets) {
            const incoming = assetEntry(raw);
            if (!incoming) continue;
            let asset = next.assets.find(a => a.name === incoming.name);
            if (!asset) {
                asset = { name: incoming.name, state: '', income: '', note: '' };
                next.assets.push(asset);
            }
            if (incoming.state) asset.state = incoming.state;
            if (incoming.income) asset.income = incoming.income;
            if (incoming.note) asset.note = incoming.note;
        }
    }

    const relations = profilePick(src, ['关系', 'relations']);
    if (Array.isArray(relations)) {
        for (const raw of relations) {
            const incoming = relationEntry(raw);
            if (!incoming) continue;
            let rel = next.relations.find(r => r.name === incoming.name);
            if (!rel) {
                rel = { name: incoming.name, tag: '', reason: '', debt: '' };
                next.relations.push(rel);
            }
            if (incoming.tag) rel.tag = incoming.tag;
            if (incoming.reason) rel.reason = incoming.reason;
            if (incoming.debt) rel.debt = incoming.debt;
        }
    }

    const promises = profilePick(src, ['承诺', 'promises']);
    if (Array.isArray(promises)) {
        for (const raw of promises) {
            const incoming = promiseEntry(raw);
            if (!incoming) continue;
            // 有「什么」时按 谁+什么 认；只有「谁」时按谁更新最近一条
            let promise = incoming.what
                ? next.promises.find(p => p.who === incoming.who && p.what === incoming.what)
                : next.promises.find(p => p.who === incoming.who);
            if (!promise) {
                promise = { who: incoming.who, what: incoming.what, due: incoming.due, status: incoming.status };
                next.promises.push(promise);
            } else {
                if (incoming.what) promise.what = incoming.what;
                if (incoming.due) promise.due = incoming.due;
                if (incoming.status) promise.status = incoming.status;
            }
        }
    }

    return next;
}

/** 索引顶部的一行玩家摘要：玩家：名字｜钱 12｜物品：剑×1、药×2｜状态：受伤 */
export function formatPlayerSummary(profile) {
    const p = normalizePlayerProfile(profile);
    const parts = [`玩家：${p.name || '未知'}`];
    parts.push(`钱 ${p.money}`);
    const items = p.items
        .slice(0, 6)
        .map(item => (item.count > 0 ? `${item.name}×${item.count}` : item.name));
    if (items.length) parts.push(`物品：${items.join('、')}`);
    if (p.status.length) parts.push(`状态：${p.status.slice(0, 6).join('、')}`);
    return parts.join('｜');
}

/**
 * 索引顶部事实块（常量放在索引最前面，每轮整段重写，不会叠加）：
 *   【当前】时间｜地点｜在场：A、B
 *   【提醒】…
 *   玩家：…
 *   声望：…
 */
export function formatIndexHeader({ time = '', place = '', present = [], warnings = [], playerLine = '', repLine = '' } = {}) {
    const lines = [];
    const here = [];
    const t = profileText(time);
    const p = profileText(place);
    const who = profileList(present);
    if (t) here.push(t);
    if (p) here.push(p);
    if (who.length) here.push(`在场：${who.join('、')}`);
    if (here.length) lines.push(`【当前】${here.join('｜')}`);

    const warn = profileList(warnings);
    if (warn.length) lines.push(`【提醒】${warn.join('；')}`);

    const player = profileText(playerLine);
    if (player) lines.push(/^玩家[：:]/.test(player) ? player : `玩家：${player}`);

    const rep = profileText(repLine);
    if (rep) lines.push(/^(声望[：:]|【声望】)/.test(rep) ? rep : `声望：${rep}`);

    return lines.join('\n');
}

/** 解析「声望」条目：成就一行一条、名声一行一条；空/坏数据返回空数组 */
export function parseReputationContent(content) {
    const out = { achievements: [], reputations: [] };
    for (const rawLine of String(content ?? '').split('\n')) {
        const line = rawLine.trim().replace(/^[-*·]\s*/, '');
        if (!line) continue;
        const parts = line.split(/[｜|]/).map(s => s.trim());
        const kind = parts[0];
        if (kind === '成就') {
            const name = parts[1] || '';
            if (!name) continue;
            out.achievements.push({
                name,
                reason: parts[2] || '',
                note: parts[3] || '',
                known: parts[4] || '',
            });
        } else if (kind === '名声') {
            const target = parts[1] || '';
            if (!target) continue;
            const r = makeReputation(target, parts[2] || '', parts.slice(3).join('｜'));
            if (r) out.reputations.push(r);
        }
    }
    return out;
}

/** 生成「声望」条目文本；中文键/英文键都认 */
export function formatReputationContent(rep) {
    const src = rep && typeof rep === 'object' ? rep : {};
    const lines = [];

    const rawAchievements = profilePick(src, ['成就', 'achievements']);
    if (Array.isArray(rawAchievements)) {
        for (const raw of rawAchievements) {
            const a = achievementEntry(raw);
            if (!a) continue;
            lines.push(`- 成就｜${a.name}｜${a.reason}｜${a.note}｜${a.known}`);
        }
    }

    const rawReputations = profilePick(src, ['名声', 'reputations', 'fame']);
    if (Array.isArray(rawReputations)) {
        for (const raw of rawReputations) {
            const r = reputationEntry(raw);
            if (!r) continue;
            if (r.level) lines.push(`- 名声｜${r.target}｜${r.level}${r.reason ? `｜${r.reason}` : ''}`);
            else lines.push(`- 名声｜${r.target}｜${r.view}`);
        }
    } else if (rawReputations && typeof rawReputations === 'object') {
        // 兼容 { 对象: 看法 } 的映射写法
        for (const [target, view] of Object.entries(rawReputations)) {
            const name = profileText(target);
            if (!name) continue;
            const r = makeReputation(name, view, '');
            if (!r) continue;
            if (r.level) lines.push(`- 名声｜${name}｜${r.level}${r.reason ? `｜${r.reason}` : ''}`);
            else lines.push(`- 名声｜${name}｜${r.view}`);
        }
    }

    return lines.join('\n');
}

/** 旧关系数值转定性标签；新格式原样返回 */
export function normalizeRelationValue(value) {
    const text = profileText(value);
    if (!text) return '';
    const favMatch = text.match(/好感\s*[:：]?\s*(\d{1,3})/);
    const trustMatch = text.match(/信任\s*[:：]?\s*(\d{1,3})/);
    // 没有好感/信任数值 = 已经是定性写法，原样返回
    if (!favMatch && !trustMatch) return text;

    let reason = '';
    const tagMatch = text.match(/标签\s*[:：]\s*([\s\S]*)$/);
    if (tagMatch) {
        reason = tagMatch[1].trim();
    } else {
        const rest = text.split(/[｜|]/)
            .map(s => s.trim())
            .filter(s => s && !/^(好感|信任)/.test(s));
        reason = rest.join('；');
    }

    const fav = favMatch ? Number(favMatch[1]) : 50;
    const trust = trustMatch ? Number(trustMatch[1]) : 50;
    const tag = relationTagOf(fav, trust);
    return reason ? `${tag}：${reason}` : tag;
}

/** 好感/信任 → 定性标签（陌生/戒备/亲近/信任/依赖/敌对） */
function relationTagOf(fav, trust) {
    if (fav <= 20) return '敌对';
    if (fav <= 40) return '戒备';
    if (fav <= 60) return '陌生';
    if (fav <= 80) return '亲近';
    return trust >= 81 ? '依赖' : '信任';
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
