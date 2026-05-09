const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const IG_BASE = "https://demo-api.ig.com/gateway/deal";
const MFB_BASE = "https://www.myfxbook.com/api";
const GEO_URL = "https://ipwho.is/";
const GEO_CACHE_MS = 6 * 60 * 60 * 1000;
const MFB_CACHE_MS = 55 * 60 * 1000;
const MFB_ALLOWED_SYMBOLS = new Set(["XAUUSD", "XAGUSD"]);
const MFB_EMAIL = process.env.MYFXBOOK_EMAIL;
const MFB_PASSWORD = process.env.MYFXBOOK_PASSWORD;
let geoCache = { ts: 0, data: null };
let mfbCache = { ts: 0, session: null };

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8"
};

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", ...headers });
  res.end(body || "");
};

const sendJson = (res, status, payload, headers = {}) => {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    ...headers
  });
  res.end(JSON.stringify(payload));
};

const fetchGeo = () => new Promise((resolve, reject) => {
  https.get(GEO_URL, { headers: { "User-Agent": "SentiMap/1.0" } }, (geoRes) => {
    let body = "";
    geoRes.on("data", chunk => { body += chunk; });
    geoRes.on("end", () => {
      try {
        const data = JSON.parse(body);
        if (data?.success === false) throw new Error(data?.message || "geo failed");
        resolve({ country: data.country, countryCode: data.country_code, city: data.city });
      } catch (err) {
        reject(err);
      }
    });
  }).on("error", reject);
});

const fetchJson = (url) => new Promise((resolve, reject) => {
  https.get(url, { headers: { "User-Agent": "SentiMap/1.0" } }, (res) => {
    let body = "";
    res.on("data", chunk => { body += chunk; });
    res.on("end", () => {
      let data = null;
      try {
        data = JSON.parse(body);
      } catch (err) {
        reject(err);
        return;
      }

      if ((res.statusCode || 0) >= 400) {
        reject(new Error(data?.message || `HTTP ${res.statusCode}`));
        return;
      }

      resolve(data);
    });
  }).on("error", reject);
});

const mfbLogin = async () => {
  if (!MFB_EMAIL || !MFB_PASSWORD) {
    throw new Error("Missing Myfxbook credentials (MYFXBOOK_EMAIL / MYFXBOOK_PASSWORD). ");
  }
  const url = `${MFB_BASE}/login.json?email=${encodeURIComponent(MFB_EMAIL)}&password=${encodeURIComponent(MFB_PASSWORD)}`;
  const data = await fetchJson(url);
  if (data?.error) throw new Error(data?.message || "Myfxbook login failed");
  if (!data?.session) throw new Error("Myfxbook login did not return a session.");
  mfbCache = { ts: Date.now(), session: data.session };
  return data.session;
};

const getMfbSession = async () => {
  if (mfbCache.session && Date.now() - mfbCache.ts < MFB_CACHE_MS) return mfbCache.session;
  return mfbLogin();
};

const mfbOutlook = async (symbol) => {
  const session = await getMfbSession();
  const url = `${MFB_BASE}/get-community-outlook-by-country.json?session=${encodeURIComponent(session)}&symbol=${encodeURIComponent(symbol)}`;
  const data = await fetchJson(url);
  if (!data?.error) return data;

  const msg = data?.message || "Myfxbook error";
  if (/session/i.test(msg)) {
    mfbCache = { ts: 0, session: null };
    const retrySession = await mfbLogin();
    const retryUrl = `${MFB_BASE}/get-community-outlook-by-country.json?session=${encodeURIComponent(retrySession)}&symbol=${encodeURIComponent(symbol)}`;
    const retryData = await fetchJson(retryUrl);
    if (!retryData?.error) return retryData;
    throw new Error(retryData?.message || "Myfxbook error");
  }

  throw new Error(msg);
};

const handleGeo = (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Access-Control-Allow-Headers": req.headers["access-control-request-headers"] || "*",
      "Access-Control-Max-Age": "600"
    });
    res.end();
    return;
  }

  const now = Date.now();
  if (geoCache.data && now - geoCache.ts < GEO_CACHE_MS) {
    sendJson(res, 200, { ok: true, cached: true, data: geoCache.data });
    return;
  }

  fetchGeo()
    .then((data) => {
      geoCache = { ts: Date.now(), data };
      sendJson(res, 200, { ok: true, cached: false, data });
    })
    .catch((err) => {
      sendJson(res, 502, { ok: false, error: err?.message || "geo failed" });
    });
};

const serveStatic = (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
  filePath = path.normalize(filePath).replace(/^(\.\.(\/|\\|$))+/, "");
  const absPath = path.join(ROOT, filePath);

  if (!absPath.startsWith(ROOT)) {
    send(res, 403, "Forbidden");
    return;
  }

  fs.readFile(absPath, (err, data) => {
    if (err) {
      send(res, 404, "Not found");
      return;
    }
    const ext = path.extname(absPath).toLowerCase();
    const type = MIME[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(data);
  });
};

const proxyIG = (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": req.headers["access-control-request-headers"] || "*",
      "Access-Control-Max-Age": "600"
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const targetPath = url.pathname.replace(/^\/api\/ig/, "") + url.search;
  const targetUrl = new URL(IG_BASE + targetPath);

  const allowedHeaders = new Set([
    "accept",
    "content-type",
    "version",
    "x-ig-api-key",
    "cst",
    "x-security-token"
  ]);
  const headers = {};
  Object.keys(req.headers || {}).forEach((key) => {
    if (allowedHeaders.has(key.toLowerCase())) headers[key] = req.headers[key];
  });
  headers["User-Agent"] = "SentiMap/1.0";

  const proxyReq = https.request(
    {
      method: req.method,
      hostname: targetUrl.hostname,
      path: targetUrl.pathname + targetUrl.search,
      headers
    },
    (proxyRes) => {
      const chunks = [];
      proxyRes.on("data", (chunk) => chunks.push(chunk));
      proxyRes.on("end", () => {
        const body = Buffer.concat(chunks);
        const outHeaders = { ...proxyRes.headers, "Access-Control-Allow-Origin": "*" };
        res.writeHead(proxyRes.statusCode || 502, outHeaders);
        res.end(body);
        if ((proxyRes.statusCode || 0) >= 400) {
          console.warn("IG proxy error:", proxyRes.statusCode, body.toString());
        }
      });
    }
  );

  proxyReq.on("error", () => {
    send(res, 502, "Bad gateway");
  });

  req.pipe(proxyReq);
};

const handleMfbOutlook = (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Access-Control-Allow-Headers": req.headers["access-control-request-headers"] || "*",
      "Access-Control-Max-Age": "600"
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const symbol = (url.searchParams.get("symbol") || "").toUpperCase();

  if (!symbol || !MFB_ALLOWED_SYMBOLS.has(symbol)) {
    sendJson(res, 400, { ok: false, error: "Invalid symbol" });
    return;
  }

  mfbOutlook(symbol)
    .then((data) => {
      sendJson(res, 200, { ok: true, updatedAt: Date.now(), data });
    })
    .catch((err) => {
      sendJson(res, 502, { ok: false, error: err?.message || "Myfxbook error" });
    });
};

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/geo")) {
    handleGeo(req, res);
    return;
  }
  if (req.url.startsWith("/api/ig")) {
    proxyIG(req, res);
    return;
  }
  if (req.url.startsWith("/api/mfb/outlook")) {
    handleMfbOutlook(req, res);
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`SentiMap dev server running at http://localhost:${PORT}`);
});
