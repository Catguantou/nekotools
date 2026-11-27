import { registry } from '../core/registry.js';
import { stBridge } from '../core/st_bridge.js';

const TAG = 'ws_player';
const SECTIONS = [
    { key: '玩家势力', title: '玩家势力' },
    { key: '据点', title: '据点' },
    { key: '经济机构', title: '经济机构' },
    { key: '经营资产', title: '经营资产' },
    { key: '文娱作品', title: '文娱作品' },
];

/**
 * 三段契约单独导出，世界模拟的提示词预览才能看见它们。
 * faction = 玩家势力 + 据点；economy = 经济机构 + 经营资产；culture = 文娱作品。
 */
export const PLAYERSTATE_SECTIONS = {
    faction: `【玩家势力】
...
【据点】
...`,
    economy: `【经济机构】
名称：
类型：交易所 / 银行 / 钱庄 / 商会 / 市场 / 其他
状态：筹备 / 开放 / 关闭
范围：
规则：
控制者：
【经营资产】
只写玩家真正开始经营或资产发生变化时；内容用 JSON：
{"cash":0,"debt":0,"mode":"trader","feeRate":0.003,"limitRate":0.1,"impact":0.02,"assets":[{"id":"唯一短id","owner":"","name":"资产名","type":"股票/商品/物品","qty":0,"cost":0,"price":10,"prevClose":10,"trend":0,"short":0,"supply":0,"candles":[{"o":10,"h":10,"l":10,"c":10,"v":1000}]}],"businesses":[{"name":"店铺/产业","status":"营业","profit":0}],"orders":[{"who":"谁在买/卖","side":"buy/sell","qty":0,"memo":"标的名称"}]}
- orders 是「待成交订单」，你只写谁、买还是卖、多少股、买什么标的（memo 写标的名称）；成交价、滑点、手续费、现金与持仓的夹紧全部由程序算，你不要写价格也不要写现金变化。
- owner 写持有人：玩家自己留空字符串，别人写具体名字（同一个人固定同一个写法）。同一个标的给不同人各写一条，价格只写在该标的第一条即可，程序会按名字统一结算。
- supply 是这只标的的流通盘股数，只有玩家做市或经营交易所时才需要填；填了面板会算出各人的持仓占比。
- mode 三选一：trader 纯投资 / maker 做市商 / exchange 交易所。做市商可以靠 trend 直接影响次日涨跌；交易所模式每笔交易抽 feeRate 的手续费，归玩家所有。
- 同一个标的不同持有人不要重复生成行情字段；只写有变化的人。
- rules 是这场子自己的规矩，一段自由文本，程序不解读、只跟着记账，所以什么玩法都能写，别替玩家规定必须抵押什么。
- platform 是玩家自己开的「场子」：{"name":"场子名","kind":"casino/exchange/shop/custom","gate":"入场规矩，自由文本，空就是不设限","open":true,"edge":0.05,"exposure":0}；gateType 决定入会要拿什么抵（照片、押金、担保都只是一种「抵押物」，别写成具体图片），exposure 是被外人察觉的程度，0–100，越高的场子越早被剧情里的人物盯上。
- 谁进这场子、谁在炒股、谁抵了什么，全部由你根据剧情与角色追踪里已有的角色决定，不要等玩家手填；玩家只做操作。
- 面板会从角色追踪（条目名「角色·某某」）自动同步参与者，所以名字要和角色追踪里的写法一致。
- members 是会员名册：[{"name":"某人","deposit":0,"balance":0,"joined":"日期","proof":"拿什么抵的","suspect":0}]；proof 只写文字，不写图片。
- limitRate 是单日涨跌停幅度（默认 0.1 即正负一成），impact 是冲击成本系数（成交越占流通盘大，价格被推得越多）；dividend 是每股月度派息，只有需要分红时写。
- 融券余额会被当成负债按市价折算，别再写「白拿钱」的桥段。
资产名、股票、店铺、产业必须根据当前世界观生成，不要套用现代股票名。`,
    culture: `【文娱作品】
只写玩家真的有文娱活动时；内容用 JSON：
{"works":[{"title":"作品名","type":"小说/画/戏/电影/歌","status":"创作中/已发布/连载中/完结","quality":"粗糙/一般/优秀/杰作","heat":"冷清/小有名气/热门/爆火/现象级","spread":"本地/地区/全国/世界","reputation":"差评/一般/好评/神作","heatScore":0,"comments":["代表性评论"],"awards":["奖项"]}]}`,
};

export function playerstatePreviewPrompt() { return prompt(); }

function worldsimCfg() {
    try {
        const ws = registry.get('worldsim');
        return (ws && ws.settings) || {};
    } catch { return {}; }
}

function modeOf(key) {
    const cfg = worldsimCfg();
    const modes = cfg.promptModes || {};
    return modes[key] || 'append';
}

function prompt() {
    const cfg = worldsimCfg();
    const parts = [];
    if (cfg.enableFaction !== false && modeOf('faction') !== 'off') parts.push(PLAYERSTATE_SECTIONS.faction);
    if (cfg.enableEconomy !== false && modeOf('economy') !== 'off') parts.push(PLAYERSTATE_SECTIONS.economy);
    if (cfg.enableCulture !== false && modeOf('culture') !== 'off') parts.push(PLAYERSTATE_SECTIONS.culture);
    if (!parts.length) return '';
    return `<nekotools:playerstate>
【玩家状态更新】
只在本轮玩家确实做了以下事情时更新对应内容，没有发生就不输出：
- 建立/加入势力，人员或职位变化；
- 建立、搬迁、升级据点；
- 建立交易所、钱庄、市场，或让交易所开放/关闭；
- 玩家开始经营、资金/资产/股票/店铺/产业发生变化；
- 开始创作、发布作品、作品反馈变化。

用 <ws_player> 包裹变化内容，按段写：
${parts.join('\n')}

只写变化的段，不重写没有变化的段；不要额外发请求。
</nekotools:playerstate>`;
}


function splitSections(text) {
    const out = {};
    let current = '';
    for (const line of String(text || '').split('\n')) {
        const m = line.match(/^【([^】]+)】\s*$/);
        if (m) {
            current = m[1].trim();
            out[current] = '';
        } else if (current) {
            out[current] += (out[current] ? '\n' : '') + line;
        }
    }
    return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.trim()]));
}

registry.register({
    id: 'playerstate',
    name: '玩家状态',
    enabled: true,
    order: 56,
    tags: [TAG],
    onRequest(ctx) {
        const text = prompt();
        if (text && Array.isArray(ctx.__nt_pendingSystems)) {
            ctx.__nt_pendingSystems.push({ role: 'system', content: text });
        }
    },
    async onResponse({ captured }) {
        const raw = captured?.[TAG];
        if (!raw) return;
        const book = stBridge.currentTrackerName();
        if (!book) return;
        const sections = splitSections(raw);
        // 一次读盘、一次写盘：先把变化段全挑出来，再看有没有真的变
        const pending = [];
        for (const section of SECTIONS) {
            const content = sections[section.key];
            if (!content) continue;
            pending.push([section, content]);
        }
        if (!pending.length) return;
        const data = await stBridge.loadWorldInfoAsync(book, true);
        if (!data) return;
        let changed = false;
        for (const [section, content] of pending) {
            const entry = Object.values(data.entries || {}).find(e => e && e.comment === section.title);
            if (entry && entry.content === content) continue;
            stBridge.upsertEntryInBook(data, section.title, content, {
                isConstant: true, keywords: [], extra: { position: 0, depth: 0, order: 870 },
            });
            changed = true;
        }
        if (!changed) return;
        await stBridge.persistLorebook(book, data);
    },
});
