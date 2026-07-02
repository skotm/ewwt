import { useState, useEffect, useLayoutEffect, useMemo, useRef, forwardRef } from "react";

/* ─────────────────────────────────────────────────────
   TRUE LIQUID GLASS
   
   Apple iOS 26 の物理モデル:
   - ガラス面 = ほぼ透明（tint なし）
   - 縁 = 光が屈折・集光 → feDisplacementMap で歪み
   - ハイライト = 縁の外側だけに細い白線（rim light）
   - 内部コンテンツは読みやすいよう最低限のblurのみ
   ───────────────────────────────────────────────────── */

const ALERT = { level: "warning", title: "大雨警報", region: "東京都・神奈川県" };

const LAYERS = [
  { id: "radar",   label: "雨雲レーダー", on: true  },
  { id: "quake",   label: "震度分布",     on: false },
  { id: "tsunami", label: "津波予報区",   on: false },
  { id: "river",   label: "河川水位",     on: true  },
  { id: "hazard",  label: "ハザード",     on: false },
  { id: "evac",    label: "避難所",       on: false },
];

const NAV = [
  { id: "quake",    label: "地震",   path: null },
  { id: "tsunami",  label: "津波",   path: null },
  { id: "weather",  label: "気象",   path: null },
  { id: "alert",    label: "警報",   path: null },
  { id: "settings", label: "設定",   path: null },
];

/* ─────────────────────────────────────────────────────
   SVG FILTERS
   真のLiquid Glass屈折: 縁にだけ歪みが集中する
   ───────────────────────────────────────────────────── */
function Filters() {
  return (
    <svg width="0" height="0" style={{ position: "absolute", overflow: "hidden" }} aria-hidden>
      <defs>

        {/* ── 縁屈折フィルタ（ピル・サークル用）────────────── */}
        {/*
            仕組み:
            1. SourceGraphic のアルファ境界を erode で細く取り出す
            2. その境界マスクで displacement をかける
            → 縁の内側だけ背景が歪む = ガラスの縁レンズ効果
        */}
        <filter id="lg-refract" x="-4%" y="-4%" width="108%" height="108%"
                colorInterpolationFilters="sRGB" primitiveUnits="userSpaceOnUse">
          {/* 境界マスク生成: ごく薄い縁のみ */}
          <feMorphology in="SourceAlpha" operator="erode" radius="0.5" result="inner"/>
          <feMorphology in="SourceAlpha" operator="dilate" radius="1" result="outer"/>
          <feComposite in="outer" in2="inner" operator="out" result="rim"/>
          <feGaussianBlur in="rim" stdDeviation="1.2" result="rimBlur"/>

          {/* 歪みベクター: 細かいノイズ＋縁マスク合成 */}
          <feTurbulence type="fractalNoise" baseFrequency="0.03 0.03"
                        numOctaves="1" seed="8" result="noise"/>
          <feComposite in="noise" in2="rimBlur" operator="in" result="edgeNoise"/>

          {/* 縁だけ歪む displacement — scaleを最小限に */}
          <feDisplacementMap in="SourceGraphic" in2="edgeNoise"
                             scale="2.5"
                             xChannelSelector="R" yChannelSelector="G"/>
        </filter>

        {/* ── 小型コントロール用（歪みさらに控えめ）───────────────── */}
        <filter id="lg-refract-sm" x="-6%" y="-6%" width="112%" height="112%"
                colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.05 0.05"
                        numOctaves="1" seed="3" result="noise"/>
          <feMorphology in="SourceAlpha" operator="erode" radius="0.5" result="inner"/>
          <feMorphology in="SourceAlpha" operator="dilate" radius="1" result="outer"/>
          <feComposite in="outer" in2="inner" operator="out" result="rim"/>
          <feGaussianBlur in="rim" stdDeviation="1" result="rimBlur"/>
          <feComposite in="noise" in2="rimBlur" operator="in" result="edgeNoise"/>
          <feDisplacementMap in="SourceGraphic" in2="edgeNoise"
                             scale="1.5"
                             xChannelSelector="R" yChannelSelector="G"/>
        </filter>

        {/* ── クロマティック・アベレーション（色収差）────────── */}
        {/* ガラスの縁で赤と青がわずかにずれる */}
        <filter id="lg-chroma" x="-4%" y="-4%" width="108%" height="108%"
                colorInterpolationFilters="sRGB">
          <feColorMatrix type="matrix"
                         values="1    0    0    0   0.004
                                 0    1    0    0   0
                                 0    0    1    0  -0.004
                                 0    0    0    1   0"/>
        </filter>

      </defs>
    </svg>
  );
}

/* ─────────────────────────────────────────────────────
   LIQUID GLASS SURFACE COMPONENT
   
   背景:  backdrop-filter: blur のみ（色付けない）
   面:    rgba(0,0,0,0) — 完全透明
   縁:    SVGフィルタで屈折 + CSSで細い白rim
   ───────────────────────────────────────────────────── */
const Glass = forwardRef(function Glass({
  children,
  radius = 20,
  style,
  filterSize = "normal",  // "normal" | "sm" | "none"
  blur = 14,               // backdrop blur量(px)。アニメーション中だけ軽くしたい場合に上書きする
  ...rest
}, ref) {
  // filterSize="none" の場合は屈折SVGフィルタを外し、単純なbackdrop blurのみにする
  // （リサイズや角丸トランジション中など、フィルタの再計算コストが重くなる場面用の軽量モード）
  const filterId = filterSize === "none" ? null : filterSize === "sm" ? "lg-refract-sm" : "lg-refract";

  return (
    <div
      ref={ref}
      style={{
        position: "relative",
        borderRadius: radius,
        isolation: "isolate",
        ...style,
      }}
      {...rest}
    >
      {/* 屈折・背景ブラー層: コンテンツとは完全に分離し、これだけにfilterを適用 */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: "inherit",
          backdropFilter: `blur(${blur}px) saturate(140%)`,
          WebkitBackdropFilter: `blur(${blur}px) saturate(140%)`,
          background: "rgba(255,255,255,0.02)",
          filter: filterId ? `url(#${filterId})` : undefined,
          zIndex: 0,
        }}
      />
      {/* 縁のrim light: シャープな1pxの白線、歪みなし */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: "inherit",
          boxShadow: `
            inset 0 0 0 0.75px rgba(255,255,255,0.45),
            inset 0 1px 0 rgba(255,255,255,0.55)
          `,
          pointerEvents: "none",
          zIndex: 1,
        }}
      />
      {/* コンテンツ層: 歪みフィルタの影響を一切受けない */}
      <div style={{ position: "relative", zIndex: 2, width: "100%", height: "100%" }}>
        {children}
      </div>
    </div>
  );
});

/* ─────────────────────────────────────────────────────
   GLOBAL STYLES
   ───────────────────────────────────────────────────── */
function GlobalStyles() {
  return (
    <style>{`
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
      html, body, #root { height: 100%; width: 100%; }
      html {
        overflow: hidden;
        background: #121214;
      }
      body {
        /*
          position:fixed でページ自体を完全に固定する。
          iOSのSafariは、地図をドラッグした際に地図だけでなく
          ページ全体がわずかに弾性スクロール(ラバーバンド)してしまうことがあり、
          その一瞬だけSafariのデフォルトのUI背景(白)が画面端に見えてしまう。
          overscroll-behavior だけでは防ぎきれないため、position:fixedで
          ページ自体をスクロール不可能な状態に固定して根本的に防ぐ。
        */
        position: fixed;
        inset: 0;
        background: #121214;
        font-family: -apple-system, BlinkMacSystemFont,
                     "SF Pro Display", "Helvetica Neue",
                     "Noto Sans JP", sans-serif;
        -webkit-font-smoothing: antialiased;
        overflow: hidden;
        overscroll-behavior: none;
        touch-action: none;
        color: #fff;
      }
      #root {
        position: absolute;
        inset: 0;
        overflow: hidden;
      }
      button { font-family: inherit; background: none; border: none; cursor: pointer; }

      @keyframes pulse {
        0%,100% { opacity:1; transform:scale(1); box-shadow: 0 0 0 0 currentColor; }
        50%      { opacity:0.4; transform:scale(0.55); }
      }
      @keyframes appear {
        from { opacity:0; transform:translateY(10px) scale(0.97); }
        to   { opacity:1; transform:translateY(0)    scale(1); }
      }
      /* レイヤーパネルはキーフレームではなく transform/opacity の
         トランジションで開閉する（下部アイコンバーへ向けて滑らかに
         スライスイン・アウトできるよう、常時マウントして状態だけ切替える） */
      @keyframes fadeIn {
        from { opacity:0; }
        to   { opacity:1; }
      }
      @keyframes spin {
        to { transform: rotate(360deg); }
      }

      /* MapLibreの標準UIはLiquid Glassの自前コントロールに置き換えるため非表示 */
      .maplibregl-ctrl-top-right,
      .maplibregl-ctrl-top-left,
      .maplibregl-ctrl-bottom-left,
      .maplibregl-ctrl-bottom-right,
      .maplibregl-control-container { display: none; }

      .mono { font-variant-numeric: tabular-nums; }

      @media (prefers-reduced-motion: reduce) {
        *, *::before, *::after {
          animation-duration: 0.01ms !important;
          transition-duration: 0.01ms !important;
        }
      }
    `}</style>
  );
}

/* ─────────────────────────────────────────────────────
   MAPLIBRE LOADER
   CDNからmaplibre-gl本体とCSSを動的読み込みする
   （Reactアーティファクト環境にはnpmパッケージが無いため）
   ───────────────────────────────────────────────────── */
const MAPLIBRE_JS  = "https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/4.7.1/maplibre-gl.js";
const MAPLIBRE_CSS = "https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/4.7.1/maplibre-gl.css";

let maplibreLoadPromise = null;
function loadMapLibre() {
  if (window.maplibregl) return Promise.resolve(window.maplibregl);
  if (maplibreLoadPromise) return maplibreLoadPromise;

  maplibreLoadPromise = new Promise((resolve, reject) => {
    if (!document.querySelector(`link[href="${MAPLIBRE_CSS}"]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = MAPLIBRE_CSS;
      document.head.appendChild(link);
    }
    const existing = document.querySelector(`script[src="${MAPLIBRE_JS}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve(window.maplibregl));
      return;
    }
    const script = document.createElement("script");
    script.src = MAPLIBRE_JS;
    script.async = true;
    script.onload = () => resolve(window.maplibregl);
    script.onerror = () => reject(new Error("MapLibre GL JS の読み込みに失敗しました"));
    document.head.appendChild(script);
  });

  return maplibreLoadPromise;
}

/* ─────────────────────────────────────────────────────
   GEO DATA LOADER
   /map/world.json (GeometryCollection・国境) と
   /map/prefectures.json (FeatureCollection・都道府県) を取得し、
   ブラウザの localStorage にキャッシュする。
   ファイル構成:
     public/
     └─ map/
        ├─ world.json
        └─ prefectures.json

   注意: localStorage は容量上限が一般的に 5〜10MB 程度(ブラウザ依存)。
   world.json は比較的大きいファイルのため、容量超過時は保存に失敗することがある。
   その場合は例外を握りつぶしてキャッシュなしで動作を継続する
   (=毎回ネットワークから取得するだけで、アプリ自体は問題なく動く)。
   ───────────────────────────────────────────────────── */
const GEO_CACHE_VERSION = "v1"; // データ更新時はここを上げるとキャッシュを無効化できる

function readGeoCache(cacheKey) {
  try {
    const raw = localStorage.getItem(cacheKey);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null; // 壊れたキャッシュ/JSON.parse失敗時は無視してネットワークから再取得
  }
}

function writeGeoCache(cacheKey, data) {
  try {
    localStorage.setItem(cacheKey, JSON.stringify(data));
  } catch {
    // QuotaExceededError など。キャッシュできなくてもアプリの動作自体は継続する。
    console.warn(`地図データのローカルキャッシュに失敗しました(${cacheKey})。容量超過の可能性があります。`);
  }
}

function cachedFetchJSON(url, cacheKey) {
  const cached = readGeoCache(cacheKey);
  if (cached) return Promise.resolve(cached);

  return fetch(url).then(r => {
    if (!r.ok) throw new Error(`${url} の取得に失敗しました (${r.status})`);
    return r.json();
  }).then(data => {
    writeGeoCache(cacheKey, data);
    return data;
  });
}

let geoDataPromise = null;
function loadGeoData() {
  if (geoDataPromise) return geoDataPromise;
  geoDataPromise = Promise.all([
    cachedFetchJSON(`${import.meta.env.BASE_URL}map/world.json`, `geo:${GEO_CACHE_VERSION}:world`),
    cachedFetchJSON(`${import.meta.env.BASE_URL}map/prefectures.json`, `geo:${GEO_CACHE_VERSION}:prefectures`),
  ]).then(([world, prefectures]) => ({ world, prefectures }));
  return geoDataPromise;
}

/* ─────────────────────────────────────────────────────
   MAPLIBREスタイル生成
   ローカルのworld.json(GeometryCollection)・prefectures.json(FeatureCollection)を
   そのままGeoJSONソースとしてMapLibreに渡し、ダークテーマで塗り分ける。
   外部タイルサーバー・外部スタイルには一切依存しない。
   ───────────────────────────────────────────────────── */
function buildMapStyle({ world, prefectures }) {
  return {
    version: 8,
    sources: {
      world: { type: "geojson", data: world },
      prefectures: { type: "geojson", data: prefectures },
    },
    layers: [
      { id: "bg", type: "background", paint: { "background-color": "#121214" } },
      {
        id: "world-fill", type: "fill", source: "world",
        paint: { "fill-color": "#2c2c2e" },
      },
      {
        id: "world-line", type: "line", source: "world",
        paint: { "line-color": "rgba(255,255,255,0.08)", "line-width": 0.5 },
      },
      {
        id: "prefectures-fill", type: "fill", source: "prefectures",
        paint: { "fill-color": "#3a3a3c" },
      },
      {
        id: "prefectures-line", type: "line", source: "prefectures",
        paint: { "line-color": "rgba(255,255,255,0.18)", "line-width": 0.6 },
      },
    ],
  };
}

/* ─────────────────────────────────────────────────────
   MAP CANVAS — MapLibre GL JS(描画エンジン) + ローカルGeoJSON(データ)
   世界(world.json)・都道府県(prefectures.json)をベクターとして描画する。
   外部タイル・外部スタイルサーバーには依存しない。
   ───────────────────────────────────────────────────── */
function MapCanvas({ onReady, stationPoints, hypocenter }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const [status, setStatus] = useState("loading"); // loading | ready | error
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    let cancelled = false;

    Promise.all([loadMapLibre(), loadGeoData()])
      .then(([maplibregl, geo]) => {
        if (cancelled || !containerRef.current) return;

        let map;
        try {
          map = new maplibregl.Map({
            container: containerRef.current,
            style: buildMapStyle(geo),
            center: [138.0, 38.0], // 日本全体が収まる中心付近
            zoom: 4.5,
            pitch: 0,
            attributionControl: false,
            // ナビゲーション操作はLiquid Glassの自前ボタンで行うため
            // 標準コントロールはあえて追加しない
          });
        } catch (constructErr) {
          console.error("MapLibre Map construction failed:", constructErr);
          if (!cancelled) {
            setStatus("error");
            setErrorMsg("地図の初期化に失敗: " + (constructErr.message || String(constructErr)));
          }
          return;
        }

        map.on("load", () => {
          if (cancelled) return;

          // 震源(バツ印)アイコンを生成してMapLibreへ登録しておく。
          // canvasで太めの赤いバツ印を描き、addImageでシンボル画像として使う。
          const size = 28;
          const canvas = document.createElement("canvas");
          canvas.width = size; canvas.height = size;
          const c = canvas.getContext("2d");
          c.strokeStyle = "#FF453A";
          c.lineWidth = 4;
          c.lineCap = "round";
          const pad = 6;
          c.beginPath();
          c.moveTo(pad, pad); c.lineTo(size - pad, size - pad);
          c.moveTo(size - pad, pad); c.lineTo(pad, size - pad);
          c.stroke();
          map.addImage("hypocenter-cross", c.getImageData(0, 0, size, size));

          // 観測点(震度)マーカー用のソース・レイヤーをここで先に用意しておく。
          // データ自体は stationPoints が変わるたびに別のeffectで更新する。
          map.addSource("station-points", {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          });
          map.addLayer({
            id: "station-points-circle",
            type: "circle",
            source: "station-points",
            paint: {
              "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 3, 10, 9],
              "circle-color": ["get", "color"],
              "circle-stroke-width": 1,
              "circle-stroke-color": "rgba(0,0,0,0.55)",
            },
          });

          // 震源マーカー用のソース・レイヤー(観測点の上に重なるよう最後に追加)
          map.addSource("hypocenter-point", {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          });
          map.addLayer({
            id: "hypocenter-point-symbol",
            type: "symbol",
            source: "hypocenter-point",
            layout: {
              "icon-image": "hypocenter-cross",
              "icon-size": 1,
              "icon-allow-overlap": true,
              "icon-ignore-placement": true,
            },
          });

          setStatus("ready");
          if (onReady) onReady(map);
        });

        map.on("error", (e) => {
          console.error("MapLibre error event:", e?.error || e);
          if (cancelled) return;
          setStatus("error");
          setErrorMsg(e?.error?.message || "地図の描画中にエラーが発生しました");
        });

        mapRef.current = map;
      })
      .catch((err) => {
        console.error("地図の読み込みに失敗:", err);
        if (cancelled) return;
        setStatus("error");
        setErrorMsg(err.message || "地図データまたはMapLibre GL JS本体の読み込みに失敗しました");
      });

    return () => {
      cancelled = true;
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 選択中の地震(stationPoints)が変わるたびに、観測点マーカーのGeoJSONを更新する。
  // 緯度経度が引けなかった観測点(マスタに見つからなかったもの)は地図には出さない。
  // 震度が大きい観測点ほど後(=前面)に描画されるよう、震度の小さい順に並べてからfeature化する
  // (MapLibreのcircleレイヤーは、GeoJSON内でのfeatureの並び順どおりに下から重ねて描画するため)。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    const source = map.getSource("station-points");
    if (!source) return;

    const INTENSITY_ORDER = ["0","1","2","3","4","5-","5+","6-","6+","7"];
    const sorted = (stationPoints || [])
      .filter(p => p.latitude != null && p.longitude != null)
      .slice()
      .sort((a, b) => INTENSITY_ORDER.indexOf(a.intensityKey) - INTENSITY_ORDER.indexOf(b.intensityKey));

    const features = sorted.map(p => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [p.longitude, p.latitude] },
      properties: {
        addr: p.addr,
        pref: p.pref,
        color: (INTENSITY_STYLE[p.intensityKey] || INTENSITY_STYLE["0"]).bg,
      },
    }));

    source.setData({ type: "FeatureCollection", features });
  }, [stationPoints, status]);

  // 選択中の地震(hypocenter)が変わるたびに、震源のバツ印マーカーを更新し、
  // 震源+周辺の観測点がちょうど収まる範囲へズームする。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    const source = map.getSource("hypocenter-point");
    if (!source) return;

    if (!hypocenter || hypocenter.latitude == null || hypocenter.longitude == null) {
      source.setData({ type: "FeatureCollection", features: [] });
      return;
    }

    source.setData({
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        geometry: { type: "Point", coordinates: [hypocenter.longitude, hypocenter.latitude] },
        properties: {},
      }],
    });

    // 震源 + 観測点(緯度経度が引けたもの)が全部収まるbounding boxを作ってfitBoundsする。
    // 観測点が1件も無い(マッチできなかった)場合は、震源を中心にほどよいズームへ寄せる。
    const coords = [[hypocenter.longitude, hypocenter.latitude]];
    (stationPoints || []).forEach(p => {
      if (p.latitude != null && p.longitude != null) coords.push([p.longitude, p.latitude]);
    });

    if (coords.length > 1) {
      let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
      coords.forEach(([lon, lat]) => {
        minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
        minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
      });
      map.fitBounds([[minLon, minLat], [maxLon, maxLat]], {
        padding: { top: 80, bottom: 220, left: 40, right: 40 },
        maxZoom: 9,
        duration: 800,
      });
    } else {
      map.flyTo({ center: [hypocenter.longitude, hypocenter.latitude], zoom: 7, duration: 800 });
    }
  }, [hypocenter, stationPoints, status]);

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: "#121214" }}>
      <div
        ref={containerRef}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          opacity: status === "ready" ? 1 : 0,
          transition: "opacity 0.4s ease",
        }}
      />

      {/* ロード中インジケータ */}
      {status === "loading" && (
        <div style={{
          position: "absolute", inset: 0,
          display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center",
          gap: 10, color: "rgba(255,255,255,0.4)",
        }}>
          <div style={{
            width: 28, height: 28, borderRadius: "50%",
            border: "2px solid rgba(255,255,255,0.15)",
            borderTopColor: "rgba(255,255,255,0.6)",
            animation: "spin 0.8s linear infinite",
          }}/>
          <span style={{ fontSize: 12 }}>地図を読み込み中…</span>
        </div>
      )}

      {/* エラー表示 */}
      {status === "error" && (
        <div style={{
          position: "absolute", inset: 0,
          display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center",
          gap: 10, color: "rgba(255,140,140,0.9)", padding: 24, textAlign: "center",
        }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>地図を表示できませんでした</span>
          <span style={{ fontSize: 12, color: "rgba(255,255,255,0.5)", maxWidth: 280 }}>{errorMsg}</span>
          <span style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", maxWidth: 280, marginTop: 4 }}>
            public/map/world.json と public/map/prefectures.json が正しい場所に
            配置されているか、CDNへのアクセスが制限されていないか確認してください。
          </span>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────
   LIVE CLOCK
   ───────────────────────────────────────────────────── */
function Clock() {
  const [t, setT] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setT(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="mono" style={{ fontSize: 12, color: "rgba(255,255,255,0.5)" }}>
      {t.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
    </span>
  );
}

/* ─────────────────────────────────────────────────────
   ALERT PILL
   ───────────────────────────────────────────────────── */
const ALERT_COLOR = {
  none:      "rgba(255,255,255,0.7)",
  watch:     "#FFD60A",
  warning:   "#FF9F0A",
  emergency: "#FF453A",
};function AlertPill({ alert }) {
  const color = ALERT_COLOR[alert.level] || ALERT_COLOR.none;
  const hasAlert = alert.level !== "none";

  return (
    <Glass
      radius={999}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "9px 16px",
        animation: "appear 0.4s cubic-bezier(.25,1,.5,1)",
      }}
    >
      {hasAlert && (
        <span style={{
          width: 7, height: 7, borderRadius: "50%",
          background: color, flexShrink: 0, color,
          animation: "pulse 1.5s ease-in-out infinite",
          boxShadow: `0 0 8px ${color}`,
          display: "block",
        }}/>
      )}
      <span style={{ fontSize: 13, fontWeight: 600, color }}>
        {alert.title}
      </span>
      <span style={{ fontSize: 13, color: "rgba(255,255,255,0.65)" }}>
        {alert.region}
      </span>
      <div style={{ width: 0.5, height: 13, background: "rgba(255,255,255,0.25)", flexShrink: 0 }}/>
      <Clock/>
    </Glass>
  );
}

/* ─────────────────────────────────────────────────────
   震度スケール — JMA震度階(0〜7、10区分)を液体ガラスのダークUIに合わせて配色。
   明るい色(〜5強)は黒文字、暗く濃い色(6弱〜7)は白文字でコントラストを確保。
   ───────────────────────────────────────────────────── */
const INTENSITY_STYLE = {
  "0":  { bg: "#3A3A3C", fg: "#fff",    label: "0"  },
  "1":  { bg: "#2F6690", fg: "#fff",    label: "1"  },
  "2":  { bg: "#3FA9E0", fg: "#0B0B0C", label: "2"  },
  "3":  { bg: "#4FBF67", fg: "#0B0B0C", label: "3"  },
  "4":  { bg: "#FFD60A", fg: "#0B0B0C", label: "4"  },
  "5-": { bg: "#FF9F0A", fg: "#0B0B0C", label: "5弱" },
  "5+": { bg: "#FF7A1A", fg: "#0B0B0C", label: "5強" },
  "6-": { bg: "#E0342C", fg: "#fff",    label: "6弱" },
  "6+": { bg: "#8A1518", fg: "#fff",    label: "6強" },
  "7":  { bg: "#5C0F1F", fg: "#fff",    label: "7"  },
  "?":  { bg: "#3A3A3C", fg: "rgba(255,255,255,0.5)", label: "?"  }, // 震度が取得できなかった場合(「0」と区別する)
};

// 表示用ラベルを「数字」と「弱/強」に分割する(バッジ内で2段組みにするため)
function splitIntensityLabel(label) {
  const m = /^([0-7])(弱|強)?$/.exec(label);
  if (!m) return { num: label, suffix: null };
  return { num: m[1], suffix: m[2] || null };
}

/* ─────────────────────────────────────────────────────
   P2P地震情報 JSON API (v2)
   https://api.p2pquake.net/v2/history?codes=551
   地震情報(code:551)を取得し、アプリ内で使う形に変換する。
   maxScale は 10刻みの震度コード(10=震度1 ... 70=震度7)で返ってくるため、
   INTENSITY_STYLE のキー("1"〜"7","5-","5+","6-","6+")に変換する。
   ───────────────────────────────────────────────────── */
const P2PQUAKE_HISTORY_URL = "https://api.p2pquake.net/v2/history?codes=551&limit=30";

function maxScaleToIntensityKey(maxScale) {
  const map = {
    "-1": "0", "0": "0",
    "10": "1", "20": "2", "30": "3", "40": "4",
    "45": "5-", "50": "5+",
    "55": "6-", "60": "6+",
    "70": "7",
  };
  return map[String(maxScale)] ?? "?";
}

// API由来のISO風文字列("2024/01/01 12:34:56.789")を "YYYY/MM/DD HH:mm:ss" 表示用に整える
function formatQuakeTime(raw) {
  if (!raw) return "";
  return raw.split(".")[0]; // ミリ秒以下を切り捨てるだけで日本時間表記のまま使える
}

// P2P地震情報APIの1レコードを、QuakeDetailCardが使う形に変換する
function toQuakeCard(item) {
  const eq = item.earthquake;
  const hypo = eq?.hypocenter;
  const points = Array.isArray(item?.points) ? item.points : [];

  // earthquake.maxScaleが欠落/nullのレコードが稀に存在する
  // (震度速報→詳細への更新過程などで一時的に未設定のことがある)。
  // その場合はpoints[]の中の最大scaleから補完し、「震度0」の誤表示を防ぐ。
  let maxScale = eq?.maxScale;
  if (maxScale == null && points.length > 0) {
    maxScale = points.reduce((max, p) => (typeof p.scale === "number" && p.scale > max ? p.scale : max), -1);
  }

  return {
    id: item.id,
    time: formatQuakeTime(eq?.time),
    place: hypo?.name || "震源地不明",
    maxIntensity: maxScaleToIntensityKey(maxScale),
    magnitude: typeof hypo?.magnitude === "number" && hypo.magnitude > 0 ? hypo.magnitude : null,
    depth: typeof hypo?.depth === "number" && hypo.depth >= 0 ? hypo.depth : null,
    longPeriod: null, // P2P地震情報APIには長周期地震動階級は含まれないため常に非表示
    latitude: typeof hypo?.latitude === "number" ? hypo.latitude : null,
    longitude: typeof hypo?.longitude === "number" ? hypo.longitude : null,
    // 観測点ごとの震度。{ pref, addr, scale, isArea }の配列(無ければ空配列)。
    // 注意: pointsは`earthquake`オブジェクトの中ではなく、レコード直下(item.points)にある。
    // scaleは10刻みのJMAコード(10=震度1 ... 70=震度7)のまま保持しておき、
    // 表示側(観測点マッチング後)でINTENSITY_STYLEのキーに変換する。
    points,
    // 国内津波の有無・程度。"None"(心配なし) / "Unknown" / "Checking"(調査中) /
    // "NonEffective"(若干の海面変動) / "Watch"(注意報) / "Warning"(警報) / "MajorWarning"(大津波警報)
    domesticTsunami: eq?.domesticTsunami || "None",
    // 気象庁が付加する自由記述コメント(あれば)
    freeFormComment: item?.comments?.freeFormComment || null,
  };
}

/* ─────────────────────────────────────────────────────
   電文(付加コメント)テキストの組み立て
   domesticTsunami(津波の有無)を基本の文言にし、freeFormComment(付加文)が
   あれば続けて表示する。津波の危険がある場合は色も変える。
   ───────────────────────────────────────────────────── */
const TSUNAMI_TEXT = {
  None:         { text: "この地震による津波の心配はありません。",                 color: "rgba(255,255,255,0.5)" },
  Unknown:      { text: "津波の有無について、現在調査中です。",                   color: "#FFD60A" },
  Checking:     { text: "津波の有無について、現在調査中です。",                   color: "#FFD60A" },
  NonEffective: { text: "若干の海面変動が予想されますが、被害の心配はありません。", color: "#FFD60A" },
  Watch:        { text: "この地震により、津波注意報が発表されています。",         color: "#FF9F0A" },
  Warning:      { text: "この地震により、津波警報が発表されています。",           color: "#FF453A" },
  MajorWarning: { text: "この地震により、大津波警報が発表されています。",         color: "#FF453A" },
};

function buildQuakeMessage(quake) {
  const tsunami = TSUNAMI_TEXT[quake.domesticTsunami] || TSUNAMI_TEXT.None;
  const lines = [{ label: "津波情報", text: tsunami.text, color: tsunami.color }];
  if (quake.freeFormComment) {
    lines.push({ label: "付加文", text: quake.freeFormComment, color: "rgba(255,255,255,0.75)" });
  }
  return lines;
}

// 直近の地震情報一覧を取得する。取得失敗時はエラーを投げる(呼び出し側でハンドリング)。
async function fetchRecentQuakes() {
  const res = await fetch(P2PQUAKE_HISTORY_URL);
  if (!res.ok) throw new Error(`地震情報の取得に失敗しました (${res.status})`);
  const data = await res.json();
  // 「震度速報のみ」等、震源情報が欠けているレコードを除外
  return data
    .filter(item => item.earthquake && item.earthquake.hypocenter && item.earthquake.hypocenter.name)
    .map(toQuakeCard);
}

/* ─────────────────────────────────────────────────────
   P2P地震情報 WebSocket API (v2)
   wss://api.p2pquake.net/v2/ws
   地震情報(code:551)を含む全情報がリアルタイムでpushされてくる。
   最新一覧は起動時に /history で1回だけ取得し(履歴はWebSocketでは
   遡れないため)、以降はこのWebSocketで届いた新着分だけを一覧に追加していく。
   ───────────────────────────────────────────────────── */
const P2PQUAKE_WS_URL = "wss://api.p2pquake.net/v2/ws";

// WebSocketで受信した1件を、地震情報(code:551)であれば変換して返す。
// 対象外(津波予報や緊急地震速報など、まだこのアプリで扱っていない種別)はnullを返す。
function wsMessageToQuakeCard(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (data.code !== 551) return null;
  if (!data.earthquake || !data.earthquake.hypocenter || !data.earthquake.hypocenter.name) return null;
  return toQuakeCard(data);
}

/**
 * P2P地震情報のWebSocketに接続し、地震情報(code:551)を受信するたびにonQuakeを呼ぶ。
 * 接続が切れた場合は一定間隔で自動的に再接続を試みる。
 * 戻り値のclose()を呼ぶと再接続をやめて確実に切断する。
 */
function connectQuakeWebSocket(onQuake, onStatusChange) {
  let ws = null;
  let closedByCaller = false;
  let reconnectTimer = null;

  function connect() {
    if (closedByCaller) return;
    ws = new WebSocket(P2PQUAKE_WS_URL);

    ws.onopen = () => {
      onStatusChange?.("open");
    };

    ws.onmessage = (event) => {
      const quake = wsMessageToQuakeCard(event.data);
      if (quake) onQuake(quake);
    };

    ws.onerror = (e) => {
      console.error("P2P地震情報WebSocketエラー:", e);
    };

    ws.onclose = () => {
      onStatusChange?.("closed");
      if (closedByCaller) return;
      // 5秒後に再接続を試みる(サーバー再起動・回線切断などからの復帰用)
      reconnectTimer = setTimeout(connect, 5000);
    };
  }

  connect();

  return {
    close() {
      closedByCaller = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) ws.close();
    },
  };
}

/* ─────────────────────────────────────────────────────
   観測点マスタ (stations_with_amp_revised.json)
   気象庁 観測点コード・地点名・緯度経度のマスタデータ。
   ファイル構成:
     public/
     └─ map/
        └─ stations_with_amp_revised.json
   ───────────────────────────────────────────────────── */
let stationsPromise = null;
function loadStations() {
  if (stationsPromise) return stationsPromise;
  stationsPromise = cachedFetchJSON(
    `${import.meta.env.BASE_URL}map/stations_with_amp_revised.json`,
    `geo:${GEO_CACHE_VERSION}:stations`
  );
  return stationsPromise;
}

/* ─────────────────────────────────────────────────────
   観測点マッチング
   P2P地震情報APIの points[] (各要素は { pref, addr, scale, isArea }) を、
   観測点マスタ(stations)の地点と突き合わせて緯度経度を割り当てる。
   addr(地点名)とpref(都道府県名)の組み合わせだけが手がかりで、観測点コードが
   直接返ってこないため、以下の2段階でマッチングする(参考にした既存実装と同じ方針):
     1. 地点名が完全一致 かつ 都道府県名が一致
     2. 見つからなければ、都道府県名が一致するものの中から、
        地点名が部分一致(どちらかがどちらかを含む)するものを探す
   複数ヒットした場合は先頭の1件を採用する。
   ───────────────────────────────────────────────────── */
function matchStation(stations, point) {
  const exact = stations.find(s => s.name === point.addr && s.pref.name === point.pref);
  if (exact) return exact;

  const partial = stations.find(s =>
    s.pref.name === point.pref &&
    (s.name.includes(point.addr) || point.addr.includes(s.name) ||
     (s.city && s.city.name && point.addr.includes(s.city.name)))
  );
  return partial || null;
}

// points[]と観測点マスタを突き合わせ、地図・一覧で使える形(緯度経度+震度キー付き)に変換する。
// マスタに見つからなかった観測点は、地図には出せないが一覧には残すため latitude/longitude が null のまま返す。
function resolveStationPoints(points, stations) {
  return points.map(p => {
    const station = matchStation(stations, p);
    return {
      pref: p.pref,
      addr: p.addr,
      intensityKey: maxScaleToIntensityKey(p.scale),
      latitude: station ? parseFloat(station.lat) : null,
      longitude: station ? parseFloat(station.lon) : null,
    };
  });
}


/* ─────────────────────────────────────────────────────
   QUAKE DETAIL CARD
   地震リスト/地図で選択した地震の詳細を表示するカード。
   左に「最大震度」バッジ、右にM/深さ・震源地・発生時刻を積む構成。
   ───────────────────────────────────────────────────── */
function QuakeDetailCard({ quake }) {
  const style = INTENSITY_STYLE[quake.maxIntensity] || INTENSITY_STYLE["1"];
  const { num, suffix } = splitIntensityLabel(style.label);

  return (
    <div
      style={{
        margin: "3px 14px 6px",
        borderRadius: 14,
        padding: "7px 12px",
        display: "flex",
        alignItems: "center",
        gap: 12,
        background: `linear-gradient(135deg, ${style.bg}2E, ${style.bg}14)`,
        boxShadow: "inset 0 0 0 0.5px rgba(255,255,255,0.12)",
        animation: "appear 0.35s cubic-bezier(.25,1,.5,1)",
      }}
    >
      {/* 最大震度バッジ */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, flexShrink: 0 }}>
        <span style={{ fontSize: 9, fontWeight: 600, color: "rgba(255,255,255,0.6)", whiteSpace: "nowrap" }}>
          最大震度
        </span>
        <div
          style={{
            width: 52, padding: "4px 0",
            borderRadius: 10,
            background: style.bg, color: style.fg,
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          }}
        >
          <span className="mono" style={{ fontSize: 22, fontWeight: 800, lineHeight: 1 }}>{num}</span>
          {suffix && (
            <span style={{ fontSize: 10, fontWeight: 700, lineHeight: 1.15 }}>{suffix}</span>
          )}
        </div>
      </div>

      {/* M・深さ / 震源地 / 発生時刻 */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
          <span style={{ fontSize: 10, color: "rgba(255,255,255,0.55)" }}>
            M<span className="mono" style={{ fontSize: 16, fontWeight: 800, color: "#fff", marginLeft: 3 }}>
              {quake.magnitude != null ? quake.magnitude.toFixed(1) : "-"}
            </span>
          </span>
          <span style={{ fontSize: 10, color: "rgba(255,255,255,0.55)" }}>
            深さ<span className="mono" style={{ fontSize: 16, fontWeight: 800, color: "#fff", marginLeft: 3 }}>
              {quake.depth != null ? `${quake.depth}km` : "-"}
            </span>
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
          <span style={{ fontSize: 10, color: "rgba(255,255,255,0.55)", flexShrink: 0 }}>震源地</span>
          <span style={{
            fontSize: 14, fontWeight: 700, color: "#fff",
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          }}>
            {quake.place}
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
          <span style={{ fontSize: 10, color: "rgba(255,255,255,0.55)", flexShrink: 0 }}>発生時刻</span>
          <span className="mono" style={{ fontSize: 10, color: "rgba(255,255,255,0.8)" }}>
            {quake.time}
          </span>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────
   QUAKE MESSAGE CARD — 電文(津波情報・付加文)
   選択中の地震について、津波の心配の有無や気象庁の付加コメントを表示する。
   ───────────────────────────────────────────────────── */
function QuakeMessageCard({ quake }) {
  const lines = buildQuakeMessage(quake);

  return (
    <div style={{ margin: "2px 14px 8px" }}>
      <div style={{
        borderRadius: 12,
        padding: "10px 12px",
        display: "flex", flexDirection: "column", gap: 8,
        background: "rgba(255,255,255,0.04)",
        boxShadow: "inset 0 0 0 0.5px rgba(255,255,255,0.08)",
      }}>
        {lines.map((line, i) => (
          <div key={i} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: line.color }}>
              【{line.label}】
            </span>
            <span style={{ fontSize: 12, color: "rgba(255,255,255,0.85)", lineHeight: 1.5 }}>
              {line.text}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────
   STATION POINTS LIST — 各地の震度
   選択中の地震について、観測点ごとの震度を大きい順に並べて表示する。
   件数が多い地震(数百観測点になることもある)を考慮し、既定では上位のみ表示し、
   「すべて表示」で展開できるようにする。
   ───────────────────────────────────────────────────── */
function StationPointsList({ points }) {
  const [expanded, setExpanded] = useState(false);

  // scale(10刻みのJMAコード)が大きい順 = 震度が大きい順
  const sorted = useMemo(() => {
    return [...points].sort((a, b) => {
      const order = ["0","1","2","3","4","5-","5+","6-","6+","7"];
      return order.indexOf(b.intensityKey) - order.indexOf(a.intensityKey);
    });
  }, [points]);

  if (sorted.length === 0) return null;

  const VISIBLE_COUNT = 10;
  const visible = expanded ? sorted : sorted.slice(0, VISIBLE_COUNT);
  const hasMore = sorted.length > VISIBLE_COUNT;

  return (
    <div style={{ margin: "2px 14px 8px" }}>
      <div style={{
        padding: "6px 2px",
        fontSize: 11, fontWeight: 600, color: "rgba(255,255,255,0.5)",
      }}>
        各地の震度
      </div>

      <div style={{
        borderRadius: 12,
        overflow: "hidden",
        background: "rgba(255,255,255,0.04)",
        boxShadow: "inset 0 0 0 0.5px rgba(255,255,255,0.08)",
      }}>
        {visible.map((p, i) => {
          const style = INTENSITY_STYLE[p.intensityKey] || INTENSITY_STYLE["0"];
          return (
            <div key={`${p.pref}-${p.addr}-${i}`}>
              {i > 0 && <div style={{ height: 0.5, background: "rgba(255,255,255,0.08)", marginLeft: 12 }}/>}
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 12px" }}>
                <span style={{
                  flexShrink: 0, minWidth: 34, padding: "2px 0", borderRadius: 6,
                  background: style.bg, color: style.fg,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 11, fontWeight: 800,
                }}>
                  {style.label}
                </span>
                <span style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", flexShrink: 0 }}>
                  {p.pref}
                </span>
                <span style={{
                  flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: "#fff",
                  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                }}>
                  {p.addr}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {hasMore && (
        <button
          onClick={() => setExpanded(v => !v)}
          style={{
            width: "100%", textAlign: "center", padding: "8px 0",
            fontSize: 12, fontWeight: 600, color: "rgba(255,255,255,0.55)",
          }}
        >
          {expanded ? "閉じる" : `すべて表示 (${sorted.length}件)`}
        </button>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────
   ZOOM CLUSTER — 縦に繋がったGlassピル
   ───────────────────────────────────────────────────── */
/* ─────────────────────────────────────────────────────
   TOGGLE (iOS-style)
   ───────────────────────────────────────────────────── */
function Toggle({ on, onChange }) {
  return (
    <div
      onClick={onChange}
      role="switch" aria-checked={on}
      style={{
        width: 44, height: 26, borderRadius: 13, flexShrink: 0,
        background: on ? "#32D74B" : "rgba(255,255,255,0.2)",
        position: "relative", cursor: "pointer",
        transition: "background 0.22s",
        boxShadow: "inset 0 0 0 0.5px rgba(0,0,0,0.2)",
      }}
    >
      <div style={{
        position: "absolute", top: 3,
        left: on ? 21 : 3, width: 20, height: 20,
        borderRadius: "50%", background: "#fff",
        boxShadow: "0 1px 4px rgba(0,0,0,0.35)",
        transition: "left 0.22s cubic-bezier(.25,1,.5,1)",
      }}/>
    </div>
  );
}

/* ─────────────────────────────────────────────────────
   NAV ICONS
   ───────────────────────────────────────────────────── */
const NAV_ICONS = {
  quake: (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none"
         stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <polyline points="2,12 4,12 5,7 6,17 8,4 9,20 11,10 12,12 14,12"/>
      <polyline points="14,12 15,9 16,15 18,12 22,12"/>
    </svg>
  ),
  tsunami: (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none"
         stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2,10.5C5,10.5 5,2.5 10.3,2.5 14.1,2.5 16,5.1 16,7.4
               c0,1.8 -1.2,3.1 -2.7,3.1 -1.3,0 -2.3,-0.9 -2.3,-2.1
               0,-0.9 0.7,-1.6 1.5,-1.6 0.6,0 1.1,0.5 1.1,1"/>
      <path d="M2,13h20"/>
      <path d="M2,19c1.5,0 1.5,-2.2 3,-2.2s1.5,2.2 3,2.2 1.5,-2.2 3,-2.2 1.5,2.2 3,2.2
               1.5,-2.2 3,-2.2 1.5,2.2 3,2.2 1.5,-2.2 3,-2.2 1.5,2.2 3,2.2"/>
    </svg>
  ),
  weather: (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none"
         stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M20,17.58A5,5 0 0 0 18,8h-1.26A8,8 0 1 0 4,16.25"/>
      <line x1="8" y1="19" x2="8" y2="21"/><line x1="12" y1="19" x2="12" y2="21"/>
      <line x1="16" y1="19" x2="16" y2="21"/>
    </svg>
  ),
  alert: (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none"
         stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2 1 21h22z"/>
      <line x1="12" y1="9" x2="12" y2="14"/>
      <line x1="12" y1="17.5" x2="12" y2="17.5"/>
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none"
         stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
    </svg>
  ),
};

/* ─────────────────────────────────────────────────────
   useSnapDrag
   ハンドルをドラッグして、高さを複数のスナップ位置のどれかに
   固定できるようにする汎用フック。UIロジックを切り離してあるので、
   heights配列を変えるだけで他のフローティングパネルにも流用できる。

   引数:
     heights: 昇順のスナップ高さ配列(px)。例: [0, 中, 高, 全画面]
     index:   現在のスナップ位置のindex(外部stateで管理)
     onSnap:  ドラッグが終わり、最も近いスナップ位置が決まった時に呼ばれる
   戻り値:
     { height, isDragging, handlePointerDown }
   ───────────────────────────────────────────────────── */
function useSnapDrag({ heights, index, onSnap }) {
  const [dragHeight, setDragHeight] = useState(null);
  const dragStartY      = useRef(0);
  const dragStartHeight = useRef(0);
  const liveHeight       = useRef(0);
  // フリック速度検出用: 直近の(時刻, 高さ)を記録しておき、
  // 指を離す直前の「速度」を算出する。
  const velocityTrack = useRef([]); // [{ t, h }, ...]

  const isDragging  = dragHeight !== null;
  const restHeight  = heights[index] ?? 0;
  const height      = isDragging ? dragHeight : restHeight;
  const maxHeight   = heights[heights.length - 1];

  function handlePointerMove(e) {
    const dy = dragStartY.current - e.clientY; // 上に引くほど高さが増える
    const h = Math.max(0, Math.min(maxHeight, dragStartHeight.current + dy));
    liveHeight.current = h;
    setDragHeight(h);

    // 直近120ms分だけ (時刻, 高さ) を保持し、速度計算に使う
    const now = performance.now();
    const track = velocityTrack.current;
    track.push({ t: now, h });
    while (track.length > 2 && now - track[0].t > 120) track.shift();
  }
  function endDrag() {
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", endDrag);
    window.removeEventListener("pointercancel", endDrag);
    const finalH = liveHeight.current;

    // フリック速度(px/ms)を算出。track の最初と最後の差分から求める。
    // 正 = 上向き(高さが増える方向)、負 = 下向き(高さが減る方向)。
    const track = velocityTrack.current;
    let velocity = 0;
    if (track.length >= 2) {
      const first = track[0], last = track[track.length - 1];
      const dt = last.t - first.t;
      if (dt > 0) velocity = (last.h - first.h) / dt;
    }
    velocityTrack.current = [];

    // 現在のスナップ位置に一番近いindexを求めておく(通常時のフォールバック用)
    let nearest = 0, nearestDist = Infinity;
    heights.forEach((h, i) => {
      const d = Math.abs(h - finalH);
      if (d < nearestDist) { nearestDist = d; nearest = i; }
    });

    // 明確な勢い(フリック)がある場合は、最近傍ではなく
    // 「現在地から見て指の動いた方向にある次のスナップ」を優先する。
    // これにより、上→下へサッとスワイプした時に中間で止まらず、
    // 意図通り1段階(またはそれ以上)下まで閉じやすくなる。
    const FLICK_THRESHOLD = 0.45; // px/ms。これを超えたら明確なフリックとみなす
    let target = nearest;
    if (Math.abs(velocity) > FLICK_THRESHOLD) {
      // 現在の指位置(finalH)がどのスナップ帯にいるかを求め、
      // フリック方向にある隣接スナップへ進める。
      let below = 0;
      for (let i = 0; i < heights.length; i++) {
        if (heights[i] <= finalH) below = i; else break;
      }
      target = velocity < 0
        ? below                                   // 下向きフリック → 現在地点以下の直近スナップ
        : Math.min(below + 1, heights.length - 1); // 上向きフリック → 直近の上のスナップ
    }

    setDragHeight(null);
    onSnap(target);
  }
  function handlePointerDown(e) {
    e.preventDefault();
    dragStartY.current = e.clientY;
    dragStartHeight.current = restHeight;
    liveHeight.current = restHeight;
    velocityTrack.current = [{ t: performance.now(), h: restHeight }];
    setDragHeight(restHeight);
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
  }

  return { height, isDragging, handlePointerDown };
}

/* ─────────────────────────────────────────────────────
   BOTTOM DOCK
   ナビバーと地図レイヤーパネルを「ひとつの液体ガラス」として統合する。
   分割した2枚のGlassを並べるのではなく、単一のGlass表面の
   高さ・角丸だけを変化させることで、ナビバーのガラス素材そのものが
   下から上へ伸びて、内側からパネルが生まれてくるように見せる。

   - 高さ: useSnapDrag により、低(閉)・中・高(従来の全開)・全画面の
     4段階のスナップ位置のどれかに固定される。先頭の白いハンドルを
     ドラッグすると、指の動きにリアルタイムで追従し、離した位置に
     最も近いスナップへ収まる。画面上部近くまで引き上げ続けると、
     そのまま画面いっぱいに広がる「全画面」状態まで連続的に伸びる。
   - 角丸: 高さの開き具合に応じて連続的に補間する。閉時は四隅とも
     ナビバー本来のピル(33px)、開くにつれて上だけ26pxへ柔らかく変化。
     999pxのような巨大な値は使わない(箱のサイズを超えてクランプされ、
     歪な円形になるのを防ぐため)。
   ───────────────────────────────────────────────────── */
function BottomDock({
  active, onNav, layerOpen, layers, onToggleLayer, onLayerOpenChange,
  quakes, quakeStatus, selectedQuakeId, onSelectQuake, stationPoints = [],
}) {
  const HANDLE_HEIGHT = 18; // ハンドル行の固定高さ(スクロールに巻き込まれず常に上部に固定)
  const bodyRef = useRef(null);
  const scrollRef = useRef(null);
  const [bodyNaturalHeight, setBodyNaturalHeight] = useState(0);

  // パネル本体(ヘッダー+レイヤー一覧。ハンドルは含まない)の
  // 「クリップされていない自然な高さ」を常に測定しておく。「高」スナップの基準になる。
  useLayoutEffect(() => {
    if (!bodyRef.current) return;
    const measure = () => setBodyNaturalHeight(bodyRef.current.scrollHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(bodyRef.current);
    return () => ro.disconnect();
  }, []);

  // タブ切り替え、または選択中の地震が変わった際に表示中身が変わると、
  // ブラウザのスクロールアンカリングによりscrollTopが勝手に動き、
  // カードやヘッダーが隠れて見えることがあるため、そのたびに明示的に
  // スクロール位置を先頭へ戻す(=常にカードが先頭に見えるようにする)。
  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [active, selectedQuakeId]);

  const naturalHeight = HANDLE_HEIGHT + bodyNaturalHeight; // ハンドル+本体の合計(=「高」スナップの高さ)

  // 画面の高さ — 「全画面」スナップの基準になる
  const [viewportH, setViewportH] = useState(() =>
    typeof window !== "undefined" ? window.innerHeight : 800
  );
  useEffect(() => {
    function onResize() { setViewportH(window.innerHeight); }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const NAV_ROW_HEIGHT  = 66; // ナビ行の固定高さ(58pxボタン + 上下4pxパディング)
  const BOTTOM_OFFSET   = 32; // 親側の bottom:16px+safeArea の概算
  const TOP_GAP         = 56; // 全画面時に画面最上部へ残す余白
  const fullscreenContentHeight = Math.max(
    naturalHeight,
    viewportH - TOP_GAP - BOTTOM_OFFSET - NAV_ROW_HEIGHT
  );

  // 0:低(閉) 1:中 2:中高(新規追加) 3:高(従来の全開) 4:全画面
  // 「高」はこれまで常に「そのタブの中身の実測高さ(naturalHeight)」そのものだったため、
  // 地震カードのように中身が短いタブでは「高」自体が縮んでしまい、地図レイヤー一覧の
  // 「高」「中高」と同じ位置まで開けなくなっていた。
  // → 「高」は「中身の実測高さ」と「地図レイヤー一覧(6項目)相当の基準高さ」の
  //    大きい方を採用し、どのタブでも同じ位置まで開けるようにする。
  //    中身がそれより短い場合は、単に空きスペースとして下に余る。
  //
  // ただし地震タブは「各地の震度」一覧を展開すると中身がかなり長くなることがあり、
  // 実測高さをそのまま採用すると「中高」からの伸び幅が大きくなりすぎて、
  // 跳ねるイージングと相まって「ビョーン」と誇張されたアニメーションに見えてしまう。
  // そのため「高」には上限(HIGH_HEIGHT_CAP)を設け、それを超える分は
  // パネル内部のスクロールに任せる(中身自体は隠れず、スクロールで見られる)。
  const REFERENCE_HIGH_HEIGHT = 350; // 地図レイヤー一覧(6項目)を開いたときの目安高さ
  const HIGH_HEIGHT_CAP = 460;       // 「高」の最大高さ。これ以上は内部スクロールに任せる
  const highHeight = Math.min(Math.max(naturalHeight, REFERENCE_HIGH_HEIGHT), HIGH_HEIGHT_CAP);

  // 「中」「中高」はタブによらず常に同じ高さになるよう固定pxで持つ
  // (地図レイヤー一覧で調整済みだった見た目の高さをそのまま定数化している)。
  const MID_FIXED     = 115; // 「中」の固定高さ(px)
  const MIDHIGH_FIXED = 222; // 「中高」の固定高さ(px)
  const GAP           = 20;  // 各スナップ間に必ず確保する最低差(px)
  const midHeight     = Math.min(MID_FIXED, highHeight - GAP * 2);
  const midHighHeight = Math.max(
    Math.min(MIDHIGH_FIXED, highHeight - GAP),
    midHeight + GAP
  );

  // 地震を選択した直後にスナップする「低(カードのみ)」の高さ。
  // 完全に閉じる(0)ではなく、QuakeDetailCard 1枚(+ハンドル)がちょうど収まる
  // 高さにして、地図の震源付近が広く見えつつカードも確認できるようにする。
  const CARD_ONLY_HEIGHT = 96; // QuakeDetailCard 1枚の実測目安(margin込み)
  const quakeLowHeight = Math.min(CARD_ONLY_HEIGHT, midHeight - GAP);

  const SNAP_HEIGHTS = [
    0,
    midHeight,
    midHighHeight,
    highHeight,
    Math.max(fullscreenContentHeight, highHeight),
  ];
  const [snapIndex, setSnapIndex] = useState(0);

  // 親から渡される layerOpen(真偽値)を 低(0)⇄高(3) として反映する。
  // ドラッグで内部的に決めたスナップを、ここで二重に上書きしないようrefで判定する。
  const lastLayerOpen = useRef(layerOpen);
  useEffect(() => {
    if (layerOpen !== lastLayerOpen.current) {
      lastLayerOpen.current = layerOpen;
      setSnapIndex(layerOpen ? (active === "quake" ? 2 : 3) : 0);
    }
  }, [layerOpen, active]);

  // 地震の選択が「あり→なし」に変わった(=戻るボタンで選択解除された)ら、
  // 詳細カード表示の「中」から一覧表示の「中高」へ戻す。
  const lastSelectedQuakeId = useRef(selectedQuakeId);
  useEffect(() => {
    if (lastSelectedQuakeId.current != null && selectedQuakeId == null) {
      setSnapIndex(2);
    }
    lastSelectedQuakeId.current = selectedQuakeId;
  }, [selectedQuakeId]);

  function handleSnap(newIndex) {
    setSnapIndex(newIndex);
    const shouldOpen = newIndex > 0;
    if (shouldOpen !== layerOpen) {
      lastLayerOpen.current = shouldOpen;
      onLayerOpenChange(shouldOpen);
    }
  }

  const { height: currentHeight, isDragging, handlePointerDown } =
    useSnapDrag({ heights: SNAP_HEIGHTS, index: snapIndex, onSnap: handleSnap });

  // 開閉トランジション・ドラッグ中だけ軽量モードにする:
  // border-radius / height のような「レイアウトに影響するプロパティ」を
  // 大きく・複雑な屈折フィルタ付きの要素でアニメーションさせると、
  // ブラウザがフレームごとにbackdrop-filter+SVGフィルタを再計算するため重くなる。
  // 動いている間だけ屈折SVGフィルタを外し、blurも軽くして、
  // 静止したら元のリッチな質感に戻す。
  const [settled, setSettled] = useState(true);
  const settleTimer = useRef(null);
  function scheduleSettle(delay = 460) {
    clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => setSettled(true), delay);
  }
  useEffect(() => {
    setSettled(false);
    scheduleSettle(460);
    return () => clearTimeout(settleTimer.current);
  }, [snapIndex]);
  useEffect(() => {
    if (isDragging) { setSettled(false); clearTimeout(settleTimer.current); }
  }, [isDragging]);

  // タブ切り替え(active変化)でも中身の自然な高さが変わり、パネルの高さが
  // アニメーションで追従する。この高さ変化中も、スナップ切り替え時と同様に
  // 重い屈折フィルタを一時的に外して軽量モードにする。
  useEffect(() => {
    setSettled(false);
    scheduleSettle(460);
  }, [active]);

  // 角丸は「現在のガラス全体の実際の高さ」と「開き具合」から直接算出する。
  // 999pxのような巨大な値をそのままトランジションさせると、中間状態で
  // border-radiusが箱の寸法を超えてクランプされ、丸が膨らんで歪な円形に
  // なってしまうため、999は一切使わない。
  // 下の角丸はナビ行(高さ66固定)に合わせて常に33pxで一定。
  // 上の角丸は、閉じている時は下と揃えて完全な丸ピルにし(33px)、
  // 開くにつれて少しだけ締まった26pxへ滑らかに変化させる
  // — 26〜33はどちらも箱の最小高さ(66, 半分33)を超えない安全な値なので、
  // 補間の途中でも歪みは発生しない(「高」を超えて全画面へ伸びる間もtopRadiusは26で頭打ち)。
  const BOTTOM_RADIUS = NAV_ROW_HEIGHT / 2; // 33px
  const openProgress = naturalHeight > 0 ? Math.min(1, Math.max(0, currentHeight / naturalHeight)) : 0;
  const topRadius    = BOTTOM_RADIUS + (26 - BOTTOM_RADIUS) * openProgress;
  const bottomRadius = BOTTOM_RADIUS;

  /* ── ナビ行スワイプ選択（%ベース連続追従方式）────────────────
     タブは flex:1 で等幅。ハイライトの left/width は、ナビ行の
     「左右パディングを除いた内側領域」を基準にした % で一貫管理する。
     NAV_PAD_X は JSX 側の padding と必ず一致させること(ズレ防止)。
     端のタブでハイライトが外枠ぎりぎりに接しないよう、左右に
     十分な余白(NAV_PAD_X)を確保している。 */
  const NAV_PAD_X = 8; // ナビ行の左右パディング[px]。JSXのpaddingと一致させる
  const navRowRef    = useRef(null);
  const navPointerId = useRef(null);
  const navMoved     = useRef(false);
  const navStartX    = useRef(0);
  const N = NAV.length;                       // タブ数
  const tabW = 100 / N;                       // 1タブの幅 [%]（内側領域基準）

  const activeIndex = NAV.findIndex(n => n.id === active);
  const [highlightLeft, setHighlightLeft] = useState(activeIndex * tabW);
  const [navDragging,   setNavDragging]   = useState(false);
  const [navPressed,    setNavPressed]    = useState(false);  // 指が触れている間ずっとtrue(タップ/ドラッグ問わず)
  const [previewIdx,    setPreviewIdx]    = useState(null);  // ドラッグ中の最近傍index

  // active が外部から変わった時（タップ以外の切替）にハイライトを追従させる
  useEffect(() => {
    if (!navDragging) {
      setHighlightLeft(activeIndex * tabW);
    }
  }, [activeIndex, navDragging, tabW]);

  // clientX → 内側領域(左右NAV_PAD_X除外)を基準にした正規化 left [%]
  function clientXToLeft(clientX) {
    const row = navRowRef.current;
    if (!row) return activeIndex * tabW;
    const { left, width } = row.getBoundingClientRect();
    const innerLeft  = left + NAV_PAD_X;
    const innerWidth = width - NAV_PAD_X * 2;
    const ratio = Math.max(0, Math.min(1, (clientX - innerLeft) / innerWidth));
    return ratio * 100;              // % 値（内側領域基準）
  }

  // clientX に最も近いタブの index を返す
  function clientXToIndex(clientX) {
    const pct = clientXToLeft(clientX);          // 0–100（内側領域基準）
    return Math.max(0, Math.min(N - 1, Math.round(pct / tabW - 0.5)));
  }

  function handleNavPointerDown(e) {
    navPointerId.current = e.pointerId;
    navMoved.current     = false;
    navStartX.current    = e.clientX;
    e.currentTarget.setPointerCapture(e.pointerId);
    const idx = clientXToIndex(e.clientX);
    setPreviewIdx(idx);
    setNavPressed(true);
    // ここでは navDragging を立てない。
    // navDragging=true は transition を切るためのフラグなので、
    // まだ指が動いていない(タップの可能性がある)段階では
    // transition を有効なままにしておき、目的のタブへ
    // スライドして移動するアニメーションを見せる。
    setHighlightLeft(idx * tabW);
  }

  function handleNavPointerMove(e) {
    if (navPointerId.current !== e.pointerId) return;
    if (Math.abs(e.clientX - navStartX.current) > 3 && !navMoved.current) {
      // ここで初めて「実際のドラッグ」と確定する。
      // この瞬間から transition を切って指に即座追従させる。
      navMoved.current = true;
      setNavDragging(true);
    }
    const idx = clientXToIndex(e.clientX);
    setPreviewIdx(idx);
    if (navMoved.current) {
      // ドラッグ確定後は、指の連続位置にハイライトを追従させる
      const raw = clientXToLeft(e.clientX) - tabW / 2;
      setHighlightLeft(Math.max(0, Math.min(100 - tabW, raw)));
    } else {
      // まだタップ相当の間はタブ中心に置いたまま(スライドで追いつく)
      setHighlightLeft(idx * tabW);
    }
  }

  function handleNavPointerUp(e) {
    if (navPointerId.current !== e.pointerId) return;
    navPointerId.current = null;
    const idx = clientXToIndex(e.clientX);
    setNavDragging(false);
    setNavPressed(false);
    setPreviewIdx(null);
    setHighlightLeft(idx * tabW);
    onNav(NAV[idx].id);
  }

  // タップ(pointermove なし)は click でも拾えるようフォールバック。
  // 同じタブを既定時間内に2回タップした場合はダブルタップとみなし、
  // ナビ切替の代わりに地図レイヤーパネルを開閉する。
  const lastTapTime = useRef(0);
  const lastTapId   = useRef(null);
  const DOUBLE_TAP_MS = 320;

  function handleNavClick(id) {
    if (navMoved.current) return;   // ドラッグ完了後の二重発火を防ぐ

    const now = Date.now();
    const isDoubleTap =
      lastTapId.current === id && (now - lastTapTime.current) < DOUBLE_TAP_MS;

    if (isDoubleTap) {
      lastTapTime.current = 0;       // 3連続タップ目を誤検知しないようリセット
      lastTapId.current   = null;
      onLayerOpenChange(!layerOpen);
      return;                        // ダブルタップ時はナビ切替を行わない
    }

    lastTapTime.current = now;
    lastTapId.current   = id;

    const idx = NAV.findIndex(n => n.id === id);
    setHighlightLeft(idx * tabW);
    onNav(id);
  }

  // ドラッグ中はプレビューindex、そうでなければactiveをハイライト表示に使う
  const displayIdx = navDragging && previewIdx != null ? previewIdx : activeIndex;

  // 戻るボタンの下端オフセット。パネル本体(currentHeight)+ナビ行(NAV_ROW_HEIGHT)+
  // 少し余白、を常に足し上げているため、ドラッグ中も含めてパネルの高さに追従する。
  const backButtonBottom = currentHeight + NAV_ROW_HEIGHT + 12;

  return (
    <>
      {/* 戻るボタン — 地震を選択している間だけ、パネルのすぐ上に浮かぶ。
          Glass(パネル本体)の兄弟として置くことで、currentHeightの変化(ドラッグ含む)に
          そのまま追従できるようにしている。 */}
      {active === "quake" && selectedQuakeId != null && (
        <div style={{
          position: "absolute",
          right: 16,
          bottom: backButtonBottom,
          transition: isDragging ? "none" : "bottom 0.4s cubic-bezier(.22,1,.36,1)",
          zIndex: 10,
        }}>
          <BackToListButton onClick={() => onSelectQuake(null)}/>
        </div>
      )}

      <Glass
      filterSize={settled ? "normal" : "none"}
      blur={settled ? 14 : 8}
      style={{
        width: "100%",
        maxWidth: 480,
        minWidth: 240,
        borderRadius: `${topRadius}px ${topRadius}px ${bottomRadius}px ${bottomRadius}px`,
        transition: isDragging ? "none" : "border-radius 0.4s cubic-bezier(.22,1,.36,1)",
        overflow: "hidden",
        animation: "appear 0.4s cubic-bezier(.25,1,.5,1) 0.1s both",
      }}
    >
      {/* レイヤーパネル部分 — 高さを直接アニメーションし、
          ナビバーのガラスの中から「せり出してくる」ように展開する */}
      <div
        aria-hidden={snapIndex === 0 && !isDragging}
        style={{
          height: currentHeight,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          transition: isDragging ? "none" : "height 0.4s cubic-bezier(.22,1,.36,1)",
          pointerEvents: (snapIndex > 0 || isDragging) ? "auto" : "none",
        }}
      >
        {/* ドラッグハンドル — 常に上部に固定。本体をスクロールしても一緒には動かない。
            以前は当たり判定を absolute で上下に張り出す構成にしていたが、
            重ね合わせが原因と思われる表示崩れが発生したため、
            ハンドル行自体の高さを広げてタップ範囲とするシンプルな
            構成に戻した(見た目のバー位置は中央のまま変わらない)。 */}
        <div
          onPointerDown={handlePointerDown}
          style={{
            flexShrink: 0,
            display: "flex", justifyContent: "center", alignItems: "center",
            width: "100%", height: HANDLE_HEIGHT,
            background: "transparent",
            cursor: "grab",
            touchAction: "none", userSelect: "none",
          }}
        >
          <div style={{
            width: 36, height: 4, borderRadius: 999,
            background: "rgba(255,255,255,0.45)",
          }}/>
        </div>

        {/* スクロール可能な本体 — ヘッダー・レイヤー一覧だけがここでスクロールする。
            overflowAnchor: "none" は、タブ切り替えで中身の高さが変わった際に
            ブラウザのスクロールアンカリングがスクロール位置を勝手にずらし、
            ヘッダーや先頭行が隠れて見える不具合を防ぐため。 */}
        <div
          ref={scrollRef}
          style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden", overflowAnchor: "none" }}
        >
          <div ref={bodyRef}>
            {active === "quake" ? (
              <>
                {quakeStatus === "loading" && quakes.length === 0 && (
                  <div style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    gap: 8, padding: "18px 0", color: "rgba(255,255,255,0.45)",
                  }}>
                    <div style={{
                      width: 16, height: 16, borderRadius: "50%",
                      border: "2px solid rgba(255,255,255,0.15)",
                      borderTopColor: "rgba(255,255,255,0.6)",
                      animation: "spin 0.8s linear infinite",
                    }}/>
                    <span style={{ fontSize: 12 }}>地震情報を取得中…</span>
                  </div>
                )}

                {quakeStatus === "error" && quakes.length === 0 && (
                  <div style={{ padding: "18px 16px", textAlign: "center" }}>
                    <span style={{ fontSize: 12, color: "rgba(255,140,140,0.9)" }}>
                      地震情報の取得に失敗しました
                    </span>
                  </div>
                )}

                {quakes.length > 0 && (() => {
                  const selected = quakes.find(q => q.id === selectedQuakeId) || null;

                  // 選択中は「カード(+各地の震度)のみ」、未選択は「一覧のみ」の排他表示。
                  if (selected) {
                    return (
                      <div key={selected.id}>
                        <QuakeDetailCard quake={selected}/>
                        <QuakeMessageCard quake={selected}/>
                        {stationPoints.length > 0 && (
                          <StationPointsList points={stationPoints}/>
                        )}
                      </div>
                    );
                  }

                  return (
                    <>
                      {quakes.map((q, i) => {
                        const style = INTENSITY_STYLE[q.maxIntensity] || INTENSITY_STYLE["1"];
                        return (
                          <div key={q.id}>
                            {i > 0 && <div style={{ height: 0.5, background: "rgba(255,255,255,0.08)", marginLeft: 18 }}/>}
                            <button
                              onClick={() => { onSelectQuake(q.id); setSnapIndex(1); }}
                              style={{
                                width: "100%", display: "flex", alignItems: "center", gap: 10,
                                padding: "9px 14px",
                                background: "transparent",
                                textAlign: "left",
                              }}
                            >
                              <span style={{
                                flexShrink: 0, width: 28, height: 22, borderRadius: 6,
                                background: style.bg, color: style.fg,
                                display: "flex", alignItems: "center", justifyContent: "center",
                                fontSize: 11, fontWeight: 800,
                              }}>
                                {style.label}
                              </span>
                              <span style={{
                                flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: "#fff",
                                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                              }}>
                                {q.place}
                              </span>
                              <span className="mono" style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", flexShrink: 0 }}>
                                {q.time?.slice(5, 16)}
                              </span>
                            </button>
                          </div>
                        );
                      })}
                    </>
                  );
                })()}

                {/* フローティング部分(地震一覧)とボタン類(ナビ行)の境界線 */}
                <div style={{ height: 0.5, background: "rgba(255,255,255,0.22)", margin: "2px 0 0" }}/>
              </>
            ) : (
              <>
                <div style={{
                  display: "flex", alignItems: "center",
                  padding: "8px 18px 11px",
                  borderBottom: "0.5px solid rgba(255,255,255,0.15)",
                }}>
                  <span style={{ fontSize: 14, fontWeight: 600, flex: 1, color: "rgba(255,255,255,0.9)" }}>
                    地図レイヤー
                  </span>
                </div>

                {layers.map((l, i) => (
                  <div key={l.id}>
                    {i > 0 && <div style={{ height: 0.5, background: "rgba(255,255,255,0.1)", marginLeft: 18 }}/>}
                    <div style={{ display: "flex", alignItems: "center", padding: "11px 18px", gap: 10 }}>
                      <span style={{ fontSize: 14, color: "rgba(255,255,255,0.85)", flex: 1 }}>
                        {l.label}
                      </span>
                      <Toggle on={l.on} onChange={() => onToggleLayer(l.id)}/>
                    </div>
                  </div>
                ))}

                {/* フローティング部分(レイヤー一覧)とボタン類(ナビ行)の境界線 */}
                <div style={{ height: 0.5, background: "rgba(255,255,255,0.22)", margin: "2px 0 0" }}/>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ナビ行 — 常に表示される、ガラスの“足元”。
          Liquid Glassのハイライトが指の位置に連続追従し、なぞるだけで
          タブを選べる。タップのみの操作もそのまま機能する。 */}
      <div
        ref={navRowRef}
        onPointerDown={handleNavPointerDown}
        onPointerMove={handleNavPointerMove}
        onPointerUp={handleNavPointerUp}
        onPointerCancel={handleNavPointerUp}
        style={{
          position: "relative",
          display: "flex", flexDirection: "row",
          padding: `4px ${NAV_PAD_X}px`, gap: 0,
          touchAction: "none",
          userSelect: "none",
          WebkitUserSelect: "none",
          WebkitTouchCallout: "none",     // iOS: 長押しでのコピー/調べる/翻訳メニューを無効化
          WebkitTapHighlightColor: "transparent",
        }}
      >
        {/* ガラスのハイライトピル — %ベースで位置・幅を管理。
            ドラッグ中: transition:none で指に即座追従。
            pointerup 後: spring transition でスナップ位置へ吸い付く。 */}
        <div
          aria-hidden
          style={{
            position: "absolute",
            top: 4, bottom: 4,
            // 親(ナビ行)基準の % だけだと外側パディングが二重に効かず
            // ハイライトが外枠の縁に接してしまうため、calc() で
            // 内側領域オフセット(NAV_PAD_X)を明示的に加算する。
            left: `calc(${NAV_PAD_X}px + (100% - ${NAV_PAD_X * 2}px) * ${highlightLeft / 100})`,
            width: `calc((100% - ${NAV_PAD_X * 2}px) * ${tabW / 100})`,
            borderRadius: 999,
            background: "rgba(255,255,255,0.13)",
            boxShadow: "inset 0 0 0 0.5px rgba(255,255,255,0.45), inset 0 1px 0 rgba(255,255,255,0.55)",
            // 押している間はわずかに拡大し、Apple Liquid Glass特有の
            // "押し込むとガラスが少し膨らむ" 触覚的な質感を再現する。
            transform: navPressed ? "scale(1.16)" : "scale(1)",
            transformOrigin: "center",
            transition: navDragging
              ? "transform 0.18s cubic-bezier(.22,1,.36,1)"
              : "left 0.38s cubic-bezier(.22,1,.36,1), transform 0.18s cubic-bezier(.22,1,.36,1)",
            pointerEvents: "none",
            zIndex: 0,
          }}
        />

        {NAV.map(({ id, label }, idx) => {
          const isActive = idx === displayIdx;
          return (
            <button
              key={id}
              onClick={() => handleNavClick(id)}
              style={{
                position: "relative", zIndex: 1,
                display: "flex", flexDirection: "column",
                alignItems: "center", justifyContent: "center",
                gap: 4, flex: 1, minWidth: 0, height: 58,
                borderRadius: 999, border: "none",
                background: "transparent",
                cursor: "pointer",
                color: isActive ? "rgba(255,255,255,1)" : "rgba(255,255,255,0.6)",
                transition: "color 0.15s",
                padding: "0 4px",
                touchAction: "none",
                userSelect: "none",
                WebkitUserSelect: "none",
                WebkitTouchCallout: "none",   // iOS: 長押しでのコピー/調べる/翻訳メニューを無効化
                WebkitTapHighlightColor: "transparent",
              }}
            >
              {NAV_ICONS[id]}
              <span style={{
                fontSize: 11,
                fontWeight: isActive ? 700 : 500,
                lineHeight: 1,
                letterSpacing: -0.1,
                whiteSpace: "nowrap",
                userSelect: "none",
                WebkitUserSelect: "none",
                WebkitTouchCallout: "none",
              }}>
                {label}
              </span>
            </button>
          );
        })}
      </div>
      </Glass>
    </>
  );
}

/* ─────────────────────────────────────────────────────
   BACK TO LIST BUTTON
   地震を選択中に地図上へ浮かぶ丸い「戻る」ボタン。
   押すと選択を解除し、パネルを「中高」にして一覧表示へ戻る。
   ───────────────────────────────────────────────────── */
function BackToListButton({ onClick }) {
  return (
    <Glass
      radius={999}
      style={{ width: 44, height: 44 }}
    >
      <button
        onClick={onClick}
        aria-label="地震一覧に戻る"
        style={{
          position: "relative", zIndex: 1,
          width: "100%", height: "100%",
          display: "flex", alignItems: "center", justifyContent: "center",
          color: "rgba(200,220,255,0.95)",
        }}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none"
             stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="15 6 9 12 15 18"/>
        </svg>
      </button>
    </Glass>
  );
}

/* ─────────────────────────────────────────────────────
   LAYERS TOGGLE ICON
   ───────────────────────────────────────────────────── */
function LayersIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none"
         stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 2 7 12 12 22 7 12 2"/>
      <polyline points="2 17 12 22 22 17"/>
      <polyline points="2 12 12 17 22 12"/>
    </svg>
  );
}

/* ─────────────────────────────────────────────────────
   APP ROOT
   ───────────────────────────────────────────────────── */
export default function App() {
  const [activeNav, setActiveNav] = useState("quake");
  const [layers,    setLayers]    = useState(LAYERS);
  const [layerOpen, setLayerOpen] = useState(false);
  const [map,       setMap]       = useState(null);

  // 地震情報(P2P地震情報API)
  const [quakes,          setQuakes]          = useState([]);
  const [quakeStatus,     setQuakeStatus]     = useState("loading"); // loading | ready | error
  const [selectedQuakeId, setSelectedQuakeId] = useState(null);

  // 観測点マスタ(緯度経度付き)。points[]との突き合わせに使う。
  const [stations, setStations] = useState(null);

  const toggleLayer = id =>
    setLayers(prev => prev.map(l => l.id === id ? { ...l, on: !l.on } : l));

  // 観測点マスタは全地震で共通なので、起動時に一度だけ取得する
  useEffect(() => {
    let cancelled = false;
    loadStations()
      .then(list => { if (!cancelled) setStations(list); })
      .catch(err => console.error("観測点マスタの取得に失敗:", err));
    return () => { cancelled = true; };
  }, []);

  // 選択中の地震 + 観測点マスタが揃ったら、観測点ごとの震度に緯度経度を割り当てる
  const selectedQuake = quakes.find(q => q.id === selectedQuakeId) || null;
  const selectedQuakePoints = useMemo(() => {
    if (!selectedQuake || !stations) return [];
    return resolveStationPoints(selectedQuake.points, stations);
  }, [selectedQuake, stations]);

  // 震源(バツ印表示・ズーム用)。緯度経度が無い地震(震源不明)ではnullのまま。
  const selectedHypocenter = useMemo(() => {
    if (!selectedQuake || selectedQuake.latitude == null || selectedQuake.longitude == null) return null;
    return { latitude: selectedQuake.latitude, longitude: selectedQuake.longitude };
  }, [selectedQuake]);

  // 起動時に /history で最新一覧を1回だけ取得し、以降はWebSocketで新着分を随時追加する。
  const [wsStatus, setWsStatus] = useState("connecting"); // connecting | open | closed
  useEffect(() => {
    let cancelled = false;

    fetchRecentQuakes()
      .then(list => {
        if (cancelled) return;
        setQuakes(list);
        setQuakeStatus("ready");
        setSelectedQuakeId(prev => (prev && list.some(q => q.id === prev)) ? prev : null);
      })
      .catch(err => {
        console.error("地震情報の取得に失敗:", err);
        if (cancelled) return;
        setQuakeStatus("error");
      });

    const socket = connectQuakeWebSocket(
      (newQuake) => {
        if (cancelled) return;
        setQuakes(prev => {
          // 同一idの重複配信を除外しつつ、新着を先頭に追加する。
          // 件数は/historyの初期取得と揃えて30件までに抑える。
          const deduped = prev.filter(q => q.id !== newQuake.id);
          return [newQuake, ...deduped].slice(0, 30);
        });
        setQuakeStatus("ready");
      },
      (status) => { if (!cancelled) setWsStatus(status); }
    );

    return () => { cancelled = true; socket.close(); };
  }, []);

  return (
    <>
      <GlobalStyles/>
      <Filters/>

      <div style={{ height: "100dvh", position: "relative", overflow: "hidden", background: "#121214" }}>

        {/* ── Layer 1: 地図（Liquid Glassが透かす背景） ── */}
        <MapCanvas onReady={setMap} stationPoints={selectedQuakePoints} hypocenter={selectedHypocenter}/>

        {/* ── Layer 2: Glass UI（透明ガラスが地図に浮かぶ） ── */}

        {/* アラートピル — 一旦非表示 */}
        {/*
        <div style={{
          position: "absolute", top: 20, left: 0, right: 0,
          display: "flex", justifyContent: "center",
          zIndex: 30, pointerEvents: "none",
        }}>
          <div style={{ pointerEvents: "auto" }}>
            <AlertPill alert={ALERT}/>
          </div>
        </div>
        */}

        {/* ボトムドック — ナビバーと地図レイヤーパネルをひとつのGlassに統合。
            レイヤーを開くと、このガラス自体の高さ・角丸が滑らかに変化し、
            ナビバーの内側からパネルが伸びて生まれてくるように見せる */}
        <div style={{
          position: "absolute",
          bottom: "calc(16px + env(safe-area-inset-bottom))",
          left: 0, right: 0,
          display: "flex", justifyContent: "center", alignItems: "flex-end",
          zIndex: 40, padding: "0 16px",
        }}>
          <BottomDock
            active={activeNav}
            onNav={setActiveNav}
            layerOpen={layerOpen}
            layers={layers}
            onToggleLayer={toggleLayer}
            onLayerOpenChange={setLayerOpen}
            quakes={quakes}
            quakeStatus={quakeStatus}
            selectedQuakeId={selectedQuakeId}
            onSelectQuake={setSelectedQuakeId}
            stationPoints={selectedQuakePoints}
          />
        </div>

      </div>
    </>
  );
}
