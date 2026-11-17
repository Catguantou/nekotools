import { registry } from '../core/registry.js';
import { stBridge } from '../core/st_bridge.js';
import { settings as coreSettings } from '../core/settings.js';

// 默认八股词库（用户定制版：单条大正则）
const DEFAULT_SLOP_RULES = [
    '/不存在的|仪式|地、|毁灭性|重复了一遍|闪过|溺水者|崇拜|极端|虔诚|膜拜三分|七分|不是比喻。|共犯|[小幼野]兽|(?:(?:手指节|指节|指关节|手关节|关节)(?:微微|略微|稍微)?|(?:微微|略微|稍微))泛白|[吞拆]吃入腹|精准地|的、|溺水的人|浮木|一丝|生理性|不容(?:置疑|拒绝|置喙)(?:的|地)?|(?:自己|连他(?:自己)?|连她(?:自己)?)?(?:都没察觉到?(?:的)?|都未曾察觉)|不[可易]察觉[地的]|[微几]不可[察查]地|极[度其]|不是([^，。\\n]+)，而是|不是([^，。\\n]+)，不是([^，。\\n]+)，|没有([^，。\\n]+)，也没有([^，。\\n]+)，|不是([^，。\\n]+)，是|不是([^，。\\n]+)。也不是([^，。\\n]+)。|，指节([^，。\\n]+)泛白|语气|，像([^，。…… :\\n]+)/gm'
];

const tmSettings = {
    autoCleanOnReceive: false,
    hideSlopVisual: true,
    exportIncludeNames: true,
    exportSkipHidden: false,
    exportSkipSystem: true,
    slopRulesText: DEFAULT_SLOP_RULES.join('\n')
};

// 清理后刷新单条消息的 DOM，否则界面要等重载才看得出变化
function refreshMessageDom(index, msg) {
    try {
        const ctx = stBridge.getContext();
        if (typeof ctx.updateMessageBlock === 'function') {
            ctx.updateMessageBlock(index, msg);
        }
    } catch (e) {
        console.warn('[nekotools] 刷新消息失败', e);
    }
}

function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ========== 状态栏升级（纯文本标记 → 样式条） ==========
const NT_STATUS_MARKER = '[[NT_STATUS]]';

function buildStatusBar(raw) {
    const parts = String(raw).split(/[|｜]/).map(s => s.trim()).filter(Boolean);
    if (!parts.length) return null;
    const bar = document.createElement('div');
    bar.className = 'ws-status-bar';
    for (const p of parts) {
        const span = document.createElement('span');
        span.className = 'ws-status-item';
        const m = p.match(/^([^:：]+)[:：](.*)$/);
        if (m) {
            const b = document.createElement('b');
            b.textContent = m[1].trim();
            span.appendChild(b);
            span.appendChild(document.createTextNode(' ' + m[2].trim()));
        } else {
            span.textContent = p;
        }
        bar.appendChild(span);
    }
    return bar;
}

export function upgradeStatusBars() {
    document.querySelectorAll('#chat .mes_text').forEach(textEl => {
        // 旧消息可能已经是渲染好的 HTML，直接置顶即可
        const existing = textEl.querySelector('.ws-status-bar');
        if (existing) {
            if (textEl.firstElementChild !== existing) textEl.prepend(existing);
            return;
        }
        const walker = document.createTreeWalker(textEl, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
            const idx = node.nodeValue.indexOf(NT_STATUS_MARKER);
            if (idx === -1) continue;
            const after = node.nodeValue.slice(idx + NT_STATUS_MARKER.length);
            const line = after.split('\n')[0];
            node.nodeValue = node.nodeValue.slice(0, idx).replace(/\s+$/, '');
            const bar = buildStatusBar(line);
            if (bar) textEl.prepend(bar);
            break;
        }
    });
}

// ========== 楼层收藏功能 ==========
export function getFavoriteFloors() {
    const ctx = stBridge.getContext();
    const chat = ctx.chat || [];
    return chat
        .map((msg, idx) => ({
            index: idx,
            name: msg.name || (msg.is_user ? 'User' : 'AI'),
            preview: (msg.mes || '').slice(0, 50).replace(/<[^>]+>/g, ''),
            isFav: msg.extra?.nekotool_favorite
        }))
        .filter(f => f.isFav);
}

export async function toggleFavoriteFloor(index) {
    const ctx = stBridge.getContext();
    const msg = ctx.chat?.[index];
    if (!msg) return false;

    if (!msg.extra) msg.extra = {};
    msg.extra.nekotool_favorite = !msg.extra.nekotool_favorite;

    if (typeof ctx.saveChatConditional === 'function') {
        ctx.saveChatConditional();
    } else if (typeof ctx.saveChat === 'function') {
        ctx.saveChat();
    }

    // 更新DOM显示
    const mesEl = document.querySelector(`#chat .mes[mesid="${index}"]`);
    if (mesEl) {
        mesEl.classList.toggle('nt-fav-mes', msg.extra.nekotool_favorite);
        const starBtn = mesEl.querySelector('.nt-fav-star-btn');
        if (starBtn) {
            starBtn.textContent = msg.extra.nekotool_favorite ? '★' : '☆';
            starBtn.classList.toggle('active', msg.extra.nekotool_favorite);
        }
    }

    window.dispatchEvent(new CustomEvent('nekotool:favorites-updated'));
    return msg.extra.nekotool_favorite;
}

/** 批量收藏/取消某个楼层区间（0 基，含端点） */
export function setFavoriteRange(from, to, value = true) {
    const ctx = stBridge.getContext();
    const chat = ctx.chat || [];
    const lo = Math.max(0, Math.min(from, to ?? from));
    const hi = Math.min(chat.length - 1, Math.max(from, to ?? from));
    let count = 0;
    for (let i = lo; i <= hi; i++) {
        if (!chat[i]) continue;
        chat[i].extra = { ...(chat[i].extra || {}), nekotool_favorite: Boolean(value) };
        count++;
    }
    if (count && typeof ctx.saveChat === 'function') ctx.saveChat();
    window.dispatchEvent(new CustomEvent('nekotool:favorites-updated'));
    return count;
}

export function jumpToFloor(index) {
    const mesEl = document.querySelector(`#chat .mes[mesid="${index}"]`);
    if (!mesEl) return false;

    mesEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    mesEl.classList.add('nt-floor-flash');
    setTimeout(() => mesEl.classList.remove('nt-floor-flash'), 1500);
    return true;
}

// ========== 纯文字导出 ==========
export function exportPureStoryTxt({ favoritesOnly = false, from = 0, to = null } = {}) {
    const ctx = stBridge.getContext();
    const includeNames = tmSettings.exportIncludeNames !== false;
    const skipHidden = tmSettings.exportSkipHidden === true;
    const skipSystem = tmSettings.exportSkipSystem !== false;

    const chat = ctx.chat || [];
    const start = Math.max(0, Number(from) || 0);
    const end = (to === null || to === undefined)
        ? chat.length - 1
        : Math.min(chat.length - 1, Math.max(0, Number(to)));

    const blocks = [];
    chat.forEach((msg, idx) => {
        if (idx < start || idx > end) return;
        if (favoritesOnly && !msg.extra?.nekotool_favorite) return;
        // 系统消息不是剧情；隐藏楼层按「数据层 hidden」判断，不再只看系统消息
        if (skipSystem && msg.is_system) return;
        if (skipHidden && msg.extra?.hidden) return;
        if (!msg.mes) return;

        // 剥离所有NEKOTOOL标签和HTML标签
        let text = msg.mes
            .replace(/<ws_[^>]*>[\s\S]*?<\/ws_[^>]*>/gi, '')
            .replace(/<nekotools:[^>]*>[\s\S]*?<\/nekotools:[^>]*>/gi, '')
            .replace(/\[\[NT_STATUS\]\][^\n]*/g, '')
            .replace(/<[^>]+>/g, '')
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();

        if (!text) return;

        if (includeNames) {
            const name = msg.is_user ? (ctx.name1 || 'User') : (msg.name || 'AI');
            blocks.push(`${name}：${text}`);
        } else {
            blocks.push(text);
        }
    });

    if (!blocks.length) {
        if (window.toastr) toastr.warning('没有可导出的楼层');
        return;
    }

    const blob = new Blob([blocks.join('\n\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const charName = stBridge.getCharacterName?.() || 'chat';
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    a.href = url;
    a.download = `${stBridge.sanitizeWorldName(charName)}_${stamp}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    if (window.toastr) {
        toastr.success(`已导出 ${blocks.length} 个楼层`);
    }
}

// ========== 一键清除八股 ==========
let lastCleanBackup = null;

function parseSlopRules(rulesText) {
    const raw = String(rulesText || '')
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'));

    const rules = [];
    for (const line of raw) {
        // /正则/flags
        const m = line.match(/^\/(.+)\/([gimuy]*)$/);
        if (m) {
            try {
                const flags = m[2].includes('g') ? m[2] : m[2] + 'g';
                rules.push({ re: new RegExp(m[1], flags), to: '' });
            } catch (e) {
                console.warn('[nekotools] 无效正则，已跳过:', line, e);
            }
            continue;
        }
        // 旧词=>新词（字面替换，不做正则解释）
        if (line.includes('=>')) {
            const [from, to = ''] = line.split('=>').map(s => s.trim());
            if (!from) continue;
            try {
                rules.push({ re: new RegExp(escapeRegExp(from), 'g'), to });
            } catch (e) {
                console.warn('[nekotools] 无效替换规则，已跳过:', line, e);
            }
            continue;
        }
        // 纯文本：按字面量删除，避免把 . * ? 之类当成正则
        try {
            rules.push({ re: new RegExp(escapeRegExp(line), 'g'), to: '' });
        } catch (e) {
            console.warn('[nekotools] 无效词条，已跳过:', line, e);
        }
    }
    return rules;
}

export async function cleanChatSlop({ rangeCount = 0, includeUser = false, from = null, to = null } = {}) {
    const ctx = stBridge.getContext();
    const chat = ctx.chat || [];
    const rules = parseSlopRules(tmSettings.slopRulesText || DEFAULT_SLOP_RULES.join('\n'));

    let msgChanged = 0;
    let totalHits = 0;
    const backup = [];
    const startIdx = (from !== null && from !== undefined)
        ? Math.max(0, Number(from))
        : (rangeCount > 0 ? Math.max(0, chat.length - rangeCount) : 0);
    const endIdx = (to !== null && to !== undefined)
        ? Math.min(chat.length - 1, Math.max(0, Number(to)))
        : chat.length - 1;

    for (let i = startIdx; i <= endIdx; i++) {
        const msg = chat[i];
        if (!msg.mes || (msg.is_user && !includeUser)) continue;

        let cleaned = msg.mes;
        let changed = false;

        for (const { re, to } of rules) {
            const before = cleaned;
            cleaned = cleaned.replace(re, to);
            if (cleaned !== before) {
                changed = true;
                totalHits++;
            }
        }

        if (changed) {
            // 收尾：去掉删词留下的重复标点与空白
            cleaned = cleaned
                .replace(/，{2,}/g, '，')
                .replace(/。{2,}/g, '。')
                .replace(/[ \t]{2,}/g, ' ')
                .replace(/\n{3,}/g, '\n\n')
                .trim();

            backup.push({ i, mes: msg.mes });
            msg.mes = cleaned;
            msgChanged++;
            refreshMessageDom(i, msg);
        }
    }

    if (msgChanged > 0) {
        if (typeof ctx.saveChat === 'function') ctx.saveChat();
        else if (typeof ctx.saveChatConditional === 'function') ctx.saveChatConditional();
    }

    lastCleanBackup = backup.length ? backup : null;
    return { msgChanged, totalHits };
}

/** 撤销上一次「立即清除八股」的改动（只保留一步） */
export function undoLastClean() {
    if (!lastCleanBackup || !lastCleanBackup.length) return 0;
    const ctx = stBridge.getContext();
    const chat = ctx.chat || [];
    let restored = 0;
    for (const { i, mes } of lastCleanBackup) {
        if (!chat[i]) continue;
        chat[i].mes = mes;
        refreshMessageDom(i, chat[i]);
        restored++;
    }
    if (typeof ctx.saveChat === 'function') ctx.saveChat();
    lastCleanBackup = null;
    return restored;
}

export function canUndoClean() {
    return Boolean(lastCleanBackup && lastCleanBackup.length);
}

// ========== 八股视觉隐藏：交给酒馆原生正则（渲染前生效） ==========

let lastNativeSlopSig = null;

/** 把八股规则同步成酒馆原生正则脚本（渲染前生效，无闪烁、无需刷新逐条处理） */
export function syncNativeSlopRegex() {
    const ctx = stBridge.getContext();
    const es = ctx.extensionSettings || window.extension_settings;
    if (!es) return false;
    if (!Array.isArray(es.regex)) es.regex = [];

    const id = 'nt-slop-visual';
    const list = es.regex;
    const idx = list.findIndex(s => s && s.id === id);
    const moduleOn = registry.get('textmanager')?.enabled !== false;
    const wantOn = moduleOn && tmSettings.hideSlopVisual === true;

    const text = tmSettings.slopRulesText || DEFAULT_SLOP_RULES.join('\n');
    const parts = parseSlopRules(text).map(r => `(?:${r.re.source})`);
    const findRegex = parts.length ? `/${parts.join('|').replace(/\//g, '\\/')}/gm` : null;

    const sig = `${wantOn}|${findRegex || ''}`;
    if (sig === lastNativeSlopSig) return false; // 规则没变，不折腾
    lastNativeSlopSig = sig;

    if (!wantOn || !findRegex) {
        if (idx !== -1) list.splice(idx, 1);
    } else {
        const script = {
            id,
            scriptName: '[NEKOTOOL] 八股视觉隐藏',
            findRegex,
            replaceString: '',
            trimStrings: [],
            placement: [2], // AI 输出
            disabled: false,
            markdownOnly: true,
            promptOnly: false,
            runOnEdit: true,
            substituteRegex: 0,
            minDepth: null,
            maxDepth: null,
        };
        if (idx === -1) list.unshift(script);
        else list[idx] = { ...list[idx], ...script };
    }

    try {
        if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
    } catch (e) {
        console.warn('[nekotools] 保存正则设置失败', e);
    }
    return true;
}

/** 让当前聊天重新走一遍渲染，正则改动才能立刻可见 */
export function refreshChatRender() {
    const ctx = stBridge.getContext();
    try {
        if (typeof ctx.reloadCurrentChat === 'function') {
            ctx.reloadCurrentChat();
            return true;
        }
    } catch (e) {
        console.warn('[nekotools] 重新渲染聊天失败', e);
    }
    return false;
}

// ========== 注册模块 ==========
registry.register({
    id: 'textmanager',
    name: '文本净水',
    enabled: true,
    order: 80,
    settings: tmSettings,
    DEFAULT_SLOP_RULES,

    loadSettings() {
        Object.assign(tmSettings, coreSettings.get('textmanager'));
    },

    saveSettings() {
        coreSettings.set('textmanager', tmSettings);
    },

    init() {
        this.loadSettings();

        // 八股默认只做视觉效果（原生正则脚本），不再自动改动正文
        const ctx = stBridge.getContext();
        syncNativeSlopRegex();

        // 注入楼层收藏星标按钮
        const observer = new MutationObserver(() => {
            // 尾部节流：合并高频变动，但保证最后一次一定执行
            //（之前用「丢弃」式节流，会把消息渲染的最后一帧吞掉，导致状态栏不渲染）
            clearTimeout(observer._timer);
            observer._timer = setTimeout(() => {
            document.querySelectorAll('#chat .mes:not([data-nt-star])').forEach(mesEl => {
                const mesId = mesEl.getAttribute('mesid');
                if (!mesId) return;

                mesEl.setAttribute('data-nt-star', '1');
                const header = mesEl.querySelector('.mes_block .ch_name, .mes_block .name_text');
                if (!header) return;

                const starBtn = document.createElement('span');
                starBtn.className = 'nt-fav-star-btn';
                starBtn.textContent = '☆';
                starBtn.title = '收藏此楼层';

                const ctx = stBridge.getContext();
                const msg = ctx.chat?.[mesId];
                if (msg?.extra?.nekotool_favorite) {
                    starBtn.classList.add('active');
                    starBtn.textContent = '★';
                    mesEl.classList.add('nt-fav-mes');
                }

                starBtn.onclick = async (e) => {
                    e.stopPropagation();
                    await toggleFavoriteFloor(Number(mesId));
                };

                header.style.position = 'relative';
                header.appendChild(starBtn);
            });

            // 状态栏：模型把内容输出在正文末尾，这里把它升级成样式条并置顶
            upgradeStatusBars();

            // 数据层已标记 hidden 的楼层，重载后重新套上视觉屏蔽
            const ctx = stBridge.getContext();
            document.querySelectorAll('#chat .mes[mesid]').forEach(el => {
                if (el.classList.contains('nt-visual-hidden')) return;
                const msg = ctx.chat?.[Number(el.getAttribute('mesid'))];
                if (msg?.extra?.hidden) el.classList.add('nt-visual-hidden');
            });
            }, 100);
        });

        const chatEl = document.getElementById('chat');
        if (chatEl) {
            observer.observe(chatEl, {
                childList: true,
                subtree: true
            });
        }
    }
});
