import { registry } from '../core/registry.js';
import { settings } from '../core/settings.js';
import { stBridge } from '../core/st_bridge.js';
import { getSlotClock } from '../core/slots.js';

const TITLE = '世界灾变';
const TAG = 'ws_disaster';
const STAGES = ['爆发期', '扩散期', '恶化期', '长期化', '灾后'];

const TEMPLATES = {
    extreme_cold: {
        name: '极寒末日',
        rules: '气温持续下降，取暖消耗翻倍，夜间外出会冻伤，道路容易被积雪封死。',
        environment: '寒潮从北境向南推进，供暖和电网开始崩溃，城镇抢购燃料。',
        survival: '燃料、食物、保暖、据点防御',
        stages: '爆发：气温骤降，供暖崩溃；扩散：雪线南移，难民上路；恶化：长夜与冻土，补给线断裂；长期化：世界进入长冬；灾后：气温缓慢回升。',
    },
    zombie: {
        name: '丧尸爆发',
        rules: '被咬伤会感染，死亡后可能转化；噪音会吸引尸群，伤口和血液有风险。',
        environment: '感染从城市边缘扩散，军队失去秩序，幸存者开始封锁街区。',
        survival: '防御、净水、食物、安静、感染隔离',
        stages: '爆发：感染扩散，秩序崩溃；扩散：尸群移动，据点封锁；恶化：围城与断供；长期化：残存者建立隔离区；灾后：清理与重建。',
    },
    flood: {
        name: '大洪水',
        rules: '低地会被淹没，水流会冲毁道路和地基，饮水容易被污染。',
        environment: '连日暴雨，河堤决口，低地被淹，幸存者向高处转移。',
        survival: '高地、船、净水、食物、地基',
        stages: '爆发：暴雨与决口；扩散：城市被淹，交通中断；恶化：孤岛与疫病；长期化：退水后的沼泽；灾后：清淤与重建。',
    },
    gray_tide: {
        name: '灰潮',
        rules: '灰雾会污染呼吸和皮肤，长时间暴露会异变；净化设备和面具决定生死。',
        environment: '灰色雾潮从地下裂隙涌出，旧城区首先失守，净化物资被抢空。',
        survival: '面具、净化、隔离、药品、通风',
        stages: '爆发：灰雾涌出；扩散：城区被污染；恶化：净化物资耗尽；长期化：隔离区与新秩序；灾后：净化与封堵。',
    },
};

function nowText() {
    try {
        return getSlotClock(stBridge.currentTrackerName())?.time || '当前';
    } catch (_) {
        return '当前';
    }
}

function formatRecord(template, date = nowText()) {
    return `【世界灾变】
状态：进行中
名称：${template.name}
阶段：爆发期
开始：${date}
世界规则：${template.rules}
当前环境：${template.environment}
生存重点：${template.survival}
阶段背景：${template.stages}
阶段记录：
- ${date} 爆发期：${template.environment}`;
}

function parseFields(text) {
    const out = {};
    for (const line of String(text || '').split('\n')) {
        const m = line.match(/^([^：:]{1,12})[：:]\s*(.*)$/);
        if (m) out[m[1].trim()] = m[2].trim();
    }
    return out;
}

export function disasterTemplates() {
    return Object.entries(TEMPLATES).map(([id, t]) => ({ id, ...t }));
}

export async function startDisaster(templateId, custom = null) {
    const book = stBridge.currentTrackerName();
    if (!book) return false;
    const template = custom || TEMPLATES[templateId];
    if (!template) return false;
    await stBridge.updateEntry(book, TITLE, formatRecord(template), true, [], {
        position: 0, depth: 0, order: 816,
    });
    return true;
}

export async function endDisaster() {
    const book = stBridge.currentTrackerName();
    if (!book) return false;
    const data = await stBridge.loadWorldInfoAsync(book, true);
    const entry = Object.values(data?.entries || {}).find(e => e && e.comment === TITLE);
    if (!entry) return false;
    const date = nowText();
    const content = String(entry.content || '')
        .replace(/^状态：.*$/m, '状态：已结束')
        .replace(/^阶段：.*$/m, '阶段：灾后')
        + `\n结束：${date}\n- ${date} 灾后：天灾结束，进入灾后状态。`;
    await stBridge.updateEntry(book, TITLE, content, true, [], {
        position: 0, depth: 0, order: 816,
    });
    return true;
}

export async function readDisaster() {
    const book = stBridge.currentTrackerName();
    if (!book) return null;
    const data = await stBridge.loadWorldInfoAsync(book, true);
    const entry = Object.values(data?.entries || {}).find(e => e && e.comment === TITLE);
    if (!entry) return null;
    return { content: String(entry.content || ''), fields: parseFields(entry.content) };
}

function disasterPrompt() {
    return `<nekotools:disaster>
【世界灾变】
如果世界书里存在「世界灾变」且状态不是已结束：
- 这是长期背景，不要为了戏剧性快速推进阶段。
- 阶段顺序固定：爆发期 → 扩散期 → 恶化期 → 长期化 → 灾后。
- 只有玩家行动、重大事件或环境积累足以改变阶段时，才更新阶段，并写清原因。
- 玩家在剧情中明确解决或结束天灾时，可以进入「灾后」，并在阶段记录写原因。
- 阶段只能向前，不能倒退；没有足够理由就保持当前阶段。
- 只写受天灾影响的部分，不要每段重复天气或灾难场面。
- 用 <${TAG}>阶段：...；当前环境：...；生存重点：...；阶段记录：...；</${TAG}> 输出变化；没有变化就不输出。
</nekotools:disaster>`;
}

function applyDisasterUpdate(content, raw) {
    const fields = parseFields(raw);
    const nextStage = String(fields['阶段'] || '').trim();
    const oldFields = parseFields(content);
    const oldIdx = STAGES.indexOf(oldFields['阶段']);
    const nextIdx = STAGES.indexOf(nextStage);
    if (!nextStage || nextIdx < 0 || (oldIdx >= 0 && nextIdx < oldIdx)) return content;
    const next = String(content || '')
        .replace(/^阶段：.*$/m, `阶段：${nextStage}`)
        .replace(/^当前环境：.*$/m, fields['当前环境'] ? `当前环境：${fields['当前环境']}` : '$&')
        .replace(/^生存重点：.*$/m, fields['生存重点'] ? `生存重点：${fields['生存重点']}` : '$&');
    const ended = nextStage === '灾后' ? next.replace(/^状态：.*$/m, '状态：已结束') : next;
    const line = String(fields['阶段记录'] || '').trim();
    if (line) {
        const logs = line.startsWith('-') ? line : `- ${line}`;
        return `${ended}\n${logs}`;
    }
    return ended;
}

registry.register({
    id: 'worldstate',
    name: '世界状态',
    enabled: true,
    order: 55,
    tags: [TAG],
    onRequest(ctx) {
        const cfg = settings.get('worldstate') || {};
        if (cfg.enabled === false) return;
        if (Array.isArray(ctx.__nt_pendingSystems)) {
            ctx.__nt_pendingSystems.push({ role: 'system', content: disasterPrompt() });
        }
    },
    async onResponse({ captured }) {
        const raw = captured?.[TAG];
        if (!raw) return;
        const book = stBridge.currentTrackerName();
        if (!book) return;
        const data = await stBridge.loadWorldInfoAsync(book, true);
        const entry = Object.values(data?.entries || {}).find(e => e && e.comment === TITLE);
        if (!entry) return;
        const content = applyDisasterUpdate(entry.content, raw);
        if (content === entry.content) return;
        await stBridge.updateEntry(book, TITLE, content, true, [], {
            position: 0, depth: 0, order: 816,
        });
    },
});
