"use strict";

const https = require("https");

const GEO_URL = "https://ipwho.is/";
const GEO_CACHE_MS = 6 * 60 * 60 * 1000;
let geoCache = { ts: 0, data: null };

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

const fetchGeo = () => new Promise((resolve, reject) => {
  https.get(GEO_URL, { headers: { "User-Agent": "SentiMap/1.0" } }, (res) => {
    let body = "";
    res.on("data", chunk => { body += chunk; });
    res.on("end", () => {
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

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }
  if (event.httpMethod !== "GET") {
    return jsonResponse(405, { ok: false, error: "Method not allowed" });
  }

  const now = Date.now();
  if (geoCache.data && now - geoCache.ts < GEO_CACHE_MS) {
    return jsonResponse(200, { ok: true, cached: true, data: geoCache.data });
  }

  try {
    const data = await fetchGeo();
    geoCache = { ts: Date.now(), data };
    return jsonResponse(200, { ok: true, cached: false, data });
  } catch (err) {
    return jsonResponse(502, { ok: false, error: err?.message || "geo failed" });
  }
};
