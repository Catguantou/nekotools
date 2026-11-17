// 世界配置：白名单 / 黑名单 / 同人开关等。
// 存在追踪书的「世界配置」条目里（disable: true，永远不会被注入提示词）。
// 插件直接读书；只缓存解析后的配置对象，不缓存书内容。

import { stBridge } from './st_bridge.js';

const CONFIG_TITLE = '世界配置';
const cache = new Map();

function normalize(cfg) {
    const src = cfg && typeof cfg === 'object' ? cfg : {};
    return {
        ...src,
        pinned: Array.isArray(src.pinned) ? src.pinned.map(String).filter(Boolean) : [],
        blocked: Array.isArray(src.blocked) ? src.blocked.map(String).filter(Boolean) : [],
    };
}

/** 读配置；force=true 时跳过缓存（打开面板/改动后调用） */
export async function loadConfig(bookName, { force = false } = {}) {
    if (!bookName) return {};
    if (!force && cache.has(bookName)) return cache.get(bookName);

    let cfg = {};
    try {
        const book = await stBridge.loadWorldInfoAsync(bookName, true);
        const entry = book && book.entries
            ? Object.values(book.entries).find(e => e && e.comment === CONFIG_TITLE)
            : null;
        if (entry) cfg = JSON.parse(entry.content || '{}');
    } catch (e) {
        console.warn('[nekotools] 世界配置解析失败', e);
    }

    const normalized = normalize(cfg);
    cache.set(bookName, normalized);
    return normalized;
}

/** 同步取缓存；没加载过就是空配置（提示词注入用） */
export function getCachedConfig(bookName) {
    return bookName ? normalize(cache.get(bookName) || {}) : normalize({});
}

/** 合并保存；返回新配置 */
export async function saveConfig(bookName, patch) {
    if (!bookName) return null;
    const current = await loadConfig(bookName, { force: true });
    const next = normalize({ ...current, ...patch });

    const book = await stBridge.loadWorldInfoAsync(bookName, true);
    if (!book || !book.entries) return null;
    stBridge.upsertEntryInBook(book, CONFIG_TITLE, JSON.stringify(next, null, 2), {
        isConstant: true,
        extra: { disable: true, position: 0, order: 9999, key: [] },
    });
    await stBridge.persistLorebook(bookName, book);
    cache.set(bookName, next);
    return next;
}

export function invalidateConfig(bookName) {
    if (bookName) cache.delete(bookName);
    else cache.clear();
}
