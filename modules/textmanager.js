import { registry } from '../core/registry.js';
import { stBridge } from '../core/st_bridge.js';
import { settings as coreSettings } from '../core/settings.js';

// 默认八股词库
const DEFAULT_SLOP_RULES = [
    '空气仿佛凝固了',
    '眼神中',
    '嘴角勾起一抹玩味的弧度',
    '心中五味杂陈',
    '/\\*\\*[^*]*\\*\\*/g',  // 移除 /**思维链**/
    '/^[>＞].*$/gm'  // 移除引用行
];

const tmSettings = {
    autoCleanOnReceive: false,
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

export function jumpToFloor(index) {
    const mesEl = document.querySelector(`#chat .mes[mesid="${index}"]`);
    if (!mesEl) return false;

    mesEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    mesEl.classList.add('nt-floor-flash');
    setTimeout(() => mesEl.classList.remove('nt-floor-flash'), 1500);
    return true;
}

// ========== 纯文字导出 ==========
export function exportPureStoryTxt({ favoritesOnly = false } = {}) {
    const ctx = stBridge.getContext();
    const includeNames = tmSettings.exportIncludeNames !== false;
    const skipHidden = tmSettings.exportSkipHidden === true;
    const skipSystem = tmSettings.exportSkipSystem !== false;

    const blocks = [];
    (ctx.chat || []).forEach((msg, idx) => {
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

export async function cleanChatSlop({ rangeCount = 0, includeUser = false } = {}) {
    const ctx = stBridge.getContext();
    const chat = ctx.chat || [];
    const rules = parseSlopRules(tmSettings.slopRulesText || DEFAULT_SLOP_RULES.join('\n'));

    let msgChanged = 0;
    let totalHits = 0;
    const backup = [];
    const startIdx = rangeCount > 0 ? Math.max(0, chat.length - rangeCount) : 0;

    for (let i = startIdx; i < chat.length; i++) {
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

        // 自动清除八股（如果开启）
        const ctx = stBridge.getContext();
        if (ctx.eventSource && ctx.eventTypes?.MESSAGE_RECEIVED) {
            ctx.eventSource.on(ctx.eventTypes.MESSAGE_RECEIVED, async () => {
                if (tmSettings.autoCleanOnReceive) {
                    await cleanChatSlop({ rangeCount: 1, includeUser: false });
                }
            });
        }

        // 注入楼层收藏星标按钮
        const observer = new MutationObserver(() => {
            // 长聊天里 DOM 变动很频繁，节流一下，避免每次变动都全量扫描
            const now = Date.now();
            if (now - (observer._lastScan || 0) < 120) return;
            observer._lastScan = now;
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
