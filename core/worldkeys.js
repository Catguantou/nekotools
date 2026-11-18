// 绿灯关键词：只生成短词，避免把整句标题写进世界书 key。
// 规则刻意保守：2–6 字、去重、限量、过滤分类名。

const STOP_WORDS = new Set([
    '国家', '势力', '社会新闻', '新闻', '事件', '影响', '来源',
    '计划', '伏笔', '道具', '支线', '主线', '地图', '索引',
    '当前', '地点', '未知', '暂无', '以下', '内容', '描述',
    '进行中', '目标', '状态', '进度', '执行者', '持有者', '作用', '来源',
]);

const ENTITY_SUFFIX = /([\u4e00-\u9fa5]{1,5}(?:区|城|镇|街|港|州|国|山|河|湖|海|盟|府|宫|门|塔|会|党|军|团|教|公司|商会|码头|监狱|车站|市场|广场|医院|学院|森林|荒原|冻土|王国|王都))/g;

const BAD_PREFIX = /^(居民|市民|百姓|人们|众人|有人|洽谈|谈判|封锁|连夜|已经|正在|开始|继续|发生|出现|造成|导致|引发|抵达|抵京|使节|盟约|使团|商队)/;
const ABSTRACT_NAME = /(疑云|寻踪|谜团|秘影|暗流|回响|序曲|终章|秘闻|传说|风云|往事|余波|征兆|真相|阴谋|计划|序章|终局)/;

// 关键词判定：从「逐字子串」改成按词/位置判断，避免把「王都」「和平」「有间客栈」这类真专名误杀。
// 多字虚词/代词短语：整词出现即拒
const KEY_STOP_RX = /(它们|什么|怎么|为什么|已经|正在|将要|可以|应该|可能|默认|觉得|认为|知道|看到|听到|因为|所以|如果|需要|开始|继续|然后|同时)/;
// 以虚词/介词/指示词/代词/动词开头的不是专名（「去酒馆」「来酒馆」「往北走」「她会知道」）
const KEY_BAD_START_RX = /^(在|是|把|给|从|到|就|才|再|还|又|很|太|更|最|也|只|想|让|说|问|这|那|哪|谁|但|而|她|他|我|你|您|它|去|来|回|往|进|出)/;
// 句子碎片里的常见虚词：单个可以出现在「和平/要塞/议会/商会/有间客栈」这类真专名里，
// 出现 2 个及以上就基本是句子碎片（如「与商会谈判」「能救下商会吗」「会来」「要去王都」）。
const KEY_STOP_CHARS_ALL = /[和与或能会要有了着过吗呢吧并及去来救谈说问想让被把给从到在是就才再还又很太更最也只这那哪谁]/g;

function stopCharCount(key) {
    const m = String(key).match(KEY_STOP_CHARS_ALL);
    return m ? m.length : 0;
}

export function isValidKey(value) {
    const key = String(value || '').trim();
    if (key.length < 2 || key.length > 6) return false;
    if (STOP_WORDS.has(key)) return false;
    if (ABSTRACT_NAME.test(key)) return false;
    if (KEY_STOP_RX.test(key)) return false;
    if (KEY_BAD_START_RX.test(key)) return false;
    // 「被」出现在词中是「属匣被开阳府」这类被动句碎片；开头的「被遗忘者」这类专名放行
    if (key.indexOf('被') > 0) return false;
    if (stopCharCount(key) >= 2) return false;
    if (/(家门|家人|时候|之后|之前|上面|下面|里面|外面|后面|前面)$/.test(key)) return false;
    return true;
}

export function isAbstractName(name) {
    return ABSTRACT_NAME.test(String(name || ''));
}

function clean(text) {
    return String(text || '')
        .replace(/^[\s\-*•·]+/, '')
        .replace(/[（(][^）)]*[）)]/g, '')
        .replace(/[「」『』【】\[\]《》<>]/g, '')
        .replace(/[\s"'“”‘’]+/g, '')
        .trim();
}

function addKey(out, value, maxLen, max) {
    if (out.length >= max) return;
    const key = clean(value);
    if (!isValidKey(key)) return;
    if (!out.includes(key)) out.push(key);
}

function addEntities(out, text, maxLen, max) {
    for (const m of String(text || '').matchAll(ENTITY_SUFFIX)) {
        addKey(out, m[1], maxLen, max);
    }
}

/** 从结构化字段 [执行者 | 目标 | ...] 或引号里取关键词，不切自由文本 */
export function extractStructuredKeys(value, { max = 10, maxLen = 6 } = {}) {
    const out = [];
    const text = String(value || '');
    for (const m of text.matchAll(/\[([^\]]+)\]/g)) {
        for (const part of m[1].split(/[｜|、,，/]/)) {
            addKey(out, part, maxLen, max);
            if (out.length >= max) break;
        }
    }
    for (const m of text.matchAll(/[「“"]([^」”"]{2,12})[」”"]/g)) {
        addKey(out, m[1], maxLen, max);
        if (out.length >= max) break;
    }
    return out;
}

/** 解析条目里显式写的「关键词：A、B」 */
export function parseKeywordSpec(value) {
    const m = String(value || '').match(/关键词[：:]\s*([^；;。\n]+)/);
    if (!m) return [];
    return m[1].split(/[、,，/]/).map(clean)
        .filter(k => isValidKey(k) && k.length <= 6);
}

/** 通用绿灯：名字短就直接用；长名字取实体词、拆段、首尾短词 */
export function deriveGreenKeys(names = [], { max = 16, maxLen = 6 } = {}) {
    const out = [];
    for (const raw of names) {
        const name = clean(raw);
        if (!name) continue;
        if (isAbstractName(name)) continue;
        if (name.length <= maxLen) addKey(out, name, maxLen, max);
        for (const part of name.split(/[·｜|、，,。！？；;:：/\\\s]+/)) {
            addKey(out, part, maxLen, max);
        }
        addEntities(out, name, maxLen, max);
        if (name.length > maxLen) {
            addKey(out, name.slice(-2), maxLen, max);
            addKey(out, name.slice(-3), maxLen, max);
            if (name.includes('的')) addKey(out, name.split('的').pop(), maxLen, max);
        }
        if (out.length >= max) break;
    }
    return out.slice(0, max);
}

/** 新闻标题：取地名/机构等实体词；没有实体词的短句取开头 3 字 */
export function deriveNewsKeys(names = [], { max = 12, maxLen = 6 } = {}) {
    const out = [];
    for (const raw of names) {
        const title = clean(raw);
        if (!title) continue;
        if (title.length <= maxLen) addKey(out, title, maxLen, max);
        const clauses = title.split(/[，。！？；;、]/).map(clean).filter(Boolean);
        for (const clause of clauses) {
            const before = out.length;
            addEntities(out, clause, maxLen, max);
            if (out.length === before && !BAD_PREFIX.test(clause)) {
                addKey(out, clause.slice(0, 3), maxLen, max);
            }
        }
        addKey(out, title.slice(-2), maxLen, max);
        addKey(out, title.slice(-3), maxLen, max);
        if (out.length >= max) break;
    }
    return out.slice(0, max);
}
