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
 *   3. panel.js 里 querySelector('#id') 引用的 id 是否真的存在于模板
 *   4. manifest.json 是否是合法 JSON 且含必需字段
 */
import { readFileSync, readdirSync, statSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { join, extname, basename, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const failures = [];
const checked = { syntax: 0, encoding: 0 };

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

// panel.js 的 DOM id 引用
const panelPath = join(ROOT, 'core', 'panel.js');
const panel = readFileSync(panelPath, 'utf8');
const ids = [...new Set([...panel.matchAll(/querySelector\('#([A-Za-z0-9_-]+)'\)/g)].map(m => m[1]))];
for (const id of ids) {
    if (!panel.includes(`id="${id}"`)) {
        failures.push(`[DOM] panel.js 引用了 #${id}，但模板里没有这个 id`);
    }
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

console.log(`检查文件：${checked.syntax} 个 JS，编码校验 ${checked.encoding} 个，DOM id ${ids.length} 个`);
if (failures.length) {
    console.error(`\n发现 ${failures.length} 个问题：`);
    for (const f of failures) console.error('  ✗ ' + f);
    process.exit(1);
}
console.log('✓ 全部通过');
