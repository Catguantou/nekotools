import { registry } from './registry.js';
import { settings } from './settings.js';
import { stBridge } from './st_bridge.js';
import {
    cleanChatSlop,
    exportPureStoryTxt,
    getFavoriteFloors,
    jumpToFloor,
    toggleFavoriteFloor,
    undoLastClean,
    setFavoriteRange,
    applySlopVisualAll,
    restoreSlopVisual
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
                ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, () => {
                    // 只刷新列表；建库/挂载/切旧书由 worldsim 负责，
                    // 面板这里再插一手会重复触发。
                    setTimeout(() => {
                        const listEl = document.getElementById('nt-lore-list');
                        if (listEl) renderLoreList();
                    }, 1000);
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
            ['roster', 'P_10', '角色索引'],
            ['genesis', 'P_11', '开局世界生成'],
            ['tick', 'P_12', '后台 tick'],
            ['map', 'P_13', '开局地图生成'],
            ['quest', 'P_14', '开局主线生成'],
            ['cognition', 'P_15', '认知隔离'],
            ['presence', 'P_16', '在场与日程'],
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
                    <button class="nt-tab active" data-target="nt-pane-core"><span class="nt-tnum">01</span>概览</button>
                    <button class="nt-tab" data-target="nt-pane-lore"><span class="nt-tnum">02</span>世界书</button>
                    <button class="nt-tab" data-target="nt-pane-data"><span class="nt-tnum">03</span>追踪</button>
                    <button class="nt-tab" data-target="nt-pane-text"><span class="nt-tnum">04</span>文本</button>
                    <button class="nt-tab" data-target="nt-pane-settings"><span class="nt-tnum">05</span>设置</button>
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
                            <label class="nt-grid-item"><input type="checkbox" id="nt-ws-quickmenu" class="nt-hidden-cb" ${s.enableQuickMenu !== false ? 'checked' : ''}><span class="nt-box"></span><span class="nt-text">TOOL 菜单</span><span class="nt-code">U_01</span></label>
                        </div>
                    </div>

                    <div class="nt-section">
                        <div class="nt-sec-head">
                            <span class="nt-index">02</span>
                            <span class="nt-title">配置限制</span>
                            <div class="nt-sec-line"></div>
                        </div>
                        <div class="nt-data-row">
                            <span class="nt-data-label">数据隐藏保留 <span class="nt-hint">/ 最新 N 条之外打 hidden 标记(影响导出)</span></span>
                            <input type="number" id="nt-ws-keep" class="nt-data-input" value="${s.hideKeepCount}" min="0" max="50">
                        </div>
                        <div class="nt-data-row">
                            <span class="nt-data-label">视觉屏蔽保留 <span class="nt-hint">/ 最新 M 条之外只在界面上隐藏，0=关闭</span></span>
                            <input type="number" id="nt-ws-visual-keep" class="nt-data-input" value="${s.visualHideKeep || 0}" min="0" max="200">
                        </div>
                        <div class="nt-data-row">
                            <button id="nt-ws-visual-restore" class="nt-btn-text" style="color:#00ffcc;">[恢复视觉显示]</button>
                        </div>
                        <div class="nt-data-row">
                            <span class="nt-data-label">大总结触发层数 <span class="nt-hint">/ 每 N 层触发</span></span>
                            <input type="number" id="nt-ws-biglimit" class="nt-data-input" value="${s.bigSummaryLimit}" min="10" max="9999">
                        </div>
                        <div class="nt-data-row">
                            <span class="nt-data-label">把用户角色记入世界书 <span class="nt-hint">/ 关闭后不创建/更新「角色·你」</span></span>
                            <label style="display:flex;align-items:center;gap:6px;">
                                <input type="checkbox" id="nt-ws-record-user" ${s.recordUserCharacter ? 'checked' : ''}> 启用
                            </label>
                        </div>
                        <div class="nt-data-row" style="margin-top: 16px;">
                            <span class="nt-data-label">后台 tick <span class="nt-hint">/ 角色与世界的离屏推进</span></span>
                            <label style="display:flex;align-items:center;gap:6px;">
                                <input type="checkbox" id="nt-ws-tick-enable" ${s.enableTicks ? 'checked' : ''}> 启用
                            </label>
                        </div>
                        <div class="nt-data-row">
                            <span class="nt-data-label">T2 离场间隔 <span class="nt-hint">/ 不在场时每 N 层更新一次（默认 2）</span></span>
                            <input type="number" id="nt-ws-char-tick" class="nt-data-input" value="${s.charTickEvery}" min="1" max="50">
                        </div>
                        <div class="nt-data-row">
                            <span class="nt-data-label">世界 tick 间隔 <span class="nt-hint">/ 每 N 条 AI 回复结算一次，0=关</span></span>
                            <input type="number" id="nt-ws-world-tick" class="nt-data-input" value="${s.worldTickEvery}" min="0" max="50">
                        </div>
                        <div class="nt-data-row">
                            <span class="nt-data-label">每轮最多结算角色 <span class="nt-hint">/ 控制 token；T1 不受限</span></span>
                            <input type="number" id="nt-ws-tick-max" class="nt-data-input" value="${s.tickMaxChars}" min="1" max="10">
                        </div>
                        <div class="nt-data-row">
                            <span class="nt-data-label">T3 间隔 <span class="nt-hint">/ 配角每 N 层更新一次（默认 5）</span></span>
                            <input type="number" id="nt-ws-stale-after" class="nt-data-input" value="${s.staleAfter}" min="5" max="200">
                            <label style="display:flex;align-items:center;gap:6px;margin-left:8px;">
                                <input type="checkbox" id="nt-ws-antilazy" ${s.enableAntiLazy ? 'checked' : ''}> 20层降级
                            </label>
                        </div>
                    </div>

                    <div class="nt-section">
                        <div class="nt-sec-head">
                            <span class="nt-index">03</span>
                            <span class="nt-title">快捷跳转</span>
                            <div class="nt-sec-line"></div>
                        </div>
                        <div class="nt-data-row" style="gap:10px; flex-wrap:wrap;">
                            <button class="nt-btn-text" data-goto="nt-pane-lore">[世界书]</button>
                            <button class="nt-btn-text" data-goto="nt-pane-data">[追踪]</button>
                            <button class="nt-btn-text" data-goto="nt-pane-text">[文本]</button>
                            <button class="nt-btn-text" data-goto="nt-pane-settings">[设置]</button>
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
                            <div class="nt-hint" style="padding:8px 2px; line-height:1.6;">
                                进入角色卡会自动为这张卡建一本空追踪书并挂到全局；切换角色时旧卡的书会自动取消挂载。
                            </div>
                        </div>
                        <label class="nt-grid-item" style="margin-top:8px;" title="删除角色卡时同时删除它绑定的世界书；删除世界书时可选择连绑定角色卡一起删。NEKOTOOL 追踪书不参与这条规则。">
                            <input type="checkbox" id="nt-lore-sync-delete" class="nt-hidden-cb" ${stBridge.getLoreManagerConfig().syncCharLifecycle ? 'checked' : ''}>
                            <span class="nt-box"></span>
                            <span class="nt-text">角色卡⇄世界书 同步删除</span>
                            <span class="nt-code">L_01</span>
                        </label>
                        <label class="nt-grid-item" style="margin-top:8px;" title="连坐删除角色卡时，是否把它名下的聊天记录也一并删除。默认只删卡、保留聊天。">
                            <input type="checkbox" id="nt-lore-del-chats" class="nt-hidden-cb" ${stBridge.getLoreManagerConfig().deleteChatsWithChar ? 'checked' : ''}>
                            <span class="nt-box"></span>
                            <span class="nt-text">同步删除聊天记录</span>
                            <span class="nt-code">L_02</span>
                        </label>
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
                                <button id="nt-ws-ensure-tracker" class="nt-btn-text" style="color: #00ffcc;">[确保当前角色追踪书]</button>
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
                            <label class="nt-grid-item"><input type="checkbox" id="nt-ws-quests" class="nt-hidden-cb" ${s.enableQuests ? 'checked' : ''}><span class="nt-box"></span><span class="nt-text">主线支线</span><span class="nt-code">T_10</span></label>
                            <label class="nt-grid-item"><input type="checkbox" id="nt-ws-cognition" class="nt-hidden-cb" ${s.enableCognition ? 'checked' : ''}><span class="nt-box"></span><span class="nt-text">认知隔离</span><span class="nt-code">T_11</span></label>
                            <label class="nt-grid-item"><input type="checkbox" id="nt-ws-presence" class="nt-hidden-cb" ${s.enablePresence ? 'checked' : ''}><span class="nt-box"></span><span class="nt-text">日程在场</span><span class="nt-code">T_12</span></label>
                        </div>
                    </div>

                    <div class="nt-section">
                        <div class="nt-sec-head">
                            <span class="nt-index">02</span>
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
                        <div class="nt-data-row" style="gap:8px; flex-wrap:wrap;">
                            <span class="nt-hint">楼层范围</span>
                            <input type="number" id="nt-tm-fav-from" class="nt-data-input" style="width:80px; text-align:left;" placeholder="起" min="1">
                            <span class="nt-hint">~</span>
                            <input type="number" id="nt-tm-fav-to" class="nt-data-input" style="width:80px; text-align:left;" placeholder="止" min="1">
                            <button id="nt-tm-fav-on" class="nt-btn-text" style="color:#ffcc00;">[批量收藏]</button>
                            <button id="nt-tm-fav-off" class="nt-btn-text" style="color:#ff4d4d;">[批量取消]</button>
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
                            <label class="nt-grid-item">
                                <input type="checkbox" id="nt-tm-exp-skip-sys" class="nt-hidden-cb" ${tm.exportSkipSystem !== false ? 'checked' : ''}>
                                <span class="nt-box"></span>
                                <span class="nt-text">跳过系统消息</span>
                                <span class="nt-code">E_03</span>
                            </label>
                        </div>
                        <div class="nt-data-row" style="gap:8px; flex-wrap:wrap; margin-bottom:8px;">
                            <span class="nt-hint">导出范围</span>
                            <input type="number" id="nt-tm-exp-from" class="nt-data-input" style="width:80px; text-align:left;" placeholder="起(可空)" min="1">
                            <span class="nt-hint">~</span>
                            <input type="number" id="nt-tm-exp-to" class="nt-data-input" style="width:80px; text-align:left;" placeholder="止(可空)" min="1">
                            <span class="nt-hint">留空=全部</span>
                        </div>
                        <div class="nt-data-row" style="justify-content:flex-start; gap:12px;">
                            <button id="nt-tm-export-txt" class="nt-btn-action primary">[一键导出纯剧情 TXT]</button>
                            <button id="nt-tm-export-fav" class="nt-btn-action danger">[仅导出收藏楼层 TXT]</button>
                        </div>
                    </div>

                    <div class="nt-section">
                        <div class="nt-sec-head">
                            <span class="nt-index">03</span>
                            <span class="nt-title">八股管理器</span>
                            <div class="nt-sec-line"></div>
                        </div>
                        <div class="nt-grid-layout" style="margin-bottom:10px;">
                            <label class="nt-grid-item">
                                <input type="checkbox" id="nt-tm-hide-slop" class="nt-hidden-cb" ${tm.hideSlopVisual !== false ? 'checked' : ''}>
                                <span class="nt-box"></span>
                                <span class="nt-text">自动视觉隐藏八股</span>
                                <span class="nt-code">C_01</span>
                            </label>
                            <div class="nt-data-row" style="margin:0; padding:0 6px; gap:6px;">
                                <span class="nt-hint">真正删除范围</span>
                                <input type="number" id="nt-tm-clean-from" class="nt-data-input" style="width:70px; text-align:left;" placeholder="起" min="1">
                                <span class="nt-hint">~</span>
                                <input type="number" id="nt-tm-clean-to" class="nt-data-input" style="width:70px; text-align:left;" placeholder="止" min="1">
                                <span class="nt-hint">空=全部</span>
                            </div>
                        </div>
                        <div class="nt-slop-add">
                            <select id="nt-slop-type" class="nt-data-select" style="width:104px;">
                                <option value="sentence">删整句</option>
                                <option value="word">删这个词</option>
                                <option value="paragraph">删整段</option>
                                <option value="regex">正则</option>
                                <option value="replace">替换</option>
                            </select>
                            <input id="nt-slop-a" class="nt-data-input" style="flex:1; width:auto;" placeholder="输入几个字，例如：空气凝固">
                            <input id="nt-slop-b" class="nt-data-input" style="flex:1; width:auto; display:none;" placeholder="替换为">
                            <button id="nt-slop-add" class="nt-btn-text">[添加]</button>
                        </div>
                        <div class="nt-hint" style="margin:4px 0 6px;">输入几个字即可：默认删掉<b>包含这些字的整句</b>；也可以选删词/删段/正则/替换。点左侧圆点停用，× 删除。</div>
                        <div class="nt-hint" style="margin:4px 0 6px;">快捷语法：字面=直接删；正则选 <code>/…/</code>、常见规则可从下拉直接选；替换填 A、B 两个框；点左侧圆点可停用</div>
                        <div id="nt-slop-list" class="nt-slop-list"></div>
                        <details class="nt-slop-raw">
                            <summary class="nt-summary">高级：直接编辑原始词库</summary>
                            <div class="nt-sec-body">
                                <div class="nt-data-row" style="justify-content:flex-end; padding-bottom:4px;">
                                    <button id="nt-tm-reset-rules" class="nt-btn-text">[恢复默认词库]</button>
                                </div>
                                <textarea id="nt-tm-slop-rules" class="nt-prompt-textarea" style="min-height:90px;">${escapeHtml(tm.slopRulesText || '')}</textarea>
                            </div>
                        </details>
                        <div class="nt-data-row" style="justify-content:flex-start; gap:12px;">
                            <button id="nt-tm-run-clean" class="nt-btn-action primary">[应用规则并清除]</button>
                            <button id="nt-tm-undo-clean" class="nt-btn-text" style="color:#ffcc00;">[撤销上次清理]</button>
                        </div>
                    </div>
                </div>

                <div class="nt-tab-pane" id="nt-pane-settings">
                    <div class="nt-section">
                        <div class="nt-sec-head">
                            <span class="nt-index">01</span>
                            <span class="nt-title">数据与诊断</span>
                            <div class="nt-sec-line"></div>
                        </div>
                        <div class="nt-data-row" style="gap:10px; flex-wrap:wrap;">
                            <button id="nt-ws-import" class="nt-btn-action">[导入]</button>
                            <button id="nt-ws-export" class="nt-btn-action">[导出]</button>
                            <button id="nt-ws-reset" class="nt-btn-action">[重置]</button>
                        </div>
                        <div class="nt-data-row">
                            <span class="nt-data-label">本轮注入预览 <span class="nt-hint">/ 看看到底发了什么</span></span>
                            <button id="nt-diag-preview" class="nt-btn-action">[生成预览]</button>
                        </div>
                        <pre id="nt-diag-out" class="nt-diag-out">点「生成预览」查看当前追踪书条目与注入契约。</pre>
                    </div>
                </div>

                <div class="nt-footer">
                    <button id="nt-ws-save" class="nt-btn-action primary">[应用]</button>
                </div>
            </div>
        </div>
    `;

    container.appendChild(wrap);

    // ---------- 区块折叠：每个 nt-section 变成可折叠面板 ----------
    {
        const openCount = new Map();
        wrap.querySelectorAll('.nt-section').forEach(sec => {
            if (sec.closest('details.nt-section')) return;
            const head = sec.querySelector(':scope > .nt-sec-head');
            if (!head) return;

            const pane = sec.closest('.nt-tab-pane');
            const paneId = pane ? pane.id : 'default';
            const opened = openCount.get(paneId) || 0;

            const det = document.createElement('details');
            det.className = 'nt-section nt-collapsible';
            const idx = head.querySelector('.nt-index')?.textContent?.trim() || '';
            if (idx) det.dataset.idx = idx;
            det.open = opened === 0;
            openCount.set(paneId, opened + 1);

            const sum = document.createElement('summary');
            sum.className = 'nt-summary';
            sum.appendChild(head);

            const body = document.createElement('div');
            body.className = 'nt-sec-body';
            while (sec.firstChild) body.appendChild(sec.firstChild);

            det.appendChild(sum);
            det.appendChild(body);
            sec.replaceWith(det);
        });
    }

    // 快捷跳转
    wrap.querySelectorAll('[data-goto]').forEach(btn => {
        btn.onclick = () => {
            const target = btn.dataset.goto;
            wrap.querySelectorAll('.nt-tab').forEach(t => t.classList.toggle('active', t.dataset.target === target));
            wrap.querySelectorAll('.nt-tab-pane').forEach(p => p.classList.toggle('active', p.id === target));
        };
    });

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

    wrap.querySelector('#nt-lore-sync-delete').onchange = (e) => {
        stBridge.saveLoreManagerConfig({ syncCharLifecycle: e.target.checked });
        if (window.toastr) toastr.info(e.target.checked ? '已开启：角色卡与世界书同步删除' : '已关闭：删除只解绑，不连坐');
    };

    wrap.querySelector('#nt-lore-del-chats').onchange = (e) => {
        stBridge.saveLoreManagerConfig({ deleteChatsWithChar: e.target.checked });
        if (window.toastr) toastr.info(e.target.checked ? '连坐删卡时会同时删除聊天记录' : '连坐删卡时保留聊天记录');
    };

    async function renderLoreList() {
        listEl.innerHTML = '<div style="color:#888; font-size:11px; padding:6px;">正在同步世界书列表...</div>';
        // 每次都让 ST 重扫磁盘，否则新建的书不会出现在列表里
        await stBridge.fetchWorldNamesFromApi();
        const allNames = stBridge.getWorldNames();

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

    wrap.querySelector('#nt-ws-visual-restore').onclick = () => {
        stBridge.showAllHiddenMessages();
        if (window.toastr) toastr.success('已恢复视觉显示（数据层隐藏未改变）');
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
        // 默认名必须和存档位规则一致；不能手拼，否则会和第 1 档同名
        const defaultName = stBridge.trackerBaseName() || '【NEKOTOOL新建世界书】';
        const targetName = prompt('请输入新世界书名称：', defaultName);
        if (!targetName) return;

        const name = targetName.trim();
        if (await stBridge.bookExists(name)) {
            if (window.toastr) toastr.warning('同名世界书已存在，换个名字');
            return;
        }
        const success = await stBridge.createWorldbook(name);
        if (success) {
            await stBridge.mountGlobalWorldbook(name, true);
            await renderLoreList();
            if (window.toastr) toastr.success('已创建并激活到全局世界书');
        } else if (window.toastr) {
            toastr.error('创建失败');
        }
    };

    wrap.querySelector('#nt-ws-ensure-tracker').onclick = async () => {
        const name = stBridge.trackerBookName();
        if (!name) {
            if (window.toastr) toastr.warning('请先选择一个角色卡');
            return;
        }
        const book = await stBridge.ensureWorldbook(name);
        await renderLoreList();
        if (window.toastr) {
            if (book) toastr.success(`追踪书已就绪：${name}`);
            else toastr.error('创建失败，按 F12 看 [nekotools] 日志');
        }
    };

    wrap.querySelector('#nt-ws-del-book').onclick = async () => {
        const selected = Array.from(listEl.querySelectorAll('.nt-book-select:checked')).map(cb => cb.dataset.name);
        if (!selected.length) {
            if (window.toastr) toastr.warning('请先勾选要删除的世界书');
            return;
        }
        if (!confirm(`确定要彻底删除选中的 ${selected.length} 本世界书吗？此操作不可恢复！`)) return;

        // 书 → 角色卡：删书时询问是否连绑定角色一起删（追踪书不参与）
        const ctx = stBridge.getContext();
        const boundChars = (Array.isArray(ctx.characters) ? ctx.characters : []).filter(
            c => selected.includes(c?.data?.extensions?.world) && !stBridge.isTrackerBook(c?.data?.extensions?.world)
        );
        let deleteLinkedChar = false;
        if (stBridge.getLoreManagerConfig().syncCharLifecycle && boundChars.length) {
            const withChats = stBridge.getLoreManagerConfig().deleteChatsWithChar;
            deleteLinkedChar = confirm(
                `检测到 ${boundChars.length} 张角色卡绑定了所选世界书。\n\n` +
                `点【确定】：连同角色卡一起删除${withChats ? '（含聊天记录）' : '（保留聊天记录）'}\n` +
                `点【取消】：只删世界书并解绑角色卡`
            );
        }

        for (const name of selected) {
            await stBridge.deleteWorldbook(name, { syncUnbindChar: true, deleteLinkedChar });
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

    // 楼层范围输入：界面 1 基，内部 0 基
    function readRange(fromSel, toSel) {
        const f = parseInt(wrap.querySelector(fromSel).value, 10);
        const t = parseInt(wrap.querySelector(toSel).value, 10);
        const from = Number.isFinite(f) ? Math.max(0, f - 1) : 0;
        const to = Number.isFinite(t) ? Math.max(0, t - 1) : null;
        return { from, to };
    }

    wrap.querySelector('#nt-tm-fav-on').onclick = () => {
        const { from, to } = readRange('#nt-tm-fav-from', '#nt-tm-fav-to');
        const n = setFavoriteRange(from, to, true);
        renderFavoriteList();
        if (window.toastr) toastr.success(`已收藏 ${n} 个楼层`);
    };

    wrap.querySelector('#nt-tm-fav-off').onclick = () => {
        const { from, to } = readRange('#nt-tm-fav-from', '#nt-tm-fav-to');
        const n = setFavoriteRange(from, to, false);
        renderFavoriteList();
        if (window.toastr) toastr.success(`已取消收藏 ${n} 个楼层`);
    };

    function syncTextManagerInputs() {
        if (!tmMod) return;
        tmMod.settings.exportIncludeNames = wrap.querySelector('#nt-tm-exp-names').checked;
        tmMod.settings.exportSkipHidden = wrap.querySelector('#nt-tm-exp-skip-hide').checked;
        tmMod.settings.exportSkipSystem = wrap.querySelector('#nt-tm-exp-skip-sys').checked;
        tmMod.settings.hideSlopVisual = wrap.querySelector('#nt-tm-hide-slop').checked;
        tmMod.settings.slopRulesText = wrap.querySelector('#nt-tm-slop-rules').value;
        tmMod.saveSettings();
    }

    wrap.querySelector('#nt-tm-export-txt').onclick = () => {
        syncTextManagerInputs();
        const { from, to } = readRange('#nt-tm-exp-from', '#nt-tm-exp-to');
        exportPureStoryTxt({ favoritesOnly: false, from, to });
    };

    wrap.querySelector('#nt-tm-export-fav').onclick = () => {
        syncTextManagerInputs();
        const { from, to } = readRange('#nt-tm-exp-from', '#nt-tm-exp-to');
        exportPureStoryTxt({ favoritesOnly: true, from, to });
    };

    // ---------- 八股词库：可视化管理 ----------
    const slopListEl = wrap.querySelector('#nt-slop-list');
    const slopTextEl = wrap.querySelector('#nt-tm-slop-rules');

    function getSlopLines() {
        return (slopTextEl.value || '').split('\n');
    }

    function setSlopLines(lines) {
        slopTextEl.value = lines.join('\n');
        syncTextManagerInputs();
        renderSlopList();
    }

    function slopTypeOf(line) {
        const t = line.trim();
        if (!t) return 'empty';
        if (t.startsWith('#')) return 'off';
        if (/^@句\s/.test(t)) return 'sentence';
        if (/^@段\s/.test(t)) return 'paragraph';
        if (/^@词\s/.test(t)) return 'word';
        if (/^\/.+\/[gimuy]*$/.test(t)) return 'regex';
        if (t.includes('=>')) return 'replace';
        return 'literal';
    }

    function renderSlopList() {
        if (!slopListEl) return;
        const rows = [];
        getSlopLines().forEach((line, i) => {
            const t = line.trim();
            if (!t) return;
            const type = slopTypeOf(t);
            const label = {
                sentence: '整句', paragraph: '整段', word: '词',
                literal: '词', regex: '正则', replace: '替换', off: '停用'
            }[type] || '词';
            const shown = t.replace(/^#\s*/, '').replace(/^@(词|句|段)\s+/, '');
            rows.push(`
                <div class="nt-slop-row ${type === 'off' ? 'is-off' : ''}">
                    <button class="nt-slop-toggle" data-i="${i}" title="启用/停用">${type === 'off' ? '○' : '●'}</button>
                    <span class="nt-slop-type">${label}</span>
                    <span class="nt-slop-text" title="${escapeHtml(shown)}">${escapeHtml(shown)}</span>
                    <button class="nt-slop-del" data-i="${i}" title="删除">×</button>
                </div>`);
        });
        slopListEl.innerHTML = rows.length
            ? rows.join('')
            : '<div class="nt-hint" style="padding:6px;">词库为空</div>';

        slopListEl.querySelectorAll('.nt-slop-del').forEach(btn => {
            btn.onclick = () => {
                const lines = getSlopLines();
                lines.splice(Number(btn.dataset.i), 1);
                setSlopLines(lines);
            };
        });
        slopListEl.querySelectorAll('.nt-slop-toggle').forEach(btn => {
            btn.onclick = () => {
                const lines = getSlopLines();
                const i = Number(btn.dataset.i);
                const raw = lines[i] || '';
                lines[i] = raw.trim().startsWith('#')
                    ? raw.replace(/^(\s*)#\s*/, '$1')
                    : '# ' + raw;
                setSlopLines(lines);
            };
        });
    }

    renderSlopList();
    slopTextEl.addEventListener('input', () => {
        syncTextManagerInputs();
        renderSlopList();
    });

    const slopTypeSel = wrap.querySelector('#nt-slop-type');
    const slopA = wrap.querySelector('#nt-slop-a');
    const slopB = wrap.querySelector('#nt-slop-b');
    const slopAddBtn = wrap.querySelector('#nt-slop-add');

    if (slopTypeSel) {
        slopTypeSel.onchange = () => {
            slopB.style.display = slopTypeSel.value === 'replace' ? '' : 'none';
            if (slopTypeSel.value === 'replace') slopB.focus();
        };
    }

    if (slopAddBtn) {
        slopAddBtn.onclick = () => {
            const type = slopTypeSel.value;
            const a = slopA.value.trim();
            const b = slopB.value.trim();
            if (!a) return;

            let val;
            if (type === 'replace') {
                if (!b) {
                    if (window.toastr) toastr.warning('替换模式需要填写右侧「替换为」');
                    return;
                }
                val = `${a}=>${b}`;
            } else if (type === 'regex') {
                let src = a;
                if (!/^\/.+\/[gimuy]*$/.test(src)) {
                    src = '/' + src.replace(/^\//, '').replace(/\/$/, '') + '/gm';
                }
                const m = src.match(/^\/(.+)\/([gimuy]*)$/);
                try {
                    new RegExp(m[1], m[2]);
                } catch (e) {
                    if (window.toastr) toastr.error('正则语法无效');
                    return;
                }
                val = src;
            } else if (type === 'sentence') {
                val = `@句 ${a}`;
            } else if (type === 'paragraph') {
                val = `@段 ${a}`;
            } else {
                val = `@词 ${a}`;
            }

            const lines = getSlopLines().filter(l => l.trim() !== '');
            if (lines.some(l => l.trim() === val)) {
                if (window.toastr) toastr.info('这条规则已经存在');
                return;
            }
            lines.push(val);
            setSlopLines(lines);
            slopA.value = '';
            slopB.value = '';
            if (window.toastr) toastr.success('已添加规则');
        };
    }

    wrap.querySelector('#nt-tm-reset-rules').onclick = () => {
        if (!tmMod || !confirm('确定恢复默认八股词库吗？')) return;
        const defText = tmMod.DEFAULT_SLOP_RULES.join('\n');
        wrap.querySelector('#nt-tm-slop-rules').value = defText;
        syncTextManagerInputs();
        renderSlopList();
        if (window.toastr) toastr.info('已恢复默认八股词库');
    };

    wrap.querySelector('#nt-tm-run-clean').onclick = async () => {
        syncTextManagerInputs();
        const { from, to } = readRange('#nt-tm-clean-from', '#nt-tm-clean-to');
        const { msgChanged, totalHits } = await cleanChatSlop({ from, to, includeUser: false });
        if (window.toastr) {
            if (totalHits > 0) toastr.success(`已真正删除：${msgChanged} 个楼层，${totalHits} 处八股（可撤销）`);
            else toastr.info('扫描完毕：未发现匹配的八股词汇');
        }
    };

    wrap.querySelector('#nt-tm-hide-slop').onchange = (e) => {
        syncTextManagerInputs();
        if (e.target.checked) {
            const hits = applySlopVisualAll();
            if (window.toastr) toastr.success(`已开启视觉隐藏（本次隐藏 ${hits} 处）`);
        } else {
            restoreSlopVisual();
            if (window.toastr) toastr.info('已关闭视觉隐藏，正文恢复显示');
        }
    };

    wrap.querySelector('#nt-tm-undo-clean').onclick = () => {
        const n = undoLastClean();
        if (window.toastr) {
            if (n > 0) toastr.success(`已撤销 ${n} 个楼层的清理`);
            else toastr.info('没有可撤销的清理（只保留最近一次）');
        }
    };

    wrap.querySelector('#nt-ws-quickmenu')?.addEventListener('change', (e) => {
        const enabled = Boolean(e.target.checked);
        try { settings.set('worldsim', { enableQuickMenu: enabled }); } catch (_) {}
        try {
            window.dispatchEvent(new CustomEvent('nekotool:quickmenu-toggle', { detail: { enabled } }));
        } catch (_) {}
    });

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
        s.enableQuests = wrap.querySelector('#nt-ws-quests').checked;
        s.enableCognition = wrap.querySelector('#nt-ws-cognition').checked;
        s.enablePresence = wrap.querySelector('#nt-ws-presence').checked;
        s.enableForeshadow = wrap.querySelector('#nt-ws-foreshadow').checked;
        s.enableSummary = wrap.querySelector('#nt-ws-summary').checked;
        s.enableBigSummary = wrap.querySelector('#nt-ws-bigsummary').checked;
        s.hideKeepCount = parseInt(wrap.querySelector('#nt-ws-keep').value) || 0;
        s.visualHideKeep = parseInt(wrap.querySelector('#nt-ws-visual-keep').value) || 0;
        s.bigSummaryLimit = parseInt(wrap.querySelector('#nt-ws-biglimit').value) || 100;
        s.recordUserCharacter = wrap.querySelector('#nt-ws-record-user').checked;
        s.enableTicks = wrap.querySelector('#nt-ws-tick-enable').checked;
        s.enableQuickMenu = wrap.querySelector('#nt-ws-quickmenu').checked;
        s.charTickEvery = parseInt(wrap.querySelector('#nt-ws-char-tick').value) || 0;
        s.worldTickEvery = parseInt(wrap.querySelector('#nt-ws-world-tick').value) || 0;
        s.tickMaxChars = parseInt(wrap.querySelector('#nt-ws-tick-max').value) || 2;
        s.staleAfter = parseInt(wrap.querySelector('#nt-ws-stale-after').value) || 0;
        s.enableAntiLazy = wrap.querySelector('#nt-ws-antilazy').checked;

        wrap.querySelectorAll('.nt-prompt-textarea[data-prompt-key]').forEach(ta => {
            const key = ta.dataset.promptKey;
            if (key) s.customPrompts[key] = ta.value;
        });

        mod.saveSettings();
        try {
            window.dispatchEvent(new CustomEvent('nekotool:quickmenu-toggle', { detail: { enabled: s.enableQuickMenu } }));
        } catch (_) {}
        syncTextManagerInputs();
        // 词库可能变了：先还原旧的隐藏，再按新规则重新套一遍
        restoreSlopVisual();
        applySlopVisualAll();
        if (window.toastr) toastr.success('数据已同步');
    };

    setTimeout(() => {
        renderLoreList();
        renderFavoriteList();
    }, 500);

    const diagBtn = wrap.querySelector('#nt-diag-preview');
    if (diagBtn) {
        diagBtn.onclick = async () => {
            const out = wrap.querySelector('#nt-diag-out');
            const ws = registry.get('worldsim');
            if (!ws || typeof ws.getInjectionPreview !== 'function') {
                out.textContent = 'worldsim 未注册';
                return;
            }
            out.textContent = '生成中…';
            try {
                out.textContent = (await ws.getInjectionPreview()) || '(空)';
            } catch (e) {
                out.textContent = '生成失败：' + (e && e.message ? e.message : e);
            }
        };
    }

    wrap.querySelector('#nt-ws-reset').onclick = async () => {
        if (!confirm('确定清除本会话的剧情推演记录吗？（世界书里的「剧情推演」条目会被删除）')) return;
        const name = stBridge.trackerBookName();
        if (name) await stBridge.removeEntryByComment(name, '剧情推演');
        localStorage.removeItem('nt_preview_cache');
        if (window.toastr) toastr.info('剧情推演记录已清除');
    };

    wrap.querySelector('#nt-ws-export').onclick = () => {
        wrap.querySelector('#nt-ws-save').click();
        const extra = {};
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