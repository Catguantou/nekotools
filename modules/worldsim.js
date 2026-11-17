import { registry } from '../core/registry.js';
import { stBridge } from '../core/st_bridge.js';
import { settings as coreSettings } from '../core/settings.js';
import { touchSlot, getSlotClock, setSlotClock } from '../core/slots.js';
import { loadConfig, getCachedConfig } from '../core/worldcfg.js';
import { migrateIndex, syncChars, syncNames, refreshChar, INDEX_TITLE } from '../core/worldindex.js';
import { applyMapOps, setCurrent, mapHasStructure, parseMap, migrateMap, MAP_TITLE } from '../core/worldmap.js';
import { applyMain, applyQuests, parseMain, mainHasContent } from '../core/worldquest.js';
import { parseStatusFields, parseGameDate, daysBetween, stripRosterLayer, formatCharacterYaml, parseCharacterYaml, normalizeMemories, normalizeRelationships } from '../core/worldfmt.js';

const defaultSettings = {
    enabled: true,
    enableStatus: true,
    enablePreview: true,
    enableChars: true,
    enableItems: true,
    enablePlot: true,
    enableWorld: true,
    enableMap: true,
    enableQuests: true,
    enableCognition: true,
    enablePresence: true,
    enableForeshadow: true,
    enableSummary: true,
    enableBigSummary: true,
    lorebookName: '',
    bigSummaryLimit: 100,
    clockJumpDays: 7,
    hideKeepCount: 2,
    visualHideKeep: 0,
    focusChars: '',
    recordUserCharacter: false,
    enableTicks: true,
    worldTickEvery: 3,
    charTickEvery: 2,
    tickMaxChars: 2,
    staleAfter: 5,
    enableAntiLazy: true,
    customPrompts: {
        status: '', preview: '', chars: '', items: '', plot: '',
        world: '', foreshadow: '', summary: '', bigSummary: '', roster: '', genesis: '', tick: '', map: '', quest: '', cognition: '', presence: '',
    }
};

const settings = { ...defaultSettings, customPrompts: { ...defaultSettings.customPrompts } };

// 仅内存：本档是否已完成「开局世界生成」/「开局地图生成」
const worldReady = new Map();
const genesisTries = new Map();
const mapReady = new Map();
const mapTries = new Map();
const questReady = new Map();
const questTries = new Map();

/** 开局世界生成：第一次运行时补全整个世界，而不是只提取当前文本 */
function buildGenesisPrompt() {
    const tagOpen = '<nekotools:genesis>';
    const tagClose = '</nekotools:genesis>';
    let p = `${tagOpen}
【开局世界生成】这是本局第一次运行。先不要只盯着眼前场景，请基于角色卡、世界书设定、用户角色，补全一个完整的世界快照。
必须在本轮 ws_update 里输出 "world": {
  "国家": {"名称": "政体｜领袖｜经济｜军事｜外交关系｜文化｜当前动向"},
  "势力": {"名称": "类型｜目标｜资源｜与主角关系｜当前动作"},
  "社会新闻": {"标题": "事件｜影响｜来源"}
}
国家固定 7 段字段、势力固定 5 段字段、社会新闻固定 3 段字段，顺序不要乱；缺的写“未知”。
至少 3 个国家、3 个势力、3 条社会新闻；国家之间要有建交/贸易/冲突/文化渗透等关系，势力要有自己的目标。
沿用已有设定，不要另起炉灶；不要只写当前文本里已经出现的东西。
${tagClose}`;
    const custom = (settings.customPrompts.genesis || '').trim();
    if (custom) p += `\n【附加要求】\n${custom}`;
    return p;
}

/** 后台 tick：角色轮值 + 世界轮值，频率由设置控制 */
function buildTickPrompt({ needCharTick, needWorldTick }) {
    const maxChars = Math.max(1, Number(settings.tickMaxChars) || 2);
    const staleAfter = Number(settings.staleAfter) || 0;
    const antiLazy = settings.enableAntiLazy && staleAfter > 0;

    const lines = ['<nekotools:tick>', '【本轮后台结算】'];
    lines.push('- 所有内容都写在本轮 ws_update 的 JSON 里，tick / world 只是其中的字段。');
    if (needCharTick) {
        lines.push('- 按等级轮换，不要只挑最久没更新的：');
        lines.push('  · T1（用户关注/钉住）：每轮至少推进 1 个；T1 不降级。');
        lines.push('  · T2（高强度互动/世界书角色）：在场的本轮更新；不在场的每 2 轮更新一次。');
        lines.push('  · T3（配角）：每 5 轮更新一次。');
        lines.push('  · T4（路边 NPC）：只在出场时更新。');
        lines.push('  · 除 T1 外，连续 20 轮未出场/未更新 → 在 roster 里降一级。');
        lines.push(`- 本轮最多写 ${maxChars} 个 tick 对象，在 "tick" 里写他们这轮在后台做了什么：`);
        lines.push('  "tick": {"角色名": {"位置":"地图小地点名","当前行动":"为什么做/怎么做","下一步":"...","心情":"...","已知":["本轮新获知的事"],"后台运行":"A→B→C"}}');
        lines.push('- 只写这些人；玩家不在场也要推进他们自己的计划，不要等玩家。');
    }
    if (needWorldTick) {
        lines.push('- 本轮同时做世界 tick：只更新国家/势力/社会新闻里发生的变化，输出 world。');
        lines.push('- 顺带检查主线/支线：推进主线一步，完成/失败/新增 0–1 条支线（写 main / quests）。');
    }
    if (antiLazy) {
        lines.push(`- 索引里超过 ${staleAfter} 层没更新的角色，本轮必须至少结算 1 个。`);
    }
    lines.push('- 若有角色本轮出场/相遇，必须结合他的日程或当前行动解释“为什么在这里”，不能凭空出现。');
    lines.push('</nekotools:tick>');

    let p = lines.join('\n');
    const custom = (settings.customPrompts.tick || '').trim();
    if (custom) p += `\n【附加要求】\n${custom}`;
    return p;
}

/** T1 每轮提醒：用户关注/钉住角色必须持续推进 */
function buildT1Prompt() {
    return `<nekotools:t1>
【T1 每轮推进】索引里若有 T1（用户关注/钉住）角色，本轮至少推进 1 个，写进 tick：位置 / 当前行动 / 下一步。
如果本轮 T1 已经在正文出场，也要补一条 tick 记录他接下来要做什么。索引里没有 T1 就跳过。
</nekotools:t1>`;
}

/** 开局地图生成：从世界书地点出发，补全周边可探索地点 */
function buildMapGenesisPrompt(bookName = '') {
    const tagOpen = '<nekotools:mapgen>';
    const tagClose = '</nekotools:mapgen>';
    const clock = bookName ? getSlotClock(bookName) : null;
    const here = clock && clock.place ? `当前地点：${clock.place}。` : '';
    let p = `${tagOpen}
【开局地图生成】${here}从世界书已有地点出发，总结当前已知地点，并合理推演周边地点，输出 "map"：
{
  "regions": {"区域/国家名": "方位：西｜类型：王国｜一句话描述"},
  "cities": {"区域名": {"城市名": "方位：中｜类型：都城｜一句话描述"}},
  "sites": {"城市名": {"地点名": "方位：南｜类型：街区｜出口：A、B｜可交互：...｜常驻：..."}}
}
- 2–3 个大地图区域（国家/地区），每个区域 1–2 个中地图城市，每个城市 3–5 个小地点。
- 方位用 北/南/东/西/中/东北/西北/东南/西南；同一层的地点要分散开，不要全挤在中间。
- 必须包含主角当前地点，且它在某个城市下；地点之间用出口互相连接。
- **地点名全局唯一，不要重名**；不同城市的同名地点请用“城市·地点”区分。
- 先复用世界书里出现过的地名，不要造与设定冲突的地方。
${tagClose}`;
    const custom = (settings.customPrompts.map || '').trim();
    if (custom) p += `\n【附加要求】\n${custom}`;
    return p;
}

/** 每轮的地图增量契约 */
function buildMapPrompt() {
    let p = `<nekotools:track.map>
【地图】JSON 字段 "map":
{
  "regions": {"区域/国家名": "方位：西｜类型｜一句话"},
  "cities": {"区域名": {"城市名": "方位：中｜类型｜一句话"}},
  "sites": {"城市名": {"地点名": "方位：南｜类型｜出口：A、B｜可交互：...｜常驻：..."}},
  "del": {"regions": ["..."], "cities": ["..."], "sites": ["..."]}
}
只写本轮新出现/变化的地点；当前地点由插件自动写。方位用 北/南/东/西/中/东北/西北/东南/西南，同层要分散。地点名**全局唯一**，不要重名；重名用“城市·地点”区分。地点名要能在正文里出现，且位置必须使用这里的小地点名。
</nekotools:track.map>`;
    return p;
}

/** 扫一遍书，判断地图是否已有足够地点 */
function markMapReady(bookName, book) {
    if (!bookName) return;
    const entry = book && book.entries
        ? Object.values(book.entries).find(e => e && e.comment === MAP_TITLE)
        : null;
    const data = entry ? parseMap(entry.content) : null;
    const ready = mapHasStructure(data);
    mapReady.set(bookName, ready);
    if (ready) mapTries.delete(bookName);
}

/** 开局主线/支线生成 */
function buildQuestGenesisPrompt() {
    const tagOpen = '<nekotools:questgen>';
    const tagClose = '</nekotools:questgen>';
    let p = `${tagOpen}
【开局主线生成】基于角色卡、世界书设定、用户角色，生成本局的长期主线 + 2 条支线，必须写在本轮 ws_update 的 JSON 里：
"main": {"标题": "...", "目标": "...", "阶段": "开局", "进度": 0, "失败代价": "...", "下一步": "..."}
"quests": {"add": {"支线名": "类型｜目标｜状态｜钩子"}}
- 主线必须是能长期推进的目标，由世界和 NPC 推动，**不要让玩家做选择**。
- 支线要能在当前地区自然触发，和 NPC/势力/新闻有关。
${tagClose}`;
    const custom = (settings.customPrompts.quest || '').trim();
    if (custom) p += `\n【附加要求】\n${custom}`;
    return p;
}

/** 每轮的主线/支线增量契约 */
function buildQuestPrompt() {
    return `<nekotools:track.quest>
【主线】JSON 字段 "main": {"标题":"...","目标":"...","阶段":"...","进度":0-100,"失败代价":"...","下一步":"..."}
只写本轮变化的字段；主线要自动推进，不要让玩家选择。这里只维护长期目标/阶段/进度，不写本轮三种走向或概率。
【支线】JSON 字段 "quests": {"add": {"支线名":"类型｜目标｜状态｜钩子"}, "del": ["支线名"]}
只写新增/完成/失败/删除的支线；这里只维护支线状态，不写本轮短期走向；支线是**可执行的目标/钩子**，已经发生的公开事件写进世界局势的社会新闻，不要重复。可以自然生成新的支线钩子，但不要围着玩家转。
</nekotools:track.quest>`;
}

function markQuestReady(bookName, book) {
    if (!bookName) return;
    const entry = book && book.entries
        ? Object.values(book.entries).find(e => e && e.comment === '主线')
        : null;
    const main = entry ? parseMain(entry.content) : {};
    const ready = mainHasContent(main);
    questReady.set(bookName, ready);
    if (ready) questTries.delete(bookName);
}

/** 把主线进度记到 slotMeta，存档列表能显示「主线 37%」 */
function rememberMainProgress(bookName, main) {
    if (!bookName || !main) return;
    try {
        const all = coreSettings.get('worldsim') || {};
        const slotMeta = { ...(all.slotMeta || {}) };
        slotMeta[bookName] = {
            ...(slotMeta[bookName] || {}),
            mainProgress: Number(main['进度']) || 0,
            mainTitle: main['标题'] || '',
        };
        coreSettings.set('worldsim', { slotMeta });
    } catch (_) {}
}

function markWorldReady(bookName, book) {
    if (!bookName) return;
    const entry = book && book.entries
        ? Object.values(book.entries).find(e => e && e.comment === '世界局势')
        : null;
    const data = entry ? parseWorldContent(entry.content) : null;
    const hasWorld = worldHasStructure(data);
    worldReady.set(bookName, hasWorld);
    if (hasWorld) genesisTries.delete(bookName);
}
// 仅内存记录，用于识别「换了会话」，不持久化
let lastChatId = null;
// 上一次已应用的更新快照：重 roll / 删除时回滚
let lastAppliedUpdate = null;

function cloneBook(book) {
    try {
        return JSON.parse(JSON.stringify(book));
    } catch (e) {
        console.warn('[worldsim] 快照失败', e);
        return null;
    }
}

async function restoreLastApplied(reason) {
    if (!lastAppliedUpdate) return false;
    const ctx = stBridge.getContext();
    if (lastAppliedUpdate.chatId !== (ctx.chatId ?? null)) {
        lastAppliedUpdate = null;
        return false;
    }
    try {
        // 删档后重 roll：旧快照不能把已删除的书写回来
        if (!(await stBridge.bookExists(lastAppliedUpdate.bookName))) {
            console.warn('[worldsim] 追踪书已删除，丢弃回滚快照');
            lastAppliedUpdate = null;
            return false;
        }
        await stBridge._writeBook(lastAppliedUpdate.bookName, lastAppliedUpdate.pre);
        // 时钟也回滚到本轮之前（时钟只存设置，不写世界书）
        if (lastAppliedUpdate.clockBefore !== undefined) {
            setSlotClock(lastAppliedUpdate.bookName, lastAppliedUpdate.clockBefore || null);
            try { window.dispatchEvent(new CustomEvent('nekotool:clock-changed')); } catch (_) {}
        }
        // 回滚了这一轮的时间跳跃，也要把提示一起清掉
        const jump = coreSettings.get('worldsim').clockJump;
        if (jump && jump.book === lastAppliedUpdate.bookName) {
            coreSettings.set('worldsim', { clockJump: null });
            try { window.dispatchEvent(new CustomEvent('nekotool:clock-jump')); } catch (_) {}
        }
        console.log('[worldsim] 已回滚上一次追踪更新（' + reason + '）');
        lastAppliedUpdate = null;
        return true;
    } catch (e) {
        console.warn('[worldsim] 回滚失败', e);
        return false;
    }
}

function loadSettings() {
    const saved = coreSettings.get('worldsim');
    if (!saved || typeof saved !== 'object') return;
    // 只认 defaultSettings 里的键：clockJump / slotMeta 是运行时状态，
    // 不能并进模块设置，否则面板保存时会把已清除的提示写回存储
    for (const key of Object.keys(defaultSettings)) {
        if (key === 'customPrompts') continue;
        if (saved[key] !== undefined) settings[key] = saved[key];
    }
    settings.customPrompts = { ...defaultSettings.customPrompts, ...(saved.customPrompts || {}) };
}

function saveSettings() {
    const out = {};
    for (const key of Object.keys(defaultSettings)) {
        if (key === 'customPrompts') continue;
        out[key] = settings[key];
    }
    out.customPrompts = { ...defaultSettings.customPrompts, ...(settings.customPrompts || {}) };
    coreSettings.set('worldsim', out);
}

function getLorebookName() {
    // 每张角色卡一本专属追踪书，命名规则集中在 stBridge.trackerBookName()
    return stBridge.trackerBookName();
}

const DIRECTOR_PROMPT = `<nekotools:director>
【NEKOTOOL 世界模拟器核心指令】
你是普赛克使用的世界模拟器工具NEKOTOOL，请结合【认知隔离】，严格执行以下任务：
1. 世界合理化：用户输入先判定成功率与后果，让世界始终保持真实且符合基本逻辑与规律运转。
2. 长线维护：以维持几千层游玩不无聊为目标，必须时刻运行主线与支线，前期埋下的伏笔或计划在未来适时引爆。
3. 认知隔离：严禁上帝视角。角色只能基于当前五感、已有记忆和信息差行动。暗中计划绝不突然告诉用户。
4. 输出格式：严格遵守下方系统标签的契约。所有标签必须放在正文末尾，标签内部仅供系统后台记录，不要用代码块包裹，绝对不要在正文中向用户解释这些标签。
</nekotools:director>`;

/** 认知隔离：去掉全知视角，角色只能用有限感官与已有记忆行动 */
function buildCognitionPrompt() {
    let p = `<nekotools:cognition>
【认知隔离 · 最高优先级】
- 去除全知视角，完全以角色的有限认知看待当下。角色只基于当前五感与已有记忆行动，遵守情报的时空限制。
- 只有用户被引号包裹、实际说出口的对话和明确的表情可以被感知；用户的想法、心理活动、旁白、系统提示严禁被角色得知或回应。
- 去元认知：禁止打破第四面墙的说明、元叙事、设定解说；禁止“原著/原本轨迹/剧情需要/作为AI”等 meta 发言。
- 时间：绝不混淆时间轴；未来的事不能提前被当下得知；未发生的未来、以后才会认识的人，绝不可能被角色说出口，绝对禁止剧透。
- 空间：信息获取严格限制在角色物理感官内；无法得知不在场的事件。
- 判断标准：严格区分叙事者所知与角色所知；凡是不清楚角色是否可知的内容，一律处理为“不知道”；严禁上帝视角、预知未来、跨场景获取情报。
- 信息差：任何情报都要有来源（看到/听到/查到/被告诉）；角色之间、角色与用户之间允许存在信息差，不得凭空得知。
- 秘密：角色的个人隐私、重大秘密、成长经历、痛苦往事，绝不随口说出；只有被逼问、信任足够或剧情付出代价时才可能透露。
</nekotools:cognition>`;
    const custom = (settings.customPrompts.cognition || '').trim();
    if (custom) p += `\n【附加要求】\n${custom}`;
    return p;
}

/** 在场与日程：角色不能凭空出现在当前场景 */
function buildPresencePrompt(bookName) {
    const clock = bookName ? getSlotClock(bookName) : null;
    const place = clock && clock.place ? `当前地点：${clock.place}。` : '';
    let p = `<nekotools:presence>
【在场与日程】${place}
- 角色出场必须满足：索引里的位置就是当前地点，或按他的日程/当前行动确实在此地。
- 不在场的角色不能凭空出现；若要出场，必须先写清他如何赶到（路程、时间、理由）。
- 每次让角色出场前先检查：他真的会在这里吗？不确定就让他不在。
- T4 路人只在需要时出现，不要为了热闹塞人。
</nekotools:presence>`;
    const custom = (settings.customPrompts.presence || '').trim();
    if (custom) p += `\n【附加要求】\n${custom}`;
    return p;
}

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
    const tagClose = '</ws_' + 'preview>';
    let p = `<nekotools:preview>
【剧情推演 · 仅供后台参考 · 绝对禁止向用户直接展示或罗列选项】
长期主线/支线由「主线」「支线」条目维护；这里**只写本轮短期走势**，不要重复长期目标、任务进度或支线列表。
你必须把全部推演内容夹在下面两个标签之间，**开始标签和结束标签都必须原样输出**；缺少结束标签会被判为正文泄露：
${tagOpen}
## 1. 行为推演
评估：结合世界观与当前阻力，用户的行动成功率大约是 XX%。
三种走向（按概率排序）：
- 走向1（XX%）：[描述可能导致的后果，不一定是用户想要的]
- 走向2（XX%）：[描述突发事件或部分成功]
- 走向3（XX%）：[描述完全的成功]
## 2. 短期走向（只写接下来 1–3 步）
下一步：[用户行动后最可能立即发生的反应]
隐患：[本轮或下一步可能冒出的即时事件/线索，不写长期伏笔清单]
倾向量表：【喜剧%+悲剧%+正剧%+幽默%+严肃%+欢快%+宏大%】
${tagClose}
（标签之外绝对不要重复上述推演内容）`;

    const custom = (settings.customPrompts.preview || '').trim();
    if (custom) p += `\n【附加要求】\n${custom}`;

    return p;
}

function buildTrackingMessages(bookName = '') {
    const list = [];
    const anyEnabled = settings.enableChars || settings.enableItems || settings.enablePlot
        || settings.enableWorld || settings.enableForeshadow || settings.enableMap || settings.enableQuests;
    if (!anyEnabled) return list;

    const tagOpen = '<ws_' + 'update>';
    const tagClose = '</ws_' + 'update>';
    list.push({
        role: 'system',
        content: `<nekotools:update>
【状态数据流契约】必须在本轮回复末尾输出 ${tagOpen} ... ${tagClose}，两者都不能省略，标签内含合法 JSON（不要代码块包裹，标签外不加任何其它字符）。
chars / tick / items / plot / world / map / main / quests / foreshadow / roster 都只写**本轮变化**：chars 写有变化的角色；tick 写离屏角色的后台行动；其余分类只写增量（add/del），绝不重复输出未变化的内容。
</nekotools:update>`
    });

    if (settings.enableChars) {
        const userName = stBridge.getUserName() || '用户';
        const recordUserChar = settings.recordUserCharacter === true;
        let c = `<nekotools:track.chars>
【角色追踪】JSON 字段 "chars": {"角色名": {"性别":"...","外貌":"...","人际关系":{"${userName}":"好感 50｜信任 50｜中性：..."},"状态":"...","后台运行":"...","长期目标":"...","近期打算":"...","关键记忆":["本轮新增1-2条"],"特殊变化":"..."}}
要求：记录活跃角色${recordUserChar ? `（包括用户角色${userName}）` : `（不包括用户角色${userName}）`}。六个字段全部必填，每个字段写完整的句子，不要合并成一句话：
- 位置：优先使用「地图」里的小地点名；没有就写当前地点
- 日程：早晨/白天/夜晚 各写「地点｜做什么」，地点同样用地图小地点名
- 状态：动作/衣着/生理状态/本次更新的剧情时间
- 后台运行：若刚出场或时间跳跃，用 A→B→C 的动作链记录
- 长期目标：最重要的长期追求
- 近期打算：短期内最可能采取的下一个具体行动
- 关键记忆：【事件】→ 导致了什么转变（本轮只写新增的 1-2 条，用数组或换行分隔；插件会追加到旧记忆，不会覆盖）
- 特殊变化：生理状态/人生目标/持有道具/人际关系/理念/身份地位的变化；确实没有就写“无”
可选：身份。
必填基础：性别 / 外貌（简单一句）/ 人际关系。
${recordUserChar ? `用户角色「${userName}」也作为一条普通角色输出档案。` : `不要输出用户角色「${userName}」的档案。`}
人际关系是对象，键写对方真实名字。用户角色就叫「${userName}」；第一次正式遇见之后才写，没遇见就不要写。
值的格式："好感 X｜信任 Y｜标签：一句原因"。
好感/信任都是 0-100：好感 0-20 敌意 / 21-40 冷淡 / 41-60 中性 / 61-80 亲近 / 81-100 信赖或爱慕；
信任 0-20 提防 / 21-40 保留 / 41-60 一般 / 61-80 信任 / 81-100 生死托付。
只写本轮有变化的人；插件会按人合并，没写到的旧关系保留。姓名由插件自动写，不用输出。
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

    // 角色索引：不依赖「角色追踪」开关，只要有追踪就维护
    list.push({ role: 'system', content: buildRosterPrompt(bookName) });

    if (settings.enableMap) list.push({ role: 'system', content: buildMapPrompt() });
    if (settings.enableQuests) list.push({ role: 'system', content: buildQuestPrompt() });

    if (settings.enableItems) {
        let c = `<nekotools:track.items>
【道具追踪】JSON 字段 "items": {"add": {"道具名": "[持有者 | 作用 | 来源] 描述"}, "del": ["道具名"]}
要求：只写本轮**变化**的道具，不要重复未变的条目。add 新增或覆盖同名项；del 删除已失去/已用掉的道具。没有变化就写 "items": {}。
道具名要短（2-8 字），必须能在正文里原样出现——这条按名字做绿灯激活。
重点保留未来剧情可能召回的道具。
`;
        const custom = (settings.customPrompts.items || '').trim();
        if (custom) c += `【附加要求】\n${custom}\n`;
        c += `</nekotools:track.items>`;
        list.push({ role: 'system', content: c });
    }

    if (settings.enablePlot) {
        let c = `<nekotools:track.plot>
【计划追踪】JSON 字段 "plot": {"add": {"计划名": "[执行者 | 目标 | 进度 | 状态] 描述"}, "del": ["计划名"]}
要求：只写本轮**变化**的计划，不要重复未变的条目。add 新增或覆盖；计划结束/作废用 del。没有变化就写 "plot": {}。
重要：此条目与角色后台动向联动。暗中进行的计划必须严守认知隔离，绝不能提前在正文中让用户或无关角色得知
`;
        const custom = (settings.customPrompts.plot || '').trim();
        if (custom) c += `【附加要求】\n${custom}\n`;
        c += `</nekotools:track.plot>`;
        list.push({ role: 'system', content: c });
    }

    if (settings.enableWorld) {
        let c = `<nekotools:track.world>
【世界局势】JSON 字段 "world": {"国家": {"名称":"政体｜领袖｜经济｜军事｜外交关系｜文化｜当前动向"}, "势力": {"名称":"类型｜目标｜资源｜与主角关系｜当前动作"}, "社会新闻": {"标题":"事件｜影响｜来源"}, "del": {"国家":["名称"], "势力":["名称"], "社会新闻":["标题"]}}
要求：国家固定 7 段字段、势力固定 5 段字段、社会新闻固定 3 段字段，顺序不要乱；缺的写“未知”。
要求：只写本轮**变化**；国家、势力、社会新闻分开维护，不要把所有东西都塞进社会新闻。没有变化就写 "world": {}。
社会新闻只写**已经发生的公开事实**；可执行的目标/承诺/待办钩子放「支线」，不要写进社会新闻。
世界要自己运转：国家之间会建交/断交/战争/贸易/文化渗透，势力有自己的目标和动作，不要围着主角转。
`;
        const custom = (settings.customPrompts.world || '').trim();
        if (custom) c += `【附加要求】\n${custom}\n`;
        c += `</nekotools:track.world>`;
        list.push({ role: 'system', content: c });
    }

    if (settings.enableForeshadow) {
        let c = `<nekotools:track.foreshadow>
【草蛇伏笔】JSON 字段 "foreshadow": {"add": {"伏笔名": "[线索 | 指向/可能的作用] 描述"}, "del": ["伏笔名"]}
要求：只写本轮**新增或修改**的伏笔，不要重复未变的条目。已触发/废弃的伏笔用 del。没有变化就写 "foreshadow": {}。与计划追踪严格分开。
伏笔名要短（2-8 字），用正文里可能出现的词——这条按名字做绿灯激活。
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
    const tagClose = '</ws_' + 'summary>';
    let p = `<nekotools:summary>
【格式契约】必须在末尾输出 ${tagOpen} ... ${tagClose}，开始与结束标签都要有。100字内对本轮剧情进行简洁概括，完整保留角色行为、发展与对话，包括详细日期时间，记录如学习到的经验/领悟/技巧/教训，或者是约定/承诺/性格转变/道具/礼物等等重要内容，确保记录具体且清晰的实际内容，严禁概括为模糊形容词
</nekotools:summary>`;
    const custom = (settings.customPrompts.summary || '').trim();
    if (custom) p += `\n【附加要求】\n${custom}`;
    return p;
}

function buildBigSummaryPrompt() {
    const tagOpen = '<ws_' + 'big_summary>';
    const tagClose = '</ws_' + 'big_summary>';
    let p = `<nekotools:bigsummary>
【格式契约 · 仅本轮触发】必须输出 ${tagOpen} ... ${tagClose}，开始与结束标签都要有。停止所有角色扮演，作为总结助手对本局游戏至此的剧情进行【大总结】。保持中性客观，总体2000token上下对已发生时间进行总结，以自然语言交代清楚发生了什么，且事件时间顺序必须与前文一致，保持时间线清晰度。相近时间事件整合为同一时间跨度，并使用【】对时间跨度进行标记，保留关键事件、人物关系变化、重要伏笔。
</nekotools:bigsummary>`;
    const custom = (settings.customPrompts.bigSummary || '').trim();
    if (custom) p += `\n【附加要求】\n${custom}`;
    return p;
}

function buildSystemMessages(needBig, includeTracking = true, bookName = '', needGenesis = false, needMapGenesis = false, needQuestGenesis = false) {
    const list = [];
    if (needGenesis) list.push({ role: 'system', content: buildGenesisPrompt() });
    if (needMapGenesis) list.push({ role: 'system', content: buildMapGenesisPrompt(bookName) });
    if (needQuestGenesis) list.push({ role: 'system', content: buildQuestGenesisPrompt() });
    list.push({ role: 'system', content: DIRECTOR_PROMPT });
    if (settings.enableCognition) list.push({ role: 'system', content: buildCognitionPrompt() });
    if (settings.enablePresence && includeTracking) list.push({ role: 'system', content: buildPresencePrompt(bookName) });

    if (settings.enableStatus) list.push({ role: 'system', content: buildStatusPrompt() });
    if (settings.enablePreview) list.push({ role: 'system', content: buildPreviewPrompt() });

    // 追踪书不存在时不要再要求模型输出追踪 JSON：写了也没地方存，白烧 token
    if (includeTracking) {
        list.push(...buildTrackingMessages(bookName));
        if (settings.enableSummary) list.push({ role: 'system', content: buildSummaryPrompt() });
        if (needBig) list.push({ role: 'system', content: buildBigSummaryPrompt() });
    }

    // 世界书设定不再由本插件注入：追踪书已经全局激活，酒馆自己会把它送进提示词。
    // 重复注入既浪费 token，也会让同一段设定出现两次。
    return list;
}

/** 角色条目：YAML 格式，姓名写进正文；关键记忆追加不覆盖 */
async function updateCharacterEntry(bookName, name, info, book, replyLayer = 0) {
    const target = book || await stBridge.loadWorldInfoAsync(bookName);
    if (!target || !target.entries) return;

    const oldEntry = Object.values(target.entries).find(e => e && e.comment === `角色·${name}`);
    const old = oldEntry ? parseCharacterYaml(oldEntry.content) : {};

    const mergeList = (a, b) => {
        const out = [...a];
        const seen = new Set(out);
        for (const item of b) {
            if (!seen.has(item)) {
                out.push(item);
                seen.add(item);
            }
        }
        return out;
    };

    const merged = mergeList(normalizeMemories(old['关键记忆']), normalizeMemories(info && info['关键记忆']));
    const mergedKnown = mergeList(normalizeMemories(old['已知']), normalizeMemories(info && info['已知']));

    // 人际关系/日程按 key 合并：本轮没写到的人保留旧状态
    const mergedRel = {
        ...normalizeRelationships(old['人际关系']),
        ...normalizeRelationships(info && info['人际关系']),
    };
    const mergedSchedule = {
        ...normalizeRelationships(old['日程']),
        ...normalizeRelationships(info && info['日程']),
    };

    const finalInfo = { ...(info && typeof info === 'object' ? info : {}) };
    // 旧的可选基本信息（性别/外貌/身份等）本轮没写就保留
    for (const [k, v] of Object.entries(old)) {
        if (['姓名', '关键记忆', '人际关系', '已知', '日程'].includes(k)) continue;
        if (!(k in finalInfo) || !String(finalInfo[k] ?? '').trim()) finalInfo[k] = v;
    }
    finalInfo['关键记忆'] = merged;
    if (mergedKnown.length) finalInfo['已知'] = mergedKnown;
    else delete finalInfo['已知'];
    if (Object.keys(mergedRel).length) finalInfo['人际关系'] = mergedRel;
    else delete finalInfo['人际关系'];
    if (Object.keys(mergedSchedule).length) finalInfo['日程'] = mergedSchedule;
    else delete finalInfo['日程'];
    if (replyLayer > 0) finalInfo['更新于'] = `第 ${replyLayer} 层`;

    const content = formatCharacterYaml(name, finalInfo);
    stBridge.upsertEntryInBook(target, `角色·${name}`, content, {
        isConstant: false,
        keywords: [name],
        extra: { position: 0, depth: 0, order: 860 },
    });
    await stBridge.persistLorebook(bookName, target);
}

/** 世界局势固定三段 */
const WORLD_SECTIONS = ['国家', '势力', '社会新闻'];

/** 至少有一个国家 + 一个势力，才算世界结构建立起来 */
function worldHasStructure(data) {
    if (!data) return false;
    return Object.keys(data.国家 || {}).length > 0 && Object.keys(data.势力 || {}).length > 0;
}

function parseWorldContent(content) {
    const data = { 国家: {}, 势力: {}, 社会新闻: {} };
    let section = '社会新闻';
    for (const raw of String(content || '').split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        if (line === '【国家】') { section = '国家'; continue; }
        if (line === '【势力】') { section = '势力'; continue; }
        if (line === '【社会新闻】') { section = '社会新闻'; continue; }
        if (line.startsWith('【')) continue;
        const m = line.match(/^-\s*([^｜|]+)[｜|]([\s\S]*)$/);
        if (m) data[section][m[1].trim()] = m[2].trim();
    }
    return data;
}

function renderWorldContent(data) {
    const src = { 国家: {}, 势力: {}, 社会新闻: {}, ...(data || {}) };
    const lines = ['【以下为世界局势】'];
    for (const section of WORLD_SECTIONS) {
        lines.push(`【${section}】`);
        const map = src[section] || {};
        const names = Object.keys(map);
        if (!names.length) lines.push('（暂无）');
        for (const name of names) {
            const desc = String(map[name] ?? '').trim();
            if (desc) lines.push(`- ${name}｜${desc}`);
        }
    }
    return lines.join('\n');
}

/** 兼容：新结构（国家/势力/社会新闻）+ 旧的 add/del 平铺 */
function normalizeWorldRaw(raw) {
    const out = { 国家: {}, 势力: {}, 社会新闻: {}, del: { 国家: [], 势力: [], 社会新闻: [] } };
    if (!raw || typeof raw !== 'object') return out;

    const hasSections = WORLD_SECTIONS.some(s => raw[s] && typeof raw[s] === 'object');
    if (hasSections) {
        for (const section of WORLD_SECTIONS) {
            const block = raw[section];
            if (block && typeof block === 'object' && !Array.isArray(block)) {
                for (const [name, value] of Object.entries(block)) {
                    const n = String(name || '').trim();
                    if (!n) continue;
                    out[section][n] = String(value ?? '').trim();
                }
            }
            if (raw.del && Array.isArray(raw.del[section])) {
                out.del[section] = raw.del[section].map(String);
            }
        }
        // 新闻 是 社会新闻 的简写
        if (raw['新闻'] && typeof raw['新闻'] === 'object' && !Array.isArray(raw['新闻'])) {
            for (const [name, value] of Object.entries(raw['新闻'])) {
                out.社会新闻[String(name).trim()] = String(value ?? '').trim();
            }
        }
        if (raw.del && Array.isArray(raw.del['新闻'])) out.del.社会新闻.push(...raw.del['新闻'].map(String));
        return out;
    }

    // 旧平铺：全部归到社会新闻，模型之后可以再分到国家/势力
    const source = (raw.add && typeof raw.add === 'object') || Array.isArray(raw.del)
        ? raw
        : { add: raw, del: [] };
    for (const [name, value] of Object.entries(source.add || {})) {
        const n = String(name || '').trim();
        if (!n) continue;
        out.社会新闻[n] = String(value ?? '').trim();
    }
    if (Array.isArray(source.del)) out.del.社会新闻 = source.del.map(String);
    return out;
}

async function applyWorldUpdate(bookName, raw) {
    const book = await stBridge.loadWorldInfoAsync(bookName);
    if (!book || !book.entries) return null;
    const entry = Object.values(book.entries).find(e => e && e.comment === '世界局势');
    const data = parseWorldContent(entry?.content);
    const ops = normalizeWorldRaw(raw);

    for (const section of WORLD_SECTIONS) {
        for (const name of ops.del[section] || []) delete data[section][name];
        for (const [name, value] of Object.entries(ops[section])) {
            if (!value) delete data[section][name];
            else data[section][name] = value;
        }
    }

    stBridge.upsertEntryInBook(book, '世界局势', renderWorldContent(data), {
        isConstant: true,
        extra: { position: 0, depth: 0, order: 800, key: [] },
    });
    await stBridge.persistLorebook(bookName, book);
    return data;
}

/** 旧平铺世界局势迁移成「国家/势力/社会新闻」三段 */
async function migrateWorld(bookName) {
    try {
        const book = await stBridge.loadWorldInfoAsync(bookName, true);
        if (!book || !book.entries) return;
        const entry = Object.values(book.entries).find(e => e && e.comment === '世界局势');
        if (!entry) return;
        const content = String(entry.content || '');
        if (WORLD_SECTIONS.some(s => content.includes(`【${s}】`))) return;
        const data = parseWorldContent(content);
        stBridge.upsertEntryInBook(book, '世界局势', renderWorldContent(data), {
            isConstant: true,
            extra: { position: 0, depth: 0, order: 800, key: [] },
        });
        await stBridge.persistLorebook(bookName, book);
        console.log('[worldsim] 世界局势已迁移为 国家/势力/社会新闻 三段');
    } catch (e) {
        console.warn('[worldsim] 世界局势迁移失败', e);
    }
}

/** 非角色分类：合并成一条，一行一个对象 */
function formatAggregate(map) {
    if (!map || typeof map !== 'object') return '';
    const lines = Object.entries(map)
        .filter(([, v]) => v !== undefined && v !== null && String(v).trim())
        .map(([k, v]) => `- ${k}｜${String(v).trim()}`);
    return lines.length ? lines.join('\n') : '（暂无）';
}

/** 条目开头加一段固定标题，方便模型按区块检索 */
function renderAggregate(title, map) {
    return `【以下为${title}】\n${formatAggregate(map)}`;
}

/** 从聚合条目内容还原成 {名称: 描述} */
function readAggregate(content) {
    const map = {};
    for (const line of String(content || '').split('\n')) {
        const m = line.match(/^\s*-\s*([^｜|]+)[｜|]([\s\S]*)$/);
        if (m) map[m[1].trim()] = m[2].trim();
    }
    return map;
}

/** 绿灯激活词：短词根优先（ST 是精确匹配，长名字基本等不到原样出现） */
/** 模型有时把「T1核心」写进位置、把真实地点写进行动，这里换回来 */
function fixRosterValue(value) {
    const parts = String(value || '').split('｜').map(s => s.trim());
    if (parts.length >= 3) {
        const [tier, location, ...rest] = parts;
        const action = rest.join('｜');
        if (/^(T\d|核心|重要|次要|主要)/i.test(location)
            && /([·街城鎮村区市巷广场酒馆王都]|市场|广场)/.test(action)) {
            return [tier, action, location].join('｜');
        }
    }
    return parts.join('｜');
}

function deriveKeys(map, title) {
    const keys = [];
    for (const name of Object.keys(map || {})) {
        const n = String(name || '').trim();
        if (!n) continue;
        if (n.length <= 6) keys.push(n);
        for (const part of n.split(/[·｜|、\s]+/)) {
            if (part.length >= 2 && part.length <= 8) keys.push(part);
        }
        if (n.includes('的')) {
            const tail = n.split('的').pop().trim();
            if (tail.length >= 2 && tail.length <= 8) keys.push(tail);
        }
        if (n.length >= 4) keys.push(n.slice(-2));
        if (n.length >= 5) keys.push(n.slice(-3));
    }
    keys.push(title);
    return [...new Set(keys)].filter(k => k.length >= 2).slice(0, 60);
}

/** 解析增量指令：{ add: {名:描述}, del: [名] }；兼容旧的整表格式 */
function parseOps(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const hasOps = Array.isArray(raw.del) || (raw.add && typeof raw.add === 'object');
    if (hasOps) {
        return {
            add: (raw.add && typeof raw.add === 'object') ? raw.add : {},
            del: Array.isArray(raw.del) ? raw.del.map(String) : [],
        };
    }
    return { add: raw, del: [] };
}

/**
 * 按增量指令修改单条目：只动变化的行，不重写未变内容。
 * keyword=true 时条目改成绿灯（按条目名激活），否则常驻。
 */
async function applyAggregateOps(bookName, title, raw, order = 900, { keyword = false } = {}) {
    const ops = parseOps(raw);
    if (!ops) return false;
    if (!Object.keys(ops.add).length && !ops.del.length) return false;

    const book = await stBridge.loadWorldInfoAsync(bookName);
    if (!book || !book.entries) return false;
    const entry = Object.values(book.entries).find(e => e && e.comment === title);
    const map = readAggregate(entry?.content);

    for (const key of ops.del) delete map[key];
    for (const [key, value] of Object.entries(ops.add)) {
        const text = (value === null || value === undefined) ? '' : String(value).trim();
        if (!text) { delete map[key]; continue; } // 传空值等同删除
        map[key] = text;
    }

    // 就地改这一条，再整本存一次；避免 updateEntry 再读一遍盘
    stBridge.upsertEntryInBook(book, title, renderAggregate(title, map), {
        isConstant: !keyword,
        keywords: keyword ? deriveKeys(map, title) : [],
        extra: { position: 0, depth: 0, order },
    });
    await stBridge.persistLorebook(bookName, book);
    return map;
}

/** 兜底：模型没按契约包标签时，把漏到正文的未闭合 tag / 推演块切掉 */
function sanitizeLastMessage() {
    const ctx = stBridge.getContext();
    const chat = ctx.chat || [];
    let idx = -1;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i] && !chat[i].is_user) { idx = i; break; }
    }
    if (idx < 0) return;

    const msg = chat[idx];
    const before = String(msg.mes || '');
    let text = before;

    // 未闭合的 <ws_xxx> 标签及其后内容
    text = text.replace(/\n*\s*<(ws_[a-z_]+)>[\s\S]*$/i, '');
    // 漏出标签的剧情推演块（同时命中「走向1」才判定，避免误伤正文）
    if (/走向\s*1/.test(text) && /(剧情推演|行为推演)/.test(text)) {
        text = text.replace(/\n*\s*(?:【剧情推演[^\n]*|##\s*1[.、]?\s*行为推演)[\s\S]*$/, '');
    }

    text = text.trim();
    if (text === before) return;

    msg.mes = text;
    try { ctx.updateMessageBlock?.(idx, msg); } catch (_) {}
    try { ctx.saveChat?.(); } catch (_) {}
    console.warn('[worldsim] 已拦截漏出正文的标签/推演内容');
}

/**
 * 解析本轮状态栏，把时钟记到当前存档的元数据里（不写世界书）。
 * 只用本轮捕获的 ws_status，不发额外请求。
 */
async function applyClock(bookName, captured, replyLayer = 0) {
    if (!settings.enableStatus) {
        clearClockJump(bookName);
        return null;
    }
    const fields = parseStatusFields(captured && captured.ws_status);
    if (!fields) return null;

    const oldClock = getSlotClock(bookName) || {};
    // 本轮缺的字段沿用上一轮，避免模型偶尔没写时间就把钟清掉
    const merged = { ...oldClock };
    for (const key of ['time', 'place', 'weather', 'temperature']) {
        if (fields[key]) merged[key] = fields[key];
    }

    const oldDate = parseGameDate(oldClock.time);
    const newDate = parseGameDate(merged.time);

    const ctx = stBridge.getContext();
    const layer = replyLayer || (Array.isArray(ctx.chat) ? ctx.chat.length : 0);
    setSlotClock(bookName, { ...merged, layer, at: Date.now() });
    try { window.dispatchEvent(new CustomEvent('nekotool:clock-changed')); } catch (_) {}

    if (!oldDate || !newDate) return { ...merged, layer };
    // 只认「往前走」的跳跃；闪回/回档不报补算
    const delta = daysBetween(oldDate, newDate);
    const limit = Number(settings.clockJumpDays) || 7;
    if (delta > limit) {
        coreSettings.set('worldsim', { clockJump: { book: bookName, days: delta, at: Date.now() } });
        console.warn(`[worldsim] 时间跳跃 ${delta} 天（阈值 ${limit}）`);
        try { window.dispatchEvent(new CustomEvent('nekotool:clock-jump')); } catch (_) {}
    } else {
        clearClockJump(bookName);
    }
    return { ...merged, layer };
}

function clearClockJump(bookName) {
    const jump = coreSettings.get('worldsim').clockJump;
    if (!jump || (bookName && jump.book !== bookName)) return;
    coreSettings.set('worldsim', { clockJump: null });
    try { window.dispatchEvent(new CustomEvent('nekotool:clock-jump')); } catch (_) {}
}

/** 清掉旧版本留下的「世界时钟」条目和自动扫描的旧名册 */
async function cleanupLegacyEntries(bookName) {
    try {
        const book = await stBridge.loadWorldInfoAsync(bookName, true);
        if (!book || !book.entries) return;
        const entries = Object.values(book.entries);
        if (entries.some(e => e && e.comment === '世界时钟')) {
            await stBridge.removeEntryByComment(bookName, '世界时钟');
            console.log('[worldsim] 已移除旧版「世界时钟」条目');
        }
        const roster = entries.find(e => e && e.comment === '角色索引');
        if (roster && /^【(世界角色名册|当前已追踪角色名册)】/.test(String(roster.content || '').trim())) {
            await stBridge.removeEntryByComment(bookName, '角色索引');
            console.log('[worldsim] 已清空旧版自动扫描的「角色索引」');
        }
    } catch (e) {
        console.warn('[worldsim] 清理旧条目失败', e);
    }
}

/** 固定条目布局：位置一律「角色定义之前」，order 决定先后 */
const ENTRY_LAYOUT = {
    '世界局势': { order: 800, constant: true, keyword: false },
    '主线': { order: 810, constant: true, keyword: false },
    '支线': { order: 812, constant: true, keyword: false },
    '地图': { order: 830, constant: true, keyword: false },
    '索引': { order: 850, constant: true, keyword: false },
    '道具': { order: 900, constant: false, keyword: true },
    '计划': { order: 910, constant: true, keyword: false },
    '伏笔': { order: 920, constant: false, keyword: true },
    '剧情推演': { order: 999, constant: true, keyword: false },
};

/** 旧档迁移：把条目挪到「角色定义之前」，道具/伏笔转绿灯，补区块标题 */
async function normalizeEntryLayout(bookName) {
    try {
        const book = await stBridge.loadWorldInfoAsync(bookName, true);
        if (!book || !book.entries) return;
        let changed = false;

        for (const entry of Object.values(book.entries)) {
            if (!entry || !entry.comment) continue;
            const c = entry.comment;
            let layout = ENTRY_LAYOUT[c];
            let isChar = false;
            if (!layout && c.startsWith('角色·')) {
                layout = { order: 860, constant: false, keyword: true };
                isChar = true;
            }
            if (!layout) continue;

            if (entry.position !== 0) { entry.position = 0; changed = true; }
            if (entry.depth !== 0) { entry.depth = 0; changed = true; }
            if (entry.order !== layout.order) { entry.order = layout.order; changed = true; }
            if (entry.constant !== layout.constant) {
                entry.constant = layout.constant;
                entry.selective = !layout.constant;
                changed = true;
            }
            if (entry.selective !== !layout.constant) {
                entry.selective = !layout.constant;
                changed = true;
            }

            const keys = layout.keyword
                ? (isChar ? [c.slice(3)] : deriveKeys(readAggregate(entry.content), c))
                : [];
            if (JSON.stringify(entry.key || []) !== JSON.stringify(keys)) {
                entry.key = keys;
                changed = true;
            }
            if (layout.constant && Array.isArray(entry.key) && entry.key.length) {
                entry.key = [];
                changed = true;
            }

            // 旧的角色档案（- 字段：值）升级成 YAML；认不出字段的不动，避免误删内容
            if (isChar) {
                const parsed = parseCharacterYaml(entry.content);
                let charChanged = false;
                if (Object.keys(parsed).length && !parsed.姓名) {
                    parsed.姓名 = c.slice(3);
                    charChanged = true;
                }
                if (charChanged) {
                    entry.content = formatCharacterYaml(c.slice(3), parsed);
                    changed = true;
                }
            }

            if (!isChar && entry.comment !== INDEX_TITLE && entry.comment !== '世界配置') {
                const content = String(entry.content || '');
                if (!content.startsWith('【以下为')) {
                    entry.content = `【以下为${c}】\n${content}`;
                    changed = true;
                }
            }
        }

        if (changed) {
            await stBridge.persistLorebook(bookName, book);
            console.log('[worldsim] 条目布局已归位/转绿灯:', bookName);
        }
        markWorldReady(bookName, book);
        markMapReady(bookName, book);
        markQuestReady(bookName, book);
    } catch (e) {
        console.warn('[worldsim] 条目布局迁移失败', e);
    }
}

/** 角色索引的默认契约（可在设置里整段改写）；让模型自己增删，插件只负责收 */
function buildRosterPrompt(bookName = '') {
    const tagOpen = '<nekotools:track.roster>';
    const tagClose = '</nekotools:track.roster>';
    let p = `${tagOpen}
【角色索引】JSON 字段 "roster": {"add": {"角色名": "等级｜位置｜最近行动"}, "del": ["角色名"]}
要求：等级只写 T1/T2/T3/T4；位置必须写「地图」里的小地点名，不要写 T1核心、核心成员、身份这类东西；最近行动写具体动作。
- 等级：T1 核心 / T2 重要 / T3 配角 / T4 背景
- 位置：现在在哪
- 最近行动：最近在做什么（一句话，别写成长篇）
要求：新角色出场就 add；有变化就重新 add（整条覆盖）；角色死亡、离场、确定不再相关就 del。没有变化就写 "roster": {}。
不要写玩家/user，不要把地名、设定标题当角色。更新时间由插件自动补，不要自己写层号。
${tagClose}`;

    const cfg = getCachedConfig(bookName);
    if (cfg.pinned.length) {
        p += `\n【常驻关注】以下角色必须留在索引里，即使本轮没出场也不要删：\n${cfg.pinned.join('、')}`;
    }
    if (cfg.blocked.length) {
        p += `\n【不记录】以下角色不要写进索引：\n${cfg.blocked.join('、')}`;
    }
    const custom = (settings.customPrompts.roster || '').trim();
    if (custom) p += `\n【附加要求】\n${custom}`;
    return p;
}

/**
 * 「请求更新」按钮的写回入口：只处理静默生成返回的 JSON。
 * 普通回合仍走 onResponse，不经过这里。
 */
export async function applyRefreshData(bookName, data, layer = 0) {
    const summary = { chars: 0, world: 0, map: 0, main: 0, quests: 0, items: 0, foreshadow: 0, plot: 0 };
    if (!bookName || !data || typeof data !== 'object') return summary;
    const book = await stBridge.loadWorldInfoAsync(bookName);
    if (!book || !book.entries) return summary;
    const touched = [];
    const userCharName = stBridge.getUserName();

    const chars = data.chars && typeof data.chars === 'object' && !Array.isArray(data.chars) ? data.chars : null;
    const ticks = data.tick && typeof data.tick === 'object' && !Array.isArray(data.tick) ? data.tick : null;
    for (const source of [chars, ticks]) {
        if (!source) continue;
        for (const [name, info] of Object.entries(source)) {
            const n = String(name || '').trim();
            if (!n || !info || typeof info !== 'object') continue;
            if (!settings.recordUserCharacter && userCharName && n === userCharName) continue;
            await updateCharacterEntry(bookName, n, info, book, layer);
            touched.push({ name: n, info });
        }
    }
    for (const { name, info } of touched) {
        const patch = { layer };
        if (info['位置']) patch.location = String(info['位置']).trim();
        if (info['当前行动']) patch.action = String(info['当前行动']).trim();
        await refreshChar(bookName, name, patch);
    }
    summary.chars = touched.length;

    if (data.world) {
        const world = await applyWorldUpdate(bookName, data.world);
        summary.world = world
            ? Object.keys(world.国家 || {}).length + Object.keys(world.势力 || {}).length + Object.keys(world.社会新闻 || {}).length
            : 0;
    }
    if (data.map) {
        const map = await applyMapOps(bookName, data.map);
        summary.map = map ? Object.keys(map.sites || {}).length : 0;
    }
    if (data.main) {
        const main = await applyMain(bookName, data.main);
        summary.main = main ? 1 : 0;
        if (main) {
            rememberMainProgress(bookName, main);
            questReady.set(bookName, mainHasContent(main));
        }
    }
    if (data.quests) {
        const quests = await applyQuests(bookName, data.quests);
        summary.quests = quests ? Object.keys(quests).length : 0;
    }
    if (data.items) {
        const map = await applyAggregateOps(bookName, '道具', data.items, 900, { keyword: true });
        if (map) {
            await syncNames(bookName, 'items', Object.keys(map));
            summary.items = Object.keys(map).length;
        }
    }
    if (data.foreshadow) {
        const map = await applyAggregateOps(bookName, '伏笔', data.foreshadow, 920, { keyword: true });
        if (map) {
            await syncNames(bookName, 'foreshadows', Object.keys(map));
            summary.foreshadow = Object.keys(map).length;
        }
    }
    if (data.plot) {
        const map = await applyAggregateOps(bookName, '计划', data.plot, 910);
        summary.plot = map ? Object.keys(map).length : 0;
    }
    return summary;
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

        // 角色可能比扩展晚就绪：带重试地确保追踪书存在并挂到全局
        const tryEnsure = async (attempt) => {
            if (!settings.enabled) return;
            const name = getLorebookName();
            if (!name) {
                if (attempt < 10) setTimeout(() => tryEnsure(attempt + 1), 3000);
                return;
            }
            try {
                // 先清掉「激活列表有、文件没有」的幽灵书，避免 ST 每轮报错
                await stBridge.cleanupGhostActiveBooks();
                if (lastChatId === null) lastChatId = stBridge.getContext().chatId ?? null;
                const book = await stBridge.ensureWorldbook(name);
                console.log(`[worldsim] 追踪书检查 #${attempt}:`, name, book ? 'OK' : 'FAILED');
                if (book) {
                    // 清掉旧版本留在书里的「世界时钟」和自动扫描名册；合并混合索引；条目布局归位
                    await cleanupLegacyEntries(name);
                    await loadConfig(name);
                    await migrateWorld(name);
                    await migrateIndex(name);
                    await migrateMap(name);
                    await normalizeEntryLayout(name);
                    await stBridge.deactivateStaleAutoBooks(name);
                    await stBridge.preloadActivatedLorebooks();
                } else if (attempt < 10) {
                    setTimeout(() => tryEnsure(attempt + 1), 3000);
                }
            } catch (e) {
                console.warn('[worldsim] 初始化世界书失败', e);
            }
        };
        setTimeout(() => tryEnsure(1), 1200);

        // 换角色/换会话时，追踪库要跟着换，并保证它处于全局激活状态
        const ctx = stBridge.getContext();

        // 切档/新建档后重新载入世界配置（白名单/黑名单）
        window.addEventListener('nekotool:slots-changed', () => {
            const name = getLorebookName();
            if (!name) return;
            loadConfig(name, { force: true }).catch(e => console.warn('[worldsim] 世界配置加载失败', e));
            normalizeEntryLayout(name).catch(e => console.warn('[worldsim] 条目布局迁移失败', e));
        });

        if (ctx.eventSource && ctx.eventTypes?.CHAT_CHANGED) {
            ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, () => {
                lastAppliedUpdate = null;
                setTimeout(async () => {
                    try {
                        if (!settings.enabled) return;
                        const name = getLorebookName();
                        if (!name) return;
                        const book = await stBridge.ensureWorldbook(name);
                        // 换会话：清掉上一段会话留下的剧情推演条目，避免污染新对话（同一角色卡也可能开新聊天）
                        const chatId = stBridge.getContext().chatId;
                        if (book && lastChatId !== null && chatId !== lastChatId) {
                            await stBridge.removeEntryByComment(name, '剧情推演');
                        }
                        lastChatId = chatId;
                        await stBridge.deactivateStaleAutoBooks(name);
                        await loadConfig(name);
                        await cleanupLegacyEntries(name);
                        await migrateWorld(name);
                        await migrateIndex(name);
                        await migrateMap(name);
                        await normalizeEntryLayout(name);
                    } catch (e) {
                        console.warn('[worldsim] 切换会话同步世界书失败', e);
                    }
                }, 800);
            });
        }

        // 重 roll：上一次回复作废，先回滚世界书再应用新的
        if (ctx.eventSource && ctx.eventTypes?.GENERATION_STARTED) {
            ctx.eventSource.on(ctx.eventTypes.GENERATION_STARTED, (type) => {
                const t = typeof type === 'string' ? type : (type && type.type);
                if (t === 'regenerate' || t === 'swipe') {
                    restoreLastApplied('重新生成');
                }
            });
        }

        // 删除最后一条 AI 消息：同样回滚它带来的更新
        if (ctx.eventSource && ctx.eventTypes?.MESSAGE_DELETED) {
            ctx.eventSource.on(ctx.eventTypes.MESSAGE_DELETED, (id) => {
                if (lastAppliedUpdate && Number(id) === lastAppliedUpdate.mesId) {
                    restoreLastApplied('消息被删除');
                }
            });
        }
    },

    onRequest(ctx) {
        loadSettings();
        if (!settings.enabled) return;

        // 轮数直接从聊天记录里数，不写任何本地存储
        const chat = ctx.chat || [];
        const aiCount = chat.filter(m => m && !m.is_user && !m.is_system).length;

        let needBig = false;
        const bigLimit = Number(settings.bigSummaryLimit) || 0;
        if (settings.enableBigSummary && bigLimit > 0 && aiCount > 0 && aiCount % bigLimit === 0) {
            needBig = true;
        }
        ctx.__ntNeedBig = needBig;

        // 追踪书确实存在才注入追踪契约；被删掉时不复活、也不让模型空写
        const bookName = getLorebookName();
        // 记下本轮用的是哪一档：生成期间用户切档时，结算仍写回发起时那一档
        ctx.__nt_bookName = bookName;
        // 本轮回复将落在第几层（1 基）。onResponse 时 chat 可能还没算上这条回复
        ctx.__nt_replyLayer = chat.length + 1;
        const includeTracking = Boolean(bookName) && stBridge.getWorldNames().includes(bookName);
        ctx.__nt_includeTracking = includeTracking;
        if (!includeTracking) {
            console.warn('[worldsim] 追踪书不存在，本轮只注入世界规则与状态栏，跳过追踪契约:', bookName || '(无角色)');
        }

        // 开局世界生成：世界局势还没内容时，前几轮自动补全整个世界
        const tries = genesisTries.get(bookName) || 0;
        const needGenesis = includeTracking && settings.enableWorld && !worldReady.get(bookName) && tries < 5;
        if (needGenesis) {
            genesisTries.set(bookName, tries + 1);
            console.log(`[worldsim] 注入开局世界生成（第 ${tries + 1} 次）`);
        }

        // 开局地图生成：地图还没足够地点时补全
        const mapTriesNow = mapTries.get(bookName) || 0;
        const needMapGenesis = includeTracking && settings.enableMap && !mapReady.get(bookName) && mapTriesNow < 5;
        if (needMapGenesis) {
            mapTries.set(bookName, mapTriesNow + 1);
            console.log(`[worldsim] 注入开局地图生成（第 ${mapTriesNow + 1} 次）`);
        }

        // 开局主线/支线生成
        const questTriesNow = questTries.get(bookName) || 0;
        const needQuestGenesis = includeTracking && settings.enableQuests && !questReady.get(bookName) && questTriesNow < 5;
        if (needQuestGenesis) {
            questTries.set(bookName, questTriesNow + 1);
            console.log(`[worldsim] 注入开局主线生成（第 ${questTriesNow + 1} 次）`);
        }
        ctx.__nt_includeTracking = includeTracking;

        for (const msg of buildSystemMessages(needBig, includeTracking, bookName, needGenesis, needMapGenesis, needQuestGenesis)) {
            ctx.__nt_pendingSystems.push(msg);
        }

        // 后台 tick：角色/世界按设置的频率轮值
        const charEvery = Number(settings.charTickEvery) || 0;
        const worldEvery = Number(settings.worldTickEvery) || 0;
        const needCharTick = settings.enableTicks && charEvery > 0 && aiCount > 0 && aiCount % charEvery === 0;
        const needWorldTick = settings.enableTicks && worldEvery > 0 && aiCount > 0 && aiCount % worldEvery === 0;
        if (needCharTick || needWorldTick) {
            ctx.__nt_pendingSystems.push({
                role: 'system',
                content: buildTickPrompt({ needCharTick, needWorldTick }),
            });
            console.log(`[worldsim] 后台 tick：角色=${needCharTick} 世界=${needWorldTick}`);
        } else if (settings.enableTicks && includeTracking && !needGenesis) {
            // 非全量 tick 的轮次也要提醒 T1，否则 T1 做不到每轮
            ctx.__nt_pendingSystems.push({ role: 'system', content: buildT1Prompt() });
        }
    },

    async onResponse({ captured }) {
        loadSettings();
        if (!settings.enabled) return;

        // 快速重 roll 时排队等待上一次结算写完，而不是直接丢弃本轮内容
        const waitStart = Date.now();
        while (this._settling && Date.now() - waitStart < 8000) {
            await new Promise(r => setTimeout(r, 120));
        }
        if (this._settling) {
            console.warn('[worldsim] 上一次结算超过 8 秒仍未完成，本次跳过');
            return;
        }
        this._settling = true;
        try {

        // 用 onRequest 时记下的那一档，避免生成期间切档把结算写进新档
        const ctx = stBridge.getContext();
        const currentLorebook = ctx.__nt_bookName || getLorebookName();
        if (!currentLorebook) return;
        const replyLayer = Number(ctx.__nt_replyLayer) || (Array.isArray(ctx.chat) ? ctx.chat.length : 0);
        const wasTracking = ctx.__nt_includeTracking === true;
        delete ctx.__nt_bookName;
        delete ctx.__nt_replyLayer;
        delete ctx.__nt_includeTracking;

        // 先收拾模型漏到正文的标签/推演块
        sanitizeLastMessage();

        // 存在性只认 /list：/get 对不存在的书会返回假书 {entries:{}}
        if (!(await stBridge.bookExists(currentLorebook))) {
            console.warn('[worldsim] 追踪书不存在（可能已被删除），本次不写入:', currentLorebook);
            // 顺手把幽灵全局激活关掉，免得酒馆每轮报 does not exist
            if (stBridge.isGloballyActivated(currentLorebook)) {
                await stBridge.mountGlobalWorldbook(currentLorebook, false);
            }
            return;
        }

        // 强制从磁盘读，避免书被删后仍从旧缓存写回去（导致「已删除的追踪书复活」）
        let book = await stBridge.loadWorldInfoAsync(currentLorebook, true);
        if (!book || !book.entries) {
            console.warn('[worldsim] 追踪书读取失败，本次不写入:', currentLorebook);
            return;
        }
        if (!stBridge.isGloballyActivated(currentLorebook)) {
            await stBridge.mountGlobalWorldbook(currentLorebook, true);
        }

        // 本轮所有写入先进内存，结束时一次落盘
        stBridge.beginBatch(currentLorebook, book);

        // 迁移：旧版按对象拆分的条目清掉，统一改成「道具/计划/伏笔」单条目
        await stBridge.pruneLegacySplitEntries(currentLorebook);

        // 应用前存一份快照，供重 roll / 删消息时回滚
        lastAppliedUpdate = {
            chatId: stBridge.getContext().chatId ?? null,
            mesId: (stBridge.getContext().chat || []).length - 1,
            bookName: currentLorebook,
            pre: cloneBook(book),
            clockBefore: getSlotClock(currentLorebook),
            at: Date.now(),
        };

        // 状态栏 → 时钟（只存设置，供 TOOL 菜单显示和跳跃检测）
        const clockNow = (await applyClock(currentLorebook, captured, replyLayer)) || getSlotClock(currentLorebook);
        // 地图「当前」行每轮同步
        if (settings.enableMap && clockNow && (clockNow.place || clockNow.time)) {
            await setCurrent(currentLorebook, clockNow, replyLayer);
        }

        if (captured.ws_big_summary && settings.enableBigSummary) {
            await stBridge.updateEntry(currentLorebook, '大总结', captured.ws_big_summary.trim(), true, [], {
                position: 4, depth: 9999, order: 9999, role: 2, insertion_order: 9999
            });
            book = await stBridge.loadWorldInfoAsync(currentLorebook);
            for (const entry of Object.values(book?.entries || {})) {
                if (entry.comment === '小总结') entry.content = '（已浓缩入大总结）';
            }
            await stBridge.persistLorebook(currentLorebook, book);
        }

        if (captured.ws_summary && settings.enableSummary && !captured.ws_big_summary) {
            book = await stBridge.loadWorldInfoAsync(currentLorebook);
            let currentSum = '';
            const entry = Object.values(book?.entries || {}).find(e => e.comment === '小总结');
            if (entry && entry.content !== '（已浓缩入大总结）') currentSum = entry.content + '\n';
            await stBridge.updateEntry(currentLorebook, '小总结', currentSum + captured.ws_summary.trim(), true, [], {
                position: 4, depth: 999, order: 999, role: 2, insertion_order: 999
            });
        }

        if (captured.ws_preview && settings.enablePreview) {
            let text = captured.ws_preview.trim();
            if (text.length > 50000) text = text.slice(-30000);
            // 剧情推演写进追踪书（常驻条目），由酒馆在下一轮自动注入；
            // 不落本地缓存，避免旧推演污染新对话/别的角色。
            await stBridge.updateEntry(currentLorebook, '剧情推演', text, true, [], {
                position: 0, depth: 0, order: 999
            });
        }

        if (wasTracking && !captured.ws_update) {
            console.warn('[worldsim] 模型没有输出 ws_update，本轮追踪未写入:', currentLorebook);
        }

        if (captured.ws_update && typeof captured.ws_update === 'string') {
            try {                const s = captured.ws_update.replace(/```json/g, '').replace(/```/g, '').trim();
                const start = s.indexOf('{');
                const end = s.lastIndexOf('}');
                if (start === -1 || end === -1) throw new Error('no json brackets');
                const data = JSON.parse(s.slice(start, end + 1));

                const cfgNow = getCachedConfig(currentLorebook);
                const blockedNow = new Set(cfgNow.blocked);
                const pinnedNow = new Set(cfgNow.pinned);

                const charsBook = await stBridge.loadWorldInfoAsync(currentLorebook);
                const touchedChars = [];
                const userCharName = stBridge.getUserName();

                if (data.chars && settings.enableChars) {
                    const focusArr = (settings.focusChars || '').split(/[,，\s]+/).map(n => n.trim()).filter(Boolean);
                    const allow = focusArr.length ? new Set([...focusArr, ...pinnedNow]) : null;
                    for (const [name, info] of Object.entries(data.chars)) {
                        const n = String(name).trim();
                        if (!n || blockedNow.has(n)) continue;
                        if (!settings.recordUserCharacter && userCharName && n === userCharName) continue;
                        if (allow && !allow.has(n)) continue;
                        await updateCharacterEntry(currentLorebook, n, info, charsBook, replyLayer);
                        touchedChars.push({ name: n, info });
                    }
                }

                // 后台 tick：模型写的离屏角色，合并进角色档案
                if (data.tick && typeof data.tick === 'object' && !Array.isArray(data.tick)) {
                    for (const [name, info] of Object.entries(data.tick)) {
                        const n = String(name).trim();
                        if (!n || blockedNow.has(n) || !info || typeof info !== 'object') continue;
                        if (!settings.recordUserCharacter && userCharName && n === userCharName) continue;
                        await updateCharacterEntry(currentLorebook, n, info, charsBook, replyLayer);
                        touchedChars.push({ name: n, info });
                    }
                }

                // 刷新索引里这些角色的位置/行动/更新时间
                for (const { name, info } of touchedChars) {
                    const patch = { layer: replyLayer };
                    if (info['位置']) patch.location = String(info['位置']).trim();
                    if (info['当前行动']) patch.action = String(info['当前行动']).trim();
                    await refreshChar(currentLorebook, name, patch);
                }
                if (data.roster) {
                    // 索引由模型自己增删；插件补更新时间、过滤黑名单、保护钉住的人
                    const raw = (data.roster && typeof data.roster === 'object') ? data.roster : {};
                    const source = (raw.add && typeof raw.add === 'object') || Array.isArray(raw.del)
                        ? raw
                        : { add: raw, del: [] };
                    const add = {};
                    for (const [name, value] of Object.entries(source.add || {})) {
                        const n = String(name || '').trim();
                        if (!n || blockedNow.has(n)) continue;
                        if (!settings.recordUserCharacter && userCharName && n === userCharName) continue;
                        const base = fixRosterValue(stripRosterLayer(String(value ?? ''))) || 'T3';
                        add[n] = `${base}｜第 ${replyLayer} 层`;
                    }
                    // 黑名单允许 del（把旧行删掉）；钉住的保护，不让模型删
                    const del = Array.isArray(source.del)
                        ? source.del.map(String).filter(n => !pinnedNow.has(n))
                        : [];
                    if (Object.keys(add).length || del.length) {
                        // 角色详情走绿灯，常驻索引只存名字行
                        await syncChars(currentLorebook, add, del);
                    }
                }
                if (data.items && settings.enableItems) {
                    const itemMap = await applyAggregateOps(currentLorebook, '道具', data.items, 900, { keyword: true });
                    if (itemMap) await syncNames(currentLorebook, 'items', Object.keys(itemMap));
                }
                if (data.plot && settings.enablePlot) {
                    await applyAggregateOps(currentLorebook, '计划', data.plot, 910);
                }
                if (data.world && settings.enableWorld) {
                    const worldData = await applyWorldUpdate(currentLorebook, data.world);
                    if (worldData) {
                        const ready = worldHasStructure(worldData);
                        worldReady.set(currentLorebook, ready);
                        if (ready) genesisTries.delete(currentLorebook);
                    }
                }
                if (data.map && settings.enableMap) {
                    const mapData = await applyMapOps(currentLorebook, data.map);
                    if (mapData) mapReady.set(currentLorebook, mapHasStructure(mapData));
                }
                if (data.main && settings.enableQuests) {
                    const mainData = await applyMain(currentLorebook, data.main);
                    if (mainData) {
                        const ready = mainHasContent(mainData);
                        questReady.set(currentLorebook, ready);
                        rememberMainProgress(currentLorebook, mainData);
                        if (ready) questTries.delete(currentLorebook);
                    }
                }
                if (data.quests && settings.enableQuests) {
                    await applyQuests(currentLorebook, data.quests);
                }
                if (data.foreshadow && settings.enableForeshadow) {
                    const foreMap = await applyAggregateOps(currentLorebook, '伏笔', data.foreshadow, 920, { keyword: true });
                    if (foreMap) await syncNames(currentLorebook, 'foreshadows', Object.keys(foreMap));
                }
            } catch (e) {
                console.warn('[worldsim] JSON 解析失败', e, captured.ws_update);
            }
        }

        setTimeout(() => { stBridge.hideOldMessages(settings.hideKeepCount, settings.visualHideKeep); }, 1000);
        // 记录这一档最后游玩时间/层数，存档列表用
        touchSlot(currentLorebook);
        } finally {
            // 一轮结束统一落盘（只写一次）
            await stBridge.commitBatch();
            this._settling = false;
        }
    },

    /** 诊断：列出本轮实际会注入的东西（世界书条目 + 契约提示词） */
    async getInjectionPreview() {
        loadSettings();
        const lines = [];
        const bookName = getLorebookName();
        lines.push(`追踪书：${bookName || '(未选中角色)'}`);
        if (!bookName) return lines.join('\n');

        const exists = await stBridge.bookExists(bookName);
        const active = stBridge.isGloballyActivated(bookName);
        lines.push(`文件存在：${exists ? '是' : '否'}｜全局激活：${active ? '是' : '否'}`);

        if (exists) {
            const book = await stBridge.loadWorldInfoAsync(bookName);
            const entries = Object.values(book?.entries || {});
            let chars = 0;
            lines.push(`条目数：${entries.length}`);
            for (const e of entries) {
                const kind = e.disable ? '停用' : (e.constant ? '常驻' : '关键词');
                const len = (e.content || '').length;
                chars += len;
                const head = (e.content || '').replace(/\s+/g, ' ').slice(0, 36);
                lines.push(`· [${kind}] ${e.comment || '(无标题)'} — ${len} 字 — ${head}`);
            }
            lines.push(`条目正文合计：${chars} 字（约 ${Math.round(chars / 1.6)} tokens）`);
        }

        const systems = buildSystemMessages(false, exists, bookName);
        let sysChars = 0;
        lines.push(`\n注入契约：${systems.length} 段`);
        for (const s of systems) {
            const c = s.content || '';
            sysChars += c.length;
            const first = (c.split('\n')[0] || '').slice(0, 28);
            lines.push(`· ${first} — ${c.length} 字`);
        }
        lines.push(`契约合计：${sysChars} 字（约 ${Math.round(sysChars / 1.6)} tokens）`);
        return lines.join('\n');
    }
});
