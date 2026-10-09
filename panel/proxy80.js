const http = require('http');
const net = require('net');

const server = http.createServer((req, res) => {
  // HTTP requests (non-upgrade) - proxy based on path
  let targetPort = 8081; // default: existing xray inbound
  if (req.url.startsWith('/ws443')) {
    targetPort = 8443;
  }

  const proxyReq = http.request({
    hostname: '127.0.0.1',
    port: targetPort,
    path: req.url,
    method: req.method,
    headers: req.headers,
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error(`HTTP proxy error to port ${targetPort}: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502);
      res.end('Bad Gateway');
    }
  });

  req.pipe(proxyReq);
});

// Handle WebSocket upgrades
server.on('upgrade', (req, socket, head) => {
  let targetPort = 8081; // default: existing xray WS path /
  if (req.url.startsWith('/ws443')) {
    targetPort = 8443;
  }

  const proxySocket = net.connect(targetPort, '127.0.0.1', () => {
    const headers = Object.entries(req.headers).map(([k,v]) => `${k}: ${v}`).join('\r\n');
    proxySocket.write(
      `GET ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`
    );
    if (head.length) proxySocket.write(head);

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
    console.error(`WS proxy error to port ${targetPort}: ${err.message}`);
    socket.destroy();
  });

  socket.on('error', () => proxySocket.destroy());
  socket.on('close', () => proxySocket.destroy());
  proxySocket.on('close', () => socket.destroy());
});

server.listen(80, '0.0.0.0', () => {
  console.log('Port 80 proxy listening');
  console.log('  /ws443  -> 127.0.0.1:8443 (new VLESS WS inbound)');
  console.log('  /*      -> 127.0.0.1:8081 (existing VLESS WS inbound)');
});
