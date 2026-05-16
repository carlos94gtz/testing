#!/usr/bin/env node

const http = require("node:http");
const os = require("node:os");

const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || 3000);
const apiToken = process.env.API_TOKEN || "";
const serviceName = process.env.SERVICE_NAME || "public-http-server";

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`Invalid PORT: ${process.env.PORT}`);
  process.exit(1);
}

function securityHeaders(req) {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const headers = {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
  };

  if (forwardedProto === "https") {
    headers["strict-transport-security"] = "max-age=31536000; includeSubDomains";
  }

  return headers;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(`${body}\n`);
}

function sendHtml(req, res, status, html) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    ...securityHeaders(req),
  });
  res.end(html);
}

function sendSecureJson(req, res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...securityHeaders(req),
  });
  res.end(`${body}\n`);
}

function requireApiToken(req, res) {
  if (!apiToken) return true;
  const authHeader = req.headers.authorization || "";
  if (authHeader === `Bearer ${apiToken}`) return true;

  sendSecureJson(req, res, 401, {
    error: "Unauthorized",
  });
  return false;
}

function localAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((entry) => entry && entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
}

const server = http.createServer((req, res) => {
  if (req.url.length > 2048) {
    sendSecureJson(req, res, 414, {
      error: "URI too long",
    });
    return;
  }

  if (!["GET", "HEAD"].includes(req.method)) {
    sendSecureJson(req, res, 405, {
      error: "Method not allowed",
    });
    return;
  }

  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  } catch {
    sendSecureJson(req, res, 400, {
      error: "Bad request",
    });
    return;
  }

  if (url.pathname === "/health") {
    sendSecureJson(req, res, 200, {
      ok: true,
      service: serviceName,
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (url.pathname === "/api/hello") {
    if (!requireApiToken(req, res)) return;

    const name = url.searchParams.get("name")?.trim() || "there";
    sendSecureJson(req, res, 200, {
      message: `Hello, ${name}!`,
      service: serviceName,
      servedBy: os.hostname(),
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (url.pathname === "/") {
    sendHtml(
      req,
      res,
      200,
      `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Public HTTP Server</title>
  <style>
    :root {
      color-scheme: light dark;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.5;
    }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #f4f6f8;
      color: #17202a;
    }
    main {
      width: min(680px, calc(100vw - 32px));
    }
    h1 {
      margin: 0 0 12px;
      font-size: clamp(2rem, 5vw, 4rem);
      line-height: 1;
      letter-spacing: 0;
    }
    p {
      margin: 0 0 20px;
      color: #3f4c5a;
      font-size: 1.1rem;
    }
    code {
      background: rgba(23, 32, 42, 0.08);
      border-radius: 6px;
      padding: 2px 6px;
    }
    ul {
      padding-left: 20px;
      color: #2c3a47;
    }
    @media (prefers-color-scheme: dark) {
      body {
        background: #101418;
        color: #f5f7fa;
      }
      p, ul {
        color: #c5ced8;
      }
      code {
        background: rgba(245, 247, 250, 0.12);
      }
    }
  </style>
</head>
<body>
  <main>
    <h1>Server is running</h1>
    <p><code>${serviceName}</code> is listening on <code>${host}:${port}</code>.</p>
    <ul>
      <li><code>/health</code> returns a JSON health check.</li>
      <li><code>/api/hello?name=Jose</code> returns a small JSON greeting.</li>
    </ul>
  </main>
</body>
</html>`
    );
    return;
  }

  sendSecureJson(req, res, 404, {
    error: "Not found",
    path: url.pathname,
  });
});

server.keepAliveTimeout = 61_000;
server.headersTimeout = 65_000;
server.requestTimeout = 30_000;

server.listen(port, host, () => {
  const addresses = localAddresses();
  console.log(`Server listening on http://${host}:${port}`);
  console.log(`Local URL: http://localhost:${port}`);
  for (const address of addresses) {
    console.log(`LAN URL: http://${address}:${port}`);
  }
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
