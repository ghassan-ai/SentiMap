"use strict";

const functions = require("firebase-functions");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");

admin.initializeApp();

const cfg = typeof functions.config === "function" ? functions.config() : {};
const cfgMyfxbook = cfg.myfxbook || {};

const BASE_URL = process.env.MYFXBOOK_BASE_URL || cfgMyfxbook.base_url || "https://www.myfxbook.com/api";
const EMAIL = process.env.MYFXBOOK_EMAIL || cfgMyfxbook.email;
const PASSWORD = process.env.MYFXBOOK_PASSWORD || cfgMyfxbook.password;
const SENTIMENT_COLLECTION = process.env.SENTIMENT_COLLECTION || "sentiment";

const ASSETS = {
  gold: "XAUUSD",
  silver: "XAGUSD"
};

const fetchJson = async (url) => {
  const res = await fetch(url, { headers: { "User-Agent": "SentiMap/1.0" } });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from Myfxbook`);
  }
  const data = await res.json();
  if (data?.error) {
    throw new Error(data?.message || "Myfxbook error");
  }
  return data;
};

const login = async () => {
  if (!EMAIL || !PASSWORD) {
    throw new Error("Missing Myfxbook credentials (MYFXBOOK_EMAIL / MYFXBOOK_PASSWORD).");
  }
  const url = `${BASE_URL}/login.json?email=${encodeURIComponent(EMAIL)}&password=${encodeURIComponent(PASSWORD)}`;
  const data = await fetchJson(url);
  if (!data?.session) throw new Error("Myfxbook login did not return a session.");
  return data.session;
};

const fetchCountryOutlook = async (session, symbol) => {
  const url = `${BASE_URL}/get-community-outlook-by-country.json?session=${encodeURIComponent(session)}&symbol=${encodeURIComponent(symbol)}`;
  return fetchJson(url);
};

const toNumber = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const clean = (obj) => Object.fromEntries(
  Object.entries(obj).filter(([_, v]) => v !== null && v !== undefined && v !== "")
);

const extractRows = (payload) => {
  if (!payload) return [];
  if (Array.isArray(payload.countries)) return payload.countries;
  if (Array.isArray(payload.country)) return payload.country;
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.rows)) return payload.rows;
  if (Array.isArray(payload.result)) return payload.result;
  return [];
};

const normalizeCountry = (raw) => {
  const code = String(
    raw.countryCode || raw.code || raw.country || raw.iso2 || raw.iso3 || raw.ISO2 || raw.ISO_A2 || ""
  ).trim().toUpperCase();
  const name = String(raw.countryName || raw.name || raw.countryName || raw.country || "").trim();

  return {
    code,
    name,
    longPercentage: toNumber(raw.longPercentage ?? raw.longPct ?? raw.long_perc ?? raw.long),
    shortPercentage: toNumber(raw.shortPercentage ?? raw.shortPct ?? raw.short_perc ?? raw.short),
    longPositions: toNumber(raw.longPositions ?? raw.longPosition ?? raw.longVolume ?? raw.longCount),
    shortPositions: toNumber(raw.shortPositions ?? raw.shortPosition ?? raw.shortVolume ?? raw.shortCount)
  };
};

const buildCountryKey = (code, name) => {
  if (code) return code;
  if (!name) return "";
  return name.toUpperCase().replace(/\s+/g, "_").replace(/[^A-Z0-9_]/g, "");
};

exports.refreshMarketSentiment = onSchedule({ schedule: "every 60 minutes", timeZone: "UTC" }, async () => {
  const session = await login();
  const db = admin.firestore();
  const batch = db.batch();
  const timestamp = admin.firestore.FieldValue.serverTimestamp();
  let hasWrites = false;

  for (const [asset, symbol] of Object.entries(ASSETS)) {
    try {
      const payload = await fetchCountryOutlook(session, symbol);
      const rows = extractRows(payload);

      const countries = {};
      let sumLong = 0;
      let sumShort = 0;
      let hasTotals = false;

      rows.forEach((row) => {
        const entry = normalizeCountry(row);
        const key = buildCountryKey(entry.code, entry.name);
        if (!key) return;

        if (Number.isFinite(entry.longPositions)) {
          sumLong += entry.longPositions;
          hasTotals = true;
        }
        if (Number.isFinite(entry.shortPositions)) {
          sumShort += entry.shortPositions;
          hasTotals = true;
        }

        countries[key] = clean({
          countryCode: entry.code || undefined,
          countryName: entry.name || undefined,
          longPercentage: entry.longPercentage,
          shortPercentage: entry.shortPercentage,
          longPositions: entry.longPositions,
          shortPositions: entry.shortPositions
        });
      });

      const global = clean({
        longPositions: hasTotals ? sumLong : undefined,
        shortPositions: hasTotals ? sumShort : undefined
      });

      if (hasTotals) {
        const total = sumLong + sumShort;
        if (total > 0) {
          global.longPercentage = Number(((sumLong / total) * 100).toFixed(4));
          global.shortPercentage = Number(((sumShort / total) * 100).toFixed(4));
        }
      }

      const payload = {
        updatedAt: timestamp,
        global,
        countries
      };

      const docRef = db.collection(SENTIMENT_COLLECTION).doc(asset);
      batch.set(docRef, payload, { merge: true });
      hasWrites = true;
    } catch (err) {
      functions.logger.error("Failed to refresh asset", asset, err?.message || err);
    }
  }

  if (hasWrites) {
    await batch.commit();
  }
});
