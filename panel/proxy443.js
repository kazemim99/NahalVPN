const https = require('https');
const http = require('http');
const net = require('net');
const fs = require('fs');
const { URL } = require('url');

const SSL_CERT = '/etc/x-ui/cert/fullchain.crt';
const SSL_KEY = '/etc/x-ui/cert/private.key';

const options = {
  cert: fs.readFileSync(SSL_CERT),
  key: fs.readFileSync(SSL_KEY),
};

function proxyRequest(req, res, target) {
  const url = new URL(target);
  const proto = url.protocol === 'https:' ? https : http;

  const proxyOpts = {
    hostname: '127.0.0.1',
    port: url.port,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: req.headers.host || 'localhost' },
    rejectUnauthorized: false,
  };

  const proxyReq = proto.request(proxyOpts, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error(`Proxy error to ${target}: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502);
      res.end('Bad Gateway');
    }
  });

  req.pipe(proxyReq);
}

const PANEL_PATH = '/RG1maXFIFNcHra6k';

const server = https.createServer(options, (req, res) => {
  if (req.url.startsWith('/ws443')) {
    // VPN inbound via WebSocket - proxy to xray on 8443
    proxyRequest(req, res, 'http://127.0.0.1:8443');
  } else if (req.url.startsWith('/secretsub')) {
    // Subscription -> x-ui sub port 2096
    proxyRequest(req, res, 'https://127.0.0.1:2096');
  } else if (req.url.startsWith('/mV7qJtLd3RYNkuBxP4')) {
    // x-ui panel -> port 2053
    proxyRequest(req, res, 'https://127.0.0.1:2053');
  } else if (req.url.startsWith(PANEL_PATH)) {
    // Client panel - strip prefix before forwarding
    req.url = req.url.slice(PANEL_PATH.length) || '/';
    proxyRequest(req, res, 'http://127.0.0.1:2095');
  } else if (req.url.startsWith('/tutorial')) {
    // Tutorial video page - serve static files
    const path = require('path');
    const basePath = '/opt/client-panel/public/tutorial';
    let filePath;
    if (req.url === '/tutorial' || req.url === '/tutorial/') {
      filePath = path.join(basePath, 'index.html');
    } else {
      filePath = path.join(basePath, req.url.slice('/tutorial'.length));
    }
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = { '.html': 'text/html; charset=utf-8', '.mp4': 'video/mp4', '.webm': 'video/webm' };
    const mime = mimeTypes[ext] || 'application/octet-stream';
    const fss = require('fs');
    fss.stat(filePath, (err, stat) => {
      if (err) { res.writeHead(404); res.end('Not Found'); return; }
      // Support Range requests for video seeking
      const range = req.headers.range;
      if (range && ext === '.mp4') {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
          'Content-Type': mime,
        });
        fss.createReadStream(filePath, { start, end }).pipe(res);
      } else {
        res.writeHead(200, { 'Content-Type': mime, 'Content-Length': stat.size });
        fss.createReadStream(filePath).pipe(res);
      }
    });
  } else if (req.url.startsWith('/api/') || req.url.startsWith('/public/')) {
    // API and static asset calls from SPA (browser uses origin, no prefix)
    proxyRequest(req, res, 'http://127.0.0.1:2095');
  } else {
    // Everything else -> 404 (hidden panel)
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

// Handle WebSocket upgrades
server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/ws443')) {
    // VPN WebSocket -> xray on 8443
    const proxySocket = net.connect(8443, '127.0.0.1', () => {
      // Send HTTP upgrade request to xray
      const headers = Object.entries(req.headers).map(([k,v]) => `${k}: ${v}`).join('\r\n');
      proxySocket.write(
        `GET ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`
      );
      if (head.length) proxySocket.write(head);

      // Once xray responds with 101, pipe raw
      let responded = false;
      let buffer = Buffer.alloc(0);
      proxySocket.on('data', function onData(chunk) {
        if (!responded) {
          buffer = Buffer.concat([buffer, chunk]);
          const idx = buffer.indexOf('\r\n\r\n');
          if (idx !== -1) {
            responded = true;
            socket.write(buffer.slice(0, idx + 4));
            const remaining = buffer.slice(idx + 4);
            if (remaining.length) socket.write(remaining);
            proxySocket.removeListener('data', onData);
            proxySocket.pipe(socket);
            socket.pipe(proxySocket);
          }
        }
      });
    });

    proxySocket.on('error', (err) => {
      console.error(`WS VPN proxy error: ${err.message}`);
      socket.destroy();
    });

    socket.on('error', () => proxySocket.destroy());
    socket.on('close', () => proxySocket.destroy());
    proxySocket.on('close', () => socket.destroy());

  } else {
    // x-ui panel WebSocket
    let targetPort = 2053;
    if (req.url.startsWith('/secretsub')) targetPort = 2096;

    const proxyOpts = {
      hostname: '127.0.0.1',
      port: targetPort,
      path: req.url,
      method: 'GET',
      headers: req.headers,
      rejectUnauthorized: false,
    };

    const proxyReq = https.request(proxyOpts);
    proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\n` +
        Object.entries(proxyRes.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') +
        '\r\n\r\n'
      );
      if (proxyHead.length) socket.write(proxyHead);
      proxySocket.pipe(socket);
      socket.pipe(proxySocket);
    });

    proxyReq.on('error', (err) => {
      console.error(`WS proxy error: ${err.message}`);
      socket.destroy();
    });

    proxyReq.end();
  }
});

server.listen(443, '0.0.0.0', () => {
  console.log('Reverse proxy listening on port 443');
  console.log('  /ws443/*              -> http://127.0.0.1:8443  (VPN WebSocket)');
  console.log('  /mV7qJtLd3RYNkuBxP4/* -> https://127.0.0.1:2053 (x-ui panel)');
  console.log('  /secretsub/*          -> https://127.0.0.1:2096 (subscription)');
  console.log('  /RG1maXFIFNcHra6k/*   -> http://127.0.0.1:2095  (client panel)');
  console.log('  /*                    -> 404 (hidden)');
});
