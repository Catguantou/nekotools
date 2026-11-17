// 纯函数：存档位命名规则 + 存档文件格式。
// 不碰 DOM、不碰世界书、不碰 ST 内部对象，方便 tools/check.mjs 直接跑样例。
//
// 命名规则：
//   第 1 档：【NEKOTOOL世界加载器·角色名】
//   第 N 档：【NEKOTOOL世界加载器·角色名·N】   (N >= 2)
// 解析只认结尾的「·数字」，角色名中间带 · 不会误伤。
// 已知边界：角色名本身以「·数字」结尾（例如真有人叫 Alice·2）会和档位后缀混淆，
// 这种名字极少见，暂不特殊处理。

export const TRACKER_PREFIX = '【NEKOTOOL世界加载器·';
export const TRACKER_SUFFIX = '】';
export const SLOT_SEP = '·';
export const SAVE_VERSION = 1;

// 世界书文件名能用的字符（与 st_bridge 现有规则保持一致）
const MAX_WORLD_NAME = 120;

export function sanitizeWorldName(name) {
    return String(name ?? '')
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_WORLD_NAME);
}

function composeTrackerName(charName, suffix = '') {
    const safe = sanitizeWorldName(charName);
    if (!safe) return '';
    const tail = `${suffix}${TRACKER_SUFFIX}`;
    const room = MAX_WORLD_NAME - TRACKER_PREFIX.length - tail.length;
    if (room <= 0) return '';
    // 超长角色名截断在角色名部分，保证结尾的 】 永远在，不然解析会坏
    return `${TRACKER_PREFIX}${safe.slice(0, room)}${tail}`;
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

/** 这本书是否属于某个角色（角色名按清洗后的形式比较） */
export function isSlotOf(name, charName) {
    const parsed = parseSlotName(name);
    if (!parsed) return false;
    return slotBaseName(parsed.charName) === slotBaseName(charName);
}

/** 存档列表里的显示名 */
export function slotLabel(n) {
    const num = Math.max(1, Math.floor(Number(n)) || 1);
    return `第 ${num} 档`;
}

/**
 * 生成存档文件对象。
 * book 传 ST 原样的世界书对象（{ entries: {...} }），内部深拷贝，避免调用方后续改动污染。
 */
export function buildSaveFile({ card, slot = 1, book, exportedAt } = {}) {
    const name = String(card ?? '').trim();
    if (!name) throw new Error('缺少角色名');
    if (!book || typeof book !== 'object' || !book.entries || typeof book.entries !== 'object') {
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
    if (!obj.book || typeof obj.book !== 'object' || !obj.book.entries || typeof obj.book.entries !== 'object') {
        throw new Error('存档里没有世界书内容');
    }
    const card = String(obj.card ?? '').trim();
    if (!card) throw new Error('存档缺少角色名');

    return {
        card,
        slot: Math.max(1, Math.floor(Number(obj.slot)) || 1),
        book: obj.book,
        exportedAt: String(obj.exportedAt || ''),
        version: Number(obj.version) || 0,
    };
}
