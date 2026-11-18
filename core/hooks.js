import { registry } from './registry.js';
import { StreamGate } from './streamgate.js';
import { getCtx } from './st_api.js';

const URL_RX = /(\/api\/backends\/(chat-completions|text-completions)\/generate|\/v1\/chat\/completions|:(streamG|g)enerateContent)/;

function getUrl(i) { return typeof i === 'string' ? i : (i && i.url) || ''; }
function isTarget(u) {
    try {
        const url = new URL(u, location.href);
        // 只劫持酒馆同源转发（本机 ST 后端）；插件自己直连外部 API 的请求不碰，
        // 否则后台更新会被当正常回合注入/结算。
        if (url.origin !== location.origin) return false;
        return URL_RX.test(url.pathname);
    } catch (_) {
        return URL_RX.test(u);
    }
}

/** 插件自己的后台请求带 X-Nekotool-Quiet:1，只跳过这一条，不影响用户同时发的聊天 */
function isQuietRequest(headers) {
    try {
        if (!headers) return false;
        if (typeof headers.get === 'function') return headers.get('x-nekotool-quiet') === '1';
        if (Array.isArray(headers)) return headers.some(([k, v]) => String(k).toLowerCase() === 'x-nekotool-quiet' && String(v) === '1');
        return Object.keys(headers).some(k => k.toLowerCase() === 'x-nekotool-quiet' && String(headers[k]) === '1');
    } catch (_) {
        return false;
    }
}
function findLastUser(m) { for (let i = m.length - 1; i >= 0; i--) if (m[i]?.role === 'user') return i; return -1; }
function extractText(c) { if (typeof c === 'string') return c; if (Array.isArray(c)) return c.filter(p => p && (p.type === 'text' || typeof p.text === 'string')).map(p => p.text || '').join('\n'); return ''; }
function setText(m, t) {
    if (typeof m.content === 'string') m.content = t;
    else if (Array.isArray(m.content)) {
        let d = false;
        m.content = m.content.map(p => { if (!d && p && (p.type === 'text' || typeof p.text === 'string')) { d = true; return { ...p, text: t }; } return p; });
        if (!d) m.content.push({ type: 'text', text: t });
    } else m.content = t;
}

function makeCtx(body, url) {
    const msgs = body.messages || [];
    const idx = findLastUser(msgs);
    const userMsgRef = idx >= 0 ? msgs[idx] : null;
    // 世界模拟靠它数 AI 楼层：请求上下文原本没有聊天记录，不补快照会永远数到 0
    let chat = [];
    try {
        const c = getCtx().chat;
        if (Array.isArray(c)) chat = c;
    } catch (_) {}

    return {
        url, body, messages: msgs,
        lastUserIndex: idx,
        lastUserText: userMsgRef ? extractText(userMsgRef.content) : '',
        chat,
        meta: {},
        __nt_pendingSystems: [],
        setLastUserText(t) {
            if (userMsgRef) setText(userMsgRef, t);
        },
    };
}

function getActiveTags() {
    const tags = new Set();
    for (const m of registry.enabled()) {
        if (Array.isArray(m.tags)) m.tags.forEach(t => tags.add(t));
    }
    return [...tags];
}

function processBody(bodyStr, url) {
    let body;
    try { body = JSON.parse(bodyStr); } catch { return { body: bodyStr, ctx: null }; }
    if (!Array.isArray(body.messages)) return { body: bodyStr, ctx: null };
    // 用户主动触发的静默生成：不注入、不结算，避免递归
    if (window.__nt_quiet) return { body: bodyStr, ctx: null };

    const ctx = makeCtx(body, url);
    for (const mod of registry.enabled()) {
        if (typeof mod.onRequest === 'function') {
            try { mod.onRequest(ctx); } catch (e) { console.error(`[nekotools:${mod.id}]`, e); }
        }
    }

    if (ctx.__nt_pendingSystems.length) {
        let lastSysIdx = -1;
        for (let i = ctx.messages.length - 1; i >= 0; i--) {
            if (ctx.messages[i] && ctx.messages[i].role === 'system') { lastSysIdx = i; break; }
        }
        if (lastSysIdx === -1) lastSysIdx = 0;
        ctx.messages.splice(lastSysIdx, 0, ...ctx.__nt_pendingSystems);
        ctx.lastUserIndex = findLastUser(ctx.messages);
    }

    return { body: JSON.stringify(ctx.body), ctx };
}

function finish(ctx, gate) {
    if (!ctx || ctx.__nt_finished) return;
    ctx.__nt_finished = true;
    const captured = gate ? gate.captured : {};
    for (const mod of registry.enabled()) {
        if (typeof mod.onResponse === 'function') {
            try { mod.onResponse({ captured, ctx }); } catch (e) { console.error(`[nekotools:${mod.id}:resp]`, e); }
        }
    }
}

function handleSseLine(line, gate, state) {
    if (!line.startsWith('data:')) return line;
    const payload = line.slice(5).trim();
    if (!payload) return line;
    if (payload === '[DONE]') {
        const tail = gate.flush();
        if (tail) {
            const chunk = state.isGemini
                ? { candidates: [{ content: { parts: [{ text: tail }], role: 'model' } }] }
                : { choices: [{ index: 0, delta: { content: tail } }] };
            return `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]`;
        }
        return line;
    }
    try {
        const obj = JSON.parse(payload);
        let changed = false;
        const ch = obj.choices?.[0];
        if (ch?.delta && typeof ch.delta.content === 'string') {
            const c = gate.feed(ch.delta.content);
            if (c !== ch.delta.content) { ch.delta.content = c; changed = true; }
        }
        if (ch?.message && typeof ch.message.content === 'string') {
            const c = gate.feed(ch.message.content);
            if (c !== ch.message.content) { ch.message.content = c; changed = true; }
        }
        const parts = obj.candidates?.[0]?.content?.parts;
        if (Array.isArray(parts)) {
            state.isGemini = true;
            for (const p of parts) {
                if (typeof p.text === 'string') {
                    const c = gate.feed(p.text);
                    if (c !== p.text) { p.text = c; changed = true; }
                }
            }
        }
        return changed ? 'data: ' + JSON.stringify(obj) : line;
    } catch { return line; }
}

async function wrapResponse(res, ctx) {
    if (!ctx || !res.ok) return res;
    const tags = getActiveTags();
    if (!tags.length) { finish(ctx, null); return res; }

    const wsMod = registry.get('worldsim');
    const customStatus = wsMod?.settings ? !!wsMod.settings.enableStatus : true;
    const gate = new StreamGate(tags, { customStatus });

    if ((res.headers.get('content-type') || '').includes('application/json')) {
        const text = await res.text();
        let outText = text;
        try {
            const obj = JSON.parse(text);
            const ch = obj.choices?.[0];
            if (ch?.message && typeof ch.message.content === 'string') {
                ch.message.content = gate.feed(ch.message.content) + gate.flush();
                outText = JSON.stringify(obj);
            }
            const parts = obj.candidates?.[0]?.content?.parts;
            if (Array.isArray(parts)) {
                for (const p of parts) {
                    if (typeof p.text === 'string') p.text = gate.feed(p.text);
                }
                const tail = gate.flush();
                if (tail && parts.length) {
                    const last = parts[parts.length - 1];
                    last.text = (last.text || '') + tail;
                }
                outText = JSON.stringify(obj);
            }
        } catch (e) { console.warn('[nekotools:resp] json parse fail', e); }
        finish(ctx, gate);
        return new Response(outText, { status: res.status, statusText: res.statusText, headers: res.headers });
    }

    if (!res.body || typeof res.body.getReader !== 'function') return res;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    const enc = new TextEncoder();
    const headers = new Headers(res.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');
    let lineBuf = '';
    const sseState = { isGemini: false };

    const stream = new ReadableStream({
        async start(controller) {
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    lineBuf += dec.decode(value, { stream: true });
                    let i;
                    while ((i = lineBuf.indexOf('\n')) !== -1) {
                        const line = lineBuf.slice(0, i).replace(/\r$/, '');
                        lineBuf = lineBuf.slice(i + 1);
                        controller.enqueue(enc.encode(handleSseLine(line, gate, sseState) + '\n'));
                    }
                }
                if (lineBuf) {
                    controller.enqueue(enc.encode(handleSseLine(lineBuf.replace(/\r$/, ''), gate, sseState) + '\n'));
                }
                // 兜底：如果上游未发 [DONE] 就断开流，封装合法的 SSE 帧吐出剩余缓存
                const tail = gate.flush();
                if (tail) {
                    const chunk = sseState.isGemini
                        ? { candidates: [{ content: { parts: [{ text: tail }], role: 'model' } }] }
                        : { choices: [{ index: 0, delta: { content: tail } }] };
                    controller.enqueue(enc.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                }
            } catch (e) {
                console.error('[nekotools:ss]', e);
            } finally {
                finish(ctx, gate);
                try { controller.close(); } catch (_) {}
            }
        },
        cancel(reason) {
            try { reader.cancel(reason); } catch (_) {}
        }
    });

    return new Response(stream, { status: res.status, statusText: res.statusText, headers });
}

export function installFetchHook(verbose = false) {
    if (window.__nekotool_fetch_hooked) return;
    window.__nekotool_fetch_hooked = true;

    let seq = 0;
    const _f = window.fetch;
    window.fetch = function (input, init) {
        const url = getUrl(input);
        if (!isTarget(url)) return _f.call(this, input, init);
        const n = ++seq;
        // 每条回复应该正好一行；如果一次回复出现两行不同编号，就是真的发了两次生成请求
        if (verbose) console.log(`[nekotools:hook] #${n}`, url);

        if (input instanceof Request) {
            return input.clone().text().then(b => {
                const { body, ctx } = isQuietRequest(input.headers)
                    ? { body: b, ctx: null }
                    : processBody(b, url);
                return _f.call(this, new Request(input, { body }), init).then(r => wrapResponse(r, ctx));
            }).catch(e => {
                console.error('[nekotools:hook:read]', e);
                return _f.call(this, input, init);
            });
        }
        if (init && typeof init.body === 'string') {
            const { body, ctx } = isQuietRequest(init.headers) || window.__nt_quiet
                ? { body: init.body, ctx: null }
                : processBody(init.body, url);
            return _f.call(this, input, { ...init, body }).then(r => wrapResponse(r, ctx));
        }
        return _f.call(this, input, init);
    };
}