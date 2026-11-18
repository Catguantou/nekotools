#!/usr/bin/env node
/**
 * NEKOTOOL 自检脚本（无依赖）
 *
 * 用法（Windows PowerShell）：
 *   node tools/check.mjs
 * 或没有 node 在 PATH 时，用 DSH 自带的运行时：
 *   $env:ELECTRON_RUN_AS_NODE='1'; & "E:\软件\DSH\DeepSeek Harness.exe" tools/check.mjs
 *
 * 检查项：
 *   1. 所有 .js 能否被解析（ESM 语法检查，复制成 .mjs 再 node --check）
 *   2. 所有 .js / .css 是否为合法 UTF-8（有没有替换字符 U+FFFD）
 *   3. 所有 js 里引用的 #nt-* DOM id 是否真的有模板声明
 *   4. core/worldfmt.js 的档名/存档格式样例测试
 *   5. core/worldkeys.js 的绿灯关键词样例测试
 *   6. 所有 .css 的大括号配对与字符串闭合（跳过注释，字符串内裸换行＝未闭合）
 *   7. manifest.json 是否是合法 JSON 且含必需字段
 */
import { readFileSync, readdirSync, statSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const failures = [];
const checked = { syntax: 0, encoding: 0, css: 0, worldfmt: 0, worldkeys: 0 };

function walk(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === '.git') continue;
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) out.push(...walk(full));
        else out.push(full);
    }
    return out;
}

const files = walk(ROOT);
const jsFiles = files.filter(f => extname(f) === '.js');
const tmp = mkdtempSync(join(tmpdir(), 'nt-check-'));

for (const file of jsFiles) {
    const rel = file.slice(ROOT.length + 1);

    // 编码
    const text = readFileSync(file, 'utf8');
    if (text.includes('\uFFFD')) {
        failures.push(`[编码] ${rel} 含替换字符 U+FFFD（文件被非 UTF-8 写过）`);
    }
    checked.encoding++;

    // 语法：复制成 .mjs 再 --check
    const dst = join(tmp, rel.replace(/[\\/]/g, '_').replace(/\.js$/, '.mjs'));
    copyFileSync(file, dst);
    const res = spawnSync(process.execPath, ['--check', dst], {
        encoding: 'utf8',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    if (res.status !== 0) {
        const msg = (res.stderr || '').split('\n').find(l => /Error/.test(l)) || 'syntax error';
        failures.push(`[语法] ${rel} → ${msg.trim()}`);
    }
    checked.syntax++;
}

// 样式表：UTF-8 + 大括号配对 + 字符串闭合
// 只做轻量扫描：跳过 /* */ 注释；' 或 " 内出现裸换行即视为引号没闭合。
// url(...) 里的内容（data URI 等）先替换成等长空格，避免把里面的引号/括号当成样式语法。
function stripUrlContents(text) {
    const out = text.split('');
    const lower = text.toLowerCase();
    for (let i = 0; i < text.length; i++) {
        if (lower.startsWith('url(', i)) {
            let depth = 1;
            let j = i + 4;
            for (; j < text.length && depth > 0; j++) {
                if (text[j] === '(') depth++;
                else if (text[j] === ')') depth--;
                else if (text[j] === '\n') break;
            }
            for (let k = i + 4; k < Math.min(j, text.length); k++) {
                if (out[k] !== '\n') out[k] = ' ';
            }
            i = j - 1;
        }
    }
    return out.join('');
}

const cssFiles = files.filter(f => extname(f) === '.css');
for (const file of cssFiles) {
    const rel = file.slice(ROOT.length + 1);
    const rawText = readFileSync(file, 'utf8');
    if (rawText.includes('\uFFFD')) {
        failures.push(`[CSS 编码] ${rel} 含替换字符 U+FFFD（文件被非 UTF-8 写过）`);
    }
    checked.encoding++;
    checked.css++;
    const text = stripUrlContents(rawText);

    let line = 1;
    let depth = 0;
    let mode = 'code'; // code | comment | string
    let quote = '';
    let stringStart = 0;
    for (let i = 0; i < text.length; i++) {
        const ln = line;
        const ch = text[i];
        const next = text[i + 1];
        if (ch === '\n') line++;
        if (mode === 'comment') {
            if (ch === '*' && next === '/') { mode = 'code'; i++; }
            continue;
        }
        if (mode === 'string') {
            if (ch === '\\') {
                i++;
                if (text[i] === '\n') line++;
                continue;
            }
            if (ch === '\n' || ch === '\r') {
                failures.push(`[CSS] ${rel}:${stringStart} 字符串出现裸换行，引号未闭合`);
                mode = 'code';
                quote = '';
                continue;
            }
            if (ch === quote) { mode = 'code'; quote = ''; }
            continue;
        }
        if (ch === '/' && next === '*') { mode = 'comment'; i++; continue; }
        if (ch === "'" || ch === '"') {
            mode = 'string';
            quote = ch;
            stringStart = ln;
            continue;
        }
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth < 0) {
                failures.push(`[CSS] ${rel}:${ln} 多了一个右大括号 }`);
                depth = 0;
            }
        }
    }
    if (mode === 'string') failures.push(`[CSS] ${rel}:${stringStart} 文件结束时字符串仍未闭合`);
    if (mode === 'comment') failures.push(`[CSS] ${rel} 文件结束时 /* 注释仍未闭合`);
    if (depth !== 0) failures.push(`[CSS] ${rel} 大括号不配对：文件结束仍有 ${depth} 个 { 未闭合`);
}

// DOM id 引用：扫所有 js，只认本插件自己的 nt-* 前缀
const jsTexts = new Map();
for (const file of jsFiles) {
    jsTexts.set(file.slice(ROOT.length + 1), readFileSync(file, 'utf8'));
}
const allJsText = [...jsTexts.values()].join('\n');
const idRefs = [];
const idConsts = new Set();
for (const [rel, text] of jsTexts) {
    for (const m of text.matchAll(/querySelector(?:All)?\(\s*['"]#(nt-[A-Za-z0-9_-]+)['"]/g)) {
        idRefs.push({ rel, id: m[1] });
    }
    for (const m of text.matchAll(/getElementById\(\s*['"](nt-[A-Za-z0-9_-]+)['"]/g)) {
        idRefs.push({ rel, id: m[1] });
    }
    // 常量写法：const FOO_ID = 'nt-...'（quickmenu 这类用 $() 取 id 的模块）
    for (const m of text.matchAll(/const\s+[A-Z][A-Z0-9_]*\s*=\s*['"](nt-[A-Za-z0-9_-]+)['"]/g)) {
        idRefs.push({ rel, id: m[1] });
        idConsts.add(m[1]);
    }
}
const ids = [...new Set(idRefs.map(r => r.id))];
for (const id of ids) {
    const declared = idConsts.has(id)
        || new RegExp(`\\bid\\s*=\\s*["']${id}["']`).test(allJsText)
        || new RegExp(`\\.id\\s*=\\s*["']${id}["']`).test(allJsText);
    if (!declared) {
        const ref = idRefs.find(r => r.id === id);
        failures.push(`[DOM] ${ref.rel} 引用了 #${id}，但没有任何模板声明这个 id`);
    }
}

// core/worldfmt.js 样例测试（纯函数，复制成 .mjs 后动态 import）
const worldfmtPath = join(ROOT, 'core', 'worldfmt.js');
try {
    const wfTmp = join(tmp, 'worldfmt_test.mjs');
    copyFileSync(worldfmtPath, wfTmp);
    const wf = await import(pathToFileURL(wfTmp).href);

    const assert = (ok, msg) => {
        checked.worldfmt++;
        if (!ok) failures.push(`[worldfmt] ${msg}`);
    };

    const base = wf.slotBaseName('Alice');
    assert(base === '【NEKOTOOL世界加载器·Alice】', '第 1 档基础名不对');
    assert(wf.slotName('Alice', 1) === base, '第 1 档不应带后缀');
    assert(wf.slotName('Alice', 2) === '【NEKOTOOL世界加载器·Alice·2】', '第 2 档名不对');

    const p1 = wf.parseSlotName(base);
    assert(p1 && p1.charName === 'Alice' && p1.slot === 1, '解析基础名失败');
    const p2 = wf.parseSlotName('【NEKOTOOL世界加载器·Alice·2】');
    assert(p2 && p2.charName === 'Alice' && p2.slot === 2, '解析第 2 档失败');
    const p3 = wf.parseSlotName('【NEKOTOOL世界加载器·A·B·3】');
    assert(p3 && p3.charName === 'A·B' && p3.slot === 3, '角色名含 · 时解析失败');
    assert(wf.parseSlotName('普通世界书') === null, '普通世界书不应被解析');
    assert(wf.parseSlotName('【NEKOTOOL世界加载器·】') === null, '空角色名不应被解析');

    const withSlash = wf.slotBaseName('A/B');
    assert(withSlash.includes('A_B'), '角色名里的非法字符未清洗');
    assert(wf.isSlotOf(withSlash, 'A/B'), '档位归属判断失败');
    assert(wf.isSlotOf('【NEKOTOOL世界加载器·A_B·2】', 'A/B'), '第 2 档归属判断失败');
    assert(!wf.isSlotOf(base, 'Bob'), '别人的档不应算自己的');

    // 长中文名：各档角色名部分必须一致，且总字节不超预算
    const longName = '很长的角色名字'.repeat(12);
    const longBytes = new TextEncoder().encode(wf.slotBaseName(longName)).length;
    assert(longBytes <= 220, '档名 UTF-8 字节超预算');
    assert(wf.isSlotOf(wf.slotName(longName, 2), longName), '超长角色名的第 2 档归属失败');
    assert(wf.isSlotOf(wf.slotBaseName(longName), longName), '超长角色名的基础档归属失败');

    // 角色名本身以 ·数字 结尾：基础档必须仍算自己
    assert(wf.isSlotOf(wf.slotBaseName('Alice·2'), 'Alice·2'), '以 ·数字 结尾的角色名归属失败');

    const saved = wf.buildSaveFile({ card: 'Alice', slot: 2, book: { entries: {} } });
    const parsed = wf.parseSaveFile(JSON.stringify(saved));
    assert(parsed.card === 'Alice' && parsed.slot === 2, '存档往返失败');

    let threw = false;
    try { wf.parseSaveFile('{"foo":1}'); } catch { threw = true; }
    assert(threw, '非法存档应当报错');

    let badUid = false;
    try {
        wf.parseSaveFile({ __nekotool_save: true, version: 1, card: 'A', book: { entries: { 1: { uid: '2' } } } });
    } catch { badUid = true; }
    assert(badUid, 'uid 对不上应当报错');

    let arrEntries = false;
    try {
        wf.parseSaveFile({ __nekotool_save: true, version: 1, card: 'A', book: { entries: [] } });
    } catch { arrEntries = true; }
    assert(arrEntries, 'entries 是数组应当报错');

    // 状态栏 → 世界时钟
    const fields = wf.parseStatusFields('时间: 2026年11月17日 | 地点: 酒馆 | 天气: 雨 | 温度: 18℃');
    assert(fields && fields.time === '2026年11月17日' && fields.place === '酒馆', '状态栏解析失败');
    assert(wf.parseStatusFields('时间：2026年1月2日｜地点：王都').place === '王都', '全角冒号/分隔符解析失败');
    assert(wf.parseStatusFields('什么都没有') === null, '无时间地点的状态栏不应解析');

    const d1 = wf.parseGameDate('2026年11月17日');
    const d2 = wf.parseGameDate('2027年2月1日');
    assert(d1 && d2 && wf.daysBetween(d1, d2) === 76, '剧情日期差值不对');
    assert(wf.daysBetween(d2, d1) === -76, '剧情日期倒推差值不对');
    assert(wf.parseGameDate('不是日期') === null, '非法日期应返回 null');
    assert(wf.parseGameDate('2026年2月30日') === null, '2 月 30 日应判非法');
    assert(wf.parseGameDate('2026年4月31日') === null, '4 月 31 日应判非法');
    assert(wf.parseGameDate('2024年2月29日') !== null, '闰年 2 月 29 日应合法');
    assert(wf.parseGameDate('0026年1月1日') === null, '过小年份应判非法');

    const rl = wf.parseRosterLine('- 阿猫｜T2｜北境｜在酒馆喝酒｜第 37 层');
    assert(rl && rl.name === '阿猫' && rl.tier === 'T2' && rl.location === '北境' && rl.action === '在酒馆喝酒' && rl.layer === 37, '角色索引行解析失败');
    assert(wf.parseRosterLine('') === null, '空行不应解析成角色');
    assert(wf.formatRosterLine({ name: '阿猫', tier: 'T2', location: '北境', action: '喝酒', layer: 37 }) === '- 阿猫｜T2｜北境｜喝酒｜第 37 层', '角色索引行生成失败');
    assert(wf.stripRosterLayer('T2｜北境｜喝酒｜第 37 层') === 'T2｜北境｜喝酒', '去掉层号失败');

    // 行动文案里出现「第 N 层」不能被当时间戳
    const rl2 = wf.parseRosterLine('- 阿猫｜T3｜地下室｜在第 5 层巡逻');
    assert(rl2 && rl2.action === '在第 5 层巡逻' && rl2.layer === 0, '行动里的「第 N 层」被误判成时间戳');
    // ASCII 竖线 + 竖线转义
    const rl3 = wf.parseRosterLine('- 阿猫 | T2 | 北境 | 喝酒 | 第 37 层');
    assert(rl3 && rl3.tier === 'T2' && rl3.location === '北境' && rl3.layer === 37, 'ASCII 竖线解析失败');
    const rl4 = wf.parseRosterLine('- 阿猫｜只是备注');
    assert(rl4 && rl4.tier === '' && rl4.action === '只是备注', '两段旧格式解析失败');
    assert(!wf.formatRosterLine({ name: 'A｜B', tier: 'T1' }).includes('A｜B'), '名字里的竖线未转义');
    assert(wf.stripRosterLayer('T2|北境|第 3 层') === 'T2|北境', 'ASCII 竖线去层号失败');
    assert(wf.parseRosterLine('【以下为角色索引】') === null, '区块标题不应被当成角色');

    // 角色档案 YAML
    const yaml = wf.formatCharacterYaml('艾达', { 身份: '机械师', 状态: '在门口', 关键记忆: ['a', 'b'] });
    assert(yaml.includes('姓名: "艾达"') && yaml.includes('  - "a"'), '角色 YAML 生成失败');
    const parsedYaml = wf.parseCharacterYaml(yaml);
    assert(parsedYaml.姓名 === '艾达' && parsedYaml.状态 === '在门口', '角色 YAML 解析失败');
    assert(Array.isArray(parsedYaml.关键记忆) && parsedYaml.关键记忆.length === 2, '角色 YAML 关键记忆解析失败');
    const oldChar = wf.parseCharacterYaml('- 状态：在门口\n- 关键记忆：a');
    assert(oldChar.状态 === '在门口' && oldChar.关键记忆 === 'a', '旧角色档案解析失败');
    assert(wf.normalizeMemories('a\nb').length === 2, '关键记忆分行失败');
    assert(wf.formatCharacterYaml('A:B', { 状态: 'x' }).includes('姓名: "A:B"'), 'YAML 引号失败');

    const yaml2 = wf.formatCharacterYaml('艾达', {
        性别: '女',
        外貌: '短发，工装',
        人际关系: { '菜月昴': '好感 40｜信任 30｜观望：愿意合作但觉得你太神秘' },
    });
    const parsed2 = wf.parseCharacterYaml(yaml2);
    assert(parsed2.性别 === '女' && parsed2.外貌.includes('短发'), '性别/外貌 YAML 往返失败');
    assert(parsed2.人际关系 && parsed2.人际关系['菜月昴'].includes('好感 40'), '人际关系 YAML 往返失败');
    assert(wf.normalizeRelationships({ a: '好感 1', b: '' }).a === '好感 1', '人际关系归一化失败');

    const yaml3 = wf.formatCharacterYaml('艾达', {
        位置: '市场街', 心情: '警惕', 日程: { 早晨: '中央广场｜摆摊' },
        当前行动: '整理凛果', 下一步: '去酒馆', 已知: ['王选仪式快开始了'],
        秘密: '认识扒手头目', 更新于: '第 37 层',
    });
    const parsed3 = wf.parseCharacterYaml(yaml3);
    assert(parsed3.位置 === '市场街' && parsed3.心情 === '警惕', '位置/心情 YAML 往返失败');
    assert(parsed3.日程 && parsed3.日程.早晨.includes('摆摊'), '日程 YAML 往返失败');
    assert(parsed3.已知 && parsed3.已知[0].includes('王选'), '已知 YAML 往返失败');
    assert(parsed3.秘密 === '认识扒手头目' && parsed3.更新于 === '第 37 层', '秘密/更新于 YAML 往返失败');
} catch (e) {
    failures.push(`[worldfmt] 样例测试无法执行：${e.message}`);
}

// core/worldkeys.js 样例测试（纯函数、无 import，复制成 .mjs 后动态 import）
const worldkeysPath = join(ROOT, 'core', 'worldkeys.js');
try {
    const wkTmp = join(tmp, 'worldkeys_test.mjs');
    copyFileSync(worldkeysPath, wkTmp);
    const wk = await import(pathToFileURL(wkTmp).href);

    const assertWk = (ok, msg) => {
        checked.worldkeys++;
        if (!ok) failures.push(`[worldkeys] ${msg}`);
    };

    // 正常专名/短词必须通过
    for (const key of ['王都', '要塞', '议会', '和平', '共和国', '有间客栈', '商会', '常织', '的黎波里', '和平饭店', '公爵府', '黑森林', '被遗忘者']) {
        assertWk(wk.isValidKey(key) === true, `isValidKey('${key}') 应为 true`);
    }
    // 句子碎片/非专名必须拒绝
    for (const key of ['她会知道', '默认她晚上会', '老妇人的家门', '属匣被开阳府', '与商会谈判', '和商会谈判', '能救下商会吗', '会来', '要去王都', '去酒馆', '来酒馆', '往北走', '与公爵谈判']) {
        assertWk(wk.isValidKey(key) === false, `isValidKey('${key}') 应为 false`);
    }
    // 抽象标题不生成 key，具体地名保留
    const green = wk.deriveGreenKeys(['王都', '冷光疑云']);
    assertWk(green.includes('王都'), 'deriveGreenKeys 未保留「王都」');
    assertWk(!green.includes('冷光疑云'), 'deriveGreenKeys 仍把抽象标题「冷光疑云」当 key');
} catch (e) {
    failures.push(`[worldkeys] 样例测试无法执行：${e.message}`);
}

// manifest
try {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
    for (const key of ['display_name', 'js', 'css']) {
        if (!manifest[key]) failures.push(`[manifest] 缺少字段 ${key}`);
    }
} catch (e) {
    failures.push(`[manifest] 解析失败：${e.message}`);
}

rmSync(tmp, { recursive: true, force: true });

console.log(`检查文件：${checked.syntax} 个 JS，编码校验 ${checked.encoding} 个（含 CSS ${checked.css} 个），DOM id ${ids.length} 个，worldfmt 样例 ${checked.worldfmt} 条，worldkeys 样例 ${checked.worldkeys} 条`);
if (failures.length) {
    console.error(`\n发现 ${failures.length} 个问题：`);
    for (const f of failures) console.error('  ✗ ' + f);
    process.exit(1);
}
console.log('✓ 全部通过');
