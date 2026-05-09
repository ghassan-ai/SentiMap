/* app.js — Main application: UI, Myfxbook via local proxy */
(() => {
  const C = window.SM_CONFIG;
  const ME = window.MapEngine;
  const A = C.ASSETS;
  const REFRESH_MS = 60 * 60 * 1000;

  const state = {
    asset: "gold",
    lastUpdated: null,
    sentimentAvailable: false,
    sentimentError: null,
    sentimentData: null,
    countryStats: {},
    global: null,
    userLocation: null
  };

  const $ = id => document.getElementById(id);
  const dom = {
    lastUpdate: $("lastUpdate"),
    globalBuy: $("globalBuy"),
    globalSell: $("globalSell"),
    globalSignal: $("globalSignal"),
    todayCount: $("todayCount"),
    topBuy: $("topBuyAsset"),
    topSell: $("topSellAsset"),
    mfbStatus: $("mfbStatus"),
    mfbError: $("mfbError"),
    toast: $("toast"),
    topList: $("topCountriesList"),
    countryPanel: $("countryPanel"),
    countryPanelEmpty: $("countryPanelEmpty"),
    countryPanelData: $("countryPanelData"),
    cpdFlag: $("cpdFlag"),
    cpdName: $("cpdName"),
    cpdCode: $("cpdCode"),
    cpdBody: $("cpdBody"),
    cpdClose: $("cpdClose")
  };
  const assetBtns = document.querySelectorAll(".asset-tab");

  let sentimentChart;

  // ── Utilities ──
  const showToast = msg => {
    if (!dom.toast) return;
    dom.toast.textContent = msg;
    dom.toast.classList.add("show");
    setTimeout(() => dom.toast.classList.remove("show"), 3000);
  };
  const GEO_CACHE_KEY = "sentimap:geo_cache";
  const GEO_CACHE_TTL = 6 * 60 * 60 * 1000;
  const toNumber = v => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const pctToRatio = v => {
    const n = toNumber(v);
    if (!Number.isFinite(n)) return null;
    return n > 1 ? n / 100 : n;
  };
  const toDate = v => {
    if (!v) return null;
    if (v instanceof Date) return v;
    if (typeof v === "number") return new Date(v);
    return null;
  };
  const fmtPct = v => (Number.isFinite(v) ? `${v.toFixed(2)}%` : "--");
  const fmtCount = v => (Number.isFinite(v) ? new Intl.NumberFormat("en-US").format(Math.round(v)) : "--");

  // ── IP Detection ──
  const detectLocation = async () => {
    try {
      const cachedRaw = localStorage.getItem(GEO_CACHE_KEY);
      if (cachedRaw) {
        try {
          const cached = JSON.parse(cachedRaw);
          if (cached?.data?.countryCode && Date.now() - cached.ts < GEO_CACHE_TTL) {
            const loc = cached.data;
            state.userLocation = { country: loc.country, countryCode: loc.countryCode, city: loc.city };
            return;
          }
        } catch {
          // Ignore cache parse errors.
        }
      }

      const r = await fetch("/api/geo");
      const d = await r.json();
      if (!r.ok || !d?.ok || !d?.data?.countryCode) throw new Error(d?.error || "location unavailable");

      const loc = d.data;
      localStorage.setItem(GEO_CACHE_KEY, JSON.stringify({ ts: Date.now(), data: loc }));
      state.userLocation = { country: loc.country, countryCode: loc.countryCode, city: loc.city };
    } catch {
      // Location is optional; ignore errors silently.
    }
  };

  // ── Chart ──
  const initChart = () => {
    sentimentChart = new Chart($("sentimentChart").getContext("2d"), {
      type: "doughnut",
      data: { labels: ["شراء", "بيع"], datasets: [{ data: [50, 50], backgroundColor: [C.COLORS.buyStrong, C.COLORS.sellStrong], borderWidth: 0 }] },
      options: { responsive: true, plugins: { legend: { display: false } }, cutout: "65%" }
    });
  };

  // ── Data normalization ──
  const extractRows = (payload) => {
    if (!payload) return [];
    if (Array.isArray(payload.countries)) return payload.countries;
    if (Array.isArray(payload.country)) return payload.country;
    if (Array.isArray(payload.data)) return payload.data;
    if (Array.isArray(payload.rows)) return payload.rows;
    if (Array.isArray(payload.result)) return payload.result;
    return [];
  };

  const normalizeCountries = (rows) => {
    const stats = {};
    if (!rows) return stats;

    rows.forEach((raw) => {
      if (!raw) return;
      const rawCode = (raw.countryCode || raw.code || raw.country || raw.iso2 || raw.iso3 || "").toUpperCase();
      const rawName = (raw.countryName || raw.name || raw.country || "").trim();
      const metaByCode = rawCode ? ME.getMeta(rawCode) : null;
      const metaByName = rawName ? ME.getMetaByName(rawName) : null;
      const code = (metaByName?.code || metaByCode?.code || rawCode || "").toUpperCase();
      if (!code) return;

      const longRatio = pctToRatio(raw.longPercentage ?? raw.longPct ?? raw.long);
      const shortRatio = pctToRatio(raw.shortPercentage ?? raw.shortPct ?? raw.short);
      const buyRatio = Number.isFinite(longRatio) ? longRatio : (Number.isFinite(shortRatio) ? 1 - shortRatio : null);
      const longPercentage = Number.isFinite(longRatio) ? longRatio * 100 : (Number.isFinite(shortRatio) ? (1 - shortRatio) * 100 : null);
      const shortPercentage = Number.isFinite(shortRatio) ? shortRatio * 100 : (Number.isFinite(longRatio) ? (1 - longRatio) * 100 : null);
      const longPositions = toNumber(raw.longPositions ?? raw.longPosition ?? raw.longVolume ?? raw.longCount);
      const shortPositions = toNumber(raw.shortPositions ?? raw.shortPosition ?? raw.shortVolume ?? raw.shortCount);
      const totalPositions = (Number.isFinite(longPositions) ? longPositions : 0) + (Number.isFinite(shortPositions) ? shortPositions : 0);

      stats[code] = {
        key: code,
        name: metaByName?.name || metaByCode?.name || rawName || code,
        buyRatio,
        longPercentage,
        shortPercentage,
        longPositions,
        shortPositions,
        totalPositions
      };
    });

    return stats;
  };

  const buildGlobal = (stats, updatedAt) => {
    let sumLong = 0;
    let sumShort = 0;
    let hasTotals = false;

    Object.values(stats).forEach((entry) => {
      if (Number.isFinite(entry.longPositions)) {
        sumLong += entry.longPositions;
        hasTotals = true;
      }
      if (Number.isFinite(entry.shortPositions)) {
        sumShort += entry.shortPositions;
        hasTotals = true;
      }
    });

    const total = sumLong + sumShort;
    const ratio = hasTotals && total > 0 ? sumLong / total : null;

    return {
      ratio,
      longPositions: hasTotals ? sumLong : null,
      shortPositions: hasTotals ? sumShort : null,
      longPercentage: Number.isFinite(ratio) ? ratio * 100 : null,
      shortPercentage: Number.isFinite(ratio) ? (1 - ratio) * 100 : null,
      updatedAt
    };
  };

  const applySentimentUpdate = (data, updatedAt) => {
    state.sentimentData = data;
    const rows = extractRows(data);
    state.countryStats = normalizeCountries(rows);
    state.global = buildGlobal(state.countryStats, updatedAt);
    state.lastUpdated = toDate(updatedAt) || new Date();
    state.sentimentAvailable = true;
    state.sentimentError = null;

    const ratio = Number.isFinite(state.global?.ratio) ? state.global.ratio : 0.5;
    ME.updateStyles(state.countryStats, ratio);
    ME.updateMFBOverlays(ratio, true);
    updateSidebar();
    updateTop5();
    updateTime();
  };

  const handleSentimentError = (message) => {
    state.sentimentAvailable = false;
    state.sentimentError = message || "تعذر تحميل بيانات السوق.";
    state.sentimentData = null;
    state.countryStats = {};
    state.global = null;
    state.lastUpdated = null;

    ME.updateStyles({}, null);
    ME.updateMFBOverlays(null, false);
    updateSidebar();
    updateTop5();
    updateTime();
  };

  const fetchMyfxbook = async (assetKey) => {
    const symbol = A[assetKey]?.symbol;
    if (!symbol) throw new Error("Symbol not defined for " + assetKey);
    const r = await fetch(`/api/mfb/outlook?symbol=${encodeURIComponent(symbol)}`);
    let d = null;
    try {
      d = await r.json();
    } catch {
      // Ignore JSON parsing errors.
    }
    if (!r.ok || !d?.ok || !d?.data) {
      throw new Error(d?.error || "تعذر تحميل بيانات Myfxbook.");
    }
    return { data: d.data, updatedAt: d.updatedAt || Date.now() };
  };

  const refreshMyfxbook = async () => {
    const was = state.sentimentAvailable;
    try {
      const payload = await fetchMyfxbook(state.asset);
      applySentimentUpdate(payload.data, payload.updatedAt);
    } catch (err) {
      handleSentimentError(err?.message || "تعذر تحميل بيانات Myfxbook.");
      if (was) showToast("بيانات Myfxbook غير متوفرة مؤقتاً");
    }
  };

  // ── Country Selection Panel ──
  const showCountryPanel = ({ name, code, flag, entry }) => {
    dom.countryPanelEmpty.style.display = "none";
    dom.countryPanelData.style.display = "block";
    dom.cpdFlag.textContent = flag;
    dom.cpdName.textContent = name;
    dom.cpdCode.textContent = code || "--";

    dom.countryPanel.classList.add("active-highlight");
    setTimeout(() => dom.countryPanel.classList.remove("active-highlight"), 2000);

    if (!entry) {
      dom.cpdBody.innerHTML = `
        <div class="cpd-no-data">
          <div class="cpd-nd-icon">📡</div>
          <div class="cpd-nd-text">لا توجد بيانات سوق لهذه الدولة بعد.</div>
        </div>`;
      return;
    }

    const buyPct = Number.isFinite(entry.longPercentage)
      ? entry.longPercentage
      : (Number.isFinite(entry.buyRatio) ? entry.buyRatio * 100 : 0);
    const sellPct = Number.isFinite(entry.shortPercentage)
      ? entry.shortPercentage
      : (Number.isFinite(entry.buyRatio) ? (1 - entry.buyRatio) * 100 : 0);
    const barWidth = Number.isFinite(buyPct) ? Math.max(0, Math.min(100, buyPct)) : 0;

    dom.cpdBody.innerHTML = `
      <div class="cpd-stats">
        <div class="cpd-progress-wrap">
          <div class="cpd-progress-label"><span>شراء ${fmtPct(buyPct)}</span><span>بيع ${fmtPct(sellPct)}</span></div>
          <div class="cpd-progress">
            <div class="cpd-progress-fill buy" style="width:${barWidth}%"></div>
          </div>
        </div>
        <div class="cpd-stat-row"><span>📈 المشترين</span><strong>${fmtCount(entry.longPositions)}</strong></div>
        <div class="cpd-stat-row"><span>📉 البائعين</span><strong>${fmtCount(entry.shortPositions)}</strong></div>
        <div class="cpd-participants"><strong>${fmtCount(entry.totalPositions)}</strong> إجمالي مراكز</div>
      </div>`;
  };

  const hideCountryPanel = () => {
    dom.countryPanelEmpty.style.display = "flex";
    dom.countryPanelData.style.display = "none";
    ME.deselectCountry();
  };

  // ── Sidebar ──
  const updateSidebar = () => {
    const ratio = Number.isFinite(state.global?.ratio) ? state.global.ratio : 0.5;
    dom.globalBuy.textContent = ME.fmt(ratio);
    dom.globalSell.textContent = ME.fmt(1 - ratio);

    const cls = ME.getClass(ratio);
    const labels = {
      "buy-strong": "سيطرة شراء قوية",
      "buy-soft": "تفوق شراء",
      neutral: "محايد",
      "sell-soft": "تفوق بيع",
      "sell-strong": "سيطرة بيع قوية"
    };
    dom.globalSignal.textContent = state.sentimentAvailable ? labels[cls] : "غير متصل";
    dom.globalSignal.className = `signal ${state.sentimentAvailable ? cls : "neutral"}`;

    if (sentimentChart) {
      sentimentChart.data.datasets[0].data = [ratio * 100, (1 - ratio) * 100];
      sentimentChart.update();
    }

    const totalPositions = (Number.isFinite(state.global?.longPositions) ? state.global.longPositions : 0)
      + (Number.isFinite(state.global?.shortPositions) ? state.global.shortPositions : 0);
    dom.todayCount.textContent = state.sentimentAvailable ? fmtCount(totalPositions) : "--";

    const entries = Object.values(state.countryStats || {});
    const topBuy = entries
      .filter(e => Number.isFinite(e.longPercentage))
      .sort((a, b) => b.longPercentage - a.longPercentage)[0];
    const topSell = entries
      .filter(e => Number.isFinite(e.shortPercentage))
      .sort((a, b) => b.shortPercentage - a.shortPercentage)[0];

    dom.topBuy.textContent = topBuy ? `${topBuy.name} (${fmtPct(topBuy.longPercentage)})` : "--";
    dom.topSell.textContent = topSell ? `${topSell.name} (${fmtPct(topSell.shortPercentage)})` : "--";

    dom.mfbStatus.textContent = state.sentimentAvailable
      ? "● بيانات Myfxbook عبر البروكسي المحلي"
      : "○ بيانات Myfxbook غير متوفرة";

    if (dom.mfbError) {
      if (state.sentimentError) {
        dom.mfbError.textContent = state.sentimentError;
        dom.mfbError.style.display = "block";
      } else {
        dom.mfbError.textContent = "";
        dom.mfbError.style.display = "none";
      }
    }
  };

  // ── Top 5 Countries ──
  const updateTop5 = () => {
    const stats = state.countryStats || {};
    const sorted = Object.values(stats)
      .filter(e => Number.isFinite(e.totalPositions) && e.totalPositions > 0)
      .sort((a, b) => b.totalPositions - a.totalPositions)
      .slice(0, 5);

    if (!sorted.length) {
      dom.topList.innerHTML = '<div class="top-country-placeholder">لا توجد بيانات بعد</div>';
      return;
    }

    dom.topList.innerHTML = sorted.map((e, i) => {
      const flag = e.key.length === 2 ? ME.toFlag(e.key) : "🏳️";
      const bp = Number.isFinite(e.longPercentage)
        ? e.longPercentage
        : (Number.isFinite(e.buyRatio) ? e.buyRatio * 100 : 0);
      const sparkId = `spark_${e.key}_${i}`;
      return `<div class="top-country-row">
        <div class="top-country-rank">${i + 1}</div>
        <div class="top-country-flag">${flag}</div>
        <div class="top-country-info"><div class="top-country-name">${e.name}</div><div class="top-country-count">${fmtCount(e.totalPositions)} مراكز · ${fmtPct(bp)} شراء</div></div>
        <canvas class="top-country-spark" id="${sparkId}" width="60" height="18"></canvas>
      </div>`;
    }).join("");

    sorted.forEach((e, i) => {
      const canvas = $("spark_" + e.key + "_" + i);
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      const ratio = Number.isFinite(e.buyRatio)
        ? e.buyRatio
        : (Number.isFinite(e.longPercentage) ? e.longPercentage / 100 : 0.5);
      const w = canvas.width, h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      const bw = Math.round(ratio * (w - 4));
      ctx.fillStyle = C.COLORS.buyStrong; ctx.beginPath(); ctx.roundRect(0, 2, bw, h - 4, 3); ctx.fill();
      ctx.fillStyle = C.COLORS.sellStrong; ctx.beginPath(); ctx.roundRect(bw + 2, 2, w - bw - 4, h - 4, 3); ctx.fill();
    });
  };

  // ── Asset Tabs ──
  const setAsset = a => {
    if (!A[a]) return;
    state.asset = a;
    assetBtns.forEach(b => b.classList.toggle("active", b.dataset.asset === a));
    refreshMyfxbook();
  };

  // ── Timers ──
  const updateTime = () => {
    if (!state.lastUpdated) {
      dom.lastUpdate.textContent = "--";
      return;
    }
    const d = Math.floor((Date.now() - state.lastUpdated.getTime()) / 1000);
    if (d < 10) dom.lastUpdate.textContent = "الآن";
    else if (d < 60) dom.lastUpdate.textContent = `قبل ${d} ثانية`;
    else if (d < 3600) dom.lastUpdate.textContent = `قبل ${Math.floor(d / 60)} دقيقة`;
    else dom.lastUpdate.textContent = `قبل ${Math.floor(d / 3600)} ساعة`;
  };

  // ── Init ──
  const init = async () => {
    ME.initMap();
    initChart();

    // Detect IP location on load
    await detectLocation();

    // Tab clicks
    assetBtns.forEach(b => b.addEventListener("click", () => setAsset(b.dataset.asset)));

    // Country panel close button
    dom.cpdClose.addEventListener("click", hideCountryPanel);

    // Country click → show in side panel (NO popup)
    try {
      await ME.loadCountries((countryInfo) => {
        showCountryPanel(countryInfo);
      });
      if (state.userLocation && state.userLocation.countryCode) {
        ME.focusCountry(state.userLocation.countryCode);
      }
    } catch (err) {
      console.warn("GeoJSON load error:", err);
      showToast("تعذر تحميل خريطة الدول حالياً.");
    }

    // Initial data fetch
    setAsset(state.asset);
    updateTime();
    setInterval(updateTime, 1000);
    setInterval(refreshMyfxbook, REFRESH_MS);
  };

  window.addEventListener("DOMContentLoaded", init);
})();
