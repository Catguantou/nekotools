// 绿灯关键词：只生成短词，避免把整句标题写进世界书 key。
// 规则刻意保守：2–6 字、去重、限量、过滤分类名。

const STOP_WORDS = new Set([
    '国家', '势力', '社会新闻', '新闻', '事件', '影响', '来源',
    '计划', '伏笔', '道具', '支线', '主线', '地图', '索引',
    '当前', '地点', '未知', '暂无', '以下', '内容', '描述',
]);

const ENTITY_SUFFIX = /([\u4e00-\u9fa5]{1,5}(?:区|城|镇|街|港|州|国|山|河|湖|海|盟|府|宫|门|塔|会|党|军|团|教|公司|商会|码头|监狱|车站|市场|广场|医院|学院|森林|荒原|冻土|王国|王都))/g;

const BAD_PREFIX = /^(居民|市民|百姓|人们|众人|有人|洽谈|谈判|封锁|连夜|已经|正在|开始|继续|发生|出现|造成|导致|引发|抵达|抵京|使节|盟约|使团|商队)/;
const ABSTRACT_NAME = /(疑云|寻踪|谜团|秘影|暗流|回响|序曲|终章|秘闻|传说|风云|往事|余波|征兆|真相|阴谋|计划|序章|终局)/;

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
    if (key.length < 2 || key.length > maxLen) return;
    if (STOP_WORDS.has(key)) return;
    if (!out.includes(key)) out.push(key);
}

function addEntities(out, text, maxLen, max) {
    for (const m of String(text || '').matchAll(ENTITY_SUFFIX)) {
        addKey(out, m[1], maxLen, max);
    }
}

/** 只抽具体实体词（地名/机构），不从抽象标题里造词 */
export function extractEntityKeys(text, { max = 12, maxLen = 6 } = {}) {
    const out = [];
    for (const clause of String(text || '').split(/[，。！？；;、]/)) {
        addEntities(out, clause, maxLen, max);
        if (out.length >= max) break;
    }
    return out.slice(0, max);
}

/** 解析条目里显式写的「关键词：A、B」 */
export function parseKeywordSpec(value) {
    const m = String(value || '').match(/关键词[：:]\s*([^；;。\n]+)/);
    if (!m) return [];
    return m[1].split(/[、,，/]/).map(clean).filter(k => k.length >= 2 && k.length <= 6);
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
