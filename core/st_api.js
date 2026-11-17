/**
 * SillyTavern 内部接口适配层。
 *
 * 只在这里接触 ST 的实现细节，其余模块一律经由 stBridge 调用。
 * 关键事实（ST 1.16.0 实测）：
 *  - `extension_settings`、`eventSource`、`event_types`、`world_names` 都**没有**挂到 window 上，
 *    只存在于模块作用域；window.xxx 读到的永远是 undefined。
 *  - 全局激活的真实状态是 world-info.js 里的 `selected_world_info`（export let，活引用），
 *    持久化副本才是 `extension_settings.world_info.globalSelect`。
 *  - 官方改激活态的唯一安全入口是 `onWorldInfoChange({state}, name)`（斜杠命令同源逻辑），
 *    它会同步 selected_world_info、存设置、发 WORLDINFO_SETTINGS_UPDATED。
 */

let wiModule = null;
let wiPromise = null;

export function getCtx() {
    try {
        return window.SillyTavern?.getContext?.() || window.getContext?.() || {};
    } catch (_) {
        return {};
    }
}

export function getEventSource() {
    const ctx = getCtx();
    return ctx.eventSource || window.eventSource || null;
}

export function getEventTypes() {
    const ctx = getCtx();
    return ctx.eventTypes || ctx.event_types || window.event_types || null;
}

export function getExtensionSettings() {
    const ctx = getCtx();
    return ctx.extensionSettings || window.extension_settings || null;
}

export function emit(name) {
    const es = getEventSource();
    const et = getEventTypes();
    if (!es || !et || !et[name]) return false;
    es.emit(et[name]);
    return true;
}

/** 懒加载 ST 的 world-info 模块，取到 selected_world_info / world_names 的活引用 */
export function loadWorldInfoModule() {
    if (wiModule) return Promise.resolve(wiModule);
    if (!wiPromise) {
        wiPromise = import('../../../../world-info.js')
            .then(m => { wiModule = m; return m; })
            .catch(e => {
                console.warn('[nekotools] 无法加载 world-info.js，全局激活降级为 DOM 方式', e);
                return null;
            })
            .finally(() => { wiPromise = null; });
    }
    return wiPromise;
}

/** 当前存在的世界书名（优先用 ST 的活列表，其次 DOM，最后 ctx） */
export function readWorldNames() {
    if (wiModule && Array.isArray(wiModule.world_names)) return [...wiModule.world_names];
    const ctx = getCtx();
    if (Array.isArray(ctx.world_names)) return [...ctx.world_names];
    const sel = document.getElementById('world_info');
    if (sel && sel.options) {
        const out = [];
        for (const opt of sel.options) {
            const t = (opt.text || '').trim();
            if (t && t !== 'None' && !t.startsWith('---')) out.push(t);
        }
        return out;
    }
    return [];
}

/** 当前全局激活的世界书名（活引用优先，其次 DOM，最后持久化副本） */
export function readActiveWorlds() {
    if (wiModule && Array.isArray(wiModule.selected_world_info)) {
        return [...wiModule.selected_world_info];
    }
    // 模块还没加载时，DOM 上的 selected 状态就是官方 change 处理器读取的依据
    const sel = document.getElementById('world_info');
    if (sel && sel.options && sel.options.length) {
        const picked = Array.from(sel.options)
            .filter(o => o.selected)
            .map(o => (o.text || '').trim())
            .filter(Boolean);
        if (picked.length) return picked;
    }
    const es = getExtensionSettings();
    const list = es?.world_info_settings?.world_info?.globalSelect
        ?? es?.world_info?.globalSelect;
    return Array.isArray(list) ? [...list] : [];
}

export function isWorldActive(name) {
    return readActiveWorlds().includes(name);
}

/** 让 ST 重新从服务端拉世界书列表，并重建 #world_info / #world_editor_select 的选项 */
export async function refreshWorldList() {
    const ctx = getCtx();
    try {
        if (typeof ctx.updateWorldInfoList === 'function') {
            await ctx.updateWorldInfoList();
            return true;
        }
    } catch (e) {
        console.warn('[nekotools] updateWorldInfoList 调用失败', e);
    }
    const m = await loadWorldInfoModule();
    if (m && typeof m.updateWorldInfoList === 'function') {
        try {
            await m.updateWorldInfoList();
            return true;
        } catch (e) {
            console.warn('[nekotools] world-info.updateWorldInfoList 调用失败', e);
        }
    }
    return false;
}

/**
 * 设置某本世界书的全局激活状态。
 * 注意：书必须已经存在于 #world_info 的选项里，所以新建书之后要先 refreshWorldList()。
 */
export async function setWorldActive(name, active) {
    if (!name) return false;
    const m = await loadWorldInfoModule();

    // 幂等：已经是目标状态就什么都不做。
    // onWorldInfoChange 的 'on' 分支是 push 而去重的，重复调用会让同一本书进两次。
    const currently = readActiveWorlds();
    if (currently.includes(name) === Boolean(active)) {
        refreshGlobalSelectUi();
        return true;
    }

    if (m && typeof m.onWorldInfoChange === 'function' && !String(name).includes(',')) {
        try {
            m.onWorldInfoChange({ state: active ? 'on' : 'off', silent: true }, name);
            refreshGlobalSelectUi();
            // 官方函数在「书不存在」时只 toast 不抛错，必须复核结果
            return readActiveWorlds().includes(name) === Boolean(active);
        } catch (e) {
            console.warn('[nekotools] onWorldInfoChange 失败，改用 DOM 回退', e);
        }
    }

    const sel = document.getElementById('world_info');
    if (!sel) return false;
    const target = String(name).trim().toLowerCase();
    const opt = Array.from(sel.options).find(o => (o.text || '').trim().toLowerCase() === target);
    if (!opt) return false;
    opt.selected = active;
    if (window.jQuery) window.jQuery(sel).trigger('change');
    else sel.dispatchEvent(new Event('change', { bubbles: true }));

    const ctx = getCtx();
    if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
    emit('WORLDINFO_SETTINGS_UPDATED');
    refreshGlobalSelectUi();
    return true;
}

/** 刷新世界书下拉框的显示（1.16 是 select2，无 multipleSelect） */
export function refreshGlobalSelectUi() {
    try {
        const $ = window.jQuery;
        if (!$) return;
        const el = $('#world_info');
        if (!el.length) return;
        if (el.data('select2')) {
            try { el.trigger('change.select2'); } catch (_) {}
        }
        if (el.data('multipleSelect')) {
            try { el.multipleSelect('refresh'); } catch (_) {}
        }
    } catch (_) {}
}

/** 角色卡绑定/解绑世界书（走 ST 官方 merge-attributes 落盘，不再调用不存在的 saveCharacterDebounced） */
export async function writeCharWorld(charIndex, worldName) {
    const ctx = getCtx();
    if (charIndex === undefined || charIndex === null || !ctx.characters?.[charIndex]) return false;
    if (typeof ctx.writeExtensionField === 'function') {
        try {
            await ctx.writeExtensionField(charIndex, 'world', worldName || '');
            return true;
        } catch (e) {
            console.warn('[nekotools] writeExtensionField 失败，仅改内存', e);
        }
    }
    const char = ctx.characters[charIndex];
    if (!char.data) char.data = {};
    if (!char.data.extensions) char.data.extensions = {};
    char.data.extensions.world = worldName || '';
    return false;
}

/** 删除世界书：必须走 ST 自己的 deleteWorldInfo，才会清 worldInfoCache（裸 API 不会） */
export async function deleteWorldInfo(name) {
    const m = await loadWorldInfoModule();
    if (m && typeof m.deleteWorldInfo === 'function') {
        try {
            await m.deleteWorldInfo(name);
            return true;
        } catch (e) {
            console.warn('[nekotools] deleteWorldInfo 失败，回退裸 API', e);
        }
    }
    return false;
}

/** 重新渲染聊天（隐藏楼层后让界面同步） */
export function reloadChatUi() {
    const ctx = getCtx();
    try {
        if (typeof ctx.reloadCurrentChat === 'function') {
            ctx.reloadCurrentChat();
            return true;
        }
    } catch (e) {
        console.warn('[nekotools] reloadCurrentChat 失败', e);
    }
    return emit('CHAT_CHANGED');
}
