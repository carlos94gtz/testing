#!/usr/bin/env node

const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || 3000);
const apiToken = process.env.API_TOKEN || "";
const serviceName = process.env.SERVICE_NAME || "public-http-server";
const databaseUrl = process.env.DATABASE_URL || "";
const messagesFile = process.env.MESSAGES_FILE || path.join(os.tmpdir(), "public-http-server-messages.jsonl");
const maxBodyBytes = 20_000;
const recentSubmissions = new Map();
let pgPool = null;

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
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  };

  if (forwardedProto === "https") {
    headers["strict-transport-security"] = "max-age=31536000; includeSubDomains";
  }

  return headers;
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

function redirect(res, location) {
  res.writeHead(303, {
    location,
    "cache-control": "no-store",
  });
  res.end();
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function clientIp(req) {
  const forwardedFor = req.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return forwardedFor.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

function checkRateLimit(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const windowMs = 60_000;
  const maxSubmissions = 5;
  const timestamps = (recentSubmissions.get(ip) || []).filter((time) => now - time < windowMs);

  if (timestamps.length >= maxSubmissions) {
    recentSubmissions.set(ip, timestamps);
    return false;
  }

  timestamps.push(now);
  recentSubmissions.set(ip, timestamps);
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function parseBody(req) {
  const body = await readBody(req);
  const contentType = String(req.headers["content-type"] || "").toLowerCase();

  if (contentType.includes("application/json")) {
    return JSON.parse(body || "{}");
  }

  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data") ||
    contentType === ""
  ) {
    return Object.fromEntries(new URLSearchParams(body));
  }

  throw new Error("Unsupported content type");
}

function cleanText(value, maxLength) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeMessage(req, input) {
  const name = cleanText(input.name, 80) || "Anonymous";
  const email = cleanText(input.email, 160);
  const message = cleanText(input.message, 2_000);
  const website = cleanText(input.website, 200);

  if (website) {
    return { accepted: true, spam: true, record: null };
  }

  if (!message || message.length < 2) {
    return { accepted: false, error: "Message is required." };
  }

  return {
    accepted: true,
    record: {
      id: randomUUID(),
      name,
      email,
      message,
      ip: clientIp(req),
      userAgent: cleanText(req.headers["user-agent"], 300),
      createdAt: new Date().toISOString(),
    },
  };
}

function getDatabasePool() {
  if (!databaseUrl) return null;
  if (pgPool) return pgPool;

  const { Pool } = require("pg");
  pgPool = new Pool({
    connectionString: databaseUrl,
    max: 5,
  });
  return pgPool;
}

function messageStorageMode() {
  return databaseUrl ? "postgres" : "file";
}

async function ensureDatabase() {
  const pool = getDatabasePool();
  if (!pool) {
    console.log(`Message storage: file (${messagesFile})`);
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      email text,
      message text NOT NULL,
      ip text,
      user_agent text,
      created_at timestamptz NOT NULL
    )
  `);
  console.log("Message storage: Postgres");
}

async function saveMessage(req, input) {
  const result = normalizeMessage(req, input);
  if (!result.accepted || !result.record) return result;

  const pool = getDatabasePool();
  if (pool) {
    const record = result.record;
    await pool.query(
      `INSERT INTO messages (id, name, email, message, ip, user_agent, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [record.id, record.name, record.email, record.message, record.ip, record.userAgent, record.createdAt]
    );
    return result;
  }

  fs.mkdirSync(path.dirname(messagesFile), { recursive: true });
  fs.appendFileSync(`${messagesFile}`, `${JSON.stringify(result.record)}\n`, "utf8");
  return result;
}

async function readMessages(limit = 100) {
  const pool = getDatabasePool();
  if (pool) {
    const result = await pool.query(
      `SELECT id, name, email, message, created_at AS "createdAt"
       FROM messages
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows;
  }

  if (!fs.existsSync(messagesFile)) return [];

  return fs
    .readFileSync(messagesFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .slice(-limit)
    .map((line) => JSON.parse(line));
}

function homePage(url) {
  const sent = url.searchParams.get("sent") === "1";
  const error = url.searchParams.get("error") || "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Leave a Message</title>
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
      background: #f5f7f9;
      color: #18212b;
    }
    main {
      width: min(720px, calc(100vw - 32px));
      padding: 48px 0;
    }
    h1 {
      margin: 0 0 10px;
      font-size: clamp(2rem, 5vw, 3.5rem);
      line-height: 1;
      letter-spacing: 0;
    }
    p {
      margin: 0 0 24px;
      color: #4a5563;
      font-size: 1.05rem;
    }
    form {
      display: grid;
      gap: 14px;
    }
    label {
      display: grid;
      gap: 6px;
      color: #25313e;
      font-weight: 650;
    }
    input,
    textarea {
      box-sizing: border-box;
      width: 100%;
      border: 1px solid #c9d2dc;
      border-radius: 8px;
      padding: 12px 14px;
      background: #ffffff;
      color: #17202a;
      font: inherit;
    }
    textarea {
      min-height: 150px;
      resize: vertical;
    }
    button {
      justify-self: start;
      border: 0;
      border-radius: 8px;
      padding: 12px 18px;
      background: #166534;
      color: white;
      font: inherit;
      font-weight: 750;
      cursor: pointer;
    }
    .notice {
      margin-bottom: 18px;
      border-radius: 8px;
      padding: 12px 14px;
      font-weight: 650;
    }
    .success {
      background: #dcfce7;
      color: #14532d;
    }
    .error {
      background: #fee2e2;
      color: #7f1d1d;
    }
    .hidden {
      display: none;
    }
    @media (prefers-color-scheme: dark) {
      body {
        background: #101418;
        color: #f5f7fa;
      }
      p, label {
        color: #c8d2dd;
      }
      input, textarea {
        border-color: #3c4652;
        background: #151b22;
        color: #f5f7fa;
      }
      .success {
        background: #12331f;
        color: #bbf7d0;
      }
      .error {
        background: #3b1414;
        color: #fecaca;
      }
    }
  </style>
</head>
<body>
  <main>
    <h1>Leave a message</h1>
    <p>Send a short note. Your message will be delivered to the server owner.</p>
    ${sent ? '<div class="notice success">Message sent. Thank you.</div>' : ""}
    ${error ? `<div class="notice error">${escapeHtml(error)}</div>` : ""}
    <form method="post" action="/messages">
      <label>
        Name
        <input name="name" autocomplete="name" maxlength="80" placeholder="Your name">
      </label>
      <label>
        Email
        <input name="email" type="email" autocomplete="email" maxlength="160" placeholder="you@example.com">
      </label>
      <label>
        Message
        <textarea name="message" maxlength="2000" required placeholder="Write your message here"></textarea>
      </label>
      <label class="hidden">
        Website
        <input name="website" tabindex="-1" autocomplete="off">
      </label>
      <button type="submit">Send message</button>
    </form>
  </main>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  if (req.url.length > 2048) {
    sendSecureJson(req, res, 414, {
      error: "URI too long",
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

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      allow: "GET, HEAD, POST, OPTIONS",
      ...securityHeaders(req),
    });
    res.end();
    return;
  }

  if (!["GET", "HEAD", "POST"].includes(req.method)) {
    sendSecureJson(req, res, 405, {
      error: "Method not allowed",
    });
    return;
  }

  if (url.pathname === "/health") {
    if (!["GET", "HEAD"].includes(req.method)) {
      sendSecureJson(req, res, 405, { error: "Method not allowed" });
      return;
    }

    sendSecureJson(req, res, 200, {
      ok: true,
      service: serviceName,
      messageStorage: messageStorageMode(),
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (url.pathname === "/api/hello") {
    if (!["GET", "HEAD"].includes(req.method)) {
      sendSecureJson(req, res, 405, { error: "Method not allowed" });
      return;
    }

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

  if (url.pathname === "/api/messages") {
    if (req.method === "GET" || req.method === "HEAD") {
      if (!requireApiToken(req, res)) return;

      const messages = await readMessages(100);
      sendSecureJson(req, res, 200, {
        messages: messages.map((message) => ({
          id: message.id,
          name: message.name,
          email: message.email,
          message: message.message,
          createdAt: message.createdAt,
        })),
      });
      return;
    }

    if (req.method === "POST") {
      if (!checkRateLimit(req)) {
        sendSecureJson(req, res, 429, { error: "Too many submissions. Try again later." });
        return;
      }

      try {
        const input = await parseBody(req);
        const result = await saveMessage(req, input);
        if (!result.accepted) {
          sendSecureJson(req, res, 400, { error: result.error });
          return;
        }

        sendSecureJson(req, res, 201, {
          ok: true,
          id: result.record?.id || null,
        });
      } catch (err) {
        sendSecureJson(req, res, 400, { error: err.message || "Invalid request body" });
      }
      return;
    }
  }

  if (url.pathname === "/messages" && req.method === "POST") {
    if (!checkRateLimit(req)) {
      redirect(res, "/?error=Too%20many%20submissions.%20Try%20again%20later.");
      return;
    }

    try {
      const input = await parseBody(req);
      const result = await saveMessage(req, input);
      if (!result.accepted) {
        redirect(res, `/?error=${encodeURIComponent(result.error)}`);
        return;
      }
      redirect(res, "/?sent=1");
    } catch (err) {
      redirect(res, `/?error=${encodeURIComponent(err.message || "Invalid message")}`);
    }
    return;
  }

  if (url.pathname === "/") {
    if (!["GET", "HEAD"].includes(req.method)) {
      sendSecureJson(req, res, 405, { error: "Method not allowed" });
      return;
    }

    sendHtml(req, res, 200, homePage(url));
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

ensureDatabase()
  .then(() => {
    server.listen(port, host, () => {
      const addresses = localAddresses();
      console.log(`Server listening on http://${host}:${port}`);
      console.log(`Local URL: http://localhost:${port}`);
      for (const address of addresses) {
        console.log(`LAN URL: http://${address}:${port}`);
      }
    });
  })
  .catch((err) => {
    console.error(`Failed to initialize message storage: ${err.message}`);
    process.exit(1);
  });

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
