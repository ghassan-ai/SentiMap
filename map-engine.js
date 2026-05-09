/* map-engine.js — Map, GeoJSON, country highlighting */
window.MapEngine = (() => {
  const C = window.SM_CONFIG;
  let map, countryLayer, badgeLayer, mfbLineLayer, mfbPanelLayer;
  let countryMetaByCode = {}, countryMetaByName = {}, countryCenterByCode = {};
  let _selectedLayer = null;
  let _mfbOverlays = [];
  let _onCountrySelect = null;  // callback when country is clicked
  let _popup = null;

  const fmt = r => `${Math.round(r * 100)}%`;
  const fmtPct = v => (Number.isFinite(v) ? `${v.toFixed(2)}%` : "--");
  const fmtCount = v => (Number.isFinite(v) ? new Intl.NumberFormat("en-US").format(Math.round(v)) : "--");
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const pctToRatio = v => {
    if (!Number.isFinite(v)) return null;
    return v > 1 ? v / 100 : v;
  };
  const getBuyRatio = entry => {
    if (!entry) return null;
    if (Number.isFinite(entry.buyRatio)) return entry.buyRatio;
    const longRatio = pctToRatio(entry.longPercentage);
    if (Number.isFinite(longRatio)) return longRatio;
    const shortRatio = pctToRatio(entry.shortPercentage);
    if (Number.isFinite(shortRatio)) return 1 - shortRatio;
    return null;
  };
  const getColor = r => {
    if (r >= 0.7) return C.COLORS.buyStrong;
    if (r >= 0.55) return C.COLORS.buySoft;
    if (r >= 0.45) return C.COLORS.neutral;
    if (r >= 0.3) return C.COLORS.sellSoft;
    return C.COLORS.sellStrong;
  };
  const getClass = r => {
    if (r >= 0.7) return "buy-strong";
    if (r >= 0.55) return "buy-soft";
    if (r >= 0.45) return "neutral";
    if (r >= 0.3) return "sell-soft";
    return "sell-strong";
  };
  const toFlag = code => {
    if (!code || code.length !== 2) return "🏳️";
    return String.fromCodePoint(...code.toUpperCase().split("").map(c => 127397 + c.charCodeAt(0)));
  };
  const mapContinent = c => c || "Asia";
  const DEFAULT_CENTER = [20, 0];
  const normalizeName = v => (v || "").toString().trim().toLowerCase().replace(/\s+/g, " ");

  const getKey = feature => {
    const p = feature.properties || {};
    return (p.ISO_A2||p.iso_a2||p.ISO_A3||p.iso_a3||feature.id||p.ADMIN||p.name||"").toUpperCase();
  };

  const NO_DATA_COLOR = "#2b3036";

  /* ── Default + highlight styles ── */
  const defaultStyle = {
    color: NO_DATA_COLOR,
    weight: 0.6,
    fillColor: NO_DATA_COLOR,
    fillOpacity: 0.45
  };

  const highlightStyle = {
    color: "#00fff2",
    weight: 2.5,
    fillColor: "rgba(0,255,242,0.08)",
    fillOpacity: 0.08
  };

  /* ── Init Map ── */
  const initMap = () => {
    const mapCfg = C.MAP || {};
    const minZoom = mapCfg.minZoom ?? 2;
    const panZoom = mapCfg.panZoom ?? Math.max(3, minZoom + 1);
    const maxBounds = mapCfg.maxBounds || [[-85, -180], [85, 180]];
    const mapOptions = {
      center: DEFAULT_CENTER,
      zoom: minZoom,
      minZoom,
      zoomControl: false,
      worldCopyJump: false,
      scrollWheelZoom: true,
      dragging: false,
      maxBounds,
      maxBoundsViscosity: 1.0
    };
    if (mapCfg.maxZoom != null) mapOptions.maxZoom = mapCfg.maxZoom;
    map = L.map("map", mapOptions);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png", {
      attribution: "&copy; OpenStreetMap &copy; CARTO", maxZoom: 19
    }).addTo(map);
    L.control.zoom({ position: "bottomleft" }).addTo(map);
    badgeLayer = L.layerGroup().addTo(map);

    map.createPane("mfb-lines");
    map.createPane("mfb-panels");
    map.getPane("mfb-lines").style.zIndex = 450;
    map.getPane("mfb-panels").style.zIndex = 460;
    map.getPane("mfb-lines").style.pointerEvents = "none";
    map.getPane("mfb-panels").style.pointerEvents = "none";
    mfbLineLayer = L.layerGroup({ pane: "mfb-lines" }).addTo(map);
    mfbPanelLayer = L.layerGroup({ pane: "mfb-panels" }).addTo(map);
    buildMFBOverlays();

    const setPanState = () => {
      const canPan = map.getZoom() >= panZoom;
      if (canPan) {
        map.dragging.enable();
        map.keyboard?.enable();
      } else {
        map.dragging.disable();
        map.keyboard?.disable();
        map.panTo(DEFAULT_CENTER, { animate: true, duration: 0.4 });
      }
    };
    map.on("zoomend", setPanState);
    setPanState();
  };

  /* ── Deselect previously selected country ── */
  const deselectCountry = () => {
    if (_selectedLayer) {
      _selectedLayer.setStyle(_selectedLayer.options.baseStyle || defaultStyle);
      _selectedLayer = null;
    }
    if (_popup && map) {
      map.closePopup(_popup);
      _popup = null;
    }
  };

  /* ── Select a country ── */
  const selectCountry = (layer) => {
    deselectCountry();
    _selectedLayer = layer;
    layer.setStyle(highlightStyle);
    layer.bringToFront();

    const feature = layer.feature;
    const p = feature.properties || {};
    const iso2 = (p.ISO_A2||p.iso_a2||"").toUpperCase();
    const name = p.ADMIN || p.name || p.NAME || "--";
    const entry = resolveEntry(feature);

    if (_onCountrySelect) {
      _onCountrySelect({
        name,
        code: iso2,
        flag: iso2.length === 2 ? toFlag(iso2) : "🏳️",
        entry
      });
    }

    const popupContent = getPopupContent(feature, entry);
    const center = layer.getBounds().getCenter();
    _popup = L.popup({
      closeButton: false,
      autoClose: true,
      closeOnClick: true,
      className: "sm-popup-wrapper"
    })
      .setLatLng(center)
      .setContent(popupContent)
      .openOn(map);
  };

  /* ── Focus on User Country ── */
  const focusCountry = (countryCode) => {
    if (!countryLayer || !countryCode) return;
    const code = countryCode.toUpperCase();
    countryLayer.eachLayer(layer => {
      const feature = layer.feature;
      if (getKey(feature) === code || (feature.properties?.ISO_A2 || "").toUpperCase() === code) {
        map.fitBounds(layer.getBounds(), { padding: [50, 50], maxZoom: 4, animate: true });
        
        // Temporarily highlight the country
        const oldStyle = layer.options.baseStyle || defaultStyle;
        layer.setStyle({ color: C.COLORS.highlight, weight: 3, fillColor: C.COLORS.highlight, fillOpacity: 0.3 });
        layer.bringToFront();
        
        setTimeout(() => {
           if (layer !== _selectedLayer) layer.setStyle(oldStyle);
        }, 4000);
      }
    });
  };

  /* ── Load GeoJSON ── */
  const loadCountries = async (onCountryClick) => {
    _onCountrySelect = onCountryClick;
    const url = "https://raw.githubusercontent.com/datasets/geo-countries/master/data/countries.geojson";
    const resp = await fetch(url);
    const geojson = await resp.json();
    countryMetaByCode = {}; countryMetaByName = {}; countryCenterByCode = {};

    geojson.features.forEach(f => {
      const p = f.properties || {};
      const iso2 = (p.ISO_A2||p.iso_a2||"").toUpperCase();
      const iso3 = (p.ISO_A3||p.iso_a3||f.id||"").toUpperCase();
      const name = p.ADMIN||p.name||p.NAME||"";
      const continent = p.CONTINENT||p.continent||"";
      const region = mapContinent(continent);
      if (iso2 && iso2 !== "-99") countryMetaByCode[iso2] = { name, code: iso2, continent, region };
      if (iso3 && iso3 !== "-99") countryMetaByCode[iso3] = { name, code: iso3, continent, region };
      if (name) countryMetaByName[name.toLowerCase()] = { name, code: iso2||iso3, continent, region };
    });

    countryLayer = L.geoJSON(geojson, {
      style: feature => {
        return defaultStyle;
      },
      onEachFeature: (feature, layer) => {
        layer.options.baseStyle = defaultStyle; // Store base style
        const p = feature.properties || {};
        const iso2 = (p.ISO_A2||p.iso_a2||"").toUpperCase();
        const iso3 = (p.ISO_A3||p.iso_a3||feature.id||"").toUpperCase();
        const center = layer.getBounds().getCenter();

        if (iso2 && iso2 !== "-99") countryCenterByCode[iso2] = center;
        if (iso3 && iso3 !== "-99") countryCenterByCode[iso3] = center;

        // Click → select
        layer.on("click", () => selectCountry(layer));
      }
    }).addTo(map);
  };

  /* ── MFB Overlay: connectors + ocean panels ── */
  const buildMFBOverlays = () => {
    if (!mfbLineLayer || !mfbPanelLayer) return;
    mfbLineLayer.clearLayers();
    mfbPanelLayer.clearLayers();
    _mfbOverlays = [];

    const overlays = Array.isArray(C.MFB_OVERLAYS) ? C.MFB_OVERLAYS : [];
    const panelSize = C.MFB_PANEL_SIZE || { width: 190, height: 36 };

    overlays.forEach(cfg => {
      if (!cfg?.land || !cfg?.ocean) return;

      const lineGlow = L.polyline([cfg.land, cfg.ocean], {
        pane: "mfb-lines",
        color: C.COLORS.neutral,
        weight: 6,
        opacity: 0.3,
        className: "mfb-connector-glow",
        interactive: false
      });
      const lineCore = L.polyline([cfg.land, cfg.ocean], {
        pane: "mfb-lines",
        color: C.COLORS.neutral,
        weight: 2,
        opacity: 0.95,
        className: "mfb-connector-core",
        interactive: false
      });
      mfbLineLayer.addLayer(lineGlow);
      mfbLineLayer.addLayer(lineCore);

      const marker = L.marker(cfg.ocean, {
        pane: "mfb-panels",
        interactive: false,
        icon: L.divIcon({
          className: "mfb-panel-marker",
          html: `<div class="mfb-panel mfb-offline" data-mfb="${cfg.id}">
            <span class="mfb-panel-name">${cfg.label}</span>
            <span class="mfb-panel-value">--</span>
          </div>`,
          iconSize: [panelSize.width, panelSize.height],
          iconAnchor: [panelSize.width / 2, panelSize.height / 2]
        })
      });
      mfbPanelLayer.addLayer(marker);
      _mfbOverlays.push({ cfg, marker, lineGlow, lineCore });
    });
  };

  const getMFBColor = r => (r >= 0.5 ? C.COLORS.buyStrong : C.COLORS.sellStrong);

  const updateMFBOverlays = (mfbData, mfbAvailable) => {
    _mfbOverlays.forEach(ov => {
      const ratio = mfbData; // mfbData is the buyRatio number directly if available from app.js

      const el = ov.marker.getElement()?.querySelector(".mfb-panel");
      const valueEl = el?.querySelector(".mfb-panel-value");

      if (!el || !valueEl) return;

      if (!mfbAvailable || !Number.isFinite(ratio)) {
        el.classList.add("mfb-offline");
        el.classList.remove("mfb-buy", "mfb-sell");
        valueEl.textContent = "غير متصل";
        ov.lineGlow.setStyle({ color: C.COLORS.neutral, opacity: 0.12 });
        ov.lineCore.setStyle({ color: C.COLORS.neutral, opacity: 0.5 });
        return;
      }

      const isBuy = ratio >= 0.5;
      const pct = Math.round((isBuy ? ratio : 1 - ratio) * 100);
      valueEl.textContent = `${isBuy ? "📈" : "📉"} ${pct}%`;
      el.classList.toggle("mfb-buy", isBuy);
      el.classList.toggle("mfb-sell", !isBuy);
      el.classList.remove("mfb-offline");

      const color = getMFBColor(ratio);
      ov.lineGlow.setStyle({ color, opacity: 0.45 });
      ov.lineCore.setStyle({ color, opacity: 1 });
    });
  };

  /* ── Stats & Styles ── */
  let _stats = {};
  let _nameIndex = {};
  let _nameEntries = [];
  const resolveEntry = (feature) => {
    const p = feature.properties || {};
    const key = getKey(feature);
    if (_stats[key]) return _stats[key];

    const iso2 = (p.ISO_A2 || p.iso_a2 || "").toUpperCase();
    const iso3 = (p.ISO_A3 || p.iso_a3 || feature.id || "").toUpperCase();
    if (_stats[iso2]) return _stats[iso2];
    if (_stats[iso3]) return _stats[iso3];

    const name = normalizeName(p.ADMIN || p.name || p.NAME || "");
    if (name && _nameIndex[name]) return _nameIndex[name];

    if (name && _nameEntries.length) {
      let best = null;
      let bestLen = 0;
      _nameEntries.forEach(({ name: entryName, entry }) => {
        if (!entryName) return;
        if (name.includes(entryName) || entryName.includes(name)) {
          const len = Math.min(name.length, entryName.length);
          if (len > bestLen) {
            best = entry;
            bestLen = len;
          }
        }
      });
      if (best) return best;
    }
    return null;
  };
  const getPopupContent = (feature, entry) => {
    const p = feature.properties || {};
    const name = p.ADMIN || p.name || "--";
    const iso2 = (p.ISO_A2 || p.iso_a2 || "").toUpperCase();
    const flag = iso2.length === 2 ? toFlag(iso2) : "🏳️";

    if (!entry) {
      return `<div class="sm-popup">
        <div class="sm-popup-title"><span class="sm-popup-flag">${flag}</span><span class="sm-popup-name">${name}</span></div>
        <div class="sm-popup-empty">لا توجد بيانات لهذه الدولة</div>
      </div>`;
    }

    const buyRatio = getBuyRatio(entry);
    const buyPct = Number.isFinite(entry.longPercentage)
      ? entry.longPercentage
      : (Number.isFinite(buyRatio) ? buyRatio * 100 : null);
    const sellPct = Number.isFinite(entry.shortPercentage)
      ? entry.shortPercentage
      : (Number.isFinite(buyRatio) ? (1 - buyRatio) * 100 : null);
    let buyWidth = Number.isFinite(buyPct) ? clamp(buyPct, 0, 100) : null;
    let sellWidth = Number.isFinite(sellPct) ? clamp(sellPct, 0, 100) : null;
    if (buyWidth === null && sellWidth === null) {
      buyWidth = 50;
      sellWidth = 50;
    } else if (buyWidth === null) {
      buyWidth = 100 - sellWidth;
    } else if (sellWidth === null) {
      sellWidth = 100 - buyWidth;
    }

    return `<div class="sm-popup">
      <div class="sm-popup-title"><span class="sm-popup-flag">${flag}</span><span class="sm-popup-name">${name}</span></div>
      <div class="sm-popup-row"><span class="sm-popup-label">المشترين</span><span class="sm-popup-value buy">${fmtCount(entry.longPositions)}</span></div>
      <div class="sm-popup-row"><span class="sm-popup-label">البائعين</span><span class="sm-popup-value sell">${fmtCount(entry.shortPositions)}</span></div>
      <div class="sm-popup-pct">
        <span class="sm-popup-pill buy">شراء ${fmtPct(buyPct)}</span>
        <span class="sm-popup-pill sell">بيع ${fmtPct(sellPct)}</span>
      </div>
      <div class="sm-popup-bar">
        <div class="sm-popup-bar-fill buy" style="width:${buyWidth}%"></div>
        <div class="sm-popup-bar-fill sell" style="width:${sellWidth}%"></div>
      </div>
    </div>`;
  };

  const setStats = stats => {
    _stats = stats || {};
    _nameIndex = {};
    _nameEntries = [];
    Object.values(_stats).forEach((entry) => {
      const name = normalizeName(entry?.name);
      if (!name) return;
      _nameIndex[name] = entry;
      _nameEntries.push({ name, entry });
    });
    return _stats;
  };

  const computeStats = stats => setStats(stats);

  const updateStyles = (stats) => {
    if (!countryLayer) return;
    const normalized = stats || {};
    setStats(normalized);
    badgeLayer.clearLayers();

    countryLayer.eachLayer(layer => {
      const feature = layer.feature;
      const entry = resolveEntry(feature);
      const entryRatio = getBuyRatio(entry);

      let borderColor = NO_DATA_COLOR;
      let fillColor = NO_DATA_COLOR;
      let fillOpacity = 0.45;
      let weight = 0.6;

      if (Number.isFinite(entryRatio)) {
        const c = getColor(entryRatio);
        borderColor = c;
        fillColor = c;
        fillOpacity = 0.6;
        weight = 1.4;
      }

      layer.options.baseStyle = {
        color: borderColor,
        weight: weight,
        fillColor: fillColor,
        fillOpacity: fillOpacity
      };

      if (layer !== _selectedLayer) {
        layer.setStyle(layer.options.baseStyle);
      }

    });
    return _stats;
  };

  return {
    initMap, loadCountries, updateStyles, computeStats, setStats, focusCountry,
    deselectCountry, updateMFBOverlays,
    getKey, getColor, getClass, toFlag, fmt, clamp, mapContinent,
    getMeta: code => countryMetaByCode[code],
    getMetaByName: name => countryMetaByName[name?.toLowerCase()],
    getStats: () => _stats
  };
})();
