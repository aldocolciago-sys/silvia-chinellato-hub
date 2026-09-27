#!/usr/bin/env node
/**
 * Server di sviluppo/test che replica il deploy Vercel:
 *  - file statici dalla radice del repository (index.html, immagini);
 *  - GET /api/ical → esegue la vera funzione serverless api/ical.js;
 *  - /__fixtures__/*.ics → calendari di esempio per gli E2E (tests/fixtures/ics);
 *  - /__fixtures__/dynamic/<chiave>.ics → calendari modificabili via PUT (un calendario per test).
 *
 * Uso: node tests/support/server.mjs  (PORT=4173 di default)
 */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import icalHandler from '../../api/ical.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures', 'ics');
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';
const QUIET = process.env.QUIET !== '0';

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.ics': 'text/calendar; charset=utf-8'
};
const BLOCKED = [/^\/node_modules\//, /^\/\.git\//, /^\/tests\//, /^\/coverage\//, /^\/playwright-report\//, /^\/test-results\//];
const dynamicCalendars = new Map();

/** Adattatore minimale req/res in stile Vercel per le funzioni in /api. */
function vercelResponse(res) {
    return {
        setHeader: (k, v) => { res.setHeader(k, v); },
        status(code) { res.statusCode = code; return this; },
        json(body) { if (!res.getHeader('content-type')) res.setHeader('content-type', 'application/json; charset=utf-8'); res.end(JSON.stringify(body)); return this; },
        send(body) { res.end(body); return this; },
        end(body) { res.end(body); return this; }
    };
}

async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
}

async function serveFile(res, filePath) {
    try {
        const info = await stat(filePath);
        if (!info.isFile()) throw new Error('not a file');
        res.writeHead(200, { 'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
        res.end(await readFile(filePath));
    } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not found');
    }
}

export function createServer() {
    return http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const pathname = decodeURIComponent(url.pathname);
        if (!QUIET) console.log(req.method, pathname);
        try {
            if (pathname === '/api/ical' || pathname === '/api/ical.js') {
                await icalHandler({ method: req.method, query: Object.fromEntries(url.searchParams), headers: req.headers }, vercelResponse(res));
                return;
            }
            const dynamic = pathname.match(/^\/__fixtures__\/dynamic\/([\w-]+)\.ics$/);
            if (dynamic) {
                if (req.method === 'PUT' || req.method === 'POST') {
                    dynamicCalendars.set(dynamic[1], await readBody(req));
                    res.writeHead(204).end();
                } else if (dynamicCalendars.has(dynamic[1])) {
                    res.writeHead(200, { 'content-type': MIME['.ics'] }).end(dynamicCalendars.get(dynamic[1]));
                } else {
                    res.writeHead(404).end('Calendario dinamico non impostato');
                }
                return;
            }
            if (pathname.startsWith('/__fixtures__/')) {
                const file = path.join(FIXTURES, path.basename(pathname));
                await serveFile(res, file);
                return;
            }
            if (BLOCKED.some(rx => rx.test(pathname))) {
                res.writeHead(404).end('Not found');
                return;
            }
            const target = path.join(ROOT, pathname === '/' ? 'index.html' : pathname);
            if (!target.startsWith(ROOT)) {
                res.writeHead(403).end('Forbidden');
                return;
            }
            await serveFile(res, target);
        } catch (err) {
            console.error(err);
            if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
            res.end(String(err?.message || err));
        }
    });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    createServer().listen(PORT, HOST, () => {
        console.log(`Silvia Chinellato Hub in ascolto su http://${HOST}:${PORT}`);
    });
}
