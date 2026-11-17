function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
        switch (c) {
            case '&': return '&';
            case '<': return '<';
            case '>': return '>';
            case '"': return '"';
            case "'": return ''';
            default: return c;
        }
    });
}

export class StreamGate {
    constructor(tags = [], options = {}) {
        this.buf = '';
        this.tags = tags;
        this.hold = null;
        this.holdLen = 0;
        this.captured = {};
        this.maxTagLen = tags.reduce((m, t) => Math.max(m, t.length), 0) + 2;
        this.customStatus = options.customStatus !== false;
        this.maxHoldLimit = options.maxHoldLimit || 35000;
    }

    feed(chunk) {
        this.buf += chunk;
        let out = '';
        while (true) {
            if (this.hold) {
                const closer = '</' + this.hold + '>';
                const idx = this.buf.indexOf(closer);
                if (idx === -1) {
                    const keep = Math.min(this.buf.length, closer.length - 1);
                    const take = this.buf.slice(0, this.buf.length - keep);
                    this.captured[this.hold] = (this.captured[this.hold] || '') + take;
                    this.holdLen += take.length;
                    this.buf = this.buf.slice(this.buf.length - keep);

                    if (this.holdLen > this.maxHoldLimit) {
                        console.warn('[nekotools] 标签未闭合且超长，触发安全释放:', this.hold);
                        out += `<${this.hold}>` + this.captured[this.hold] + this.buf;
                        delete this.captured[this.hold];
                        this.buf = '';
                        this.hold = null;
                        this.holdLen = 0;
                        continue;
                    }
                    return out;
                }
                this.captured[this.hold] = (this.captured[this.hold] || '') + this.buf.slice(0, idx);
                this.buf = this.buf.slice(idx + closer.length);

                if (this.hold === 'ws_status' && this.customStatus) {
                    out += this.renderStatus(this.captured[this.hold]);
                }

                this.hold = null;
                this.holdLen = 0;
                continue;
            }

            let best = -1, tag = null;
            for (const t of this.tags) {
                const i = this.buf.indexOf('<' + t + '>');
                if (i !== -1 && (best === -1 || i < best)) { best = i; tag = t; }
            }
            if (best === -1) {
                if (!this.tags.length) {
                    out += this.buf;
                    this.buf = '';
                    return out;
                }
                const keep = Math.min(this.buf.length, this.maxTagLen + 1);
                out += this.buf.slice(0, this.buf.length - keep);
                this.buf = this.buf.slice(this.buf.length - keep);
                return out;
            }
            out += this.buf.slice(0, best);
            this.buf = this.buf.slice(best + tag.length + 2);
            this.hold = tag;
            this.holdLen = 0;
        }
    }

    flush() {
        if (this.hold) {
            this.captured[this.hold] = (this.captured[this.hold] || '') + this.buf;
            let out = '';
            if (this.hold === 'ws_status' && this.customStatus) {
                out = this.renderStatus(this.captured[this.hold]);
            }
            this.buf = '';
            this.hold = null;
            this.holdLen = 0;
            return out;
        }
        const rest = this.buf;
        this.buf = '';
        return rest;
    }

    renderStatus(text) {
        const parts = text.split(/[|｜\n]/).map(s => s.trim()).filter(Boolean);
        if (!parts.length) return '';
        let html = '<div class="ws-status-bar">';
        parts.forEach(p => {
            const match = p.match(/^([^:：]+)[:：](.*)$/);
            if (match) {
                html += `<span class="ws-status-item"><b>${escapeHtml(match[1].trim())}</b>${escapeHtml(match[2].trim())}</span>`;
            } else {
                html += `<span class="ws-status-item">${escapeHtml(p)}</span>`;
            }
        });
        html += '</div>\n\n';
        return html;
    }
}