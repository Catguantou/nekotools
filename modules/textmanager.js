import { registry } from '../core/registry.js';
import { stBridge } from '../core/st_bridge.js';
import { settings as coreSettings } from '../core/settings.js';

// 默认八股词库（用户定制版：单条大正则）
const DEFAULT_SLOP_RULES = [
    '/不存在的|仪式|地、|毁灭性|重复了一遍|闪过|溺水者|崇拜|极端|虔诚|膜拜三分|七分|不是比喻。|共犯|[小幼野]兽|(?:(?:手指节|指节|指关节|手关节|关节)(?:微微|略微|稍微)?|(?:微微|略微|稍微))泛白|[吞拆]吃入腹|精准地|的、|溺水的人|浮木|一丝|生理性|不容(?:置疑|拒绝|置喙)(?:的|地)?|(?:自己|连他(?:自己)?|连她(?:自己)?)?(?:都没察觉到?(?:的)?|都未曾察觉)|不[可易]察觉[地的]|[微几]不可[察查]地|极[度其]|不是([^，。\\n]+)，而是|不是([^，。\\n]+)，不是([^，。\\n]+)，|没有([^，。\\n]+)，也没有([^，。\\n]+)，|不是([^，。\\n]+)，是|不是([^，。\\n]+)。也不是([^，。\\n]+)。|，指节([^，。\\n]+)泛白|语气|，像([^，。…… :\\n]+)/gm'
];

const tmSettings = {
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

    const tag = document.createElement('div');
    tag.className = 'plate-tag';
    const sq = document.createElement('span');
    sq.className = 'pt-sq';
    const sys = document.createElement('span');
    sys.className = 'mono';
    sys.textContent = 'SYS';
    tag.appendChild(sq);
    tag.appendChild(sys);

    const fields = document.createElement('div');
    fields.className = 'plate-fields';

    for (const p of parts) {
        const span = document.createElement('div');
        span.className = 'ws-status-item';
        const label = document.createElement('i');
        const value = document.createElement('b');
        const m = p.match(/^([^:：]+)[:：](.*)$/);
        if (m) {
            label.textContent = m[1].trim();
            value.textContent = m[2].trim();
        } else {
            label.textContent = '';
            value.textContent = p;
        }
        span.appendChild(label);
        span.appendChild(value);
        fields.appendChild(span);
    }

    const mark = document.createElement('div');
    mark.className = 'plate-mark';
    const bc = document.createElement('span');
    bc.className = 'barcode-v';
    const nm = document.createElement('span');
    nm.className = 'mono';
    nm.textContent = 'NT.STATUS';
    mark.appendChild(bc);
    mark.appendChild(nm);

    bar.appendChild(tag);
    bar.appendChild(fields);
    bar.appendChild(mark);
    return bar;
}

export function upgradeStatusBars(root = document) {
    const textEls = root === document
        ? document.querySelectorAll('#chat .mes_text')
        : (root.matches?.('.mes_text') ? [root] : (root.querySelectorAll ? [...root.querySelectorAll('.mes_text')] : []));
    textEls.forEach(textEl => {
        // 旧消息可能已经是渲染好的 HTML，直接置顶即可
        const existing = textEl.querySelector('.ws-status-bar');
        if (existing) {
            if (textEl.firstElementChild !== existing && !textEl.dataset.ntStatusPlaced) {
                textEl.prepend(existing);
            }
            textEl.dataset.ntStatusPlaced = '1';
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
            if (bar) {
                textEl.prepend(bar);
                textEl.dataset.ntStatusPlaced = '1';
            }
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

    // ST 的 context 只有 saveChat（底层是 saveChatConditional），没有 saveChatConditional
    await ctx.saveChat?.();

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
    // 结束楼层非法（NaN/非数字）时按「到末尾」处理：导出是只读操作，宁可多导也不要整段作废
    const toNum = (to === null || to === undefined) ? null : Number(to);
    const end = Number.isFinite(toNum)
        ? Math.min(chat.length - 1, Math.max(0, toNum))
        : chat.length - 1;

    const blocks = [];
    chat.forEach((msg, idx) => {
        if (idx < start || idx > end) return;
        if (favoritesOnly && !msg.extra?.nekotool_favorite) return;
        // 系统消息不是剧情；插件为省 token 隐藏的楼层不是系统消息，导出时照常当剧情楼层
        if (skipSystem && msg.is_system && !msg.extra?.nekotool_hidden_by_plugin) return;
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

/**
 * 关键词规则引擎：
 *  - 词：只删命中词（兼容旧版裸词条）
 *  - 句：删掉包含该词的整句（最推荐，避免删词后句子残缺）
 *  - 段：删掉包含该词的整段
 */
function buildKeywordRegex(keyword, mode) {
    const k = escapeRegExp(keyword);
    if (mode === 'sentence') {
        return new RegExp(`[^。！？!?\\n]*${k}[^。！？!?\\n]*[。！？!?]?`, 'g');
    }
    if (mode === 'paragraph') {
        return new RegExp(`(?:^|\\n)[^\\n]*${k}[^\\n]*(?:\\n|$)`, 'g');
    }
    return new RegExp(k, 'g');
}

function parseSlopRules(rulesText) {
    const raw = String(rulesText || '')
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'));
    // '# ' 前缀的停用规则在上面已被过滤；这里只处理启用规则

    const rules = [];
    for (const line of raw) {
        // @句 keyword / @词 keyword / @段 keyword
        const kw = line.match(/^@(词|句|段)\s+(.+)$/);
        if (kw) {
            const mode = kw[1] === '句' ? 'sentence' : (kw[1] === '段' ? 'paragraph' : 'word');
            try {
                rules.push({ re: buildKeywordRegex(kw[2].trim(), mode), to: '', mode: kw[1] });
            } catch (e) {
                console.warn('[nekotools] 无效关键词规则，已跳过:', line, e);
            }
            continue;
        }

        // /正则/flags
        const m = line.match(/^\/(.+)\/([gimuy]*)$/);
        if (m) {
            try {
                const flags = m[2].includes('g') ? m[2] : m[2] + 'g';
                rules.push({ re: new RegExp(m[1], flags), to: '', mode: '正则' });
            } catch (e) {
                console.warn('[nekotools] 无效正则，已跳过:', line, e);
            }
            continue;
        }

        // 旧词=>新词（字面替换）
        if (line.includes('=>')) {
            const [from, to = ''] = line.split('=>').map(s => s.trim());
            if (!from) continue;
            try {
                rules.push({ re: new RegExp(escapeRegExp(from), 'g'), to, mode: '替换' });
            } catch (e) {
                console.warn('[nekotools] 无效替换规则，已跳过:', line, e);
            }
            continue;
        }

        // 裸词（兼容旧版）：按字面删除
        try {
            rules.push({ re: new RegExp(escapeRegExp(line), 'g'), to: '', mode: '词' });
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

        const oldMes = msg.mes;
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

            // 同步当前 swipe 和 display_text，否则切 swipe / 重新渲染后看到的还是没清洗的旧文本
            const swipeId = msg.swipe_id;
            const oldSwipe = (Array.isArray(msg.swipes)
                && Number.isInteger(swipeId)
                && typeof msg.swipes[swipeId] === 'string') ? msg.swipes[swipeId] : null;
            const oldDisplay = (msg.extra && typeof msg.extra.display_text === 'string' && msg.extra.display_text === oldMes)
                ? msg.extra.display_text : null;

            backup.push({ i, mes: oldMes, swipeId, swipe: oldSwipe, display: oldDisplay });
            if (oldSwipe !== null) msg.swipes[swipeId] = cleaned;
            if (oldDisplay !== null) msg.extra.display_text = cleaned;
            msg.mes = cleaned;
            msgChanged++;
            refreshMessageDom(i, msg);
        }
    }

    if (msgChanged > 0) {
        await ctx.saveChat?.();
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
    for (const { i, mes, swipeId, swipe, display } of lastCleanBackup) {
        const msg = chat[i];
        if (!msg) continue;
        msg.mes = mes;
        // 清洗时同步改过 swipe / display_text，撤销时也要一起还原
        if (swipe !== null && swipe !== undefined && Array.isArray(msg.swipes) && Number.isInteger(swipeId)) {
            msg.swipes[swipeId] = swipe;
        }
        if (display !== null && display !== undefined && msg.extra && typeof msg.extra.display_text === 'string') {
            msg.extra.display_text = display;
        }
        refreshMessageDom(i, msg);
        restored++;
    }
    if (typeof ctx.saveChat === 'function') ctx.saveChat();
    lastCleanBackup = null;
    return restored;
}

export function canUndoClean() {
    return Boolean(lastCleanBackup && lastCleanBackup.length);
}

// ========== 八股视觉隐藏（NEKOTOOL 自己实现，不写入酒馆正则列表） ==========
const SLOP_HIDDEN_CLASS = 'nt-slop-hidden';
let slopCache = { text: null, re: null };

function getSlopRegex() {
    const text = tmSettings.slopRulesText || DEFAULT_SLOP_RULES.join('\n');
    if (slopCache.text === text) return slopCache.re;
    const parts = parseSlopRules(text).map(r => `(?:${r.re.source})`);
    let re = null;
    if (parts.length) {
        try {
            re = new RegExp(parts.join('|'), 'g');
        } catch (e) {
            console.warn('[nekotools] 合并八股正则失败', e);
        }
    }
    slopCache = { text, re };
    return re;
}

/**
 * 同步隐藏一条消息里的八股。
 * 必须在 MutationObserver 回调里同步调用：回调发生在浏览器绘制之前，
 * 所以用户看到的永远是已经隐藏好的文本（这就是不闪的关键）。
 */
export function hideSlopInMessage(mesEl) {
    if (tmSettings.hideSlopVisual !== true) return 0;
    const textEl = mesEl?.querySelector?.('.mes_text');
    if (!textEl) return 0;
    const re = getSlopRegex();
    if (!re) return 0;

    const len = String(textEl.textContent.length);
    if (textEl.dataset.ntSlopLen === len) return 0;

    const walker = document.createTreeWalker(textEl, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            if (!node.nodeValue || node.nodeValue.length < 2) return NodeFilter.FILTER_REJECT;
            if (node.parentElement && node.parentElement.closest('.' + SLOP_HIDDEN_CLASS)) {
                return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
        }
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    let hits = 0;
    for (const node of nodes) {
        const text = node.nodeValue;
        re.lastIndex = 0;
        if (!re.test(text)) continue;

        const frag = document.createDocumentFragment();
        let last = 0;
        let m;
        re.lastIndex = 0;
        while ((m = re.exec(text)) !== null) {
            if (m[0] === '') { re.lastIndex++; continue; }
            if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
            const span = document.createElement('span');
            span.className = SLOP_HIDDEN_CLASS;
            span.textContent = m[0];
            frag.appendChild(span);
            last = m.index + m[0].length;
            hits++;
        }
        if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
        node.parentNode.replaceChild(frag, node);
    }
    textEl.dataset.ntSlopLen = String(textEl.textContent.length);
    return hits;
}

/** 对所有楼层处理一次（开关打开、切换会话、初次加载时用） */
export function applySlopVisualAll() {
    let hits = 0;
    document.querySelectorAll('#chat .mes').forEach(el => {
        hits += hideSlopInMessage(el);
    });
    return hits;
}

/** 还原视觉隐藏（只动 DOM，不改存档） */
export function restoreSlopVisual() {
    document.querySelectorAll('#chat .' + SLOP_HIDDEN_CLASS).forEach(span => {
        const parent = span.parentNode;
        if (!parent) return;
        parent.replaceChild(document.createTextNode(span.textContent), span);
        parent.normalize();
    });
    document.querySelectorAll('#chat .mes .mes_text').forEach(el => {
        delete el.dataset.ntSlopLen;
    });
}

/** 迁移：清掉上一版写进酒馆正则列表里的脚本 */
export function removeNativeSlopRegex() {
    const ctx = stBridge.getContext();
    const es = ctx.extensionSettings || window.extension_settings;
    if (!es || !Array.isArray(es.regex)) return false;
    const before = es.regex.length;
    es.regex = es.regex.filter(s => s?.id !== 'nt-slop-visual');
    if (es.regex.length !== before) {
        try {
            if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
        } catch (_) {}
        return true;
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

        // 八股默认只做视觉隐藏（自研，不写入酒馆正则）
        const ctx = stBridge.getContext();
        removeNativeSlopRegex();
        setTimeout(() => applySlopVisualAll(), 400);

        // 注入楼层收藏星标按钮
        const observer = new MutationObserver((records) => {
            // 本次变动涉及的消息（供去八股/状态栏共用）
            const touched = new Set();

            // ① 同步去八股：MutationObserver 回调在绘制前执行，
            //    在这里改 DOM 用户看不到中间态，所以不会闪。
            //    流式生成期间不重写 DOM：每个 token 都重新包 span 会让正文持续闪烁，
            //    等 MESSAGE_RECEIVED / GENERATION_ENDED 再统一处理一次。
            if (tmSettings.hideSlopVisual === true && stBridge.getContext().isGenerating !== true) {
                try {
                    for (const rec of records) {
                        if (rec.type === 'characterData') {
                            const mes = rec.target.parentElement?.closest?.('.mes');
                            if (mes) touched.add(mes);
                            continue;
                        }
                        if (rec.target instanceof Element) {
                            const host = rec.target.closest?.('.mes_text');
                            if (host) {
                                const mes = host.closest('.mes');
                                if (mes) touched.add(mes);
                            }
                        }
                        for (const node of rec.addedNodes) {
                            if (node.nodeType !== 1) continue;
                            if (node.matches?.('.mes')) {
                                touched.add(node);
                            } else {
                                const mes = node.closest?.('.mes');
                                if (mes) touched.add(mes);
                                else node.querySelectorAll?.('.mes').forEach(m => touched.add(m));
                            }
                        }
                    }
                    touched.forEach(hideSlopInMessage);
                } catch (e) {
                    console.warn('[nekotools] 视觉隐藏失败（不影响其他功能）', e);
                }
            }

            // ② 星标/状态栏/视觉屏蔽：可以延后合并处理
            // 尾部节流：合并高频变动，但保证最后一次一定执行
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

            // 状态栏：只处理本次变动到的消息（全量留给初次加载）
            const ctx = stBridge.getContext();
            try {
                if (touched.size) {
                    touched.forEach(mesEl => upgradeStatusBars(mesEl));
                }
            } catch (e) {
                console.warn('[nekotools] 状态栏渲染失败', e);
            }
            try {
                // 流式输出时 DOM 每 100ms 就会变动一次；只有“楼层数变化”才需要重算视觉屏蔽，
                // 否则每次 token 都先移除再补回 nt-visual-hidden，整段聊天会不停闪。
                const liveLen = (stBridge.getContext().chat || []).length;
                if (observer._visualChatLen !== liveLen) {
                    observer._visualChatLen = liveLen;
                    stBridge.applyVisualKeep();
                }
            } catch (e) {
                console.warn('[nekotools] 视觉屏蔽失败', e);
            }
            }, 100);
        });

        const chatEl = document.getElementById('chat');
        if (chatEl) {
            observer.observe(chatEl, {
                childList: true,
                subtree: true
            });
        }

        // 兜底：生成结束 / 收到消息 / 切会话时再补一次状态栏渲染
        const ev = ctx.eventTypes || {};
        [ev.MESSAGE_RECEIVED, ev.GENERATION_ENDED, ev.CHAT_CHANGED].forEach(name => {
            if (!name || !ctx.eventSource) return;
            ctx.eventSource.on(name, () => setTimeout(() => {
                try {
                    upgradeStatusBars();
                    applySlopVisualAll();
                    stBridge.applyVisualKeep();
                } catch (e) {
                    console.warn('[nekotools] 状态栏补渲染失败', e);
                }
            }, 80));
        });

        // 初次加载：把已渲染好的旧楼层补处理一遍
        setTimeout(() => {
            upgradeStatusBars();
            applySlopVisualAll();
            stBridge.applyVisualKeep();
        }, 600);
    }
});
