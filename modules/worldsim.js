import { registry } from '../core/registry.js';
import { stBridge } from '../core/st_bridge.js';
import { settings as coreSettings } from '../core/settings.js';

const defaultSettings = {
    enabled: true,
    enableStatus: true,
    enablePreview: true,
    enableChars: true,
    enableItems: true,
    enablePlot: true,
    enableWorld: true,
    enableForeshadow: true,
    enableSummary: true,
    enableBigSummary: true,
    lorebookName: '',
    bigSummaryLimit: 100,
    hideKeepCount: 2,
    focusChars: '',
    customPrompts: {
        status: '', preview: '', chars: '', items: '', plot: '',
        world: '', foreshadow: '', summary: '', bigSummary: '',
    }
};

const settings = { ...defaultSettings, customPrompts: { ...defaultSettings.customPrompts } };

function loadSettings() {
    const saved = coreSettings.get('worldsim');
    if (saved && typeof saved === 'object') {
        const custom = { ...defaultSettings.customPrompts, ...(saved.customPrompts || {}) };
        Object.assign(settings, defaultSettings, saved, { customPrompts: custom });
    }
}

function saveSettings() {
    coreSettings.set('worldsim', settings);
}

function getLorebookName() {
    if (settings.lorebookName) return settings.lorebookName;
    const charName = stBridge.getCharacterName();
    return charName ? `【NEKOTOOL世界加载器·${charName}】` : '【NEKOTOOL世界加载器·默认】';
}

function fetchConstantLore(recentText = '') {
    const cfg = stBridge.getLoreManagerConfig();
    if (!cfg.independentInject) return '';

    const matched = stBridge.collectMatchedLoreEntries(recentText);
    if (!matched.length) return '';

    let text = '';
    for (const entry of matched) {
        if (entry.comment !== '小总结' && entry.comment !== '大总结') {
            text += `[${entry.comment}]: ${entry.content}\n`;
        }
    }
    return text;
}

const DIRECTOR_PROMPT = `<nekotools:director>
【NEKOTOOL 世界模拟器核心指令】
你是普赛克使用的世界模拟器工具NEKOTOOL，请结合【认知隔离】，严格执行以下任务：
1. 世界合理化：用户输入先判定成功率与后果，让世界始终保持真实且符合基本逻辑与规律运转。
2. 长线维护：以维持几千层游玩不无聊为目标，必须时刻运行主线与支线，前期埋下的伏笔或计划在未来适时引爆。
3. 认知隔离：严禁上帝视角。角色只能基于当前五感、已有记忆和信息差行动。暗中计划绝不突然告诉用户。
4. 输出格式：严格遵守下方系统标签的契约。所有标签必须放在正文末尾，标签内部仅供系统后台记录，不要用代码块包裹，绝对不要在正文中向用户解释这些标签。
</nekotools:director>`;

function buildStatusPrompt() {
    const tagOpen = '<ws_' + 'status>';
    const tagClose = '</ws_' + 'status>';
    let p = `<nekotools:status>\n【状态栏终端】必须在本轮正文末尾输出：\n${tagOpen}时间: XXXX年XX月XX日 | 地点: XXX | 天气: XXX | 温度: XX℃${tagClose}\n（前端会自动渲染，不要用代码块包裹，字段用 " | " 分隔）\n</nekotools:status>`;
    const custom = (settings.customPrompts.status || '').trim();
    if (custom) p += `\n【附加要求】\n${custom}`;
    return p;
}

function buildPreviewPrompt() {
    const tagOpen = '<ws_' + 'preview>';
    let p = `<nekotools:preview>
【剧情推演 · 仅供后台参考 · 绝对禁止向用户直接展示或罗列选项】
你必须在 ${tagOpen} 标签内完成以下推演，为下一轮生成提供指导：
## 1. 行为推演
评估：结合世界观与当前阻力，用户的行动成功率大约是 XX%。
三种走向（按概率排序）：
- 走向1（XX%）：[描述可能导致的后果，不一定是用户想要的]
- 走向2（XX%）：[描述突发事件或部分成功]
- 走向3（XX%）：[描述完全的成功]
## 2. 长线剧情规划（必须包含可探索的线索）
主线推进：[当前世界主线/核心任务，本轮该如何运转]
支线触发：[提供 1-2 个背后的暗线、可探索的区域或即将发生的随机事件]
铺垫追踪：[若有突发事件，指明其前置铺垫线索是什么，但决不让突发事件一直出现打断现有正在做的事，只有在剧情偏向无聊时优先考虑]
倾向量表：【喜剧%+悲剧%+正剧%+幽默%+严肃%+欢快%+宏大%】
</nekotools:preview>`;

    const custom = (settings.customPrompts.preview || '').trim();
    if (custom) p += `\n【附加要求】\n${custom}`;

    const cache = localStorage.getItem('nt_preview_cache');
    if (cache) {
        p += `\n【上一轮沙盘推演记录】\n${cache}\n（必须参考上一轮的推演结果，保持剧情连贯和长线逻辑，不要吃书或者过于跳跃。）`;
    }
    return p;
}

function buildTrackingMessages() {
    const list = [];
    const anyEnabled = settings.enableChars || settings.enableItems || settings.enablePlot
        || settings.enableWorld || settings.enableForeshadow;
    if (!anyEnabled) return list;

    const tagOpen = '<ws_' + 'update>';
    list.push({
        role: 'system',
        content: `<nekotools:update>
【状态数据流契约】必须在本轮回复末尾输出 ${tagOpen} 标签，内含合法 JSON（不要代码块包裹，前后不加任何其它字符）。
JSON 仅包含下方已启用的字段键名，请根据剧情进展综合判断更新，若是首次出场则新建，若状态未变可省略。
</nekotools:update>`
    });

    if (settings.enableChars) {
        let c = `<nekotools:track.chars>
【角色追踪】JSON 字段 "chars": {"角色名": "多行文本"}
要求：记录活跃 NPC（严禁记录 user）。请结合角色的主观能动性，综合以下维度进行状态快照：
- 状态：[动作/衣着/生理状态/本次更新的剧情时间戳]
- 后台运行：[若刚出场或时间跳跃：以A→B→C的动作链条记录]
- 长期目标：[概括最重要的长期追求] / 近期打算：[短期内最可能采取的下一个具体行动]
- 关键记忆：[格式：【事件】→导致了什么转变。每次最多添加 1-2 个最关键的新记忆]
- 特殊变化：[角色→角色生理状态变动|人生目标变化|持有道具物品|所有人际关系变化|个人理念变动|身份地位变化]
`;
        const focus = (settings.focusChars || '').trim();
        if (focus) {
            c += `\n【重要限制】：你只能追踪并更新以下指定的角色，绝对不要输出名单外角色的 JSON：\n${focus}\n`;
        }
        const custom = (settings.customPrompts.chars || '').trim();
        if (custom) c += `【附加要求】\n${custom}\n`;
        c += `</nekotools:track.chars>`;
        list.push({ role: 'system', content: c });
    }

    if (settings.enableItems) {
        let c = `<nekotools:track.items>
【道具追踪】JSON 字段 "items": {"道具名": "描述"}
要求：追踪剧情关键道具、剩余金钱、随身重要物品、礼物等。格式：[当前持有者 | 作用 | 来源]。重点标注那些未来剧情可能召回的道具，失去后删除。
`;
        const custom = (settings.customPrompts.items || '').trim();
        if (custom) c += `【附加要求】\n${custom}\n`;
        c += `</nekotools:track.items>`;
        list.push({ role: 'system', content: c });
    }

    if (settings.enablePlot) {
        let c = `<nekotools:track.plot>
【计划追踪】JSON 字段 "plot": {"计划名": "描述"}
要求：记录 NPC 或势力的暗计划。格式：[执行者 | 目标 | 进度 | 状态(暗中进行/已暴露)]。
重要：此条目与角色后台动向联动。暗中进行的计划必须严守认知隔离，绝不能提前在正文中让用户或无关角色得知
`;
        const custom = (settings.customPrompts.plot || '').trim();
        if (custom) c += `【附加要求】\n${custom}\n`;
        c += `</nekotools:track.plot>`;
        list.push({ role: 'system', content: c });
    }

    if (settings.enableWorld) {
        let c = `<nekotools:track.world>
【世界局势】JSON 字段 "world": {"局势": "描述"}
要求：宏观层面的变动（国家、势力、政治经济文化），社会的舆论、争端、风向，某个大人物的重要动向等。可能发生或酝酿世界级事件，模拟真实世界运转，不要围着主角转。
`;
        const custom = (settings.customPrompts.world || '').trim();
        if (custom) c += `【附加要求】\n${custom}\n`;
        c += `</nekotools:track.world>`;
        list.push({ role: 'system', content: c });
    }

    if (settings.enableForeshadow) {
        let c = `<nekotools:track.foreshadow>
【草蛇伏笔】JSON 字段 "foreshadow": {"伏笔名": "描述"}
要求：记录未来可能有用的情报、暗线、物件线索。与计划追踪严格分开。
格式：[线索内容 | 指向/可能的作用]。已触发的伏笔进行删除。
`;
        const custom = (settings.customPrompts.foreshadow || '').trim();
        if (custom) c += `【附加要求】\n${custom}\n`;
        c += `</nekotools:track.foreshadow>`;
        list.push({ role: 'system', content: c });
    }

    return list;
}

function buildSummaryPrompt() {
    const tagOpen = '<ws_' + 'summary>';
    let p = `<nekotools:summary>
【格式契约】必须在末尾输出 ${tagOpen} 标签，100字内对本轮剧情进行简洁概括，完整保留角色行为、发展与对话，包括详细日期时间，记录如学习到的经验/领悟/技巧/教训，或者是约定/承诺/性格转变/道具/礼物等等重要内容，确保记录具体且清晰的实际内容，严禁概括为模糊形容词
</nekotools:summary>`;
    const custom = (settings.customPrompts.summary || '').trim();
    if (custom) p += `\n【附加要求】\n${custom}`;
    return p;
}

function buildBigSummaryPrompt() {
    const tagOpen = '<ws_' + 'big_summary>';
    let p = `<nekotools:bigsummary>
【格式契约 · 仅本轮触发】必须输出 ${tagOpen} 标签。停止所有角色扮演，作为总结助手对本局游戏至此的剧情进行【大总结】。保持中性客观，总体2000token上下对已发生时间进行总结，以自然语言交代清楚发生了什么，且事件时间顺序必须与前文一致，保持时间线清晰度。相近时间事件整合为同一时间跨度，并使用【】对时间跨度进行标记，保留关键事件、人物关系变化、重要伏笔。
</nekotools:bigsummary>`;
    const custom = (settings.customPrompts.bigSummary || '').trim();
    if (custom) p += `\n【附加要求】\n${custom}`;
    return p;
}

function buildSystemMessages(needBig, recentText = '') {
    const list = [{ role: 'system', content: DIRECTOR_PROMPT }];

    if (settings.enableStatus) list.push({ role: 'system', content: buildStatusPrompt() });
    if (settings.enablePreview) list.push({ role: 'system', content: buildPreviewPrompt() });
    list.push(...buildTrackingMessages());
    if (settings.enableSummary) list.push({ role: 'system', content: buildSummaryPrompt() });
    if (needBig) list.push({ role: 'system', content: buildBigSummaryPrompt() });

    const loreText = fetchConstantLore(recentText);
    if (loreText) {
        list.push({
            role: 'system',
            content: `<nekotools:lore>\n【当前激活的世界书设定】\n${loreText}\n</nekotools:lore>`
        });
    }

    return list;
}

registry.register({
    id: 'worldsim',
    name: '世界模拟',
    enabled: true,
    order: 50,
    tags: ['ws_update', 'ws_preview', 'ws_status', 'ws_summary', 'ws_big_summary'],
    settings,
    saveSettings,
    loadSettings,

    init() {
        loadSettings();
        setTimeout(() => { stBridge.preloadActivatedLorebooks(); }, 800);
    },

    onRequest(ctx) {
        loadSettings();
        if (!settings.enabled) return;

        const recentText = (ctx.messages || [])
            .slice(-6)
            .map(m => (typeof m.content === 'string' ? m.content : ''))
            .join('\n');

        const turnCount = parseInt(localStorage.getItem('nt_worldsim_turn') || '0') + 1;
        localStorage.setItem('nt_worldsim_turn', turnCount.toString());

        let needBig = false;
        if (settings.enableBigSummary && turnCount > 0 && turnCount % settings.bigSummaryLimit === 0) {
            needBig = true;
        }
        ctx.__ntNeedBig = needBig;

        for (const msg of buildSystemMessages(needBig, recentText)) {
            ctx.__nt_pendingSystems.push(msg);
        }
    },

    async onResponse({ captured }) {
        loadSettings();
        if (!settings.enabled) return;

        const currentLorebook = getLorebookName();
        if (!currentLorebook) return;

        // 异步安全读取（若缓存没有则自动从后端拉取，绝不丢失第一轮记录）
        let book = await stBridge.loadWorldInfoAsync(currentLorebook);
        if (!book) {
            console.warn('[nekotools] 追踪世界书尚未创建，跳过写入:', currentLorebook);
            return;
        }

        if (captured.ws_big_summary && settings.enableBigSummary) {
            await stBridge.updateEntry(currentLorebook, '大总结', captured.ws_big_summary.trim(), true, [], {
                position: 4, depth: 9999, order: 9999, role: 2, insertion_order: 9999
            });
            book = await stBridge.loadWorldInfoAsync(currentLorebook);
            for (const entry of Object.values(book.entries)) {
                if (entry.comment === '小总结') entry.content = '（已浓缩入大总结）';
            }
            await stBridge.persistLorebook(currentLorebook, book);
            localStorage.removeItem('nt_worldsim_turn');
        }

        if (captured.ws_summary && settings.enableSummary && !captured.ws_big_summary) {
            book = await stBridge.loadWorldInfoAsync(currentLorebook);
            let currentSum = '';
            const entry = Object.values(book.entries).find(e => e.comment === '小总结');
            if (entry && entry.content !== '（已浓缩入大总结）') currentSum = entry.content + '\n';
            await stBridge.updateEntry(currentLorebook, '小总结', currentSum + captured.ws_summary.trim(), true, [], {
                position: 4, depth: 999, order: 999, role: 2, insertion_order: 999
            });
        }

        if (captured.ws_preview && settings.enablePreview) {
            let cache = captured.ws_preview.trim();
            if (cache.length > 50000) cache = cache.slice(-30000);
            localStorage.setItem('nt_preview_cache', cache);
        }

        if (captured.ws_update && typeof captured.ws_update === 'string') {
            try {
                const s = captured.ws_update.replace(/```json/g, '').replace(/```/g, '').trim();
                const start = s.indexOf('{');
                const end = s.lastIndexOf('}');
                if (start === -1 || end === -1) throw new Error('no json brackets');
                const data = JSON.parse(s.slice(start, end + 1));

                if (data.chars && settings.enableChars) {
                    const focusArr = (settings.focusChars || '').split(/[,，\s]+/).map(n => n.trim()).filter(Boolean);
                    for (const [name, desc] of Object.entries(data.chars)) {
                        const n = String(name).trim();
                        if (focusArr.length > 0 && !focusArr.includes(n)) continue;
                        await stBridge.updateEntry(currentLorebook, `角色·${n}`, desc, false, [n]);
                    }

                    book = await stBridge.loadWorldInfoAsync(currentLorebook);
                    const trackedNames = new Set();
                    for (const entry of Object.values(book.entries)) {
                        if (entry.comment && entry.comment.startsWith('角色·')) {
                            trackedNames.add(entry.comment.replace('角色·', ''));
                        }
                    }
                    if (trackedNames.size > 0) {
                        const tOpen = '<ws_' + 'update>';
                        const rosterText = `【当前已追踪角色名册】\n${Array.from(trackedNames).join('、')}\n\n（提醒：如果这些角色长时间未出场或在幕后发生了变动，请在合适的时机在 ${tOpen} 中更新他们的状态。）`;
                        await stBridge.updateEntry(currentLorebook, '角色索引', rosterText, true);
                    }
                }
                if (data.items && settings.enableItems) {
                    for (const [name, desc] of Object.entries(data.items)) {
                        await stBridge.updateEntry(currentLorebook, `道具·${name}`, desc, false, [name]);
                    }
                }
                if (data.plot && settings.enablePlot) {
                    for (const [name, desc] of Object.entries(data.plot)) {
                        await stBridge.updateEntry(currentLorebook, `计划·${name}`, desc, true);
                    }
                }
                if (data.world && settings.enableWorld) {
                    if (data.world['局势']) {
                        await stBridge.updateEntry(currentLorebook, '世界局势', data.world['局势'], true);
                    }
                }
                if (data.foreshadow && settings.enableForeshadow) {
                    for (const [name, desc] of Object.entries(data.foreshadow)) {
                        await stBridge.updateEntry(currentLorebook, `伏笔·${name}`, desc, true);
                    }
                }
            } catch (e) {
                console.warn('[worldsim] JSON 解析失败', e, captured.ws_update);
            }
        }

        setTimeout(() => { stBridge.hideOldMessages(settings.hideKeepCount); }, 1000);
    }
});
