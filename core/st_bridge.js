import { settings } from './settings.js';
import {
    readWorldNames,
    readActiveWorlds,
    isWorldActive,
    refreshWorldList,
    setWorldActive,
    refreshGlobalSelectUi,
    writeCharWorld,
    deleteWorldInfo,
} from './st_api.js';

function extractStringName(item) {
    if (typeof item === 'string') return item.trim();
    if (item && typeof item === 'object') {
        const keys = ['name', 'file_id', 'filename', 'id', 'title'];
        for (const k of keys) {
            if (typeof item[k] === 'string' && item[k].trim()) return item[k].trim();
        }
    }
    return '';
}

function cleanAndDedupeList(arr) {
    const set = new Set();
    for (const item of arr) {
        const name = extractStringName(item);
        if (name && name !== '[object Object]') set.add(name);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

const loreCache = new Map();

export const stBridge = {
    getContext() {
        return window.SillyTavern?.getContext?.() || window.getContext?.() || {};
    },

    getLoreManagerConfig() {
        const cfg = settings.get('loremanager');
        return {
            activeBooks: Array.isArray(cfg.activeBooks) ? cfg.activeBooks : null,
            syncCharLifecycle: cfg.syncCharLifecycle !== false,
            autoActivateCharBook: cfg.autoActivateCharBook !== false,
            independentInject: cfg.independentInject !== false,
        };
    },

    saveLoreManagerConfig(patch) {
        settings.set('loremanager', patch);
    },

    /** 世界书的文件名由 ST 决定，非法字符会被后端改名；本地先统一处理，避免「建完找不到」 */
    sanitizeWorldName(name) {
        return String(name ?? '')
            .replace(/[\\/:*?"<>|]/g, '_')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 120);
    },

    getAutoActiveBooks() {
        const cfg = settings.get('loremanager');
        return Array.isArray(cfg.autoActiveBooks) ? cfg.autoActiveBooks : [];
    },

    rememberAutoActive(name) {
        if (!name) return;
        const list = this.getAutoActiveBooks();
        if (list.includes(name)) return;
        settings.set('loremanager', { autoActiveBooks: [...list, name] });
    },

    forgetAutoActive(name) {
        settings.set('loremanager', {
            autoActiveBooks: this.getAutoActiveBooks().filter(n => n !== name),
        });
    },

    /** 切角色时关掉其他角色的追踪库，否则旧角色的总结会被注入新角色 */
    async deactivateStaleAutoBooks(keepName) {
        const prefix = '【NEKOTOOL世界加载器·';
        const stale = new Set(
            this.getGloballyActivatedWorlds().filter(n => n.startsWith(prefix) && n !== keepName)
        );
        for (const name of this.getAutoActiveBooks()) {
            if (name !== keepName) stale.add(name);
        }
        for (const name of stale) {
            if (name && name !== keepName && this.isGloballyActivated(name)) {
                try { await this.mountGlobalWorldbook(name, false); } catch (_) {}
            }
            this.forgetAutoActive(name);
        }
    },

    getCharacterName() {
        const char = this.getCurrentCharacter();
        return char ? char.name : null;
    },

    getCurrentCharacter() {
        const ctx = this.getContext();
        const charId = ctx.characterId;
        if (charId !== undefined && charId !== null && ctx.characters && ctx.characters[charId]) {
            return ctx.characters[charId];
        }
        return null;
    },

    getWorldNames() {
        const ctx = this.getContext();
        const raw = [];

        // ST 的活列表（world-info.js 的 world_names）最可信
        const live = readWorldNames();
        if (Array.isArray(live)) raw.push(...live);

        if (Array.isArray(ctx.world_names)) raw.push(...ctx.world_names);

        const selectEl = document.getElementById('world_info');
        if (selectEl && selectEl.options) {
            for (const opt of selectEl.options) {
                const txt = (opt.text || '').trim();
                if (txt && txt !== 'None' && !txt.startsWith('---')) raw.push(txt);
            }
        }

        const wInfo = ctx.world_info || ctx.worldInfo;
        if (wInfo && typeof wInfo === 'object' && !Array.isArray(wInfo)) {
            raw.push(...Object.keys(wInfo));
        }

        return cleanAndDedupeList(raw);
    },

    async fetchWorldNamesFromApi() {
        const ctx = this.getContext();
        try {
            const headers = {
                ...(typeof ctx.getRequestHeaders === 'function' ? ctx.getRequestHeaders() : {}),
                'Content-Type': 'application/json'
            };
            const res = await fetch('/api/worldinfo/list', {
                method: 'POST',
                headers,
                body: JSON.stringify({})
            });
            if (!res.ok) return [];
            const data = await res.json();
            let raw = [];
            if (Array.isArray(data)) raw = data;
            else if (data && typeof data === 'object') raw = Object.keys(data);
            
            const names = cleanAndDedupeList(raw);
            // 让 ST 自己刷新列表：它会重建 #world_info 选项并重算 world_names。
            // 不再手工往 ctx.world_names 里塞——getContext() 返回的是快照对象，写了不生效。
            await refreshWorldList();
            return names.length ? names : cleanAndDedupeList(readWorldNames());
        } catch (e) {
            console.warn('[nekotools] /api/worldinfo/list 请求失败', e);
            return [];
        }
    },

    async loadWorldInfoAsync(name, forceApi = false) {
        if (!forceApi && loreCache.has(name)) return loreCache.get(name);

        const ctx = this.getContext();
        if (!forceApi && typeof ctx.loadWorldInfo === 'function') {
            try {
                const book = await ctx.loadWorldInfo(name);
                if (book) { loreCache.set(name, book); return book; }
            } catch (e) {}
        }
        try {
            const headers = {
                ...(typeof ctx.getRequestHeaders === 'function' ? ctx.getRequestHeaders() : {}),
                'Content-Type': 'application/json'
            };
            const res = await fetch('/api/worldinfo/get', {
                method: 'POST',
                headers,
                body: JSON.stringify({ name })
            });
            if (!res.ok) return null;
            const book = await res.json();
            loreCache.set(name, book);
            return book;
        } catch (e) {
            return null;
        }
    },

    getLorebook(name) {
        return loreCache.get(name) || null;
    },

    getGloballyActivatedWorlds() {
        return readActiveWorlds();
    },

    isGloballyActivated(name) {
        return isWorldActive(name);
    },

    async mountGlobalWorldbook(name, activate) {
        if (!name) return false;
        // 新建的书还没进 #world_info 的选项表时，官方激活会报「No world found named」，
        // 所以先让 ST 重新拉一遍列表。
        if (!this.getWorldNames().includes(name)) {
            await refreshWorldList();
        }
        const ok = await setWorldActive(name, activate);
        refreshGlobalSelectUi();
        return ok;
    },

    async preloadActivatedLorebooks() {
        await refreshWorldList();
        const names = this.getGloballyActivatedWorlds();
        for (const name of names) {
            await this.loadWorldInfoAsync(name, true);
        }
    },

    async createWorldbook(name, initContent = '') {
        const ctx = this.getContext();
        if (!ctx || !name) return false;

        // 空书就是空书。以前默认塞一条 constant 的「NEKOTOOL初始化」，
        // 一旦全局激活，这条会被 ST 每一轮都注入，等于往提示词里灌垃圾。
        const initData = { entries: {} };
        if (initContent) {
            initData.entries['1'] = {
                uid: '1',
                key: ['初始化'],
                comment: 'NEKOTOOL初始化',
                content: initContent,
                constant: true,
                selective: true,
                order: 100,
                position: 0,
                disable: false,
                excludeRecursion: true,
                preventRecursion: true,
            };
        }

        try {
            const headers = {
                ...(typeof ctx.getRequestHeaders === 'function' ? ctx.getRequestHeaders() : {}),
                'Content-Type': 'application/json'
            };

            const res = await fetch('/api/worldinfo/edit', {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({ name, data: initData })
            });

            if (!res.ok) throw new Error(`API 失败: ${res.status}`);

            loreCache.set(name, initData);
            const wInfo = ctx.world_info || ctx.worldInfo;
            if (wInfo) wInfo[name] = initData;

            // 关键：让 ST 重新拉一次列表。否则新书不在 #world_info 的选项里，
            // 激活时会报 No world found named，表现就是「书建出来了但挂不上」。
            await refreshWorldList();
            return true;
        } catch (e) {
            console.error('[nekotools] 创建世界书失败', e);
            return false;
        }
    },

    /** 确保某本书记存在且已全局激活；不存在就创建。返回可用的书数据。 */
    async ensureWorldbook(name, initContent = '') {
        if (!name) return null;

        let book = await this.loadWorldInfoAsync(name, true);
        if (!book) {
            const created = await this.createWorldbook(name, initContent);
            if (!created) return null;
            book = await this.loadWorldInfoAsync(name, true);
            if (!book) return null;
        }

        if (!this.isGloballyActivated(name)) {
            const activated = await this.mountGlobalWorldbook(name, true);
            if (activated) this.rememberAutoActive(name);
        }
        return book;
    },

    async deleteWorldbook(name, { syncUnbindChar = true, deleteLinkedChar = false } = {}) {
        const ctx = this.getContext();
        try {
            if (syncUnbindChar && Array.isArray(ctx.characters)) {
                for (let i = 0; i < ctx.characters.length; i++) {
                    const char = ctx.characters[i];
                    if (char?.data?.extensions?.world === name) {
                        // 走官方 merge-attributes 落盘；saveCharacterDebounced 在 ST 里不存在
                        await writeCharWorld(i, '');
                    }
                }
                await new Promise(r => setTimeout(r, 300));
            }

            // 先解绑全局激活，避免删完文件还留着幽灵选项
            await this.mountGlobalWorldbook(name, false);

            // 必须走 ST 的 deleteWorldInfo，它才会清 worldInfoCache；
            // 裸调 API 删书后，ST 仍可能从旧缓存里注入已删除的条目。
            let ok = await deleteWorldInfo(name);
            if (!ok) {
                const res = await fetch('/api/worldinfo/delete', {
                    method: 'POST',
                    headers: {
                        ...(typeof ctx.getRequestHeaders === 'function' ? ctx.getRequestHeaders() : {}),
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ name })
                });
                ok = res.ok;
            }

            if (ok) {
                loreCache.delete(name);
                const wInfo = ctx.world_info || ctx.worldInfo;
                if (wInfo && wInfo[name]) delete wInfo[name];
                this.forgetAutoActive(name);
                await refreshWorldList();
                return true;
            }
            return false;
        } catch (e) {
            console.error('[nekotools] 删除世界书失败', e);
            return false;
        }
    },

    async deleteEntries(bookName, uids) {
        const book = await this.loadWorldInfoAsync(bookName, true);
        if (!book || !book.entries) return false;
        for (const uid of uids) {
            delete book.entries[uid];
        }
        await this.persistLorebook(bookName, book);
        return true;
    },

    async forwardEntries(sourceName, targetName, uids) {
        const src = await this.loadWorldInfoAsync(sourceName, true);
        let dst = await this.loadWorldInfoAsync(targetName, true);

        if (!src || !src.entries) return false;
        
        if (!dst) {
            const created = await this.createWorldbook(targetName, '转发生成');
            if (!created) return false;
            dst = await this.loadWorldInfoAsync(targetName, true);
        }

        for (const uid of uids) {
            const entry = src.entries[uid];
            if (!entry) continue;
            const newUid = Date.now().toString() + Math.floor(Math.random() * 1000);
            dst.entries[newUid] = { ...JSON.parse(JSON.stringify(entry)), uid: newUid };
        }
        await this.persistLorebook(targetName, dst);
        return true;
    },

    async forwardBooks(sourceNames, targetName) {
        let dst = await this.loadWorldInfoAsync(targetName, true);
        if (!dst) {
            const created = await this.createWorldbook(targetName, '合并转发生成');
            if (!created) return { ok: false, count: 0 };
            dst = await this.loadWorldInfoAsync(targetName, true);
        }
        if (!dst.entries) dst.entries = {};

        let count = 0;
        for (const srcName of sourceNames) {
            if (srcName === targetName) continue;
            const src = await this.loadWorldInfoAsync(srcName, true);
            if (!src || !src.entries) continue;
            for (const entry of Object.values(src.entries)) {
                const newUid = Date.now().toString() + Math.floor(Math.random() * 10000);
                dst.entries[newUid] = { ...JSON.parse(JSON.stringify(entry)), uid: newUid };
                count++;
            }
        }
        await this.persistLorebook(targetName, dst);
        return { ok: true, count };
    },

    async toggleEntryState(bookName, uid, field) {
        const book = await this.loadWorldInfoAsync(bookName, true);
        if (!book || !book.entries || !book.entries[uid]) return false;
        const entry = book.entries[uid];
        entry[field] = !entry[field];
        await this.persistLorebook(bookName, book);
        return true;
    },

    async syncFromCharacterCard(charId, silent = false) {
        const ctx = this.getContext();
        const targetChar = charId !== null && charId !== undefined ? ctx.characters?.[charId] : this.getCurrentCharacter();
        if (!targetChar) return false;
        
        const charName = targetChar.name || '未命名角色';
        const book = targetChar.data?.character_book;
        const existingWorld = targetChar.data?.extensions?.world;
        
        if (existingWorld && this.getWorldNames().includes(existingWorld)) {
            return existingWorld;
        }
        
        if (!book || !book.entries || !book.entries.length) return false;
        
        const targetName = this.sanitizeWorldName(`【角色卡内嵌】${charName}`);
        const exists = this.getWorldNames().includes(targetName);
        if (exists && silent) return targetName;
        
        const initData = { entries: {} };
        book.entries.forEach((e, index) => {
            const uid = (Date.now() + index).toString();
            initData.entries[uid] = {
                uid: uid,
                key: e.keys || [],
                keysecondary: e.secondary_keys || [],
                comment: e.comment || e.name || `条目_${index}`,
                content: e.content || '',
                constant: e.constant || false,
                selective: e.selective || false,
                order: e.insertion_order || 100,
                position: e.position === 'before_char' ? 0 : 4,
                disable: e.enabled === false,
                excludeRecursion: true,
                preventRecursion: true
            };
        });
        
        try {
            const headers = {
                ...(typeof ctx.getRequestHeaders === 'function' ? ctx.getRequestHeaders() : {}),
                'Content-Type': 'application/json'
            };
            const res = await fetch('/api/worldinfo/edit', {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({ name: targetName, data: initData })
            });
            if (!res.ok) return false;
            
            loreCache.set(targetName, initData);
            const wInfo = ctx.world_info || ctx.worldInfo;
            if (wInfo) wInfo[targetName] = initData;

            await refreshWorldList();

            const charIndex = Array.isArray(ctx.characters) ? ctx.characters.indexOf(targetChar) : -1;
            if (charIndex >= 0) {
                await writeCharWorld(charIndex, targetName);
            } else {
                if (!targetChar.data) targetChar.data = {};
                if (!targetChar.data.extensions) targetChar.data.extensions = {};
                targetChar.data.extensions.world = targetName;
            }
            return targetName;
        } catch (e) {
            console.error('[nekotools] 角色卡同步失败', e);
            return false;
        }
    },

    async cleanupCharacterWorldbooks(payload) {
        const char = payload?.character || payload;
        if (!char) return;
        const charName = char.name;
        if (!charName) return;
        
        // 只删本插件自己建的追踪书；角色卡绑定的原生世界书属于用户资产，删卡时不动它
        const booksToDelete = [
            this.sanitizeWorldName(`【NEKOTOOL世界加载器·${charName}】`),
        ];
        
        for (const book of booksToDelete) {
            const worldNames = this.getWorldNames();
            if (worldNames.includes(book)) {
                await this.deleteWorldbook(book, { syncUnbindChar: false });
            }
        }
    },

    async updateEntry(bookName, title, content, isConstant = false, keywords = [], extra = {}) {
        const book = await this.loadWorldInfoAsync(bookName, true);
        if (!book) return;
        if (!book.entries) book.entries = {};

        let entryId = null;
        for (const [uid, entry] of Object.entries(book.entries)) {
            if (entry.comment === title) {
                entryId = uid;
                break;
            }
        }

        if (!entryId) {
            entryId = Date.now().toString() + Math.floor(Math.random() * 1000);
            book.entries[entryId] = {
                uid: entryId,
                key: isConstant ? [] : (keywords.length ? keywords : [title]),
                keysecondary: [],
                comment: title,
                content: content,
                constant: isConstant,
                selective: !isConstant,
                order: 100,
                position: 0,
                disable: false,
                excludeRecursion: true,
                preventRecursion: true,
                ...extra,
            };
        } else {
            const entry = book.entries[entryId];
            entry.content = content;
            entry.constant = isConstant;
            entry.selective = !isConstant;
            if (!isConstant && keywords.length) entry.key = keywords;
            Object.assign(entry, extra);
        }

        await this.persistLorebook(bookName, book);
    },

    async persistLorebook(bookName, bookData) {
        const ctx = this.getContext();
        loreCache.set(bookName, bookData);
        try {
            if (ctx && typeof ctx.saveWorldInfo === 'function' && bookData) {
                await ctx.saveWorldInfo(bookName, bookData, true);
            } else {
                const headers = {
                    ...(typeof ctx.getRequestHeaders === 'function' ? ctx.getRequestHeaders() : {}),
                    'Content-Type': 'application/json'
                };
                await fetch('/api/worldinfo/edit', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ name: bookName, data: bookData })
                });
            }
        } catch (e) {
            console.warn('[nekotools] 保存世界书失败', e);
        }
    },

    hideOldMessages(keepCount = 2, { visual = true } = {}) {
        const ctx = this.getContext();
        if (!ctx || !ctx.chat) return;
        let aiCount = 0;
        let cutoffIndex = -1;
        for (let i = ctx.chat.length - 1; i >= 0; i--) {
            const msg = ctx.chat[i];
            if (!msg.is_user && !msg.is_system) {
                aiCount++;
                if (aiCount === keepCount + 1) {
                    cutoffIndex = i;
                    break;
                }
            }
        }
        if (cutoffIndex >= 0) {
            for (let i = 0; i < cutoffIndex; i++) {
                const msg = ctx.chat[i];
                if (msg.extra && msg.extra.nekotool_favorite) continue;
                msg.extra = { ...(msg.extra || {}), hidden: true };
            }
            if (typeof ctx.saveChat === 'function') {
                // 数据层隐藏：只落盘，供导出过滤与下次重新加载使用
                ctx.saveChat();
            }
            // 视觉层隐藏：和上面是两回事，随时可一键恢复，不改任何数据
            if (visual) this.applyVisualHide(cutoffIndex);
        }
    },

    /** 视觉屏蔽：只给楼层加 class，看不见但数据没变 */
    applyVisualHide(cutoffIndex) {
        const chatEl = document.getElementById('chat');
        const ctx = this.getContext();
        if (!chatEl) return;
        for (let i = 0; i < cutoffIndex; i++) {
            if (ctx.chat?.[i]?.extra?.nekotool_favorite) continue;
            const el = chatEl.querySelector(`.mes[mesid="${i}"]`);
            if (el) el.classList.add('nt-visual-hidden');
        }
    },

    /** 恢复全部视觉显示（不动数据层的 hidden） */
    showAllHiddenMessages() {
        const chatEl = document.getElementById('chat');
        if (chatEl) {
            chatEl.querySelectorAll('.mes.nt-visual-hidden').forEach(el => el.classList.remove('nt-visual-hidden'));
        }
    }
};