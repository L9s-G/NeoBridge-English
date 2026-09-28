#!/usr/bin/env node
/**
 * 零依赖静态服务器，专门服务 app/ 目录。
 *
 *   npm start                 → http://localhost:1080  （同时监听 0.0.0.0，局域网可访问）
 *   PORT=8080 HOST=127.0.0.1 npm start
 *
 * PWA、Service Worker、`crypto.subtle` 都要求安全上下文，file:// 打不开。
 * 局域网 IP 是**不安全上下文**：手机上要么加 Chrome 白名单
 * （chrome://flags/#unsafely-treat-insecure-origin-as-secure 填 http://<IP>:<PORT>），
 * 要么用 HTTPS。
 */

import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(join(dirname(dirname(fileURLToPath(import.meta.url))), 'app'));
const PORT = Number(process.env.PORT) || 1080;
const HOST = process.env.HOST || '0.0.0.0';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  res.end(body);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';

    // 解析后必须仍然落在 ROOT 里，挡住 ../ 穿越
    const filePath = resolve(join(ROOT, normalize(pathname)));
    if (filePath !== ROOT && !filePath.startsWith(ROOT + sep)) {
      return send(res, 403, 'Forbidden');
    }

    const info = await stat(filePath).catch(() => null);
    if (!info || !info.isFile()) return send(res, 404, 'Not Found');

    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch (err) {
    console.error(err);
    send(res, 500, 'Internal Server Error');
  }
});

server.listen(PORT, HOST, () => {
  const lan = Object.values(networkInterfaces())
    .flat()
    .filter(n => n && n.family === 'IPv4' && !n.internal)
    .map(n => n.address);
  console.log(`\n  NeoBridge English  →  http://localhost:${PORT}/`);
  for (const ip of lan) console.log(`  局域网        →  http://${ip}:${PORT}/`);
  console.log(`  服务目录       →  ${ROOT}`);
  console.log(`  监听           →  ${HOST}:${PORT}`);
  console.log('  Service Worker 需要 localhost 或 HTTPS —— 用局域网 IP 打开时');
  console.log(`  手机 Chrome 要先到 chrome://flags/#unsafely-treat-insecure-origin-as-secure`);
  console.log(`  填 http://${lan[0] || '<IP>'}:${PORT} 并重启浏览器，否则词包/发音下载全用不了\n`);
});
