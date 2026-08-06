// Render 版：WebDAV 中转代理 + 静态托管 index.html（零依赖，原生 http）
// 部署：仓库根放 server.js + package.json + index.html，Render 导入后自动 npm start
// 工作台「中转代理」填：https://<你的render地址>/api/proxy
//
// 与本地代理 local-proxy.js 同一套契约：
//   浏览器 -> 代理: 头 X-WebDAV-Url(真实地址) + X-WebDAV-Auth(Basic 凭证)
//   代理 -> 坚果云: 用上述头转发，并自动 MKCOL 父目录解决 409
// 仅允许转发到 dav.jianguoyun.com，防止被滥用。

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS, MKCOL',
  'Access-Control-Allow-Headers': 'Content-Type, X-WebDAV-Url, X-WebDAV-Auth, Authorization',
  'Access-Control-Max-Age': '86400',
};

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function proxyRequest(targetUrl, method, auth, body) {
  return new Promise((resolve, reject) => {
    const r = https.request({
      hostname: targetUrl.hostname,
      port: 443,
      path: targetUrl.pathname + targetUrl.search,
      method,
      headers: {
        'Authorization': auth,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    }, (upRes) => {
      const out = [];
      upRes.on('data', (c) => out.push(c));
      upRes.on('end', () => {
        resolve({ status: upRes.statusCode || 200, buf: Buffer.concat(out), contentType: upRes.headers['content-type'] });
      });
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('上游超时')); });
    if (body && body.length) r.write(body);
    r.end();
  });
}

function mkcolParent(targetUrl, auth) {
  return new Promise((resolve) => {
    const parentPath = targetUrl.pathname.replace(/\/[^\/]*$/, '/');
    const r = https.request({
      hostname: targetUrl.hostname,
      port: 443,
      path: parentPath,
      method: 'MKCOL',
      headers: { 'Authorization': auth },
      timeout: 15000,
    }, (upRes) => { upRes.resume(); upRes.on('end', resolve); });
    r.on('error', () => resolve());
    r.on('timeout', () => { r.destroy(); resolve(); });
    r.end();
  });
}

const server = http.createServer(async (req, res) => {
  // ---- 代理路由 ----
  if (req.url.split('?')[0] === '/api/proxy') {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      return res.end();
    }

    const target = req.headers['x-webdav-url'];
    const auth = req.headers['x-webdav-auth'];
    if (!target || !auth) {
      res.writeHead(400, CORS);
      return res.end('缺少 X-WebDAV-Url 或 X-WebDAV-Auth 头');
    }

    let url;
    try { url = new URL(target); } catch (e) {
      res.writeHead(400, CORS);
      return res.end('X-WebDAV-Url 非法');
    }
    if (url.hostname !== 'dav.jianguoyun.com') {
      res.writeHead(403, CORS);
      return res.end('仅允许转发到 dav.jianguoyun.com');
    }

    try {
      const body = await readBody(req);
      if (req.method === 'PUT') {
        await mkcolParent(url, auth);
      }
      const upstream = await proxyRequest(url, req.method, auth, body);
      const headers = { ...CORS };
      if (upstream.contentType) headers['Content-Type'] = upstream.contentType;
      res.writeHead(upstream.status, headers);
      res.end(upstream.buf);
    } catch (e) {
      res.writeHead(502, CORS);
      res.end('代理转发失败: ' + e.message);
    }
    return;
  }

  // ---- 静态托管：返回 index.html（兼容根目录或子目录存放） ----
  if (req.method === 'GET' || req.method === 'HEAD') {
    const candidates = [
      path.join(ROOT, 'index.html'),
      path.join(ROOT, 'vercel-deploy', 'index.html'),
      path.join(ROOT, 'deploy_latest', 'index.html'),
      path.join(ROOT, 'dist', 'index.html'),
    ];
    let file = null;
    for (const c of candidates) {
      if (fs.existsSync(c)) { file = c; break; }
    }
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('index.html not found');
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('index.html not found');
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
        'Clear-Site-Data': '"cache"',
      });
      res.end(data);
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log('408-workbench listening on port ' + PORT);
});
