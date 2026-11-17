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
 *   2. 文件是否为合法 UTF-8（有没有出现替换字符 U+FFFD）
 *   3. 所有 js 里引用的 #nt-* DOM id 是否真的有模板声明
 *   4. core/worldfmt.js 的档名/存档格式样例测试
 *   5. manifest.json 是否是合法 JSON 且含必需字段
 */
import { readFileSync, readdirSync, statSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const failures = [];
const checked = { syntax: 0, encoding: 0, worldfmt: 0 };

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
        人际关系: { '<user>': '好感 40｜信任 30｜观望：愿意合作但觉得你太神秘' },
    });
    const parsed2 = wf.parseCharacterYaml(yaml2);
    assert(parsed2.性别 === '女' && parsed2.外貌.includes('短发'), '性别/外貌 YAML 往返失败');
    assert(parsed2.人际关系 && parsed2.人际关系['<user>'].includes('好感 40'), '人际关系 YAML 往返失败');
    assert(wf.normalizeRelationships({ a: '好感 1', b: '' }).a === '好感 1', '人际关系归一化失败');
} catch (e) {
    failures.push(`[worldfmt] 样例测试无法执行：${e.message}`);
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

console.log(`检查文件：${checked.syntax} 个 JS，编码校验 ${checked.encoding} 个，DOM id ${ids.length} 个，worldfmt 样例 ${checked.worldfmt} 条`);
if (failures.length) {
    console.error(`\n发现 ${failures.length} 个问题：`);
    for (const f of failures) console.error('  ✗ ' + f);
    process.exit(1);
}
console.log('✓ 全部通过');
