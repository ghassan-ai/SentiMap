"use strict";

const https = require("https");

const MFB_BASE = "https://www.myfxbook.com/api";
const SESSION_TTL_MS = 55 * 60 * 1000;
const CACHE_DURATION = 60 * 60 * 1000;

let sessionCache = { ts: 0, session: null };
let cachedData = null;
let lastFetch = 0;
let cachedSymbol = null;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "content-type"
};

const jsonResponse = (statusCode, payload) => ({
  statusCode,
  headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders },
  body: JSON.stringify(payload)
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

      if (data?.error) {
        reject(new Error(data?.message || "Myfxbook error"));
        return;
      }

      resolve(data);
    });
  }).on("error", reject);
});

const login = async () => {
  const email = String(process.env.MYFXBOOK_EMAIL || "").trim();
  const password = String(process.env.MYFXBOOK_PASSWORD || "").trim();
  if (!email || !password) {
    console.error("Myfxbook env missing: MYFXBOOK_EMAIL or MYFXBOOK_PASSWORD");
    throw new Error("Missing MYFXBOOK_EMAIL or MYFXBOOK_PASSWORD");
  }
  const url = `${MFB_BASE}/login.json?email=${email}&password=${password}`;
  const data = await fetchJson(url);
  if (!data?.session) throw new Error("Myfxbook login did not return a session");
  sessionCache = { ts: Date.now(), session: data.session };
  return data.session;
};

const getSession = async () => {
  if (sessionCache.session && Date.now() - sessionCache.ts < SESSION_TTL_MS) {
    return sessionCache.session;
  }
  return login();
};

const getOutlook = async (symbol) => {
  const session = await getSession();
  const url = `${MFB_BASE}/get-community-outlook-by-country.json?session=${session}&symbol=${symbol}`;
  try {
    return await fetchJson(url);
  } catch (err) {
    if (/session/i.test(err?.message || "")) {
      sessionCache = { ts: 0, session: null };
      const retrySession = await login();
      const retryUrl = `${MFB_BASE}/get-community-outlook-by-country.json?session=${retrySession}&symbol=${symbol}`;
      return fetchJson(retryUrl);
    }
    throw err;
  }
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }
  if (event.httpMethod !== "GET") {
    return jsonResponse(405, { ok: false, error: "Method not allowed" });
  }

  const symbol = (event.queryStringParameters?.symbol || "").toUpperCase();
  if (!symbol) {
    return jsonResponse(400, { ok: false, error: "Missing symbol" });
  }

  const now = Date.now();
  if (cachedData && cachedSymbol === symbol && now - lastFetch < CACHE_DURATION) {
    return jsonResponse(200, { ok: true, cached: true, updatedAt: lastFetch, data: cachedData });
  }

  try {
    const data = await getOutlook(symbol);
    cachedData = data;
    cachedSymbol = symbol;
    lastFetch = Date.now();
    return jsonResponse(200, { ok: true, cached: false, updatedAt: lastFetch, data });
  } catch (err) {
    console.error("Myfxbook function error:", err?.message || err);
    return jsonResponse(502, { ok: false, error: err?.message || "Myfxbook error" });
  }
};
