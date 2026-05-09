"use strict";

const MFB_BASE = "https://www.myfxbook.com/api";
const SESSION_TTL_MS = 55 * 60 * 1000;

let sessionCache = { ts: 0, session: null };

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

const fetchJson = async (url) => {
  const res = await fetch(url, { headers: { "User-Agent": "SentiMap/1.0" } });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.message || `HTTP ${res.status}`);
  }
  if (data?.error) {
    throw new Error(data?.message || "Myfxbook error");
  }
  return data;
};

const login = async () => {
  const email = process.env.MYFXBOOK_EMAIL;
  const password = process.env.MYFXBOOK_PASSWORD;
  if (!email || !password) {
    throw new Error("Missing MYFXBOOK_EMAIL or MYFXBOOK_PASSWORD");
  }
  const url = `${MFB_BASE}/login.json?email=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}`;
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
  const url = `${MFB_BASE}/get-community-outlook-by-country.json?session=${encodeURIComponent(session)}&symbol=${encodeURIComponent(symbol)}`;
  try {
    return await fetchJson(url);
  } catch (err) {
    if (/session/i.test(err?.message || "")) {
      sessionCache = { ts: 0, session: null };
      const retrySession = await login();
      const retryUrl = `${MFB_BASE}/get-community-outlook-by-country.json?session=${encodeURIComponent(retrySession)}&symbol=${encodeURIComponent(symbol)}`;
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

  try {
    const data = await getOutlook(symbol);
    return jsonResponse(200, { ok: true, updatedAt: Date.now(), data });
  } catch (err) {
    return jsonResponse(502, { ok: false, error: err?.message || "Myfxbook error" });
  }
};
