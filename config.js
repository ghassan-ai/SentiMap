window.SM_CONFIG = {
  firebase: {
    apiKey: "AIzaSyAKq17JBF5HfSc7mAgV_1QubqJpou20iJ0",
    authDomain: "sentimap-f8f61.firebaseapp.com",
    projectId: "sentimap-f8f61",
    storageBucket: "sentimap-f8f61.firebasestorage.app",
    messagingSenderId: "793949448189",
    appId: "1:793949448189:web:03e51036e5cb8b3daa9b94",
    measurementId: "G-EN7VT905HC"
  },
  ASSETS: {
    gold: { label: "ذهب", symbol: "XAUUSD" },
    silver: { label: "فضة", symbol: "XAGUSD" }
  },
  COLORS: {
    buyStrong: "#2ea043", buySoft: "#3fbf5f",
    neutral: "#8b949e",
    sellSoft: "#f47067", sellStrong: "#da3633",
    highlight: "#00fff2"
  },
  MFB_PANEL_SIZE: { width: 190, height: 36 },
  MFB_OVERLAYS: [
    { id: "northAmerica", label: "أمريكا الشمالية", land: [50, -125], ocean: [35, -160] },
    { id: "southAmerica", label: "أمريكا الجنوبية", land: [-15, -75], ocean: [-25, -110] },
    { id: "europe", label: "أوروبا", land: [50, -10], ocean: [45, -35] },
    { id: "africa", label: "أفريقيا", land: [5, -5], ocean: [-10, -30] },
    { id: "asia", label: "آسيا", land: [35, 135], ocean: [30, 165] },
    { id: "oceania", label: "أوقيانوسيا", land: [-25, 135], ocean: [-35, 170] }
  ],
  MAP: {
    minZoom: 2,
    panZoom: 3,
    maxBounds: [[-85, -180], [85, 180]]
  }
};
