// 世界配置：白名单 / 黑名单 / 同人开关等。
// 存在追踪书的「世界配置」条目里（disable: true，永远不会被注入提示词）。
// 插件直接读书；只缓存解析后的配置对象，不缓存书内容。

import { stBridge } from './st_bridge.js';

const CONFIG_TITLE = '世界配置';
const cache = new Map();
let writeQueue = Promise.resolve();

function normalize(cfg) {
    const src = cfg && typeof cfg === 'object' ? cfg : {};
    return {
        ...src,
        pinned: Array.isArray(src.pinned) ? src.pinned.map(String).filter(Boolean) : [],
        blocked: Array.isArray(src.blocked) ? src.blocked.map(String).filter(Boolean) : [],
    };
}

function readRawConfig(book) {
    const entry = book && book.entries
        ? Object.values(book.entries).find(e => e && e.comment === CONFIG_TITLE)
        : null;
    if (!entry) return {};
    try {
        return JSON.parse(entry.content || '{}');
    } catch {
        throw new Error('「世界配置」条目内容坏了，请先在世界书里修好再操作');
    }
}

/** 读配置；force=true 时跳过缓存（打开面板/改动后调用） */
export async function loadConfig(bookName, { force = false } = {}) {
    if (!bookName) return {};
    if (!force && cache.has(bookName)) return cache.get(bookName);

    let cfg = {};
    try {
        const book = await stBridge.loadWorldInfoAsync(bookName, true);
        cfg = readRawConfig(book);
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

/**
 * 合并保存；返回新配置。
 * 串行化：连点钉住/拉黑时不会互相覆盖；写前查 /list，删过的书不复活。
 */
export function saveConfig(bookName, patch) {
    const run = async () => {
        if (!bookName) return null;
        if (!(await stBridge.bookExists(bookName))) return null;

        const book = await stBridge.loadWorldInfoAsync(bookName, true);
        if (!book || !book.entries) return null;

        const current = readRawConfig(book);
        const next = normalize({ ...current, ...patch });

        stBridge.upsertEntryInBook(book, CONFIG_TITLE, JSON.stringify(next, null, 2), {
            isConstant: true,
            extra: { disable: true, position: 0, order: 9999, key: [] },
        });
        await stBridge.persistLorebook(bookName, book);
        cache.set(bookName, next);
        return next;
    };

    const p = writeQueue.then(run, run);
    writeQueue = p.then(() => {}, () => {});
    return p;
}

export function invalidateConfig(bookName) {
    if (bookName) cache.delete(bookName);
    else cache.clear();
}

// 删存档/删角色卡时，由 st_bridge 广播；这里清掉对应缓存，避免同名书继承旧名单
if (typeof window !== 'undefined') {
    window.addEventListener('nekotool:config-invalidated', (e) => {
        const names = e && e.detail && e.detail.names;
        if (Array.isArray(names)) {
            for (const n of names) cache.delete(n);
        } else {
            cache.clear();
        }
    });
}
