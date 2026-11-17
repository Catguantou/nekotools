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
