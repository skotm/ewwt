import { useState, useEffect, useLayoutEffect, useMemo, useRef, useContext, createContext, forwardRef, Fragment } from "react";
import { createPortal } from "react-dom";

/* ─────────────────────────────────────────────────────
   APP VERSION
   バージョン表記のルール(vMAJOR.MINOR.PATCH):
   - PATCH(3つ目の数字)を更新のたびに1ずつ増やす
   - PATCHが10になったらMINOR(2つ目)を1増やし、PATCHは0に戻す
   - MINORが10になったらMAJOR(1つ目)を1増やし、MINORは0に戻す
   - MAJORには繰り上げ先が無いので、10になってもそのまま11、12…と増え続ける
   (要するに10進の桁上がりと同じルールで、MAJORだけ上限が無い)
   ───────────────────────────────────────────────────── */
const APP_VERSION = "1.0.7a";

/* ─────────────────────────────────────────────────────
   RESPONSIVE LAYOUT
   スマホ縦持ちでは「下部タブバー + 下からドラッグして開くボトムシート」、
   横画面スマホ・タブレット・PCなど横幅が十分ある場合は「左端の縦タブバー
   (レール) + 常に画面右側に居るパネル」に切り替える。
   ここではその判定(=isWideLayout)だけを提供する。実際のレイアウト分岐は
   BottomDock側で行う。
   ───────────────────────────────────────────────────── */
const WIDE_LAYOUT_MIN_WIDTH = 720; // これ未満は常にスマホ縦持ち相当の下部タブバーを使う

function useIsWideLayout() {
  const [isWide, setIsWide] = useState(() =>
    typeof window !== "undefined" && window.innerWidth >= WIDE_LAYOUT_MIN_WIDTH
  );
  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${WIDE_LAYOUT_MIN_WIDTH}px)`);
    const update = () => setIsWide(mq.matches);
    update();
    // Safari旧バージョン対応でaddListener/removeListenerもフォールバックしておく
    if (mq.addEventListener) mq.addEventListener("change", update);
    else mq.addListener(update);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", update);
      else mq.removeListener(update);
    };
  }, []);
  return isWide;
}

// 「ホーム画面に追加」して起動した、いわゆるスタンドアロンPWAかどうかを判定する。
// 通常のSafari/Chromeのタブとして開いている場合はfalse。
// スタンドアロンだとブラウザ自身のツールバーが無いためbottomのセーフエリアの
// 余白の付け方が変わるので、下部ナビの余白調整で使い分ける(BottomDock参照)。
function useIsStandalonePwa() {
  const [isStandalone, setIsStandalone] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(display-mode: standalone)").matches
      || window.navigator.standalone === true; // iOS Safariの旧来のフラグ
  });
  useEffect(() => {
    const mq = window.matchMedia("(display-mode: standalone)");
    const update = () => setIsStandalone(mq.matches || window.navigator.standalone === true);
    update();
    if (mq.addEventListener) mq.addEventListener("change", update);
    else mq.addListener(update);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", update);
      else mq.removeListener(update);
    };
  }, []);
  return isStandalone;
}

// 横画面レイアウト用のUI縮小率。PC・タブレットの横画面では画面の縦幅に
// 余裕があるので等倍(1)のままでよいが、横画面のスマホ(高さ400px前後)
// では同じ大きさのまま出すと文字・要素が窮屈になり壊滅的に見づらくなる
// ため、画面の縦幅に応じて0.7〜1の範囲で縮小する。
// 基準の700pxは、タブレット横画面などで概ね窮屈にならない高さの目安。
function useWideUIScale(isWide) {
  const [scale, setScale] = useState(1);
  useEffect(() => {
    if (!isWide) { setScale(1); return; }
    const update = () => {
      const h = window.innerHeight;
      setScale(Math.max(0.7, Math.min(1, h / 700)));
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [isWide]);
  return scale;
}

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
  { id: "radar",        label: "雨雲レーダー", on: true  },
  { id: "quake",        label: "震度分布",     on: false },
  // 実際のon/offは常にApp側のestIntensityEnabled(設定と共有・localStorage永続化)で
  // 上書きされるため、ここでの初期値(false)自体は使われない(layersForPanelを参照)。
  { id: "estIntensity", label: "推計震度分布", on: false },
  { id: "tsunami",      label: "津波予報区",   on: false },
  { id: "river",        label: "河川水位",     on: true  },
  { id: "hazard",       label: "ハザード",     on: false },
  { id: "evac",         label: "避難所",       on: false },
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
   BACKDROP-FILTER 実効性の疑わしさを検出する
   
   Windows Chromium(ANGLE Direct3D11経由)では、backdrop-filterは
   CSS機能としては「対応」しているにもかかわらず(@supportsも通る)、
   背後のWebGL canvas(地図)がDirectCompositionのハードウェア
   オーバーレイに昇格し、ブラウザの通常コンポジタから見えなくなる
   ことがある。この場合ぼかしは一切効かず、ガラスパネルの背景が
   ほぼ完全に透けて見える(既存の @supports not(...) フォールバックは
   「機能自体に非対応」の場合しか拾えないため、この症状は検出できない)。
   
   WEBGL_debug_renderer_info 拡張でGPUレンダラー文字列を取得し、
   既知の発生条件(ANGLEのDirect3D11バックエンド)に一致するかで
   ヒューリスティックに判定する。100%正確な判定ではないため、
   設定側で手動オーバーライドできるようにlocalStorageに保存する
   ("auto" | "on"(常に不透明) | "off"(常にぼかし優先))。
   ───────────────────────────────────────────────────── */
function detectSuspectedBackdropFilterBreakage() {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
    if (!gl) return false;
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    if (!ext) return false;
    const renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || "";
    // 例: "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)"
    return /ANGLE/i.test(String(renderer)) && /Direct3D11/i.test(String(renderer));
  } catch {
    return false;
  }
}

const GLASS_OPAQUE_OVERRIDE_KEY = "glassOpaqueFallback"; // "auto" | "on" | "off"

function loadGlassOpaqueOverride() {
  try {
    const v = localStorage.getItem(GLASS_OPAQUE_OVERRIDE_KEY);
    return v === "on" || v === "off" ? v : "auto";
  } catch {
    return "auto";
  }
}

function saveGlassOpaqueOverride(v) {
  try { localStorage.setItem(GLASS_OPAQUE_OVERRIDE_KEY, v); } catch {}
}

// Glassコンポーネント群、および設定画面の「フローティング関連」トグルが
// 共有するcontext。Appのトップレベルで判定結果(自動判定 or 手動オーバーライド)
// と、オーバーライドを変更するための関数をまとめて配信する。
// - opaque: 実際に不透明表示にするかどうか(Glassコンポーネントが参照)
// - override: "auto" | "on" | "off"(ユーザーの手動選択。設定画面のトグルに対応)
// - suspectedBroken: 自動判定の結果(ぼかしが実効しない疑いがあるか)
// - setOverride: overrideを変更する関数
const GlassOpaqueContext = createContext({
  opaque: false,
  override: "auto",
  suspectedBroken: false,
  setOverride: () => {},
});

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
  // backdrop-filterが実効しない(疑いがある)環境では、屈折SVGフィルタも
  // ぼかし層も使わず、はっきり見える不透明めの背景に切り替える。
  // 屈折フィルタは「ぼかされた背景を歪ませる」演出のため、ぼかし自体が
  // 効いていない状態でfilter:url(...)だけ生かしても視覚的な意味がない。
  const { opaque: glassOpaque } = useContext(GlassOpaqueContext);
  const { tokens } = useContext(ThemeContext);

  // filterSize="none" の場合は屈折SVGフィルタを外し、単純なbackdrop blurのみにする
  // （リサイズや角丸トランジション中など、フィルタの再計算コストが重くなる場面用の軽量モード）
  const filterId = glassOpaque ? null : (filterSize === "none" ? null : filterSize === "sm" ? "lg-refract-sm" : "lg-refract");

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
      {/* 背景ブラー層: backdrop-filterのみを単独で適用する。
          ここに filter:url(...) を同時指定すると、Windows版Chrome/Edge
          (ANGLE/D3D11経由のレンダリングパス)ではbackdrop-filterの
          ぼかし自体が丸ごと無効化され、rgba(255,255,255,0.02)というほぼ
          無色の背景だけが残って「完全に透ける」表示になってしまう
          既知の不具合があるため、意図的にfilterを外してある。 */}
      <div
        aria-hidden
        className="glass-backdrop-layer"
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: "inherit",
          // ぼかしが実効しない環境ではbackdrop-filter自体を外す
          // (どうせ効かない処理をGPUにやらせ続けるコストを避ける)。
          backdropFilter: glassOpaque ? "none" : `blur(${blur}px) saturate(140%)`,
          WebkitBackdropFilter: glassOpaque ? "none" : `blur(${blur}px) saturate(140%)`,
          background: glassOpaque ? tokens.glassOpaqueBg : tokens.glassTint,
          zIndex: 0,
        }}
      />
      {/* 縁屈折(SVG displacement)層: 上のブラー層とは別要素にすることで、
          backdrop-filter + filter の組み合わせ不具合がここで起きても
          このレイヤーだけが無効になり、下のブラー層は影響を受けない
          (＝最悪の場合でも「ぼかしは効くが屈折演出だけ消える」に留まり、
          「完全に透ける」事態は起きない、というフォールバック構造)。 */}
      {filterId && (
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: "inherit",
            backdropFilter: `blur(${blur}px) saturate(140%)`,
            WebkitBackdropFilter: `blur(${blur}px) saturate(140%)`,
            filter: `url(#${filterId})`,
            zIndex: 0,
            pointerEvents: "none",
          }}
        />
      )}
      {/* 縁のrim light: シャープな1pxの白線、歪みなし */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: "inherit",
          boxShadow: `
            inset 0 0 0 0.75px ${tokens.rimLight},
            inset 0 1px 0 ${tokens.rimHighlight}
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
   PRESSABLE BUTTON
   ガラスデザインではないフラットなボタン(設定行・一覧行・チップなど)向けの、
   共通のタップフィードバック。押している間だけ少し縮小+暗くなり、離すと
   すぐ戻る。個々のボタンでpressed状態を都度書かなくて済むように、ここに
   一箇所だけ実装して使い回す(ガラス側は既にGlass+pressedで独自の
   "膨らむ"演出があるので対象外)。
   ───────────────────────────────────────────────────── */
const PressableButton = forwardRef(function PressableButton({ style, onClick, children, ...rest }, ref) {
  const [pressed, setPressed] = useState(false);
  return (
    <button
      ref={ref}
      onClick={onClick}
      onPointerDown={() => setPressed(true)}
      onPointerUp={() => setPressed(false)}
      onPointerCancel={() => setPressed(false)}
      onPointerLeave={() => setPressed(false)}
      style={{
        ...style,
        opacity: pressed ? 0.55 : (style?.opacity ?? 1),
        transform: pressed ? "scale(0.97)" : (style?.transform ?? "scale(1)"),
        transition: "opacity 0.12s ease, transform 0.12s ease",
      }}
      {...rest}
    >
      {children}
    </button>
  );
});

/* ─────────────────────────────────────────────────────
   GLOBAL STYLES
   ───────────────────────────────────────────────────── */
function GlobalStyles({ tokens = THEME_TOKENS.dark }) {
  return (
    <style>{`
      :root {
        --page-bg: ${tokens.pageBg};
        --text: ${tokens.text};
        --glass-opaque-bg: ${tokens.glassOpaqueBg};
      }
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
      /* PC(Windows/Mac)のChrome・Edgeでは、地震一覧などスクロール可能な
         パネル内に、ネイティブの太い白っぽいスクロールバーがそのまま
         出てしまい、Liquid Glassの見た目にそぐわない。スクロール自体は
         有効なまま、バーの見た目だけ全要素で非表示にする。 */
      *, *::before, *::after {
        scrollbar-width: none;      /* Firefox */
        -ms-overflow-style: none;   /* 旧Edge/IE */
      }
      *::-webkit-scrollbar {
        display: none;              /* Chrome, 新Edge, Safari */
        width: 0;
        height: 0;
      }
      html, body, #root { height: 100%; width: 100%; }
      /* iOSのスタンドアロンPWAは、ステータスバー分(env(safe-area-inset-top))だけ
         ドキュメント全体を上にずらして描画するが、高さ自体は増えないため、
         その分だけ下端に隙間ができてしまう。ずらされる分だけ高さを余分に
         確保しておくことで、この隙間を無くす。 */
      html { min-height: calc(100% + env(safe-area-inset-top, 0px)); }
      html {
        overflow: hidden;
        background: var(--page-bg);
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
        background: var(--page-bg);
        font-family: -apple-system, BlinkMacSystemFont,
                     "SF Pro Display", "Helvetica Neue",
                     "Noto Sans JP", sans-serif;
        -webkit-font-smoothing: antialiased;
        overflow: hidden;
        overscroll-behavior: none;
        touch-action: none;
        color: var(--text);
      }
      /* アプリ全体をネイティブアプリのUIのように扱うため、長押しでの
         テキスト選択・コピー/調べる/翻訳メニュー(iOSのcallout)を無効化する。
         フローティングパネルや震度凡例を長押しした時に、意図せず選択
         ハイライトやコピーメニューが出てしまうのを防ぐ。 */
      *, *::before, *::after {
        -webkit-user-select: none;
        user-select: none;
        -webkit-touch-callout: none;
        -webkit-tap-highlight-color: transparent;
      }
      #root {
        position: absolute;
        inset: 0;
        overflow: hidden;
      }
      button { font-family: inherit; background: none; border: none; cursor: pointer; }

      /* Liquid Glassの背景は backdrop-filter の blur ありきで
         rgba(255,255,255,0.02) というほぼ完全に透明な色にしている。
         backdrop-filter に対応していない環境(一部のAndroid端末やPC)では、
         ぼかしが一切効かず、ほぼ透明な色だけが残るため、パネルが
         「完全に透けて見える」状態になってしまう。
         backdrop-filterが使えない場合だけ、はっきり見える不透明めの
         背景色に差し替える(!importantはこのフォールバック目的でのみ使用)。 */
      @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
        .glass-backdrop-layer {
          background: var(--glass-opaque-bg) !important;
        }
      }

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

   localStorageではなく Cache API (caches.open) を使う理由:
   - localStorageは5〜10MB程度(ブラウザ依存)しか使えず、world.jsonや
     細分区域.json(いずれも10MB超)を保存しようとすると容量超過しやすい。
   - Cache APIはResponseをそのまま保存できるため文字列化(JSON.stringify/parse)の
     コストが無く、上限もブラウザの空きディスク容量に応じて大きく取れる。
   - Service Worker無し(ページのJSから直接)でも caches.open() だけで利用できる。
   ───────────────────────────────────────────────────── */
const GEO_CACHE_VERSION = "v1"; // データ更新時はここを上げるとキャッシュを無効化できる
const GEO_CACHE_NAME = `bosai-geo-${GEO_CACHE_VERSION}`;

// Cache APIが使えない環境(プライベートブラウジング等で無効化されている場合や
// 古いブラウザ)でも、キャッシュを諦めるだけで動作は継続できるようにする。
function isCacheApiAvailable() {
  return typeof caches !== "undefined";
}

async function cachedFetchJSON(url) {
  if (!isCacheApiAvailable()) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} の取得に失敗しました (${res.status})`);
    return res.json();
  }

  try {
    const cache = await caches.open(GEO_CACHE_NAME);
    const cached = await cache.match(url);
    if (cached) return cached.json();

    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} の取得に失敗しました (${res.status})`);
    // レスポンスはストリームなので、キャッシュ保存用と読み取り用で複製してから使う
    await cache.put(url, res.clone());
    return res.json();
  } catch (err) {
    // QuotaExceededError などでキャッシュの読み書きに失敗した場合は、
    // キャッシュを諦めて素のfetchにフォールバックする(アプリ自体は動作を継続)。
    console.warn(`地図データのキャッシュ(Cache API)に失敗しました(${url})。`, err);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} の取得に失敗しました (${res.status})`);
    return res.json();
  }
}

let geoDataPromise = null;
function loadGeoData() {
  if (geoDataPromise) return geoDataPromise;
  geoDataPromise = Promise.all([
    cachedFetchJSON(`${import.meta.env.BASE_URL}map/world.json`),
    cachedFetchJSON(`${import.meta.env.BASE_URL}map/prefectures.json`),
    cachedFetchJSON(`${import.meta.env.BASE_URL}map/細分区域.json`),
  ]).then(([world, prefectures, areas]) => ({ world, prefectures, areas }));
  return geoDataPromise;
}

/* ─────────────────────────────────────────────────────
   MAPLIBREスタイル生成
   ローカルのworld.json(GeometryCollection)・prefectures.json(FeatureCollection)を
   そのままGeoJSONソースとしてMapLibreに渡し、ダークテーマで塗り分ける。
   外部タイルサーバー・外部スタイルには一切依存しない。

   areas(細分区域.json)は、気象庁の細分区域ごとの震度分布を塗るためのソース。
   実際の色は震度分布モードがONの間だけ、feature-state(setFeatureState)で
   区域ごとに動的に設定する。ここでは初期値(無色・透明)のレイヤーだけ用意しておく。
   ───────────────────────────────────────────────────── */
function buildMapStyle({ world, prefectures, areas }, mapColors = THEME_TOKENS.dark) {
  return {
    version: 8,
    sources: {
      world: { type: "geojson", data: world },
      prefectures: { type: "geojson", data: prefectures },
      // idをproperties.code(気象庁の細分区域コード)に昇格しておくことで、
      // setFeatureState({ source: "areas", id: code }, ...) で個別に塗り分けできる。
      areas: { type: "geojson", data: areas, promoteId: "code" },
    },
    layers: [
      { id: "bg", type: "background", paint: { "background-color": mapColors.mapBg } },
      {
        id: "world-fill", type: "fill", source: "world",
        paint: { "fill-color": mapColors.mapWorldFill },
      },
      {
        id: "world-line", type: "line", source: "world",
        paint: { "line-color": mapColors.mapWorldLine, "line-width": 0.5 },
      },
      {
        id: "prefectures-fill", type: "fill", source: "prefectures",
        paint: { "fill-color": mapColors.mapPrefFill },
      },
      {
        id: "prefectures-line", type: "line", source: "prefectures",
        paint: { "line-color": mapColors.mapPrefLine, "line-width": 0.6 },
      },
      {
        // 震度分布(細分区域ごとの塗り分け)。feature-stateが無い区域は透明のまま。
        id: "areas-intensity-fill", type: "fill", source: "areas",
        paint: {
          "fill-color": ["coalesce", ["feature-state", "color"], "rgba(0,0,0,0)"],
          "fill-opacity": 0.75,
        },
      },
      {
        id: "areas-intensity-line", type: "line", source: "areas",
        paint: {
          "line-color": "rgba(0,0,0,0.35)",
          "line-width": ["coalesce", ["feature-state", "hasIntensity"], 0],
        },
      },
    ],
  };
}

/* ─────────────────────────────────────────────────────
   MAP CANVAS — MapLibre GL JS(描画エンジン) + ローカルGeoJSON(データ)
   世界(world.json)・都道府県(prefectures.json)をベクターとして描画する。
   外部タイル・外部スタイルサーバーには依存しない。
   ───────────────────────────────────────────────────── */
function MapCanvas({
  onReady, stationPoints, hypocenters, isWide,
  quakeTimeStr, maxIntensityKey, estIntensityEnabled, areaFillEnabled,
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const [status, setStatus] = useState("loading"); // loading | ready | error
  const [errorMsg, setErrorMsg] = useState("");
  // 現在選択中の震度配色スキーム。観測点マーカー・震度分布の塗り分けの両方で使う。
  const colorSchemeId = useContext(QuakeColorSchemeContext);
  const colorScheme = QUAKE_COLOR_SCHEMES[colorSchemeId] || QUAKE_COLOR_SCHEMES.fill;
  // 地図の基本配色(海・陸・都道府県境界線)。ライト/ダークモードで切り替える。
  const { tokens: themeTokens, mode } = useContext(ThemeContext);
  const tokens = themeTokens; // 下方で自動変換されたtokens.*参照のためのエイリアス
  // マップ生成(下のuseEffect本体)は[]依存で一度きりしか走らないため、
  // 生成時点の最新トークンをrefで参照する。切り替え時の反映は
  // 別のuseEffectでsetPaintPropertyして行う(下方)。
  const themeTokensRef = useRef(themeTokens);
  themeTokensRef.current = themeTokens;

  useEffect(() => {
    let cancelled = false;

    Promise.all([loadMapLibre(), loadGeoData()])
      .then(([maplibregl, geo]) => {
        if (cancelled || !containerRef.current) return;

        let map;
        try {
          map = new maplibregl.Map({
            container: containerRef.current,
            style: buildMapStyle(geo, themeTokensRef.current),
            center: [138.0, 38.0], // 日本全体が収まる中心付近
            zoom: 4.5,
            pitch: 0,
            attributionControl: false,
            // ナビゲーション操作はLiquid Glassの自前ボタンで行うため
            // 標準コントロールはあえて追加しない

            // preserveDrawingBuffer: true
            // MapLibreのWebGL canvasはデフォルトだと描画直後にdrawing bufferを
            // 破棄してよいことになっている(次フレームでどうせ描き直すため)。
            // 通常表示ではこれで問題ないが、backdrop-filterはブラウザの
            // コンポジタが「今画面に出ている見た目」をその都度スナップショット
            // して読みに行く処理であり、Windows Chromium(ANGLE/D3D11経由)の
            // GPUコンポジットのタイミングによっては、そのスナップショットの
            // 瞬間にはすでにbufferがクリア済み=空、ということが起こり得る。
            // これが「backdrop-filterのガラスパネルの中だけWebGL地図が
            // 全く映らず完全に透ける」症状の典型的な原因のひとつ。
            // preserveDrawingBufferをtrueにすると毎フレームのbufferが
            // 保持されるため、コンポジタがいつ読みに来ても地図が残っている
            // 状態になる(引き換えに描画コストがわずかに上がる)。
            preserveDrawingBuffer: true,
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
          // 白フチ付きの赤いバツ印にするため、まず太めの白でストロークしてから
          // その上に少し細い赤をストロークすることで、白い縁取りを再現する。
          const crossSize = 36;
          const crossCanvas = document.createElement("canvas");
          crossCanvas.width = crossSize; crossCanvas.height = crossSize;
          const cc = crossCanvas.getContext("2d");
          const crossPad = 10;
          const drawCrossPath = () => {
            cc.beginPath();
            cc.moveTo(crossPad, crossPad); cc.lineTo(crossSize - crossPad, crossSize - crossPad);
            cc.moveTo(crossSize - crossPad, crossPad); cc.lineTo(crossPad, crossSize - crossPad);
          };
          cc.lineCap = "round";
          cc.lineJoin = "round";
          cc.strokeStyle = "#ffffff";
          cc.lineWidth = 10;
          drawCrossPath();
          cc.stroke();
          cc.strokeStyle = "#FF453A";
          cc.lineWidth = 6;
          drawCrossPath();
          cc.stroke();
          map.addImage("hypocenter-cross", cc.getImageData(0, 0, crossSize, crossSize));

          // 観測点(震度)マーカー用のアイコン(丸+白フチ+数字)を、
          // 現在の配色スキームに合わせて生成・登録しておく。
          registerStationIcons(map, colorScheme);

          // 観測点マーカー本体。circleではなくsymbolレイヤーにすることで、
          // registerStationIconsで焼いたbitmap(白フチ+数字入り)をそのまま使う。
          // ズームに応じた大きさは、段階切り替えだとカクつくため連続補間(interpolate)にし、
          // 見やすさ重視で全体的に一回り大きめのサイズにしている。
          // 推計震度分布(250mメッシュをベクター化したもの)の塗り・境界線レイヤー。
          // 初期状態は空のFeatureCollectionで登録しておき、実際のデータは専用の
          // useEffect内でsetData()により差し替える(選択中の地震・トグルが変わるたび)。
          // station-points-symbolより前にaddLayerすることで、観測点マーカーより
          // 必ず下に来るようにしている。
          map.addSource("est-intensity-fill", {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
            // MapLibreはGeoJSONソースを内部的にタイル分割して描画するため、単純化
            // (簡略化)されると、隣接タイル同士で境界の頂点位置がわずかにずれて、
            // 継ぎ目(細い線)として見えてしまうことがある。矩形はもともと単純な形状で
            // 単純化の恩恵もほぼ無いため、toleranceを0にして単純化自体を無効化する。
            tolerance: 0,
          });
          map.addLayer({
            id: "est-intensity-fill-layer",
            type: "fill",
            source: "est-intensity-fill",
            paint: {
              "fill-color": buildEstIntensityFillColorExpr(colorScheme),
              "fill-opacity": 0.75,
              // 隣接する矩形ポリゴン同士の境目(内部タイル分割の継ぎ目を含む)に
              // GPU描画特有の細い隙間(線)が出るのを防ぐため、アンチエイリアスを無効化する。
              "fill-antialias": false,
            },
          });
          map.addSource("est-intensity-line", {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          });
          map.addLayer({
            id: "est-intensity-line-layer",
            type: "line",
            source: "est-intensity-line",
            paint: {
              // 外周(色が付いた範囲と地図の背景との境目)は暗い地図に対して見やすいよう白、
              // 震度階級同士の境目(4と5-の間など)は両側とも明るい色なので黒のままにする。
              "line-color": ["match", ["get", "edgeType"], "outer", `rgba(${tokens.ink},0.8)`, "rgba(0,0,0,0.45)"],
              "line-width": 1,
            },
          });

          map.addSource("station-points", {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          });
          map.addLayer({
            id: "station-points-symbol",
            type: "symbol",
            source: "station-points",
            layout: {
              // ズーム6未満は円が小さく数字が潰れるため、数字なしアイコンに切り替える。
              "icon-image": [
                "step", ["zoom"],
                ["concat", "station-icon-", ["get", "intensityKey"], "-dot"],
                6, ["concat", "station-icon-", ["get", "intensityKey"], "-num"],
              ],
              "icon-size": [
                "interpolate", ["linear"], ["zoom"],
                4, 5 / STATION_ICON_BASE_RADIUS,
                7, 10 / STATION_ICON_BASE_RADIUS,
                9, 14 / STATION_ICON_BASE_RADIUS,
                11, 20 / STATION_ICON_BASE_RADIUS,
                14, 30 / STATION_ICON_BASE_RADIUS,
              ],
              "icon-allow-overlap": true,
              "icon-ignore-placement": true,
              // 震度が大きいほど後(=前面)に描画されるよう、sort-keyに震度の並び順を使う。
              "symbol-sort-key": ["get", "sortOrder"],
            },
          });

          // 震源マーカー用のソース・レイヤー。観測点レイヤーより後にaddLayerすることで、
          // MapLibreのレイヤー順だけで「震源は常に観測点より上」を保証する。
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
              // crossSize(36px)を焼いたが、見た目の大きさは元の28px相当のまま保つための比率
              "icon-size": 28 / 36,
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
  // sortOrder(震度の小さい順の連番)をsymbol-sort-keyに渡すことで、
  // 震度が大きい観測点ほど前面に描画されるようにする。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;

    const source = map.getSource("station-points");
    if (!source) return;

    const features = (stationPoints || [])
      .filter(p => p.latitude != null && p.longitude != null)
      .map(p => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [p.longitude, p.latitude] },
        properties: {
          intensityKey: STATION_ICON_KEYS.includes(p.intensityKey) ? p.intensityKey : "0",
          sortOrder: STATION_ICON_KEYS.indexOf(p.intensityKey),
        },
      }));
    source.setData({ type: "FeatureCollection", features });
  }, [stationPoints, status]);

  // 配色スキームが切り替わったら、観測点アイコン(丸+白フチ+数字)を焼き直す。
  // symbolレイヤー側は同じicon-image名を参照し続けるので、updateImageするだけで
  // 表示中のマーカーにも即座に反映される。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    registerStationIcons(map, colorScheme);
  }, [colorScheme, status]);

  // 震度分布(細分区域ごとの塗り分け)を更新する。
  // 前回塗った区域は毎回リセットしてから、今回の集計結果を塗り直す
  // (そうしないと、観測点が無くなった区域の色が古いまま残ってしまう)。
  // 設定でOFFにされている場合は、リセットだけ行って塗り直しはしない(塗りつぶし無し状態にする)。
  const paintedAreaCodesRef = useRef([]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;

    for (const code of paintedAreaCodesRef.current) {
      map.setFeatureState({ source: "areas", id: code }, { color: null, hasIntensity: 0 });
    }
    paintedAreaCodesRef.current = [];

    if (!areaFillEnabled) return;

    const maxByArea = aggregateByArea(stationPoints || []);
    const codes = [];
    maxByArea.forEach((intensityKey, code) => {
      const color = (colorScheme.colors[intensityKey] || colorScheme.colors["0"]).bg;
      map.setFeatureState({ source: "areas", id: code }, { color, hasIntensity: 1 });
      codes.push(code);
    });
    paintedAreaCodesRef.current = codes;
  }, [stationPoints, status, colorScheme, areaFillEnabled]);

  // 選択中の地震(hypocenters)が変わるたびに、震源のバツ印マーカーを更新し、
  // 震源(複数の場合は全件)+周辺の観測点がちょうど収まる範囲へズームする。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    const source = map.getSource("hypocenter-point");
    if (!source) return;

    const validHypocenters = (hypocenters || [])
      .filter(h => h && h.latitude != null && h.longitude != null);

    if (validHypocenters.length === 0) {
      source.setData({ type: "FeatureCollection", features: [] });
      return;
    }

    source.setData({
      type: "FeatureCollection",
      features: validHypocenters.map(h => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [h.longitude, h.latitude] },
        properties: {},
      })),
    });

    // 震源(複数あれば全件) + 観測点(緯度経度が引けたもの)が全部収まる
    // bounding boxを作ってfitBoundsする。観測点が1件も無い(マッチできなかった)
    // 場合は、震源(複数なら重心)を中心にほどよいズームへ寄せる。
    const coords = validHypocenters.map(h => [h.longitude, h.latitude]);
    (stationPoints || []).forEach(p => {
      if (p.latitude != null && p.longitude != null) coords.push([p.longitude, p.latitude]);
    });

    if (coords.length > 1) {
      let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
      coords.forEach(([lon, lat]) => {
        minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
        minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
      });
      // 横画面(isWide)ではフローティングパネルが画面左側を覆っているため、
      // 左のpaddingを広めに取り、パネルに隠れない範囲にズームする。
      map.fitBounds([[minLon, minLat], [maxLon, maxLat]], {
        padding: isWide
          ? { top: 40, bottom: 40, left: 460, right: 40 }
          : { top: 80, bottom: 220, left: 40, right: 40 },
        maxZoom: 9,
        duration: 800,
      });
    } else {
      const [lon, lat] = coords[0];
      map.flyTo({
        center: [lon, lat], zoom: 7, duration: 800,
        // 横画面ではパネルぶん(360px)画面左側が隠れているので、
        // 見た目の中心が隠れない範囲の中央に来るようずらす。
        offset: isWide ? [230, 0] : [0, 0],
      });
    }
  }, [hypocenters, stationPoints, status, isWide]);

  // 推計震度分布(気象庁 estimated_intensity_map)を更新する。
  // 選択中の地震・設定トグルが変わるたびに、画像を取得・ピクセル解析してGeoJSONに変換し、
  // 塗り(est-intensity-fill)・境界線(est-intensity-line)の2つのソースにsetData()する。
  // 画像デコード・320×320のピクセル走査はメッシュ数によっては時間がかかるため、
  // 処理中はestIntensityLoadingをtrueにして呼び出し側(このコンポーネント自身)で
  // ローディング表示を出す。
  const estIntensityRequestIdRef = useRef(0);
  const [estIntensityLoading, setEstIntensityLoading] = useState(false);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;

    const requestId = ++estIntensityRequestIdRef.current;
    const isStale = () => requestId !== estIntensityRequestIdRef.current || mapRef.current !== map;

    const clearData = () => {
      if (map.getSource("est-intensity-fill")) {
        map.getSource("est-intensity-fill").setData({ type: "FeatureCollection", features: [] });
      }
      if (map.getSource("est-intensity-line")) {
        map.getSource("est-intensity-line").setData({ type: "FeatureCollection", features: [] });
      }
    };

    clearData();
    setEstIntensityLoading(false);

    // 対象外(トグルOFF・震度5弱未満・地震未選択)ならここで終了
    if (!estIntensityEnabled || !EST_INTENSITY_MIN_INTENSITY_KEYS.includes(maxIntensityKey)) {
      return;
    }

    setEstIntensityLoading(true);

    fetchEstimatedIntensityMatch(quakeTimeStr, maxIntensityKey)
      .then(async matched => {
        if (isStale()) return;
        if (!matched) { setEstIntensityLoading(false); return; }

        const baseUrl = `https://www.jma.go.jp/bosai/estimated_intensity_map/data/${matched.url}/`;

        // フェーズ1: 全メッシュ画像を取得してピクセル解析し、格子(grid)だけ先に揃える。
        // 境界線の判定で隣接メッシュの実データを参照できるようにするため、
        // 先に全メッシュ分のgridを用意してから、フェーズ2で塗り・境界線を組み立てる。
        // 1枚の取得・解析に失敗しても、他のメッシュは表示できるよう処理を継続する。
        // 1枚ごとにわずかに間を空け(setTimeout 0)、ピクセル走査中もブラウザが
        // 操作やアニメーションに応答できるようにする(長時間のフリーズを避けるため)。
        const gridsByMeshCode = new Map();
        const boundsByMeshCode = new Map();
        for (const meshCode of matched.mesh_num) {
          if (isStale()) return;
          try {
            const bounds = meshCodeToBounds(meshCode);
            const img = await loadImageElement(`${baseUrl}${meshCode}.png`);
            if (isStale()) return;
            gridsByMeshCode.set(meshCode, buildEstIntensityGridFromImage(img));
            boundsByMeshCode.set(meshCode, bounds);
            await new Promise(resolve => setTimeout(resolve, 0));
          } catch (err) {
            console.error(`推計震度分布メッシュ(${meshCode})の変換に失敗:`, err);
          }
        }

        if (isStale()) return;

        // フェーズ2: 各メッシュの塗り・境界線を組み立てる。
        // 境界線は、画像の端(1次メッシュの継ぎ目)で誤って線を引いてしまわないよう、
        // 東隣・南隣のメッシュが取得できていれば、その実データを参照して判定する。
        const allFillFeatures = [];
        const allOuterLineCoords = [];
        const allInnerLineCoords = [];
        for (const [meshCode, grid] of gridsByMeshCode) {
          const bounds = boundsByMeshCode.get(meshCode);
          allFillFeatures.push(...buildEstIntensityFillFeatures(grid, bounds));

          const eastCode = offsetMeshCode(meshCode, 0, 1);
          const southCode = offsetMeshCode(meshCode, -1, 0);
          const neighborGrids = {
            eastGrid: eastCode ? gridsByMeshCode.get(eastCode) : undefined,
            southGrid: southCode ? gridsByMeshCode.get(southCode) : undefined,
          };
          const { outerCoords, innerCoords } = buildEstIntensityLineCoords(grid, bounds, neighborGrids);
          allOuterLineCoords.push(...outerCoords);
          allInnerLineCoords.push(...innerCoords);
        }

        if (isStale()) return;

        map.getSource("est-intensity-fill")?.setData({ type: "FeatureCollection", features: allFillFeatures });
        map.getSource("est-intensity-line")?.setData({
          type: "FeatureCollection",
          features: [
            // 色が付いた範囲と地図の背景との境目(外周)。暗い地図に対して見やすいよう白線にする。
            { type: "Feature", properties: { edgeType: "outer" }, geometry: { type: "MultiLineString", coordinates: allOuterLineCoords } },
            // 震度階級同士の境目(4と5-の間など)。両側とも明るい色なので黒線のままでよい。
            { type: "Feature", properties: { edgeType: "inner" }, geometry: { type: "MultiLineString", coordinates: allInnerLineCoords } },
          ],
        });
        setEstIntensityLoading(false);
      })
      .catch(err => {
        console.error("推計震度分布の取得に失敗:", err);
        if (!isStale()) setEstIntensityLoading(false);
      });
  }, [status, quakeTimeStr, maxIntensityKey, estIntensityEnabled]);

  // 震度配色スキームが変わったら、既に表示中の推計震度分布の塗り色だけを塗り替える
  // (データの再取得・再解析は不要なため、これは別のuseEffectに分けている)。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    if (map.getLayer("est-intensity-fill-layer")) {
      map.setPaintProperty("est-intensity-fill-layer", "fill-color", buildEstIntensityFillColorExpr(colorScheme));
    }
  }, [colorScheme, status]);

  // ライト/ダークモードが切り替わったら、地図の基本配色(海・陸・都道府県境界線)
  // だけを塗り替える。マップの再生成は行わない(ソースの再読み込みが走ると
  // 一瞬地図が消えてちらつくため)。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    map.setPaintProperty("bg", "background-color", themeTokens.mapBg);
    map.setPaintProperty("world-fill", "fill-color", themeTokens.mapWorldFill);
    map.setPaintProperty("world-line", "line-color", themeTokens.mapWorldLine);
    map.setPaintProperty("prefectures-fill", "fill-color", themeTokens.mapPrefFill);
    map.setPaintProperty("prefectures-line", "line-color", themeTokens.mapPrefLine);
  }, [themeTokens, status]);

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: themeTokens.mapBg }}>
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
          gap: 10, color: `rgba(${tokens.ink},0.4)`,
        }}>
          <div style={{
            width: 28, height: 28, borderRadius: "50%",
            border: `2px solid rgba(${tokens.ink},0.15)`,
            borderTopColor: `rgba(${tokens.ink},0.6)`,
            animation: "spin 0.8s linear infinite",
          }}/>
          <span style={{ fontSize: 12 }}>地図を読み込み中…</span>
        </div>
      )}

      {/* 推計震度分布を画像→ベクター変換している間の、地図を隠さない小さなローディング表示 */}
      {status === "ready" && estIntensityLoading && (
        <div style={{
          position: "absolute",
          top: "calc(14px + env(safe-area-inset-top, 0px))",
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 5,
          display: "flex", alignItems: "center", gap: 8,
          padding: "8px 14px",
          borderRadius: 999,
          background: tokens.glassOpaqueBg,
          backdropFilter: "blur(10px)",
          WebkitBackdropFilter: "blur(10px)",
          color: tokens.text,
          fontSize: 12,
          fontWeight: 600,
          // 直下に地図(任意の色)が透けるため、文字の可読性を担保する縁取り。
          textShadow: mode === "light"
            ? "0 1px 2px rgba(255,255,255,0.6)"
            : "0 1px 3px rgba(0,0,0,0.6)",
          boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
          pointerEvents: "none",
        }}>
          <div style={{
            width: 14, height: 14, borderRadius: "50%",
            border: `2px solid rgba(${tokens.ink},0.25)`,
            borderTopColor: `rgba(${tokens.ink},0.9)`,
            animation: "spin 0.8s linear infinite",
            flexShrink: 0,
          }}/>
          推計震度分布を計算中…
        </div>
      )}

      {/* エラー表示 */}
      {status === "error" && (
        <div style={{
          position: "absolute", inset: 0,
          display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center",
          gap: 10, color: "rgba(255,140,140,0.9)", padding: 24, textAlign: "center",
          textShadow: mode === "light" ? "0 1px 2px rgba(255,255,255,0.7)" : "0 1px 3px rgba(0,0,0,0.6)",
        }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>地図を表示できませんでした</span>
          <span style={{ fontSize: 12, color: `rgba(${tokens.ink},0.5)`, maxWidth: 280 }}>{errorMsg}</span>
          <span style={{ fontSize: 11, color: `rgba(${tokens.ink},0.3)`, maxWidth: 280, marginTop: 4 }}>
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
  const { tokens } = useContext(ThemeContext);

  const [t, setT] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setT(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="mono" style={{ fontSize: 12, color: `rgba(${tokens.ink},0.5)` }}>
      {t.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
    </span>
  );
}

/* ─────────────────────────────────────────────────────
   ALERT PILL
   ───────────────────────────────────────────────────── */
const ALERT_COLOR = {
  watch:     "#FFD60A",
  warning:   "#FF9F0A",
  emergency: "#FF453A",
};
function AlertPill({ alert }) {
  const { tokens } = useContext(ThemeContext);

  // "warning"等の警報色は演出上どのテーマでも同じ鮮やかな色を保つが、
  // 警報なし("none")の通常表示は地の文なので、他のテキストと同様に
  // テーマの文字色に追従させる(固定の白だとライトモードで読めなくなるため)。
  const color = ALERT_COLOR[alert.level] || tokens.textSecondary;
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
      <span style={{ fontSize: 13, color: `rgba(${tokens.ink},0.65)` }}>
        {alert.region}
      </span>
      <div style={{ width: 0.5, height: 13, background: `rgba(${tokens.ink},0.25)`, flexShrink: 0 }}/>
      <Clock/>
    </Glass>
  );
}

/* ─────────────────────────────────────────────────────
   震度スケール — JMA震度階(0〜7、10区分)を液体ガラスのダークUIに合わせて配色。
   明るい色(〜5強)は黒文字、暗く濃い色(6弱〜7)は白文字でコントラストを確保。

   ユーザーが「地震」タブの設定画面から配色スキームを切り替えられるよう、
   色(bg/fg)だけを複数パレット化している。ラベル("6弱"等)はスキームに
   依存しない共通の情報なのでINTENSITY_LABELに1本化した。
   ───────────────────────────────────────────────────── */
const INTENSITY_LABEL = {
  "0": "0", "1": "1", "2": "2", "3": "3", "4": "4",
  "5": "5", "5-": "5弱", "5+": "5強", "6": "6", "6-": "6弱", "6+": "6強", "7": "7",
  "?": "?", // 震度が取得できなかった場合(「0」と区別する)
};

// 観測点マーカーをMapLibreのsymbolレイヤーで描くための下準備。
// 震度キーは有限個(0〜7,5-,5+,6-,6+,?)しかないので、キーごとに
// 「丸+白フチ+震度番号」を1枚のbitmapとして事前にcanvasへ焼いておき、
// addImageでMapLibreに登録する。text-fieldを使わないため、
// スタイルにglyphs(フォント配信)を用意しなくても数字を表示できる。
const STATION_ICON_KEYS = ["0", "1", "2", "3", "4", "5", "5-", "5+", "6", "6-", "6+", "7", "?"];

// 震度キーの弱い順(小さい順)の並び。震度リストのソート・グループ化・
// 折りたたみ判定など、複数箇所で「震度の大小比較」が必要な場面で共通して使う。
const INTENSITY_ORDER = ["0","1","2","3","4","5","5-","5+","6","6-","6+","7"];
const STATION_ICON_BASE_RADIUS = 32; // bitmap側の半径(px)。icon-sizeで実際の大きさへスケールする。

// withText=falseの場合は数字を描かない(低ズームで円が小さいときに文字が潰れるのを避けるため)。
function buildStationIconCanvas(bg, fg, label, withText) {
  const size = STATION_ICON_BASE_RADIUS * 2;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const cx = size / 2, cy = size / 2, r = STATION_ICON_BASE_RADIUS - 2;

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#ffffff";
  ctx.stroke();

  if (withText) {
    // アプリ全体のCSSと同じフォントスタックに揃える。iOSではSan Francisco、
    // それ以外ではNoto Sans JP等に自然にフォールバックし、見た目を統一する。
    const STATION_ICON_FONT_STACK =
      '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", "Noto Sans JP", sans-serif';
    // 文字数で単純に切り替えると「5-」「6+」のような2文字が「1」等の1文字より
    // 見た目に小さくなってしまうため、実際の文字幅を測って、丸からはみ出さない
    // 範囲でできるだけ大きく表示されるようフォントサイズを自動調整する。
    const maxTextWidth = r * 1.7;
    let fontSize = r * 1.3;
    ctx.font = `800 ${fontSize}px ${STATION_ICON_FONT_STACK}`;
    const width = ctx.measureText(label).width;
    if (width > maxTextWidth) {
      fontSize *= maxTextWidth / width;
      ctx.font = `800 ${fontSize.toFixed(1)}px ${STATION_ICON_FONT_STACK}`;
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = fg;
    ctx.fillText(label, cx, cy + 1);
  }
  return ctx.getImageData(0, 0, size, size);
}

// 現在の配色スキームに合わせて、観測点アイコン(数字あり/なしの2種類 x 震度キー分)を
// まとめて生成し、MapLibreへaddImage/updateImageする。配色スキームが切り替わるたびに呼ぶ。
function registerStationIcons(map, scheme) {
  STATION_ICON_KEYS.forEach(key => {
    const style = scheme.colors[key] || scheme.colors["0"];
    // 地図上の丸には「5弱」「6強」ではなくキー表記(5-,6+等)をそのまま出す。
    const label = key;
    const dotImg = buildStationIconCanvas(style.bg, style.fg, label, false);
    const numImg = buildStationIconCanvas(style.bg, style.fg, label, true);
    const dotId = `station-icon-${key}-dot`;
    const numId = `station-icon-${key}-num`;
    if (map.hasImage(dotId)) map.updateImage(dotId, dotImg); else map.addImage(dotId, dotImg);
    if (map.hasImage(numId)) map.updateImage(numId, numImg); else map.addImage(numId, numImg);
  });
}

const QUAKE_COLOR_SCHEMES = {
  // 過去のLeaflet版(getIntensityColor)と全く同じ、鮮やかなApple風パレット。
  legacy: {
    label: "eqs viewer配色",
    colors: {
      "0":  { bg: "#8E8E93", fg: "#fff" },
      "1":  { bg: "#64D2FF", fg: "#0B0B0C" },
      "2":  { bg: "#0A84FF", fg: "#fff" },
      "3":  { bg: "#30D158", fg: "#0B0B0C" },
      "4":  { bg: "#FFD60A", fg: "#0B0B0C" },
      "5":  { bg: "#FF9F0A", fg: "#0B0B0C" }, // 1996年10月改定前の「弱/強」区分が無い震度5
      "5-": { bg: "#FF9F0A", fg: "#0B0B0C" },
      "5+": { bg: "#FF453A", fg: "#fff" },
      "6":  { bg: "#FF2D55", fg: "#fff" }, // 同上、震度6
      "6-": { bg: "#FF2D55", fg: "#fff" },
      "6+": { bg: "#BF5AF2", fg: "#fff" },
      "7":  { bg: "#5E5CE6", fg: "#fff" },
      "?":  { bg: "#8E8E93", fg: "rgba(255,255,255,0.5)" },
    },
  },
  // 気象庁「ホームページにおける気象情報の配色に関する設定指針」(表２－２ 震度)に
  // 定められた公式のRGB値をそのまま使用。
  // 震度7:(180,0,104) 6強:(165,0,33) 6弱:(255,40,0) 5強:(255,153,0) 5弱:(255,230,0)
  // 4:(250,230,150) 3:(0,65,255) 2:(0,170,255) 1:(242,242,255)
  jma: {
    label: "気象庁配色",
    colors: {
      "0":  { bg: "#E5E5EA", fg: "#0B0B0C" }, // 震度0は指針に規定が無いため、背景に馴染む薄いグレーにしている
      "1":  { bg: "#F2F2FF", fg: "#0B0B0C" },
      "2":  { bg: "#00AAFF", fg: "#0B0B0C" },
      "3":  { bg: "#0041FF", fg: "#fff" },
      "4":  { bg: "#FAE696", fg: "#0B0B0C" },
      "5":  { bg: "#FFE600", fg: "#0B0B0C" }, // 1996年10月改定前の「弱/強」区分が無い震度5
      "5-": { bg: "#FFE600", fg: "#0B0B0C" },
      "5+": { bg: "#FF9900", fg: "#0B0B0C" },
      "6":  { bg: "#FF2800", fg: "#fff" }, // 同上、震度6
      "6-": { bg: "#FF2800", fg: "#fff" },
      "6+": { bg: "#A50021", fg: "#fff" },
      "7":  { bg: "#B40068", fg: "#fff" },
      "?":  { bg: "#C7C7CC", fg: "rgba(11,11,12,0.5)" },
    },
  },
  // このアプリで震度分布の塗りつぶし・バッジに元々使っていた配色。
  fill: {
    label: "",
    colors: {
      "0":  { bg: "#3A3A3C", fg: "#fff" },
      "1":  { bg: "#2F6690", fg: "#fff" },
      "2":  { bg: "#3FA9E0", fg: "#0B0B0C" },
      "3":  { bg: "#4FBF67", fg: "#0B0B0C" },
      "4":  { bg: "#FFD60A", fg: "#0B0B0C" },
      "5":  { bg: "#FF9F0A", fg: "#0B0B0C" }, // 1996年10月改定前の「弱/強」区分が無い震度5
      "5-": { bg: "#FF9F0A", fg: "#0B0B0C" },
      "5+": { bg: "#FF7A1A", fg: "#0B0B0C" },
      "6":  { bg: "#E0342C", fg: "#fff" }, // 同上、震度6
      "6-": { bg: "#E0342C", fg: "#fff" },
      "6+": { bg: "#8A1518", fg: "#fff" },
      "7":  { bg: "#AF52DE", fg: "#fff" }, // 紫
      "?":  { bg: "#3A3A3C", fg: "rgba(255,255,255,0.5)" },
    },
  },
};

// 現在選択中の震度配色スキームID("legacy" | "jma" | "fill")を
// アプリ全体に配るコンテキスト。地図・バッジ・凡例など離れた場所からでも
// props バケツリレーせずに参照できるようにする。
const QuakeColorSchemeContext = createContext("legacy");

// 震度配色スキームの選択はブラウザのlocalStorageに保存し、次回起動時も覚えておく。
// (プライベートブラウジング等でlocalStorageが使えない環境でも落ちないようtry/catchで囲む)
const QUAKE_COLOR_SCHEME_STORAGE_KEY = "quakeColorScheme";

function loadStoredQuakeColorScheme() {
  try {
    const saved = localStorage.getItem(QUAKE_COLOR_SCHEME_STORAGE_KEY);
    if (saved && QUAKE_COLOR_SCHEMES[saved]) return saved;
  } catch (err) {
    console.warn("震度配色の設定を読み込めませんでした:", err);
  }
  return "legacy";
}

function saveQuakeColorScheme(schemeId) {
  try {
    localStorage.setItem(QUAKE_COLOR_SCHEME_STORAGE_KEY, schemeId);
  } catch (err) {
    console.warn("震度配色の設定を保存できませんでした:", err);
  }
}

/* ─────────────────────────────────────────────────────
   ライト/ダークモード
   
   アプリ全体はもともとダーク基調(#121214背景+白文字)で作られているため、
   ライトモードは「別の配色を丸ごと用意し、UIのベースとなる色をcontext経由で
   出し分ける」形で追加する。地図の基本配色(海・陸のタイル色)や、震度色
   バッジのような意味を持つ色(震度配色スキームなど)まではこの対応範囲に
   含めない(それらは別途テーマ対応が必要)。まずは背景・カード・文字色
   など、UIチューム全体に効いてくる基礎トークンをテーマ切り替え対象にする。
   ───────────────────────────────────────────────────── */
const THEME_TOKENS = {
  dark: {
    pageBg: "#121214",
    text: "#ffffff",
    textSecondary: "rgba(255,255,255,0.55)",
    textTertiary: "rgba(255,255,255,0.35)",
    cardBg: "rgba(255,255,255,0.04)",
    cardBorder: "rgba(255,255,255,0.08)",
    divider: "rgba(255,255,255,0.08)",
    glassTint: "rgba(255,255,255,0.02)",
    glassOpaqueBg: "rgba(32,32,36,0.92)",
    rimLight: "rgba(255,255,255,0.45)",
    rimHighlight: "rgba(255,255,255,0.55)",
    // ナビ行(SideNavRail/BottomDockの下部タブ)の選択中ピル。
    // ダークはこれまで通りガラスの縁取り(rim)入りの見た目を維持する。
    navPillBg: "rgba(255,255,255,0.13)",
    navPillShadow: "inset 0 0 0 0.5px rgba(255,255,255,0.45), inset 0 1px 0 rgba(255,255,255,0.55)",
    // 文字・線用のRGBチャンネル値(不透明度だけ変えたrgba(${tokens.ink},X)の形で
    // 各所から使う。ダークは白、ライトはほぼ黒)。
    ink: "255,255,255",
    // 検索ボタンなどのアクセント文字色。ダークは明るい水色の方が背景に映えるが、
    // ライトの明るい背景だと同じ色ではコントラストが足りず読みにくくなるため、
    // ライトモードではやや濃い標準的なシステムブルーにする。
    accentText: "#64D2FF",
    // 地図の基本配色(海・陸・都道府県境界線)
    mapBg: "#121214",         // 海
    mapWorldFill: "#2c2c2e",  // 陸地(海外)
    mapWorldLine: "rgba(255,255,255,0.08)",
    mapPrefFill: "#3a3a3c",   // 都道府県(日本)
    mapPrefLine: "rgba(255,255,255,0.18)",
  },
  light: {
    pageBg: "#eef0f3",
    text: "#15161a",
    textSecondary: "rgba(21,22,26,0.6)",
    textTertiary: "rgba(21,22,26,0.4)",
    cardBg: "rgba(21,22,26,0.045)",
    cardBorder: "rgba(21,22,26,0.10)",
    divider: "rgba(21,22,26,0.10)",
    glassTint: "rgba(255,255,255,0.55)",
    glassOpaqueBg: "rgba(244,245,248,0.94)",
    rimLight: "rgba(21,22,26,0.16)",
    rimHighlight: "rgba(255,255,255,0.8)",
    // ナビ行の選択中ピル。参考画像のような、縁取りのないフラットな
    // 淡いグレーのピルにする(ダークのようなガラスの縁取りは入れない)。
    navPillBg: "rgba(21,22,26,0.07)",
    navPillShadow: "none",
    ink: "21,22,26",
    accentText: "#0A84FF",
    // 地図の基本配色(海・陸・都道府県境界線)
    mapBg: "#aecbe8",         // 海
    mapWorldFill: "#e4e2dc",  // 陸地(海外)
    mapWorldLine: "rgba(21,22,26,0.12)",
    mapPrefFill: "#f2f0ea",   // 都道府県(日本)
    mapPrefLine: "rgba(21,22,26,0.22)",
  },
};

// UIのベースになる配色トークンを、モード("dark"|"light")込みでアプリ全体に配るcontext。
// { mode, tokens, setMode } の形。tokensはTHEME_TOKENS[mode]そのもの。
const ThemeContext = createContext({
  mode: "dark",
  tokens: THEME_TOKENS.dark,
  setMode: () => {},
});

// テーマの選択はlocalStorageに保存し、次回起動時も覚えておく。初期設定はダーク。
const THEME_MODE_STORAGE_KEY = "themeMode";

function loadStoredThemeMode() {
  try {
    const saved = localStorage.getItem(THEME_MODE_STORAGE_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch (err) {
    console.warn("テーマ設定を読み込めませんでした:", err);
  }
  return "dark";
}

function saveThemeMode(mode) {
  try {
    localStorage.setItem(THEME_MODE_STORAGE_KEY, mode);
  } catch (err) {
    console.warn("テーマ設定を保存できませんでした:", err);
  }
}


/* ─────────────────────────────────────────────────────
   推計震度分布(気象庁 estimated_intensity_map)の表示ON/OFF設定。
   震度配色と同様、ブラウザのlocalStorageに保存し次回起動時も覚えておく。
   デフォルトはON(防災アプリとして、初回起動時から見えている方が安全側)。
   ───────────────────────────────────────────────────── */
const EST_INTENSITY_ENABLED_STORAGE_KEY = "showEstimatedIntensity";

function loadStoredEstIntensityEnabled() {
  try {
    const saved = localStorage.getItem(EST_INTENSITY_ENABLED_STORAGE_KEY);
    if (saved === "true") return true;
    if (saved === "false") return false;
  } catch (err) {
    console.warn("推計震度分布の表示設定を読み込めませんでした:", err);
  }
  return true;
}

function saveEstIntensityEnabled(enabled) {
  try {
    localStorage.setItem(EST_INTENSITY_ENABLED_STORAGE_KEY, String(enabled));
  } catch (err) {
    console.warn("推計震度分布の表示設定を保存できませんでした:", err);
  }
}

/* ─────────────────────────────────────────────────────
   細分区域(気象庁の細分区域単位)を震度の色で塗りつぶすかどうかの設定。
   推計震度分布と同様、localStorageに保存し次回起動時も覚えておく。
   デフォルトはON(従来どおりの見た目を維持する)。
   ───────────────────────────────────────────────────── */
const AREA_FILL_ENABLED_STORAGE_KEY = "showAreaIntensityFill";

function loadStoredAreaFillEnabled() {
  try {
    const saved = localStorage.getItem(AREA_FILL_ENABLED_STORAGE_KEY);
    if (saved === "true") return true;
    if (saved === "false") return false;
  } catch (err) {
    console.warn("細分区域塗りつぶしの表示設定を読み込めませんでした:", err);
  }
  return true;
}

function saveAreaFillEnabled(enabled) {
  try {
    localStorage.setItem(AREA_FILL_ENABLED_STORAGE_KEY, String(enabled));
  } catch (err) {
    console.warn("細分区域塗りつぶしの表示設定を保存できませんでした:", err);
  }
}

/* ─────────────────────────────────────────────────────
   地震一覧の取得件数の設定。
   P2P地震情報APIの /history から一度に取得する件数(=一覧に表示する最大件数)。
   1〜1000件の範囲でユーザーが指定でき、localStorageに保存する。デフォルトは100件。
   ───────────────────────────────────────────────────── */
const QUAKE_FETCH_LIMIT_STORAGE_KEY = "quakeFetchLimit";
const QUAKE_FETCH_LIMIT_MIN = 1;
const QUAKE_FETCH_LIMIT_MAX = 1000;
const QUAKE_FETCH_LIMIT_DEFAULT = 100;

function clampQuakeFetchLimit(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return QUAKE_FETCH_LIMIT_DEFAULT;
  return Math.min(QUAKE_FETCH_LIMIT_MAX, Math.max(QUAKE_FETCH_LIMIT_MIN, n));
}

function loadStoredQuakeFetchLimit() {
  try {
    const saved = localStorage.getItem(QUAKE_FETCH_LIMIT_STORAGE_KEY);
    if (saved != null) return clampQuakeFetchLimit(saved);
  } catch (err) {
    console.warn("地震の取得件数の設定を読み込めませんでした:", err);
  }
  return QUAKE_FETCH_LIMIT_DEFAULT;
}

function saveQuakeFetchLimit(limit) {
  try {
    localStorage.setItem(QUAKE_FETCH_LIMIT_STORAGE_KEY, String(clampQuakeFetchLimit(limit)));
  } catch (err) {
    console.warn("地震の取得件数の設定を保存できませんでした:", err);
  }
}

/* ─────────────────────────────────────────────────────
   震度観測点リスト(StationPointsList)の表示方法。
   "grouped" = 震度階級ごとに階層表示(既定)、"list" = 従来のフラット一覧。
   震度配色などと同様、localStorageに保存し次回起動時も覚えておく。
   ───────────────────────────────────────────────────── */
const STATION_LIST_DISPLAY_MODES = {
  grouped: { label: "階層表示" },
  list:    { label: "一覧表示" },
};
const STATION_LIST_DISPLAY_MODE_STORAGE_KEY = "stationListDisplayMode";

function loadStoredStationListDisplayMode() {
  try {
    const saved = localStorage.getItem(STATION_LIST_DISPLAY_MODE_STORAGE_KEY);
    if (saved && STATION_LIST_DISPLAY_MODES[saved]) return saved;
  } catch (err) {
    console.warn("震度観測点リストの表示設定を読み込めませんでした:", err);
  }
  return "list"; // 既定は一覧表示
}

function saveStationListDisplayMode(mode) {
  try {
    localStorage.setItem(STATION_LIST_DISPLAY_MODE_STORAGE_KEY, mode);
  } catch (err) {
    console.warn("震度観測点リストの表示設定を保存できませんでした:", err);
  }
}

// 指定したスキームオブジェクトについて、震度キーに対応する{ bg, fg, label }を返す。
// .map()のコールバック内などフックを呼べない場所からはこちらを直接使う
// (スキーム自体はコンポーネント側で useContext(QuakeColorSchemeContext) して渡す)。
function getIntensityStyleFromScheme(scheme, intensityKey) {
  const c = scheme.colors[intensityKey] || scheme.colors["0"];
  const label = INTENSITY_LABEL[intensityKey] || INTENSITY_LABEL["0"];
  return { bg: c.bg, fg: c.fg, label };
}

// 指定した震度キー("1"〜"7","5-"などINTENSITY_LABELのキー)について、
// 現在選択中のスキームに沿った{ bg, fg, label }を返す。
function useIntensityStyle(intensityKey) {
  const schemeId = useContext(QuakeColorSchemeContext);
  const scheme = QUAKE_COLOR_SCHEMES[schemeId] || QUAKE_COLOR_SCHEMES.fill;
  return getIntensityStyleFromScheme(scheme, intensityKey);
}

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
const P2PQUAKE_HISTORY_URL_BASE = "https://api.p2pquake.net/v2/history?codes=551";

function maxScaleToIntensityKey(maxScale) {
  const map = {
    "-1": "0", "0": "0",
    "10": "1", "20": "2", "30": "3", "40": "4",
    "44": "5", "45": "5-", "50": "5+",
    "54": "6", "55": "6-", "60": "6+",
    "70": "7",
  };
  return map[String(maxScale)] ?? "?";
}

// API由来のISO風文字列("2024/01/01 12:34:56.789")を "YYYY/MM/DD HH:mm:ss" 表示用に整える
function formatQuakeTime(raw) {
  if (!raw) return "";
  return raw.split(".")[0]; // ミリ秒以下を切り捨てるだけで日本時間表記のまま使える
}

// 発生時刻を「YYYY/MM/DD HH:mm頃」の表示用に整形する(QuakeDetailCard用)。
// formatQuakeTime()済みの "YYYY/MM/DD HH:mm:ss" (または元のISO風文字列)どちらを渡しても動くよう、
// 空白で日付部分と時刻部分に分け、時刻はHH:mmだけ取り出して秒は切り捨てる。
function formatQuakeTimeShort(raw) {
  if (!raw) return "";
  const [datePart, timePart] = raw.split(" ");
  if (!timePart) return raw;
  const [hh, mm] = timePart.split(":");
  if (hh == null || mm == null) return raw;
  return `${datePart} ${hh}:${mm}頃`;
}

// P2P地震情報APIの1レコードを、QuakeDetailCardが使う形に変換する
function toQuakeCard(item) {
  const eq = item.earthquake;
  const hypo = eq?.hypocenter;
  const points = Array.isArray(item?.points) ? item.points : [];

  // 遠地地震(海外で発生し、国内で震度が観測されない地震)に関する情報かどうか。
  // issue.type === "Foreign" の場合、maxScaleは "-1"(観測なし)になる。
  // これを国内の「震度0(揺れなし)」と同じ扱いにしてしまうと紛らわしいため、区別する。
  const isForeign = item?.issue?.type === "Foreign";

  // earthquake.maxScaleが欠落/nullのレコードが稀に存在する
  // (震度速報→詳細への更新過程などで一時的に未設定のことがある)。
  // その場合はpoints[]の中の最大scaleから補完し、「震度0」の誤表示を防ぐ。
  // ただし遠地地震はそもそも国内観測点のpointsを持たないため、補完の対象外とする。
  let maxScale = eq?.maxScale;
  if (!isForeign && maxScale == null && points.length > 0) {
    maxScale = points.reduce((max, p) => (typeof p.scale === "number" && p.scale > max ? p.scale : max), -1);
  }

  return {
    id: item.id,
    time: formatQuakeTime(eq?.time),
    place: hypo?.name || "震源地不明",
    maxIntensity: isForeign ? "?" : maxScaleToIntensityKey(maxScale),
    isForeign,
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
  None:         { text: "この地震による津波の心配はありません。" },
  Unknown:      { text: "津波の有無について、現在調査中です。",                   color: "#FFD60A" },
  Checking:     { text: "津波の有無について、現在調査中です。",                   color: "#FFD60A" },
  NonEffective: { text: "若干の海面変動が予想されますが、被害の心配はありません。", color: "#FFD60A" },
  Watch:        { text: "この地震により、津波注意報が発表されています。",         color: "#FF9F0A" },
  Warning:      { text: "この地震により、津波警報が発表されています。",           color: "#FF453A" },
  MajorWarning: { text: "この地震により、大津波警報が発表されています。",         color: "#FF453A" },
};

function buildQuakeMessage(quake) {
  const { tokens } = useContext(ThemeContext);

  const tsunami = TSUNAMI_TEXT[quake.domesticTsunami] || TSUNAMI_TEXT.None;
  const lines = [{ label: "津波情報", text: tsunami.text, color: tsunami.color || tokens.textSecondary }];
  if (quake.freeFormComment) {
    lines.push({ label: "付加文", text: quake.freeFormComment, color: `rgba(${tokens.ink},0.75)` });
  }
  return lines;
}

// 直近の地震情報一覧を取得する。取得失敗時はエラーを投げる(呼び出し側でハンドリング)。
/* ─────────────────────────────────────────────────────
   重複レコードの除外
   同じ地震について、気象庁から複数の電文(震度・観測点を含むものと、
   震源(位置・M・深さ)だけを伝えるもの)が別レコードとして配信されることがある。
   その場合、同じ発生時刻+同じ震源地なのに「震度4」と「震度0」が別々に
   一覧に並んでしまい、後者はあたかも別の(無感)地震のように見えて紛らわしい。
   → 発生時刻+震源地が一致するグループの中に、実際に震度情報(points)を
     持つレコードが1件でもあれば、震度情報を持たない(points空 かつ 震度0)
     レコードは「同じ地震の随伴電文」とみなして除外する。
   ───────────────────────────────────────────────────── */
function dedupeQuakeList(list) {
  // 発生時刻+震源地が一致すれば「同じ地震の一連の電文」とみなす。
  // 以前はM・深さも一致条件に含めていたが、顕著な地震などでは
  // 「震源に関する情報(速報値)」→「震源・震度に関する情報(確定値)」の
  // 過程でM・深さがわずかに修正されることがあり、その場合に一致しなくなって
  // 同じ地震が2件並んでしまう不具合があった。
  // (時刻+震源地が完全一致する別々の地震が同時に起きる可能性は極めて低いため、
  //  M・深さを条件から外しても誤結合のリスクは実用上問題にならない)
  const groupKey = q => `${q.time}|${q.place}`;

  // 各グループについて、最も情報量の多い(震度情報を持つ、かつリスト内でより後に
  // 出てきた=より新しい)レコードだけを残す。
  const bestInGroup = new Map(); // groupKey -> 現時点で最良のレコード
  for (const q of list) {
    const key = groupKey(q);
    const existing = bestInGroup.get(key);
    if (!existing) {
      bestInGroup.set(key, q);
      continue;
    }
    const existingSubstantial = existing.points.length > 0 || (existing.maxIntensity !== "0" && existing.maxIntensity !== "?");
    const qSubstantial = q.points.length > 0 || (q.maxIntensity !== "0" && q.maxIntensity !== "?");
    // 震度情報を持つ方を優先。情報量が同じレベルなら、より新しい(リスト内で後の)方を採用する
    // ことで、M・深さの修正(確定値への更新)を反映できるようにする。
    if (qSubstantial || qSubstantial === existingSubstantial) {
      bestInGroup.set(key, q);
    }
  }

  // 元のリストの並び順を保ったまま、各グループを1件にまとめて書き出す
  const order = [];
  const seen = new Set();
  for (const q of list) {
    const key = groupKey(q);
    if (!seen.has(key)) { seen.add(key); order.push(key); }
  }
  return order.map(key => bestInGroup.get(key));
}

/* ─────────────────────────────────────────────────────
   気象庁 推計震度分布(estimated_intensity_map) 連携
   震度5弱以上の地震選択時、気象庁が発表する250mメッシュの推計震度分布画像を
   地図上に重ねて表示する。過去に別アプリ(index.html版)で実装済みのロジックを
   MapLibre GL JS向けに移植したもの。
   ───────────────────────────────────────────────────── */
const EST_INTENSITY_LIST_URL = "https://www.jma.go.jp/bosai/estimated_intensity_map/data/list.json";
// 一覧データの発生時刻とP2P地震情報側の発生時刻がぴったり一致しないことがあるため、
// 差がこの範囲内(1分以内)なら同じ地震とみなす。
const EST_INTENSITY_MATCH_TOLERANCE_MS = 60 * 1000;
// この震度分布は震度5弱以上の地震でのみ気象庁から発表される。
const EST_INTENSITY_MIN_INTENSITY_KEYS = ["5-", "5+", "6-", "6+", "7"];

// 気象庁の1次地域メッシュコード(4桁)から、画像を貼り付ける緯度経度範囲(矩形)を計算する。
// 上2桁が緯度方向・下2桁が経度方向のメッシュ番号で、1次メッシュは緯度2/3度×経度1度。
function meshCodeToBounds(meshCode) {
  const latStart = parseInt(meshCode.substring(0, 2), 10) / 1.5;
  const lonStart = parseInt(meshCode.substring(2, 4), 10) + 100;
  const latEnd = latStart + 2 / 3;
  const lonEnd = lonStart + 1;
  return { latStart, lonStart, latEnd, lonEnd };
}

// 選択中の地震の発生時刻・最大震度から、該当する推計震度分布データを検索する。
// 対象外(震度5弱未満)・該当データなし・取得失敗の場合はnullを返す
// (呼び出し側では「表示しない」扱いにするだけで、エラー扱いにはしない)。
async function fetchEstimatedIntensityMatch(quakeTimeStr, maxIntensityKey) {
  if (!EST_INTENSITY_MIN_INTENSITY_KEYS.includes(maxIntensityKey)) return null;
  if (!quakeTimeStr) return null;

  const targetTimeMs = new Date(quakeTimeStr).getTime();
  if (Number.isNaN(targetTimeMs)) return null;

  const res = await fetch(EST_INTENSITY_LIST_URL);
  if (!res.ok) throw new Error(`推計震度分布一覧の取得に失敗しました (${res.status})`);
  const list = await res.json();
  if (!Array.isArray(list)) return null;

  for (const item of list) {
    const at = item?.hypo?.at;
    if (!at) continue;
    const itemTimeMs = new Date(at).getTime();
    if (Number.isNaN(itemTimeMs)) continue;
    if (Math.abs(itemTimeMs - targetTimeMs) <= EST_INTENSITY_MATCH_TOLERANCE_MS) {
      if (Array.isArray(item.mesh_num) && item.url) return item;
      return null;
    }
  }
  return null;
}

/* ─────────────────────────────────────────────────────
   推計震度分布 画像 → ベクター(GeoJSON)変換
   参考: 【気象庁HP】推計震度分布図のGeoJSONデータを無料で取得したい！！
         https://qiita.com/ZeroQuake/items/e6dd2691fe8fa5e2b3b2
   気象庁の画像(800×800px)は250mメッシュ(1メッシュ=2.5px)を表現しているため、
   拡大するとアンチエイリアスで境界がぼやける。ズームしても輪郭が鮮明なままになるよう、
   画像を1度だけピクセル解析し、320×320の格子(メッシュ)ごとに震度階級を判定して
   ポリゴン(塗り)・境界線(隣接メッシュと震度階級が異なる辺のみ)に変換する。
   ───────────────────────────────────────────────────── */
const EST_INTENSITY_GRID_SIZE = 320;

// 気象庁の公式配色(推計震度分布画像で使われている色)と震度階級の対応。
// 画像は圧縮等で色が微妙にずれることがあるため、RGB各値の差分16未満を許容して判定する
// (元記事の閾値をそのまま採用)。
const EST_INTENSITY_COLOR_TABLE = [
  { key: "4",  r: 250, g: 230, b: 150 },
  { key: "5-", r: 255, g: 230, b: 0   },
  { key: "5+", r: 255, g: 153, b: 0   },
  { key: "6-", r: 255, g: 40,  b: 0   },
  { key: "6+", r: 165, g: 0,   b: 33  },
  { key: "7",  r: 180, g: 0,   b: 104 },
];

// ピクセルの色から、最も近い震度階級を選ぶ(周囲から推測するのではなく、
// あくまでそのピクセル自身の色を根拠にする)。
// 境界(色の変わり目)は元画像でアンチエイリアスがかかっており、6色のどれとも
// 「ぴったり一致」しない中間色になっていることがある。以前は許容誤差(閾値)を
// 決めて外れたものを「データなし」にしていたが、それだと本来は震度が付いている
// はずのメッシュまで欠落して見えてしまう。実際にはその中間色は隣り合う2つの
// 震度色のどちらかに近いはずなので、6色のうち最も色が近いものを選ぶ方が、
// 周囲のメッシュから推測するよりも本来のデータに忠実。
function classifyEstIntensityColor(r, g, b, a) {
  if (a <= 50) return null; // 透明(=本当にデータが無い場所)
  let best = null;
  let bestDist = Infinity;
  for (const c of EST_INTENSITY_COLOR_TABLE) {
    const dist = (r - c.r) ** 2 + (g - c.g) ** 2 + (b - c.b) ** 2;
    if (dist < bestDist) { bestDist = dist; best = c.key; }
  }
  return best;
}

// 画像を読み込む。getImageData()でピクセルを読み取るため、crossOriginを明示的に指定し、
// キャンバスが「汚染」されて読み取り不能にならないようにする。
function loadImageElement(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`画像の読み込みに失敗しました: ${url}`));
    img.src = url;
  });
}

// 気象庁の1次地域メッシュコードから、東隣・北隣など指定方向に1つずれたメッシュコードを計算する。
// (上2桁=緯度方向のメッシュ番号、下2桁=経度方向のメッシュ番号。それぞれ±1が隣接メッシュにあたる)
// 範囲外(0〜99を超える)になる場合はnullを返す。
function offsetMeshCode(meshCode, dLatCode, dLonCode) {
  const latCode = parseInt(meshCode.substring(0, 2), 10) + dLatCode;
  const lonCode = parseInt(meshCode.substring(2, 4), 10) + dLonCode;
  if (latCode < 0 || latCode > 99 || lonCode < 0 || lonCode > 99) return null;
  return String(latCode).padStart(2, "0") + String(lonCode).padStart(2, "0");
}

// 1枚の推計震度分布画像(1次メッシュ分)を、250mメッシュ単位の格子(320×320、
// grid[i][j] = 震度キー or 該当なしはnull)に分解する。
function buildEstIntensityGridFromImage(img) {
  const GRID = EST_INTENSITY_GRID_SIZE;

  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 800;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, 800, 800);
  // クロスオリジンで汚染されたcanvasの場合、ここでSecurityErrorが投げられる
  // (呼び出し側でtry/catchして「表示しない」扱いにフォールバックする)。
  const imgData = ctx.getImageData(0, 0, 800, 800).data;

  // アンチエイリアスの影響を受けない「元の色を完全に反映するピクセル」だけを
  // 参照する(x: 5n+1,5n+3 / y: 5m+1,5m+4 のパターンで交互に2px・3pxずつ進む)。
  const grid = Array.from({ length: GRID }, () => new Array(GRID).fill(null));
  let y = 1;
  for (let i = 0; i < GRID; i++) {
    let x = 1;
    for (let j = 0; j < GRID; j++) {
      const idx = (y * 800 + x) * 4;
      grid[i][j] = classifyEstIntensityColor(
        imgData[idx], imgData[idx + 1], imgData[idx + 2], imgData[idx + 3]
      );
      x += (j % 2 === 0) ? 3 : 2;
    }
    y += (i % 2 === 0) ? 2 : 3;
  }
  return grid;
}

// 250mメッシュの格子(grid)から塗り用ポリゴンを作る。
// 同じ震度階級が隣接するメッシュを1枚の四角形にまとめる(矩形統合)ことで、
// 250mメッシュ1枚ごとにポリゴンを作った場合(広い震度5弱の範囲などで数万枚になり、
// MapLibre側の描画処理が重くフリーズの原因になる)と比べ、ポリゴン数を大幅に減らす。
// 同じ色のポリゴン同士が隣接する境目にGPU描画特有の細い隙間が出る問題もあわせて解消する。
function buildEstIntensityFillFeatures(grid, meshBounds) {
  const { latStart: lat, lonStart: lng, latEnd: lat2, lonEnd: lng2 } = meshBounds;
  const GRID = EST_INTENSITY_GRID_SIZE;

  const rectangles = mergeGridIntoRectangles(grid, GRID);
  return rectangles.map(rect => {
    const North = lat2 + ((lat - lat2) / GRID) * rect.i0;
    const South = lat2 + ((lat - lat2) / GRID) * (rect.i1 + 1);
    const West = lng + ((lng2 - lng) / GRID) * rect.j0;
    const East = lng + ((lng2 - lng) / GRID) * (rect.j1 + 1);
    return {
      type: "Feature",
      properties: { intensity: rect.intensity },
      geometry: {
        type: "Polygon",
        coordinates: [[[West, North], [East, North], [East, South], [West, South], [West, North]]],
      },
    };
  });
}

// 250mメッシュの格子(grid)から、震度階級が変わる境目だけの線分を作る。
// 1次メッシュ画像は複数枚(mesh_num)を並べて1つの地震の範囲を表すため、画像の端(=1次メッシュの
// 継ぎ目)をそのまま「データなし」として扱うと、実際は同じ震度が続いているだけの場所にも
// 誤って境界線を引いてしまう(隣の画像との継ぎ目に黒い線が入って見える不具合の原因)。
// これを避けるため、東隣・南隣のメッシュの格子(あれば)を渡してもらい、画像の端では
// そちらの値を参照して判定する。
//
// 境界線は2種類に分けて返す。
// ・outerCoords: 色が付いた範囲と「データなし(=地図の背景)」との境目。
//   暗い地図の背景に対して黒線だと見えにくいため、呼び出し側で白線にする。
// ・innerCoords: 震度階級同士(4と5-など)の境目。両側とも明るい色なので、
//   今まで通り黒線のままでよい。
function buildEstIntensityLineCoords(grid, meshBounds, neighborGrids = {}) {
  const { latStart: lat, lonStart: lng, latEnd: lat2, lonEnd: lng2 } = meshBounds;
  const GRID = EST_INTENSITY_GRID_SIZE;
  const { eastGrid, southGrid } = neighborGrids;

  const outerCoords = [];
  const innerCoords = [];
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      const intensity = grid[i][j];
      if (!intensity) continue;

      const North = lat2 + ((lat - lat2) / GRID) * i;
      const South = lat2 + ((lat - lat2) / GRID) * (i + 1);
      const West = lng + ((lng2 - lng) / GRID) * j;
      const East = lng + ((lng2 - lng) / GRID) * (j + 1);

      // 右隣: 同じ画像内ならgrid[i][j+1]、画像の右端(j+1がGRID)なら東隣メッシュの
      // 同じ行・左端(列0)を参照する(東隣メッシュが無ければ本当にデータなし=null)。
      const rightIntensity = j + 1 < GRID ? grid[i][j + 1] : (eastGrid ? eastGrid[i][0] : null);
      if (rightIntensity !== intensity) {
        (rightIntensity ? innerCoords : outerCoords).push([[East, North], [East, South]]);
      }
      // 下隣: 同じ画像内ならgrid[i+1][j]、画像の下端(i+1がGRID)なら南隣メッシュの
      // 同じ列・上端(行0)を参照する(南隣メッシュが無ければ本当にデータなし=null)。
      const bottomIntensity = i + 1 < GRID ? grid[i + 1][j] : (southGrid ? southGrid[0][j] : null);
      if (bottomIntensity !== intensity) {
        (bottomIntensity ? innerCoords : outerCoords).push([[West, South], [East, South]]);
      }
    }
  }
  return { outerCoords, innerCoords };
}

// 格子(grid[i][j] = 震度キー or null)を、同じ震度階級が連続する矩形の集まりに変換する。
// 手順: ① 各行ごとに横方向へ連続する同じ値をひとまとめの区間(ラン)にする
//       ② 上の行から縦方向に伸ばせる区間(j0・j1・intensityが完全一致)は1つの矩形として延長し、
//          伸ばせなくなった時点で確定させる
// (震源付近のような大きな塊はこれでほぼ1枚〜数枚の矩形にまとまり、ポリゴン数が劇的に減る)
function mergeGridIntoRectangles(grid, GRID) {
  const finished = [];
  let openRects = []; // 直前の行まで伸びている矩形: { j0, j1, intensity, i0, i1 }

  for (let i = 0; i < GRID; i++) {
    // この行の横方向のラン(連続区間)を作る
    const runs = [];
    let j = 0;
    while (j < GRID) {
      const intensity = grid[i][j];
      if (!intensity) { j++; continue; }
      let j1 = j;
      while (j1 + 1 < GRID && grid[i][j1 + 1] === intensity) j1++;
      runs.push({ j0: j, j1, intensity });
      j = j1 + 1;
    }

    const nextOpenRects = [];
    for (const run of runs) {
      // 直前の行で同じ範囲・同じ震度階級の矩形が伸びてきていれば、そのまま延長する
      const match = openRects.find(r => r.j0 === run.j0 && r.j1 === run.j1 && r.intensity === run.intensity && r.i1 === i - 1);
      if (match) {
        match.i1 = i;
        nextOpenRects.push(match);
      } else {
        nextOpenRects.push({ j0: run.j0, j1: run.j1, intensity: run.intensity, i0: i, i1: i });
      }
    }

    // 今回延長されなかった(=これ以上下に続かない)矩形は確定させる
    for (const r of openRects) {
      if (!nextOpenRects.includes(r)) finished.push(r);
    }
    openRects = nextOpenRects;
  }
  finished.push(...openRects); // 最後の行まで伸びていた分を確定させる

  return finished;
}

// 現在の震度配色スキームから、MapLibreの"fill-color"に使うmatch式を組み立てる。
// (推計震度分布も、他の震度表示と同じアプリ内配色に合わせて塗るため)
function buildEstIntensityFillColorExpr(colorScheme) {
  const expr = ["match", ["get", "intensity"]];
  for (const c of EST_INTENSITY_COLOR_TABLE) {
    expr.push(c.key, (colorScheme.colors[c.key] || colorScheme.colors["0"]).bg);
  }
  expr.push("rgba(0,0,0,0)"); // 該当なし(通常は発生しない)
  return expr;
}

// 直近の地震情報一覧を取得する。取得失敗時はエラーを投げる(呼び出し側でハンドリング)。
// limit: 設定画面で指定された取得件数(1〜1000、デフォルト100)。
//
// 注意1: P2P地震情報APIの /history は1回のリクエストにつき limit を1〜100までしか
// 指定できない(仕様: https://www.p2pquake.net/develop/json_api_v2/ の /history 参照)。
// 100件を超える件数が設定されている場合、limit=100 のリクエストを offset をずらしながら
// 複数回叩いて必要件数を積み上げる(例: 300件なら3回)。
//
// 注意2: 同APIの offset は「1週間以上古い情報は取得できない場合がある」仕様のため、
// 直近1週間の地震が指定件数に満たない場合、それ以上ページを進めても同じ内容が
// 返ってくることがある。これを区別せずに積み上げると、後段の重複排除で結局同じ
// 件数に収束してしまい「件数を増やしても表示が変わらない」ように見えてしまう。
// → 各ページのidをseenIdsで追跡し、新規idが1件も無いページに当たった時点で
//   「これ以上遡れない」とみなして打ち切る。
const P2PQUAKE_API_PAGE_SIZE = 100;

async function fetchRecentQuakes(limit = QUAKE_FETCH_LIMIT_DEFAULT) {
  const target = clampQuakeFetchLimit(limit);
  const results = [];
  const seenIds = new Set();
  let offset = 0;

  while (results.length < target) {
    const pageSize = Math.min(P2PQUAKE_API_PAGE_SIZE, target - results.length);
    const res = await fetch(`${P2PQUAKE_HISTORY_URL_BASE}&limit=${pageSize}&offset=${offset}`);
    if (!res.ok) throw new Error(`地震情報の取得に失敗しました (${res.status})`);
    const page = await res.json();
    if (!Array.isArray(page) || page.length === 0) break; // これ以上遡れる情報が無い

    const newItems = page.filter(item => item?.id != null && !seenIds.has(item.id));
    if (newItems.length === 0) break; // 新規レコードが無い = 同じ内容が返ってきている(offsetの限界に到達)
    for (const item of newItems) seenIds.add(item.id);
    results.push(...newItems);

    offset += page.length;

    // 返ってきた件数がリクエストしたページサイズより少なければ、これ以上古い情報は無い
    if (page.length < pageSize) break;
  }

  // 「震度速報のみ」等、震源情報が欠けているレコードを除外
  const list = results
    .filter(item => item.earthquake && item.earthquake.hypocenter && item.earthquake.hypocenter.name)
    .map(toQuakeCard);
  return dedupeQuakeList(list);
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
  stationsPromise = cachedFetchJSON(`${import.meta.env.BASE_URL}map/stations_with_amp_revised.json`);
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
// areaCode(気象庁の細分区域コード)も一緒に引いておき、区域単位の震度分布の塗り分けに使う。
function resolveStationPoints(points, stations) {
  return points.map(p => {
    const station = matchStation(stations, p);
    if (!station) {
      // eslint-disable-next-line no-console
      console.warn(`[観測点マスタ未一致] ${p.pref} ${p.addr} — stations_with_amp_revised.jsonに追加が必要かもしれません`);
    }
    return {
      pref: p.pref,
      addr: p.addr,
      city: station?.city?.name || null,
      intensityKey: maxScaleToIntensityKey(p.scale),
      latitude: station ? parseFloat(station.lat) : null,
      longitude: station ? parseFloat(station.lon) : null,
      areaCode: station?.area?.code || null,
    };
  });
}

// 観測点(緯度経度+震度キー付き)の配列を、細分区域コードごとに集計する。
// 各区域には、その区域内の観測点で観測された「最大震度」を割り当てる
// (気象庁の震度分布図と同じ考え方: 区域内で一番揺れが大きかった地点の震度で塗る)。
function aggregateByArea(resolvedPoints) {
  const INTENSITY_ORDER = ["0","1","2","3","4","5","5-","5+","6","6-","6+","7"];
  const maxByArea = new Map(); // areaCode -> intensityKey

  for (const p of resolvedPoints) {
    if (!p.areaCode) continue;
    const current = maxByArea.get(p.areaCode);
    if (!current || INTENSITY_ORDER.indexOf(p.intensityKey) > INTENSITY_ORDER.indexOf(current)) {
      maxByArea.set(p.areaCode, p.intensityKey);
    }
  }
  return maxByArea;
}

/* ─────────────────────────────────────────────────────
   気象庁 震度データベース(eqdb) 検索API
   https://www.data.jma.go.jp/eqdb/data/shindo/
   過去の地震を期間・マグニチュード・最大震度で検索する(mode=search)、
   および1件の地震の観測点別震度を取得する(mode=event)ためのAPI。
   このAPIはP2P地震情報と違い、観測点の緯度経度(lat/lon)を直接返してくるため、
   自前の観測点マスタ(stations)との突き合わせをしなくても地図に描画できる。
   ───────────────────────────────────────────────────── */
const EQDB_API_URL = "https://www.data.jma.go.jp/eqdb/data/shindo/api/";

// 検索フォーム「最大震度」欄の選択肢。値はeqdb APIのmaxIntパラメータそのもの。
const EQDB_MAX_INT_OPTIONS = [
  { value: "1", label: "指定なし（震度1以上）" },
  { value: "2", label: "震度2以上" },
  { value: "3", label: "震度3以上" },
  { value: "4", label: "震度4以上" },
  { value: "A", label: "震度5弱以上" },
  { value: "B", label: "震度5強以上" },
  { value: "C", label: "震度6弱以上" },
  { value: "D", label: "震度6強以上" },
  { value: "7", label: "震度7" },
];
// 検索の「震度◯以上」フィルターで比較する際に使うスケール値。
// eqdbIntensityStringToScale()は表示用に、旧震度階級(弱/強の区分が無い震度5・6)を
// 現行の5弱(45)/6弱(55)とは別のスケール値(44/54)として返すが、そのままだと
// 「5弱以上」「6弱以上」で検索した際に旧震度階級の地震がヒットしなくなってしまう。
// 実際の震度は5弱〜5強(または6弱〜6強)のいずれかだったはずなので、
// 「◯弱以上」の条件は満たすとみなして45/55に読み替える。
function eqdbIntensityThresholdScale(raw) {
  const scale = eqdbIntensityStringToScale(raw);
  if (scale === 44) return 45;
  if (scale === 54) return 55;
  return scale;
}

const EQDB_MAX_INT_SCALE = { "1": 10, "2": 20, "3": 30, "4": 40, "A": 45, "B": 50, "C": 55, "D": 60, "7": 70 };

// 「この震源の近傍で発生した地震」ボタンを出す条件。
// P2P地震情報(リアルタイム)側の地震であれば、震度・マグニチュードに関わらず表示する。
function shouldShowNearbyQuakeButton(quake) {
  return !!quake && !quake.isEqdb;
}

const EQDB_SORT_OPTIONS = [
  { value: "S0", label: "新しい順" },
  { value: "S1", label: "古い順" },
  { value: "S2", label: "最大震度の大きい順" },
  { value: "S3", label: "地震の規模の大きい順" },
];

// 最小マグニチュードの選択肢("1.0"〜"9.9")
const EQDB_MIN_MAG_OPTIONS = [
  { value: "0.0", label: "指定なし" },
  ...Array.from({ length: 90 }, (_, i) => {
    const v = ((i + 10) / 10).toFixed(1);
    return { value: v, label: `M${v}以上` };
  }),
];

// "震度５弱"/"５弱"/"震度７"/"5弱(推定)" のような文字列(全角数字・「震度」接頭辞・
// 前後の余分な文字の有無を問わない)を、10刻みのJMAスケール
// (10=震度1 ... 70=震度7、47=旧震度5、57=旧震度6)に変換する。
// 完全一致ではなく部分一致で判定しているのは、eqdb側が返す文字列に
// "(推定)"などの注記が付くことがあり、完全一致だと本来有効な観測点まで
// 判定漏れして震度の塗りつぶしから抜け落ちてしまうことがあったため。
function eqdbIntensityStringToScale(raw) {
  if (!raw) return 0;
  const str = raw
    .replace(/震度/g, "")
    .replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  if (str.includes("7")) return 70;
  // 1996年10月の震度階級改定より前は「弱」「強」の区分が無く、単に「震度6」
  // 「震度5」とだけ記録されている(旧震度階級)。これらは現在の「5弱」「6弱」とは
  // 区別して、そのまま「5」「6」として表示したいので、専用のスケール値(44/54)を
  // 割り当てる(45=5弱, 55=6弱と衝突しないようにするため)。
  if (str.includes("6")) return str.includes("強") ? 60 : str.includes("弱") ? 55 : 54;
  if (str.includes("5")) return str.includes("強") ? 50 : str.includes("弱") ? 45 : 44;
  if (str.includes("4")) return 40;
  if (str.includes("3")) return 30;
  if (str.includes("2")) return 20;
  if (str.includes("1")) return 10;
  return 0;
}

// eqdbのid(dbid)は "YYYYMMDDHHMMSS..." 形式の発生時刻エンコード文字列。
// アプリ内の他の地震カードと表示を揃えるため "YYYY/MM/DD HH:MM:SS" に変換する。
function eqdbIdToTimeDisplay(id) {
  if (!id || id.length < 14) return "";
  return `${id.slice(0,4)}/${id.slice(4,6)}/${id.slice(6,8)} ${id.slice(8,10)}:${id.slice(10,12)}:${id.slice(12,14)}`;
}

// mode=search: 期間・M・最大震度・(任意で)震央地名で地震を検索する。
// 観測点別の詳細は含まない一覧のみを返す。
// epi: 震央地名(例:"神奈川県西部")をそのまま渡すと、サーバー側でその震央地名に
// 完全一致する地震だけに絞り込んで返してくれる(実際のeqdb検索フォームの挙動と同じ)。
// 指定が無い場合は"99"(絞り込みなし)を使う。
async function fetchEqdbSearch({ startDate, endDate, minMag, maxInt, sort, epi }) {
  const epiValue = epi || "99";
  const isFiltered = minMag > 0 || maxInt !== "1" || epiValue !== "99";
  const fd = new FormData();
  fd.append("mode", "search");
  fd.append("dateTimeF[]", startDate); fd.append("dateTimeF[]", "00:00");
  fd.append("dateTimeT[]", endDate);   fd.append("dateTimeT[]", "23:59");
  fd.append("mag[]", minMag.toFixed(1)); fd.append("mag[]", "9.9");
  fd.append("dep[]", "000"); fd.append("dep[]", "999");
  fd.append("epi[]", epiValue); fd.append("pref[]", "99"); fd.append("city[]", "99"); fd.append("station[]", "99");
  fd.append("obsInt", "1");
  fd.append("maxInt", maxInt);
  fd.append("additionalC", isFiltered ? "true" : "false");
  fd.append("Sort", sort);
  fd.append("Comp", "C0");
  fd.append("seisCount", "false");
  fd.append("observed", "false");
  fd.append("strParam", "[object Object]");

  const res = await fetch(EQDB_API_URL, { method: "POST", body: fd });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const list = Array.isArray(data.res) ? data.res : [];
  const strMsgs = Array.isArray(data.str) ? data.str : [];
  const errMsg = strMsgs.find(s => s.includes("ありません") || s.includes("エラー") || s.includes("見直し"));
  return { list, errMsg, summary: strMsgs[1] || "" };
}

// mode=event: 1件の地震について、観測点ごとの震度(int[], lat/lon付き)を含む詳細を取得する。
async function fetchEqdbEvent(id) {
  const fd = new FormData();
  fd.append("mode", "event");
  fd.append("id", id);
  const res = await fetch(EQDB_API_URL, { method: "POST", body: fd });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.res && Array.isArray(data.res.hyp) && data.res.hyp.length > 0) return data.res;
  return null;
}

// 点(lat,lon)が、GeoJSONのリング(座標配列 [[lon,lat], ...])の内側にあるかどうかを
// レイキャスティング法で判定する。
function isPointInRing(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// 点(lat,lon)が、Polygon/MultiPolygonジオメトリの内側(穴を除く)にあるかどうかを判定する。
function isPointInPolygonGeometry(lat, lon, geometry) {
  if (!geometry) return false;
  const testRings = (rings) => {
    if (!rings.length || !isPointInRing(lat, lon, rings[0])) return false;
    for (let k = 1; k < rings.length; k++) {
      if (isPointInRing(lat, lon, rings[k])) return false; // 穴の内側
    }
    return true;
  };
  if (geometry.type === "Polygon") return testRings(geometry.coordinates);
  if (geometry.type === "MultiPolygon") return geometry.coordinates.some(testRings);
  return false;
}

// 細分区域(areasGeoJSON=細分区域.json)のポリゴンを実際に走査し、点(lat,lon)を
// 含む区域のcode(properties.code)を返す。名前によるあいまい照合と違い、
// 区域境界そのものに基づく判定なので、表記揺れや同名地点による誤判定が起きない。
function findAreaCodeByPoint(areasGeoJSON, lat, lon) {
  if (!areasGeoJSON || !Array.isArray(areasGeoJSON.features) || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  for (const feature of areasGeoJSON.features) {
    if (isPointInPolygonGeometry(lat, lon, feature.geometry)) {
      return feature.properties?.code ?? null;
    }
  }
  return null;
}

// 観測点マスタ(stations)から、eqdbの観測点名(name)に対応する地点を探し、
// 区域コード(area.code)を補完する。
// eqdbは観測点の緯度経度(lat/lon)を直接返してくるため、まずareasGeoJSON(細分区域の
// ポリゴン)に対する点-in-多角形判定で区域を確定させる。これは区域境界そのものに
// 基づく判定なので、観測点名の表記揺れや同名地点があっても誤判定しない。
// (以前は観測点マスタとの名前照合だけで区域を推定しており、名前が一致しない/
//  複数の地点に一致してしまうケースで「区域が塗られない」「違う区域の色が塗られる」
//  ことがあった。)
// areasGeoJSONが無い、または該当ポリゴンが見つからない場合のみ、次点として
// 観測点マスタとの名前照合(ベストエフォート)にフォールバックする:
//   1. 地点名が完全一致
//   2. 見つからなければ、地点名が部分一致(どちらかがどちらかを含む)するもの
//   3. それでも見つからなければ、緯度経度が最も近い観測点を採用する
//      (ただしあまりに離れた地点を誤って採用しないよう、約0.05度以内という上限を設ける)
// 観測点マスタ(stations)から、eqdbの観測点名(name)に最も一致する地点を探す。
// findAreaCodeByStationNameと同じマッチング方針(名前の完全一致→部分一致→
// 緯度経度が最も近い地点、の順)を使うが、区域コードだけでなく都道府県名・
// 市区町村名も一緒に取り出したいため、マッチング処理そのものを共通化している。
//
// 【重要】eqdbの観測点名(例: "苫前町旭＊")は市区町村名から始まり、都道府県名は
// 含まれない(気象庁 震度データベースAPIの実際のレスポンスで確認済み)。
// そのため都道府県は文字列解析では判別できず、緯度経度・地点名を観測点マスタと
// 突き合わせて、マスタ側が持つpref.name(都道府県名)を借りてくる必要がある。
function findBestStationMatch(stations, name, lat, lon) {
  if (!stations || stations.length === 0) return null;

  let candidates = name ? stations.filter(s => s.name === name) : [];

  if (candidates.length === 0 && name) {
    candidates = stations.filter(s =>
      s.name.includes(name) || name.includes(s.name) ||
      (s.city && s.city.name && name.includes(s.city.name))
    );
  }

  let fellBackToAll = false;
  if (candidates.length === 0) {
    if (lat == null || lon == null) return null;
    candidates = stations;
    fellBackToAll = true;
  }

  if (candidates.length === 1) return candidates[0];
  if (lat == null || lon == null) return candidates[0] || null;

  let best = null, bestDist = Infinity;
  for (const c of candidates) {
    const cLat = parseFloat(c.lat), cLon = parseFloat(c.lon);
    if (!Number.isFinite(cLat) || !Number.isFinite(cLon)) continue;
    const dLat = cLat - lat, dLon = cLon - lon;
    const dist = dLat * dLat + dLon * dLon;
    if (dist < bestDist) { bestDist = dist; best = c; }
  }
  if (!best) return null;
  if (fellBackToAll) {
    const cLat = parseFloat(best.lat), cLon = parseFloat(best.lon);
    if (Math.abs(cLat - lat) > 0.05 || Math.abs(cLon - lon) > 0.05) return null;
  }
  return best;
}

function findAreaCodeByStationName(stations, name, lat, lon, areasGeoJSON) {
  const byPoint = findAreaCodeByPoint(areasGeoJSON, lat, lon);
  if (byPoint) return byPoint;

  const match = findBestStationMatch(stations, name, lat, lon);
  return match?.area?.code || null;
}

// eqdbの観測点名(name)・緯度経度から、観測点マスタ上の都道府県名・市区町村名を
// 借りてくる。マッチした市区町村名がnameの先頭に含まれていれば、見出しと
// 二重表示にならないようそこを取り除いた残りをaddrとして一緒に返す
// (例: マスタ側city.name="苫前町"、name="苫前町旭＊" → addr="旭＊")。
// マッチしなかった場合はpref/cityともnullとし、addrは元のnameのまま返す。
function resolvePrefCityForEqdbPoint(stations, name, lat, lon) {
  const match = findBestStationMatch(stations, name, lat, lon);
  const pref = match?.pref?.name || null;
  const city = match?.city?.name || null;
  let addr = name;
  if (city && name && name.startsWith(city)) {
    const rest = name.slice(city.length);
    if (rest) addr = rest;
  }
  return { pref, city, addr };
}

// eqdbのmode=eventレスポンスを、アプリ内の「地震カード」共通形式に変換する。
// P2P地震情報由来のカードと違い、resolvedPointsとして緯度経度・震度キーまで
// 解決済みの状態を直接持たせる。selectedQuakePoints側は、resolvedPointsが
// あればそれをそのまま使い、無ければ従来通り観測点マスタで解決する。
function buildEqdbQuakeCard(detail, listItem, stations, areasGeoJSON) {
  const hyp = detail.hyp[0];
  const intPoints = Array.isArray(detail.int) ? detail.int : [];

  // ごく稀に、1つの地震(event)に対して震源が複数記録されていることがある
  // (例: 群発地震をまとめて1件として扱っている場合など)。detail.hypは配列な
  // ので、先頭だけでなく全件を拾って地図上にバツ印を複数表示できるようにする。
  // 代表値(震源地名・M・深さなど)は従来通り先頭(hyp = detail.hyp[0])を使う。
  const hypocenters = detail.hyp
    .map(h => ({ latitude: parseFloat(h.lat), longitude: parseFloat(h.lon) }))
    .filter(h => Number.isFinite(h.latitude) && Number.isFinite(h.longitude));

  const lat = parseFloat(hyp.lat);
  const lon = parseFloat(hyp.lon);
  const mag = parseFloat(hyp.mag);
  const depMatch = (hyp.dep || "").match(/\d+/);
  const depth = depMatch ? parseInt(depMatch[0], 10) : 0;
  const maxScale = eqdbIntensityStringToScale(hyp.maxI || "");

  const resolvedPoints = intPoints.map(pt => {
    const scale = eqdbIntensityStringToScale(pt.int || "");
    if (scale <= 0) return null;
    const pLat = parseFloat(pt.lat), pLon = parseFloat(pt.lon);
    // eqdbは観測点名(pt.name。例: "苫前町旭＊")しか返さず、都道府県名は
    // 含まれない(市区町村名から始まる)。そのため観測点マスタ(stations)と
    // 名前・緯度経度で突き合わせて、マスタ側が持つ都道府県名・市区町村名を
    // 借りてくる(通常のP2P地震情報由来の地点と同じ「都道府県ごとの階層表示」に
    // 乗せられるようにするため)。マスタに見つからなければpref/cityともnullのまま
    // (今まで通り、階層表示では「その他」等の扱いにフォールバックする)。
    const { pref, city, addr } = resolvePrefCityForEqdbPoint(stations, pt.name, pLat, pLon);
    return {
      pref,
      city,
      addr,
      intensityKey: maxScaleToIntensityKey(scale),
      latitude: Number.isFinite(pLat) ? pLat : null,
      longitude: Number.isFinite(pLon) ? pLon : null,
      areaCode: findAreaCodeByStationName(stations, pt.name, pLat, pLon, areasGeoJSON),
    };
  }).filter(Boolean);

  // 1996年10月の震度階級改定(弱/強区分の導入)より前の地震かどうか。
  // 震度7の地震であっても、旧震度階級の期間のものは内部の5・6も区分の無い
  // 「5」「6」のはずなので、凡例側で5弱/5強・6弱/6強を出さないための目印にする。
  const eventDateStr = (listItem?.id || "").slice(0, 8);
  const legacyIntensityScale = eventDateStr.length === 8 && eventDateStr < "19961001";

  return {
    id: `eqdb_${listItem?.id || hyp.name}`,
    time: eqdbIdToTimeDisplay(listItem?.id) || (listItem?.ot || ""),
    place: hyp.name || listItem?.name || "震源地不明",
    maxIntensity: maxScaleToIntensityKey(maxScale),
    legacyIntensityScale,
    isForeign: false,
    isEqdb: true, // 一覧表示で日時を「YYYY/MM/DD」形式にするための目印
    magnitude: Number.isFinite(mag) && mag > 0 ? mag : null,
    depth: Number.isFinite(depth) ? depth : null,
    longPeriod: null,
    latitude: Number.isFinite(lat) ? lat : null,
    longitude: Number.isFinite(lon) ? lon : null,
    hypocenters, // 複数震源対応。地図には1件以上のバツ印として全て表示する。
    points: [],
    resolvedPoints,
    // eqdbには津波情報が含まれないため、津波の心配なし文言をデフォルトにしておく
    domesticTsunami: "None",
    freeFormComment: "気象庁 震度データベースより取得",
  };
}

// 検索結果一覧(mode=searchの生データ)の1件を、QuakeListRowでそのまま表示できる
// 「地震カード」互換の軽量プレビュー形式に変換する(観測点別震度はまだ持たない)。
function eqdbListItemToPreview(eq) {
  const scale = eqdbIntensityStringToScale(eq.maxI || "");
  const depMatch = (eq.dep || "").match(/\d+/);
  const mag = parseFloat(eq.mag);
  return {
    id: eq.id,
    time: eqdbIdToTimeDisplay(eq.id) || (eq.ot || ""),
    place: eq.name || "震源地不明",
    maxIntensity: scale > 0 ? maxScaleToIntensityKey(scale) : "?",
    isForeign: false,
    magnitude: Number.isFinite(mag) && mag > 0 ? mag : null,
    depth: depMatch ? parseInt(depMatch[0], 10) : null,
    isEqdb: true, // 一覧表示で日時を「YYYY/MM/DD」形式にするための目印
  };
}

/* ─────────────────────────────────────────────────────
   AUTO FIT TEXT
   与えられたコンテナ幅に収まるよう、フォントサイズを自動的に縮小して1行で表示する。
   QuakeDetailCardの震源地名(短い地名〜長い地名まで幅が大きく変わる)向け。
   ResizeObserverでコンテナ幅の変化(画面回転・レイアウト変更)にも追従する。
   ───────────────────────────────────────────────────── */
function AutoFitText({ text, maxFontSize, minFontSize = 13, className, style }) {
  const containerRef = useRef(null);
  const textRef = useRef(null);
  const [fontSize, setFontSize] = useState(maxFontSize);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const textEl = textRef.current;
    if (!container || !textEl) return;

    function fit() {
      const containerWidth = container.clientWidth;
      if (containerWidth <= 0) return;

      // 最大サイズから1pxずつ縮めて、テキストの実測幅(scrollWidth)が
      // コンテナ幅に収まるところを探す。文字数が少なければ最大サイズのまま。
      let size = maxFontSize;
      textEl.style.fontSize = `${size}px`;
      while (size > minFontSize && textEl.scrollWidth > containerWidth) {
        size -= 1;
        textEl.style.fontSize = `${size}px`;
      }
      setFontSize(size);
    }

    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(container);
    return () => ro.disconnect();
  }, [text, maxFontSize, minFontSize]);

  return (
    <div ref={containerRef} style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
      <span
        ref={textRef}
        className={className}
        style={{ ...style, fontSize, whiteSpace: "nowrap", display: "inline-block" }}
      >
        {text}
      </span>
    </div>
  );
}

/* ─────────────────────────────────────────────────────
   QUAKE DETAIL CARD
   地震リスト/地図で選択した地震の詳細を表示するカード。
   左に「最大震度」バッジ、右にM/深さ・震源地・発生時刻を積む構成。
   ───────────────────────────────────────────────────── */
function QuakeDetailCard({ quake }) {
  const { tokens } = useContext(ThemeContext);

  const style = useIntensityStyle(quake.maxIntensity || "1");
  const { num, suffix } = splitIntensityLabel(style.label);

  return (
    <div
      style={{
        margin: "2px 14px 4px",
        borderRadius: 16,
        padding: "7px 16px",
        display: "flex",
        alignItems: "center",
        gap: 14,
        background: `linear-gradient(135deg, ${style.bg}2E, ${style.bg}14)`,
        boxShadow: `inset 0 0 0 0.5px rgba(${tokens.ink},0.12)`,
        animation: "appear 0.35s cubic-bezier(.25,1,.5,1)",
      }}
    >
      {/* 最大震度バッジ — 遠地地震は震度が観測されないため「遠地」表示にする */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, flexShrink: 0 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: `rgba(${tokens.ink},0.6)`, whiteSpace: "nowrap", lineHeight: 1.1 }}>
          {quake.isForeign ? "遠地地震" : "最大震度"}
        </span>
        <div
          style={{
            width: 64, height: 64,
            borderRadius: 14,
            background: style.bg, color: style.fg,
            position: "relative",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          {quake.isForeign ? (
            <span style={{ fontSize: 14, fontWeight: 800, lineHeight: 1.2 }}>不明</span>
          ) : suffix ? (
            <>
              {/* 弱/強付き(5弱・5強・6弱・6強) — 数字と弱/強を近づけ、正方形の中央にまとめて配置 */}
              <span className="mono" style={{ fontSize: 32, fontWeight: 800, lineHeight: 1 }}>{num}</span>
              <span style={{
                fontSize: 15, fontWeight: 700, lineHeight: 1,
                marginLeft: 2, alignSelf: "flex-end", marginBottom: 14,
              }}>{suffix}</span>
            </>
          ) : (
            // 数字のみ(1〜4,7) — 弱/強が無い分、正方形の大きさを変えずに数字だけ少し大きく
            <span className="mono" style={{ fontSize: 32, fontWeight: 800, lineHeight: 1 }}>{num}</span>
          )}
        </div>
      </div>

      {/* 震源地 / M・深さ / 発生時刻 — 中央寄せで大きめに表示する */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", minWidth: 0, lineHeight: 1.1 }}>
          <span style={{ fontSize: 12, color: `rgba(${tokens.ink},0.55)`, flexShrink: 0, lineHeight: 1.1 }}>震源地</span>
          <AutoFitText
            text={quake.place}
            maxFontSize={30}
            minFontSize={13}
            style={{ fontWeight: 800, color: tokens.text, lineHeight: 1.1 }}
          />
        </div>

        <div style={{ display: "flex", alignItems: "baseline", gap: 12, lineHeight: 1.1 }}>
          <span style={{ fontSize: 11, color: `rgba(${tokens.ink},0.55)`, lineHeight: 1.1 }}>
            M<span className="mono" style={{ fontSize: 21, fontWeight: 800, color: tokens.text, marginLeft: 3, lineHeight: 1.1 }}>
              {quake.magnitude != null ? quake.magnitude.toFixed(1) : "-"}
            </span>
          </span>
          <span style={{ fontSize: 11, color: `rgba(${tokens.ink},0.55)`, lineHeight: 1.1 }}>
            深さ<span className="mono" style={{ fontSize: 21, fontWeight: 800, color: tokens.text, marginLeft: 3, lineHeight: 1.1 }}>
              {quake.depth != null ? (quake.depth === 0 ? "ごく浅い" : quake.depth) : "-"}
            </span>
            {quake.depth != null && quake.depth !== 0 && (
              <span style={{ fontSize: 11, color: `rgba(${tokens.ink},0.6)`, marginLeft: 2, lineHeight: 1.1 }}>km</span>
            )}
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "baseline", gap: 6, lineHeight: 1.1 }}>
          <span style={{ fontSize: 11, color: `rgba(${tokens.ink},0.55)`, flexShrink: 0, lineHeight: 1.1 }}>発生時刻</span>
          <span className="mono" style={{ fontSize: 12, fontWeight: 600, color: `rgba(${tokens.ink},0.85)`, lineHeight: 1.1 }}>
            {formatQuakeTimeShort(quake.time)}
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
  const { tokens } = useContext(ThemeContext);

  const lines = buildQuakeMessage(quake);

  return (
    <div style={{ margin: "2px 14px 8px" }}>
      <div style={{
        borderRadius: 12,
        padding: "10px 12px",
        display: "flex", flexDirection: "column", gap: 8,
        background: `rgba(${tokens.ink},0.04)`,
        boxShadow: `inset 0 0 0 0.5px rgba(${tokens.ink},0.08)`,
      }}>
        {lines.map((line, i) => (
          <div key={i} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: line.color }}>
              【{line.label}】
            </span>
            <span style={{ fontSize: 12, color: `rgba(${tokens.ink},0.85)`, lineHeight: 1.5 }}>
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
   選択中の地震について、観測点ごとの震度を表示する。表示方法は設定で選べる:
     - "list"    : 震度が大きい順にフラットな一覧で表示(従来の見た目)。
                   件数が多い地震(数百観測点になることもある)を考慮し、
                   既定では上位のみ表示し「すべて表示」で展開できる。
     - "grouped" : 震度階級ごとの一覧(既定)。各行は「バッジ+震度ラベル+
                   都道府県名(まとめて表示)+ >」の要約行で、タップすると
                   その震度の地域一覧(都道府県ごとに開閉できる詳細画面)へ遷移する。
   観測点マスタに見つからず地図に表示されていない件数(unmappedCount)は、
   要約画面の最下部にまとめて表示する(詳細画面では表示しない)。
   ───────────────────────────────────────────────────── */
function StationPointsList({ points, displayMode = "list" }) {
  const { tokens } = useContext(ThemeContext);

  const [expanded, setExpanded] = useState(false); // 一覧表示(list)用の「すべて表示」
  const [openKey, setOpenKey] = useState(null); // 階層表示(grouped)用: 詳細画面を開いている震度キー
  const [openPrefs, setOpenPrefs] = useState(() => new Set()); // 詳細画面内で開いている都道府県
  const [closePressed, setClosePressed] = useState(false); // 詳細画面の✕(ガラス)ボタンの押下状態
  const schemeId = useContext(QuakeColorSchemeContext);
  const scheme = QUAKE_COLOR_SCHEMES[schemeId] || QUAKE_COLOR_SCHEMES.fill;

  // scale(10刻みのJMAコード)が大きい順 = 震度が大きい順
  const sorted = useMemo(() => {
    return [...points].sort((a, b) => INTENSITY_ORDER.indexOf(b.intensityKey) - INTENSITY_ORDER.indexOf(a.intensityKey));
  }, [points]);

  // 震度キーごとにグループ化する(sortedは既に震度降順なので、Mapの挿入順=震度降順のまま保たれる)
  const groups = useMemo(() => {
    const map = new Map();
    for (const p of sorted) {
      if (!map.has(p.intensityKey)) map.set(p.intensityKey, []);
      map.get(p.intensityKey).push(p);
    }
    return [...map.entries()];
  }, [sorted]);

  // 選択中の地震が変わるたび(=points自体が変わるたび)、詳細画面は閉じておく
  useEffect(() => {
    setOpenKey(null);
    setOpenPrefs(new Set());
  }, [points]);

  if (sorted.length === 0) return null;

  // 観測点マスタに見つからず、緯度経度が引けなかった(=地図上には表示されていない)観測点の数。
  // 地図上で「無いことに気づけない」状態を防ぐため、要約画面の最下部に件数を明示しておく。
  const unmappedCount = sorted.filter(p => p.latitude == null || p.longitude == null).length;

  const VISIBLE_COUNT = 10;
  const visible = expanded ? sorted : sorted.slice(0, VISIBLE_COUNT);
  const hasMore = sorted.length > VISIBLE_COUNT;

  function togglePref(pref) {
    setOpenPrefs(prev => {
      const next = new Set(prev);
      if (next.has(pref)) next.delete(pref); else next.add(pref);
      return next;
    });
  }

  // 階層表示(grouped)で、ある震度キーの地域詳細画面を開いている場合はそちらを表示する
  if (displayMode === "grouped" && openKey != null) {
    const groupPoints = groups.find(([k]) => k === openKey)?.[1] || [];
    const style = getIntensityStyleFromScheme(scheme, openKey);

    // 都道府県ごと→さらに市区町村ごとにまとめ直す(出現順を維持)。
    // 同じ市区町村の地点は1つの見出しの下にまとめ、見出しの繰り返しを避ける。
    const byPref = [];
    const prefIndexOf = new Map();
    for (const p of groupPoints) {
      if (!prefIndexOf.has(p.pref)) {
        prefIndexOf.set(p.pref, byPref.length);
        byPref.push({ pref: p.pref, cities: [], cityIndexOf: new Map() });
      }
      const prefEntry = byPref[prefIndexOf.get(p.pref)];
      const cityKey = p.city || `__nocity_${p.addr}`; // 市区町村が無い観測点は地点名単位でそのまま1件ずつ扱う
      if (!prefEntry.cityIndexOf.has(cityKey)) {
        prefEntry.cityIndexOf.set(cityKey, prefEntry.cities.length);
        prefEntry.cities.push({ city: p.city, addrs: [] });
      }
      prefEntry.cities[prefEntry.cityIndexOf.get(cityKey)].addrs.push(p.addr);
    }

    return (
      <div style={{ margin: "2px 14px 8px", textAlign: "left" }}>
        <div style={{ position: "relative", display: "flex", alignItems: "center", padding: "6px 2px 10px" }}>
          <div style={{ flex: 1, textAlign: "left", fontSize: 14, fontWeight: 700, color: tokens.text, paddingRight: 36 }}>
            震度{style.label}の地域
          </div>
          <div style={{ position: "absolute", right: 0 }}>
            <Glass
              radius={999}
              style={{
                width: 28, height: 28,
                transform: closePressed ? "scale(1.16)" : "scale(1)",
                transformOrigin: "center",
                transition: "transform 0.18s cubic-bezier(.22,1,.36,1)",
              }}
            >
              <button
                onClick={() => setOpenKey(null)}
                onPointerDown={() => setClosePressed(true)}
                onPointerUp={() => setClosePressed(false)}
                onPointerCancel={() => setClosePressed(false)}
                onPointerLeave={() => setClosePressed(false)}
                aria-label="閉じる"
                style={{
                  width: "100%", height: "100%",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  background: "transparent", border: "none", cursor: "pointer",
                }}
              >
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none"
                     stroke={`rgba(${tokens.ink},0.75)`} strokeWidth="2.4" strokeLinecap="round">
                  <line x1="6" y1="6" x2="18" y2="18"/>
                  <line x1="18" y1="6" x2="6" y2="18"/>
                </svg>
              </button>
            </Glass>
          </div>
        </div>

        <div style={{
          borderRadius: 12,
          overflow: "hidden",
          background: `rgba(${tokens.ink},0.04)`,
          boxShadow: `inset 0 0 0 0.5px rgba(${tokens.ink},0.08)`,
        }}>
          {byPref.map((entry, pi) => {
            const isOpen = openPrefs.has(entry.pref);
            return (
              <div key={entry.pref}>
                {pi > 0 && <div style={{ height: 0.5, background: `rgba(${tokens.ink},0.08)` }}/>}
                <PressableButton
                  onClick={() => togglePref(entry.pref)}
                  style={{
                    width: "100%", display: "block", background: "transparent", border: "none",
                    cursor: "pointer", textAlign: "left", padding: 0,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 12px" }}>
                    <span style={{ fontSize: 14, fontWeight: 700, color: tokens.text, flex: 1 }}>
                      {entry.pref}
                    </span>
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none"
                         stroke={`rgba(${tokens.ink},0.3)`} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"
                         style={{ transform: isOpen ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.15s ease", flexShrink: 0 }}>
                      <polyline points="6 9 12 15 18 9"/>
                    </svg>
                  </div>
                  {isOpen && (
                    <div style={{ padding: "0 12px 10px", textAlign: "left" }}>
                      {entry.cities.map((c, ci) => (
                        <div key={ci} style={{ marginTop: ci > 0 ? 6 : 0, fontSize: 14, lineHeight: 1.7, textAlign: "left" }}>
                          {c.city && (
                            <span style={{ fontWeight: 700, color: tokens.text }}>{c.city} </span>
                          )}
                          <span style={{ color: `rgba(${tokens.ink},0.88)` }}>{c.addrs.join(" ")}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </PressableButton>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div style={{ margin: "2px 14px 8px" }}>
      <div style={{
        padding: "6px 2px",
        fontSize: 11, fontWeight: 600, color: `rgba(${tokens.ink},0.5)`,
      }}>
        各地の震度
      </div>

      <div style={{
        borderRadius: 12,
        overflow: "hidden",
        background: `rgba(${tokens.ink},0.04)`,
        boxShadow: `inset 0 0 0 0.5px rgba(${tokens.ink},0.08)`,
      }}>
        {displayMode === "grouped" ? (
          groups.map(([key, groupPoints], gi) => {
            const style = getIntensityStyleFromScheme(scheme, key);
            const prefs = [...new Set(groupPoints.map(p => p.pref))];
            return (
              <div key={key}>
                {gi > 0 && <div style={{ height: 0.5, background: `rgba(${tokens.ink},0.08)` }}/>}
                <PressableButton
                  onClick={() => setOpenKey(key)}
                  style={{
                    width: "100%", display: "flex", alignItems: "center", gap: 10,
                    padding: "9px 12px", background: "transparent", border: "none",
                    cursor: "pointer", textAlign: "left",
                  }}
                >
                  <span style={{
                    flexShrink: 0, minWidth: 34, padding: "2px 0", borderRadius: 6,
                    background: style.bg, color: style.fg,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 11, fontWeight: 800,
                  }}>
                    {style.label}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: tokens.text }}>
                      震度{style.label}
                    </div>
                    <div style={{ fontSize: 13, color: `rgba(${tokens.ink},0.65)`, marginTop: 3, lineHeight: 1.6 }}>
                      {prefs.map((pref, pi) => (
                        <span key={pref} style={{ whiteSpace: "nowrap" }}>
                          {pref}{pi < prefs.length - 1 ? "、" : ""}
                        </span>
                      ))}
                    </div>
                  </div>
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none"
                       stroke={`rgba(${tokens.ink},0.3)`} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
                       style={{ flexShrink: 0 }}>
                    <polyline points="9 6 15 12 9 18"/>
                  </svg>
                </PressableButton>
              </div>
            );
          })
        ) : (
          visible.map((p, i) => {
            const style = getIntensityStyleFromScheme(scheme, p.intensityKey);
            return (
              <div key={`${p.pref}-${p.addr}-${i}`}>
                {i > 0 && <div style={{ height: 0.5, background: `rgba(${tokens.ink},0.08)`, marginLeft: 12 }}/>}
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 12px" }}>
                  <span style={{
                    flexShrink: 0, minWidth: 34, padding: "2px 0", borderRadius: 6,
                    background: style.bg, color: style.fg,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 11, fontWeight: 800,
                  }}>
                    {style.label}
                  </span>
                  <span style={{ fontSize: 11, color: `rgba(${tokens.ink},0.4)`, flexShrink: 0 }}>
                    {p.pref}
                  </span>
                  <span style={{
                    flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: tokens.text,
                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                  }}>
                    {p.addr}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>

      {displayMode === "list" && hasMore && (
        <PressableButton
          onClick={() => setExpanded(v => !v)}
          style={{
            width: "100%", textAlign: "center", padding: "8px 0",
            fontSize: 12, fontWeight: 600, color: `rgba(${tokens.ink},0.55)`,
          }}
        >
          {expanded ? "閉じる" : `すべて表示 (${sorted.length}件)`}
        </PressableButton>
      )}

      {unmappedCount > 0 && (
        <div style={{ padding: "8px 2px 2px", fontSize: 11, fontWeight: 500, color: `rgba(${tokens.ink},0.35)` }}>
          うち{unmappedCount}件は観測点マスタに無く、地図には非表示です
        </div>
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
function Toggle({ on, onChange, disabled = false }) {
  const { tokens } = useContext(ThemeContext);

  return (
    <div
      onClick={disabled ? undefined : onChange}
      role="switch" aria-checked={on} aria-disabled={disabled || undefined}
      style={{
        width: 44, height: 26, borderRadius: 13, flexShrink: 0,
        background: on ? "#32D74B" : `rgba(${tokens.ink},0.2)`,
        position: "relative", cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
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
   SIDE NAV RAIL
   広い画面(isWide)用の、縦タブバーの中身(アイコン列+スライドする
   ハイライト)。ドラッグ操作は無く、単純なクリックだけでタブを切り替える
   (PC・タブレットでは横スワイプよりクリック/タップの方が自然なため)。
   このコンポーネント自身はGlassや位置決めを持たない。フローティング
   パネルと1枚の連続したガラスに見せるため、App側で用意した共有の
   Glassの中に、コンテンツ(BottomDock)と並べて描画される。
   ───────────────────────────────────────────────────── */
const WIDE_RAIL_WIDTH = 44;      // 横幅[px]
const WIDE_RAIL_TOP = 16;        // 画面上端からの余白[px]。フローティングパネルと揃える
const WIDE_RAIL_RADIUS = 28;     // 角丸[px](共有Glass全体に適用する)

function SideNavRail({ active, onNav, uiScale = 1 }) {
  const { tokens } = useContext(ThemeContext);
  const { opaque: glassOpaque } = useContext(GlassOpaqueContext);

  const RAIL_PAD_Y = 14; // 内側コンテンツ(ボタン列)の上下パディング[px]。JSXと一致させる
  const N = NAV.length;
  const tabH = 100 / N;  // 1タブぶんの高さ[%](内側領域基準)
  const activeIndex = Math.max(0, NAV.findIndex(n => n.id === active));

  // 縦画面のナビ行(%ベースで指に連続追従するハイライト)と全く同じ考え方を、
  // 横→縦の軸を入れ替えて再現する。バーの全長自体がclamp(vh)で画面サイズに
  // 応じて伸縮するため、pxではなく%で管理する(そうしないと画面サイズが
  // 変わった時にハイライトの位置・サイズがずれてしまう)。
  const contentRef    = useRef(null);
  const pointerIdRef  = useRef(null);
  const movedRef      = useRef(false);
  const startYRef     = useRef(0);
  const [highlightTop, setHighlightTop] = useState(activeIndex * tabH); // %
  const [dragging,     setDragging]     = useState(false);
  const [pressed,      setPressed]      = useState(false); // 指が触れている間ずっとtrue
  const [previewIdx,   setPreviewIdx]   = useState(null);

  // active が外部から変わった時(タップ以外の切替)にハイライトを追従させる
  useEffect(() => {
    if (!dragging) setHighlightTop(activeIndex * tabH);
  }, [activeIndex, dragging, tabH]);

  // clientY → 内側領域(上下RAIL_PAD_Y除外)を基準にした正規化top [%]
  function clientYToTop(clientY) {
    const el = contentRef.current;
    if (!el) return activeIndex * tabH;
    const { top, height } = el.getBoundingClientRect();
    const innerTop    = top + RAIL_PAD_Y;
    const innerHeight = height - RAIL_PAD_Y * 2;
    const ratio = Math.max(0, Math.min(1, (clientY - innerTop) / innerHeight));
    return Math.max(0, Math.min(100 - tabH, ratio * 100 - tabH / 2));
  }

  // clientY に最も近いタブのindexを返す
  function clientYToIndex(clientY) {
    const el = contentRef.current;
    if (!el) return activeIndex;
    const { top, height } = el.getBoundingClientRect();
    const innerTop    = top + RAIL_PAD_Y;
    const innerHeight = height - RAIL_PAD_Y * 2;
    const ratio = Math.max(0, Math.min(1, (clientY - innerTop) / innerHeight));
    return Math.max(0, Math.min(N - 1, Math.round(ratio * 100 / tabH - 0.5)));
  }

  function handlePointerDown(e) {
    pointerIdRef.current = e.pointerId;
    movedRef.current = false;
    startYRef.current = e.clientY;
    e.currentTarget.setPointerCapture(e.pointerId);
    const idx = clientYToIndex(e.clientY);
    setPreviewIdx(idx);
    setPressed(true);
    // タップの可能性がある間はtransitionを効かせたまま、目的のタブへ
    // スライドするアニメーションを見せる(縦画面版と同じ考え方)。
    setHighlightTop(idx * tabH);
  }

  function handlePointerMove(e) {
    if (pointerIdRef.current !== e.pointerId) return;
    if (Math.abs(e.clientY - startYRef.current) > 3 && !movedRef.current) {
      movedRef.current = true;
      setDragging(true);
    }
    const idx = clientYToIndex(e.clientY);
    setPreviewIdx(idx);
    if (movedRef.current) {
      setHighlightTop(clientYToTop(e.clientY)); // 指の連続位置に追従
    } else {
      setHighlightTop(idx * tabH);
    }
  }

  function handlePointerUp(e) {
    if (pointerIdRef.current !== e.pointerId) return;
    pointerIdRef.current = null;
    const idx = clientYToIndex(e.clientY);
    setDragging(false);
    setPressed(false);
    setPreviewIdx(null);
    setHighlightTop(idx * tabH);
    onNav(NAV[idx].id);
  }

  function handleClick(id) {
    if (movedRef.current) return; // ドラッグ完了後の二重発火を防ぐ
    const idx = NAV.findIndex(n => n.id === id);
    setHighlightTop(idx * tabH);
    onNav(id);
  }

  const displayIdx = dragging && previewIdx != null ? previewIdx : activeIndex;

  return (
      <div style={{
        width: `${100 / uiScale}%`,
        height: `${100 / uiScale}%`,
        transform: `scale(${uiScale})`,
        transformOrigin: "top left",
      }}>
        <div
          ref={contentRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          style={{
            position: "relative",
              height: "100%",
              display: "flex", flexDirection: "column",
              alignItems: "stretch",
              padding: `${RAIL_PAD_Y}px 5px`,
              touchAction: "none",
              userSelect: "none",
              WebkitUserSelect: "none",
              WebkitTouchCallout: "none",
            }}
          >
            {/* ガラスのハイライトピル — 縦画面のナビ行と全く同じ見た目・挙動
                (完全な丸ピル、指に連続追従、押し込むと少し膨らむ)。
                バーの全長がclamp(vh)で伸縮するため、位置・高さとも%で
                管理し、画面サイズが変わっても常に正しい位置に来るようにする。 */}
            <div
              aria-hidden
              style={{
                position: "absolute",
                left: 3, right: 3,
                top: `calc(${RAIL_PAD_Y}px + (100% - ${RAIL_PAD_Y * 2}px) * ${highlightTop / 100})`,
                height: `calc((100% - ${RAIL_PAD_Y * 2}px) * ${tabH / 100})`,
                borderRadius: 999,
                background: (pressed || dragging) && !glassOpaque ? tokens.glassTint : tokens.navPillBg,
                boxShadow: (pressed || dragging) && !glassOpaque
                  ? `inset 0 0 0 0.5px ${tokens.rimLight}, inset 0 1px 0 ${tokens.rimHighlight}`
                  : tokens.navPillShadow,
                // タッチ/ドラッグ中だけ本物のガラス(backdrop-filter blur)にする。
                // 通常時は軽量なフラットピルのままにして、常時ブラーによる
                // 描画負荷を避ける。
                backdropFilter: (pressed || dragging) && !glassOpaque ? "blur(16px) saturate(160%)" : "none",
                WebkitBackdropFilter: (pressed || dragging) && !glassOpaque ? "blur(16px) saturate(160%)" : "none",
                transform: pressed ? "scale(1.08)" : "scale(1)",
                transformOrigin: "center",
                transition: dragging
                  ? "transform 0.18s cubic-bezier(.22,1,.36,1)"
                  : "top 0.38s cubic-bezier(.22,1,.36,1), transform 0.18s cubic-bezier(.22,1,.36,1)",
                pointerEvents: "none",
                zIndex: 0,
              }}
            />

            {NAV.map(({ id, label }, idx) => {
              const isActive = idx === displayIdx;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => handleClick(id)}
                  style={{
                    position: "relative", zIndex: 1,
                    flex: 1, minHeight: 0, width: "100%",
                    display: "flex", flexDirection: "column",
                    alignItems: "center", justifyContent: "center",
                    gap: 1,
                    borderRadius: 999, border: "none", cursor: "pointer",
                    background: "transparent",
                    color: isActive ? tokens.text : `rgba(${tokens.ink},0.6)`,
                    transition: "color 0.15s",
                    touchAction: "none",
                    userSelect: "none",
                    WebkitUserSelect: "none",
                    WebkitTouchCallout: "none",
                  }}
                >
                  <span style={{ transform: "scale(0.7)" }}>{NAV_ICONS[id]}</span>
                  <span style={{ fontSize: 9, fontWeight: isActive ? 700 : 500, letterSpacing: -0.1 }}>
                    {label}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
  );
}

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
    //
    // ただし、指を離した位置がすでに特定のスナップのすぐ近くにある場合は、
    // そこで止めようとした意図とみなし、フリック判定より最近傍を優先する。
    // 許容範囲は「最も近いスナップと、その両隣との間隔」から決める
    // (全スナップ中の最小間隔を使うと、無関係な離れた場所の間隔が極端に
    //  狭い場合に引きずられて許容範囲が潰れてしまうため)。
    const lowerNeighbor = heights[nearest - 1];
    const upperNeighbor = heights[nearest + 1];
    const distToLower = lowerNeighbor !== undefined ? heights[nearest] - lowerNeighbor : Infinity;
    const distToUpper = upperNeighbor !== undefined ? upperNeighbor - heights[nearest] : Infinity;
    const localGap = Math.min(distToLower, distToUpper);
    const SNAP_STICK_PX = Math.max(8, Math.min(30, localGap / 2));

    const FLICK_THRESHOLD = 0.45; // px/ms。これを超えたら明確なフリックとみなす
    let target = nearest;
    if (Math.abs(velocity) > FLICK_THRESHOLD && nearestDist > SNAP_STICK_PX) {
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

   - 高さ: useSnapDrag により、低(閉)・中・中高・中中高・高(従来の全開)・全画面の
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
  onChangeQuakeColorScheme,
  estIntensityEnabled, onChangeEstIntensityEnabled,
  areaFillEnabled, onChangeAreaFillEnabled,
  quakeFetchLimit, onChangeQuakeFetchLimit,
  stationListDisplayMode, onChangeStationListDisplayMode,
  stations, searchQuake, onFoundSearchQuake,
  uiScale = 1,
}) {
  const { tokens } = useContext(ThemeContext);
  const { opaque: glassOpaque } = useContext(GlassOpaqueContext);

  const HANDLE_HEIGHT = 18; // ハンドル行の固定高さ(スクロールに巻き込まれず常に上部に固定)。
                            // 地震タブでは直下のQuakeListToolbarが縦ドラッグをこのハンドルへ
                            // 引き渡す(onHandoffToPanelDrag)ため、ハンドル自体を広げる必要はない。
  const isWide = useIsWideLayout(); // 横画面スマホ・タブレット・PCなどの広い画面かどうか
  const scrollRef = useRef(null);

  // 一覧⇄検索の切り替えや地震の選択/選択解除など、表示中身が切り替わって
  // scrollRef自体がkeyごと作り直される直前に呼ぶ。「勢いよくスクロールした
  // 直後に切り替える」と、iOSの慣性スクロール(フリック後の減速アニメーション)が
  // 古い要素に対してまだ動いている場合があり、key変更によるDOM要素の作り直しが
  // 1フレーム遅れるだけでも新しい要素側に慣性が乗り移って見えることがあるため、
  // 切り替えの直前にoverflowをhiddenにして慣性スクロールを即座に断ち切っておく
  // (新しい要素はstyle指定で改めてoverflow: autoになるので支障はない)。
  function killScrollMomentum() {
    // overflowをhidden→autoと切り替えて慣性スクロールを断ち切る方式は、
    // iOS Safariでボタン要素(地震一覧の各行など)がスクロールをまったく
    // 受け付けなくなる不具合の原因になっていたため廃止した。
    // スクロール位置の復元はuseLayoutEffect側でscrollTopを直接設定するだけで
    // 十分実用上問題なく、慣性も自然に収まる。
  }

  const colorSchemeId = useContext(QuakeColorSchemeContext);
  const colorScheme = QUAKE_COLOR_SCHEMES[colorSchemeId] || QUAKE_COLOR_SCHEMES.fill;

  // 設定タブ内の階層メニューの現在地。[] = トップメニュー、["quake"] = 地震カテゴリの
  // メニュー、["quake","colorScheme"] = 震度配色の中身、のようにパスで表現する。
  // 設定タブ以外に移動したら、次に開いた時は必ずトップメニューから始まるようにリセットする。
  const [settingsPath, setSettingsPath] = useState([]);
  useEffect(() => {
    if (active !== "settings") setSettingsPath([]);
  }, [active]);

  // 横画面(isWide)では、戻るボタンをガラスの外に浮かせて表示するため、
  // パネル本体(GlassOrPlainの中身)の画面上の位置を測っておく。
  const wideContentRef = useRef(null);
  const [wideAnchorRect, setWideAnchorRect] = useState(null);
  useLayoutEffect(() => {
    if (!isWide) { setWideAnchorRect(null); return; }
    const update = () => {
      if (wideContentRef.current) setWideAnchorRect(wideContentRef.current.getBoundingClientRect());
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [isWide, active, selectedQuakeId, settingsPath]);

  // 地震タブの表示モード。"recent" = 直近の地震一覧(P2P地震情報フィード)、
  // "search" = 気象庁 震度データベースを検索するUI。
  // タブを離れたら次に開いた時は必ず「一覧」から始まるようにリセットする。
  // ただし、検索結果から地震を選択して詳細カードを表示している間に他のタブへ
  // 移動した場合はリセットしない。ここでリセットしてしまうと、タブを行き来して
  // 地震タブに戻ってきた時点では detail カードがそのまま表示され続けるため
  // 気づきにくいが、その後「戻る」を押した瞬間にquakeViewModeが既に"recent"に
  // 書き換わっており、本来戻るべき検索結果ではなく直近一覧に戻ってしまう
  // (=検索経由で選択→他タブ→戻る→「戻る」ボタンでリストタブになる不具合)。
  const [quakeViewMode, setQuakeViewMode] = useState("recent"); // "recent" | "search"
  useEffect(() => {
    if (active !== "quake" && selectedQuakeId == null) setQuakeViewMode("recent");
  }, [active, selectedQuakeId]);

  // 「この震源の近傍で発生した地震」パネルを開いている場合の、震源地名。
  // nullなら通常の地震詳細カードを表示し、震源地名(文字列)が入っている間は
  // 代わりにNearbyQuakesPanelを表示する。選択解除(戻るボタンで一覧に戻る等)
  // されたら一緒に閉じる。
  const [nearbyQuakeFor, setNearbyQuakeFor] = useState(null);
  // 「近傍で発生した地震」ボタンを押した、元の地震のID。
  // 近傍一覧から別の地震を選んで詳細を見た後、一覧に「戻る」時にはこのIDの地震を
  // 選択し直す(=一覧を開いていた時点の地震に選択・観測点・凡例を揃える)ために使う。
  // 一覧自体から「戻る」を押して元の地震の詳細に戻ったらクリアする。
  const [nearbyOriginId, setNearbyOriginId] = useState(null);
  useEffect(() => {
    if (selectedQuakeId == null) { setNearbyQuakeFor(null); setNearbyOriginId(null); }
  }, [selectedQuakeId]);

  // 気象庁 震度データベース検索フォーム・結果一覧の状態。
  // QuakeSearchPanel自身の内部state(useState)ではなくここに持たせているのは、
  // 地震を選択すると一覧側(QuakeSearchPanel)がいったんアンマウントされるため
  // (選択中は代わりにQuakeDetailCard等を表示する排他表示になっている)。
  // 「戻る」ボタンで選択解除して一覧に戻った時に、検索結果や入力条件が
  // 消えてしまわないよう、アンマウントされないBottomDock側で保持する。
  const [eqdbSearch, setEqdbSearch] = useState(() => {
    const { start, end } = defaultEqdbDateRange();
    return {
      startDate: start, endDate: end,
      minMag: "0.0", maxInt: "1", sort: "S0",
      status: "", isSearching: false, hasSearched: false,
      results: [], loadingId: null,
    };
  });

  // 一覧(未選択状態)のスクロール位置を覚えておくためのref。
  // 地震を選択するとカード表示に排他的に切り替わり(keyが変わり)一覧側のDOM要素
  // ごと作り直されるため、選択した瞬間のスクロール位置を保存しておかないと、
  // 「戻る」で一覧に戻った時に必ず先頭に戻ってしまう。選択操作の直前
  // (handleSelectQuakeForScroll)で保存し、選択解除(戻る)で復元する。
  const listScrollTopRef = useRef(0);
  function handleSelectQuakeForScroll(id) {
    if (scrollRef.current) listScrollTopRef.current = scrollRef.current.scrollTop;
    killScrollMomentum();
    onSelectQuake(id);
    setSnapIndex(1);
  }

  // 近傍地震一覧のスクロール位置。一覧→他の地震の詳細→一覧、と行き来する際、
  // NearbyQuakesPanel自体はDOMごと作り直される(=スクロール位置は自然には
  // 残らない)ため、一覧から離れる直前に保存しておき、一覧に戻ってきた時だけ
  // 復元する。pendingNearbyScrollRestoreRefは「次にスクロール位置を調整する
  // タイミングでは、0にリセットするのではなくこちらを復元してほしい」という
  // 1回限りの合図。
  const nearbyListScrollTopRef = useRef(0);
  const pendingNearbyScrollRestoreRef = useRef(false);

  // タブ切り替え、一覧⇄検索モードの切り替え、地震の選択/選択解除で表示中身が
  // 変わるたびに、ブラウザのスクロールアンカリングによりscrollTopが勝手に動き、
  // カードやヘッダーが隠れて見えることがあるため、そのたびに明示的にスクロール
  // 位置を調整する。
  // ただし「戻る」ボタンで選択解除して一覧に戻っただけ(タブ・モードは変わって
  // いない)場合は、先頭に戻すのではなく選択前のスクロール位置を復元する
  // (=一覧を下の方までスクロールして地震を選んだ後、戻ったら同じ場所に
  //  留まってほしい、という自然な挙動にするため)。
  const prevScrollDepsRef = useRef({ active, quakeViewMode, selectedQuakeId });
  useLayoutEffect(() => {
    if (!scrollRef.current) return;
    const prev = prevScrollDepsRef.current;
    const onlyDeselected =
      prev.active === active && prev.quakeViewMode === quakeViewMode &&
      prev.selectedQuakeId != null && selectedQuakeId == null;

    // scrollTopを直接設定するだけで、一覧⇄詳細切り替え時の位置調整は十分。
    // 以前はここでoverflowをhidden→autoと切り替えていたが、iOS Safariで
    // ボタン要素(地震一覧の各行)がスクロールを受け付けなくなる不具合の
    // 原因になっていたため廃止した(killScrollMomentum側も参照)。
    const el = scrollRef.current;
    if (pendingNearbyScrollRestoreRef.current) {
      el.scrollTop = nearbyListScrollTopRef.current;
      pendingNearbyScrollRestoreRef.current = false;
    } else {
      el.scrollTop = onlyDeselected ? listScrollTopRef.current : 0;
    }
    prevScrollDepsRef.current = { active, quakeViewMode, selectedQuakeId };
  }, [active, selectedQuakeId, quakeViewMode, nearbyQuakeFor]);


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

  // ハンドル行の高さ(HANDLE_HEIGHT)を変更した場合の差分。
  // 各スナップの固定高さは元々HANDLE_HEIGHT=18px前提で調整済みなので、
  // ここで差分を加算しておくことで、将来ハンドルの高さを変えても
  // 中身の表示領域(ここが本質)は変えずに済むようにしている。
  // 現在はHANDLE_HEIGHT=18のためこの差分は0。
  const HANDLE_HEIGHT_DELTA = HANDLE_HEIGHT - 18;

  // 0:低(閉) 1:中 2:中中 3:中高 4:高 5:全画面
  // 「高」「全画面」は、以前は表示中のタブの中身の実測高さ(naturalHeight)を
  // 元に計算していたが、これだと地震タブ(地震の件数や「各地の震度」展開で
  // 中身の長さが大きく変動する)だけ、気象/津波/警報/設定タブ(常に同じ
  // 「地図レイヤー」一覧を表示)と「高」「全画面」の高さがズレてしまっていた。
  // → タブごとの中身の長さには一切依存させず、常に同じ固定値/画面基準の
  //    値にすることで、どのタブでも「高」「全画面」が同じ高さになるようにする。
  //    中身がその高さより長い場合は、パネル内部のスクロール(scrollRef)に任せる。
  const highHeight = 390 + HANDLE_HEIGHT_DELTA; // 「高」の固定高さ(px)。地図レイヤー一覧(6項目)相当の目安(旧: 350)
  const fullscreenContentHeight = viewportH - TOP_GAP - BOTTOM_OFFSET - NAV_ROW_HEIGHT;

  // 「中」「中高」はタブによらず常に同じ高さになるよう固定pxで持つ
  // (地図レイヤー一覧で調整済みだった見た目の高さをそのまま定数化している)。
  const MID_FIXED     = 115 + HANDLE_HEIGHT_DELTA; // 「中」の固定高さ(px)
  // 「中中」の固定高さ(px)。「中」と「中高」の間に設ける中間スナップ。
  const MIDMID_FIXED = 200 + HANDLE_HEIGHT_DELTA;
  // 「中高」の固定高さ(px)。設定タブのトップメニュー(ヘッダー+5項目のカード)や、
  // 地震タブの検索フォーム(検索ボタンまで)がスクロールなしで丸ごと収まる高さを
  // 基準に調整している(旧: 222px)。検索フォーム側を見た目のバランスを保ちつつ
  // コンパクトに詰めることで、この高さのまま検索ボタンまで収まるようにしている。
  const MIDHIGH_FIXED = 290 + HANDLE_HEIGHT_DELTA;
  const GAP           = 20;  // 各スナップ間に必ず確保する最低差(px)
  const midHeight     = Math.min(MID_FIXED, highHeight - GAP * 2);
  const midHighHeight = Math.max(
    Math.min(MIDHIGH_FIXED, highHeight - GAP),
    midHeight + GAP
  );
  const midMidHeight = Math.max(
    Math.min(MIDMID_FIXED, midHighHeight - GAP),
    midHeight + GAP
  );

  // 地震を選択した直後にスナップする「低(カードのみ)」の高さ。
  // 完全に閉じる(0)ではなく、QuakeDetailCard 1枚(+ハンドル)がちょうど収まる
  // 高さにして、地図の震源付近が広く見えつつカードも確認できるようにする。
  const CARD_ONLY_HEIGHT = 96 + HANDLE_HEIGHT_DELTA; // QuakeDetailCard 1枚の実測目安(margin込み)
  const quakeLowHeight = Math.min(CARD_ONLY_HEIGHT, midHeight - GAP);

  const SNAP_HEIGHTS = [
    0,
    midHeight,
    midMidHeight,
    midHighHeight,
    highHeight,
    Math.max(fullscreenContentHeight, highHeight),
  ];
  const [snapIndex, setSnapIndex] = useState(0);

  // 親から渡される layerOpen(真偽値)を 低(0)⇄高(4) として反映する。
  // ドラッグで内部的に決めたスナップを、ここで二重に上書きしないようrefで判定する。
  const lastLayerOpen = useRef(layerOpen);
  useEffect(() => {
    if (layerOpen !== lastLayerOpen.current) {
      lastLayerOpen.current = layerOpen;
      setSnapIndex(layerOpen ? (active === "quake" ? 3 : 4) : 0);
    }
  }, [layerOpen, active]);

  // 地震の選択が「あり→なし」に変わった(=戻るボタンで選択解除された)ら、
  // 詳細カード表示の「中」から一覧表示の「中高」へ戻す。
  const lastSelectedQuakeId = useRef(selectedQuakeId);
  useEffect(() => {
    if (lastSelectedQuakeId.current != null && selectedQuakeId == null) {
      setSnapIndex(3);
    }
    lastSelectedQuakeId.current = selectedQuakeId;
  }, [selectedQuakeId]);

  // 設定タブを開いた瞬間は、常にパネルの高さを「中高」にする
  // (トップメニューがスクロールなしで丸ごと見える高さのため)。
  // 開く前の高さ(ドラッグで調整していた場合も含む)を覚えておき、
  // 設定タブから元のタブへ戻った時はその高さにそのまま復元する。
  const preSettingsSnapIndexRef = useRef(snapIndex);
  const lastActiveForSettings = useRef(active);
  useEffect(() => {
    if (lastActiveForSettings.current !== "settings" && active === "settings") {
      preSettingsSnapIndexRef.current = snapIndex; // 開く直前の高さを覚えておく
      setSnapIndex(3);
    } else if (lastActiveForSettings.current === "settings" && active !== "settings") {
      setSnapIndex(preSettingsSnapIndexRef.current); // 覚えておいた元の高さに戻す
    }
    lastActiveForSettings.current = active;
  }, [active]);

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
  // openProgressは「高」の固定高さ(highHeight)を基準にする。
  // 以前はnaturalHeight(タブごとに変わる中身の実測高さ)を分母にしていたため、
  // 同じスナップ高さでもタブによってopenProgressが変わり、地震タブだけ
  // 上の角丸が他タブと微妙に異なって見える原因になっていた。
  const openProgress = Math.min(1, Math.max(0, currentHeight / highHeight));
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
  // パネルが閉じている状態でアクティブなタブを再タップした場合は、
  // 待たずに1回のタップで即座に開く。
  // パネルが開いている状態で同じタブを既定時間内に2回タップした場合は
  // ダブルタップとみなし、閉じる(誤って閉じないよう、閉じる側だけ2回タップを要求する)。
  const lastTapTime = useRef(0);
  const lastTapId   = useRef(null);
  const DOUBLE_TAP_MS = 320;

  function handleNavClick(id) {
    if (navMoved.current) return;   // ドラッグ完了後の二重発火を防ぐ

    if (id === active && !layerOpen) {
      lastTapTime.current = 0;      // 直後の別タップを誤って連続タップ扱いしないようリセット
      lastTapId.current   = null;
      onLayerOpenChange(true);
      return;                       // 1回のタップで開く
    }

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
      {/* 広い画面では、SideNavRail(タブ部分)はApp側で共有のGlassの中に
          BottomDockと並べて描画するため、ここでは出さない。 */}

      {/* 戻るボタン — 地震を選択している間だけ、パネルのすぐ上に浮かぶ。
          Glass(パネル本体)の兄弟として置くことで、currentHeightの変化
          (ドラッグ含む)にそのまま追従できるようにしている。 */}
      {active === "quake" && selectedQuakeId != null && (
        isWide && wideAnchorRect ? createPortal(
          <div style={{
            position: "fixed",
            left: wideAnchorRect.right + 12,
            top: wideAnchorRect.top + 16,
            zIndex: 50,
          }}>
            <BackToListButton
              onClick={() => {
                killScrollMomentum();
                if (nearbyQuakeFor) {
                  setNearbyQuakeFor(null);
                  setNearbyOriginId(null);
                  setSnapIndex(1);
                  return;
                }
                if (nearbyOriginId) {
                  const originQuake = quakes.find(q => q.id === nearbyOriginId)
                    || (searchQuake && searchQuake.id === nearbyOriginId ? searchQuake : null);
                  if (originQuake) {
                    pendingNearbyScrollRestoreRef.current = true;
                    onSelectQuake(nearbyOriginId);
                    setNearbyQuakeFor(originQuake.place);
                  } else {
                    setNearbyOriginId(null);
                  }
                  setSnapIndex(3);
                  return;
                }
                onSelectQuake(null);
              }}
              label={nearbyQuakeFor ? "地震の詳細に戻る" : nearbyOriginId ? "近傍地震一覧に戻る" : "地震一覧に戻る"}
            />
          </div>,
          document.body
        ) : (
        <div style={{
          position: "absolute",
          right: 16,
          bottom: backButtonBottom,
          transition: isDragging ? "none" : "bottom 0.4s cubic-bezier(.22,1,.36,1)",
          zIndex: 10,
        }}>
          <BackToListButton
            onClick={() => {
              killScrollMomentum();
              if (nearbyQuakeFor) {
                // 一覧を閉じて、元の地震(nearbyOriginId)の詳細に戻る。
                setNearbyQuakeFor(null);
                setNearbyOriginId(null);
                setSnapIndex(1);
                return;
              }
              if (nearbyOriginId) {
                // 近傍一覧から選んだ地震の詳細から、一覧に戻る。
                // 選択自体も元の地震に戻すことで、観測点・凡例・地図上のバツ印を
                // 一覧を開いていた時点の地震に揃える(戻さないと、一覧の裏で
                // 選んだ地震のデータがそのまま残ってしまう)。
                const originQuake = quakes.find(q => q.id === nearbyOriginId)
                  || (searchQuake && searchQuake.id === nearbyOriginId ? searchQuake : null);
                if (originQuake) {
                  pendingNearbyScrollRestoreRef.current = true;
                  onSelectQuake(nearbyOriginId);
                  setNearbyQuakeFor(originQuake.place);
                } else {
                  setNearbyOriginId(null);
                }
                setSnapIndex(3);
                return;
              }
              onSelectQuake(null);
            }}
            label={nearbyQuakeFor ? "地震の詳細に戻る" : nearbyOriginId ? "近傍地震一覧に戻る" : "地震一覧に戻る"}
          />
        </div>
        )
      )}

      {/* 設定タブのサブ画面(カテゴリ/項目の中身)を見ている間だけ、同じ戻るボタンを浮かべる。 */}
      {active === "settings" && settingsPath.length > 0 && (
        isWide && wideAnchorRect ? createPortal(
          <div style={{
            position: "fixed",
            left: wideAnchorRect.right + 12,
            top: wideAnchorRect.top + 16,
            zIndex: 50,
          }}>
            <BackToListButton
              onClick={() => setSettingsPath(p => p.slice(0, -1))}
              label="前の画面に戻る"
            />
          </div>,
          document.body
        ) : (
        <div style={{
          position: "absolute",
          right: 16,
          bottom: backButtonBottom,
          transition: isDragging ? "none" : "bottom 0.4s cubic-bezier(.22,1,.36,1)",
          zIndex: 10,
        }}>
          <BackToListButton
            onClick={() => setSettingsPath(p => p.slice(0, -1))}
            label="前の画面に戻る"
          />
        </div>
        )
      )}

      {(() => {
        const GlassOrPlain = isWide ? "div" : Glass;
        const glassProps = isWide
          ? { ref: wideContentRef, style: { width: "clamp(240px, 30vw, 380px)", height: "100%", overflow: "hidden", position: "relative" } }
          : {
              filterSize: settled ? "normal" : "none",
              blur: settled ? 14 : 8,
              style: {
                width: "100%",
                maxWidth: 480,
                minWidth: 240,
                borderRadius: `${topRadius}px ${topRadius}px ${bottomRadius}px ${bottomRadius}px`,
                transition: isDragging ? "none" : "border-radius 0.4s cubic-bezier(.22,1,.36,1)",
                overflow: "hidden",
                animation: "appear 0.4s cubic-bezier(.25,1,.5,1) 0.1s both",
              },
            };
        return (
      <GlassOrPlain {...glassProps}>
      {/* uiScaleが1未満の時(横画面で画面が低い場合)、中身を実際より広い
          仮想サイズでレイアウトさせてから縮小することで、外枠(Glassの箱)の
          サイズは変えずに文字・要素だけを縮めて収める。
          uiScale===1(縦画面、または横画面でも画面が十分高い場合)では、
          たとえscale(1)であってもtransformを祖先要素に付けると、
          スクロール関連の挙動(iOS Safariでのタッチスクロール、
          scrollIntoViewによる自動スクロール位置など)がおかしくなる
          ことがあるため、実際に縮小が必要な時だけこのラッパーを使う
          (それ以外はFragmentで素通しする)。 */}
      {(() => {
        const needsScale = uiScale < 1;
        const ScaleWrap = needsScale ? "div" : Fragment;
        const scaleWrapProps = needsScale ? {
          style: {
            width: `${100 / uiScale}%`,
            height: `${100 / uiScale}%`,
            transform: `scale(${uiScale})`,
            transformOrigin: "top left",
          },
        } : {};
        return (
      <ScaleWrap {...scaleWrapProps}>
      {/* レイヤーパネル部分 — 高さを直接アニメーションし、
          ナビバーのガラスの中から「せり出してくる」ように展開する。
          広い画面(isWide)では、ドラッグで高さを変える仕組み自体を使わず、
          常に親いっぱいの固定高さで表示する。 */}
      <div
        aria-hidden={!isWide && snapIndex === 0 && !isDragging}
        style={{
          height: isWide ? "100%" : currentHeight,
          paddingTop: isWide ? 14 : 0, // ハンドルが無い分、上に少し余白を持たせる
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          transition: isWide || isDragging ? "none" : "height 0.4s cubic-bezier(.22,1,.36,1)",
          pointerEvents: isWide || snapIndex > 0 || isDragging ? "auto" : "none",
        }}
      >
        {/* ドラッグハンドル — 広い画面(isWide)では高さを変える操作自体が無いため
            表示しない。狭い画面(縦持ち)でのみ、常に上部に固定表示する。
            以前は当たり判定を absolute で上下に張り出す構成にしていたが、
            重ね合わせが原因と思われる表示崩れが発生したため、
            ハンドル行自体の高さを広げてタップ範囲とするシンプルな
            構成に戻した(見た目のバー位置は中央のまま変わらない)。 */}
        {!isWide && (
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
            background: `rgba(${tokens.ink},0.45)`,
          }}/>
        </div>
        )}

        {/* 地震タブの「一覧⇄検索」切り替えバー — ハンドル直下に固定表示し、
            スクロールしても本体と一緒には動かない(検索/一覧の入口を常に見せておく)。
            地震を選択してカード表示になっている間は不要なので隠す。 */}
        {active === "quake" && selectedQuakeId == null && (
          <QuakeListToolbar
            mode={quakeViewMode}
            onModeChange={(mode) => { killScrollMomentum(); setQuakeViewMode(mode); }}
            onHandoffToPanelDrag={handlePointerDown}
          />
        )}

        {/* スクロール可能な本体 — ヘッダー・レイヤー一覧だけがここでスクロールする。
            overflowAnchor: "none" は、タブ切り替えで中身の高さが変わった際に
            ブラウザのスクロールアンカリングがスクロール位置を勝手にずらし、
            ヘッダーや先頭行が隠れて見える不具合を防ぐため。
            key で active/quakeViewMode ごとに別のDOM要素にしているのは、
            scrollTop=0を後から代入するだけだと、iOSの慣性スクロール(勢いよく
            フリックした後の減速アニメーション)が同じ要素に対して裏側で動き続け、
            切り替え直後にリセットしてもすぐ上書きされて別タブ側まで動いてしまう
            ため。要素ごと作り直すことで、古い要素に紐づく慣性スクロールを
            物理的に断ち切る。 */}
        <div
          key={`${active}:${quakeViewMode}:${selectedQuakeId != null}`}
          ref={scrollRef}
          style={{
            flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden", overflowAnchor: "none",
            // 文字(数字含む)の上を指でなぞった時、iOS Safariは既定だと
            // テキスト選択ジェスチャーとして扱ってしまい、スクロールが
            // 効かなくなることがある。中身のテキストを選択不可にして、
            // どこを触ってもスクロールとして扱われるようにする。
            userSelect: "none", WebkitUserSelect: "none", WebkitTouchCallout: "none",
          }}
        >
          <div>
            {active === "quake" ? (
              <>
                {quakeViewMode !== "search" && quakeStatus === "loading" && quakes.length === 0 && (
                  <div style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    gap: 8, padding: "18px 0", color: `rgba(${tokens.ink},0.45)`,
                  }}>
                    <div style={{
                      width: 16, height: 16, borderRadius: "50%",
                      border: `2px solid rgba(${tokens.ink},0.15)`,
                      borderTopColor: `rgba(${tokens.ink},0.6)`,
                      animation: "spin 0.8s linear infinite",
                    }}/>
                    <span style={{ fontSize: 12 }}>地震情報を取得中…</span>
                  </div>
                )}

                {quakeViewMode !== "search" && quakeStatus === "error" && quakes.length === 0 && (
                  <div style={{ padding: "18px 16px", textAlign: "center" }}>
                    <span style={{ fontSize: 12, color: "rgba(255,140,140,0.9)" }}>
                      地震情報の取得に失敗しました
                    </span>
                  </div>
                )}

                {(() => {
                  // 選択中の地震は、直近一覧(quakes)だけでなく、気象庁 震度データベース検索
                  // から開いた地震(searchQuake)も対象に探す(検索結果はquakesには入れていないため)。
                  const selected = quakes.find(q => q.id === selectedQuakeId)
                    || (searchQuake && searchQuake.id === selectedQuakeId ? searchQuake : null);

                  // 選択中は「カード(+各地の震度)のみ」、未選択は「一覧のみ」の排他表示。
                  if (selected) {
                    if (nearbyQuakeFor) {
                      return (
                        <div key={`${selected.id}:nearby`}>
                          <NearbyQuakesPanel
                            place={nearbyQuakeFor}
                            stations={stations}
                            colorScheme={colorScheme}
                            onFoundQuake={onFoundSearchQuake}
                            onSelectQuake={(id) => {
                              if (scrollRef.current) nearbyListScrollTopRef.current = scrollRef.current.scrollTop;
                              setNearbyQuakeFor(null);
                              handleSelectQuakeForScroll(id);
                            }}
                          />
                        </div>
                      );
                    }
                    return (
                      <div key={selected.id}>
                        <QuakeDetailCard quake={selected}/>
                        {!selected.isEqdb && <QuakeMessageCard quake={selected}/>}
                        {shouldShowNearbyQuakeButton(selected) && (
                          <div style={{ margin: "2px 14px 8px" }}>
                            <PressableButton
                              type="button"
                              onClick={() => {
                                if (scrollRef.current) scrollRef.current.scrollTop = 0;
                                setNearbyOriginId(selected.id);
                                setNearbyQuakeFor(selected.place);
                                setSnapIndex(3);
                              }}
                              style={{
                                width: "100%", padding: "10px 12px", borderRadius: 12,
                                border: "none", cursor: "pointer",
                                background: `rgba(${tokens.ink},0.08)`,
                                boxShadow: `inset 0 0 0 0.5px rgba(${tokens.ink},0.14)`,
                                color: tokens.text, fontSize: 13, fontWeight: 600,
                                display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                              }}
                            >
                              この震源の近傍で発生した地震
                            </PressableButton>
                          </div>
                        )}
                        {stationPoints.length > 0 && (
                          <StationPointsList points={stationPoints} displayMode={stationListDisplayMode}/>
                        )}
                      </div>
                    );
                  }

                  // 「検索」モード: 気象庁 震度データベース(eqdb)を期間・M・最大震度で検索するUI。
                  if (quakeViewMode === "search") {
                    return (
                      <QuakeSearchPanel
                        stations={stations}
                        colorScheme={colorScheme}
                        onFoundQuake={onFoundSearchQuake}
                        onSelectQuake={handleSelectQuakeForScroll}
                        search={eqdbSearch}
                        onChangeSearch={setEqdbSearch}
                        onSearchExecuted={() => setSnapIndex(3)}
                        scrollContainerRef={scrollRef}
                      />
                    );
                  }

                  return (
                    <>
                      {quakes.map((q, i) => (
                        <QuakeListRow
                          key={q.id}
                          quake={q}
                          showDivider={i > 0}
                          colorScheme={colorScheme}
                          onSelect={() => handleSelectQuakeForScroll(q.id)}
                        />
                      ))}
                    </>
                  );
                })()}

                {/* フローティング部分(地震一覧)とボタン類(ナビ行)の境界線 */}
                <div style={{ height: 0.5, background: `rgba(${tokens.ink},0.22)`, margin: "2px 0 0" }}/>
              </>
            ) : active === "settings" ? (
              <>
                <SettingsBody
                  path={settingsPath}
                  onNavigate={setSettingsPath}
                  colorSchemeId={colorSchemeId}
                  onChangeColorScheme={onChangeQuakeColorScheme}
                  estIntensityEnabled={estIntensityEnabled}
                  onChangeEstIntensityEnabled={onChangeEstIntensityEnabled}
                  areaFillEnabled={areaFillEnabled}
                  onChangeAreaFillEnabled={onChangeAreaFillEnabled}
                  quakeFetchLimit={quakeFetchLimit}
                  onChangeQuakeFetchLimit={onChangeQuakeFetchLimit}
                  stationListDisplayMode={stationListDisplayMode}
                  onChangeStationListDisplayMode={onChangeStationListDisplayMode}
                />

                {/* フローティング部分(設定メニュー)とボタン類(ナビ行)の境界線 */}
                <div style={{ height: 0.5, background: `rgba(${tokens.ink},0.22)`, margin: "2px 0 0" }}/>
              </>
            ) : (
              <>
                <div style={{
                  display: "flex", alignItems: "center",
                  padding: "8px 18px 11px",
                  borderBottom: `0.5px solid rgba(${tokens.ink},0.15)`,
                }}>
                  <span style={{ fontSize: 14, fontWeight: 600, flex: 1, color: `rgba(${tokens.ink},0.9)` }}>
                    地図レイヤー
                  </span>
                </div>

                {layers.map((l, i) => (
                  <div key={l.id}>
                    {i > 0 && <div style={{ height: 0.5, background: `rgba(${tokens.ink},0.1)`, marginLeft: 18 }}/>}
                    <div style={{ display: "flex", alignItems: "center", padding: "11px 18px", gap: 10 }}>
                      <span style={{ fontSize: 14, color: `rgba(${tokens.ink},0.85)`, flex: 1 }}>
                        {l.label}
                      </span>
                      <Toggle on={l.on} onChange={() => onToggleLayer(l.id)}/>
                    </div>
                  </div>
                ))}

                {/* フローティング部分(レイヤー一覧)とボタン類(ナビ行)の境界線 */}
                <div style={{ height: 0.5, background: `rgba(${tokens.ink},0.22)`, margin: "2px 0 0" }}/>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ナビ行 — 常に表示される、ガラスの“足元”。
          Liquid Glassのハイライトが指の位置に連続追従し、なぞるだけで
          タブを選べる。タップのみの操作もそのまま機能する。
          広い画面(isWide)では、代わりに左端のSideNavRailを使うのでここでは出さない。 */}
      {!isWide && (
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
            background: (navPressed || navDragging) && !glassOpaque ? tokens.glassTint : tokens.navPillBg,
            boxShadow: (navPressed || navDragging) && !glassOpaque
              ? `inset 0 0 0 0.5px ${tokens.rimLight}, inset 0 1px 0 ${tokens.rimHighlight}`
              : tokens.navPillShadow,
            // タッチ/ドラッグ中だけ本物のガラス(backdrop-filter blur)にする。
            backdropFilter: (navPressed || navDragging) && !glassOpaque ? "blur(16px) saturate(160%)" : "none",
            WebkitBackdropFilter: (navPressed || navDragging) && !glassOpaque ? "blur(16px) saturate(160%)" : "none",
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
                color: isActive ? `rgba(${tokens.ink},1)` : `rgba(${tokens.ink},0.6)`,
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
      )}
      </ScaleWrap>
        );
      })()}
      </GlassOrPlain>
        );
      })()}
    </>
  );
}

/* ─────────────────────────────────────────────────────
   QUAKE INTENSITY LEGEND
   選択中の地震の「震度1〜最大震度」までを縦並びで表示する凡例。
   最大震度のバッジだけ枠線で強調する。画面左上に浮かべて使う想定。
   ───────────────────────────────────────────────────── */
const INTENSITY_LEGEND_ORDER = ["1", "2", "3", "4", "5-", "5+", "6-", "6+", "7"];

function QuakeIntensityLegend({ maxIntensity, legacyIntensityScale }) {
  const { tokens } = useContext(ThemeContext);
  const schemeId = useContext(QuakeColorSchemeContext);
  const scheme = QUAKE_COLOR_SCHEMES[schemeId] || QUAKE_COLOR_SCHEMES.fill;

  // 旧震度階級(弱/強の区分が無い震度5・6)は、5弱/6弱と同じ色を使っているため、
  // 通常の並び順にそのまま追加すると「5」と「5弱」のように同じ色のバーが
  // 隣り合って重複しているように見えてしまう。そのため通常の並び順には含めず、
  // 震度4(または5強)までの並びに続けて、単独の「5」または「6」バーで
  // 打ち切る形にする。
  // 震度7の場合も、旧震度階級の期間の地震なら5弱/5強・6弱/6強の区別は
  // 存在しないはずなので、legacyIntensityScaleを見て同様に単純化する。
  let levels;
  if (maxIntensity === "5") {
    levels = ["1", "2", "3", "4", "5"];
  } else if (maxIntensity === "6") {
    levels = ["1", "2", "3", "4", "5", "6"];
  } else if (maxIntensity === "7" && legacyIntensityScale) {
    levels = ["1", "2", "3", "4", "5", "6", "7"];
  } else {
    const maxIdx = INTENSITY_LEGEND_ORDER.indexOf(maxIntensity);
    if (maxIdx < 0) return null; // 震度0や不明("?")の場合は凡例を出さない
    levels = INTENSITY_LEGEND_ORDER.slice(0, maxIdx + 1);
  }

  return (
    <Glass
      radius={12}
      style={{ animation: "appear 0.35s cubic-bezier(.25,1,.5,1)" }}
    >
      <div style={{
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        gap: 2,
        padding: "8px 9px",
      }}>
        {levels.map(key => {
          const style = getIntensityStyleFromScheme(scheme, key);
          const isMax = key === maxIntensity;
          return (
            // 設定の震度配色ピッカーのミニプレビューと同じ、隙間の詰まった横一列のバー
            <div
              key={key}
              style={{
                width: 7, height: 16, borderRadius: 2,
                background: style.bg,
                boxShadow: isMax ? `0 0 0 2px rgba(${tokens.ink},0.9)` : "none",
                flexShrink: 0,
              }}
            />
          );
        })}
      </div>
    </Glass>
  );
}

/* ─────────────────────────────────────────────────────
   BACK TO LIST BUTTON
   地震を選択中に地図上へ浮かぶ丸い「戻る」ボタン。
   押すと選択を解除し、パネルを「中高」にして一覧表示へ戻る。
   ───────────────────────────────────────────────────── */
function BackToListButton({ onClick, label = "地震一覧に戻る" }) {
  const { tokens } = useContext(ThemeContext);
  // ナビ行のガラスハイライトと同じ、"押し込むとガラスが少し膨らむ"演出。
  const [pressed, setPressed] = useState(false);

  return (
    <Glass
      radius={999}
      style={{
        width: 44, height: 44,
        transform: pressed ? "scale(1.16)" : "scale(1)",
        transformOrigin: "center",
        transition: "transform 0.18s cubic-bezier(.22,1,.36,1)",
      }}
    >
      <button
        onClick={onClick}
        onPointerDown={() => setPressed(true)}
        onPointerUp={() => setPressed(false)}
        onPointerCancel={() => setPressed(false)}
        onPointerLeave={() => setPressed(false)}
        aria-label={label}
        style={{
          position: "relative", zIndex: 1,
          width: "100%", height: "100%",
          display: "flex", alignItems: "center", justifyContent: "center",
          color: tokens.text,
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
   LIST VIEW ICON — 横長長方形が縦に3段積み上がったアイコン
   ───────────────────────────────────────────────────── */
function ListViewIcon({ size = 18 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor">
      <rect x="3" y="4.5"  width="18" height="4" rx="1.6"/>
      <rect x="3" y="10.25" width="18" height="4" rx="1.6"/>
      <rect x="3" y="16"   width="18" height="4" rx="1.6"/>
    </svg>
  );
}

/* ─────────────────────────────────────────────────────
   SEARCH ICON — 虫眼鏡アイコン
   ───────────────────────────────────────────────────── */
function SearchGlassIcon({ size = 18 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none"
         stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="10.5" cy="10.5" r="6.5"/>
      <line x1="15.3" y1="15.3" x2="20.5" y2="20.5"/>
    </svg>
  );
}

/* ─────────────────────────────────────────────────────
   QUAKE LIST ROW
   地震一覧の1行分。「直近の一覧」と「検索結果一覧」の両方から共通で使う。
   ───────────────────────────────────────────────────── */
function QuakeListRow({ quake: q, showDivider, colorScheme, onSelect }) {
  const { tokens } = useContext(ThemeContext);

  const style = getIntensityStyleFromScheme(colorScheme, q.maxIntensity || "1");
  return (
    <div>
      {showDivider && <div style={{ height: 0.5, background: `rgba(${tokens.ink},0.08)`, marginLeft: 18 }}/>}
      <PressableButton
        onClick={onSelect}
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
          fontSize: q.isForeign ? 9 : 11, fontWeight: 800,
        }}>
          {q.isForeign ? "遠地" : style.label}
        </span>
        <span style={{
          flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: tokens.text,
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }}>
          {q.place}
        </span>
        {(q.magnitude != null || q.depth != null) && (
          <span className="mono" style={{
            fontSize: 11, color: `rgba(${tokens.ink},0.5)`,
            flexShrink: 0, whiteSpace: "nowrap",
          }}>
            M{q.magnitude != null ? q.magnitude.toFixed(1) : "-"}{q.depth != null ? (q.depth === 0 ? "・ごく浅い" : `・深さ${q.depth}km`) : "・深さ-"}
          </span>
        )}
        <span className="mono" style={{ fontSize: 10, color: `rgba(${tokens.ink},0.4)`, flexShrink: 0 }}>
          {q.isEqdb ? q.time?.slice(0, 10) : q.time?.slice(5, 16)}
        </span>
      </PressableButton>
    </div>
  );
}

/* ─────────────────────────────────────────────────────
   EQDB FORM FIELD — 検索フォームの1項目(ラベル+入力欄)の共通ラッパー
   ───────────────────────────────────────────────────── */
// 開始日/終了日(input[type=date])・OptionPickerの見た目を統一するための共通スタイル。
// 高さを固定(34px)して、日付欄とピッカー欄で縦の揃いがずれないようにする。
// 「中高」パネル(290px固定)に検索ボタンまで収まるよう、あえて少しコンパクトにしている。
// ライト/ダークで色が変わるため、固定オブジェクトではなくtokensを受け取る関数にしている。
function eqdbInputStyle(tokens, mode) {
  return {
    width: "100%", height: 34, boxSizing: "border-box",
    background: `rgba(${tokens.ink},0.06)`, color: tokens.text,
    border: `1px solid rgba(${tokens.ink},0.16)`, borderRadius: 8,
    padding: "0 10px", fontSize: 13, outline: "none",
    colorScheme: mode === "light" ? "light" : "dark",
  };
}

function EqdbFormField({ label, full, children }) {
  const { tokens } = useContext(ThemeContext);

  return (
    <div style={{ flex: full ? "1 1 100%" : 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
      <span style={{ fontSize: 9, fontWeight: 600, color: `rgba(${tokens.ink},0.5)`, lineHeight: 1.2 }}>{label}</span>
      {children}
    </div>
  );
}

// "YYYY-MM-DD" (input[type=date]の値形式)に整形する
function eqdbDateValue(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

// 開始日に指定できる最も古い日付。気象庁 震度データベースの対象期間が
// 1919年1月1日以降のため、これより前は選べないようにする。
const EQDB_MIN_DATE = "1919-01-01";

// 終了日に指定できる最新日(=現在の2日前)。気象庁 震度データベースは直近の地震が
// 登録されるまでにタイムラグがあるため、終了日はここより新しい日付を選べないようにする。
function eqdbMaxEndDate() {
  const d = new Date();
  d.setDate(d.getDate() - 2);
  return eqdbDateValue(d);
}

// 検索フォームの初期値。開始日=1か月前、終了日=選べる最新日(現在の2日前)。
function defaultEqdbDateRange() {
  const start = new Date();
  start.setMonth(start.getMonth() - 1);
  return { start: eqdbDateValue(start), end: eqdbMaxEndDate() };
}

// input[type=date](ネイティブのカレンダーから選ぶ方式)専用のスタイル。
// フォントサイズを16px未満にすると、iOSがフォーカス時に画面を自動的に拡大し、
// そのまま(user-scalable=noのため)手動で縮小できなくなる不具合があるため、
// 必ず16px以上にする。
const EQDB_DATE_INPUT_STYLE_EXTRA = {
  fontSize: 16,
  WebkitAppearance: "none",
  appearance: "none",
};

function eqdbDateInputStyle(tokens, mode) {
  return { ...eqdbInputStyle(tokens, mode), ...EQDB_DATE_INPUT_STYLE_EXTRA };
}

// 下向き山形アイコン(OptionPickerの右端に置く。開いている間は上下反転する)
function ChevronDownIcon({ open }) {
  const { tokens } = useContext(ThemeContext);

  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none"
         stroke={`rgba(${tokens.ink},0.45)`} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
         style={{ flexShrink: 0, marginLeft: 6, transition: "transform 0.15s", transform: open ? "rotate(180deg)" : "none" }}>
      <polyline points="6 9 12 15 18 9"/>
    </svg>
  );
}

/* ─────────────────────────────────────────────────────
   OPTION PICKER
   ネイティブの<select>や<input type="date">はiOS Safariだと背景・高さを
   自前のCSSで統一できず、他の項目と見た目が揃わなくなる(ネイティブのピル状
   UIが被さって見えてしまう)ため、代わりにこのアプリの他の設定画面と同じ
   「ボタン+SVGの山形アイコン」で選択肢を開閉する自前のドロップダウンを使う。
   ───────────────────────────────────────────────────── */
function OptionPicker({ value, options, onChange, style }) {
  const { tokens, mode } = useContext(ThemeContext);
  const [open, setOpen] = useState(false);
  const [menuRect, setMenuRect] = useState(null); // {left, width, top?, bottom?}
  const btnRef = useRef(null);
  const menuRef = useRef(null);
  const selected = options.find(o => o.value === value);

  // ボトムシートは自身のスクロール領域でoverflowを切っているため、通常の
  // position:absoluteな子要素だと上下どちらに開いてもシートの外にはみ出た分が
  // 見切れてしまう。それを避けるため、メニュー自体はdocument.bodyへportalし、
  // position:fixedでボタンの実際の画面上の位置から浮かせて表示する
  // (=シートのoverflowに一切影響されない)。
  function computeAndOpen() {
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) { setOpen(true); return; }
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const openUpward = spaceBelow < 240 && spaceAbove > spaceBelow;
    setMenuRect({
      left: rect.left, width: rect.width,
      ...(openUpward ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }),
    });
    setOpen(true);
  }

  // 開いている間にシートやページがスクロールされると、固定座標がボタンと
  // ずれてしまうため、その場合はメニューを閉じる。
  useEffect(() => {
    if (!open) return;
    const close = (e) => {
      // メニュー自身(選択肢一覧)のスクロールでは閉じない。ボトムシート側など
      // 外側のスクロールでボタンとメニューの位置がずれた場合だけ閉じる。
      if (menuRef.current && menuRef.current.contains(e.target)) return;
      setOpen(false);
    };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  return (
    <div style={{ position: "relative" }}>
      <PressableButton
        ref={btnRef}
        type="button"
        onClick={() => (open ? setOpen(false) : computeAndOpen())}
        style={{
          ...eqdbInputStyle(tokens, mode), ...style,
          display: "flex", alignItems: "center", justifyContent: "space-between",
          cursor: "pointer",
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {selected?.label ?? value}
        </span>
        <ChevronDownIcon open={open}/>
      </PressableButton>

      {open && menuRect && createPortal(
        <>
          {/* 背面タップで閉じるための透明オーバーレイ */}
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 9998 }}/>
          <div
            ref={menuRef}
            style={{
              position: "fixed",
              left: menuRect.left, width: menuRect.width,
              ...(menuRect.top != null ? { top: menuRect.top } : { bottom: menuRect.bottom }),
              zIndex: 9999,
              maxHeight: 220, overflowY: "auto",
              borderRadius: 10,
              background: tokens.glassOpaqueBg,
              boxShadow: `0 10px 28px rgba(0,0,0,0.35), inset 0 0 0 0.5px rgba(${tokens.ink},0.14)`,
            }}
          >
            {options.map((o, i) => (
              <PressableButton
                key={o.value}
                type="button"
                onClick={() => { onChange(o.value); setOpen(false); }}
                style={{
                  width: "100%", textAlign: "left", padding: "9px 12px",
                  background: o.value === value ? `rgba(${tokens.ink},0.08)` : "transparent",
                  border: "none", borderTop: i > 0 ? `0.5px solid rgba(${tokens.ink},0.08)` : "none",
                  color: tokens.text, fontSize: 13,
                }}
              >
                {o.label}
              </PressableButton>
            ))}
          </div>
        </>,
        document.body
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────
   NEARBY QUAKES PANEL
   「この震源の近傍で発生した地震」。選択中のP2P地震情報(リアルタイム)の
   震源地名と同じ震源地名を持つ地震を、気象庁 震度データベース(eqdb)全期間から
   検索して一覧表示する。eqdbの検索APIには震央地名そのものを条件にする項目が
   無い(震央地域はコード化された階層選択のみ)ため、期間全体を対象に検索した
   上で、返ってきた各件の震源地名(name)が選択中の地震の震源地名と完全一致する
   ものだけをクライアント側で絞り込む。
   ───────────────────────────────────────────────────── */
const NEARBY_SORT_BUTTONS = [
  { key: "time", label: "日時" },
  { key: "mag", label: "M" },
  { key: "maxInt", label: "最大震度" },
  { key: "depth", label: "深さ" },
];

// 近傍地震一覧の検索結果キャッシュ(震源地名→結果一覧)。
// NearbyQuakesPanelは、近傍一覧→他の地震の詳細→近傍一覧、と行き来するたびに
// (selectedQuakeIdの変化でキーが変わるため)Reactコンポーネントとしては毎回
// 作り直される。componentのstateはその度に失われるので、再訪問時に検索し直さず
// 済むよう、コンポーネントの外(モジュールスコープ)にキャッシュを持たせる。
const nearbyQuakeSearchCache = new Map();

function NearbyQuakesPanel({ place, stations, colorScheme, onFoundQuake, onSelectQuake }) {
  const { tokens } = useContext(ThemeContext);

  const cached = nearbyQuakeSearchCache.get(place);
  const [status, setStatus] = useState(cached ? "done" : "loading"); // loading | error | done
  const [results, setResults] = useState(cached || []);
  const [sortKey, setSortKey] = useState("maxInt");
  const [sortDesc, setSortDesc] = useState(true);
  const [loadingId, setLoadingId] = useState(null);

  useEffect(() => {
    if (nearbyQuakeSearchCache.has(place)) return; // キャッシュ済みなら検索し直さない
    let cancelled = false;
    (async () => {
      setStatus("loading");
      try {
        const { list, errMsg } = await fetchEqdbSearch({
          startDate: EQDB_MIN_DATE, endDate: eqdbMaxEndDate(),
          minMag: 0, maxInt: "1", sort: "S2", epi: place,
        });
        if (cancelled) return;
        if (errMsg) { setStatus("error"); setResults([]); return; }
        nearbyQuakeSearchCache.set(place, list);
        setResults(list);
        setStatus("done");
      } catch (e) {
        if (!cancelled) { setStatus("error"); setResults([]); }
      }
    })();
    return () => { cancelled = true; };
  }, [place]);

  const sorted = useMemo(() => {
    const arr = [...results];
    const valueOf = (eq) => {
      if (sortKey === "time") return eq.id || "";
      if (sortKey === "mag") return parseFloat(eq.mag) || 0;
      if (sortKey === "depth") return parseInt((eq.dep || "").match(/\d+/)?.[0] || "0", 10);
      return eqdbIntensityStringToScale(eq.maxI || "");
    };
    arr.sort((a, b) => {
      const av = valueOf(a), bv = valueOf(b);
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sortDesc ? -cmp : cmp;
    });
    return arr;
  }, [results, sortKey, sortDesc]);

  function handleSortTap(key) {
    if (sortKey === key) { setSortDesc(d => !d); return; }
    setSortKey(key);
    setSortDesc(true);
  }

  async function handlePick(eq) {
    if (loadingId) return;
    setLoadingId(eq.id);
    try {
      const [detail, geo] = await Promise.all([fetchEqdbEvent(eq.id), loadGeoData()]);
      if (!detail) return;
      const card = buildEqdbQuakeCard(detail, eq, stations, geo?.areas);
      onFoundQuake(card);
      onSelectQuake(card.id);
    } finally {
      setLoadingId(null);
    }
  }

  return (
    <div>
      <div style={{ padding: "10px 14px 2px" }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: tokens.text }}>
          この震源({place})の近傍で発生した地震
        </span>
      </div>

      <div style={{ display: "flex", gap: 6, padding: "8px 14px 10px", flexWrap: "wrap" }}>
        {NEARBY_SORT_BUTTONS.map(b => (
          <PressableButton
            key={b.key}
            type="button"
            onClick={() => handleSortTap(b.key)}
            style={{
              padding: "5px 10px", borderRadius: 8, fontSize: 12, fontWeight: 600,
              border: "none", cursor: "pointer",
              background: sortKey === b.key ? `rgba(${tokens.ink},0.18)` : `rgba(${tokens.ink},0.06)`,
              color: sortKey === b.key ? tokens.text : `rgba(${tokens.ink},0.6)`,
            }}
          >
            {b.label}{sortKey === b.key ? (sortDesc ? " ↓" : " ↑") : ""}
          </PressableButton>
        ))}
      </div>

      {status === "loading" && (
        <div style={{ padding: "18px 0", textAlign: "center", color: `rgba(${tokens.ink},0.45)`, fontSize: 12 }}>
          検索中…
        </div>
      )}
      {status === "error" && (
        <div style={{ padding: "18px 16px", textAlign: "center", color: "rgba(255,140,140,0.9)", fontSize: 12 }}>
          取得に失敗しました
        </div>
      )}
      {status === "done" && sorted.length === 0 && (
        <div style={{ padding: "18px 16px", textAlign: "center", color: `rgba(${tokens.ink},0.45)`, fontSize: 12 }}>
          同じ震源地の地震は見つかりませんでした
        </div>
      )}
      {status === "done" && sorted.map((eq, i) => (
        <QuakeListRow
          key={eq.id}
          quake={eqdbListItemToPreview(eq)}
          showDivider={i > 0}
          colorScheme={colorScheme}
          onSelect={() => handlePick(eq)}
        />
      ))}
    </div>
  );
}

/* ─────────────────────────────────────────────────────
   QUAKE SEARCH PANEL
   「検索」モードの中身。気象庁 震度データベース(eqdb)を期間・マグニチュード・
   最大震度で検索するフォーム + 結果一覧。
   結果一覧の1件をタップすると、その地震の観測点別震度(mode=event)を取得し、
   通常の地震カード(QuakeDetailCard等)と全く同じ見た目で表示できる形に変換して
   onFoundQuakeで親(App)に渡し、onSelectQuakeで選択状態にする。
   ───────────────────────────────────────────────────── */
function QuakeSearchPanel({ stations, colorScheme, onFoundQuake, onSelectQuake, search, onChangeSearch, onSearchExecuted, scrollContainerRef }) {
  const { tokens, mode } = useContext(ThemeContext);

  const maxEndDate = eqdbMaxEndDate(); // 終了日に選べる最新日(=現在の2日前)。固定なので毎回同じ値。

  const {
    startDate, endDate, minMag, maxInt, sort,
    status, isSearching, hasSearched, results, loadingId,
  } = search;

  // 検索条件・結果一覧の状態は、選択解除で再マウントされても消えないよう
  // 親(BottomDock)側で保持している。ここでは差分だけをマージして書き戻す。
  function patch(p) {
    onChangeSearch(prev => ({ ...prev, ...p }));
  }

  // 検索を実行したら、パネルの高さは「中高」のまま、結果一覧の先頭が
  // パネル上部に来る位置までスクロールする。
  // (「戻る」で選択解除された後の再マウント時など、ユーザー操作を伴わない
  //  タイミングでは動かしたくないため、実際にhandleSearchが呼ばれた時だけ
  //  フラグを立てて、検索が完了した瞬間(isSearchingがtrue→falseになった瞬間)に発火する)
  const justSearchedRef = useRef(false);
  const resultsAnchorRef = useRef(null);
  useEffect(() => {
    if (justSearchedRef.current && !isSearching) {
      justSearchedRef.current = false;
      onSearchExecuted?.();
      // パネルの高さが変わるアニメーション(0.4s)が落ち着いてからスクロールする。
      // scrollIntoView()は「overflow:hiddenだが技術的にはスクロール可能な
      // 祖先要素」まで対象にしてしまうことがあり(例えば角丸クリップ用の
      // overflow:hidden要素)、本来スクロールさせたいスクロールコンテナ
      // (scrollContainerRef)ではなく見えない場所を動かしてしまうことがある。
      // そのため、対象となるスクロールコンテナに対して直接scrollTopを
      // 計算して設定する。
      setTimeout(() => {
        const container = scrollContainerRef?.current;
        const anchor = resultsAnchorRef.current;
        if (container && anchor) {
          const containerRect = container.getBoundingClientRect();
          const anchorRect = anchor.getBoundingClientRect();
          const delta = anchorRect.top - containerRect.top;
          container.scrollTo({ top: container.scrollTop + delta, behavior: "smooth" });
        } else {
          anchor?.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      }, 420);
    }
  }, [isSearching, onSearchExecuted]);

  async function handleSearch() {
    if (isSearching) return;
    justSearchedRef.current = true;

    // 検索前に、終了日が現在の2日前を超えていないか・開始日が終了日より後や
    // 1919年1月1日より前になっていないかを念のため補正する
    // (input[type=date]のmax/min属性で通常は防げるが、念のためここでも二重にチェックしておく)。
    let effectiveEnd = endDate > maxEndDate ? maxEndDate : endDate;
    let effectiveStart = startDate > effectiveEnd ? effectiveEnd : startDate;
    if (effectiveStart < EQDB_MIN_DATE) effectiveStart = EQDB_MIN_DATE;

    if (!effectiveStart || !effectiveEnd) { patch({ status: "開始日・終了日を指定してください" }); justSearchedRef.current = false; return; }

    patch({
      startDate: effectiveStart, endDate: effectiveEnd,
      isSearching: true, hasSearched: true,
      status: "気象庁 震度データベースを検索中…",
    });
    try {
      const minMagNum = parseFloat(minMag) || 0;
      const { list, errMsg, summary } = await fetchEqdbSearch({ startDate: effectiveStart, endDate: effectiveEnd, minMag: minMagNum, maxInt, sort });
      if (errMsg) {
        patch({ status: `⚠ ${errMsg}`, results: [] });
        return;
      }
      const maxIntScale = EQDB_MAX_INT_SCALE[maxInt] || 10;
      const filtered = list.filter(eq => {
        const magOk = minMagNum <= 0 || parseFloat(eq.mag) >= minMagNum;
        const intOk = maxInt === "1" || eqdbIntensityThresholdScale(eq.maxI || "") >= maxIntScale;
        return magOk && intOk;
      });
      if (sort === "S2") {
        filtered.sort((a, b) => eqdbIntensityStringToScale(b.maxI || "") - eqdbIntensityStringToScale(a.maxI || "") || parseFloat(b.mag) - parseFloat(a.mag));
      } else if (sort === "S3") {
        filtered.sort((a, b) => parseFloat(b.mag) - parseFloat(a.mag) || eqdbIntensityStringToScale(b.maxI || "") - eqdbIntensityStringToScale(a.maxI || ""));
      }
      patch({
        results: filtered,
        status: filtered.length !== list.length
          ? `${filtered.length}件（取得${list.length}件からM${minMagNum.toFixed(1)}以上でフィルター）`
          : (summary || `${filtered.length}件`),
      });
    } catch (e) {
      patch({ status: `検索中にエラーが発生しました: ${e.message}`, results: [] });
    } finally {
      patch({ isSearching: false });
    }
  }

  async function handleSelect(eq) {
    if (loadingId) return;
    patch({ loadingId: eq.id, status: `「${eq.name}」の震度データを取得中…` });
    try {
      const [detail, geo] = await Promise.all([fetchEqdbEvent(eq.id), loadGeoData()]);
      if (!detail) {
        patch({ status: "詳細データの取得に失敗しました" });
        return;
      }
      const card = buildEqdbQuakeCard(detail, eq, stations, geo?.areas);
      onFoundQuake(card);
      onSelectQuake(card.id);
    } catch (e) {
      patch({ status: `詳細データの取得に失敗しました: ${e.message}` });
    } finally {
      patch({ loadingId: null });
    }
  }

  return (
    <div>
      {/* 検索条件フォーム */}
      <div style={{ padding: "2px 14px 6px", display: "flex", flexDirection: "column", gap: 5 }}>
        <div style={{ display: "flex", gap: 8 }}>
          <EqdbFormField label="開始日">
            <input type="date" value={startDate} min={EQDB_MIN_DATE} max={endDate || maxEndDate}
              onChange={e => patch({ startDate: e.target.value < EQDB_MIN_DATE ? EQDB_MIN_DATE : e.target.value })} style={eqdbDateInputStyle(tokens, mode)}/>
          </EqdbFormField>
          <EqdbFormField label="終了日">
            <input type="date" value={endDate} min={startDate || EQDB_MIN_DATE} max={maxEndDate}
              onChange={e => patch({ endDate: e.target.value > maxEndDate ? maxEndDate : e.target.value })} style={eqdbDateInputStyle(tokens, mode)}/>
          </EqdbFormField>
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <EqdbFormField label="最小M">
            <OptionPicker value={minMag} options={EQDB_MIN_MAG_OPTIONS} onChange={v => patch({ minMag: v })}/>
          </EqdbFormField>
          <EqdbFormField label="最大震度">
            <OptionPicker value={maxInt} options={EQDB_MAX_INT_OPTIONS} onChange={v => patch({ maxInt: v })}/>
          </EqdbFormField>
        </div>

        <EqdbFormField label="並び順" full>
          <OptionPicker value={sort} options={EQDB_SORT_OPTIONS} onChange={v => patch({ sort: v })}/>
        </EqdbFormField>

        <PressableButton
          onClick={handleSearch}
          disabled={isSearching}
          style={{
            marginTop: 1, padding: "8px 0", borderRadius: 10,
            display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
            border: "1px solid rgba(10,132,255,0.9)",
            background: "#0A84FF", color: "#ffffff",
            fontSize: 14, fontWeight: 700,
            opacity: isSearching ? 0.5 : 1,
          }}
        >
          <SearchGlassIcon size={15}/>
          <span>{isSearching ? "検索中…" : "検索"}</span>
        </PressableButton>

        {status !== "" && (
          <div style={{ fontSize: 11, color: `rgba(${tokens.ink},0.55)`, textAlign: "center" }}>
            {status}
          </div>
        )}
      </div>

      {/* 検索結果一覧 — refは「検索」実行後にここまでスクロールするための目印 */}
      <div ref={resultsAnchorRef}/>
      {!hasSearched ? (
        <div style={{ padding: "18px 16px", textAlign: "center" }}>
          <span style={{ fontSize: 12, color: `rgba(${tokens.ink},0.4)` }}>
            条件を指定して検索してください
          </span>
        </div>
      ) : results.length === 0 ? (
        !isSearching && (
          <div style={{ padding: "18px 16px", textAlign: "center" }}>
            <span style={{ fontSize: 12, color: `rgba(${tokens.ink},0.4)` }}>
              該当する地震が見つかりませんでした
            </span>
          </div>
        )
      ) : (
        results.map((eq, i) => (
          <div key={eq.id} style={loadingId === eq.id ? { opacity: 0.5, pointerEvents: "none" } : undefined}>
            <QuakeListRow
              quake={eqdbListItemToPreview(eq)}
              showDivider={i > 0}
              colorScheme={colorScheme}
              onSelect={() => handleSelect(eq)}
            />
          </div>
        ))
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────
   QUAKE LIST TOOLBAR
   地震タブの一覧最上部（ハンドル直下）に固定表示するミニバー。
   ハイライトピルの動き(指の位置に連続追従するドラッグ、離した位置の
   タブへスナップ、押している間のスケール膨張)は、ボトムドック本体の
   ナビ行(NAVタブ)と全く同じロジックを2項目版として踏襲している。
   - リストボタン: 直近の地震一覧（既存のP2P地震情報フィード）を表示
   - 検索ボタン:   気象庁 震度データベースの検索UIに切り替える
   ───────────────────────────────────────────────────── */
const QUAKE_TOOLBAR_ITEMS = [
  { id: "recent", label: "地震一覧" },
  { id: "search", label: "地震検索" },
];

function QuakeListToolbar({ mode, onModeChange, onHandoffToPanelDrag }) {
  const { tokens } = useContext(ThemeContext);
  const { opaque: glassOpaque } = useContext(GlassOpaqueContext);

  // ナビ行と同じ %ベース連続追従方式。PAD_X はJSX側のpaddingと必ず一致させる。
  const PAD_X = 3;
  const rowRef      = useRef(null);
  const pointerId    = useRef(null);
  const moved        = useRef(false);
  const startX       = useRef(0);
  const startY       = useRef(0);
  const N     = QUAKE_TOOLBAR_ITEMS.length;
  const tabW  = 100 / N; // 1タブの幅[%]（内側領域基準）

  const activeIndex = QUAKE_TOOLBAR_ITEMS.findIndex(item => item.id === mode);
  const [highlightLeft, setHighlightLeft] = useState(activeIndex * tabW);
  const [dragging,      setDragging]      = useState(false);
  const [pressed,       setPressed]       = useState(false);
  const [previewIdx,    setPreviewIdx]    = useState(null);

  // mode が外部から変わった時（タップ以外の切替）にハイライトを追従させる
  useEffect(() => {
    if (!dragging) setHighlightLeft(activeIndex * tabW);
  }, [activeIndex, dragging, tabW]);

  function clientXToLeft(clientX) {
    const row = rowRef.current;
    if (!row) return activeIndex * tabW;
    const { left, width } = row.getBoundingClientRect();
    const innerLeft  = left + PAD_X;
    const innerWidth = width - PAD_X * 2;
    const ratio = Math.max(0, Math.min(1, (clientX - innerLeft) / innerWidth));
    return ratio * 100;
  }

  function clientXToIndex(clientX) {
    const pct = clientXToLeft(clientX);
    return Math.max(0, Math.min(N - 1, Math.round(pct / tabW - 0.5)));
  }

  function handlePointerDown(e) {
    pointerId.current = e.pointerId;
    moved.current      = false;
    startX.current     = e.clientX;
    startY.current     = e.clientY;
    e.currentTarget.setPointerCapture(e.pointerId);
    const idx = clientXToIndex(e.clientX);
    setPreviewIdx(idx);
    setPressed(true);
    setHighlightLeft(idx * tabW);
  }

  function handlePointerMove(e) {
    if (pointerId.current !== e.pointerId) return;

    if (!moved.current) {
      const dx = e.clientX - startX.current;
      const dy = e.clientY - startY.current;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        moved.current = true;

        // 縦方向優位の動き = すぐ上にあるドラッグハンドルを掴もうとして
        // 指が少しずれてこのバーの上で始まってしまったケース。
        // このバーのトグル操作としては扱わず、パネル本体のリサイズドラッグへ
        // そのまま引き渡す(ハイライトは元の位置に戻して動かさない)。
        if (Math.abs(dy) > Math.abs(dx)) {
          setPressed(false);
          setPreviewIdx(null);
          setHighlightLeft(activeIndex * tabW);
          try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
          pointerId.current = null;
          onHandoffToPanelDrag?.(e);
          return;
        }

        setDragging(true);
      }
    }

    const idx = clientXToIndex(e.clientX);
    setPreviewIdx(idx);
    if (moved.current) {
      const raw = clientXToLeft(e.clientX) - tabW / 2;
      setHighlightLeft(Math.max(0, Math.min(100 - tabW, raw)));
    } else {
      setHighlightLeft(idx * tabW);
    }
  }

  function handlePointerUp(e) {
    if (pointerId.current !== e.pointerId) return;
    pointerId.current = null;
    const idx = clientXToIndex(e.clientX);
    setDragging(false);
    setPressed(false);
    setPreviewIdx(null);
    setHighlightLeft(idx * tabW);
    onModeChange(QUAKE_TOOLBAR_ITEMS[idx].id);
  }

  function handleClick(id) {
    if (moved.current) return; // ドラッグ完了後(縦方向への引き渡しを含む)の二重発火を防ぐ
    const idx = QUAKE_TOOLBAR_ITEMS.findIndex(item => item.id === id);
    setHighlightLeft(idx * tabW);
    onModeChange(id);
  }

  const displayIdx = dragging && previewIdx != null ? previewIdx : activeIndex;

  return (
    <div style={{ flexShrink: 0, padding: "2px 14px 8px" }}>
      <div
        ref={rowRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        style={{
          position: "relative",
          display: "flex",
          height: 34,
          borderRadius: 999,
          background: `rgba(${tokens.ink},0.05)`,
          boxShadow: `inset 0 0 0 0.5px rgba(${tokens.ink},0.14)`,
          padding: PAD_X,
          touchAction: "none",
          userSelect: "none",
          WebkitUserSelect: "none",
          WebkitTouchCallout: "none",
          WebkitTapHighlightColor: "transparent",
        }}
      >
        {/* スライドするハイライトピル — ナビ行と同じ%ベースのleft/width計算 */}
        <div
          aria-hidden
          style={{
            position: "absolute",
            top: PAD_X, bottom: PAD_X,
            left: `calc(${PAD_X}px + (100% - ${PAD_X * 2}px) * ${highlightLeft / 100})`,
            width: `calc((100% - ${PAD_X * 2}px) * ${tabW / 100})`,
            borderRadius: 999,
            background: (pressed || dragging) && !glassOpaque ? tokens.glassTint : tokens.navPillBg,
            boxShadow: (pressed || dragging) && !glassOpaque
              ? `inset 0 0 0 0.5px ${tokens.rimLight}, inset 0 1px 0 ${tokens.rimHighlight}`
              : tokens.navPillShadow,
            // タッチ/ドラッグ中だけ本物のガラス(backdrop-filter blur)にする。
            backdropFilter: (pressed || dragging) && !glassOpaque ? "blur(16px) saturate(160%)" : "none",
            WebkitBackdropFilter: (pressed || dragging) && !glassOpaque ? "blur(16px) saturate(160%)" : "none",
            transform: pressed ? "scale(1.16)" : "scale(1)",
            transformOrigin: "center",
            transition: dragging
              ? "transform 0.18s cubic-bezier(.22,1,.36,1)"
              : "left 0.38s cubic-bezier(.22,1,.36,1), transform 0.18s cubic-bezier(.22,1,.36,1)",
            pointerEvents: "none",
            zIndex: 0,
          }}
        />
        {QUAKE_TOOLBAR_ITEMS.map(({ id, label }, idx) => {
          const isActive = idx === displayIdx;
          return (
            <button
              key={id}
              onClick={() => handleClick(id)}
              aria-label={label}
              style={{
                position: "relative", zIndex: 1, flex: 1,
                display: "flex", alignItems: "center", justifyContent: "center",
                border: "none", background: "transparent", borderRadius: 999,
                cursor: "pointer",
                color: isActive ? `rgba(${tokens.ink},1)` : `rgba(${tokens.ink},0.5)`,
                transition: "color 0.15s",
                touchAction: "none",
                userSelect: "none",
                WebkitUserSelect: "none",
                WebkitTouchCallout: "none",
                WebkitTapHighlightColor: "transparent",
              }}
            >
              {id === "recent" ? <ListViewIcon size={16}/> : <SearchGlassIcon size={16}/>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────
   SETTINGS TAB — 階層メニュー
   設定タブを開くとまずカテゴリ一覧(地震/津波/気象/警報/詳細設定)を表示し、
   カテゴリを選ぶとその中の項目一覧へ、項目を選ぶと実際の設定内容へ、と
   BottomDockパネルの中身をその場で差し替えながら掘り下げていく構成。
   現在地は親(BottomDock)がsettingsPath(配列)として持ち、このコンポーネントは
   それを受け取って該当する画面を描くだけの純粋な表示コンポーネントにしている。

   見た目は「地図レイヤー」一覧(フチなし全幅リスト+下線ヘッダー)をそのまま
   流用せず、震度配色ピッカーで元々使っていた「角丸のグループ化カード」を
   基本デザインとして統一している。
   ───────────────────────────────────────────────────── */
const SETTINGS_MENU = [
  { id: "quake",    label: "地震" },
  { id: "tsunami",  label: "津波" },
  { id: "weather",  label: "気象" },
  { id: "alert",    label: "警報" },
  { id: "advanced", label: "詳細設定" },
];

// カテゴリごとの項目一覧。地震カテゴリはSettingsBody内で専用に組み立てるため
// ここには含めない。詳細設定にはライセンス表示を追加、他のカテゴリは現状すべて骨組み(空のプレースホルダー画面)。
const SETTINGS_ITEMS = {
  advanced: [
    { id: "appearance", label: "外観" },
    { id: "floating",   label: "フローティング関連" },
    { id: "license",    label: "ライセンス" },
  ],
};

// 設定画面共通のヘッダー。「地図レイヤー」のような下線区切りは使わず、
// 太字の大きめタイトルにすることで独自の見た目にしている。
// 戻る操作は地震タブと同じ丸いフローティングボタン(BackToListButton)に
// 統一したので、ヘッダー自体には戻るボタンを持たせていない。
function SettingsHeader({ title }) {
  const { tokens } = useContext(ThemeContext);
  return (
    <div style={{ padding: "12px 14px 6px" }}>
      <span style={{ fontSize: 16, fontWeight: 700, color: tokens.text }}>
        {title}
      </span>
    </div>
  );
}

// カテゴリ/項目一覧を包む角丸のグループ化カード。震度配色ピッカーと同じ見た目の箱。
function SettingsCard({ children }) {
  const { tokens } = useContext(ThemeContext);
  return (
    <div style={{ margin: "6px 14px 8px" }}>
      <div style={{
        borderRadius: 12,
        overflow: "hidden",
        background: tokens.cardBg,
        boxShadow: `inset 0 0 0 0.5px ${tokens.cardBorder}`,
      }}>
        {children}
      </div>
    </div>
  );
}

function SettingsCardDivider() {
  const { tokens } = useContext(ThemeContext);
  return <div style={{ height: 0.5, background: tokens.divider, marginLeft: 12 }}/>;
}

// カード内の1行。右端に「>」を出して、掘り下げられることを示す。
function SettingsMenuRow({ label, onClick }) {
  const { tokens } = useContext(ThemeContext);
  return (
    <PressableButton
      onClick={onClick}
      style={{
        width: "100%", display: "flex", alignItems: "center", gap: 10,
        padding: "12px 14px", background: "transparent", border: "none",
        cursor: "pointer", textAlign: "left",
      }}
    >
      <span style={{ fontSize: 14, fontWeight: 600, color: tokens.text, flex: 1 }}>
        {label}
      </span>
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none"
           stroke={tokens.textTertiary} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="9 6 15 12 9 18"/>
      </svg>
    </PressableButton>
  );
}

// カード内の1行(ON/OFF切り替え用)。SettingsMenuRowと同じ余白・見た目で、
// 右端は「>」の代わりに丸いスイッチ(Toggle)を出す。
function SettingsToggleRow({ label, description, checked, onChange, disabled = false }) {
  const { tokens } = useContext(ThemeContext);
  return (
    <div style={{
      width: "100%", display: "flex", alignItems: "center", gap: 10,
      padding: "12px 14px",
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: tokens.text }}>{label}</div>
        {description && (
          <div style={{ fontSize: 11, color: tokens.textSecondary, marginTop: 3, lineHeight: 1.4 }}>
            {description}
          </div>
        )}
      </div>
      <Toggle on={checked} onChange={onChange} disabled={disabled}/>
    </div>
  );
}

// 地震一覧の取得件数の設定画面。スライダー(左右に動かして数値を決める) + よく使う件数のプリセットチップ。
// 以前は数値入力欄だったが、タップした瞬間にiOS側でページ全体がズームされてしまうため、
// テキスト入力を使わずスライダーだけで完結するようにしている。
function QuakeFetchLimitSettings({ value, onChange }) {
  const { tokens } = useContext(ThemeContext);

  const presets = [50, 100, 300, 500, 1000];

  return (
    <SettingsCard>
      <div style={{ padding: "14px 14px 12px" }}>
        <div style={{ fontSize: 11, color: `rgba(${tokens.ink},0.4)`, marginBottom: 12, lineHeight: 1.5 }}>
          地震一覧を取得する最大件数です。{QUAKE_FETCH_LIMIT_MIN}〜{QUAKE_FETCH_LIMIT_MAX}件の範囲で指定できます
          (デフォルト{QUAKE_FETCH_LIMIT_DEFAULT}件)。100件を超える件数を指定すると複数回に分けて取得するため、
          件数が多いほど取得に時間がかかります。また、直近1週間より前の情報は取得できない仕様のため、
          地震の少ない期間は指定した件数に満たないことがあります。
        </div>

        <div style={{ textAlign: "center", marginBottom: 10 }}>
          <span style={{ fontSize: 30, fontWeight: 800, color: tokens.text }}>{value}</span>
          <span style={{ fontSize: 14, fontWeight: 600, color: `rgba(${tokens.ink},0.5)`, marginLeft: 4 }}>件</span>
        </div>

        <input
          type="range"
          min={QUAKE_FETCH_LIMIT_MIN}
          max={QUAKE_FETCH_LIMIT_MAX}
          step={1}
          value={value}
          onChange={e => onChange(clampQuakeFetchLimit(e.target.value))}
          style={{
            width: "100%", height: 28,
            accentColor: "#0A84FF",
            touchAction: "none",
          }}
        />
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 2 }}>
          <span style={{ fontSize: 10, color: `rgba(${tokens.ink},0.35)` }}>{QUAKE_FETCH_LIMIT_MIN}</span>
          <span style={{ fontSize: 10, color: `rgba(${tokens.ink},0.35)` }}>{QUAKE_FETCH_LIMIT_MAX}</span>
        </div>
      </div>
      <SettingsCardDivider/>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, padding: "12px 14px" }}>
        {presets.map(p => (
          <PressableButton
            key={p}
            onClick={() => onChange(p)}
            style={{
              padding: "6px 12px", borderRadius: 999, fontSize: 12, fontWeight: 600,
              border: `1px solid rgba(${tokens.ink},0.16)`,
              background: value === p ? "rgba(10,132,255,0.9)" : `rgba(${tokens.ink},0.08)`,
              color: tokens.text, cursor: "pointer",
            }}
          >
            {p}件
          </PressableButton>
        ))}
      </div>
    </SettingsCard>
  );
}

// 震度配色の選択画面。元のQuakeSettingsBodyと同じ見た目のリスト。
function QuakeColorSchemeSettings({ colorSchemeId, onChangeColorScheme }) {
  const { tokens } = useContext(ThemeContext);

  const entries = Object.entries(QUAKE_COLOR_SCHEMES);
  return (
    <SettingsCard>
      {entries.map(([id, scheme], i) => {
        const selected = colorSchemeId === id;
        return (
          <div key={id}>
            {i > 0 && <SettingsCardDivider/>}
            <PressableButton
              onClick={() => onChangeColorScheme(id)}
              style={{
                width: "100%", display: "flex", alignItems: "center", gap: 12,
                padding: "11px 12px",
                background: selected ? `rgba(${tokens.ink},0.07)` : "transparent",
                border: "none", cursor: "pointer", textAlign: "left",
              }}
            >
              {/* ミニプレビュー(震度1〜7の色見本を並べる) */}
              <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
                {["1","2","3","4","5-","5+","6-","6+","7"].map(key => (
                  <div key={key} style={{
                    width: 7, height: 16, borderRadius: 2,
                    background: scheme.colors[key].bg,
                  }}/>
                ))}
              </div>
              <span style={{ fontSize: 13, fontWeight: 600, color: tokens.text, flex: 1 }}>
                {scheme.label}
              </span>
              {selected && (
                <span style={{ fontSize: 13, color: `rgba(${tokens.ink},0.85)` }}>✓</span>
              )}
            </PressableButton>
          </div>
        );
      })}
    </SettingsCard>
  );
}

// 震度観測点リストの表示方法(階層表示/一覧表示)の選択画面。震度配色ピッカーと同じ見た目のリスト。
// 下にプレビュー用のサンプルデータを添えて、選んだ表示方法がどう見えるかその場で分かるようにする。
const STATION_DISPLAY_PREVIEW_SAMPLE = [
  { pref: "東京都",   city: "千代田区", addr: "千代田区大手町", intensityKey: "3" },
  { pref: "神奈川県", city: "横浜市",   addr: "横浜市中区山下町", intensityKey: "3" },
];

function StationListDisplayModePreview({ mode }) {
  const { tokens } = useContext(ThemeContext);

  const schemeId = useContext(QuakeColorSchemeContext);
  const scheme = QUAKE_COLOR_SCHEMES[schemeId] || QUAKE_COLOR_SCHEMES.fill;
  const sorted = [...STATION_DISPLAY_PREVIEW_SAMPLE].sort(
    (a, b) => INTENSITY_ORDER.indexOf(b.intensityKey) - INTENSITY_ORDER.indexOf(a.intensityKey)
  );

  return (
    <div style={{ margin: "18px 14px 2px" }}>
      <div style={{ padding: "0 2px 6px", fontSize: 11, fontWeight: 600, color: `rgba(${tokens.ink},0.5)` }}>
        プレビュー
      </div>
      <div style={{
        borderRadius: 12, overflow: "hidden",
        background: `rgba(${tokens.ink},0.04)`,
        boxShadow: `inset 0 0 0 0.5px rgba(${tokens.ink},0.08)`,
        pointerEvents: "none", // プレビューはあくまで見本。タップでの開閉はさせない
      }}>
        {mode === "grouped" ? (
          (() => {
            const map = new Map();
            for (const p of sorted) {
              if (!map.has(p.intensityKey)) map.set(p.intensityKey, []);
              map.get(p.intensityKey).push(p);
            }
            return [...map.entries()].map(([key, groupPoints], gi) => {
              const style = getIntensityStyleFromScheme(scheme, key);
              const prefs = [...new Set(groupPoints.map(p => p.pref))];
              return (
                <div key={key}>
                  {gi > 0 && <div style={{ height: 0.5, background: `rgba(${tokens.ink},0.08)` }}/>}
                  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px" }}>
                    <span style={{
                      flexShrink: 0, minWidth: 34, padding: "2px 0", borderRadius: 6,
                      background: style.bg, color: style.fg,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 11, fontWeight: 800,
                    }}>
                      {style.label}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: tokens.text }}>震度{style.label}</div>
                      <div style={{ fontSize: 13, color: `rgba(${tokens.ink},0.65)`, marginTop: 3, lineHeight: 1.6 }}>
                        {prefs.map((pref, pi) => (
                          <span key={pref} style={{ whiteSpace: "nowrap" }}>
                            {pref}{pi < prefs.length - 1 ? "、" : ""}
                          </span>
                        ))}
                      </div>
                    </div>
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none"
                         stroke={`rgba(${tokens.ink},0.3)`} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="9 6 15 12 9 18"/>
                    </svg>
                  </div>
                </div>
              );
            });
          })()
        ) : (
          sorted.map((p, i) => {
            const style = getIntensityStyleFromScheme(scheme, p.intensityKey);
            return (
              <div key={`${p.pref}-${p.addr}-${i}`}>
                {i > 0 && <div style={{ height: 0.5, background: `rgba(${tokens.ink},0.08)`, marginLeft: 12 }}/>}
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 12px" }}>
                  <span style={{
                    flexShrink: 0, minWidth: 34, padding: "2px 0", borderRadius: 6,
                    background: style.bg, color: style.fg,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 11, fontWeight: 800,
                  }}>
                    {style.label}
                  </span>
                  <span style={{ fontSize: 11, color: `rgba(${tokens.ink},0.4)`, flexShrink: 0 }}>
                    {p.pref}
                  </span>
                  <span style={{
                    flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: tokens.text,
                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                  }}>
                    {p.addr}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function StationListDisplayModeSettings({ value, onChange }) {
  const { tokens } = useContext(ThemeContext);

  const entries = Object.entries(STATION_LIST_DISPLAY_MODES);
  return (
    <>
      <SettingsCard>
        {entries.map(([id, mode], i) => {
          const selected = value === id;
          return (
            <div key={id}>
              {i > 0 && <SettingsCardDivider/>}
              <PressableButton
                onClick={() => onChange(id)}
                style={{
                  width: "100%", display: "flex", alignItems: "center", gap: 12,
                  padding: "11px 12px",
                  background: selected ? `rgba(${tokens.ink},0.07)` : "transparent",
                  border: "none", cursor: "pointer", textAlign: "left",
                }}
              >
                <span style={{ fontSize: 13, fontWeight: 600, color: tokens.text, flex: 1 }}>
                  {mode.label}
                </span>
                {selected && (
                  <span style={{ fontSize: 13, color: `rgba(${tokens.ink},0.85)` }}>✓</span>
                )}
              </PressableButton>
            </div>
          );
        })}
      </SettingsCard>
      <StationListDisplayModePreview mode={value}/>
    </>
  );
}

// リポジトリ直下のLICENSEファイル(MIT)を実行時に取得して、そのまま表示するカード。
// ビルド時に埋め込むのではなく、デプロイ先で公開されている実ファイルを毎回fetchすることで、
// LICENSEファイルの内容が変わっても表示側の修正なしに追従できるようにしている。
// 前提: Viteの public/ ディレクトリに LICENSE ファイルが置かれていること。
// (このプロジェクトは vite.config.ts を使っており、GitHub Pagesには
//  skotm.github.io/ewwt/ というサブパスで公開されている。publicディレクトリの
//  中身はビルド時にそのままそのサブパス配下にコピーされるため、リポジトリ直下に
//  置いただけのファイルはビルド成果物に含まれず配信されない。
//  import.meta.env.BASE_URL でサブパスを解決しているので、コード側での
//  対応はこれで済むが、LICENSEファイル自体を public/LICENSE にも
//  配置(またはコピー)しておく必要がある)
function LicenseFileCard() {
  const { tokens } = useContext(ThemeContext);

  const [state, setState] = useState({ status: "loading", text: "" });

  useEffect(() => {
    let cancelled = false;
    fetch(`${import.meta.env.BASE_URL}LICENSE`)
      .then(res => {
        if (!res.ok) throw new Error(`status ${res.status}`);
        return res.text();
      })
      .then(text => { if (!cancelled) setState({ status: "ready", text }); })
      .catch(err => {
        console.warn("LICENSEファイルを取得できませんでした:", err);
        if (!cancelled) setState({ status: "error", text: "" });
      });
    return () => { cancelled = true; };
  }, []);

  return (
    <SettingsCard>
      <div style={{ padding: "14px 14px", textAlign: "left" }}>
        {state.status === "loading" && (
          <div style={{ fontSize: 12, color: `rgba(${tokens.ink},0.4)` }}>読み込み中…</div>
        )}
        {state.status === "error" && (
          <div style={{ fontSize: 12, color: `rgba(${tokens.ink},0.4)` }}>
            LICENSEファイルを読み込めませんでした。
          </div>
        )}
        {state.status === "ready" && (
          <pre style={{
            margin: 0, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 11, lineHeight: 1.7, color: `rgba(${tokens.ink},0.65)`,
            whiteSpace: "pre-wrap", wordBreak: "break-word", textAlign: "left",
          }}>
            {state.text}
          </pre>
        )}
      </div>
    </SettingsCard>
  );
}

function SettingsBody({
  path, onNavigate, colorSchemeId, onChangeColorScheme,
  estIntensityEnabled, onChangeEstIntensityEnabled,
  areaFillEnabled, onChangeAreaFillEnabled,
  quakeFetchLimit, onChangeQuakeFetchLimit,
  stationListDisplayMode, onChangeStationListDisplayMode,
}) {
  // 「フローティングを不透明にする」トグル用。BottomDock経由でpropsを何段も
  // 通す代わりに、Appのトップレベルで配信しているcontextを直接購読する。
  const {
    opaque: glassOpaqueEnabled,
    suspectedBroken: glassOpaqueSuspectedBroken,
    setOverride: onChangeGlassOpaqueOverride,
  } = useContext(GlassOpaqueContext);

  // ライト/ダークモード切り替え用。同じくcontext経由で直接購読する。
  const { mode: themeMode, tokens, setMode: onChangeThemeMode } = useContext(ThemeContext);

  // トップメニュー(カテゴリ一覧)
  if (path.length === 0) {
    return (
      <>
        <SettingsHeader title="設定"/>
        <SettingsCard>
          {SETTINGS_MENU.map((item, i) => (
            <div key={item.id}>
              {i > 0 && <SettingsCardDivider/>}
              <SettingsMenuRow label={item.label} onClick={() => onNavigate([item.id])}/>
            </div>
          ))}
        </SettingsCard>
        <div style={{ padding: "10px 14px 20px", textAlign: "center", fontSize: 11, color: `rgba(${tokens.ink},0.3)` }}>
          Developed by skotm
          <br/>
          v{APP_VERSION}
        </div>
      </>
    );
  }

  const [category, leaf, sub] = path;
  const categoryLabel = SETTINGS_MENU.find(m => m.id === category)?.label || "";

  // 震度配色(地震カテゴリの項目)の中身
  if (category === "quake" && leaf === "colorScheme") {
    return (
      <>
        <SettingsHeader title="震度配色"/>
        <QuakeColorSchemeSettings colorSchemeId={colorSchemeId} onChangeColorScheme={onChangeColorScheme}/>
      </>
    );
  }

  // 地図塗りつぶし(地震カテゴリの項目)の中身。
  // 「細分区域を震度で塗りつぶす」「推計震度分布を表示」の2つのON/OFFをまとめる。
  if (category === "quake" && leaf === "mapFill") {
    return (
      <>
        <SettingsHeader title="地図塗りつぶし"/>
        <SettingsCard>
          <SettingsToggleRow
            label="細分区域を震度で塗りつぶす"
            description="観測点の震度をもとに、気象庁の細分区域単位で地図を塗り分けます。"
            checked={areaFillEnabled}
            onChange={() => onChangeAreaFillEnabled(!areaFillEnabled)}
          />
          <SettingsCardDivider/>
          <SettingsToggleRow
            label="推計震度分布を表示"
            description="震度5弱以上の地震選択時、気象庁の推計震度分布を地図に重ねて表示します。"
            checked={estIntensityEnabled}
            onChange={() => onChangeEstIntensityEnabled(!estIntensityEnabled)}
          />
        </SettingsCard>
      </>
    );
  }

  // 各地の震度リストの表示方法(地震カテゴリの項目)の中身
  if (category === "quake" && leaf === "stationListDisplay") {
    return (
      <>
        <SettingsHeader title="各地の震度の表示方法"/>
        <StationListDisplayModeSettings value={stationListDisplayMode} onChange={onChangeStationListDisplayMode}/>
      </>
    );
  }

  // 取得件数(地震カテゴリの項目)の中身
  if (category === "quake" && leaf === "fetchLimit") {
    return (
      <>
        <SettingsHeader title="取得件数"/>
        <QuakeFetchLimitSettings value={quakeFetchLimit} onChange={onChangeQuakeFetchLimit}/>
      </>
    );
  }

  // 地震カテゴリのトップ(震度配色・地図塗りつぶし・取得件数への入口)。
  // 他のカテゴリと違い項目を専用に組み立てているため、汎用のitems一覧ループとは別扱いにする。
  if (category === "quake" && !leaf) {
    return (
      <>
        <SettingsHeader title="地震"/>
        <SettingsCard>
          <SettingsMenuRow label="震度配色" onClick={() => onNavigate([...path, "colorScheme"])}/>
          <SettingsCardDivider/>
          <SettingsMenuRow label="地図塗りつぶし" onClick={() => onNavigate([...path, "mapFill"])}/>
          <SettingsCardDivider/>
          <SettingsMenuRow label="各地の震度の表示方法" onClick={() => onNavigate([...path, "stationListDisplay"])}/>
          <SettingsCardDivider/>
          <SettingsMenuRow label="取得件数" onClick={() => onNavigate([...path, "fetchLimit"])}/>
        </SettingsCard>
      </>
    );
  }

  // 外観(詳細設定カテゴリの項目)の中身。ライトモード/ダークモードの切り替え。
  // 初期設定はダーク。ここではUIチューム(背景・カード・文字色など)の
  // 基礎トークンだけを切り替えており、地図の基本配色や震度配色スキームは
  // 対象外(別途テーマ対応が必要)。
  if (category === "advanced" && leaf === "appearance") {
    return (
      <>
        <SettingsHeader title="外観"/>
        <SettingsCard>
          <SettingsToggleRow
            label="ライトモード"
            description="オフのときはダークモード(初期設定)です。"
            checked={themeMode === "light"}
            onChange={() => onChangeThemeMode(themeMode === "light" ? "dark" : "light")}
          />
        </SettingsCard>
      </>
    );
  }

  // フローティング関連(詳細設定カテゴリの項目)の中身。
  // Liquid Glassのぼかしを使わず、常に不透明な背景にするかどうかのトグル。
  // ぼかしが実効しない疑いがある環境(Windows ChromeでのANGLE Direct3D11絡みの
  // 既知の不具合など)では、自動判定により常にON固定・変更不可にしている。
  if (category === "advanced" && leaf === "floating") {
    return (
      <>
        <SettingsHeader title="フローティング関連"/>
        <SettingsCard>
          <SettingsToggleRow
            label="フローティングを不透明にする"
            description={
              glassOpaqueSuspectedBroken
                ? "この端末・ブラウザではぼかし効果が正しく表示されない可能性があるため、自動的に不透明表示に固定されています。"
                : "オンにすると、地図パネルなどの半透明・ぼかし表示をやめて、はっきり見える不透明な背景にします。"
            }
            checked={glassOpaqueEnabled}
            onChange={() => onChangeGlassOpaqueOverride(glassOpaqueEnabled ? "off" : "on")}
            disabled={glassOpaqueSuspectedBroken}
          />
        </SettingsCard>
      </>
    );
  }

  // ライセンス(詳細設定カテゴリの項目)の中身
  if (category === "advanced" && leaf === "license" && !sub) {
    return (
      <>
        <SettingsHeader title="ライセンス"/>
        <SettingsCard>
          <div style={{ padding: "14px 14px", fontSize: 12, color: `rgba(${tokens.ink},0.55)`, lineHeight: 1.8, textAlign: "left" }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: tokens.text, marginBottom: 4 }}>
              データ提供
            </div>
            気象庁 / 国土地理院 / Natural Earth / P2P地震情報
          </div>
          <SettingsCardDivider/>
          <div style={{ padding: "14px 14px", fontSize: 12, color: `rgba(${tokens.ink},0.55)`, lineHeight: 1.8, textAlign: "left" }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: tokens.text, marginBottom: 4 }}>
              オープンソースソフトウェア
            </div>
            React
          </div>
        </SettingsCard>
        <SettingsCard>
          <SettingsMenuRow label="MIT License 2026 skotm" onClick={() => onNavigate([...path, "mit"])}/>
        </SettingsCard>
      </>
    );
  }

  // MITライセンス本文(ライセンス項目のさらに下の階層)。新しくモーダルを作らず、
  // 他の設定画面と同じ「パネル内をその場で差し替える」ナビゲーションで表示する。
  if (category === "advanced" && leaf === "license" && sub === "mit") {
    return (
      <>
        <SettingsHeader title="MIT License 2026 skotm"/>
        <LicenseFileCard/>
      </>
    );
  }

  // カテゴリ内の項目一覧(地震カテゴリは上で処理済みのため、それ以外のカテゴリ用)
  const items = SETTINGS_ITEMS[category] || [];
  if (!leaf) {
    return (
      <>
        <SettingsHeader title={categoryLabel}/>
        {items.length > 0 ? (
          <SettingsCard>
            {items.map((item, i) => (
              <div key={item.id}>
                {i > 0 && <SettingsCardDivider/>}
                <SettingsMenuRow label={item.label} onClick={() => onNavigate([...path, item.id])}/>
              </div>
            ))}
          </SettingsCard>
        ) : (
          <div style={{ padding: "28px 18px", textAlign: "center", fontSize: 12, color: `rgba(${tokens.ink},0.4)` }}>
            現在、設定できる項目はありません
          </div>
        )}
      </>
    );
  }

  // 想定外のパス(念のためのフォールバック)
  return <SettingsHeader title={categoryLabel}/>;
}

/* ─────────────────────────────────────────────────────
   APP ROOT
   ───────────────────────────────────────────────────── */
export default function App() {
  const [activeNav, setActiveNav] = useState("quake");
  const [layers,    setLayers]    = useState(LAYERS);
  const [layerOpen, setLayerOpen] = useState(false);
  const [map,       setMap]       = useState(null);
  const isWide = useIsWideLayout(); // 横画面スマホ・タブレット・PCなどの広い画面かどうか
  const wideUIScale = useWideUIScale(isWide); // 横画面で画面が低い(=スマホ横持ち)場合の縮小率
  const isStandalonePwa = useIsStandalonePwa(); // ホーム画面に追加したPWAとして起動しているか

  // Liquid Glassのぼかしが実効しない(疑いがある)場合の不透明フォールバック。
  // "auto"時はWebGLレンダラー文字列からのヒューリスティック判定に従い、
  // 手動で "on"(常に不透明)/"off"(常にぼかし優先)にも上書きできる
  // (設定タブなどから handleChangeGlassOpaqueOverride を呼んで切り替える)。
  const [glassOpaqueOverride, setGlassOpaqueOverrideState] = useState(loadGlassOpaqueOverride);
  const [suspectedBackdropFilterBroken] = useState(detectSuspectedBackdropFilterBreakage);

  function handleChangeGlassOpaqueOverride(next) {
    // ぼかしが実効しない疑いがある場合、不透明のまま固定する
    // (設定画面のトグルはdisabled表示にしているが、念のためここでも二重に防ぐ)。
    if (suspectedBackdropFilterBroken) return;
    setGlassOpaqueOverrideState(next);
    saveGlassOpaqueOverride(next);
  }

  const glassOpaque =
    suspectedBackdropFilterBroken ? true : // ぼかしが効かない疑いがある場合は常に不透明固定
    glassOpaqueOverride === "on"  ? true  :
    glassOpaqueOverride === "off" ? false :
    false; // "auto" かつ疑いがない場合はぼかしを使う

  const glassOpaqueContextValue = useMemo(() => ({
    opaque: glassOpaque,
    override: glassOpaqueOverride,
    suspectedBroken: suspectedBackdropFilterBroken,
    setOverride: handleChangeGlassOpaqueOverride,
  }), [glassOpaque, glassOpaqueOverride, suspectedBackdropFilterBroken, handleChangeGlassOpaqueOverride]);

  // ライト/ダークモード。設定タブの「詳細設定」→「外観」から切り替える。
  // 初期設定はダーク。選択はlocalStorageに保存し、次回起動時も復元する。
  const [themeMode, setThemeModeState] = useState(loadStoredThemeMode); // "dark" | "light"

  function handleChangeThemeMode(next) {
    setThemeModeState(next);
    saveThemeMode(next);
  }

  const themeContextValue = useMemo(() => ({
    mode: themeMode,
    tokens: THEME_TOKENS[themeMode],
    setMode: handleChangeThemeMode,
  }), [themeMode]);

  // App自身はThemeContext.Providerを作る側なので、自分に対してはuseContextせず
  // 計算済みのthemeContextValueから直接参照する。
  const tokens = themeContextValue.tokens;

  // 震度配色。設定タブの「地震」→「震度配色」から切り替える。
  // 選択したスキームはlocalStorageに保存し、次回起動時も復元する。
  const [quakeColorScheme, setQuakeColorScheme] = useState(loadStoredQuakeColorScheme); // "legacy" | "jma" | "fill"

  function handleChangeQuakeColorScheme(schemeId) {
    setQuakeColorScheme(schemeId);
    saveQuakeColorScheme(schemeId);
  }

  // 推計震度分布の表示ON/OFF。地図レイヤーパネルの「推計震度分布」トグルと
  // 設定タブ「地震」内のトグルの、両方から操作できる単一の状態(localStorageに永続化)。
  const [estIntensityEnabled, setEstIntensityEnabledState] = useState(loadStoredEstIntensityEnabled);

  function handleChangeEstIntensityEnabled(next) {
    setEstIntensityEnabledState(next);
    saveEstIntensityEnabled(next);
  }

  // 細分区域を震度の色で塗りつぶすかどうか。推計震度分布と同じく設定タブで操作し、localStorageに永続化する。
  const [areaFillEnabled, setAreaFillEnabledState] = useState(loadStoredAreaFillEnabled);

  function handleChangeAreaFillEnabled(next) {
    setAreaFillEnabledState(next);
    saveAreaFillEnabled(next);
  }

  // 震度観測点リスト(各地の震度)の表示方法。"grouped"(階層表示、既定) | "list"(一覧表示)。
  // 設定タブ「地震」内から切り替え、localStorageに永続化する。
  const [stationListDisplayMode, setStationListDisplayModeState] = useState(loadStoredStationListDisplayMode);

  function handleChangeStationListDisplayMode(next) {
    setStationListDisplayModeState(next);
    saveStationListDisplayMode(next);
  }

  // 地震一覧の取得件数(1〜1000、デフォルト100)。設定タブで変更すると一覧を取り直す。
  const [quakeFetchLimit, setQuakeFetchLimitState] = useState(loadStoredQuakeFetchLimit);

  function handleChangeQuakeFetchLimit(next) {
    const clamped = clampQuakeFetchLimit(next);
    setQuakeFetchLimitState(clamped);
    saveQuakeFetchLimit(clamped);
  }

  // 地震情報(P2P地震情報API)
  const [quakes,          setQuakes]          = useState([]);
  const [quakeStatus,     setQuakeStatus]     = useState("loading"); // loading | ready | error
  const [selectedQuakeId, setSelectedQuakeId] = useState(null);
  // WebSocketのイベントハンドラ(古いクロージャのまま生き続ける)から常に最新の
  // selectedQuakeIdを参照できるようにするためのref。
  const selectedQuakeIdRef = useRef(null);
  useEffect(() => { selectedQuakeIdRef.current = selectedQuakeId; }, [selectedQuakeId]);

  // 観測点マスタ(緯度経度付き)。points[]との突き合わせに使う。
  const [stations, setStations] = useState(null);

  // 気象庁 震度データベース(eqdb)検索で開いた地震。直近一覧(quakes)には混ぜず、
  // ここだけで別管理する(P2P地震情報のWebSocket更新・件数上限に巻き込まれないようにするため)。
  const [searchQuake, setSearchQuake] = useState(null);

  const toggleLayer = id => {
    // 「推計震度分布」レイヤーだけは、layers配列ではなく設定と共有のestIntensityEnabled側で管理する
    if (id === "estIntensity") {
      handleChangeEstIntensityEnabled(!estIntensityEnabled);
      return;
    }
    setLayers(prev => prev.map(l => l.id === id ? { ...l, on: !l.on } : l));
  };

  // レイヤーパネルに渡す一覧。「推計震度分布」の見た目上のon/offは、layers配列の
  // 初期値ではなく、常にestIntensityEnabled(設定と共有・永続化されている値)を反映させる。
  const layersForPanel = useMemo(
    () => layers.map(l => l.id === "estIntensity" ? { ...l, on: estIntensityEnabled } : l),
    [layers, estIntensityEnabled]
  );

  // 観測点マスタは全地震で共通なので、起動時に一度だけ取得する
  useEffect(() => {
    let cancelled = false;
    loadStations()
      .then(list => { if (!cancelled) setStations(list); })
      .catch(err => console.error("観測点マスタの取得に失敗:", err));
    return () => { cancelled = true; };
  }, []);

  // 選択中の地震 + 観測点マスタが揃ったら、観測点ごとの震度に緯度経度を割り当てる。
  // 気象庁 震度データベース検索から開いた地震(searchQuake)は quakes には入っていないため、
  // そちらも見つからなかった場合のフォールバックとして探す。
  const selectedQuake = quakes.find(q => q.id === selectedQuakeId)
    || (searchQuake && searchQuake.id === selectedQuakeId ? searchQuake : null);
  const selectedQuakePoints = useMemo(() => {
    if (!selectedQuake) return [];
    // eqdb由来の地震は、観測点の緯度経度を自前で解決済み(resolvedPoints)なのでそのまま使う。
    if (selectedQuake.resolvedPoints) return selectedQuake.resolvedPoints;
    if (!stations) return [];
    return resolveStationPoints(selectedQuake.points, stations);
  }, [selectedQuake, stations]);

  // 震源(バツ印表示・ズーム用)。複数震源(eqdbのhypocenters)があればその全件、
  // 無ければ従来通り単一のlatitude/longitudeを1件だけの配列にして使う。
  // 緯度経度が無い地震(震源不明)では空配列のまま。
  const selectedHypocenters = useMemo(() => {
    if (!selectedQuake) return [];
    if (Array.isArray(selectedQuake.hypocenters) && selectedQuake.hypocenters.length > 0) {
      return selectedQuake.hypocenters;
    }
    if (selectedQuake.latitude == null || selectedQuake.longitude == null) return [];
    return [{ latitude: selectedQuake.latitude, longitude: selectedQuake.longitude }];
  }, [selectedQuake]);

  // 起動時に /history で最新一覧を1回だけ取得し、以降はWebSocketで新着分を随時追加する。
  // quakeFetchLimit(設定タブで変更可能)が変わった場合も、この効果全体をやり直して
  // 新しい件数で一覧を取得し直す。
  const [wsStatus, setWsStatus] = useState("connecting"); // connecting | open | closed
  useEffect(() => {
    let cancelled = false;

    fetchRecentQuakes(quakeFetchLimit)
      .then(list => {
        if (cancelled) return;
        setQuakes(prev => {
          // /historyの完了より先にWebSocketで新着が届いていた場合、
          // ここで単純に上書き(setQuakes(list))してしまうと、
          // 「WebSocketで先に届いて選択していた地震」が/historyの
          // レスポンスにまだ反映されていない(配信の遅延)ことがあり、
          // 選択中の地震ごと一覧から消えてしまうことがあった。
          // → prev(それまでの一覧、WebSocket分を含む)とlist(/history)を
          //   idで統合し、どちらか一方にしか無い分もすべて残す。
          const byId = new Map();
          for (const q of list) byId.set(q.id, q);
          for (const q of prev) if (!byId.has(q.id)) byId.set(q.id, q);
          const merged = Array.from(byId.values())
            .sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0))
            .slice(0, quakeFetchLimit);
          const result = dedupeQuakeList(merged);

          // 選択中の地震が、統合後もなお一覧に存在しない場合だけ選択解除する。
          // ただし気象庁 震度データベース検索由来(id が "eqdb_" 始まり)の地震は
          // そもそもこの一覧(P2P地震情報)には入らないため、対象外にする。
          const selId = selectedQuakeIdRef.current;
          if (selId != null && !String(selId).startsWith("eqdb_") && !result.some(q => q.id === selId)) {
            setSelectedQuakeId(null);
          }

          return result;
        });
        setQuakeStatus("ready");
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
          // 選択中の地震(あれば)を、差し替え前に控えておく。
          // dedupeQuakeList等で「同じ地震の新しいレコード」に統合された場合、
          // 選択状態をそちらへ引き継ぐために使う。
          const prevSelected = prev.find(q => q.id === selectedQuakeIdRef.current) || null;

          // 同一idの重複配信を除外しつつ、新着を先頭に追加する。
          // 件数は/historyの初期取得と揃えて設定値(quakeFetchLimit)までに抑える。
          const deduped = prev.filter(q => q.id !== newQuake.id);
          const merged = [newQuake, ...deduped].slice(0, quakeFetchLimit);
          // 同じ地震の「震度を持つレコード」と「震源だけの空レコード」が
          // 別々に届くことがあるため、都度まとめて重複排除しておく。
          const result = dedupeQuakeList(merged);

          // 選択中だった地震が、上記の処理で一覧から消えていないか確認する。
          // 消えていて、かつ「同じ発生時刻+震源地」の後継レコードが
          // 残っている場合は、そちらに選択状態を引き継ぐ(カード表示が
          // 突然一覧表示に戻ってしまう・戻るボタンだけ残る、といった
          // ズレを防ぐため)。完全に消えた(後継も無い)場合は選択解除する。
          // (M・深さは後から修正されることがあるため、一致条件には含めない)
          if (prevSelected && !result.some(q => q.id === prevSelected.id)) {
            const successor = result.find(q =>
              q.time === prevSelected.time &&
              q.place === prevSelected.place
            );
            setSelectedQuakeId(successor ? successor.id : null);
          }

          return result;
        });
        setQuakeStatus("ready");
      },
      (status) => { if (!cancelled) setWsStatus(status); }
    );

    return () => { cancelled = true; socket.close(); };
  }, [quakeFetchLimit]);

  return (
    <ThemeContext.Provider value={themeContextValue}>
    <GlassOpaqueContext.Provider value={glassOpaqueContextValue}>
    <QuakeColorSchemeContext.Provider value={quakeColorScheme}>
      <GlobalStyles tokens={themeContextValue.tokens}/>
      <Filters/>

      <div style={{ height: "100%", position: "relative", overflow: "hidden", background: themeContextValue.tokens.pageBg }}>

        {/* ── Layer 1: 地図（Liquid Glassが透かす背景） ── */}
        <MapCanvas
          onReady={setMap}
          stationPoints={selectedQuakePoints}
          hypocenters={selectedHypocenters}
          isWide={isWide}
          quakeTimeStr={selectedQuake?.time}
          maxIntensityKey={selectedQuake?.maxIntensity}
          estIntensityEnabled={estIntensityEnabled}
          areaFillEnabled={areaFillEnabled}
        />

        {/* 震度凡例 — 地震を選択している間だけ、画面右上に縦並びで浮かぶ */}
        {activeNav === "quake" && selectedQuake && (
          <div style={{
            position: "absolute",
            top: "calc(16px + env(safe-area-inset-top))",
            right: 16,
            zIndex: 30,
          }}>
            <QuakeIntensityLegend maxIntensity={selectedQuake.maxIntensity} legacyIntensityScale={selectedQuake.legacyIntensityScale}/>
          </div>
        )}

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
            ナビバーの内側からパネルが伸びて生まれてくるように見せる。
            広い画面(isWide)では、SideNavRail(タブ列)とBottomDockの中身を
            1つの共有Glassの中に並べて描画し、継ぎ目の無い1枚のガラスに
            見せる(BottomDock自身はisWideの時、自前のGlassを持たず透明な
            中身だけを返す)。 */}
        <div style={isWide ? {
          position: "fixed",
          left: 12, top: 16, bottom: 16,
          zIndex: 40,
        } : {
          position: "absolute",
          bottom: isStandalonePwa
            ? "calc(env(safe-area-inset-bottom) - 10px)"
            : "calc(env(safe-area-inset-bottom) + 10px)",
          left: 0, right: 0,
          display: "flex", justifyContent: "center", alignItems: "flex-end",
          zIndex: 40, padding: "0 16px",
        }}>
          {isWide ? (
              <div style={{ height: "100%", animation: "appear 0.4s cubic-bezier(.25,1,.5,1) 0.1s both" }}>
                <Glass radius={28} style={{ height: "100%" }}>
                  <div style={{ display: "flex", alignItems: "stretch", height: "100%" }}>
                    <div style={{ width: WIDE_RAIL_WIDTH, flexShrink: 0, position: "relative" }}>
                      <SideNavRail active={activeNav} onNav={setActiveNav} uiScale={wideUIScale}/>
                    </div>
                    <div style={{ width: 1, alignSelf: "stretch", background: `rgba(${tokens.ink},0.14)` }}/>
                    <BottomDock
                      active={activeNav}
                      onNav={setActiveNav}
                      layerOpen={layerOpen}
                      layers={layersForPanel}
                      onToggleLayer={toggleLayer}
                      onLayerOpenChange={setLayerOpen}
                      uiScale={wideUIScale}
                      quakes={quakes}
                  quakeStatus={quakeStatus}
                  selectedQuakeId={selectedQuakeId}
                  onSelectQuake={setSelectedQuakeId}
                  stationPoints={selectedQuakePoints}
                  onChangeQuakeColorScheme={handleChangeQuakeColorScheme}
                  estIntensityEnabled={estIntensityEnabled}
                  onChangeEstIntensityEnabled={handleChangeEstIntensityEnabled}
                  areaFillEnabled={areaFillEnabled}
                  onChangeAreaFillEnabled={handleChangeAreaFillEnabled}
                  quakeFetchLimit={quakeFetchLimit}
                  onChangeQuakeFetchLimit={handleChangeQuakeFetchLimit}
                  stationListDisplayMode={stationListDisplayMode}
                  onChangeStationListDisplayMode={handleChangeStationListDisplayMode}
                  stations={stations}
                  searchQuake={searchQuake}
                  onFoundSearchQuake={setSearchQuake}
                />
              </div>
            </Glass>
              </div>
          ) : (
            <BottomDock
              active={activeNav}
              onNav={setActiveNav}
              layerOpen={layerOpen}
              layers={layersForPanel}
              onToggleLayer={toggleLayer}
              onLayerOpenChange={setLayerOpen}
              quakes={quakes}
              quakeStatus={quakeStatus}
              selectedQuakeId={selectedQuakeId}
              onSelectQuake={setSelectedQuakeId}
              stationPoints={selectedQuakePoints}
              onChangeQuakeColorScheme={handleChangeQuakeColorScheme}
              estIntensityEnabled={estIntensityEnabled}
              onChangeEstIntensityEnabled={handleChangeEstIntensityEnabled}
              areaFillEnabled={areaFillEnabled}
              onChangeAreaFillEnabled={handleChangeAreaFillEnabled}
              quakeFetchLimit={quakeFetchLimit}
              onChangeQuakeFetchLimit={handleChangeQuakeFetchLimit}
              stationListDisplayMode={stationListDisplayMode}
              onChangeStationListDisplayMode={handleChangeStationListDisplayMode}
              stations={stations}
              searchQuake={searchQuake}
              onFoundSearchQuake={setSearchQuake}
            />
          )}
        </div>

      </div>
    </QuakeColorSchemeContext.Provider>
    </GlassOpaqueContext.Provider>
    </ThemeContext.Provider>
  );
}
