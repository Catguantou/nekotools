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
let scriptModule = null;
let scriptPromise = null;
// 静默生成引用计数：嵌套调用时只有全部结束才真正解除静默
let quietDepth = 0;
let quietTimer = null;

/** 开始一段静默生成（期间 hooks 不注入、不结算，避免递归） */
export function beginQuiet() {
    quietDepth++;
    window.__nt_quiet = true;
    if (quietTimer) clearTimeout(quietTimer);
    // 安全兜底：异常退出没配对 endQuiet 时，10 分钟后自动解除，避免永久静默
    quietTimer = setTimeout(() => {
        quietDepth = 0;
        window.__nt_quiet = false;
        quietTimer = null;
    }, 10 * 60 * 1000);
}

/** 结束一段静默生成；引用计数归零才真正解除 */
export function endQuiet() {
    quietDepth = Math.max(0, quietDepth - 1);
    if (quietDepth === 0) {
        window.__nt_quiet = false;
        if (quietTimer) {
            clearTimeout(quietTimer);
            quietTimer = null;
        }
    }
}

export function getCtx() {
    try {
        return window.SillyTavern?.getContext?.() || window.getContext?.() || {};
    } catch (_) {
        return {};
    }
}

/** 懒加载 ST 的 script.js（静默生成等） */
export function loadScriptModule() {
    if (scriptModule) return Promise.resolve(scriptModule);
    if (!scriptPromise) {
        scriptPromise = import('../../../../../script.js')
            .then(m => { scriptModule = m; return m; })
            .catch(e => {
                console.warn('[nekotools] 无法加载 script.js，静默生成不可用', e);
                return null;
            })
            .finally(() => { scriptPromise = null; });
    }
    return scriptPromise;
}

/**
 * 用户主动点「请求更新」时的一次静默生成（不走聊天记录）。
 * 设置 window.__nt_quiet，让 hooks 跳过注入与结算，避免递归。
 */
export async function generateQuiet(prompt) {
    const mod = await loadScriptModule();
    if (!mod || typeof mod.generateQuietPrompt !== 'function') {
        throw new Error('当前酒馆版本不支持静默生成');
    }
    beginQuiet();
    const systemKey = '__NEKOTOOL_QUIET_SYSTEM__';
    const userKey = '__NEKOTOOL_QUIET_USER__';
    const types = mod.extension_prompt_types;
    const roles = mod.extension_prompt_roles;
    let systemPromptSet = false;
    let userPromptSet = false;
    try {
        // quietPrompt 在部分后端会被塞成 assistant；这里改成扩展 system 提示，
        // 再补一条最后的 user 触发，避免请求以模型消息结尾（Gemini 会拒绝）。
        if (typeof mod.setExtensionPrompt === 'function' && types && roles) {
            mod.setExtensionPrompt(systemKey, prompt, types.IN_PROMPT, 0, false, roles.SYSTEM);
            systemPromptSet = true;
            mod.setExtensionPrompt(
                userKey,
                '开始更新。',
                types.IN_CHAT,
                0,
                false,
                roles.USER,
            );
            userPromptSet = true;
        }
        return await mod.generateQuietPrompt({
            quietPrompt: systemPromptSet ? '' : prompt,
            quietToLoud: false,
        });
    } finally {
        if (systemPromptSet) {
            try {
                mod.setExtensionPrompt(systemKey, '', types.IN_PROMPT, 0, false, roles.SYSTEM);
            } catch (_) {}
        }
        if (userPromptSet) {
            try {
                mod.setExtensionPrompt(userKey, '', types.IN_CHAT, 0, false, roles.USER);
            } catch (_) {}
        }
        endQuiet();
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

    // 主路径：直接改 world-info 模块的活状态。
    // 不依赖 #world_info 的 option 是否存在（新书在列表刷新前没有 option，
    // 走官方 onWorldInfoChange 会静默失败，表现为「书建了但没挂上」）。
    const m = await loadWorldInfoModule();
    if (m && Array.isArray(m.selected_world_info)) {
        const arr = m.selected_world_info;
        const idx = arr.indexOf(name);
        if (active && idx === -1) arr.push(name);
        if (!active && idx !== -1) arr.splice(idx, 1);

        // 让保存链路拿到的 globalSelect 也是这份数组
        if (m.world_info) m.world_info.globalSelect = arr;

        // 重建下拉框，让 UI 勾选态跟上
        try {
            if (typeof m.updateWorldInfoList === 'function') await m.updateWorldInfoList();
        } catch (e) {
            console.warn('[nekotools] 重建世界书列表失败', e);
        }

        // 强制同步 #world_info 的选中态并触发 change：
        // ST 的「已启用的世界」标签由 select2 渲染，不触发 change 会一直显示 No Worlds active
        const selEl = document.getElementById('world_info');
        if (selEl) {
            const want = new Set(arr);
            for (const opt of selEl.options) {
                opt.selected = want.has((opt.text || '').trim());
            }
            try {
                if (window.jQuery) window.jQuery(selEl).trigger('change');
                else selEl.dispatchEvent(new Event('change', { bubbles: true }));
            } catch (e) {
                console.warn('[nekotools] 同步世界书选中态失败', e);
            }
        }

        const ctx = getCtx();
        if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
        emit('WORLDINFO_SETTINGS_UPDATED');
        refreshGlobalSelectUi();
        return readActiveWorlds().includes(name) === Boolean(active);
    }

    // 回退（模块拿不到时）：走官方 onWorldInfoChange
    if (m && typeof m.onWorldInfoChange === 'function' && !String(name).includes(',')) {
        try {
            m.onWorldInfoChange({ state: active ? 'on' : 'off', silent: true }, name);
            refreshGlobalSelectUi();
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
            // ST 会返回真实布尔值（列表里没有 / HTTP 失败都是 false），必须原样带出去，
            // 否则 st_bridge 永远以为删成功，文件其实还在。
            const ok = await m.deleteWorldInfo(name);
            return ok !== false;
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
