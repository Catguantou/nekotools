import { registry } from './registry.js';
import { settings } from './settings.js';
import { stBridge } from './st_bridge.js';
import {
    cleanChatSlop,
    exportPureStoryTxt,
    getFavoriteFloors,
    jumpToFloor,
    toggleFavoriteFloor
} from '../modules/textmanager.js';

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

let lifecycleBound = false;

export function mountPanel() {
    if (document.getElementById('nt-ws-panel')) {
        document.getElementById('nt-ws-panel').remove();
    }

    const container = document.getElementById('extensions_settings') || document.getElementById('extensions_settings2');
    if (!container) {
        setTimeout(mountPanel, 1000);
        return;
    }

    const wrap = document.createElement('div');
    wrap.id = 'nt-ws-panel';
    wrap.className = 'extension_container';

    const mod = registry.get('worldsim');
    if (!mod || !mod.settings) {
        console.error('[nekotools] worldsim 未注册，面板无法挂载');
        return;
    }
    if (typeof mod.loadSettings === 'function') mod.loadSettings();

    const s = mod.settings;
    if (!s.customPrompts) s.customPrompts = {};

    const tmMod = registry.get('textmanager');
    if (tmMod && typeof tmMod.loadSettings === 'function') tmMod.loadSettings();
    const tm = tmMod ? tmMod.settings : {
        autoCleanOnReceive: false,
        exportIncludeNames: true,
        exportSkipHidden: false,
        slopRulesText: ''
    };

    const loreCfg = stBridge.getLoreManagerConfig();

    if (!lifecycleBound) {
        lifecycleBound = true;
        const ctx = stBridge.getContext();
        if (ctx.eventSource && ctx.eventTypes) {
            if (ctx.eventTypes.CHARACTER_DELETED) {
                ctx.eventSource.on(ctx.eventTypes.CHARACTER_DELETED, async (payload) => {
                    await stBridge.cleanupCharacterWorldbooks(payload);
                    const listEl = document.getElementById('nt-lore-list');
                    if (listEl) renderLoreList();
                });
            }
            if (ctx.eventTypes.CHAT_CHANGED) {
                ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, async () => {
                    const cfg = stBridge.getLoreManagerConfig();
                    if (cfg.syncCharLifecycle) {
                        const syncedBook = await stBridge.syncFromCharacterCard(null, true);
                        if (syncedBook && cfg.autoActivateCharBook) {
                            await stBridge.mountGlobalWorldbook(syncedBook, true);
                        }
                    }
                    await stBridge.preloadActivatedLorebooks();
                    const listEl = document.getElementById('nt-lore-list');
                    if (listEl) renderLoreList();
                });
            }
        }
    }

    function getModulesHtml() {
        let html = '';
        let i = 0;
        for (const m of registry.list()) {
            i++;
            const code = String(i).padStart(2, '0');
            html += `
            <label class="nt-grid-item">
                <input type="checkbox" data-mod-id="${m.id}" class="nt-hidden-cb nt-mod-cb" ${m.enabled ? 'checked' : ''}>
                <span class="nt-box"></span>
                <span class="nt-text">${escapeHtml(m.name)}</span>
                <span class="nt-code">M_${code}</span>
            </label>`;
        }
        return html;
    }

    function getPromptBlocksHtml() {
        const map = [
            ['status', 'P_01', '状态栏'],
            ['preview', 'P_02', '剧情预演'],
            ['chars', 'P_03', '角色追踪'],
            ['items', 'P_04', '道具追踪'],
            ['plot', 'P_05', '计划追踪'],
            ['world', 'P_06', '世界局势'],
            ['foreshadow', 'P_07', '草蛇伏笔'],
            ['summary', 'P_08', '小总结'],
            ['bigSummary', 'P_09', '大总结'],
        ];
        return map.map(([key, code, name]) => {
            const val = (s.customPrompts && s.customPrompts[key]) || '';
            return `
            <div class="nt-prompt-block">
                <div class="nt-prompt-head">
                    <span class="nt-prompt-code">${code}</span>
                    <span class="nt-prompt-name">${name}</span>
                </div>
                <textarea class="nt-prompt-textarea" data-prompt-key="${key}" placeholder="[自定义提示词 // 留空则使用默认契约]">${escapeHtml(val)}</textarea>
            </div>`;
        }).join('');
    }

    wrap.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header nt-header">
                <div class="nt-logo-wrap">
                    <div class="nt-deco-line"></div>
                    <b class="nt-logo glitch" data-text="NEKOTOOL">NEKOTOOL</b>
                    <span class="nt-sub">系统面板</span>
                </div>
                <div class="nt-coords">
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
            </div>

            <div class="inline-drawer-content nt-content">
                <div class="nt-noise"></div>
                <div class="nt-scanlines"></div>
                <div class="nt-bg-grid"></div>

                <div class="nt-tabs">
                    <button class="nt-tab active" data-target="nt-pane-core">01 / 核心</button>
                    <button class="nt-tab" data-target="nt-pane-lore">02 / 世界书</button>
                    <button class="nt-tab" data-target="nt-pane-data">03 / 数据</button>
                    <button class="nt-tab" data-target="nt-pane-prompt">04 / 提示词</button>
                    <button class="nt-tab" data-target="nt-pane-text">05 / 文本</button>
                </div>

                <div class="nt-tab-pane active" id="nt-pane-core">
                    <div class="nt-section">
                        <div class="nt-sec-head">
                            <span class="nt-index">01</span>
                            <span class="nt-title">系统模块</span>
                            <div class="nt-sec-line"></div>
                        </div>
                        <div class="nt-grid-layout">
                            ${getModulesHtml()}
                        </div>
                    </div>

                    <div class="nt-section">
                        <div class="nt-sec-head">
                            <span class="nt-index">02</span>
                            <span class="nt-title">配置限制</span>
                            <div class="nt-sec-line"></div>
                        </div>
                        <div class="nt-data-row">
                            <span class="nt-data-label">保留楼层数 <span class="nt-hint">/ 最新 N 条之外隐藏(收藏除外)</span></span>
                            <input type="number" id="nt-ws-keep" class="nt-data-input" value="${s.hideKeepCount}" min="1" max="50">
                        </div>
                        <div class="nt-data-row">
                            <span class="nt-data-label">大总结触发层数 <span class="nt-hint">/ 每 N 层触发</span></span>
                            <input type="number" id="nt-ws-biglimit" class="nt-data-input" value="${s.bigSummaryLimit}" min="10" max="9999">
                        </div>
                        <div class="nt-data-row" style="margin-top: 16px;">
                            <span class="nt-data-label">关注角色 <span class="nt-hint">/ 逗号分隔，留空追踪全部</span></span>
                        </div>
                        <div class="nt-data-row">
                            <input type="text" id="nt-ws-focuschars" class="nt-data-input" style="width:100%; text-align:left;" value="${escapeHtml(s.focusChars || '')}" placeholder="例如: 张三,李四">
                        </div>
                    </div>
                </div>

                <div class="nt-tab-pane" id="nt-pane-lore">
                    <div class="nt-section" style="margin-bottom: 14px;">
                        <div class="nt-sec-head">
                            <span class="nt-index">00</span>
                            <span class="nt-title">角色卡⇄世界书联动控制</span>
                            <div class="nt-sec-line"></div>
                        </div>
                        <div class="nt-grid-layout">
                            <label class="nt-grid-item" title="导入/切卡自动提取内嵌世界书，删角色卡自动删关联世界书">
                                <input type="checkbox" id="nt-lore-sync-life" class="nt-hidden-cb" ${loreCfg.syncCharLifecycle ? 'checked' : ''}>
                                <span class="nt-box"></span>
                                <span class="nt-text">角色卡同生共死</span>
                                <span class="nt-code">L_01</span>
                            </label>
                            <label class="nt-grid-item" title="由 NEKOTOOL 独立接管全局激活世界书注入，彻底解决酒馆开关失灵">
                                <input type="checkbox" id="nt-lore-indep-inject" class="nt-hidden-cb" ${loreCfg.independentInject ? 'checked' : ''}>
                                <span class="nt-box"></span>
                                <span class="nt-text">独立强制全局生效</span>
                                <span class="nt-code">L_02</span>
                            </label>
                        </div>
                    </div>

                    <div id="nt-lore-view-books">
                        <div class="nt-section">
                            <div class="nt-sec-head">
                                <span class="nt-index">01</span>
                                <span class="nt-title">全局世界书列表 <span class="nt-hint">(点击书名自由开关全局激活)</span></span>
                                <div class="nt-sec-line"></div>
                            </div>
                            <div class="nt-data-row" style="display:flex; gap: 10px; margin-bottom: 8px; flex-wrap: wrap;">
                                <button id="nt-ws-refresh" class="nt-btn-text">[刷新]</button>
                                <button id="nt-ws-select-all-books" class="nt-btn-text">[全选]</button>
                                <button id="nt-ws-new" class="nt-btn-text" style="color: var(--nt-blue);">[+ 新建]</button>
                                <button id="nt-ws-sync-char" class="nt-btn-text" style="color: #00ffcc;">[提取当前卡世界书]</button>
                                <button id="nt-ws-del-book" class="nt-btn-text" style="color: #ff3333;">[多选删除]</button>
                            </div>
                            <div class="nt-data-row" style="display:flex; gap: 8px; margin-bottom: 8px; align-items:center; flex-wrap: wrap;">
                                <span class="nt-hint">勾选多本书转发合并至:</span>
                                <select id="nt-ws-book-forward-target" class="nt-data-select" style="flex:1; min-width:120px; font-size:11px;"></select>
                                <button id="nt-ws-forward-books" class="nt-btn-text" style="color: var(--nt-blue);">[整书多选转发]</button>
                            </div>
                            <div id="nt-lore-list" class="nt-ws-booklist" style="max-height: 360px; display:block;"></div>
                        </div>
                    </div>

                    <div id="nt-lore-view-entries" style="display:none;">
                        <div class="nt-section">
                            <div class="nt-sec-head">
                                <span class="nt-index">02</span>
                                <span class="nt-title" id="nt-current-book-title" style="color:var(--nt-blue); text-overflow:ellipsis; overflow:hidden; white-space:nowrap; max-width:200px;">条目管理</span>
                                <div class="nt-sec-line"></div>
                            </div>
                            <div class="nt-data-row" style="display:flex; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; align-items:center;">
                                <button id="nt-ws-back" class="nt-btn-text">[← 返回书架]</button>
                                <button id="nt-ws-select-all-entries" class="nt-btn-text">[全选]</button>
                                <button id="nt-ws-del-entries" class="nt-btn-text" style="color: #ff3333;">[删除选中条目]</button>
                            </div>
                            <div class="nt-data-row" style="display:flex; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; align-items:center;">
                                <span class="nt-hint">选中条目转发至:</span>
                                <select id="nt-ws-forward-target" class="nt-data-select" style="flex:1; min-width:120px; font-size:11px;"></select>
                                <button id="nt-ws-forward" class="nt-btn-text" style="color: var(--nt-blue);">[执行条目转发]</button>
                            </div>
                            <div id="nt-lore-entries" class="nt-ws-booklist" style="max-height: 360px; display:block;"></div>
                        </div>
                    </div>
                </div>

                <div class="nt-tab-pane" id="nt-pane-data">
                    <div class="nt-section">
                        <div class="nt-sec-head">
                            <span class="nt-index">01</span>
                            <span class="nt-title">追踪开关</span>
                            <div class="nt-sec-line"></div>
                        </div>
                        <div class="nt-grid-layout">
                            <label class="nt-grid-item"><input type="checkbox" id="nt-ws-status" class="nt-hidden-cb" ${s.enableStatus ? 'checked' : ''}><span class="nt-box"></span><span class="nt-text">状态栏美化</span><span class="nt-code">T_01</span></label>
                            <label class="nt-grid-item"><input type="checkbox" id="nt-ws-preview" class="nt-hidden-cb" ${s.enablePreview ? 'checked' : ''}><span class="nt-box"></span><span class="nt-text">剧情预演</span><span class="nt-code">T_02</span></label>
                            <label class="nt-grid-item"><input type="checkbox" id="nt-ws-chars" class="nt-hidden-cb" ${s.enableChars ? 'checked' : ''}><span class="nt-box"></span><span class="nt-text">角色追踪</span><span class="nt-code">T_03</span></label>
                            <label class="nt-grid-item"><input type="checkbox" id="nt-ws-items" class="nt-hidden-cb" ${s.enableItems ? 'checked' : ''}><span class="nt-box"></span><span class="nt-text">道具追踪</span><span class="nt-code">T_04</span></label>
                            <label class="nt-grid-item"><input type="checkbox" id="nt-ws-plot" class="nt-hidden-cb" ${s.enablePlot ? 'checked' : ''}><span class="nt-box"></span><span class="nt-text">计划追踪</span><span class="nt-code">T_05</span></label>
                            <label class="nt-grid-item"><input type="checkbox" id="nt-ws-world" class="nt-hidden-cb" ${s.enableWorld ? 'checked' : ''}><span class="nt-box"></span><span class="nt-text">世界局势</span><span class="nt-code">T_06</span></label>
                            <label class="nt-grid-item"><input type="checkbox" id="nt-ws-foreshadow" class="nt-hidden-cb" ${s.enableForeshadow ? 'checked' : ''}><span class="nt-box"></span><span class="nt-text">草蛇伏笔</span><span class="nt-code">T_07</span></label>
                            <label class="nt-grid-item"><input type="checkbox" id="nt-ws-summary" class="nt-hidden-cb" ${s.enableSummary ? 'checked' : ''}><span class="nt-box"></span><span class="nt-text">小总结</span><span class="nt-code">T_08</span></label>
                            <label class="nt-grid-item"><input type="checkbox" id="nt-ws-bigsummary" class="nt-hidden-cb" ${s.enableBigSummary ? 'checked' : ''}><span class="nt-box"></span><span class="nt-text">大总结</span><span class="nt-code">T_09</span></label>
                        </div>
                    </div>
                </div>

                <div class="nt-tab-pane" id="nt-pane-prompt">
                    <div class="nt-section">
                        <div class="nt-sec-head">
                            <span class="nt-index">01</span>
                            <span class="nt-title">自定义提示词</span>
                            <div class="nt-sec-line"></div>
                        </div>
                        ${getPromptBlocksHtml()}
                    </div>
                </div>

                <div class="nt-tab-pane" id="nt-pane-text">
                    <div class="nt-section">
                        <div class="nt-sec-head">
                            <span class="nt-index">01</span>
                            <span class="nt-title">楼层收藏夹 <span class="nt-hint">/ 聊天框每层右上角点击 ☆ 即可收藏</span></span>
                            <div class="nt-sec-line"></div>
                        </div>
                        <div class="nt-data-row" style="gap:8px;">
                            <input type="number" id="nt-tm-fav-input" class="nt-data-input" style="width:90px; text-align:left;" placeholder="输入楼层号#" min="0">
                            <button id="nt-tm-fav-add" class="nt-btn-text" style="color:var(--nt-blue);">[收藏/取消该层]</button>
                            <button id="nt-tm-fav-refresh" class="nt-btn-text">[刷新列表]</button>
                        </div>
                        <div id="nt-tm-fav-list" class="nt-ws-booklist" style="max-height:180px; display:block;"></div>
                    </div>

                    <div class="nt-section">
                        <div class="nt-sec-head">
                            <span class="nt-index">02</span>
                            <span class="nt-title">纯净剧情导出 TXT <span class="nt-hint">/ 自动剥离思维链与系统标签</span></span>
                            <div class="nt-sec-line"></div>
                        </div>
                        <div class="nt-grid-layout" style="margin-bottom:10px;">
                            <label class="nt-grid-item">
                                <input type="checkbox" id="nt-tm-exp-names" class="nt-hidden-cb" ${tm.exportIncludeNames ? 'checked' : ''}>
                                <span class="nt-box"></span>
                                <span class="nt-text">附带角色/用户名</span>
                                <span class="nt-code">E_01</span>
                            </label>
                            <label class="nt-grid-item">
                                <input type="checkbox" id="nt-tm-exp-skip-hide" class="nt-hidden-cb" ${tm.exportSkipHidden ? 'checked' : ''}>
                                <span class="nt-box"></span>
                                <span class="nt-text">跳过已隐藏楼层</span>
                                <span class="nt-code">E_02</span>
                            </label>
                        </div>
                        <div class="nt-data-row" style="justify-content:flex-start; gap:12px;">
                            <button id="nt-tm-export-txt" class="nt-btn-action primary">[一键导出纯剧情 TXT]</button>
                            <button id="nt-tm-export-fav" class="nt-btn-action danger">[仅导出收藏楼层 TXT]</button>
                        </div>
                    </div>

                    <div class="nt-section">
                        <div class="nt-sec-head">
                            <span class="nt-index">03</span>
                            <span class="nt-title">一键清除八股 (代替正则)</span>
                            <div class="nt-sec-line"></div>
                        </div>
                        <div class="nt-grid-layout" style="margin-bottom:10px;">
                            <label class="nt-grid-item">
                                <input type="checkbox" id="nt-tm-auto-clean" class="nt-hidden-cb" ${tm.autoCleanOnReceive ? 'checked' : ''}>
                                <span class="nt-box"></span>
                                <span class="nt-text">AI回复后自动去八股</span>
                                <span class="nt-code">C_01</span>
                            </label>
                            <div class="nt-data-row" style="margin:0; padding:0 6px;">
                                <span class="nt-hint">扫描层数(0=全部):</span>
                                <input type="number" id="nt-tm-clean-range" class="nt-data-input" value="0" min="0" max="9999">
                            </div>
                        </div>
                        <div class="nt-prompt-block">
                            <div class="nt-prompt-head" style="justify-content:space-between;">
                                <span class="nt-prompt-name">自定义八股词库（一行一条，直接填词删除；或写 <code>旧词=>新词</code> 替换；支持 <code>/正则/g</code>）</span>
                                <button id="nt-tm-reset-rules" class="nt-btn-text">[恢复默认词库]</button>
                            </div>
                            <textarea id="nt-tm-slop-rules" class="nt-prompt-textarea" style="min-height:110px;">${escapeHtml(tm.slopRulesText || '')}</textarea>
                        </div>
                        <div class="nt-data-row" style="justify-content:flex-start; gap:12px;">
                            <button id="nt-tm-run-clean" class="nt-btn-action primary">[立即一键清除八股]</button>
                        </div>
                    </div>
                </div>

                <div class="nt-footer">
                    <button id="nt-ws-import" class="nt-btn-action danger">[导入]</button>
                    <button id="nt-ws-export" class="nt-btn-action danger">[导出]</button>
                    <button id="nt-ws-reset" class="nt-btn-action danger">重置</button>
                    <button id="nt-ws-save" class="nt-btn-action primary">应用</button>
                </div>
            </div>
        </div>
    `;

    container.appendChild(wrap);

    // 强制展开抽屉内容，无视酒馆的展开动画逻辑
    setTimeout(() => {
        const header = wrap.querySelector('.inline-drawer-toggle');
        const content = wrap.querySelector('.inline-drawer-content');
        if (header && content) {
            content.style.display = 'block';
            const icon = header.querySelector('.inline-drawer-icon');
            if (icon) {
                icon.classList.remove('down');
                icon.classList.add('up');
            }
        }
    }, 100);

    wrap.querySelectorAll('.nt-tab').forEach(tab => {
        tab.onclick = () => {
            wrap.querySelectorAll('.nt-tab').forEach(t => t.classList.remove('active'));
            wrap.querySelectorAll('.nt-tab-pane').forEach(p => p.classList.remove('active'));
            tab.classList.add('active');
            const targetPane = wrap.querySelector('#' + tab.dataset.target);
            if (targetPane) targetPane.classList.add('active');
            if (tab.dataset.target === 'nt-pane-text') renderFavoriteList();
            if (tab.dataset.target === 'nt-pane-lore') renderLoreList();
        };
    });

    const listEl = wrap.querySelector('#nt-lore-list');
    const entriesEl = wrap.querySelector('#nt-lore-entries');
    const viewBooks = wrap.querySelector('#nt-lore-view-books');
    const viewEntries = wrap.querySelector('#nt-lore-view-entries');
    const titleEl = wrap.querySelector('#nt-current-book-title');
    const forwardSelect = wrap.querySelector('#nt-ws-forward-target');
    const bookForwardSelect = wrap.querySelector('#nt-ws-book-forward-target');
    let currentEditingBook = null;

    wrap.querySelector('#nt-lore-sync-life').onchange = (e) => {
        stBridge.saveLoreManagerConfig({ syncCharLifecycle: e.target.checked });
    };
    wrap.querySelector('#nt-lore-indep-inject').onchange = (e) => {
        stBridge.saveLoreManagerConfig({ independentInject: e.target.checked });
    };

    async function renderLoreList() {
        listEl.innerHTML = '<div style="color:#888; font-size:11px; padding:6px;">正在同步世界书列表...</div>';
        let allNames = stBridge.getWorldNames();
        if (!allNames.length) {
            allNames = await stBridge.fetchWorldNamesFromApi();
        }

        bookForwardSelect.innerHTML = '<option value="">-- 选择合并目标书 --</option><option value="__NEW__">[+ 新建目标世界书...]</option>';
        allNames.forEach(n => {
            const opt = document.createElement('option');
            opt.value = n;
            opt.textContent = n;
            bookForwardSelect.appendChild(opt);
        });

        const activeNames = stBridge.getGloballyActivatedWorlds();
        const charBoundWorld = stBridge.getCurrentCharacter()?.data?.extensions?.world || '';

        if (!allNames.length) {
            listEl.innerHTML = '<div style="color:#888; font-size:11px; padding:6px;">未找到世界书，请点击 [+ 新建]。</div>';
            return;
        }

        let html = '';
        allNames.forEach(name => {
            const isGlobalActive = activeNames.includes(name);
            const isCharBound = charBoundWorld === name;
            const btnClass = isGlobalActive ? 'active' : '';
            const icon = isGlobalActive ? '◉' : '○';
            const color = isGlobalActive ? 'var(--nt-blue)' : '#666';
            const badge = isCharBound ? '<span style="color:#00ffcc; font-size:10px; margin-left:6px;">[当前卡绑定]</span>' : '';

            html += `
                <div class="nt-book-row ${btnClass}" style="display:flex; align-items:stretch; padding:0; margin-bottom:6px;">
                    <label style="padding:0 10px; display:flex; align-items:center; border-right:1px solid var(--nt-line); cursor:pointer; margin:0;">
                        <input type="checkbox" class="nt-book-select" data-name="${escapeHtml(name)}" style="cursor:pointer; width:15px; height:15px; margin:0;">
                    </label>
                    <div class="nt-book-activate" data-name="${escapeHtml(name)}" title="点击切换全局激活状态" style="flex:1; display:flex; align-items:center; padding:10px 12px; cursor:pointer; min-width:0;">
                        <span style="color:${color}; margin-right:10px; font-size:15px; font-weight:bold;">${icon}</span>
                        <span style="flex:1; text-align:left; text-overflow:ellipsis; overflow:hidden; white-space:nowrap;">${escapeHtml(name)}${badge}</span>
                        <span style="font-size:10px; color:${isGlobalActive ? '#fff' : '#666'}; margin-left:8px;">${isGlobalActive ? '[全局已激活]' : '[未激活]'}</span>
                    </div>
                    <div style="padding:0 10px; display:flex; align-items:center; border-left:1px solid var(--nt-line);">
                        <button class="nt-btn-text nt-edit-btn" data-name="${escapeHtml(name)}">[条目]</button>
                    </div>
                </div>
            `;
        });
        listEl.innerHTML = html;

        listEl.querySelectorAll('.nt-book-activate').forEach(row => {
            row.onclick = async () => {
                const name = row.dataset.name;
                const currentlyActive = stBridge.getGloballyActivatedWorlds().includes(name);
                await stBridge.mountGlobalWorldbook(name, !currentlyActive);
                await renderLoreList();
                if (window.toastr) {
                    toastr.success(!currentlyActive ? `已全局激活：${name}` : `已关闭全局激活：${name}`);
                }
            };
        });

        listEl.querySelectorAll('.nt-edit-btn').forEach(btn => {
            btn.onclick = async (e) => {
                e.stopPropagation();
                await openEntriesView(btn.dataset.name, allNames);
            };
        });
    }

    async function openEntriesView(bookName, allNames) {
        currentEditingBook = bookName;
        titleEl.textContent = bookName;
        viewBooks.style.display = 'none';
        viewEntries.style.display = 'block';
        entriesEl.innerHTML = '<div style="color:#888; font-size:11px; padding:6px;">正在读取条目...</div>';

        forwardSelect.innerHTML = '<option value="">-- 选择目标世界书 --</option><option value="__NEW__">[+ 新建目标世界书...]</option>';
        allNames.forEach(n => {
            if (n !== bookName) {
                const opt = document.createElement('option');
                opt.value = n;
                opt.textContent = n;
                forwardSelect.appendChild(opt);
            }
        });

        const book = await stBridge.loadWorldInfoAsync(bookName, true);
        if (!book || !book.entries) {
            entriesEl.innerHTML = '<div style="color:#ff3333; font-size:11px; padding:6px;">无法读取该世界书内容</div>';
            return;
        }

        const entries = Object.values(book.entries);
        if (!entries.length) {
            entriesEl.innerHTML = '<div style="color:#888; font-size:11px; padding:6px;">这本书是空的</div>';
            return;
        }

        let html = '';
        entries.forEach(e => {
            const isBlue = Boolean(e.constant);
            const isDisabled = Boolean(e.disable);
            const lightBtn = isBlue
                ? '<span style="color:#4d79ff; font-weight:bold;">[蓝灯常驻]</span>'
                : '<span style="color:#2ecc71;">[绿灯触发]</span>';
            const stateBtn = isDisabled
                ? '<span style="color:#ff4d4d;">[已禁用]</span>'
                : '<span style="color:#aaa;">[启用中]</span>';
            const title = e.comment || '未命名条目';

            html += `
                <div class="nt-book-row" style="display:flex; align-items:stretch; padding:0; margin-bottom:5px; opacity:${isDisabled ? '0.55' : '1'};">
                    <label style="padding:0 10px; display:flex; align-items:center; border-right:1px solid var(--nt-line); cursor:pointer; margin:0;">
                        <input type="checkbox" class="nt-entry-select" data-uid="${e.uid}" style="cursor:pointer; width:15px; height:15px; margin:0;">
                    </label>
                    <div style="flex:1; display:flex; align-items:center; padding:8px 10px; min-width:0; gap:8px;">
                        <button class="nt-btn-text nt-toggle-light" data-uid="${e.uid}" title="点击切换蓝灯/绿灯">${lightBtn}</button>
                        <span style="flex:1; text-align:left; text-overflow:ellipsis; overflow:hidden; white-space:nowrap;">${escapeHtml(title)}</span>
                        <button class="nt-btn-text nt-toggle-disable" data-uid="${e.uid}" title="点击切换启用/禁用">${stateBtn}</button>
                    </div>
                </div>
            `;
        });
        entriesEl.innerHTML = html;

        entriesEl.querySelectorAll('.nt-toggle-light').forEach(btn => {
            btn.onclick = async () => {
                await stBridge.toggleEntryState(bookName, btn.dataset.uid, 'constant');
                openEntriesView(bookName, stBridge.getWorldNames());
            };
        });
        entriesEl.querySelectorAll('.nt-toggle-disable').forEach(btn => {
            btn.onclick = async () => {
                await stBridge.toggleEntryState(bookName, btn.dataset.uid, 'disable');
                openEntriesView(bookName, stBridge.getWorldNames());
            };
        });
    }

    wrap.querySelector('#nt-ws-back').onclick = () => {
        currentEditingBook = null;
        viewEntries.style.display = 'none';
        viewBooks.style.display = 'block';
        renderLoreList();
    };

    wrap.querySelector('#nt-ws-refresh').onclick = async () => {
        await stBridge.fetchWorldNamesFromApi();
        await renderLoreList();
        if (window.toastr) toastr.info('世界书列表已刷新');
    };

    wrap.querySelector('#nt-ws-select-all-books').onclick = () => {
        const cbs = Array.from(listEl.querySelectorAll('.nt-book-select'));
        const allChecked = cbs.length > 0 && cbs.every(c => c.checked);
        cbs.forEach(c => { c.checked = !allChecked; });
    };

    wrap.querySelector('#nt-ws-select-all-entries').onclick = () => {
        const cbs = Array.from(entriesEl.querySelectorAll('.nt-entry-select'));
        const allChecked = cbs.length > 0 && cbs.every(c => c.checked);
        cbs.forEach(c => { c.checked = !allChecked; });
    };

    wrap.querySelector('#nt-ws-new').onclick = async () => {
        const charName = stBridge.getCharacterName();
        const defaultName = charName ? `【NEKOTOOL世界加载器·${charName}】` : '【NEKOTOOL新建世界书】';
        const targetName = prompt('请输入新世界书名称：', defaultName);
        if (!targetName) return;

        const success = await stBridge.createWorldbook(targetName.trim());
        if (success) {
            await stBridge.mountGlobalWorldbook(targetName.trim(), true);
            await renderLoreList();
            if (window.toastr) toastr.success('已创建并激活到全局世界书');
        } else if (window.toastr) {
            toastr.error('创建失败');
        }
    };

    wrap.querySelector('#nt-ws-sync-char').onclick = async () => {
        const result = await stBridge.syncFromCharacterCard(null, false);
        if (result === false) {
            if (window.toastr) toastr.warning('当前角色卡没有内嵌或绑定的世界书');
        } else if (result) {
            await stBridge.mountGlobalWorldbook(result, true);
            await renderLoreList();
            if (window.toastr) toastr.success(`已提取绑定角色卡世界书并全局激活：${result}`);
        } else if (window.toastr) {
            toastr.error('同步提取失败');
        }
    };

    wrap.querySelector('#nt-ws-del-book').onclick = async () => {
        const selected = Array.from(listEl.querySelectorAll('.nt-book-select:checked')).map(cb => cb.dataset.name);
        if (!selected.length) {
            if (window.toastr) toastr.warning('请先勾选要删除的世界书');
            return;
        }
        if (!confirm(`确定要彻底删除选中的 ${selected.length} 本世界书吗？此操作不可恢复！`)) return;

        const syncLife = wrap.querySelector('#nt-lore-sync-life')?.checked;
        let delLinkedChar = false;
        if (syncLife) {
            const ctx = stBridge.getContext();
            const hasBoundChar = Array.isArray(ctx.characters) && ctx.characters.some(
                c => selected.includes(c?.data?.extensions?.world)
            );
            if (hasBoundChar) {
                delLinkedChar = confirm('检测到部分世界书绑定了专属角色卡。\n点击【确定】连同关联角色卡一起彻底删除；\n点击【取消】仅删除世界书并解绑角色卡。');
            }
        }

        for (const name of selected) {
            await stBridge.deleteWorldbook(name, { syncUnbindChar: true, deleteLinkedChar: delLinkedChar });
        }
        await renderLoreList();
        if (window.toastr) toastr.success(`已删除 ${selected.length} 本世界书`);
    };

    wrap.querySelector('#nt-ws-forward-books').onclick = async () => {
        const selected = Array.from(listEl.querySelectorAll('.nt-book-select:checked')).map(cb => cb.dataset.name);
        if (!selected.length) {
            if (window.toastr) toastr.warning('请先在左侧勾选要转发的世界书（支持多选）');
            return;
        }

        let target = bookForwardSelect.value;
        if (!target) {
            if (window.toastr) toastr.warning('请先选择转发的目标世界书');
            return;
        }
        if (target === '__NEW__') {
            target = prompt('请输入合并后的新世界书名称：', '【合并世界书】');
            if (!target) return;
            target = target.trim();
        }

        const { ok, count } = await stBridge.forwardBooks(selected, target);
        if (ok) {
            await renderLoreList();
            if (window.toastr) toastr.success(`已将 ${selected.length} 本书共 ${count} 个条目转发合并至：${target}`);
        } else if (window.toastr) {
            toastr.error('整书转发失败');
        }
    };

    wrap.querySelector('#nt-ws-del-entries').onclick = async () => {
        if (!currentEditingBook) return;
        const selected = Array.from(entriesEl.querySelectorAll('.nt-entry-select:checked')).map(cb => cb.dataset.uid);
        if (!selected.length) {
            if (window.toastr) toastr.warning('请先勾选要删除的条目');
            return;
        }
        if (!confirm(`确定要删除这 ${selected.length} 个条目吗？`)) return;

        await stBridge.deleteEntries(currentEditingBook, selected);
        await openEntriesView(currentEditingBook, stBridge.getWorldNames());
        if (window.toastr) toastr.success(`已删除 ${selected.length} 个条目`);
    };

    wrap.querySelector('#nt-ws-forward').onclick = async () => {
        if (!currentEditingBook) return;
        const selected = Array.from(entriesEl.querySelectorAll('.nt-entry-select:checked')).map(cb => cb.dataset.uid);
        if (!selected.length) {
            if (window.toastr) toastr.warning('请先勾选要转发的条目');
            return;
        }

        let target = forwardSelect.value;
        if (!target) {
            if (window.toastr) toastr.warning('请选择目标世界书');
            return;
        }
        if (target === '__NEW__') {
            target = prompt('请输入新建目标世界书名称：', '【提取条目合集】');
            if (!target) return;
            target = target.trim();
        }

        const success = await stBridge.forwardEntries(currentEditingBook, target, selected);
        if (success) {
            if (window.toastr) toastr.success(`已转发 ${selected.length} 个条目至：${target}`);
        } else if (window.toastr) {
            toastr.error('转发失败');
        }
    };

    const favListEl = wrap.querySelector('#nt-tm-fav-list');

    function renderFavoriteList() {
        const favs = getFavoriteFloors();
        if (!favs.length) {
            favListEl.innerHTML = '<div style="color:#888; font-size:11px; padding:6px;">暂无收藏楼层（点击聊天消息右上角的 ☆ 即可收藏）</div>';
            return;
        }
        favListEl.innerHTML = favs.map(f => `
            <div class="nt-book-row" style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:5px;">
                <div class="nt-fav-jump" data-idx="${f.index}" style="flex:1; min-width:0; cursor:pointer;" title="点击跳转到该楼层">
                    <span style="color:#ffcc00; font-weight:bold; margin-right:6px;">★ #${f.index}</span>
                    <span style="color:var(--nt-blue); margin-right:6px;">[${escapeHtml(f.name)}]</span>
                    <span style="color:#ccc; font-size:11px;">${escapeHtml(f.preview)}</span>
                </div>
                <button class="nt-btn-text nt-fav-remove" data-idx="${f.index}" style="color:#ff4d4d;">[取消]</button>
            </div>
        `).join('');

        favListEl.querySelectorAll('.nt-fav-jump').forEach(el => {
            el.onclick = () => {
                const ok = jumpToFloor(Number(el.dataset.idx));
                if (!ok && window.toastr) toastr.warning('该楼层当前未加载在视口 DOM 中');
            };
        });
        favListEl.querySelectorAll('.nt-fav-remove').forEach(btn => {
            btn.onclick = async () => {
                await toggleFavoriteFloor(Number(btn.dataset.idx));
                renderFavoriteList();
            };
        });
    }

    window.addEventListener('nekotool:favorites-updated', renderFavoriteList);

    wrap.querySelector('#nt-tm-fav-refresh').onclick = renderFavoriteList;

    wrap.querySelector('#nt-tm-fav-add').onclick = async () => {
        const val = wrap.querySelector('#nt-tm-fav-input').value;
        if (val === '') return;
        const idx = parseInt(val, 10);
        if (Number.isNaN(idx)) return;
        const nowFav = await toggleFavoriteFloor(idx);
        renderFavoriteList();
        if (window.toastr) toastr.info(nowFav ? `已收藏 #${idx} 层` : `已取消收藏 #${idx} 层`);
    };

    function syncTextManagerInputs() {
        if (!tmMod) return;
        tmMod.settings.exportIncludeNames = wrap.querySelector('#nt-tm-exp-names').checked;
        tmMod.settings.exportSkipHidden = wrap.querySelector('#nt-tm-exp-skip-hide').checked;
        tmMod.settings.autoCleanOnReceive = wrap.querySelector('#nt-tm-auto-clean').checked;
        tmMod.settings.slopRulesText = wrap.querySelector('#nt-tm-slop-rules').value;
        tmMod.saveSettings();
    }

    wrap.querySelector('#nt-tm-export-txt').onclick = () => {
        syncTextManagerInputs();
        exportPureStoryTxt({ favoritesOnly: false });
    };

    wrap.querySelector('#nt-tm-export-fav').onclick = () => {
        syncTextManagerInputs();
        exportPureStoryTxt({ favoritesOnly: true });
    };

    wrap.querySelector('#nt-tm-reset-rules').onclick = () => {
        if (!tmMod || !confirm('确定恢复默认八股词库吗？')) return;
        const defText = tmMod.DEFAULT_SLOP_RULES.join('\n');
        wrap.querySelector('#nt-tm-slop-rules').value = defText;
        syncTextManagerInputs();
        if (window.toastr) toastr.info('已恢复默认八股词库');
    };

    wrap.querySelector('#nt-tm-run-clean').onclick = async () => {
        syncTextManagerInputs();
        const rangeCount = parseInt(wrap.querySelector('#nt-tm-clean-range').value, 10) || 0;
        const { msgChanged, totalHits } = await cleanChatSlop({ rangeCount, includeUser: false });
        if (window.toastr) {
            if (totalHits > 0) toastr.success(`清除完成：共净化 ${msgChanged} 个楼层，移除 ${totalHits} 处八股表达！`);
            else toastr.info('扫描完毕：未发现匹配的八股词汇');
        }
    };

    wrap.querySelector('#nt-ws-save').onclick = () => {
        wrap.querySelectorAll('.nt-mod-cb').forEach(cb => {
            const id = cb.dataset.modId;
            const m = registry.get(id);
            if (m) {
                m.enabled = cb.checked;
                settings.set(id, { enabled: m.enabled });
            }
        });

        s.enableStatus = wrap.querySelector('#nt-ws-status').checked;
        s.enablePreview = wrap.querySelector('#nt-ws-preview').checked;
        s.enableChars = wrap.querySelector('#nt-ws-chars').checked;
        s.enableItems = wrap.querySelector('#nt-ws-items').checked;
        s.enablePlot = wrap.querySelector('#nt-ws-plot').checked;
        s.enableWorld = wrap.querySelector('#nt-ws-world').checked;
        s.enableForeshadow = wrap.querySelector('#nt-ws-foreshadow').checked;
        s.enableSummary = wrap.querySelector('#nt-ws-summary').checked;
        s.enableBigSummary = wrap.querySelector('#nt-ws-bigsummary').checked;
        s.hideKeepCount = parseInt(wrap.querySelector('#nt-ws-keep').value) || 2;
        s.bigSummaryLimit = parseInt(wrap.querySelector('#nt-ws-biglimit').value) || 100;
        s.focusChars = wrap.querySelector('#nt-ws-focuschars').value;

        wrap.querySelectorAll('.nt-prompt-textarea[data-prompt-key]').forEach(ta => {
            const key = ta.dataset.promptKey;
            if (key) s.customPrompts[key] = ta.value;
        });

        mod.saveSettings();
        syncTextManagerInputs();
        if (window.toastr) toastr.success('数据已同步');
    };

    setTimeout(() => {
        renderLoreList();
        renderFavoriteList();
    }, 500);

    wrap.querySelector('#nt-ws-reset').onclick = () => {
        if (!confirm('确定要重置轮数统计与预演缓存吗？')) return;
        localStorage.removeItem('nt_worldsim_turn');
        localStorage.removeItem('nt_preview_cache');
        if (window.toastr) toastr.info('系统已重置');
    };

    wrap.querySelector('#nt-ws-export').onclick = () => {
        wrap.querySelector('#nt-ws-save').click();
        const extra = {
            nt_preview_cache: localStorage.getItem('nt_preview_cache'),
            nt_worldsim_turn: localStorage.getItem('nt_worldsim_turn'),
        };
        const payload = settings.exportAll(extra);
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `nekotool_backup_${Date.now()}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        if (window.toastr) toastr.success('已导出');
    };

    wrap.querySelector('#nt-ws-import').onclick = () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.onchange = async (e) => {
            const file = e.target.files && e.target.files[0];
            if (!file) return;
            try {
                const text = await file.text();
                const obj = JSON.parse(text);
                const state = settings.importAll(obj);
                if (state && state.nt_preview_cache) localStorage.setItem('nt_preview_cache', state.nt_preview_cache);
                if (state && state.nt_worldsim_turn) localStorage.setItem('nt_worldsim_turn', state.nt_worldsim_turn);

                for (const m of registry.list()) {
                    if (typeof m.loadSettings === 'function') m.loadSettings();
                }
                if (window.toastr) toastr.success('已导入');
                wrap.remove();
                mountPanel();
            } catch (err) {
                if (window.toastr) toastr.error('导入失败');
            }
        };
        input.click();
    };
}