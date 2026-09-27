/** Request/Response minimali compatibili con le funzioni serverless di Vercel (Node runtime). */
export function createMockReq({ method = 'GET', query = {}, headers = {} } = {}) {
    return { method, query, headers };
}

export function createMockRes() {
    const res = {
        statusCode: 200,
        headers: {},
        body: undefined,
        ended: false,
        setHeader(name, value) { this.headers[name.toLowerCase()] = value; return this; },
        getHeader(name) { return this.headers[name.toLowerCase()]; },
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; this.headers['content-type'] ??= 'application/json; charset=utf-8'; this.ended = true; return this; },
        send(payload) { this.body = payload; this.ended = true; return this; },
        end(payload) { if (payload !== undefined) this.body = payload; this.ended = true; return this; }
    };
    return res;
}
