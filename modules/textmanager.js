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
    slopRulesText: DEFAULT_SLOP_RULES.join('\n')
};

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

    const blocks = [];
    ctx.chat.forEach((msg, idx) => {
        if (favoritesOnly && !msg.extra?.nekotool_favorite) return;
        if (skipHidden && msg.is_system && msg.extra?.hidden) return;
        if (!msg.mes) return;

        // 剥离所有NEKOTOOL标签和HTML标签
        let text = msg.mes
            .replace(/<ws_[^>]*>[\s\S]*?<\/ws_[^>]*>/gi, '')
            .replace(/<nekotools:[^>]*>[\s\S]*?<\/nekotools:[^>]*>/gi, '')
            .replace(/<[^>]+>/g, '')
            .trim();

        if (!text) return;

        if (includeNames) {
            const name = msg.is_user ? (ctx.name1 || 'User') : (msg.name || 'AI');
            blocks.push(`${name}：${text}`);
        } else {
            blocks.push(text);
        }
    });

    const blob = new Blob([blocks.join('\n\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `story_${Date.now()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    if (window.toastr) {
        toastr.success(`已导出 ${blocks.length} 个楼层`);
    }
}

// ========== 一键清除八股 ==========
export async function cleanChatSlop({ rangeCount = 0, includeUser = false } = {}) {
    const ctx = stBridge.getContext();
    const rulesText = tmSettings.slopRulesText || DEFAULT_SLOP_RULES.join('\n');

    const rules = rulesText
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map(rule => {
            // 支持正则格式 /pattern/flags
            const regexMatch = rule.match(/^\/(.+?)\/([gimuy]*)$/);
            if (regexMatch) {
                try {
                    return new RegExp(regexMatch[1], regexMatch[2]);
                } catch {
                    return rule;
                }
            }
            // 支持替换格式 "旧词=>新词"
            if (rule.includes('=>')) {
                const [from, to] = rule.split('=>').map(s => s.trim());
                return { type: 'replace', from, to };
            }
            return rule;
        });

    let msgChanged = 0;
    let totalHits = 0;
    const startIdx = rangeCount > 0 ? Math.max(0, ctx.chat.length - rangeCount) : 0;

    for (let i = startIdx; i < ctx.chat.length; i++) {
        const msg = ctx.chat[i];
        if (!msg.mes || (msg.is_user && !includeUser)) continue;

        let cleaned = msg.mes;
        let changed = false;

        for (const rule of rules) {
            if (rule instanceof RegExp) {
                const before = cleaned;
                cleaned = cleaned.replace(rule, '');
                if (cleaned !== before) {
                    changed = true;
                    totalHits++;
                }
            } else if (rule.type === 'replace') {
                const before = cleaned;
                cleaned = cleaned.replace(new RegExp(rule.from, 'g'), rule.to);
                if (cleaned !== before) {
                    changed = true;
                    totalHits++;
                }
            } else if (typeof rule === 'string') {
                const before = cleaned;
                cleaned = cleaned.replace(new RegExp(rule, 'g'), '');
                if (cleaned !== before) {
                    changed = true;
                    totalHits++;
                }
            }
        }

        if (changed) {
            msg.mes = cleaned.trim();
            msgChanged++;
        }
    }

    if (msgChanged > 0) {
        if (typeof ctx.saveChatConditional === 'function') {
            ctx.saveChatConditional();
        } else if (typeof ctx.saveChat === 'function') {
            ctx.saveChat();
        }
    }

    return { msgChanged, totalHits };
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

            // 状态栏视觉置顶：模型把 <ws_status> 输出在正文末尾，
            // StreamGate 就地渲染，所以这里把它搬到消息文本最前面。
            document.querySelectorAll('#chat .mes_text .ws-status-bar').forEach(bar => {
                const holder = bar.closest('.mes_text');
                if (holder && holder.firstElementChild !== bar) {
                    holder.prepend(bar);
                }
            });

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
