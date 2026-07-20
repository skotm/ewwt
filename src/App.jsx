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
const APP_VERSION = "1.2.0b";

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
   断層(faults.geojson)・プレート境界(plate-boundaries.json)データ。
   いずれも数MB規模のファイルのため、world.json等とは違いアプリ起動時には
   読み込まず、設定でトグルが最初にONにされたタイミングで遅延読み込みする
   (loadGeoDataと同様、一度取得したPromiseはキャッシュして使い回す)。
   ファイル構成:
     public/
     └─ map/
        ├─ faults.geojson
        └─ plate-boundaries.json
   ───────────────────────────────────────────────────── */
let faultsDataPromise = null;
function loadFaultsData() {
  if (faultsDataPromise) return faultsDataPromise;
  faultsDataPromise = cachedFetchJSON(`${import.meta.env.BASE_URL}map/faults.geojson`);
  return faultsDataPromise;
}

let plateBoundariesDataPromise = null;
function loadPlateBoundariesData() {
  if (plateBoundariesDataPromise) return plateBoundariesDataPromise;
  plateBoundariesDataPromise = cachedFetchJSON(`${import.meta.env.BASE_URL}map/plate-boundaries.json`);
  return plateBoundariesDataPromise;
}

// 津波予報区(海岸線)データ。津波情報の詳細を開いた時だけ、対象の予報区を
// 塗り分けるために遅延読み込みする(断層・プレート境界と同じ理由・同じ方式)。
// ファイル: public/map/tsunami-areas.json
let tsunamiAreasDataPromise = null;
function loadTsunamiAreasData() {
  if (tsunamiAreasDataPromise) return tsunamiAreasDataPromise;
  tsunamiAreasDataPromise = cachedFetchJSON(`${import.meta.env.BASE_URL}map/tsunami-areas.json`);
  return tsunamiAreasDataPromise;
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
  faultsEnabled, plateBoundariesEnabled, boundaryLineColorId,
  epicenterPoints = [], onSelectEpicenterPoint,
  pointsLoading = false, epicenterLoading = false,
  tsunamiAreas = [],
  stationMarkersVisible = true,
  tideStationPoints = [], onSelectTideStation, selectedTideStationCode,
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const [status, setStatus] = useState("loading"); // loading | ready | error
  const [errorMsg, setErrorMsg] = useState("");
  // 現在選択中の震度配色スキーム。観測点マーカー・震度分布の塗り分けの両方で使う。
  const colorSchemeId = useContext(QuakeColorSchemeContext);
  const colorScheme = QUAKE_COLOR_SCHEMES[colorSchemeId] || QUAKE_COLOR_SCHEMES.fill;
  // 震央分布(circleレイヤー)は map.on("load") 内(初回マウント時のみ実行)で
  // 作るため、生成時点の最新配色をrefで参照できるようにしておく
  // (切り替え時の反映は別のuseEffectでsetPaintPropertyする。下方)。
  const colorSchemeRef = useRef(colorScheme);
  colorSchemeRef.current = colorScheme;

  // 震央分布の丸をホバー/タッチした時に出す簡易ツールチップ。
  // { x, y, title, text } | null。x,yは地図コンテナ基準のスクリーン座標
  // (MapLibreのe.pointがそのままその座標系なので、変換不要で使える)。
  const [epicenterTooltip, setEpicenterTooltip] = useState(null);

  // 震央分布の丸をタップした時に呼ぶ選択コールバック。
  // map.on("load")内の登録は初回マウント時の1回きりなので、refで最新の
  // 関数を参照できるようにしておく。
  const onSelectEpicenterPointRef = useRef(onSelectEpicenterPoint);
  onSelectEpicenterPointRef.current = onSelectEpicenterPoint;
  const onSelectTideStationRef = useRef(onSelectTideStation);
  onSelectTideStationRef.current = onSelectTideStation;
  // 地図の基本配色(海・陸・都道府県境界線)。ライト/ダークモードで切り替える。
  const { tokens: themeTokens, mode } = useContext(ThemeContext);
  const tokens = themeTokens; // 下方で自動変換されたtokens.*参照のためのエイリアス
  // マップ生成(下のuseEffect本体)は[]依存で一度きりしか走らないため、
  // 生成時点の最新トークンをrefで参照する。切り替え時の反映は
  // 別のuseEffectでsetPaintPropertyして行う(下方)。
  const themeTokensRef = useRef(themeTokens);
  themeTokensRef.current = themeTokens;
  // 震央分布の縁取り色(震度1・気象庁配色のみライトモードで黒にする)の判定に、
  // 生成時点のライト/ダーク状態も同様にrefで参照できるようにしておく。
  const modeRef = useRef(mode);
  modeRef.current = mode;

  // 断層・プレート境界の「枠内の色」の現在値をrefでも持っておき、
  // map.on("load")内(初回マウント時のみ実行)で最新の選択値を読めるようにする。
  const boundaryLineColorIdRef = useRef(boundaryLineColorId);
  boundaryLineColorIdRef.current = boundaryLineColorId;

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

          // プレート境界(plate-boundaries.json)・断層(faults.geojson)レイヤー。
          // いずれも数MB規模のファイルのため、初期状態では空のFeatureCollectionだけ
          // 登録しておき、実データは対応するトグルが最初にONにされた時点で
          // 遅延読み込みする(下方の専用useEffectでsetDataにより差し替える)。
          // トグルOFF時はvisibility:noneで非表示にするだけでレイヤー自体は
          // 削除しない(再ON時に読み込み直さずに済むようにするため)。
          // beforeIdに"station-points-symbol"を指定し、観測点マーカーより
          // 必ず下に来るようにする。
          //
          // 配色はプレート境界・断層とも、種別ごとの派手な色分けはせず、
          // 「縁取り(halo)は共通の固定グレー」「枠内の色(core)はユーザーが
          // 設定で選べる」という組み合わせにする。
          // ・縁取り(halo)はライト/ダーク共通の固定色(BOUNDARY_HALO_COLOR)。
          //   どちらのテーマでも海・陸に対して十分なコントラストが出る
          //   中間グレーを採用している。
          // ・枠内の色(core)は設定(BOUNDARY_LINE_COLORS)から選んだ色を使う。
          // ・どちらも、あえて半透明(rgba)にせず不透明の実色にしている。
          //   半透明にすると、線同士が交差・分岐する箇所(断層の枝分かれ・
          //   プレート境界同士の交点など)でアルファが重なって不自然に濃く
          //   見えてしまうため、それを避けるため。
          // 「線の先端を丸く」という見た目のため、太めのハローレイヤーを下に敷き、
          // その上に細めの中の線を重ねる「ケースドライン」の手法を使う
          // (halo→mainの順にaddLayerすることで、両方ともstation-points-symbolの
          // 直下・halo→mainの順で正しく積み重なる)。
          const boundaryLineLayout = { visibility: "none", "line-cap": "round", "line-join": "round" };
          const boundaryHaloWidth = ["interpolate", ["linear"], ["zoom"], 4, 2.2, 8, 3.6, 12, 5.2];
          const boundaryLineWidth = ["interpolate", ["linear"], ["zoom"], 4, 1.0, 8, 1.6, 12, 2.2];
          const initHalo = getBoundaryHaloColor(boundaryLineColorIdRef.current);
          const initCore = (BOUNDARY_LINE_COLORS[boundaryLineColorIdRef.current] || BOUNDARY_LINE_COLORS.gray).color;

          map.addSource("plate-boundaries", {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          });
          map.addLayer({
            id: "plate-boundaries-halo-layer",
            type: "line",
            source: "plate-boundaries",
            layout: boundaryLineLayout,
            paint: { "line-color": initHalo, "line-width": boundaryHaloWidth },
          }, "station-points-symbol");
          map.addLayer({
            id: "plate-boundaries-layer",
            type: "line",
            source: "plate-boundaries",
            layout: boundaryLineLayout,
            paint: { "line-color": initCore, "line-width": boundaryLineWidth },
          }, "station-points-symbol");

          map.addSource("faults", {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          });
          map.addLayer({
            id: "faults-halo-layer",
            type: "line",
            source: "faults",
            layout: boundaryLineLayout,
            paint: { "line-color": initHalo, "line-width": boundaryHaloWidth },
          }, "station-points-symbol");
          map.addLayer({
            id: "faults-layer",
            type: "line",
            source: "faults",
            layout: boundaryLineLayout,
            paint: { "line-color": initCore, "line-width": boundaryLineWidth },
          }, "station-points-symbol");

          // 津波予報区(海岸線)。津波情報の詳細を開いた時だけ、対象の予報区を
          // grade(危険度)の色で塗る。データ自体は遅延読み込みのため、
          // ここでは空のソースだけ用意しておく(下方のuseEffect参照)。
          map.addSource("tsunami-areas", {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          });
          map.addLayer({
            id: "tsunami-areas-layer",
            type: "line",
            source: "tsunami-areas",
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": "rgba(0,0,0,0)",
              "line-width": 4.5,
            },
          }, "station-points-symbol");

          // 震央分布(P2P地震一覧・近傍地震検索・データベース検索の結果を、
          // 震度配色の丸として地図上に重ねて表示する)。
          // 独自のcanvasレイヤーではなくMapLibre標準のcircleレイヤーにすることで、
          // map.on('click'/'mousemove', layerId, ...)によるタップ選択・
          // ホバー/タッチ時のツールチップ表示がそのまま使える。
          // beforeIdを指定していないため、ここまでに作った他のレイヤー
          // (観測点・断層・プレート境界など)より上に、かつこの後に作る
          // hypocenter-point-symbol(選択中の地震の×印)より下に積み重なる。
          map.addSource("epicenter-points", {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          });
          map.addLayer({
            id: "epicenter-points-layer",
            type: "circle",
            source: "epicenter-points",
            paint: {
              // 参考にしたLeaflet版(circleMarker)と同じ考え方で、マグニチュードに
              // 応じた固定ピクセル半径にする(ズームで拡大縮小しない)。
              "circle-radius": ["max", ["*", ["coalesce", ["get", "mag"], 4], 2.2], 5],
              "circle-color": buildEpicenterCircleColorExpr(colorSchemeRef.current),
              "circle-opacity": 0.45,
              "circle-stroke-color": buildEpicenterCircleStrokeColorExpr(colorSchemeRef.current, modeRef.current),
              "circle-stroke-width": 1.4,
              "circle-stroke-opacity": 0.95,
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

          // 潮位観測点のピン。津波タブの「潮位計」モードでだけデータが入る
          // (tideStationPointsが空の間は何も描かれない)。
          map.addSource("tide-station-points", {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          });
          map.addLayer({
            id: "tide-station-points-layer",
            type: "circle",
            source: "tide-station-points",
            paint: {
              "circle-radius": [
                "interpolate", ["linear"], ["zoom"],
                4,  ["case", ["get", "selected"], 7, 4.5],
                8,  ["case", ["get", "selected"], 8, 5.5],
                12, ["case", ["get", "selected"], 11, 7],
                16, ["case", ["get", "selected"], 15, 9.5],
              ],
              "circle-color": [
                "case",
                ["get", "selected"], "#FF9F0A",
                ["match", ["get", "grade"],
                  "MajorWarning", "#BF5AF2",
                  "Warning", "#FF453A",
                  "Watch", "#FFD60A",
                  "NonEffective", "#64D2FF",
                  "#30D5C8",
                ],
              ],
              "circle-stroke-width": ["case", ["get", "selected"], 2.5, 1.5],
              "circle-stroke-color": "#ffffff",
            },
          });
          map.on("mouseenter", "tide-station-points-layer", () => {
            map.getCanvas().style.cursor = "pointer";
          });
          map.on("mouseleave", "tide-station-points-layer", () => {
            map.getCanvas().style.cursor = "";
          });
          map.on("click", "tide-station-points-layer", (e) => {
            if (!e.features || !e.features.length) return;
            onSelectTideStationRef.current?.(e.features[0].properties.code);
          });

          // 震央分布の丸のタップ選択・ホバー/タッチ時のツールチップ表示。
          map.on("mouseenter", "epicenter-points-layer", () => {
            map.getCanvas().style.cursor = "pointer";
          });
          map.on("mouseleave", "epicenter-points-layer", () => {
            map.getCanvas().style.cursor = "";
            setEpicenterTooltip(null);
          });
          map.on("mousemove", "epicenter-points-layer", (e) => {
            if (!e.features || !e.features.length) return;
            const p = e.features[0].properties || {};
            const magNum = Number(p.mag);
            const magText = Number.isFinite(magNum) && magNum > 0 ? `M${magNum.toFixed(1)}` : "M不明";
            const depthNum = Number(p.depth);
            const depthText = depthNum === 0 ? "ごく浅い" : (Number.isFinite(depthNum) && depthNum > 0 ? `${depthNum}km` : "深さ不明");
            setEpicenterTooltip({
              x: e.point.x,
              y: e.point.y,
              title: p.place || "震源地不明",
              text: `${p.time || ""}　${magText}　深さ${depthText}`,
            });
          });
          map.on("click", "epicenter-points-layer", (e) => {
            if (!e.features || !e.features.length) return;
            setEpicenterTooltip(null);
            onSelectEpicenterPointRef.current?.(e.features[0].properties.id);
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

    const features = stationMarkersVisible
      ? (stationPoints || [])
          .filter(p => p.latitude != null && p.longitude != null)
          .map(p => ({
            type: "Feature",
            geometry: { type: "Point", coordinates: [p.longitude, p.latitude] },
            properties: {
              intensityKey: STATION_ICON_KEYS.includes(p.intensityKey) ? p.intensityKey : "0",
              sortOrder: STATION_ICON_KEYS.indexOf(p.intensityKey),
            },
          }))
      : [];
    source.setData({ type: "FeatureCollection", features });
  }, [stationPoints, status, stationMarkersVisible]);

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

  // 断層(faults.geojson)の表示ON/OFF。トグルがONになった最初の1回だけ
  // 実データ(数MB)を取得してsetDataで流し込み、以降のON/OFF切り替えは
  // レイヤーのvisibilityを変えるだけ(再取得しない)にすることで、
  // OFFのままなら通信自体が発生しないようにしている。
  const faultsLoadedRef = useRef(false);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    if (!map.getLayer("faults-layer")) return;

    const v = faultsEnabled ? "visible" : "none";
    map.setLayoutProperty("faults-halo-layer", "visibility", v);
    map.setLayoutProperty("faults-layer", "visibility", v);

    if (faultsEnabled && !faultsLoadedRef.current) {
      faultsLoadedRef.current = true;
      loadFaultsData()
        .then((geojson) => {
          const source = map.getSource("faults");
          if (source) source.setData(geojson);
        })
        .catch((err) => {
          console.error("断層データの読み込みに失敗しました:", err);
          faultsLoadedRef.current = false; // 失敗時は次回ONで再試行できるようにする
        });
    }
  }, [faultsEnabled, status]);

  // プレート境界(plate-boundaries.json)の表示ON/OFF。断層と同様の遅延読み込み。
  const plateBoundariesLoadedRef = useRef(false);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    if (!map.getLayer("plate-boundaries-layer")) return;

    const v = plateBoundariesEnabled ? "visible" : "none";
    map.setLayoutProperty("plate-boundaries-halo-layer", "visibility", v);
    map.setLayoutProperty("plate-boundaries-layer", "visibility", v);

    if (plateBoundariesEnabled && !plateBoundariesLoadedRef.current) {
      plateBoundariesLoadedRef.current = true;
      loadPlateBoundariesData()
        .then((geojson) => {
          const source = map.getSource("plate-boundaries");
          if (source) source.setData(geojson);
        })
        .catch((err) => {
          console.error("プレート境界データの読み込みに失敗しました:", err);
          plateBoundariesLoadedRef.current = false; // 失敗時は次回ONで再試行できるようにする
        });
    }
  }, [plateBoundariesEnabled, status]);

  // 津波予報区(海岸線)。断層・プレート境界と同じ遅延読み込みだが、こちらは
  // 設定トグルではなく「表示すべき予報区(tsunamiAreas)が1件以上ある」ことが
  // トリガーになる(=津波タブで津波情報の詳細を開いた時だけ実データを取得する)。
  const tsunamiAreasLoadedRef = useRef(false);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    if (!map.getLayer("tsunami-areas-layer")) return;

    map.setPaintProperty("tsunami-areas-layer", "line-color", buildTsunamiAreaColorExpr(tsunamiAreas));

    if (tsunamiAreas.length > 0 && !tsunamiAreasLoadedRef.current) {
      tsunamiAreasLoadedRef.current = true;
      loadTsunamiAreasData()
        .then((geojson) => {
          const source = map.getSource("tsunami-areas");
          if (source) source.setData(geojson);
        })
        .catch((err) => {
          console.error("津波予報区データの読み込みに失敗しました:", err);
          tsunamiAreasLoadedRef.current = false; // 失敗時は次回表示対象が出た時に再試行できるようにする
        });
    }
  }, [tsunamiAreas, status]);

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

  // 断層・プレート境界の「枠内の色」を、設定で選んだ色に合わせて塗り替える。
  // 縁取り(halo)は基本的にライト/ダーク・設定を問わず固定色だが、
  // 枠内の色が「グレー」の時だけ白にして、芯とのコントラストを保つ。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    const core = (BOUNDARY_LINE_COLORS[boundaryLineColorId] || BOUNDARY_LINE_COLORS.gray).color;
    const halo = getBoundaryHaloColor(boundaryLineColorId);
    if (map.getLayer("plate-boundaries-layer")) {
      map.setPaintProperty("plate-boundaries-layer", "line-color", core);
      map.setPaintProperty("plate-boundaries-halo-layer", "line-color", halo);
    }
    if (map.getLayer("faults-layer")) {
      map.setPaintProperty("faults-layer", "line-color", core);
      map.setPaintProperty("faults-halo-layer", "line-color", halo);
    }
  }, [boundaryLineColorId, status]);

  // 震央分布(P2P地震一覧・近傍地震検索・データベース検索)のデータを反映する。
  // 呼び出し元(App/BottomDock)側で、今どの一覧を表示中かに応じて渡す点の
  // 配列を切り替えているので、ここでは受け取った配列をGeoJSON化するだけ。
  // MapLibreのcircleレイヤーには「z-index」に相当するものが無く、重なった時の
  // 上下関係はソースの配列順(後ろにあるものほど上)がそのまま描画順になるため、
  // 最大震度が大きいものほど後ろに来るよう昇順にソートしてから渡す。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    const source = map.getSource("epicenter-points");
    if (!source) return;
    const sortedPoints = [...(epicenterPoints || [])].sort((a, b) => {
      const ra = QUAKE_INTENSITY_RANK[a.maxIntensityKey] ?? -1;
      const rb = QUAKE_INTENSITY_RANK[b.maxIntensityKey] ?? -1;
      return ra - rb;
    });
    const features = sortedPoints
      .filter(p => Number.isFinite(p.latitude) && Number.isFinite(p.longitude))
      .map(p => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [p.longitude, p.latitude] },
        properties: {
          id: p.id,
          mag: p.magnitude,
          depth: p.depth,
          scaleKey: p.maxIntensityKey,
          time: p.time,
          place: p.place,
        },
      }));
    source.setData({ type: "FeatureCollection", features });
  }, [epicenterPoints, status]);

  // 潮位観測点ピンの更新。tideStationPointsが空の間(潮位計モードでない間)は
  // 何も表示されない。選択中の地点は"selected"プロパティを立てて、レイヤー側の
  // data-drivenなpaint式で強調表示させるのに加え、配列の最後に置くことで
  // (MapLibreは描画順=配列順のため)他のピンより必ず前面に来るようにする。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    const source = map.getSource("tide-station-points");
    if (!source) return;
    const points = [...(tideStationPoints || [])].sort((a, b) => {
      const aSel = a.code === selectedTideStationCode ? 1 : 0;
      const bSel = b.code === selectedTideStationCode ? 1 : 0;
      return aSel - bSel; // 選択中のものが最後(=最前面)に来るよう昇順ソート
    });
    const features = points
      .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon))
      .map(p => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [p.lon, p.lat] },
        properties: { code: p.code, name: p.name, selected: p.code === selectedTideStationCode, grade: p.activeGrade || "" },
      }));
    source.setData({ type: "FeatureCollection", features });
  }, [tideStationPoints, selectedTideStationCode, status]);

  // 配色スキームが切り替わったら、震央分布の丸の色も塗り直す。
  // 縁取り色はライト/ダークでも変わりうるため(気象庁配色の震度1のみ)、modeも依存に含める。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== "ready") return;
    if (!map.getLayer("epicenter-points-layer")) return;
    map.setPaintProperty("epicenter-points-layer", "circle-color", buildEpicenterCircleColorExpr(colorScheme));
    map.setPaintProperty("epicenter-points-layer", "circle-stroke-color", buildEpicenterCircleStrokeColorExpr(colorScheme, mode));
  }, [colorScheme, mode, status]);

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

      {/* 震央分布の丸をホバー/タッチした時に出る簡易ツールチップ */}
      {epicenterTooltip && (
        <div style={{
          position: "absolute",
          left: epicenterTooltip.x,
          top: epicenterTooltip.y,
          transform: "translate(-50%, -100%) translateY(-10px)",
          pointerEvents: "none",
          zIndex: 20,
          padding: "6px 10px",
          borderRadius: 10,
          background: mode === "dark" ? "rgba(28,28,30,0.92)" : "rgba(255,255,255,0.95)",
          boxShadow: "0 2px 10px rgba(0,0,0,0.35)",
          color: tokens.text,
          fontSize: 11,
          lineHeight: 1.4,
          whiteSpace: "nowrap",
          maxWidth: 220,
        }}>
          <div style={{ fontWeight: 700, marginBottom: 2 }}>{epicenterTooltip.title}</div>
          <div>{epicenterTooltip.text}</div>
        </div>
      )}

      {/* 推計震度分布の画像→ベクター変換中、観測点データの突き合わせ処理中、
          または震央分布の丸をバックグラウンドで読み込み中に、地図を隠さない
          小さなローディング表示を出す。複数同時に走ることもあるが、その場合は
          推計震度分布 → 観測点データ → 震央分布 の優先順で1つだけ文言を出す。 */}
      {status === "ready" && (estIntensityLoading || pointsLoading || epicenterLoading) && (
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
          {estIntensityLoading ? "推計震度分布を計算中…"
            : pointsLoading ? "観測点データを処理中…"
            : "震央分布を読み込み中…"}
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
// strokeColorは通常は白固定だが、配色によっては塗りが白に近く縁が見えなくなる
// 震度キーがあるため、呼び出し側(registerStationIcons)で個別に上書きできるようにしている。
function buildStationIconCanvas(bg, fg, label, withText, strokeColor = "#ffffff") {
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
  ctx.strokeStyle = strokeColor;
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
    // 気象庁配色の震度1は塗りがほぼ白(#F2F2FF)なので、既定の白い縁のままだと
    // 塗りと縁が同化して見分けづらい。この組み合わせの時だけ縁を黒にする。
    const strokeColor = (scheme.id === "jma" && key === "1") ? "#000000" : "#ffffff";
    const dotImg = buildStationIconCanvas(style.bg, style.fg, label, false, strokeColor);
    const numImg = buildStationIconCanvas(style.bg, style.fg, label, true, strokeColor);
    const dotId = `station-icon-${key}-dot`;
    const numId = `station-icon-${key}-num`;
    if (map.hasImage(dotId)) map.updateImage(dotId, dotImg); else map.addImage(dotId, dotImg);
    if (map.hasImage(numId)) map.updateImage(numId, numImg); else map.addImage(numId, numImg);
  });
}

/* ─────────────────────────────────────────────────────
   断層・プレート境界レイヤーの配色。
   ・縁取り(halo)はライト/ダーク共通の固定色にする(どちらのテーマでも
     海・陸に対して十分なコントラストが出る中間グレーを採用)。
   ・枠内の色(core)は設定画面でユーザーが選べるようにする。
   ───────────────────────────────────────────────────── */
const BOUNDARY_HALO_COLOR = "#86868c";

// 枠内の色が「グレー」の時だけ、縁取り(halo)を白にする。
// core・halo両方が似た中間グレーだと、二層構造(縁取り+芯)のコントラストが
// なくなって見分けにくくなるため、グレー選択時だけ縁取りを明るくして
// 芯とのコントラストを保つ。それ以外の色(オレンジ等)は、既に彩度差で
// haloとの区別がつくため、共通の固定グレーのままにする。
function getBoundaryHaloColor(colorId) {
  return colorId === "gray" ? "#ffffff" : BOUNDARY_HALO_COLOR;
}

const BOUNDARY_LINE_COLORS = {
  gray:   { label: "グレー",   color: "#9a9a9f" },
  white:  { label: "ホワイト", color: "#ffffff", checkColor: "#1c1c1e" }, // 白背景に白チェックだと見えないため、チェックだけ濃色にする
  orange: { label: "オレンジ", color: "#ff9500" },
  red:    { label: "レッド",   color: "#ff3b30" },
  blue:   { label: "ブルー",   color: "#0a84ff" },
  green:  { label: "グリーン", color: "#34c759" },
  purple: { label: "パープル", color: "#af52de" },
};

const QUAKE_COLOR_SCHEMES = {
  // 過去のLeaflet版(getIntensityColor)と全く同じ、鮮やかなApple風パレット。
  legacy: {
    id: "legacy",
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
    id: "jma",
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
    id: "fill",
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
// mode: 実際に適用中のライト/ダーク("dark"|"light"、"system"選択時はデバイス設定から解決した結果)。
// modePref: ユーザーが選んだ設定そのもの("system"|"light"|"dark"、初期設定は"system")。
// setModePref: modePrefを変更する関数。
const ThemeContext = createContext({
  mode: "dark",
  tokens: THEME_TOKENS.dark,
  modePref: "system",
  setModePref: () => {},
});

// デバイスの配色設定(prefers-color-scheme)をライブで監視するフック。
// "デバイスの設定に合わせる"がONの間、この値をそのままthemeMode解決に使う。
// 端末側でライト/ダークが切り替わった場合もリアルタイムに追従する。
function useSystemThemeMode() {
  const [systemMode, setSystemMode] = useState(() => {
    try {
      return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    } catch (err) {
      return "dark";
    }
  });

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const handleChange = (e) => setSystemMode(e.matches ? "light" : "dark");
    if (mq.addEventListener) mq.addEventListener("change", handleChange);
    else if (mq.addListener) mq.addListener(handleChange); // 古いSafari向けフォールバック
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", handleChange);
      else if (mq.removeListener) mq.removeListener(handleChange);
    };
  }, []);

  return systemMode;
}

// ナビ等のハイライトピルを指で押している間だけ本物のガラス(backdrop-filter)に
// する際のぼかし量。ライトモードは背景の色情報が少なく、ダークと同じ強さでは
// 「ガラス感」が弱く見えるため、ぼかし・彩度ともライトの方を強めにしている。
function touchGlassBackdropFilter(mode) {
  return mode === "light"
    ? "blur(22px) saturate(220%)"
    : "blur(16px) saturate(160%)";
}

// テーマの選択はlocalStorageに保存し、次回起動時も覚えておく。
// 値は"system"(デバイスの設定に合わせる。初期設定) | "light" | "dark"。
const THEME_MODE_STORAGE_KEY = "themeMode";

function loadStoredThemeModePref() {
  try {
    const saved = localStorage.getItem(THEME_MODE_STORAGE_KEY);
    if (saved === "light" || saved === "dark" || saved === "system") return saved;
  } catch (err) {
    console.warn("テーマ設定を読み込めませんでした:", err);
  }
  return "system";
}

function saveThemeModePref(modePref) {
  try {
    localStorage.setItem(THEME_MODE_STORAGE_KEY, modePref);
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
   実験的・テスト機能のON/OFF設定。デフォルトはOFF
   (明示的にONにした場合のみ、設定画面にテスト配信UI等が現れる)。
   ───────────────────────────────────────────────────── */
const EXPERIMENTAL_FEATURES_STORAGE_KEY = "experimentalFeaturesEnabled";

function loadStoredExperimentalFeaturesEnabled() {
  try {
    return localStorage.getItem(EXPERIMENTAL_FEATURES_STORAGE_KEY) === "true";
  } catch (err) {
    console.warn("実験的機能の設定を読み込めませんでした:", err);
  }
  return false;
}

function saveExperimentalFeaturesEnabled(enabled) {
  try {
    localStorage.setItem(EXPERIMENTAL_FEATURES_STORAGE_KEY, String(enabled));
  } catch (err) {
    console.warn("実験的機能の設定を保存できませんでした:", err);
  }
}

/* ─────────────────────────────────────────────────────
   断層(faults.geojson)の表示ON/OFF設定。
   推計震度分布などと同様、localStorageに保存し次回起動時も覚えておく。
   ファイルサイズが大きい(数MB)ため、デフォルトはOFF
   (明示的にONにした場合のみデータを読み込む)。
   ───────────────────────────────────────────────────── */
const FAULTS_ENABLED_STORAGE_KEY = "showFaults";

function loadStoredFaultsEnabled() {
  try {
    const saved = localStorage.getItem(FAULTS_ENABLED_STORAGE_KEY);
    if (saved === "true") return true;
    if (saved === "false") return false;
  } catch (err) {
    console.warn("断層表示の設定を読み込めませんでした:", err);
  }
  return false;
}

function saveFaultsEnabled(enabled) {
  try {
    localStorage.setItem(FAULTS_ENABLED_STORAGE_KEY, String(enabled));
  } catch (err) {
    console.warn("断層表示の設定を保存できませんでした:", err);
  }
}

/* ─────────────────────────────────────────────────────
   プレート境界(plate-boundaries.json)の表示ON/OFF設定。
   断層と同様、ファイルサイズが大きいためデフォルトはOFF。
   ───────────────────────────────────────────────────── */
const PLATE_BOUNDARIES_ENABLED_STORAGE_KEY = "showPlateBoundaries";

function loadStoredPlateBoundariesEnabled() {
  try {
    const saved = localStorage.getItem(PLATE_BOUNDARIES_ENABLED_STORAGE_KEY);
    if (saved === "true") return true;
    if (saved === "false") return false;
  } catch (err) {
    console.warn("プレート境界表示の設定を読み込めませんでした:", err);
  }
  return false;
}

function savePlateBoundariesEnabled(enabled) {
  try {
    localStorage.setItem(PLATE_BOUNDARIES_ENABLED_STORAGE_KEY, String(enabled));
  } catch (err) {
    console.warn("プレート境界表示の設定を保存できませんでした:", err);
  }
}

/* ─────────────────────────────────────────────────────
   震央分布(地図上の丸)の表示ON/OFF設定。
   一覧を開くたびに丸が大量に出ると地図が見づらいという声があるため、
   デフォルトはOFFにしておき、必要な人だけ設定でONにしてもらう。
   ───────────────────────────────────────────────────── */
const EPICENTER_CIRCLES_ENABLED_STORAGE_KEY = "showEpicenterCircles";

function loadStoredEpicenterCirclesEnabled() {
  try {
    const saved = localStorage.getItem(EPICENTER_CIRCLES_ENABLED_STORAGE_KEY);
    if (saved === "true") return true;
    if (saved === "false") return false;
  } catch (err) {
    console.warn("震央分布表示の設定を読み込めませんでした:", err);
  }
  return false;
}

function saveEpicenterCirclesEnabled(enabled) {
  try {
    localStorage.setItem(EPICENTER_CIRCLES_ENABLED_STORAGE_KEY, String(enabled));
  } catch (err) {
    console.warn("震央分布表示の設定を保存できませんでした:", err);
  }
}

/* ─────────────────────────────────────────────────────
   利用規約・プライバシーポリシー・注意事項への同意まわり。

   public/配下の3つのMarkdownファイルの「内容」から非暗号学的ハッシュ(cyrb53)を
   計算し、前回同意した時点のハッシュとlocalStorage上で比較することで、
   文書が更新されたかどうかを自動判定する。開発者が手動でバージョン番号を
   上げ忘れても、ファイルの中身さえ変われば自動的に再同意を求められる。

   改ざん耐性等は不要(あくまで「差分があるかどうか」の検知が目的)なため、
   Web Crypto(非同期)は使わず、高速な同期関数で済ませている。
   ───────────────────────────────────────────────────── */
function simpleHash(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

const TERMS_AGREEMENT_STORAGE_KEY = "termsAgreementV1";

// { tou, privacy, notices: <各文書の同意時点でのハッシュ>, agreedAt } | null
function loadStoredTermsAgreement() {
  try {
    const saved = localStorage.getItem(TERMS_AGREEMENT_STORAGE_KEY);
    if (!saved) return null;
    const parsed = JSON.parse(saved);
    if (parsed && typeof parsed === "object" && parsed.tou && parsed.privacy && parsed.notices) {
      return parsed;
    }
  } catch (err) {
    console.warn("利用規約等への同意状態を読み込めませんでした:", err);
  }
  return null;
}

function saveStoredTermsAgreement(agreement) {
  try {
    localStorage.setItem(TERMS_AGREEMENT_STORAGE_KEY, JSON.stringify(agreement));
  } catch (err) {
    console.warn("利用規約等への同意状態を保存できませんでした:", err);
  }
}

/* ─────────────────────────────────────────────────────
   断層・プレート境界の「枠内の色」設定。
   縁取り(halo)はライト/ダーク共通の固定色だが、枠内の色はBOUNDARY_LINE_COLORSの
   中からユーザーが選べるようにし、localStorageに保存する。デフォルトは"gray"。
   ───────────────────────────────────────────────────── */
const BOUNDARY_LINE_COLOR_STORAGE_KEY = "boundaryLineColorId";

function loadStoredBoundaryLineColorId() {
  try {
    const saved = localStorage.getItem(BOUNDARY_LINE_COLOR_STORAGE_KEY);
    if (saved && BOUNDARY_LINE_COLORS[saved]) return saved;
  } catch (err) {
    console.warn("断層・プレート境界の色設定を読み込めませんでした:", err);
  }
  return "gray";
}

function saveBoundaryLineColorId(id) {
  try {
    localStorage.setItem(BOUNDARY_LINE_COLOR_STORAGE_KEY, id);
  } catch (err) {
    console.warn("断層・プレート境界の色設定を保存できませんでした:", err);
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

// 津波情報の発表時刻は(地震の発生時刻と違って)推定ではなく確定した時刻なので、
// formatQuakeTimeShortの「頃」は付けない。
function formatTsunamiTimeShort(raw) {
  if (!raw) return "";
  const [datePart, timePart] = raw.split(" ");
  if (!timePart) return raw;
  const [hh, mm] = timePart.split(":");
  if (hh == null || mm == null) return raw;
  return `${datePart} ${hh}:${mm}`;
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
   津波情報(P2P地震情報 JMATsunami, code:552)
   https://api.p2pquake.net/v2/history?codes=552
   気象庁が発表する津波予報区ごとの津波予報・警報を取得する。
   区分(grade)は MajorWarning(大津波警報) > Warning(津波警報) >
   Watch(津波注意報) > NonEffective(津波予報・若干の海面変動) > Unknown(調査中)
   の順に危険度が高い。1件のレコードに複数の予報区(areas)が含まれるため、
   一覧には「その時点で最も危険度が高いgrade」を代表として表示する。
   ───────────────────────────────────────────────────── */
const P2PQUAKE_TSUNAMI_HISTORY_URL_BASE = "https://api.p2pquake.net/v2/history?codes=552";
const TSUNAMI_FETCH_LIMIT = 50; // 地震に比べて発表頻度が低いため、地震ほど多くの件数は要らない

const TSUNAMI_GRADE_INFO = {
  MajorWarning: { label: "大津波警報", weight: 4, color: "#BF5AF2" },
  Warning:      { label: "津波警報",   weight: 3, color: "#FF453A" },
  Watch:        { label: "津波注意報", weight: 2, color: "#FFD60A" },
  NonEffective: { label: "津波予報",   weight: 1, color: "#64D2FF" },
  Unknown:      { label: "調査中",     weight: 0, color: "#8E8E93" },
};
const TSUNAMI_GRADE_FALLBACK = { label: "情報", weight: 0, color: "#8E8E93" };

function tsunamiGradeInfo(grade) {
  return TSUNAMI_GRADE_INFO[grade] || TSUNAMI_GRADE_FALLBACK;
}

// tsunami-areas.json(津波予報区の海岸線)の各featureは properties.name に
// 予報区名を持つ。表示中の津波情報のareas(name+grade)を突き合わせて、
// 該当する予報区だけをgradeの色で塗り、それ以外は透明にするmatch式を作る。
function buildTsunamiAreaColorExpr(areas) {
  if (!areas || areas.length === 0) return "rgba(0,0,0,0)";
  const expr = ["match", ["get", "name"]];
  const seen = new Set();
  for (const a of areas) {
    if (!a.name || seen.has(a.name)) continue; // 同名予報区が重複していたら最初の1件を優先
    seen.add(a.name);
    expr.push(a.name, tsunamiGradeInfo(a.grade).color);
  }
  if (seen.size === 0) return "rgba(0,0,0,0)";
  expr.push("rgba(0,0,0,0)"); // 対象外の予報区は透明(=非表示)
  return expr;
}

// P2P地震情報APIの1レコード(JMATsunami)を、アプリ内で使う形に変換する
function toTsunamiCard(item) {
  const areas = Array.isArray(item.areas) ? item.areas.map(a => ({
    name: a.name || "不明な予報区",
    grade: a.grade || "Unknown",
    immediate: !!a.immediate,
    firstHeightCondition: a.firstHeight?.condition || null,
    firstHeightTime: a.firstHeight?.arrivalTime || null,
    maxHeightDescription: a.maxHeight?.description || null,
  })) : [];

  // 全予報区の中で最も危険度が高いgradeを、一覧表示・バッジ色の代表として使う。
  let maxGrade = null;
  let maxWeight = -1;
  areas.forEach(a => {
    const w = tsunamiGradeInfo(a.grade).weight;
    if (w > maxWeight) { maxWeight = w; maxGrade = a.grade; }
  });

  return {
    id: item.id,
    time: formatQuakeTime(item.time),
    cancelled: !!item.cancelled,
    areas,
    maxGrade: item.cancelled ? null : maxGrade,
  };
}

// 同一idの重複を除いて、新しい順に並べ直す
function dedupeTsunamiList(list) {
  const byId = new Map();
  for (const t of list) byId.set(t.id, t);
  return Array.from(byId.values()).sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
}

// 直近の津波情報一覧を取得する。取得失敗時はエラーを投げる(呼び出し側でハンドリング)。
async function fetchRecentTsunamis(limit) {
  const res = await fetch(`${P2PQUAKE_TSUNAMI_HISTORY_URL_BASE}&limit=${limit}`);
  if (!res.ok) throw new Error(`P2P地震情報 津波情報の取得に失敗(HTTP ${res.status})`);
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return dedupeTsunamiList(data.map(toTsunamiCard));
}

/* ─────────────────────────────────────────────────────
   過去の津波情報(津波タブ「過去」モード)

   【重要】直近一覧(fetchRecentTsunamis)や当初の実装では、地震・EEW等すべての
   コードを1つの領域(capped collection)で共有する/history?codes=552 を使っていたが、
   これは発表頻度の低い津波情報がすぐ押し出されてしまい、offsetで遡っても
   「過去の津波が見つかりません」になりやすい。
   → 津波予報だけを独立して保持している専用API /v2/jma/tsunami に切り替える
     (地震情報の/v2/jma/quakeに相当する、津波版のエンドポイント)。
   さらに気象庁自身が公開している一覧(list.json)も合わせて取得し、両方を
   統合することで、より確実に過去分を取得できるようにする。
     (以前作ったindex.html版アプリのfetchJMATsunamiHistory()と同じ考え方)。
   ───────────────────────────────────────────────────── */
const JMA_TSUNAMI_LIST_URL = "https://www.jma.go.jp/bosai/tsunami/data/list.json";
const JMA_TSUNAMI_HISTORY_LIMIT = 40; // list.json自体は新しい順に並んでいるため、先頭から取得する件数

// 気象庁のReportDateTime("2024-08-08T20:30:00+09:00"のようなISO風文字列、常にJST)を、
// アプリ内で使っている"YYYY/MM/DD HH:mm:ss"形式(P2P地震情報側と揃える。ソート・
// 表示(TsunamiListRowのslice(5,16)等)の両方でこの形式を前提にしているため)に変換する。
function jmaIsoToSlash(iso) {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(iso);
  if (!m) return iso;
  const [, y, mo, d, h, mi, s] = m;
  return `${y}/${mo}/${d} ${h}:${mi}:${s}`;
}

// 気象庁の個別報(Head/Body形式のJSON)を、アプリ内の津波カード形式(toTsunamiCardと同じ形)に変換する。
function jmaTsunamiReportToCard(report, reportDatetime) {
  const head = report?.Head;
  const issueTime = head?.ReportDateTime || reportDatetime;
  const isCancel = head?.InfoType === "取消";
  const areas = [];
  const forecast = report?.Body?.Tsunami?.Forecast;
  if (forecast?.Item) {
    const items = Array.isArray(forecast.Item) ? forecast.Item : [forecast.Item];
    items.forEach(item => {
      const areaName = item?.Area?.Name || "";
      const kindName = item?.Category?.Kind?.Name || "";
      if (!areaName || kindName.includes("解除")) return;
      let grade = "Unknown";
      if (kindName.includes("大津波")) grade = "MajorWarning";
      else if (kindName.includes("警報")) grade = "Warning";
      else if (kindName.includes("注意報")) grade = "Watch";
      else if (kindName.includes("海面変動") || kindName.includes("予報")) grade = "NonEffective";
      if (grade === "Unknown") return;
      areas.push({
        name: areaName,
        grade,
        immediate: !!item?.FirstHeight?.Condition && item.FirstHeight.Condition.includes("ただちに"),
        firstHeightCondition: item?.FirstHeight?.Condition || null,
        firstHeightTime: item?.FirstHeight?.ArrivalTime || null,
        maxHeightDescription: item?.MaxHeight?.TsunamiHeight?.Description || null,
      });
    });
  }
  let maxGrade = null, maxWeight = -1;
  areas.forEach(a => {
    const w = tsunamiGradeInfo(a.grade).weight;
    if (w > maxWeight) { maxWeight = w; maxGrade = a.grade; }
  });
  return {
    id: `jma_${reportDatetime}`,
    time: jmaIsoToSlash(issueTime),
    cancelled: isCancel,
    areas,
    maxGrade: isCancel ? null : maxGrade,
  };
}

// 気象庁 津波情報一覧(list.json)を取得し、先頭(新しい順)からJMA_TSUNAMI_HISTORY_LIMIT件、
// 各個別報を取得して津波カードに変換する。1件でも取得に失敗した場合はその1件だけを
// null化して除外し、全体は継続する。
async function fetchJmaTsunamiHistory(limit = JMA_TSUNAMI_HISTORY_LIMIT) {
  const listRes = await fetch(JMA_TSUNAMI_LIST_URL);
  if (!listRes.ok) throw new Error(`気象庁 津波情報一覧の取得に失敗(HTTP ${listRes.status})`);
  const list = await listRes.json();
  if (!Array.isArray(list)) return [];
  const targets = list.slice(0, limit);
  const cards = await Promise.all(targets.map(async item => {
    try {
      const res = await fetch(`https://www.jma.go.jp/bosai/tsunami/data/${item.json}`);
      if (!res.ok) return null;
      return jmaTsunamiReportToCard(await res.json(), item.reportDatetime);
    } catch {
      return null;
    }
  }));
  return dedupeTsunamiList(cards.filter(Boolean));
}

// 直近一覧(fetchRecentTsunamis, /v2/history?codes=552)とは別の、津波予報専用のJSON API。
// /historyは地震情報等すべてのコードと容量を共有するcapped collectionのため、
// 発表頻度の低い津波情報はすぐ押し出されて過去に遡りにくいが、こちらは津波予報だけを
// 独立して保持しているため、より確実に過去分を取得できる
// (レート制限は/historyの60リクエスト/分より厳しい10リクエスト/分なので、
// 呼びすぎないよう「もっと見る」を押した時だけ叩く)。
const P2PQUAKE_JMA_TSUNAMI_URL = "https://api.p2pquake.net/v2/jma/tsunami";
const TSUNAMI_HISTORY_PAGE_SIZE = 100; // このAPIの1リクエストあたりの最大件数

async function fetchTsunamiHistoryPage(offset, limit = TSUNAMI_HISTORY_PAGE_SIZE) {
  const res = await fetch(`${P2PQUAKE_JMA_TSUNAMI_URL}?limit=${limit}&offset=${offset}`);
  if (!res.ok) throw new Error(`過去の津波情報の取得に失敗(HTTP ${res.status})`);
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return dedupeTsunamiList(data.map(toTsunamiCard));
}

// 気象庁一覧(primary)とP2P地震情報一覧(supplementary)を統合する。同じ発表が
// 双方に出てくることがあるため、発表時刻が1時間以内に近い場合は重複とみなして
// supplementary側を捨てる(以前のindex.html版アプリと同じ判定基準)。
function mergeTsunamiSources(primary, supplementary) {
  const merged = [...primary];
  supplementary.forEach(s => {
    const sTime = new Date(s.time).getTime();
    const isDup = merged.some(p => Math.abs(new Date(p.time).getTime() - sTime) < 60 * 60 * 1000);
    if (!isDup) merged.push(s);
  });
  return dedupeTsunamiList(merged);
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

// 震央分布(circleレイヤー)の色分けに使う、震度キーの全パターン。
// "5"/"6"(弱/強の区分が無い旧震度階級)も含める。QUAKE_COLOR_SCHEMESの各配色は
// これらを既にスキーム内の色(5弱/6弱と同じ色)として持っているため、そのまま
// 拾えば「今ある配色に従う」ことになる。
const QUAKE_INTENSITY_KEYS = ["0", "1", "2", "3", "4", "5", "5-", "5+", "6", "6-", "6+", "7", "?"];

// 震央分布を「最大震度が大きいものほど上(=後から描画)」にするための重み。
// 数字が大きいほど後で描画される=他の丸に重なった時に上に来る。
// "5"/"6"(旧震度階級)は、実際の強さとしては5弱/6弱相当なのでそこに合わせておく。
// "?"(不明)は最も弱い扱いにする。
const QUAKE_INTENSITY_RANK = {
  "?": -1, "0": 0, "1": 1, "2": 2, "3": 3, "4": 4,
  "5": 5, "5-": 5, "5+": 6, "6": 7, "6-": 7, "6+": 8, "7": 9,
};

// 現在の震度配色スキームから、震央分布(circle-color)の塗り用match式を組み立てる。
// P2P地震一覧・近傍地震検索・データベース検索、どの震央分布も同じ配色ルールで塗る。
function buildEpicenterCircleColorExpr(colorScheme) {
  const expr = ["match", ["get", "scaleKey"]];
  for (const key of QUAKE_INTENSITY_KEYS) {
    expr.push(key, (colorScheme.colors[key] || colorScheme.colors["0"]).bg);
  }
  expr.push((colorScheme.colors["?"] || colorScheme.colors["0"]).bg);
  return expr;
}

// 震央分布(circle-stroke-color)用のmatch式。基本は塗りと同じ色だが、
// 気象庁配色の震度1はほぼ白(#F2F2FF)のため、塗りと同色の縁だとライトモードの
// (白系の)地図に溶け込んでしまう。ライトモードの時だけ縁を薄いグレーにする
// (ダークモードは暗い地図に対してそのままでも十分見えるため据え置き)。
function buildEpicenterCircleStrokeColorExpr(colorScheme, mode) {
  const expr = ["match", ["get", "scaleKey"]];
  for (const key of QUAKE_INTENSITY_KEYS) {
    const useGray = colorScheme.id === "jma" && key === "1" && mode === "light";
    expr.push(key, useGray ? "#C7C7CC" : (colorScheme.colors[key] || colorScheme.colors["0"]).bg);
  }
  expr.push((colorScheme.colors["?"] || colorScheme.colors["0"]).bg);
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
   地震情報(code:551)・津波情報(code:552)を含む全情報がリアルタイムでpushされてくる。
   最新一覧は起動時に /history で1回だけ取得し(履歴はWebSocketでは
   遡れないため)、以降はこのWebSocketで届いた新着分だけを一覧に追加していく。
   ───────────────────────────────────────────────────── */
const P2PQUAKE_WS_URL = "wss://api.p2pquake.net/v2/ws";

// WebSocketで受信した1件を、地震情報(code:551)であれば変換して返す。
// 対象外(津波予報や緊急地震速報など、このアプリでまだ扱っていない種別)はnullを返す。
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

// WebSocketで受信した1件を、津波情報(code:552)であれば変換して返す。
function wsMessageToTsunamiCard(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (data.code !== 552) return null;
  return toTsunamiCard(data);
}

/**
 * P2P地震情報のWebSocketに接続し、地震情報(code:551)を受信するたびにonQuakeを、
 * 津波情報(code:552)を受信するたびにonTsunamiを呼ぶ。1本の接続で両方を賄う
 * (種別ごとに別々の接続を開くと無駄にコネクション数が増えてしまうため)。
 * 接続が切れた場合は一定間隔で自動的に再接続を試みる。
 * 戻り値のclose()を呼ぶと再接続をやめて確実に切断する。
 */
function connectQuakeWebSocket(onQuake, onTsunami, onStatusChange) {
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
      if (quake) { onQuake(quake); return; }
      const tsunami = wsMessageToTsunamiCard(event.data);
      if (tsunami) onTsunami?.(tsunami);
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
async function fetchEqdbSearch({ startDate, endDate, startTime = "00:00", endTime = "23:59", minMag, maxInt, sort, epi }) {
  const epiValue = epi || "99";
  const isFiltered = minMag > 0 || maxInt !== "1" || epiValue !== "99";
  const fd = new FormData();
  fd.append("mode", "search");
  fd.append("dateTimeF[]", startDate); fd.append("dateTimeF[]", startTime);
  fd.append("dateTimeT[]", endDate);   fd.append("dateTimeT[]", endTime);
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

/* ─────────────────────────────────────────────────────
   震央分布(地図上の丸)用: 気象庁 震度データベース(eqdb)の座標プリフェッチ。
   eqdbの一覧検索(mode=search、近傍地震検索・データベース検索で使用)は
   震央の緯度経度を返さない。座標が分かるのは1件ごとの詳細(mode=event)
   だけなので、一覧が決まったらバックグラウンドで少しずつ詳細を取得し、
   震央分布に反映していく。
   取得済みの詳細はモジュールスコープのキャッシュ(id→detail)に載せておき、
   一覧をタップして選択する時にも同じデータをそのまま使い回せるようにする
   (二重に同じ地震を取得しないため)。
   ───────────────────────────────────────────────────── */
const eqdbEventDetailCache = new Map();

async function fetchEqdbEventCached(id) {
  if (eqdbEventDetailCache.has(id)) return eqdbEventDetailCache.get(id);
  const detail = await fetchEqdbEvent(id);
  if (detail) eqdbEventDetailCache.set(id, detail);
  return detail;
}

// eqdbのmode=event詳細(+検索一覧の元データ)から、震央分布1点分の情報を作る。
// 選択(タップ)時にそのままbuildEqdbQuakeCardへ渡せるよう、元データも持たせておく。
function eqdbDetailToEpicenterPoint(detail, listItem) {
  if (!detail || !Array.isArray(detail.hyp) || !detail.hyp[0]) return null;
  const hyp = detail.hyp[0];
  const lat = parseFloat(hyp.lat), lon = parseFloat(hyp.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const scale = eqdbIntensityStringToScale(hyp.maxI || "");
  const mag = parseFloat(hyp.mag);
  const depMatch = (hyp.dep || "").match(/\d+/);
  return {
    id: `eqdb_${listItem?.id || hyp.name}`,
    latitude: lat,
    longitude: lon,
    magnitude: Number.isFinite(mag) && mag > 0 ? mag : null,
    maxIntensityKey: scale > 0 ? maxScaleToIntensityKey(scale) : "?",
    time: eqdbIdToTimeDisplay(listItem?.id) || (listItem?.ot || ""),
    depth: depMatch ? parseInt(depMatch[0], 10) : null,
    place: hyp.name || listItem?.name || "震源地不明",
    _eqdbListItem: listItem,
    _eqdbDetail: detail,
  };
}

// 近傍地震検索・データベース検索の結果一覧(rawList、座標を持たない生のeqdb一覧項目)
// から、震央分布用の点をバックグラウンドで少しずつ解決していくフック。
// 同時に取得するのは3件までにして、APIへの負荷と表示までの速さのバランスを取る。
// キャッシュ済みの分は即座に反映され、未取得の分は取得でき次第、順次追加されていく。
// 震央分布の設定がOFFの時、useEqdbEpicenterPointsに毎回新しい[]を渡すと
// (依存配列の参照比較で)無駄にeffectが再実行されてしまうため、固定の空配列を使う。
const EMPTY_EQDB_LIST = [];

/* ─────────────────────────────────────────────────────
   潮位計(津波タブ「潮位計」モード)
   気象庁 統合地図ページ(map.html#contents=tidelevel)が使っている非公式JSON API。
   ・観測点一覧(静的、めったに変わらない): tide_area.json
   ・観測値(1地点1日1ファイル、15秒間隔): tide_obs_{YYYYMMDD}_{地点コード}.json
   ───────────────────────────────────────────────────── */
const TIDE_AREA_URL = "https://www.jma.go.jp/bosai/tidelevel/const/tide_area.json";

function tideObsUrl(dateStr, stationCode) {
  return `https://www.jma.go.jp/bosai/tidelevel/data/tide/tide_obs_${dateStr}_${stationCode}.json`;
}

// Dateオブジェクトを、tide_obsのURLで使うYYYYMMDD形式(JST基準)に変換する。
function toTideDateStr(d) {
  const pad2 = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}

// tide_area.json(地域コード→潮位区→地点、の階層構造)を、地図にピンを立てやすい
// フラットな地点一覧に展開する。

// 2点間の距離の2乗(km²相当)を求める、比較専用の簡易距離関数。
// 経度方向は緯度に応じてcos補正する(日本付近ではこれで十分な精度)。
function fastDist2(lat1, lon1, lat2, lon2) {
  const latScale = 111; // 緯度1度あたりのおおよそのkm数
  const lonScale = 111 * Math.cos((lat1 * Math.PI) / 180); // この緯度での経度1度あたりのkm数
  const dLat = (lat1 - lat2) * latScale;
  const dLon = (lon1 - lon2) * lonScale;
  return dLat * dLat + dLon * dLon;
}

// 潮位観測点(1点)から一番近い津波予報区を、tsunami-areas.json(海岸線の座標データ、
// 都道府県名などのあいまいな情報に頼らず地図描画に実際使っている正式なデータ)との
// 距離計算で求める。各予報区のMultiLineStringの頂点との最短距離で近似している
// (頂点間隔は密なため、線分内挿までは行わずとも十分な精度が出る)。
function findNearestTsunamiArea(lat, lon, tsunamiAreasGeoJSON) {
  if (lat == null || lon == null || !tsunamiAreasGeoJSON || !Array.isArray(tsunamiAreasGeoJSON.features)) return null;
  let best = null;
  let bestDist2 = Infinity;
  for (const feature of tsunamiAreasGeoJSON.features) {
    const multiLine = feature.geometry?.coordinates;
    if (!Array.isArray(multiLine)) continue;
    for (const line of multiLine) {
      for (const pt of line) {
        const d2 = fastDist2(lat, lon, pt[1], pt[0]);
        if (d2 < bestDist2) {
          bestDist2 = d2;
          best = feature.properties;
        }
      }
    }
  }
  return best; // { code, name } | null
}

async function fetchTideStations() {
  const res = await fetch(TIDE_AREA_URL);
  if (!res.ok) throw new Error(`潮位観測点一覧の取得に失敗(HTTP ${res.status})`);
  const data = await res.json();
  const stations = [];
  Object.values(data || {}).forEach(class20 => {
    (class20.class30s || []).forEach(class30 => {
      (class30.stations || []).forEach(st => {
        if (st.lat == null || st.lon == null) return;
        stations.push({
          code: st.code,
          name: st.name,
          typeName: st.typeName,
          addr: st.addr,
          reference: st.reference,
          max: st.max || null,
          level4: class30.standard?.level4 ?? null,
          level5: class30.standard?.level5 ?? null,
          areaName: class20.name,
          class20Code: st.parents?.class20 ?? null,
          class30Code: st.parents?.class30 ?? null,
          lat: st.lat,
          lon: st.lon,
        });
      });
    });
  });
  return stations;
}

// 指定地点・指定日の観測値(15秒間隔のtide/departure配列)を取得する。
// dateStrはYYYYMMDD形式(toTideDateStr参照)。
async function fetchTideObs(dateStr, stationCode) {
  const res = await fetch(tideObsUrl(dateStr, stationCode));
  if (!res.ok) throw new Error(`潮位観測値の取得に失敗(HTTP ${res.status})`);
  return res.json();
}


function useEqdbEpicenterPoints(rawList) {
  const [points, setPoints] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;

    function rebuildFromCache() {
      const next = [];
      for (const item of rawList || []) {
        const detail = eqdbEventDetailCache.get(item.id);
        const point = detail ? eqdbDetailToEpicenterPoint(detail, item) : null;
        if (point) next.push(point);
      }
      if (!cancelled) setPoints(next);
    }

    rebuildFromCache(); // まずキャッシュ済みの分だけ即座に反映する

    const total = (rawList || []).length;
    if (total === 0) {
      setLoading(false);
      return () => { cancelled = true; };
    }
    setLoading(true);

    let nextIndex = 0;
    let completed = 0;
    async function worker() {
      while (!cancelled) {
        const i = nextIndex++;
        if (i >= total) return;
        const item = rawList[i];
        if (!eqdbEventDetailCache.has(item.id)) {
          try {
            await fetchEqdbEventCached(item.id);
          } catch (err) {
            // この1件は諦めて次へ(震央分布は「取れた分だけ表示」でよいため)
          }
          if (cancelled) return;
          rebuildFromCache();
        }
        completed++;
        if (!cancelled && completed >= total) setLoading(false);
      }
    }
    const CONCURRENCY = 3;
    for (let i = 0; i < CONCURRENCY; i++) worker();

    return () => { cancelled = true; };
  }, [rawList]);

  return { points, loading };
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

/* ─────────────────────────────────────────────────────
   発震機構解(CMT解) — 「この地震の詳細」用

   気象庁の発震機構解(精査後)ページ(data.jma.go.jp/eqev/data/mech/cmt/…)は
   正式なJSON APIではなく、月別の一覧HTMLページと、地震ごとの詳細HTMLページから
   なる。fetchでの取得(CORS)自体は実機で確認済み。
   
   1. 対象地震の発生月から一覧ページ(cmtYYYYMM.html)を取得し、時刻・位置が
      近い行を探す(=CMT解が求まっている地震かどうか、どれに対応するかを判別)。
   2. 一致した行の発生時刻から、詳細ページのURL(cmtYYYYMMDDHHMMSS.html)を
      組み立てて取得し、震源球画像・モーメントテンソル・P/T/N軸などの
      詳しい情報を得る。
   ───────────────────────────────────────────────────── */

const CMT_LIST_BASE = "https://www.data.jma.go.jp/eqev/data/mech/cmt/";
const CMT_FIG_BASE = "https://www.data.jma.go.jp/eqev/data/mech/cmt/fig/";

// "33度17.8分N" のような度分表記を10進の度(符号付き)に変換する。
// S(南緯)・W(西経)の場合は負の値にする。
function cmtParseDegMin(str) {
  if (!str) return null;
  const m = String(str).match(/([\d.]+)度([\d.]+)分([NSEW])/);
  if (!m) return null;
  const deg = parseFloat(m[1]) + parseFloat(m[2]) / 60;
  return (m[3] === "S" || m[3] === "W") ? -deg : deg;
}

// "2026-07-09 21:58:58.8" のような気象庁側の時刻文字列(日本時間)を、
// 比較に使えるエポックミリ秒に変換する。
function cmtParseTimeToEpochMs(str) {
  if (!str) return null;
  const m = String(str).trim().match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss] = m.map(Number);
  // 気象庁のページはすべて日本時間(UTC+9)表記のため、UTCとして組み立ててから9時間引く。
  return Date.UTC(y, mo - 1, d, hh, mm, ss) - 9 * 3600 * 1000;
}

// アプリ内の地震オブジェクトが持つ time("YYYY/MM/DD HH:mm[:ss]"、日本時間)を
// 同じくエポックミリ秒に変換する。cmtParseTimeToEpochMsと単位を揃えるための対。
function quakeTimeToEpochMs(timeStr) {
  if (!timeStr) return null;
  const m = String(timeStr).trim().match(/(\d{4})\/(\d{2})\/(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const hh = Number(m[4]), mm = Number(m[5]), ss = m[6] ? Number(m[6]) : 0;
  return Date.UTC(y, mo - 1, d, hh, mm, ss) - 9 * 3600 * 1000;
}

// 発生時刻(気象庁ページの文字列)から、詳細ページのURLに使うタイムスタンプ
// (YYYYMMDDHHMMSS)を組み立てる。
function cmtTimeToUrlStamp(str) {
  const m = String(str).trim().match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return m[1] + m[2] + m[3] + m[4] + m[5] + m[6];
}

// 月別一覧ページ(cmtYYYYMM.html)を取得し、行ごとに構造化データへ変換する。
// 同じ月内で複数回この一覧が必要になることがあるため、簡単なメモ化キャッシュを持つ。
const cmtMonthCache = new Map(); // "YYYYMM" -> Promise<rows>

function fetchCmtMonthList(yyyymm) {
  if (cmtMonthCache.has(yyyymm)) return cmtMonthCache.get(yyyymm);

  const promise = (async () => {
    const res = await fetch(`${CMT_LIST_BASE}cmt${yyyymm}.html`);
    if (!res.ok) throw new Error(`CMT一覧の取得に失敗しました(status ${res.status})`);
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const rows = [...doc.querySelectorAll("table tr")];

    const out = [];
    for (const tr of rows) {
      const cells = [...tr.querySelectorAll("td")].map(td => td.textContent.trim());
      // データ行は14列(発生時刻,緯度,経度,深さ,M,震央地域名,Mw,走向1,傾斜1,すべり角1,走向2,傾斜2,すべり角2,詳細)。
      // ヘッダー行(列数が違う・数値が入っていない)はここで自然に弾かれる。
      if (cells.length < 13) continue;
      const timeMs = cmtParseTimeToEpochMs(cells[0]);
      if (timeMs == null) continue;
      const lat = cmtParseDegMin(cells[1]);
      const lon = cmtParseDegMin(cells[2]);
      const depthMatch = cells[3].match(/\d+/);
      out.push({
        timeStr: cells[0],
        timeMs,
        lat, lon,
        depth: depthMatch ? parseInt(depthMatch[0], 10) : null,
        magnitude: parseFloat(cells[4]) || null,
        place: cells[5] || "",
        mw: parseFloat(cells[6]) || null,
        plane1: { strike: cells[7], dip: cells[8], rake: cells[9] },
        plane2: { strike: cells[10], dip: cells[11], rake: cells[12] },
        detailUrlStamp: cmtTimeToUrlStamp(cells[0]),
      });
    }
    return out;
  })();

  cmtMonthCache.set(yyyymm, promise);
  // 失敗した月はキャッシュに残さない(一時的なネットワーク障害等で、以後ずっと
  // 失敗扱いのままになるのを防ぐ)。
  promise.catch(() => cmtMonthCache.delete(yyyymm));
  return promise;
}

// 対象の地震(time・緯度経度)に最も近いCMT解の行を探す。
// 発生時刻が近い(±3分以内)ことを必須とし、その中で最も時刻が近いものを採用する
// (連続発生時に別の地震を誤って拾わないよう、念のため緯度経度も大きく離れて
//  いないか確認する)。
const CMT_MATCH_TOLERANCE_MS = 3 * 60 * 1000;
const CMT_MATCH_MAX_DEGREES = 2.0;

async function findCmtMatchForQuake(quake) {
  const quakeMs = quakeTimeToEpochMs(quake.time);
  if (quakeMs == null) return null;

  const d = new Date(quakeMs);
  // 発生時刻が月初め近くの場合、CMT解の一覧側は「発生時刻」(=同じ日本時間)なので
  // 基本的には地震自身と同じ月の一覧に載っているはずだが、念のため前月分も
  // 候補に含めておく(月境界をまたぐタイミングのずれ対策)。
  const yyyymmThis = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const prevMonthDate = new Date(quakeMs - 24 * 3600 * 1000);
  const yyyymmPrev = `${prevMonthDate.getUTCFullYear()}${String(prevMonthDate.getUTCMonth() + 1).padStart(2, "0")}`;
  const monthKeys = yyyymmThis === yyyymmPrev ? [yyyymmThis] : [yyyymmThis, yyyymmPrev];

  let candidates = [];
  for (const key of monthKeys) {
    try {
      const rows = await fetchCmtMonthList(key);
      candidates = candidates.concat(rows);
    } catch {
      // その月の一覧が取れなくても、もう片方の月で見つかる可能性があるので続行する。
    }
  }

  let best = null, bestDiff = Infinity;
  for (const row of candidates) {
    const diff = Math.abs(row.timeMs - quakeMs);
    if (diff > CMT_MATCH_TOLERANCE_MS) continue;
    if (quake.latitude != null && quake.longitude != null && row.lat != null && row.lon != null) {
      const dist = Math.abs(row.lat - quake.latitude) + Math.abs(row.lon - quake.longitude);
      if (dist > CMT_MATCH_MAX_DEGREES) continue;
    }
    if (diff < bestDiff) { bestDiff = diff; best = row; }
  }
  return best;
}

// 地震ごとの詳細ページ(cmtYYYYMMDDHHMMSS.html)を取得し、震源球画像や
// モーメントテンソル・発震機構解(P/T/N軸込み)・観測点数などを取り出す。
async function fetchCmtDetail(detailUrlStamp) {
  const url = `${CMT_FIG_BASE}cmt${detailUrlStamp}.html`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CMT詳細の取得に失敗しました(status ${res.status})`);
  const html = await res.text();
  const doc = new DOMParser().parseFromString(html, "text/html");

  // ページ内には複数の<table>があり、順番は固定(見出し文言で対応するテーブルを探す)。
  // h2見出しの直後の最初のtableを、その見出しのテーブルとみなす。
  function tableAfterHeading(keyword) {
    const heading = [...doc.querySelectorAll("h2")].find(h => h.textContent.includes(keyword));
    if (!heading) return null;
    let el = heading.nextElementSibling;
    while (el && el.tagName !== "TABLE") el = el.nextElementSibling;
    return el;
  }
  function rowCells(table, rowIndex) {
    if (!table) return [];
    const trs = table.querySelectorAll("tr");
    const tr = trs[rowIndex];
    if (!tr) return [];
    return [...tr.querySelectorAll("td,th")].map(c => c.textContent.trim());
  }

  const hypoTable = tableAfterHeading("地震発生時刻と震源位置");
  const hypo = rowCells(hypoTable, 1); // [発生時刻, 緯度, 経度, 深さ, M]

  const centroidTable = tableAfterHeading("セントロイド時刻");
  const centroid = rowCells(centroidTable, 1); // [セントロイド時刻, 緯度, 経度, 深さ, Mw]

  const mechTable = tableAfterHeading("発震機構解");
  const plane1Row = rowCells(mechTable, 1); // [断層面解1, 走向, 傾斜, すべり角, 方位, P軸方位, T軸方位, N軸方位]
  const plane2Row = rowCells(mechTable, 2); // [断層面解2, 走向, 傾斜, すべり角, 傾斜, P軸傾斜, T軸傾斜, N軸傾斜]

  const stationTable = tableAfterHeading("使用観測点数");
  const stationRow = rowCells(stationTable, 0);

  // 画像(震源球・周辺のCMT解)。<img>タグで直接読み込むだけなのでCORSの影響を受けない。
  // ページ内のsrc属性は相対パス("cmt....png"など)で書かれていることがあるため、
  // 文字列にパスが含まれているかで絞り込む前に、必ずURLを絶対パスへ解決してから
  // 判定する(でないと相対パスの画像を取りこぼす)。
  const images = [...doc.querySelectorAll("img")]
    .map(img => img.getAttribute("src"))
    .filter(Boolean)
    .map(src => new URL(src, url).href)
    .filter(src => !src.includes("jma.go.jp/jma/com/images/")); // 気象庁ロゴなど共通画像を除外
  const beachballImg = images.find(src => !/map/i.test(src)) || null;
  const surroundingMapImg = images.find(src => /map/i.test(src)) || null;

  return {
    sourceUrl: url,
    hypo: {
      time: hypo[0] || null, lat: hypo[1] || null, lon: hypo[2] || null,
      depth: hypo[3] || null, magnitude: hypo[4] || null,
    },
    centroid: {
      time: centroid[0] || null, lat: centroid[1] || null, lon: centroid[2] || null,
      depth: centroid[3] || null, mw: centroid[4] || null,
    },
    plane1: { strike: plane1Row[1] || null, dip: plane1Row[2] || null, rake: plane1Row[3] || null },
    plane2: { strike: plane2Row[1] || null, dip: plane2Row[2] || null, rake: plane2Row[3] || null },
    // P軸・T軸・N軸は「方位」の行(plane1Row)と「傾斜」の行(plane2Row)にそれぞれ
    // 3つずつ入っている(表が2行にまたがった構成のため)。
    axes: {
      p: { azimuth: plane1Row[5] || null, plunge: plane2Row[5] || null },
      t: { azimuth: plane1Row[6] || null, plunge: plane2Row[6] || null },
      n: { azimuth: plane1Row[7] || null, plunge: plane2Row[7] || null },
    },
    stationCount: stationRow[1] || null,
    varianceReduction: stationRow[3] || null,
    beachballImageUrl: beachballImg,
    surroundingMapImageUrl: surroundingMapImg,
  };
}


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
function StationPointsList({ points, displayMode = "list", openKey, onOpenKeyChange }) {
  const { tokens } = useContext(ThemeContext);

  const [expanded, setExpanded] = useState(false); // 一覧表示(list)用の「すべて表示」
  // 階層表示(grouped)用: 詳細画面を開いている震度キー。
  // フローティングの外にある丸い「戻る」ボタンでもこの詳細画面を閉じられるように、
  // 親(BottomDock)側にstateを持ち上げてpropsで受け取る形にしている
  // (✕ボタン自体はこれまで通りこのコンポーネント内に残す)。
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
    onOpenKeyChange(null);
    setOpenPrefs(new Set());
  }, [points]);

  // 詳細画面を閉じた時・別の震度キーの詳細画面へ切り替わった時は、
  // 開いていた都道府県の展開状態をリセットする。
  // openPrefsは震度キーをまたいで共有しているstateなので、これをやらないと
  // 「震度5弱の詳細で北海道を開いたまま閉じて、震度3の詳細を開いたら
  //  北海道が開きっぱなしになっている」といった意図しない引き継ぎが起きる。
  useEffect(() => {
    setOpenPrefs(new Set());
  }, [openKey]);

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
                onClick={() => onOpenKeyChange(null)}
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
                  onClick={() => onOpenKeyChange(key)}
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
   QUAKE MECH DETAIL PANEL — 「この地震の詳細」画面
   
   気象庁の発震機構解(CMT解)を取得して表示する。M5.0以上でないとそもそも
   解析されないため、見つからない場合はその旨を案内する(エラーではない)。
   ───────────────────────────────────────────────────── */
function QuakeMechDetailPanel({ quake }) {
  const { tokens } = useContext(ThemeContext);
  // ホーム画面に追加したPWA(スタンドアロン表示)かどうか。
  // iOSのスタンドアロンPWAには「新しいタブ」という概念が無いため、
  // target="_blank"のリンクを踏むとOSがSafari側にまるごと処理を渡してしまい、
  // 「戻る」で復帰した時にPWA側のWebViewがメモリから破棄されていて
  // アプリ全体がリロードされてしまうことがある(=開いていた画面が消える不具合)。
  // スタンドアロン時だけtarget="_blank"を外し、同じWebView内で遷移させることで、
  // これを避ける。
  const isStandalonePwa = useIsStandalonePwa();
  // "loading" | "found" | "not_found" | "error"
  const [status, setStatus] = useState("loading");
  const [detail, setDetail] = useState(null);
  const [matchedRow, setMatchedRow] = useState(null);
  // 震源球画像のURLが取れても、実際には読み込みに失敗する(ページ構成の想定違いで
  // 誤ったURLを組み立ててしまった等)ことがあるため、<img>のonErrorで検知して
  // 壊れた画像アイコンの代わりに案内文を出す。
  const [imgLoadFailed, setImgLoadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setDetail(null);
    setMatchedRow(null);
    setImgLoadFailed(false);

    (async () => {
      try {
        const match = await findCmtMatchForQuake(quake);
        if (cancelled) return;
        if (!match) { setStatus("not_found"); return; }
        setMatchedRow(match);
        const d = await fetchCmtDetail(match.detailUrlStamp);
        if (cancelled) return;
        setDetail(d);
        setStatus("found");
      } catch (err) {
        console.error("発震機構解の取得に失敗:", err);
        if (!cancelled) setStatus("error");
      }
    })();

    return () => { cancelled = true; };
  }, [quake.id]);

  const rowLabelStyle = { fontSize: 11, color: tokens.textSecondary };
  const rowValueStyle = { fontSize: 13, fontWeight: 700, color: tokens.text };

  function DataRow({ label, value }) {
    if (value == null || value === "") return null;
    return (
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "6px 0" }}>
        <span style={rowLabelStyle}>{label}</span>
        <span style={rowValueStyle}>{value}</span>
      </div>
    );
  }

  // 深さ・M(またはMw)のように、単独の行だと空きスペースが目立つ2項目を
  // 1行に横並びで表示する(左右それぞれで見出し/値のペア)。
  // 片方だけ値が無い場合は、そちら側だけ非表示にする。
  function DataRowPair({ left, right }) {
    const leftHas = left.value != null && left.value !== "";
    const rightHas = right.value != null && right.value !== "";
    if (!leftHas && !rightHas) return null;
    return (
      <div style={{ display: "flex", gap: 10, padding: "6px 0" }}>
        {leftHas && (
          <div style={{ flex: 1, display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{ ...rowLabelStyle, flexShrink: 0 }}>{left.label}</span>
            <span style={{ ...rowValueStyle, flex: 1, textAlign: "center" }}>{left.value}</span>
          </div>
        )}
        {rightHas && (
          <div style={{ flex: 1, display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{ ...rowLabelStyle, flexShrink: 0 }}>{right.label}</span>
            <span style={{ ...rowValueStyle, flex: 1, textAlign: "center" }}>{right.value}</span>
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <QuakeDetailCard quake={quake}/>
      <div style={{ padding: "2px 14px 16px" }}>
      {status === "loading" && (
        <Glass radius={14} style={{ padding: "24px 16px", textAlign: "center" }}>
          <div style={{ fontSize: 12, color: tokens.textSecondary }}>気象庁のデータを確認しています…</div>
        </Glass>
      )}

      {status === "not_found" && (
        <Glass radius={14} style={{ padding: "24px 16px", textAlign: "center" }}>
          <div style={{ fontSize: 12, color: tokens.textSecondary, lineHeight: 1.6 }}>
            この地震の発震機構解は見つかりませんでした。<br/>
            まだ解析中か、解析対象外の可能性があります。
          </div>
        </Glass>
      )}

      {status === "error" && (
        <Glass radius={14} style={{ padding: "24px 16px", textAlign: "center" }}>
          <div style={{ fontSize: 12, color: "rgba(255,140,140,0.9)", lineHeight: 1.6 }}>
            気象庁のデータ取得に失敗しました。時間をおいて再度お試しください。
          </div>
        </Glass>
      )}

      {status === "found" && detail && (
        <>
          {/* 使用観測点数・精度(左)と震源球の図(右)を横並びにする。
              左側は中身の幅だけ確保し(space-betweenで間延びさせない)、
              余った分は震源球の画像を大きく見せる方に回す。
              「震源球(下半球等積投影)」のキャプションは画像の下ではなく、
              左側の解の精度の下に矢印つきで置くことで、画像により幅を割ける。 */}
          <Glass radius={14} style={{ padding: 16, marginBottom: 10 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, minWidth: 0 }}>
              <div style={{ flexShrink: 1, minWidth: 0 }}>
                <DataRow label="使用観測点数" value={detail.stationCount} />
                <DataRow label="解の精度(V.R.)" value={detail.varianceReduction} />
                {detail.beachballImageUrl && !imgLoadFailed && (
                  <div style={{ fontSize: 10, color: tokens.textSecondary, marginTop: 6 }}>
                    震源球(下半球等積投影)→
                  </div>
                )}
              </div>
              {detail.beachballImageUrl && (
                <div style={{ flex: "0 1 150px", minWidth: 0, maxWidth: 150, textAlign: "center" }}>
                  {!imgLoadFailed ? (
                    <img
                      src={detail.beachballImageUrl}
                      alt="震源球(発震機構解)"
                      style={{ display: "block", width: "100%", maxWidth: "100%", height: "auto", borderRadius: 8, background: "#fff" }}
                      onError={() => setImgLoadFailed(true)}
                    />
                  ) : (
                    <div style={{ fontSize: 10, color: tokens.textSecondary, lineHeight: 1.5 }}>
                      画像を読み込めませんでした
                    </div>
                  )}
                </div>
              )}
            </div>
          </Glass>

          <Glass radius={14} style={{ padding: "6px 16px", marginBottom: 10 }}>
            <DataRow label="発生時刻" value={detail.hypo.time} />
            <DataRow label="震源位置" value={detail.hypo.lat && detail.hypo.lon ? `${detail.hypo.lat} ${detail.hypo.lon}` : null} />
            <DataRowPair
              left={{ label: "深さ", value: detail.hypo.depth }}
              right={{ label: "M", value: detail.hypo.magnitude }}
            />
          </Glass>

          <Glass radius={14} style={{ padding: "6px 16px", marginBottom: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: tokens.text, padding: "8px 0 2px" }}>
              セントロイド・モーメントマグニチュード
            </div>
            <DataRow label="セントロイド時刻" value={detail.centroid.time} />
            <DataRow label="位置" value={detail.centroid.lat && detail.centroid.lon ? `${detail.centroid.lat} ${detail.centroid.lon}` : null} />
            <DataRowPair
              left={{ label: "深さ", value: detail.centroid.depth }}
              right={{ label: "Mw", value: detail.centroid.mw }}
            />
          </Glass>

          {/* 断層面解1・2は片方ずつだと余白が目立つため、真ん中に区切り線を入れて
              横に2つ並べる。 */}
          <Glass radius={14} style={{ padding: "6px 16px", marginBottom: 10 }}>
            <div style={{ display: "flex", gap: 14 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: tokens.text, padding: "8px 0 2px" }}>
                  断層面解1
                </div>
                <DataRow label="走向" value={detail.plane1.strike} />
                <DataRow label="傾斜" value={detail.plane1.dip} />
                <DataRow label="すべり角" value={detail.plane1.rake} />
              </div>
              <div style={{ width: 1, alignSelf: "stretch", background: tokens.divider, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: tokens.text, padding: "8px 0 2px" }}>
                  断層面解2
                </div>
                <DataRow label="走向" value={detail.plane2.strike} />
                <DataRow label="傾斜" value={detail.plane2.dip} />
                <DataRow label="すべり角" value={detail.plane2.rake} />
              </div>
            </div>
          </Glass>

          <Glass radius={14} style={{ padding: "6px 16px", marginBottom: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: tokens.text, padding: "8px 0 2px" }}>
              P軸・T軸・N軸(方位 / 傾斜)
            </div>
            <DataRow label="P軸" value={detail.axes.p.azimuth && detail.axes.p.plunge ? `${detail.axes.p.azimuth}° / ${detail.axes.p.plunge}°` : null} />
            <DataRow label="T軸" value={detail.axes.t.azimuth && detail.axes.t.plunge ? `${detail.axes.t.azimuth}° / ${detail.axes.t.plunge}°` : null} />
            <DataRow label="N軸" value={detail.axes.n.azimuth && detail.axes.n.plunge ? `${detail.axes.n.azimuth}° / ${detail.axes.n.plunge}°` : null} />
          </Glass>

          <a
            href={detail.sourceUrl}
            {...(isStandalonePwa ? {} : { target: "_blank", rel: "noopener noreferrer" })}
            style={{
              display: "block", textAlign: "center", padding: "10px 0",
              fontSize: 12, fontWeight: 600, color: tokens.accentText || "#0A84FF",
              textDecoration: "none",
            }}
          >
            気象庁の該当ページを開く ↗
          </a>
        </>
      )}

      {/* CMT解についての注意書きは最下部に置く */}
      <Glass radius={14} style={{ padding: "14px 16px", marginTop: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: tokens.text, marginBottom: 2 }}>
          発震機構解(CMT解)
        </div>
        <div style={{ fontSize: 11, color: tokens.textSecondary, lineHeight: 1.5 }}>
          気象庁の解析結果です。マグニチュード5.0程度以上の地震のみ解析されるため、
          対象の地震でも掲載されていない場合があります。
        </div>
      </Glass>
      </div>
    </>
  );
}


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
  const { tokens, mode } = useContext(ThemeContext);
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
                backdropFilter: (pressed || dragging) && !glassOpaque ? touchGlassBackdropFilter(mode) : "none",
                WebkitBackdropFilter: (pressed || dragging) && !glassOpaque ? touchGlassBackdropFilter(mode) : "none",
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
  active, onNav, navCollapseSignal, layerOpen, layers, onToggleLayer, onLayerOpenChange,
  quakes, quakeStatus, selectedQuakeId, onSelectQuake, stationPoints = [],
  tsunamis = [], tsunamiStatus = "loading", selectedTsunamiId, onSelectTsunami,
  tsunamiHistory, onLoadMoreTsunamiHistory, onCausingQuakeChange,
  onTsunamiViewModeChange,
  tideStations = EMPTY_EQDB_LIST, tideStationsStatus = "idle",
  selectedTideStationCode, onSelectTideStation, tideObsByStation = {}, onLoadTideObs,
  stationMarkersVisible = true, onToggleStationMarkersVisible,
  onChangeQuakeColorScheme,
  estIntensityEnabled, onChangeEstIntensityEnabled,
  areaFillEnabled, onChangeAreaFillEnabled,
  faultsEnabled, onChangeFaultsEnabled,
  plateBoundariesEnabled, onChangePlateBoundariesEnabled,
  epicenterCirclesEnabled, onChangeEpicenterCirclesEnabled,
  boundaryLineColorId, onChangeBoundaryLineColorId,
  quakeFetchLimit, onChangeQuakeFetchLimit,
  stationListDisplayMode, onChangeStationListDisplayMode,
  experimentalFeaturesEnabled, onChangeExperimentalFeaturesEnabled,
  testTsunami, onBroadcastTestTsunami, onCancelTestTsunami, onClearTestTsunami,
  stations, searchQuake, onFoundSearchQuake,
  onEpicenterPointsChange,
  onEpicenterLoadingChange,
  mapSelectSignal,
  uiScale = 1,
}) {
  const { tokens, mode } = useContext(ThemeContext);
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

  // 設定内の画面を切り替えるたびに、スクロール位置(共有の1本のscrollRef)を
  // 先頭へ戻す。そうしないと、例えば「利用規約」を下までスクロールした状態で
  // 「注意事項」に切り替えた時、同じスクロール位置が引き継がれてしまう。
  function handleSettingsNavigate(nextPath) {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    setSettingsPath(nextPath);
  }

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

  // 津波タブ版の表示モード。"recent" = 直近の津波情報一覧、
  // "history" = 過去に発表された津波情報一覧(/history APIをoffsetで遡って取得)。
  // 考え方はquakeViewModeと全く同じ(タブを離れたら「一覧」に戻す/選択中は維持)。
  const [tsunamiViewMode, setTsunamiViewMode] = useState("recent"); // "recent" | "history" | "tidegauge"
  useEffect(() => {
    if (active !== "tsunami" && selectedTsunamiId == null) setTsunamiViewMode("recent");
  }, [active, selectedTsunamiId]);

  // App側(地図の潮位計ピン表示用)に、現在のtsunamiViewModeを都度伝える。
  useEffect(() => {
    onTsunamiViewModeChange?.(tsunamiViewMode);
  }, [tsunamiViewMode, onTsunamiViewModeChange]);

  // 「過去」モードを初めて開いた時、まだ何も取得していなければ最初の1ページを取得する。
  useEffect(() => {
    if (
      active === "tsunami" && tsunamiViewMode === "history" &&
      tsunamiHistory && tsunamiHistory.items.length === 0 && tsunamiHistory.status === "idle"
    ) {
      onLoadMoreTsunamiHistory?.();
    }
  }, [active, tsunamiViewMode, tsunamiHistory, onLoadMoreTsunamiHistory]);

  /* ─────────────────────────────────────────────────────
     「↪︎ 津波を引き起こした地震」— 津波カードの右下ボタン。

     判定方法(ユーザー指定の方式):
     1. 選択中の津波情報が属する「一連の津波現象」(最初の警報・注意報・予報〜
        解除まで)を特定する。厳密な系列IDは無いので、直近一覧+過去一覧を
        時刻順に並べ、選択中の情報から過去へ辿って、隣り合う発表の間隔が
        24時間以内で続く限りひとつながりの現象とみなす(24時間以上の空きが
        あればそこで別の現象として区切る)、という簡易ヒューリスティックを使う。
     2. その現象の「最初の発表時刻」の30分前〜その時刻までを検索窓とし、
        気象庁 震度データベース(eqdb)でこの窓に発生した地震を検索する。
     3. 該当した地震のうち、規模(M)が最大のものを「津波を引き起こした地震」
        と特定する。
     ───────────────────────────────────────────────────── */
  // 形: { [tsunamiId]: { status: "loading"|"done"|"notfound"|"error", quake: card|null } }
  const [causingQuakeState, setCausingQuakeState] = useState({});
  // 現在「引き起こした地震」のカードを表示中の津波ID(nullなら通常の津波カード表示)
  const [showingCausingQuakeFor, setShowingCausingQuakeFor] = useState(null);
  // 引き起こした地震の観測点一覧が「階層表示」設定の時に使う、開いている震度キー
  // (StationPointsListの通常の観測点一覧(stationDetailOpenKey)とは別に持つ)。
  const [causingQuakeStationOpenKey, setCausingQuakeStationOpenKey] = useState(null);
  // 選択中の津波情報が変わったら(別の情報を選び直した/選択解除した)、
  // 「引き起こした地震」の表示は必ず一旦引っ込める(別の津波情報のまま古い結果が
  // 表示され続けるのを防ぐ)。
  useEffect(() => {
    setShowingCausingQuakeFor(null);
    setCausingQuakeStationOpenKey(null);
  }, [selectedTsunamiId]);

  // 表示中の「引き起こした地震」が変わるたび、App側(地図表示用)に通知する。
  // 見つかっていない・読み込み中・選択解除されている間はnullを通知して地図から消す。
  useEffect(() => {
    if (showingCausingQuakeFor == null) {
      onCausingQuakeChange?.(null);
      return;
    }
    const st = causingQuakeState[showingCausingQuakeFor];
    onCausingQuakeChange?.(st && st.status === "done" ? st.quake : null);
  }, [showingCausingQuakeFor, causingQuakeState, onCausingQuakeChange, active]);

  // 「戻る」を押した時に呼ぶ。表示を引っ込めるだけでなく、キャッシュ済みの
  // 結果も消して表示をクリアする(再度ボタンを押すとまた最初から検索し直す)。
  function handleBackFromCausingQuake() {
    setShowingCausingQuakeFor(null);
    setCausingQuakeStationOpenKey(null);
    if (selectedTsunamiId != null) {
      setCausingQuakeState(prev => {
        const next = { ...prev };
        delete next[selectedTsunamiId];
        return next;
      });
    }
  }

  // 津波タブ版の「戻る」ボタン。地震タブのhandleBackFromQuakeと同じ考え方で、
  // 「引き起こした地震」を表示中ならまずそれを閉じて予報区一覧に戻し、
  // 何も開いていなければ津波情報の選択自体を解除して一覧に戻る。
  function handleBackFromTsunami() {
    if (showingCausingQuakeFor != null) {
      handleBackFromCausingQuake();
      return;
    }
    if (tsunamiViewMode === "tidegauge" && selectedTideStationCode != null) {
      onSelectTideStation?.(null);
      return;
    }
    onSelectTsunami(null);
  }
  const backFromTsunamiLabel = showingCausingQuakeFor != null
    ? "予報区一覧に戻る"
    : (tsunamiViewMode === "tidegauge" && selectedTideStationCode != null)
    ? "観測点一覧に戻る"
    : "津波情報一覧に戻る";
  // 観測点表示切替ボタンは、「引き起こした地震」が実際に見つかった時だけ出す
  // (読み込み中・見つからなかった時・エラー時は観測点自体が無いので出さない)。
  const causingQuakeFound = showingCausingQuakeFor != null && causingQuakeState[showingCausingQuakeFor]?.status === "done";

  async function handleFindCausingQuake(tsunamiCard) {
    const id = tsunamiCard.id;
    setShowingCausingQuakeFor(id);
    if (causingQuakeState[id]?.status === "loading" || causingQuakeState[id]?.status === "done") return;
    setCausingQuakeState(prev => ({ ...prev, [id]: { status: "loading", quake: null } }));
    try {
      const allCards = dedupeTsunamiList([...(tsunamis || []), ...(tsunamiHistory?.items || [])]);
      const sorted = [...allCards].sort((a, b) => new Date(a.time) - new Date(b.time));
      const idx = sorted.findIndex(c => c.id === id);
      let episodeStart = idx >= 0 ? new Date(sorted[idx].time) : new Date(tsunamiCard.time);
      const GAP_LIMIT_MS = 24 * 60 * 60 * 1000; // 24時間以上の空きで別の現象とみなす
      for (let i = idx; i > 0; i--) {
        const cur = new Date(sorted[i].time);
        const prevTime = new Date(sorted[i - 1].time);
        if (cur.getTime() - prevTime.getTime() > GAP_LIMIT_MS) break;
        episodeStart = prevTime;
      }

      const winEnd = episodeStart;
      const winStart = new Date(episodeStart.getTime() - 30 * 60 * 1000);
      const pad2 = n => String(n).padStart(2, "0");
      const dateStr = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
      const timeStr = d => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

      const { list, errMsg } = await fetchEqdbSearch({
        startDate: dateStr(winStart), startTime: timeStr(winStart),
        endDate: dateStr(winEnd), endTime: timeStr(winEnd),
        minMag: 0, maxInt: "1", sort: "S3", epi: "99", // S3: 地震の規模(M)の大きい順
      });
      if (errMsg || !list || list.length === 0) {
        setCausingQuakeState(prev => ({ ...prev, [id]: { status: "notfound", quake: null } }));
        return;
      }
      const top = list[0]; // 規模が最大の1件
      const [detail, geo] = await Promise.all([fetchEqdbEventCached(top.id), loadGeoData()]);
      if (!detail) {
        setCausingQuakeState(prev => ({ ...prev, [id]: { status: "notfound", quake: null } }));
        return;
      }
      const card = buildEqdbQuakeCard(detail, top, stations, geo?.areas);
      setCausingQuakeState(prev => ({ ...prev, [id]: { status: "done", quake: card } }));
    } catch (err) {
      console.error("津波を引き起こした地震の検索に失敗:", err);
      setCausingQuakeState(prev => ({ ...prev, [id]: { status: "error", quake: null } }));
    }
  }

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
  // 「各地の震度」の詳細画面(震度キーごとの地域一覧)を開いている場合の、その震度キー。
  // StationPointsList内の✕ボタンだけでなく、フローティングの外にある丸い
  // 「戻る」ボタンでも閉じられるようにするため、stateをここ(親)に持ち上げている。
  const [stationDetailOpenKey, setStationDetailOpenKey] = useState(null);
  // 「この地震の詳細」(発震機構解)画面を開いているかどうか。
  // stationDetailOpenKeyと同様、外の「戻る」ボタンで閉じられるよう親に持ち上げている。
  const [mechDetailOpen, setMechDetailOpen] = useState(false);
  useEffect(() => {
    if (selectedQuakeId == null) {
      setNearbyQuakeFor(null);
      setNearbyOriginId(null);
      setStationDetailOpenKey(null);
      setMechDetailOpen(false);
    }
  }, [selectedQuakeId]);

  /* ─────────────────────────────────────────────────────
     震央分布(地図上に丸で重ねて表示し、タップで選択できるようにする機能)。
     P2P地震一覧(quakes)・近傍地震検索(NearbyQuakesPanel)・データベース検索
     (QuakeSearchPanel)のうち、「今どれを表示中か」に応じて1つだけをMapCanvasに
     渡す。個別の地震を選択して詳細を見ている間は、震源のバツ印だけで十分なため
     分布は消す。
     近傍・検索の2つは、生の一覧に座標が無く、子コンポーネント側で
     バックグラウンド解決した点をonPointsChangeで受け取って保持している。
     ───────────────────────────────────────────────────── */
  const [nearbyEpicenterPoints, setNearbyEpicenterPoints] = useState([]);
  const [searchEpicenterPoints, setSearchEpicenterPoints] = useState([]);
  // 震央分布の丸を、まだ全件分バックグラウンド解決しきっていない間のフラグ。
  // 地図側でローディング表示を出すために使う。
  const [nearbyEpicenterLoading, setNearbyEpicenterLoading] = useState(false);
  const [searchEpicenterLoading, setSearchEpicenterLoading] = useState(false);

  const selectedForMap = quakes.find(q => q.id === selectedQuakeId)
    || (searchQuake && searchQuake.id === selectedQuakeId ? searchQuake : null);

  const activeEpicenterPoints = useMemo(() => {
    if (!epicenterCirclesEnabled) return []; // 設定でOFFなら常に非表示
    if (active !== "quake") return [];
    if (nearbyQuakeFor) return nearbyEpicenterPoints;
    if (selectedForMap) return []; // 個別の地震の詳細表示中は分布を出さない
    if (quakeViewMode === "search") return searchEpicenterPoints;
    return quakes
      .filter(q => Number.isFinite(q.latitude) && Number.isFinite(q.longitude))
      .map(q => ({
        id: q.id,
        latitude: q.latitude,
        longitude: q.longitude,
        magnitude: q.magnitude,
        maxIntensityKey: q.maxIntensity,
        time: q.time,
        depth: q.depth,
        place: q.place,
      }));
  }, [epicenterCirclesEnabled, active, nearbyQuakeFor, nearbyEpicenterPoints, selectedForMap, quakeViewMode, searchEpicenterPoints, quakes]);

  useEffect(() => {
    onEpicenterPointsChange?.(activeEpicenterPoints);
  }, [activeEpicenterPoints]);

  // 震央分布の丸がまだ読み込み中かどうかも、表示中の分布(近傍/検索)に応じて同様に選ぶ。
  const activeEpicenterLoading = useMemo(() => {
    if (!epicenterCirclesEnabled) return false;
    if (active !== "quake") return false;
    if (nearbyQuakeFor) return nearbyEpicenterLoading;
    if (selectedForMap) return false;
    if (quakeViewMode === "search") return searchEpicenterLoading;
    return false;
  }, [epicenterCirclesEnabled, active, nearbyQuakeFor, nearbyEpicenterLoading, selectedForMap, quakeViewMode, searchEpicenterLoading]);

  useEffect(() => {
    onEpicenterLoadingChange?.(activeEpicenterLoading);
  }, [activeEpicenterLoading]);

  // 地震タブの「戻る」ボタン(フローティングの外にある丸ボタン)の挙動。
  // 手前で開いている画面から順に閉じていくスタック式:
  //   1. 「この地震の詳細」(発震機構解)画面を開いていれば、まずそれを閉じる
  //   2. 「各地の震度」の詳細画面(震度キーごとの地域一覧)を開いていれば、それを閉じる
  //   3. 「近傍の地震」一覧を開いていれば、それを閉じる
  //   4. 近傍一覧から選んだ地震の詳細を見ていれば、元の地震の近傍一覧に戻す
  //   5. どれでもなければ、選択解除して一覧に戻る
  // ✕ボタン(StationPointsList内)はこれとは別に残したままにしている。
  function handleBackFromQuake() {
    killScrollMomentum();
    if (mechDetailOpen) {
      setMechDetailOpen(false);
      return;
    }
    if (stationDetailOpenKey != null) {
      setStationDetailOpenKey(null);
      return;
    }
    if (nearbyQuakeFor) {
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
  }
  const backFromQuakeLabel =
    mechDetailOpen ? "地震の詳細に戻る" :
    stationDetailOpenKey != null ? "地震の詳細に戻る" :
    nearbyQuakeFor ? "地震の詳細に戻る" :
    nearbyOriginId ? "近傍地震一覧に戻る" :
    "地震一覧に戻る";

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

  // 津波タブ版のhandleSelectQuakeForScroll。地震タブと同じく、選択した瞬間に
  // パネルの高さを「中」に揃える。
  function handleSelectTsunamiForScroll(id) {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    killScrollMomentum();
    onSelectTsunami(id);
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
  const prevScrollDepsRef = useRef({ active, quakeViewMode, tsunamiViewMode, selectedQuakeId });
  useLayoutEffect(() => {
    if (!scrollRef.current) return;
    const prev = prevScrollDepsRef.current;
    const onlyDeselected =
      prev.active === active && prev.quakeViewMode === quakeViewMode && prev.tsunamiViewMode === tsunamiViewMode &&
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
    prevScrollDepsRef.current = { active, quakeViewMode, tsunamiViewMode, selectedQuakeId };
    // settingsPath(設定の階層メニュー内の画面遷移。例: ライセンス一覧→個別ライセンス詳細)や
    // stationDetailOpenKey(「各地の震度」の詳細画面)は、同じscrollRefを共有したまま
    // 中身の高さだけ変わる。これらの変化時にscrollTopをリセットしないと、深くスクロール
    // した状態で戻った時、新しい(短い)中身に対して古い(大きい)scrollTopが残ったままになり、
    // 中身が全部スクロールアウトして「フローティング内が何も表示されない」ように見える不具合が起きる。
  }, [active, selectedQuakeId, quakeViewMode, tsunamiViewMode, nearbyQuakeFor, settingsPath, stationDetailOpenKey, mechDetailOpen]);


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

  // 「今、自分(タブタップの開閉トグル)が開いた状態にしているか」を表すref。
  // タブ切り替えで開いた場合もここを立てておくことで、直後の同じタブの再タップで
  // 正しく閉じられるようにする(現在のsnapIndexの読み取りには依存しない)。
  const openedByTapRef = useRef(false);

  // 別のタブに切り替えた時は、フローティングを「中高」まで開く。
  // (同じタブを再タップした時の開閉トグルとは別物なので、prevActiveRefで
  // 「本当にタブが変わった時だけ」を判定している)
  const prevActiveRef = useRef(active);
  useEffect(() => {
    if (prevActiveRef.current !== active) {
      killScrollMomentum();
      setSnapIndex(3);
      openedByTapRef.current = true;
    }
    prevActiveRef.current = active;
  }, [active]);

  // タブバーで、既にアクティブなタブがもう一度タップされた時(navCollapseSignalの変化で検知)、
  // フローティングを開閉トグルする。前回タップ(またはタブ切り替え)で自分が開いたかどうかを
  // refで直接管理し、現在のsnapIndexの読み取り(ドラッグ操作等の影響を受けうる)には依存しないようにする。
  const isFirstNavCollapseRender = useRef(true);
  useEffect(() => {
    if (isFirstNavCollapseRender.current) {
      isFirstNavCollapseRender.current = false;
      return;
    }
    killScrollMomentum();
    if (openedByTapRef.current) {
      openedByTapRef.current = false;
      setSnapIndex(0);
    } else {
      openedByTapRef.current = true;
      setSnapIndex(3);
    }
  }, [navCollapseSignal]);

  // 親から渡される layerOpen(真偽値)を 低(0)⇄高(4) として反映する。
  // ドラッグで内部的に決めたスナップを、ここで二重に上書きしないようrefで判定する。
  const lastLayerOpen = useRef(layerOpen);
  useEffect(() => {
    if (layerOpen !== lastLayerOpen.current) {
      lastLayerOpen.current = layerOpen;
      setSnapIndex(layerOpen ? (active === "quake" ? 3 : 4) : 0);
    }
  }, [layerOpen, active]);

  // 震央分布(地図上の丸)をタップして地震を選択した時も、一覧内から選んだ時
  // (handleSelectQuakeForScroll)と同じく、フローティングの高さを「中」に揃える。
  // mapSelectSignalは「丸がタップされるたびに1増える」だけの値なので、
  // 初回マウント時(値が変わっていない)には反応しないようにしておく。
  const lastMapSelectSignal = useRef(mapSelectSignal);
  useEffect(() => {
    if (mapSelectSignal !== lastMapSelectSignal.current) {
      lastMapSelectSignal.current = mapSelectSignal;
      setSnapIndex(1);
      // 近傍の地震一覧を開いたまま丸をタップした場合、一覧側の表示を優先してしまい
      // (a)フローティングに選んだ地震の詳細が出ない (b)他の丸が消えない、という
      // 2つの不具合につながるため、丸タップでの選択は一覧表示(nearbyQuakeFor)を
      // 閉じる。ただしnearbyOriginIdは残す — これは一覧内の行をタップして選んだ時
      // (NearbyQuakesPanelのonSelectQuake)と同じ挙動で、これを消してしまうと
      // 「戻る」を押した時に近傍一覧へ戻れず、最初の画面まで戻ってしまう。
      setNearbyQuakeFor(null);
    }
  }, [mapSelectSignal]);

  // 地震の選択が「あり→なし」に変わった(=戻るボタンで選択解除された)ら、
  // 詳細カード表示の「中」から一覧表示の「中高」へ戻す。
  const lastSelectedQuakeId = useRef(selectedQuakeId);
  useEffect(() => {
    if (lastSelectedQuakeId.current != null && selectedQuakeId == null) {
      setSnapIndex(3);
    }
    lastSelectedQuakeId.current = selectedQuakeId;
  }, [selectedQuakeId]);

  // 津波タブ版。考え方は地震タブとまったく同じ。
  const lastSelectedTsunamiId = useRef(selectedTsunamiId);
  useEffect(() => {
    if (lastSelectedTsunamiId.current != null && selectedTsunamiId == null) {
      setSnapIndex(3);
    }
    lastSelectedTsunamiId.current = selectedTsunamiId;
  }, [selectedTsunamiId]);

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
              onClick={handleBackFromQuake}
              label={backFromQuakeLabel}
            />
            <div style={{ marginTop: 12 }}>
              {areaFillEnabled && (
                <StationMarkerToggleButton visible={stationMarkersVisible} onClick={onToggleStationMarkersVisible}/>
              )}
            </div>
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
          <div style={{ marginBottom: 12 }}>
            {areaFillEnabled && (
              <StationMarkerToggleButton visible={stationMarkersVisible} onClick={onToggleStationMarkersVisible}/>
            )}
          </div>
          <BackToListButton
            onClick={handleBackFromQuake}
            label={backFromQuakeLabel}
          />
        </div>
        )
      )}

      {/* 津波タブ版。地震タブの戻るボタンと全く同じ考え方。観測点表示切替ボタンは
          「引き起こした地震」を表示している間だけ出す(通常の津波一覧には観測点が無いため)。 */}
      {active === "tsunami" && (selectedTsunamiId != null || (tsunamiViewMode === "tidegauge" && selectedTideStationCode != null)) && (
        isWide && wideAnchorRect ? createPortal(
          <div style={{
            position: "fixed",
            left: wideAnchorRect.right + 12,
            top: wideAnchorRect.top + 16,
            zIndex: 50,
          }}>
            <BackToListButton
              onClick={handleBackFromTsunami}
              label={backFromTsunamiLabel}
            />
            {causingQuakeFound && (
              <div style={{ marginTop: 12 }}>
                <StationMarkerToggleButton visible={stationMarkersVisible} onClick={onToggleStationMarkersVisible}/>
              </div>
            )}
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
          {causingQuakeFound && (
            <div style={{ marginBottom: 12 }}>
              <StationMarkerToggleButton visible={stationMarkersVisible} onClick={onToggleStationMarkersVisible}/>
            </div>
          )}
          <BackToListButton
            onClick={handleBackFromTsunami}
            label={backFromTsunamiLabel}
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

        {/* 津波タブの「一覧⇄過去」切り替えバー — 地震タブと全く同じ考え方。
            津波情報を選択してカード表示になっている間は不要なので隠す。 */}
        {active === "tsunami" && selectedTsunamiId == null && (
          <QuakeListToolbar
            items={TSUNAMI_TOOLBAR_ITEMS}
            mode={tsunamiViewMode}
            onModeChange={(mode) => { killScrollMomentum(); setTsunamiViewMode(mode); }}
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
          key={`${active}:${quakeViewMode}:${tsunamiViewMode}:${selectedQuakeId != null}:${selectedTsunamiId != null}`}
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
                            onPointsChange={setNearbyEpicenterPoints}
                            onLoadingChange={setNearbyEpicenterLoading}
                            epicenterCirclesEnabled={epicenterCirclesEnabled}
                            onSelectQuake={(id) => {
                              if (scrollRef.current) nearbyListScrollTopRef.current = scrollRef.current.scrollTop;
                              setNearbyQuakeFor(null);
                              handleSelectQuakeForScroll(id);
                            }}
                          />
                        </div>
                      );
                    }
                    if (mechDetailOpen) {
                      return (
                        <div key={`${selected.id}:mech`}>
                          <QuakeMechDetailPanel quake={selected}/>
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
                          <StationPointsList points={stationPoints} displayMode={stationListDisplayMode}
                            openKey={stationDetailOpenKey} onOpenKeyChange={setStationDetailOpenKey}/>
                        )}
                        {/* 発震機構解はおおむねM5.0以上でないと気象庁側で解析されないため、
                            それ未満の地震ではボタン自体を出さない。 */}
                        {selected.magnitude != null && selected.magnitude >= 5.0 && (
                          <div style={{ margin: "8px 14px 4px" }}>
                            <PressableButton
                              type="button"
                              onClick={() => {
                                if (scrollRef.current) scrollRef.current.scrollTop = 0;
                                setMechDetailOpen(true);
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
                              この地震の詳細
                            </PressableButton>
                          </div>
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
                        onPointsChange={setSearchEpicenterPoints}
                        onLoadingChange={setSearchEpicenterLoading}
                        epicenterCirclesEnabled={epicenterCirclesEnabled}
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
            ) : active === "tsunami" ? (
              <>
                <TsunamiTabBody
                  tsunamis={tsunamis}
                  status={tsunamiStatus}
                  selectedId={selectedTsunamiId}
                  onSelect={handleSelectTsunamiForScroll}
                  viewMode={tsunamiViewMode}
                  historyItems={tsunamiHistory?.items ?? EMPTY_EQDB_LIST}
                  historyStatus={tsunamiHistory?.status ?? "idle"}
                  historyHasMore={tsunamiHistory?.hasMore ?? true}
                  historyDebug={tsunamiHistory?.debug ?? ""}
                  onLoadMoreHistory={onLoadMoreTsunamiHistory}
                  onFindCausingQuake={handleFindCausingQuake}
                  causingQuakeState={causingQuakeState}
                  showingCausingQuakeFor={showingCausingQuakeFor}
                  onBackFromCausingQuake={handleBackFromCausingQuake}
                  stationListDisplayMode={stationListDisplayMode}
                  causingQuakeStationOpenKey={causingQuakeStationOpenKey}
                  onChangeCausingQuakeStationOpenKey={setCausingQuakeStationOpenKey}
                  tideStations={tideStations}
                  tideStationsStatus={tideStationsStatus}
                  selectedTideStationCode={selectedTideStationCode}
                  onSelectTideStation={onSelectTideStation}
                  tideObsByStation={tideObsByStation}
                  onLoadTideObs={onLoadTideObs}
                />

                {/* フローティング部分(津波情報一覧)とボタン類(ナビ行)の境界線 */}
                <div style={{ height: 0.5, background: `rgba(${tokens.ink},0.22)`, margin: "2px 0 0" }}/>
              </>
            ) : active === "settings" ? (
              <>
                <SettingsBody
                  path={settingsPath}
                  onNavigate={handleSettingsNavigate}
                  colorSchemeId={colorSchemeId}
                  onChangeColorScheme={onChangeQuakeColorScheme}
                  estIntensityEnabled={estIntensityEnabled}
                  onChangeEstIntensityEnabled={onChangeEstIntensityEnabled}
                  areaFillEnabled={areaFillEnabled}
                  onChangeAreaFillEnabled={onChangeAreaFillEnabled}
                  faultsEnabled={faultsEnabled}
                  onChangeFaultsEnabled={onChangeFaultsEnabled}
                  plateBoundariesEnabled={plateBoundariesEnabled}
                  onChangePlateBoundariesEnabled={onChangePlateBoundariesEnabled}
                  epicenterCirclesEnabled={epicenterCirclesEnabled}
                  onChangeEpicenterCirclesEnabled={onChangeEpicenterCirclesEnabled}
                  boundaryLineColorId={boundaryLineColorId}
                  onChangeBoundaryLineColorId={onChangeBoundaryLineColorId}
                  quakeFetchLimit={quakeFetchLimit}
                  onChangeQuakeFetchLimit={onChangeQuakeFetchLimit}
                  stationListDisplayMode={stationListDisplayMode}
                  onChangeStationListDisplayMode={onChangeStationListDisplayMode}
                  experimentalFeaturesEnabled={experimentalFeaturesEnabled}
                  onChangeExperimentalFeaturesEnabled={onChangeExperimentalFeaturesEnabled}
                  testTsunami={testTsunami}
                  onBroadcastTestTsunami={onBroadcastTestTsunami}
                  onCancelTestTsunami={onCancelTestTsunami}
                  onClearTestTsunami={onClearTestTsunami}
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
            backdropFilter: (navPressed || navDragging) && !glassOpaque ? touchGlassBackdropFilter(mode) : "none",
            WebkitBackdropFilter: (navPressed || navDragging) && !glassOpaque ? touchGlassBackdropFilter(mode) : "none",
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
   TSUNAMI GRADE LEGEND — QuakeIntensityLegendと全く同じ見た目
   (横一列に並んだ隙間の詰まった色バー)にした版。震度のような連続した
   尺度が無いため、「1〜最大」ではなく、現在地図に塗っている予報区
   (areas)に実際に含まれるgradeだけを、危険度が低い順に並べる。
   最も危険度が高いバーだけ枠線で強調する。画面右上に浮かべて使う想定。
   ───────────────────────────────────────────────────── */
function TsunamiGradeLegend({ areas }) {
  const { tokens } = useContext(ThemeContext);
  const gradesPresent = [...new Set((areas || []).map(a => a.grade))]
    .sort((a, b) => tsunamiGradeInfo(a).weight - tsunamiGradeInfo(b).weight);
  if (gradesPresent.length === 0) return null;
  const maxWeight = Math.max(...gradesPresent.map(g => tsunamiGradeInfo(g).weight));

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
        {gradesPresent.map(grade => {
          const info = tsunamiGradeInfo(grade);
          const isMax = info.weight === maxWeight;
          return (
            // 震度凡例のミニバーと同じ、隙間の詰まった横一列のバー
            <div
              key={grade}
              style={{
                width: 7, height: 16, borderRadius: 2,
                background: info.color,
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
/* ─────────────────────────────────────────────────────
   STATION MARKER TOGGLE BUTTON — 地図上の観測点マーカーの表示/非表示を切り替える。
   表示中は点線の円、非表示中は実線の円のアイコンにする(BackToListButtonと
   同じ44×44の丸いGlassボタン)。
   ───────────────────────────────────────────────────── */
function StationMarkerToggleButton({ visible, onClick }) {
  const { tokens } = useContext(ThemeContext);
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
        aria-label={visible ? "観測点の表示を消す" : "観測点を表示する"}
        style={{
          position: "relative", zIndex: 1,
          width: "100%", height: "100%",
          display: "flex", alignItems: "center", justifyContent: "center",
          color: tokens.text,
        }}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none"
             stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="9.5" strokeDasharray={visible ? "3 3" : undefined}/>
        </svg>
      </button>
    </Glass>
  );
}

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
   HISTORY ICON — 時計(履歴)アイコン。津波タブの「過去」モードで使う。
   ───────────────────────────────────────────────────── */
function HistoryClockIcon({ size = 18 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none"
         stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12.5" r="8.5"/>
      <path d="M12 8v4.5l3 2"/>
      <path d="M9 2.5h6"/>
    </svg>
  );
}

/* ─────────────────────────────────────────────────────
   TIDE GAUGE ICON — 潮位計タブ用。目盛り付きの棒+波線で「水位計」を表す。
   ───────────────────────────────────────────────────── */
function TideGaugeIcon({ size = 18 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none"
         stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 21V4.5"/>
      <path d="M6 7h2.5"/>
      <path d="M6 11h2.5"/>
      <path d="M6 15h2.5"/>
      <path d="M11 15c1.4-1.6 2.9-1.6 4.3 0s2.9 1.6 4.3 0"/>
    </svg>
  );
}

/* ─────────────────────────────────────────────────────
   QUAKE LIST ROW
   地震一覧の1行分。「直近の一覧」と「検索結果一覧」の両方から共通で使う。
   ───────────────────────────────────────────────────── */
function QuakeListRow({ quake: q, showDivider, colorScheme, onSelect, loading = false }) {
  const { tokens } = useContext(ThemeContext);

  const style = getIntensityStyleFromScheme(colorScheme, q.maxIntensity || "1");
  return (
    <div>
      {showDivider && <div style={{ height: 0.5, background: `rgba(${tokens.ink},0.08)`, marginLeft: 18 }}/>}
      <PressableButton
        onClick={loading ? undefined : onSelect}
        style={{
          width: "100%", display: "flex", alignItems: "center", gap: 10,
          padding: "9px 14px",
          background: "transparent",
          textAlign: "left",
          opacity: loading ? 0.5 : 1,
          pointerEvents: loading ? "none" : "auto",
        }}
      >
        {loading ? (
          <span style={{
            flexShrink: 0, width: 28, height: 22, borderRadius: 6,
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <span style={{
              width: 13, height: 13, borderRadius: "50%",
              border: `2px solid rgba(${tokens.ink},0.25)`,
              borderTopColor: `rgba(${tokens.ink},0.9)`,
              animation: "spin 0.8s linear infinite",
              display: "block",
            }}/>
          </span>
        ) : (
          <span style={{
            flexShrink: 0, width: 28, height: 22, borderRadius: 6,
            background: style.bg, color: style.fg,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: q.isForeign ? 9 : 11, fontWeight: 800,
          }}>
            {q.isForeign ? "遠地" : style.label}
          </span>
        )}
        <span style={{
          flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: tokens.text,
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }}>
          {loading ? `${q.place}を読み込み中…` : q.place}
        </span>
        {!loading && (q.magnitude != null || q.depth != null) && (
          <span className="mono" style={{
            fontSize: 11, color: `rgba(${tokens.ink},0.5)`,
            flexShrink: 0, whiteSpace: "nowrap",
          }}>
            M{q.magnitude != null ? q.magnitude.toFixed(1) : "-"}{q.depth != null ? (q.depth === 0 ? "・ごく浅い" : `・深さ${q.depth}km`) : "・深さ-"}
          </span>
        )}
        {!loading && (
          <span className="mono" style={{ fontSize: 10, color: `rgba(${tokens.ink},0.4)`, flexShrink: 0 }}>
            {q.isEqdb ? q.time?.slice(0, 10) : q.time?.slice(5, 16)}
          </span>
        )}
      </PressableButton>
    </div>
  );
}

/* ─────────────────────────────────────────────────────
   TSUNAMI LIST ROW — 津波情報一覧の1行(QuakeListRowと対の構成)
   震度のような1〜2文字の共通表記が無いため、バッジは「大津波/警報/注意/予報/解除」
   の短縮ラベルをグレード色の背景で表示する。
   ───────────────────────────────────────────────────── */
function tsunamiShortLabel(card) {
  if (card.cancelled) return "解除";
  return tsunamiGradeShortLabel(card.maxGrade);
}
function tsunamiFullLabel(card) {
  if (card.cancelled) return "津波予報・警報の解除";
  return tsunamiGradeInfo(card.maxGrade).label;
}

function TsunamiListRow({ tsunami: t, showDivider, onSelect, isHistory = false }) {
  const { tokens } = useContext(ThemeContext);

  const color = t.cancelled ? TSUNAMI_GRADE_FALLBACK.color : tsunamiGradeInfo(t.maxGrade).color;
  const areaCount = t.areas.length;

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
          flexShrink: 0, width: 40, height: 22, borderRadius: 6,
          background: color, color: "#000",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 11, fontWeight: 800, whiteSpace: "nowrap",
        }}>
          {tsunamiShortLabel(t)}
        </span>
        <span style={{
          flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: tokens.text,
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }}>
          {tsunamiFullLabel(t)}
        </span>
        {t.isTest && (
          <span style={{
            flexShrink: 0, fontSize: 9.5, fontWeight: 800, color: "#fff",
            background: "#FF453A", borderRadius: 4, padding: "2px 5px",
          }}>
            テスト
          </span>
        )}
        {!t.cancelled && areaCount > 0 && (
          <span className="mono" style={{
            fontSize: 11, color: `rgba(${tokens.ink},0.5)`,
            flexShrink: 0, whiteSpace: "nowrap",
          }}>
            {areaCount}区域
          </span>
        )}
        <span className="mono" style={{ fontSize: 10, color: `rgba(${tokens.ink},0.4)`, flexShrink: 0 }}>
          {isHistory ? t.time?.slice(0, 10) : t.time?.slice(5, 16)}
        </span>
      </PressableButton>
    </div>
  );
}

/* ─────────────────────────────────────────────────────
   TSUNAMI DETAIL CARD — QuakeDetailCardと対の構成。
   最大グレードを大きく表示し、発表時刻を添える。
   ───────────────────────────────────────────────────── */
function TsunamiDetailCard({ tsunami: t, onFindCausingQuake }) {
  const { tokens, mode } = useContext(ThemeContext);
  const color = t.cancelled ? TSUNAMI_GRADE_FALLBACK.color : tsunamiGradeInfo(t.maxGrade).color;
  const textColor = mode === "dark" ? "#ffffff" : "#000000";

  return (
    <div
      style={{
        position: "relative",
        margin: "2px 14px 4px",
        borderRadius: 16,
        padding: "7px 16px",
        display: "flex",
        alignItems: "center",
        gap: 14,
        background: `linear-gradient(135deg, ${color}22, ${color}0E)`,
        boxShadow: `inset 0 0 0 0.5px rgba(${tokens.ink},0.12)`,
        animation: "appear 0.35s cubic-bezier(.25,1,.5,1)",
      }}
    >
      {t.isTest && (
        <span style={{
          position: "absolute", top: 6, left: 10,
          fontSize: 9.5, fontWeight: 800, color: "#fff",
          background: "#FF453A", borderRadius: 4, padding: "2px 6px",
        }}>
          テスト配信
        </span>
      )}
      {/* グレード名を表示する、色付き枠線の角丸バッジ(横幅2倍・QuakeDetailCardと同じ高さ)。
          枠線のさらに外側を白い線(box-shadowのリング)で囲っている。 */}
      <div style={{ flexShrink: 0 }}>
        <div
          style={{
            width: 128, height: 80,
            borderRadius: 14,
            border: `2px solid ${color}`,
            background: `${color}14`,
            boxShadow: "0 0 0 2px #ffffff",
            display: "flex", alignItems: "center", justifyContent: "center",
            padding: "4px 6px",
          }}
        >
          <span style={{ fontSize: 20, fontWeight: 800, color: textColor, textAlign: "center", lineHeight: 1.15 }}>
            {tsunamiFullLabel(t)}
          </span>
        </div>
      </div>

      {/* 発表時刻(小さめ)。右下のボタンと重ならないよう、少し上寄りに配置する。 */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2, paddingBottom: 16 }}>
        <span className="mono" style={{ fontSize: 14, fontWeight: 800, color: tokens.text, lineHeight: 1.2, whiteSpace: "nowrap" }}>
          {formatTsunamiTimeShort(t.time)}
        </span>
        <span style={{ fontSize: 12, fontWeight: 500, color: `rgba(${tokens.ink},0.5)` }}>
          {t.cancelled ? "解除" : "発表"}
        </span>
      </div>

      {/* 「↪︎津波を引き起こした地震」— 右下に絶対配置し、カードの高さには影響させない */}
      {onFindCausingQuake && (
        <PressableButton
          type="button"
          onClick={onFindCausingQuake}
          style={{
            position: "absolute", right: 8, bottom: 6,
            display: "flex", alignItems: "center", gap: 3,
            padding: "3px 8px", borderRadius: 999,
            border: "none", cursor: "pointer",
            background: `rgba(${tokens.ink},0.08)`,
            color: `rgba(${tokens.ink},0.7)`,
            fontSize: 10, fontWeight: 600, whiteSpace: "nowrap",
          }}
        >
          ↪︎津波を引き起こした地震
        </PressableButton>
      )}
    </div>
  );
}

// 津波予報区1件分の行。グレード色で背景・左枠線をつけ、到達予想時刻(または
// 「ただちに」等の文言)・予想の高さを添える。
// 津波予報区1件分の行(震度観測点リストのStationPointsList「一覧」表示と対の構成)。
// グレード色の短縮バッジ+予報区名+到達予想時刻や高さの補足、という並びにしている。
function tsunamiGradeShortLabel(grade) {
  const map = { MajorWarning: "大津波", Warning: "警報", Watch: "注意", NonEffective: "予報", Unknown: "情報" };
  return map[grade] || "情報";
}

function TsunamiAreaRow({ area, showDivider }) {
  const { tokens } = useContext(ThemeContext);
  const info = tsunamiGradeInfo(area.grade);

  let timeText = null;
  if (area.immediate) timeText = "ただちに津波が到達";
  else if (area.firstHeightCondition) timeText = area.firstHeightCondition;
  else if (area.firstHeightTime) timeText = formatQuakeTimeShort(area.firstHeightTime);
  const metaText = [area.maxHeightDescription, timeText].filter(Boolean).join("・");

  return (
    <div>
      {showDivider && <div style={{ height: 0.5, background: `rgba(${tokens.ink},0.08)`, marginLeft: 12 }}/>}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 12px" }}>
        <span style={{
          flexShrink: 0, minWidth: 34, padding: "2px 0", borderRadius: 6,
          background: info.color, color: "#000",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 11, fontWeight: 800,
        }}>
          {tsunamiGradeShortLabel(area.grade)}
        </span>
        <span style={{
          flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: tokens.text,
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }}>
          {area.name}
        </span>
        {metaText && (
          <span style={{
            fontSize: 11, color: `rgba(${tokens.ink},0.4)`,
            flexShrink: 0, whiteSpace: "nowrap",
          }}>
            {metaText}
          </span>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────
   TSUNAMI TAB BODY — 津波タブ本体。選択中の津波情報があれば詳細(グレード+
   予報区一覧)を、無ければ一覧を表示する。地震タブのQuakeListRow⇄QuakeDetailCard
   と同じ「同じスクロール領域内でその場を差し替える」構成。
   ───────────────────────────────────────────────────── */
function TsunamiTabBody({
  tsunamis, status, selectedId, onSelect,
  // 「過去」モード関連。viewModeが"history"の間は、直近一覧(tsunamis)の代わりに
  // historyItems(/history APIをoffsetで遡って追加取得した一覧)を表示する。
  // 選択中の詳細は、直近一覧・過去一覧のどちらから選んでも見られるよう両方から探す
  // (地震タブのquakes⇄searchQuakeと同じ考え方)。
  viewMode = "recent",
  historyItems = EMPTY_EQDB_LIST, historyStatus = "idle", historyHasMore = true, historyDebug = "",
  onLoadMoreHistory,
  // 「↪︎ 津波を引き起こした地震」関連。
  onFindCausingQuake, causingQuakeState = {}, showingCausingQuakeFor, onBackFromCausingQuake,
  stationListDisplayMode = "list", causingQuakeStationOpenKey, onChangeCausingQuakeStationOpenKey,
  // 「潮位計」モード関連。
  tideStations = EMPTY_EQDB_LIST, tideStationsStatus = "idle",
  selectedTideStationCode, onSelectTideStation, tideObsByStation = {}, onLoadTideObs,
}) {
  const { tokens } = useContext(ThemeContext);

  // 潮位計モードで地点が選ばれたら観測値を読み込む。早期returnより前でしか
  // hooksを呼べないため、ここで無条件に呼んでおき、中で条件分岐する。
  useEffect(() => {
    if (viewMode === "tidegauge" && selectedTideStationCode != null) {
      onLoadTideObs?.(selectedTideStationCode);
    }
  }, [viewMode, selectedTideStationCode, onLoadTideObs]);

  const selected = tsunamis.find(t => t.id === selectedId)
    || historyItems.find(t => t.id === selectedId)
    || null;

  if (selected) {
    const sortedAreas = [...selected.areas].sort((a, b) => tsunamiGradeInfo(b.grade).weight - tsunamiGradeInfo(a.grade).weight);
    const showingCausingQuake = showingCausingQuakeFor === selected.id;
    const causingState = causingQuakeState[selected.id];

    return (
      <>
        <TsunamiDetailCard tsunami={selected} onFindCausingQuake={() => onFindCausingQuake?.(selected)}/>
        {showingCausingQuake ? (
          <div style={{ margin: "2px 0 8px" }}>
            <PressableButton
              type="button"
              onClick={onBackFromCausingQuake}
              style={{
                display: "flex", alignItems: "center", gap: 4,
                margin: "0 14px 4px", padding: "6px 2px",
                background: "transparent", border: "none", cursor: "pointer",
                fontSize: 12.5, fontWeight: 600, color: `rgba(${tokens.ink},0.6)`,
              }}
            >
              ← 予報区一覧に戻る
            </PressableButton>
            {(!causingState || causingState.status === "loading") ? (
              <div style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                gap: 8, margin: "0 14px", padding: "18px 0", color: `rgba(${tokens.ink},0.45)`,
              }}>
                <div style={{
                  width: 16, height: 16, borderRadius: "50%",
                  border: `2px solid rgba(${tokens.ink},0.15)`,
                  borderTopColor: `rgba(${tokens.ink},0.6)`,
                  animation: "spin 0.8s linear infinite",
                }}/>
                <span style={{ fontSize: 12 }}>地震を読み込み中…</span>
              </div>
            ) : causingState.status === "notfound" ? (
              <div style={{ margin: "0 14px", padding: "18px 16px", textAlign: "center" }}>
                <span style={{ fontSize: 12, color: `rgba(${tokens.ink},0.4)`, lineHeight: 1.8 }}>
                  該当する地震が気象庁 震度データベースに見つかりませんでした。遠地地震の可能性があります。
                </span>
              </div>
            ) : causingState.status === "error" ? (
              <div style={{ margin: "0 14px", padding: "18px 16px", textAlign: "center" }}>
                <span style={{ fontSize: 12, color: `rgba(${tokens.ink},0.4)` }}>地震の検索に失敗しました</span>
              </div>
            ) : (
              <>
                <QuakeDetailCard quake={causingState.quake}/>
                {Array.isArray(causingState.quake.resolvedPoints) && causingState.quake.resolvedPoints.length > 0 && (
                  <StationPointsList
                    points={causingState.quake.resolvedPoints}
                    displayMode={stationListDisplayMode}
                    openKey={causingQuakeStationOpenKey}
                    onOpenKeyChange={onChangeCausingQuakeStationOpenKey}
                  />
                )}
              </>
            )}
          </div>
        ) : selected.cancelled ? (
          <div style={{
            margin: "8px 14px", padding: 14, borderRadius: 12,
            background: `rgba(${tokens.ink},0.04)`,
            fontSize: 12.5, color: `rgba(${tokens.ink},0.6)`, lineHeight: 1.8,
          }}>
            発表されていた津波の予報・警報は解除されました。
          </div>
        ) : sortedAreas.length > 0 ? (
          <div style={{ margin: "2px 14px 8px" }}>
            <div style={{
              padding: "6px 2px",
              fontSize: 11, fontWeight: 600, color: `rgba(${tokens.ink},0.5)`,
            }}>
              対象の予報区
            </div>
            <div style={{
              borderRadius: 12,
              overflow: "hidden",
              background: `rgba(${tokens.ink},0.04)`,
              boxShadow: `inset 0 0 0 0.5px rgba(${tokens.ink},0.08)`,
            }}>
              {sortedAreas.map((area, i) => (
                <TsunamiAreaRow key={`${area.name}-${i}`} area={area} showDivider={i > 0}/>
              ))}
            </div>
          </div>
        ) : (
          <div style={{
            margin: "8px 14px", padding: 14, borderRadius: 12,
            background: `rgba(${tokens.ink},0.04)`,
            fontSize: 12.5, color: `rgba(${tokens.ink},0.6)`,
          }}>
            対象区域の詳細データがありません。
          </div>
        )}
      </>
    );
  }

  // 「潮位計」モード: 地図の観測点ピンをタップして選んだ地点の、当日分の
  // 潮位・潮位偏差グラフを表示する。
  if (viewMode === "tidegauge") {
    if (selectedTideStationCode == null) {
      if (tideStationsStatus === "loading" || tideStationsStatus === "error" || tideStations.length === 0) {
        return (
          <div style={{ padding: "28px 18px", textAlign: "center" }}>
            <TideGaugeIcon size={28}/>
            <div style={{ marginTop: 10, fontSize: 12.5, color: `rgba(${tokens.ink},0.45)`, lineHeight: 1.8 }}>
              {tideStationsStatus === "loading"
                ? "潮位観測点を読み込み中…"
                : tideStationsStatus === "error"
                ? "潮位観測点の取得に失敗しました"
                : "潮位観測点が見つかりませんでした"}
            </div>
          </div>
        );
      }

      const sortedStations = [...tideStations].sort((a, b) => {
        const aw = a.activeGrade ? tsunamiGradeInfo(a.activeGrade).weight : -1;
        const bw = b.activeGrade ? tsunamiGradeInfo(b.activeGrade).weight : -1;
        if (aw !== bw) return bw - aw; // 警報グレードが高い(大津波→警報→注意報→予報)ものを先に
        const areaCmp = (a.areaName || "").localeCompare(b.areaName || "", "ja");
        return areaCmp !== 0 ? areaCmp : (a.name || "").localeCompare(b.name || "", "ja");
      });

      return (
        <>
          <div style={{ padding: "2px 14px 6px", fontSize: 11, color: `rgba(${tokens.ink},0.45)`, textAlign: "center" }}>
            地図のピンをタップするか、一覧から観測点を選んでください({sortedStations.length}地点)
          </div>
          {sortedStations.map((st, i) => (
            <TideStationListRow key={st.code} station={st} showDivider={i > 0} onSelect={() => onSelectTideStation?.(st.code)}/>
          ))}
        </>
      );
    }

    const station = tideStations.find(s => s.code === selectedTideStationCode);
    const obs = tideObsByStation[selectedTideStationCode];

    return (
      <TideStationDetail
        station={station}
        obs={obs}
      />
    );
  }

  // 「過去」モード: /history APIをoffsetで遡って取得した過去の津波情報一覧を表示する。
  // 末尾に「もっと見る」ボタンを置き、押すたびにさらに古い分を追加取得する。
  if (viewMode === "history") {
    if (historyStatus === "loading" && historyItems.length === 0) {
      return (
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
          <span style={{ fontSize: 12 }}>過去の津波情報を取得中…</span>
        </div>
      );
    }

    if (historyStatus === "error" && historyItems.length === 0) {
      return (
        <div style={{ padding: "18px 16px", textAlign: "center" }}>
          <span style={{ fontSize: 12, color: `rgba(${tokens.ink},0.4)` }}>過去の津波情報の取得に失敗しました</span>
          {historyDebug && (
            <div style={{ marginTop: 6, fontSize: 11, color: `rgba(${tokens.ink},0.35)`, wordBreak: "break-all" }}>{historyDebug}</div>
          )}
        </div>
      );
    }

    if (historyItems.length === 0) {
      return (
        <div style={{ padding: "18px 16px", textAlign: "center" }}>
          <span style={{ fontSize: 12, color: `rgba(${tokens.ink},0.4)` }}>過去の津波情報が見つかりませんでした</span>
          {historyDebug && (
            <div style={{ marginTop: 6, fontSize: 11, color: `rgba(${tokens.ink},0.35)`, wordBreak: "break-all" }}>{historyDebug}</div>
          )}
        </div>
      );
    }

    return (
      <>
        <div style={{ padding: "2px 14px 6px", fontSize: 11, color: `rgba(${tokens.ink},0.45)`, textAlign: "center" }}>
          {historyItems.length}件を表示中
        </div>
        {historyItems.map((t, i) => (
          <TsunamiListRow key={t.id} tsunami={t} showDivider={i > 0} onSelect={() => onSelect(t.id)} isHistory/>
        ))}
        {historyHasMore && (
          <div style={{ margin: "12px 14px 6px" }}>
            <PressableButton
              type="button"
              onClick={onLoadMoreHistory}
              disabled={historyStatus === "loading"}
              style={{
                width: "100%", padding: "10px 12px", borderRadius: 12,
                border: "none", cursor: "pointer",
                background: `rgba(${tokens.ink},0.06)`,
                boxShadow: `inset 0 0 0 0.5px rgba(${tokens.ink},0.12)`,
                color: `rgba(${tokens.ink},0.75)`, fontSize: 13, fontWeight: 600,
                display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                opacity: historyStatus === "loading" ? 0.55 : 1,
              }}
            >
              {historyStatus === "loading" ? (
                <>
                  <div style={{
                    width: 13, height: 13, borderRadius: "50%",
                    border: `2px solid rgba(${tokens.ink},0.2)`,
                    borderTopColor: `rgba(${tokens.ink},0.7)`,
                    animation: "spin 0.8s linear infinite",
                  }}/>
                  <span>読み込み中…</span>
                </>
              ) : (
                <>
                  <HistoryClockIcon size={14}/>
                  <span>もっと見る</span>
                </>
              )}
            </PressableButton>
          </div>
        )}
      </>
    );
  }

  if (status === "loading" && tsunamis.length === 0) {
    return (
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
        <span style={{ fontSize: 12 }}>津波情報を取得中…</span>
      </div>
    );
  }

  if (status === "error" && tsunamis.length === 0) {
    return (
      <div style={{ padding: "28px 18px", textAlign: "center", fontSize: 12.5, color: `rgba(${tokens.ink},0.45)`, lineHeight: 1.8 }}>
        津波情報の取得に失敗しました。
      </div>
    );
  }

  if (tsunamis.length === 0) {
    return (
      <div style={{ padding: "28px 18px", textAlign: "center", fontSize: 12.5, color: `rgba(${tokens.ink},0.45)` }}>
        現在発表されている津波予報・警報はありません
      </div>
    );
  }

  return (
    <>
      {tsunamis.map((t, i) => (
        <TsunamiListRow key={t.id} tsunami={t} showDivider={i > 0} onSelect={() => onSelect(t.id)}/>
      ))}
    </>
  );
}


/* ─────────────────────────────────────────────────────
   TIDE STATION DETAIL — 潮位計モードで地点を選んだ時の表示。
   気象庁の潮位観測ページ(map.html#contents=tidelevel)のグラフ画面を
   参考に、タイトルバー+潮位グラフ+潮位偏差グラフの構成にしている。
   ───────────────────────────────────────────────────── */
// tide_area.jsonのmax.datetimeは"200409080732"のような12桁(秒無し)形式。
function tideMaxDatetimeDisplay(id) {
  if (!id || id.length < 12) return "";
  return `${id.slice(0, 4)}/${id.slice(4, 6)}/${id.slice(6, 8)} ${id.slice(8, 10)}:${id.slice(10, 12)}`;
}

const TIDE_RANGE_OPTIONS = [
  { id: "1h",  label: "1時間",  hours: 1 },
  { id: "6h",  label: "6時間",  hours: 6 },
  { id: "12h", label: "12時間", hours: 12 },
  { id: "24h", label: "1日",   hours: 24 },
];

/* ─────────────────────────────────────────────────────
   TIDE STATION LIST ROW — 潮位観測点一覧の1行分。
   地震・津波の一覧行と同じ「区切り線+タップ可能な行」構成。
   ───────────────────────────────────────────────────── */
function TideStationListRow({ station, showDivider, onSelect }) {
  const { tokens } = useContext(ThemeContext);
  // addrは"北海道 小樽市 築港"のように"都道府県 市区町村 地区"の空白区切りなので、
  // 先頭(都道府県名)だけ取り出して、市区町村名(areaName)の前にスペース区切りで添える。
  const prefName = (station.addr || "").split(/[ 　]/)[0] || "";
  const gradeInfo = station.activeGrade ? tsunamiGradeInfo(station.activeGrade) : null;
  return (
    <div>
      {showDivider && <div style={{ height: 0.5, background: `rgba(${tokens.ink},0.08)`, marginLeft: 14 }}/>}
      <PressableButton
        onClick={onSelect}
        style={{
          width: "100%", display: "flex", alignItems: "center", gap: 10,
          padding: "9px 14px",
          background: "transparent",
          textAlign: "left",
        }}
      >
        {gradeInfo && (
          <span style={{
            flexShrink: 0, minWidth: 34, padding: "2px 0", borderRadius: 6,
            background: gradeInfo.color, color: "#000",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 11, fontWeight: 800,
          }}>
            {tsunamiGradeShortLabel(station.activeGrade)}
          </span>
        )}
        <span style={{
          flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: tokens.text,
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }}>
          {station.name}
        </span>
        <span style={{
          fontSize: 11, color: `rgba(${tokens.ink},0.45)`,
          flexShrink: 0, whiteSpace: "nowrap", maxWidth: "40%",
          overflow: "hidden", textOverflow: "ellipsis",
        }}>
          {prefName} {station.areaName}
        </span>
      </PressableButton>
    </div>
  );
}

function TideStationDetail({ station, obs }) {
  const { tokens, mode } = useContext(ThemeContext);
  const [rangeId, setRangeId] = useState("24h");
  const isStandalonePwa = useIsStandalonePwa();

  // ダーク/ライトそれぞれで見やすい配色。
  // (ダークでは黒基準線が見えなくなるため、ダーク時は白系に切り替える)
  const tideColor  = mode === "dark" ? "#64D2FF" : "#0A5FCC";
  const astroColor = mode === "dark" ? "#FFD60A" : "#FF9500";
  const depColor   = mode === "dark" ? "#64D2FF" : "#0A5FCC";
  const level5Color = mode === "dark" ? "#F2F2F7" : "#1C1C1E";
  const level4Color = "#BF5AF2";
  const maxColor     = "#30D158";

  if (!station) {
    return (
      <div style={{ padding: "18px 16px", textAlign: "center" }}>
        <span style={{ fontSize: 12, color: `rgba(${tokens.ink},0.4)` }}>観測点の情報が見つかりませんでした</span>
      </div>
    );
  }

  // tide(実測潮位)とdeparture(潮位偏差 = 実測−天文潮位)から、天文潮位を逆算する。
  const tideValues = obs?.data?.tide;
  const departureValues = obs?.data?.departure;
  const astroValues = (Array.isArray(tideValues) && Array.isArray(departureValues))
    ? tideValues.map((v, i) => (v == null || departureValues[i] == null) ? null : v - departureValues[i])
    : null;

  // 選択中の表示期間(1時間〜1日)ぶんだけ、末尾から切り出す。
  const intervalSec = obs?.data?.interval || 15;
  const samplesPerHour = 3600 / intervalSec;
  const rangeHours = TIDE_RANGE_OPTIONS.find(r => r.id === rangeId)?.hours ?? 24;
  const windowSamples = Math.max(1, Math.round(rangeHours * samplesPerHour));
  const fullLen = Array.isArray(tideValues) ? tideValues.length : 0;
  const windowStartIndex = Math.max(0, fullLen - windowSamples);
  const windowSlice = arr => (Array.isArray(arr) ? arr.slice(windowStartIndex) : []);
  const tideWindowed = windowSlice(tideValues);
  const astroWindowed = astroValues ? windowSlice(astroValues) : null;
  const departureWindowed = windowSlice(departureValues);
  const dayStart = obs?.data?.time ? new Date(obs.data.time) : null;
  const windowStartTime = dayStart ? new Date(dayStart.getTime() + windowStartIndex * intervalSec * 1000) : null;

  return (
    <div style={{ padding: "2px 14px 12px" }}>
      {/* タイトルバー — 気象庁の潮位ページと同じ「市町村名 観測所:地点名[種別]」表記 */}
      <div style={{
        borderRadius: 10, padding: "10px 12px", marginBottom: 10,
        background: "#0A84FF", color: "#ffffff",
      }}>
        <span style={{ fontSize: 13.5, fontWeight: 700 }}>
          {station.areaName}　観測所：{station.name}[{station.typeName}]
        </span>
      </div>

      {!obs || obs.status === "loading" ? (
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
          <span style={{ fontSize: 12 }}>潮位データを読み込み中…</span>
        </div>
      ) : obs.status === "error" ? (
        <div style={{ padding: "18px 16px", textAlign: "center" }}>
          <span style={{ fontSize: 12, color: `rgba(${tokens.ink},0.4)` }}>
            本日分の潮位データがまだ無いか、取得に失敗しました。
          </span>
        </div>
      ) : (
        <>
          {/* 表示期間(横軸の範囲)の切り替え */}
          <div style={{ display: "flex", gap: 6, padding: "2px 2px 8px" }}>
            {TIDE_RANGE_OPTIONS.map(opt => (
              <PressableButton
                key={opt.id}
                type="button"
                onClick={() => setRangeId(opt.id)}
                style={{
                  padding: "5px 10px", borderRadius: 999, border: "none", cursor: "pointer",
                  fontSize: 11.5, fontWeight: 600,
                  background: rangeId === opt.id ? "#0A84FF" : `rgba(${tokens.ink},0.08)`,
                  color: rangeId === opt.id ? "#ffffff" : `rgba(${tokens.ink},0.7)`,
                }}
              >
                {opt.label}
              </PressableButton>
            ))}
          </div>

          <Glass radius={16} style={{ padding: "10px 8px 12px" }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: `rgba(${tokens.ink},0.5)`, padding: "2px 2px 4px" }}>
              潮位(cm)
            </div>
            <TideLineChart
              series={[
                // 実際の潮位を最後(=一番手前)に描くことで、天文潮位・基準線より前面に出す。
                ...(astroWindowed ? [{ name: "天文潮位", color: astroColor, values: astroWindowed }] : []),
                { name: "実際の潮位", color: tideColor, values: tideWindowed || [] },
              ]}
              thresholds={[
                ...(station.level5 != null ? [{ label: `レベル5特別警報基準(${station.level5}cm)`, value: station.level5, color: level5Color }] : []),
                ...(station.level4 != null ? [{ label: `レベル4危険警報基準(${station.level4}cm)`, value: station.level4, color: level4Color }] : []),
                ...(station.max?.level != null ? [{ label: `過去最高潮位(${station.max.level}cm)`, value: station.max.level, color: maxColor, dashed: true }] : []),
              ]}
              startTime={windowStartTime}
              intervalSec={intervalSec}
            />

            <div style={{ fontSize: 11, fontWeight: 600, color: `rgba(${tokens.ink},0.5)`, padding: "10px 2px 4px" }}>
              潮位偏差(cm)
            </div>
            <TideLineChart
              series={[{ name: "潮位偏差", color: depColor, values: departureWindowed || [] }]}
              zeroLine
              startTime={windowStartTime}
              intervalSec={intervalSec}
            />
          </Glass>

          {station.max && (
            <div style={{ marginTop: 8, fontSize: 11, color: `rgba(${tokens.ink},0.45)`, lineHeight: 1.7 }}>
              過去最高潮位: {station.max.level}cm({tideMaxDatetimeDisplay(station.max.datetime)}・{station.max.description})
            </div>
          )}

          {station.class20Code && station.class30Code && (
            <a
              href={`https://www.jma.go.jp/bosai/tidelevel/#area_type=class20s&area_code=${station.class20Code}&point_code=${station.code}&class30s=${station.class30Code}&filter=0`}
              {...(isStandalonePwa ? {} : { target: "_blank", rel: "noopener noreferrer" })}
              style={{
                display: "block", textAlign: "center", padding: "10px 0",
                fontSize: 12, fontWeight: 600, color: tokens.accentText || "#0A84FF",
                textDecoration: "none",
              }}
            >
              気象庁の該当ページを開く ↗
            </a>
          )}
        </>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────
   TIDE LINE CHART — 簡易SVG折れ線グラフ。潮位・潮位偏差の両方で使う共通部品。
   ───────────────────────────────────────────────────── */
function TideLineChart({ series, thresholds = [], height = 150, zeroLine = false, startTime, intervalSec }) {
  const { tokens } = useContext(ThemeContext);
  const containerRef = useRef(null);
  const [measuredWidth, setMeasuredWidth] = useState(320);
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth;
      if (w > 0) setMeasuredWidth(w);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const width = Math.max(160, measuredWidth);
  const padding = { top: 10, right: 10, bottom: 18, left: 32 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;

  const allValues = series.flatMap(s => (s.values || []).filter(v => v != null))
    .concat(thresholds.map(t => t.value));
  if (allValues.length === 0) {
    return (
      <div style={{ padding: "18px 0", textAlign: "center", fontSize: 12, color: `rgba(${tokens.ink},0.4)` }}>
        表示できるデータがありません
      </div>
    );
  }
  let dataMin = Math.min(...allValues, zeroLine ? 0 : allValues[0]);
  let dataMax = Math.max(...allValues, zeroLine ? 0 : allValues[0]);
  if (dataMin === dataMax) { dataMin -= 1; dataMax += 1; }
  const marginPad = (dataMax - dataMin) * 0.08;
  dataMin -= marginPad; dataMax += marginPad;
  const span = dataMax - dataMin || 1;
  const yScale = v => padding.top + innerH - ((v - dataMin) / span) * innerH;

  const n = Math.max(...series.map(s => (s.values || []).length), 1);
  const xScale = i => padding.left + (i / (n - 1 || 1)) * innerW;

  const pathFor = (values) => {
    let d = "";
    let started = false;
    values.forEach((v, i) => {
      if (v == null) { started = false; return; }
      d += `${started ? "L" : "M"} ${xScale(i).toFixed(1)} ${yScale(v).toFixed(1)} `;
      started = true;
    });
    return d.trim();
  };

  const tickCount = 5;
  const ticks = Array.from({ length: tickCount }, (_, i) => dataMin + (span * i) / (tickCount - 1));

  // 横軸(時刻)の目盛り。startTime(この配列の先頭のオリジナル時刻)+intervalSec(1件あたりの秒数)から
  // 各目盛り位置の実際の時刻を逆算する。日をまたぐ場合は日付も添える。
  const xTickCount = 6;
  const xTicks = (startTime && intervalSec)
    ? Array.from({ length: xTickCount }, (_, j) => {
        const idx = Math.round((j / (xTickCount - 1)) * (n - 1));
        const t = new Date(startTime.getTime() + idx * intervalSec * 1000);
        return { x: xScale(idx), t };
      })
    : [];
  let lastDateLabel = null;

  return (
    <div ref={containerRef}>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} style={{ display: "block" }}>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={padding.left} x2={width - padding.right} y1={yScale(t)} y2={yScale(t)}
              stroke={`rgba(${tokens.ink},0.08)`} strokeWidth="1"/>
            <text x={padding.left - 5} y={yScale(t) + 3} fontSize="9" textAnchor="end" fill={`rgba(${tokens.ink},0.45)`}>
              {Math.round(t)}
            </text>
          </g>
        ))}
        {zeroLine && dataMin < 0 && dataMax > 0 && (
          <line x1={padding.left} x2={width - padding.right} y1={yScale(0)} y2={yScale(0)}
            stroke={`rgba(${tokens.ink},0.35)`} strokeWidth="1"/>
        )}
        {thresholds.map((t, i) => (
          t.value >= dataMin && t.value <= dataMax && (
            <line key={i} x1={padding.left} x2={width - padding.right} y1={yScale(t.value)} y2={yScale(t.value)}
              stroke={t.color} strokeWidth="2" strokeDasharray={t.dashed ? "5 3" : undefined}/>
          )
        ))}
        {series.map((s, i) => (
          <path key={i} d={pathFor(s.values || [])} fill="none" stroke={s.color} strokeWidth="2.25" strokeLinejoin="round" strokeLinecap="round"/>
        ))}
        {/* 横軸(時刻) */}
        {xTicks.length > 0 && (
          <line x1={padding.left} x2={width - padding.right} y1={padding.top + innerH} y2={padding.top + innerH}
            stroke={`rgba(${tokens.ink},0.18)`} strokeWidth="1"/>
        )}
        {xTicks.map((tick, j) => {
          const hh = String(tick.t.getHours()).padStart(2, "0");
          const mm = String(tick.t.getMinutes()).padStart(2, "0");
          const dateLabel = `${tick.t.getMonth() + 1}/${tick.t.getDate()}`;
          const showDate = dateLabel !== lastDateLabel;
          lastDateLabel = dateLabel;
          return (
            <text key={j} x={tick.x} y={height - 4} fontSize="9" textAnchor="middle" fill={`rgba(${tokens.ink},0.45)`}>
              {showDate ? `${dateLabel} ${hh}:${mm}` : `${hh}:${mm}`}
            </text>
          );
        })}
      </svg>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 10px", padding: "4px 2px 0" }}>
        {series.map((s, i) => (
          <div key={`s${i}`} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <div style={{ width: 10, height: 2, background: s.color, borderRadius: 1 }}/>
            <span style={{ fontSize: 10, color: `rgba(${tokens.ink},0.5)` }}>{s.name}</span>
          </div>
        ))}
        {thresholds.map((t, i) => (
          <div key={`t${i}`} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <div style={{ width: 10, height: 2, background: t.color, borderRadius: 1 }}/>
            <span style={{ fontSize: 10, color: `rgba(${tokens.ink},0.5)` }}>{t.label}</span>
          </div>
        ))}
      </div>
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

function NearbyQuakesPanel({ place, stations, colorScheme, onFoundQuake, onSelectQuake, onPointsChange, onLoadingChange, epicenterCirclesEnabled }) {
  const { tokens } = useContext(ThemeContext);

  const cached = nearbyQuakeSearchCache.get(place);
  const [status, setStatus] = useState(cached ? "done" : "loading"); // loading | error | done
  const [results, setResults] = useState(cached || []);
  const [sortKey, setSortKey] = useState("maxInt");
  const [sortDesc, setSortDesc] = useState(true);
  const [loadingId, setLoadingId] = useState(null);

  // 震央分布(地図上の丸)用に、resultsの座標をバックグラウンドで少しずつ解決し、
  // 呼び出し元(BottomDock)へ伝える。まだ解決しきっていない間はonLoadingChangeで
  // 「読み込み中」も伝え、地図上にローディング表示を出せるようにする。
  // 設定でOFFの場合は、そもそも表示しないデータを無駄に取得しないよう、
  // 解決対象を空配列にしてバックグラウンド取得自体を行わない。
  const { points: epicenterPoints, loading: epicenterLoading } = useEqdbEpicenterPoints(epicenterCirclesEnabled ? results : EMPTY_EQDB_LIST);
  useEffect(() => {
    onPointsChange?.(epicenterPoints);
  }, [epicenterPoints]);
  useEffect(() => {
    onLoadingChange?.(epicenterLoading);
    return () => onLoadingChange?.(false);
  }, [epicenterLoading]);

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
      const [detail, geo] = await Promise.all([fetchEqdbEventCached(eq.id), loadGeoData()]);
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
          loading={loadingId === eq.id}
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
function QuakeSearchPanel({ stations, colorScheme, onFoundQuake, onSelectQuake, search, onChangeSearch, onSearchExecuted, scrollContainerRef, onPointsChange, onLoadingChange, epicenterCirclesEnabled }) {
  const { tokens, mode } = useContext(ThemeContext);

  const maxEndDate = eqdbMaxEndDate(); // 終了日に選べる最新日(=現在の2日前)。固定なので毎回同じ値。

  const {
    startDate, endDate, minMag, maxInt, sort,
    status, isSearching, hasSearched, results, loadingId,
  } = search;

  // 震央分布(地図上の丸)用に、resultsの座標をバックグラウンドで少しずつ解決し、
  // 呼び出し元(BottomDock)へ伝える。まだ解決しきっていない間はonLoadingChangeで
  // 「読み込み中」も伝え、地図上にローディング表示を出せるようにする。
  // 設定でOFFの場合は、そもそも表示しないデータを無駄に取得しないよう、
  // 解決対象を空配列にしてバックグラウンド取得自体を行わない。
  const { points: epicenterPoints, loading: epicenterLoading } = useEqdbEpicenterPoints(epicenterCirclesEnabled ? results : EMPTY_EQDB_LIST);
  useEffect(() => {
    onPointsChange?.(epicenterPoints);
  }, [epicenterPoints]);
  useEffect(() => {
    onLoadingChange?.(epicenterLoading);
    return () => onLoadingChange?.(false);
  }, [epicenterLoading]);

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
      const [detail, geo] = await Promise.all([fetchEqdbEventCached(eq.id), loadGeoData()]);
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
          <QuakeListRow
            key={eq.id}
            quake={eqdbListItemToPreview(eq)}
            showDivider={i > 0}
            colorScheme={colorScheme}
            onSelect={() => handleSelect(eq)}
            loading={loadingId === eq.id}
          />
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
  { id: "recent", label: "地震一覧", icon: ListViewIcon },
  { id: "search", label: "地震検索", icon: SearchGlassIcon },
];

// 津波タブ版の切り替え項目。地震タブの「一覧⇄検索」と同じ考え方で、
// 直近一覧⇄過去の津波情報を切り替える(過去分は/history APIをoffsetで
// 遡って追加取得するTsunamiHistoryのモード)。
const TSUNAMI_TOOLBAR_ITEMS = [
  { id: "recent",    label: "津波情報",   icon: ListViewIcon },
  { id: "history",   label: "過去の津波", icon: HistoryClockIcon },
  { id: "tidegauge", label: "潮位計",     icon: TideGaugeIcon },
];

function QuakeListToolbar({ mode, onModeChange, onHandoffToPanelDrag, items = QUAKE_TOOLBAR_ITEMS }) {
  // このコンポーネント自身のpropに"mode"(表示モード: list/search)があるため、
  // ThemeContextの方はthemeModeという別名で受け取る。
  const { tokens, mode: themeMode } = useContext(ThemeContext);
  const { opaque: glassOpaque } = useContext(GlassOpaqueContext);

  // ナビ行と同じ %ベース連続追従方式。PAD_X はJSX側のpaddingと必ず一致させる。
  const PAD_X = 3;
  const rowRef      = useRef(null);
  const pointerId    = useRef(null);
  const moved        = useRef(false);
  const startX       = useRef(0);
  const startY       = useRef(0);
  const N     = items.length;
  const tabW  = 100 / N; // 1タブの幅[%]（内側領域基準）

  const activeIndex = items.findIndex(item => item.id === mode);
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
    onModeChange(items[idx].id);
  }

  function handleClick(id) {
    if (moved.current) return; // ドラッグ完了後(縦方向への引き渡しを含む)の二重発火を防ぐ
    const idx = items.findIndex(item => item.id === id);
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
            backdropFilter: (pressed || dragging) && !glassOpaque ? touchGlassBackdropFilter(themeMode) : "none",
            WebkitBackdropFilter: (pressed || dragging) && !glassOpaque ? touchGlassBackdropFilter(themeMode) : "none",
            transform: pressed ? "scale(1.16)" : "scale(1)",
            transformOrigin: "center",
            transition: dragging
              ? "transform 0.18s cubic-bezier(.22,1,.36,1)"
              : "left 0.38s cubic-bezier(.22,1,.36,1), transform 0.18s cubic-bezier(.22,1,.36,1)",
            pointerEvents: "none",
            zIndex: 0,
          }}
        />
        {items.map(({ id, label, icon: Icon }, idx) => {
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
              <Icon size={16}/>
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
// 設定トップの一覧。「利用規約等・注意事項」(ライセンスもこの中に含む)は
// 詳細設定の下ではなくトップ階層に置く。
const SETTINGS_MENU = [
  { id: "tabSettings", label: "タブ設定" },
  { id: "terms",       label: "利用規約等・注意事項" },
  { id: "advanced",    label: "詳細設定" },
];

// 「タブ設定」配下の一覧。以前のSETTINGS_MENUそのもの。
// pathとしては ["tabSettings", "quake", ...] のように先頭にtabSettingsが付く形になる。
const TAB_SETTINGS_CATEGORIES = [
  { id: "quake",    label: "地震" },
  { id: "tsunami",  label: "津波" },
  { id: "weather",  label: "気象" },
  { id: "alert",    label: "警報" },
];

// カテゴリごとの項目一覧。地震・利用規約等の各カテゴリはSettingsBody内で専用に
// 組み立てるためここには含めない。他のカテゴリは現状すべて骨組み(空のプレースホルダー画面)。
const SETTINGS_ITEMS = {
  advanced: [
    { id: "appearance", label: "外観" },
    { id: "experimental", label: "実験的・テスト機能" },
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

/* ─────────────────────────────────────────────────────
   TSUNAMI TEST BROADCAST PANEL — 実験的機能の1つ。
   実際のP2P地震情報とは完全に別のダミーデータ(isTest: true)を津波タブに
   一時的に流し込み、UIの動作確認(一覧・カード・地図の塗り分け・凡例・
   潮位観測点への警報反映など)ができるようにする。
   ───────────────────────────────────────────────────── */
const TEST_TSUNAMI_GRADE_OPTIONS = [
  { value: "MajorWarning", label: "大津波警報" },
  { value: "Warning",      label: "津波警報" },
  { value: "Watch",        label: "津波注意報" },
  { value: "NonEffective", label: "津波予報" },
];

function TsunamiTestBroadcastPanel({ testTsunami, onBroadcast, onCancel, onClear }) {
  const { tokens, mode } = useContext(ThemeContext);
  const [grade, setGrade] = useState("Warning");
  const [areaName, setAreaName] = useState("テスト予報区");

  return (
    <>
      <SettingsHeader title="津波警報テスト配信"/>
      <div style={{ margin: "-4px 14px 10px", fontSize: 11, color: `rgba(${tokens.ink},0.45)`, lineHeight: 1.7 }}>
        実際の気象庁発表ではない、動作確認用のダミーデータです。津波タブの一覧・カード・地図の塗り分け・
        潮位観測点への反映などが、このデータを使って表示されます。「配信を削除」で元に戻ります。
      </div>

      <SettingsCard>
        <div style={{ padding: "12px 14px 4px", fontSize: 11, fontWeight: 600, color: `rgba(${tokens.ink},0.5)` }}>
          グレード
        </div>
        <div style={{ padding: "0 14px 12px" }}>
          <OptionPicker value={grade} options={TEST_TSUNAMI_GRADE_OPTIONS} onChange={setGrade}/>
        </div>
        <SettingsCardDivider/>
        <div style={{ padding: "12px 14px 4px", fontSize: 11, fontWeight: 600, color: `rgba(${tokens.ink},0.5)` }}>
          予報区名
        </div>
        <div style={{ padding: "0 14px 12px" }}>
          <input
            type="text"
            value={areaName}
            onChange={e => setAreaName(e.target.value)}
            placeholder="例: 東京都・北海道太平洋沿岸東部 など"
            style={eqdbInputStyle(tokens, mode)}
          />
        </div>
      </SettingsCard>

      <SettingsCard>
        <PressableButton
          type="button"
          onClick={() => onBroadcast?.({ grade, areaName: areaName.trim() || "テスト予報区" })}
          style={{
            width: "100%", padding: "12px 14px", border: "none", cursor: "pointer",
            background: "transparent", textAlign: "center",
            fontSize: 14, fontWeight: 700, color: "#FF453A",
          }}
        >
          テスト配信する
        </PressableButton>
        {testTsunami && !testTsunami.cancelled && (
          <>
            <SettingsCardDivider/>
            <PressableButton
              type="button"
              onClick={onCancel}
              style={{
                width: "100%", padding: "12px 14px", border: "none", cursor: "pointer",
                background: "transparent", textAlign: "center",
                fontSize: 14, fontWeight: 600, color: `rgba(${tokens.ink},0.7)`,
              }}
            >
              解除を配信する
            </PressableButton>
          </>
        )}
        {testTsunami && (
          <>
            <SettingsCardDivider/>
            <PressableButton
              type="button"
              onClick={onClear}
              style={{
                width: "100%", padding: "12px 14px", border: "none", cursor: "pointer",
                background: "transparent", textAlign: "center",
                fontSize: 14, fontWeight: 600, color: `rgba(${tokens.ink},0.45)`,
              }}
            >
              配信を削除(片付ける)
            </PressableButton>
          </>
        )}
      </SettingsCard>

      {testTsunami && (
        <div style={{ margin: "6px 14px 10px", fontSize: 11, color: `rgba(${tokens.ink},0.5)`, lineHeight: 1.7 }}>
          現在の配信状況: {testTsunami.cancelled ? "解除済み" : tsunamiGradeInfo(testTsunami.maxGrade).label}
          ({testTsunami.areas?.[0]?.name})・{testTsunami.time}
        </div>
      )}
    </>
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

// **強調** と [文字列](URL) の簡易インライン処理。genuine Markdownパーサーではなく、
// こちらで用意する定型文書(利用規約・注意事項等)のみを想定したサブセット。
// リンクはhttp(s)スキームのみ許可し、javascript:等は文字列として素通しする
// (このファイル群はこちらで用意するものだが、念のための防御)。
function renderInlineMarkdown(text, keyPrefix) {
  const parts = text.split(/(\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g);
  return parts.map((part, i) => {
    if (!part) return null;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={`${keyPrefix}-${i}`}>{part.slice(2, -2)}</strong>;
    }
    const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (linkMatch) {
      const [, label, url] = linkMatch;
      if (!/^https?:\/\//i.test(url)) {
        return <Fragment key={`${keyPrefix}-${i}`}>{label}</Fragment>;
      }
      return (
        <a
          key={`${keyPrefix}-${i}`}
          href={url}
          onClick={(e) => {
            // iOSのホーム画面PWA(standalone表示)では、target="_blank"だけだと
            // 別ウィンドウ(Safari)に離脱せず同じスタンドアロン画面内で遷移して
            // しまうことがあり、その状態で「戻る」とアプリ全体がリロードされて
            // しまう(=それまでのReactの状態が失われる)。window.openを明示的に
            // 呼んで新しいブラウジングコンテキストを開くことで、この画面はその場に
            // 留まったまま、リンク先だけを別枠(Safari等)で開くようにする。
            e.preventDefault();
            window.open(url, "_blank", "noopener,noreferrer");
          }}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "#0A84FF", textDecoration: "underline", wordBreak: "break-all" }}
        >
          {label}
        </a>
      );
    }
    return <Fragment key={`${keyPrefix}-${i}`}>{part}</Fragment>;
  });
}

// ごく簡易的なMarkdown→JSXレンダラー。任意のMarkdown全般には対応せず、
// 見出し(#/##/###)・箇条書き(-/・)・区切り線(---)・**強調**・
// 空行区切りの段落のみを扱う、利用規約等の定型文書専用のサブセット実装。
// dangerouslySetInnerHTMLは一切使わず常にReact要素として組み立てるため、
// 万一ファイル内容に任意のHTML/スクリプトが混入していても実行されない。
function renderMarkdownLite(text, tokens) {
  const lines = (text || "").replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let listBuffer = [];

  function flushList() {
    if (listBuffer.length === 0) return;
    const items = listBuffer;
    listBuffer = [];
    blocks.push(
      <ul key={`ul-${blocks.length}`} style={{ margin: "4px 0 12px", paddingLeft: 20, textAlign: "left" }}>
        {items.map((item, i) => (
          <li key={i} style={{ marginBottom: 4 }}>{renderInlineMarkdown(item, `li-${blocks.length}-${i}`)}</li>
        ))}
      </ul>
    );
  }

  lines.forEach((rawLine, i) => {
    const line = rawLine.trim();
    if (line.startsWith("### ")) {
      flushList();
      blocks.push(<div key={i} style={{ fontSize: 13, fontWeight: 700, color: tokens.text, margin: "14px 0 4px", textAlign: "left" }}>{renderInlineMarkdown(line.slice(4), `h3-${i}`)}</div>);
    } else if (line.startsWith("## ")) {
      flushList();
      blocks.push(<div key={i} style={{ fontSize: 14, fontWeight: 700, color: tokens.text, margin: "18px 0 6px", textAlign: "left" }}>{renderInlineMarkdown(line.slice(3), `h2-${i}`)}</div>);
    } else if (line.startsWith("# ")) {
      flushList();
      blocks.push(<div key={i} style={{ fontSize: 16, fontWeight: 800, color: tokens.text, margin: "4px 0 10px", textAlign: "left" }}>{renderInlineMarkdown(line.slice(2), `h1-${i}`)}</div>);
    } else if (/^-{3,}$/.test(line)) {
      flushList();
      blocks.push(<div key={i} style={{ height: 1, background: `rgba(${tokens.ink},0.1)`, margin: "14px 0" }}/>);
    } else if (line.startsWith("- ") || line.startsWith("・")) {
      listBuffer.push(line.startsWith("- ") ? line.slice(2) : line.slice(1));
    } else if (line === "") {
      flushList();
    } else {
      flushList();
      blocks.push(<p key={i} style={{ margin: "0 0 10px", lineHeight: 1.9, textAlign: "left" }}>{renderInlineMarkdown(line, `p-${i}`)}</p>);
    }
  });
  flushList();
  return blocks;
}

// public/配下のMarkdownファイル(利用規約・注意事項・プライバシーポリシー等)を
// 実行時に取得し、renderMarkdownLiteで整形して表示するカード。LicenseFileCardと
// 同じ理由(ビルドし直さずファイル編集だけで内容を更新できるように)で、
// ビルド時埋め込みではなく実行時fetchにしている。
// 前提: Viteの public/ ディレクトリに対象のMarkdownファイルが置かれていること
// (LicenseFileCardと同様、BASE_URL配下に配置する必要がある)。
function MarkdownFileCard({ fileName }) {
  const { tokens } = useContext(ThemeContext);
  const [state, setState] = useState({ status: "loading", text: "" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading", text: "" });
    fetch(`${import.meta.env.BASE_URL}${fileName}`)
      .then(res => {
        if (!res.ok) throw new Error(`status ${res.status}`);
        return res.text();
      })
      .then(text => { if (!cancelled) setState({ status: "ready", text }); })
      .catch(err => {
        console.warn(`${fileName}を取得できませんでした:`, err);
        if (!cancelled) setState({ status: "error", text: "" });
      });
    return () => { cancelled = true; };
  }, [fileName]);

  return (
    <SettingsCard>
      <div style={{ padding: "14px 16px", textAlign: "left" }}>
        {state.status === "loading" && (
          <div style={{ fontSize: 12, color: `rgba(${tokens.ink},0.4)` }}>読み込み中…</div>
        )}
        {state.status === "error" && (
          <div style={{ fontSize: 12, color: `rgba(${tokens.ink},0.4)` }}>
            {fileName}を読み込めませんでした。
          </div>
        )}
        {state.status === "ready" && (
          <div style={{ fontSize: 12.5, color: `rgba(${tokens.ink},0.7)` }}>
            {renderMarkdownLite(state.text, tokens)}
          </div>
        )}
      </div>
    </SettingsCard>
  );
}

// 断層・プレート境界の「枠内の色」選択部分。色名は出さず、色つきの丸(スウォッチ)を
// 横に並べるだけのシンプルなUIにする。選択中の丸には白いチェックマークを重ねる。
// 他のトグル行と同じSettingsCard内に収める前提のため、自前のカードは持たず、
// 小さな見出しとスウォッチ行だけを返すコンパクトな作りにしている
// (パネルの高さ「中高」だけでスクロールなしに収まるようにするため)。
function BoundaryLineColorSettings({ boundaryLineColorId, onChangeBoundaryLineColorId }) {
  const { tokens } = useContext(ThemeContext);

  const entries = Object.entries(BOUNDARY_LINE_COLORS);
  return (
    <div style={{ padding: "10px 14px 12px" }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: tokens.textSecondary, marginBottom: 9 }}>
        枠内の色
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, justifyContent: "center" }}>
        {entries.map(([id, entry]) => {
          const selected = boundaryLineColorId === id;
          const checkColor = entry.checkColor || "#fff";
          return (
            <PressableButton
              key={id}
              onClick={() => onChangeBoundaryLineColorId(id)}
              aria-label={entry.label}
              style={{
                width: 30, height: 30, borderRadius: 15, flexShrink: 0,
                background: entry.color,
                border: "none", padding: 0, cursor: "pointer",
                display: "flex", alignItems: "center", justifyContent: "center",
                boxShadow: selected
                  ? `0 0 0 2px ${tokens.pageBg}, 0 0 0 3.5px rgba(${tokens.ink},0.4)`
                  : `0 0 0 1px rgba(${tokens.ink},0.15)`,
              }}
            >
              {selected && (
                <span style={{ fontSize: 13, fontWeight: 700, color: checkColor, lineHeight: 1 }}>✓</span>
              )}
            </PressableButton>
          );
        })}
      </div>
    </div>
  );
}


function SettingsBody({
  path, onNavigate, colorSchemeId, onChangeColorScheme,
  estIntensityEnabled, onChangeEstIntensityEnabled,
  areaFillEnabled, onChangeAreaFillEnabled,
  faultsEnabled, onChangeFaultsEnabled,
  plateBoundariesEnabled, onChangePlateBoundariesEnabled,
  epicenterCirclesEnabled, onChangeEpicenterCirclesEnabled,
  boundaryLineColorId, onChangeBoundaryLineColorId,
  quakeFetchLimit, onChangeQuakeFetchLimit,
  stationListDisplayMode, onChangeStationListDisplayMode,
  experimentalFeaturesEnabled, onChangeExperimentalFeaturesEnabled,
  testTsunami, onBroadcastTestTsunami, onCancelTestTsunami, onClearTestTsunami,
}) {
  // 「フローティングを不透明にする」トグル用。BottomDock経由でpropsを何段も
  // 通す代わりに、Appのトップレベルで配信しているcontextを直接購読する。
  const {
    opaque: glassOpaqueEnabled,
    suspectedBroken: glassOpaqueSuspectedBroken,
    setOverride: onChangeGlassOpaqueOverride,
  } = useContext(GlassOpaqueContext);

  // ライト/ダークモード切り替え用。同じくcontext経由で直接購読する。
  const { mode: themeMode, tokens, modePref: themeModePref, setModePref: onChangeThemeModePref } = useContext(ThemeContext);

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

  // 「タブ設定」の中身(地震・津波・気象・警報への入口)。
  if (path.length === 1 && path[0] === "tabSettings") {
    return (
      <>
        <SettingsHeader title="タブ設定"/>
        <SettingsCard>
          {TAB_SETTINGS_CATEGORIES.map((item, i) => (
            <div key={item.id}>
              {i > 0 && <SettingsCardDivider/>}
              <SettingsMenuRow label={item.label} onClick={() => onNavigate([...path, item.id])}/>
            </div>
          ))}
        </SettingsCard>
      </>
    );
  }

  // 地震・津波・気象・警報は「タブ設定」配下に移動したため、実際のpathは
  // ["tabSettings", "quake", ...] のように先頭にtabSettingsが付く。以降の
  // ルーティングは以前と同じcategory/leaf/subの2〜3階層で判定したいので、
  // その場合だけ先頭のtabSettingsを取り除いたものをlogicalPathとして扱う。
  const logicalPath = path[0] === "tabSettings" ? path.slice(1) : path;
  const [category, leaf, sub] = logicalPath;
  const categoryLabel = (SETTINGS_MENU.find(m => m.id === category)
    || TAB_SETTINGS_CATEGORIES.find(m => m.id === category))?.label || "";

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

  // 断層・プレート境界(地震カテゴリの項目)の中身。
  // いずれもファイルサイズが大きいデータのため、初期設定は両方OFF。
  // 縁取り(halo)はライト/ダーク共通の固定色だが、枠内の色はここで選べる。
  // ヘッダー・カードを1つにまとめてコンパクトにし、パネルの高さ「中高」
  // (MIDHIGH_FIXED)だけでスクロールなしに全項目が収まるようにしている。
  if (category === "quake" && leaf === "boundaries") {
    return (
      <>
        <SettingsHeader title="断層・プレート境界"/>
        <SettingsCard>
          <SettingsToggleRow
            label="断層を表示"
            description="日本の主な活断層を表示します。"
            checked={faultsEnabled}
            onChange={() => onChangeFaultsEnabled(!faultsEnabled)}
          />
          <SettingsCardDivider/>
          <SettingsToggleRow
            label="プレート境界を表示"
            description="世界のプレート境界を表示します。"
            checked={plateBoundariesEnabled}
            onChange={() => onChangePlateBoundariesEnabled(!plateBoundariesEnabled)}
          />
          <SettingsCardDivider/>
          <BoundaryLineColorSettings
            boundaryLineColorId={boundaryLineColorId}
            onChangeBoundaryLineColorId={onChangeBoundaryLineColorId}
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
          <SettingsMenuRow label="断層・プレート境界" onClick={() => onNavigate([...path, "boundaries"])}/>
          <SettingsCardDivider/>
          <SettingsToggleRow
            label="震央分布を表示"
            description="近傍/データベース検索の地震一覧を開いた時、地図上に震央の丸を表示します。震度が大きい地震ほど上に重なって表示されます。"
            checked={epicenterCirclesEnabled}
            onChange={() => onChangeEpicenterCirclesEnabled(!epicenterCirclesEnabled)}
          />
          <SettingsCardDivider/>
          <SettingsMenuRow label="各地の震度の表示方法" onClick={() => onNavigate([...path, "stationListDisplay"])}/>
          <SettingsCardDivider/>
          <SettingsMenuRow label="取得件数" onClick={() => onNavigate([...path, "fetchLimit"])}/>
        </SettingsCard>
      </>
    );
  }

  // 外観(詳細設定カテゴリの項目)の中身。
  // 「デバイスの設定に合わせる」が初期設定(ON)で、端末のライト/ダーク設定に
  // 自動追従する。OFFにした場合のみ、ライト/ダークを手動で選べる。
  // ここではUIチューム(背景・カード・文字色など)の基礎トークンだけを
  // 切り替えており、地図の基本配色や震度配色スキームは対象外
  // (別途テーマ対応が必要)。
  if (category === "advanced" && leaf === "appearance") {
    const followSystem = themeModePref === "system";
    return (
      <>
        <SettingsHeader title="外観"/>
        <SettingsCard>
          <SettingsToggleRow
            label="デバイスの設定に合わせる"
            description="オンにすると、端末のライト/ダークモード設定に自動で追従します(初期設定)。"
            checked={followSystem}
            onChange={() => onChangeThemeModePref(followSystem ? themeMode : "system")}
          />
          {!followSystem && (
            <>
              <SettingsCardDivider/>
              <SettingsToggleRow
                label="ライトモード"
                description="オフのときはダークモードです。"
                checked={themeModePref === "light"}
                onChange={() => onChangeThemeModePref(themeModePref === "light" ? "dark" : "light")}
              />
            </>
          )}
        </SettingsCard>
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

  // 実験的・テスト機能(詳細設定の項目)の中身。
  if (category === "advanced" && leaf === "experimental") {
    return (
      <>
        <SettingsHeader title="実験的・テスト機能"/>
        <SettingsCard>
          <SettingsToggleRow
            label="実験的機能を有効にする"
            description="開発中・テスト用の機能を使えるようにします。実際の防災情報とは異なる場合があるため、通常時はOFFのままにしてください。"
            checked={experimentalFeaturesEnabled}
            onChange={() => onChangeExperimentalFeaturesEnabled(!experimentalFeaturesEnabled)}
          />
        </SettingsCard>
        {experimentalFeaturesEnabled && (
          <TsunamiTestBroadcastPanel
            testTsunami={testTsunami}
            onBroadcast={onBroadcastTestTsunami}
            onCancel={onCancelTestTsunami}
            onClear={onClearTestTsunami}
          />
        )}
      </>
    );
  }

  // 利用規約等・注意事項(トップ階層のカテゴリ)の中身。文書一覧。
  // ライセンスもこの中に含める。
  if (category === "terms" && !leaf) {
    return (
      <>
        <SettingsHeader title="利用規約等・注意事項"/>
        <SettingsCard>
          <SettingsMenuRow label="利用規約" onClick={() => onNavigate([...path, "tou"])}/>
          <SettingsCardDivider/>
          <SettingsMenuRow label="注意事項" onClick={() => onNavigate([...path, "notices"])}/>
          <SettingsCardDivider/>
          <SettingsMenuRow label="プライバシーポリシー" onClick={() => onNavigate([...path, "privacy"])}/>
          <SettingsCardDivider/>
          <SettingsMenuRow label="ライセンス" onClick={() => onNavigate([...path, "license"])}/>
        </SettingsCard>
      </>
    );
  }

  // 利用規約本文。public/terms-of-use.md を実行時に取得して表示する。
  if (category === "terms" && leaf === "tou") {
    return (
      <>
        <SettingsHeader title="利用規約"/>
        <MarkdownFileCard fileName="terms-of-use.md"/>
      </>
    );
  }

  // 注意事項本文。public/notices.md を実行時に取得して表示する。
  if (category === "terms" && leaf === "notices") {
    return (
      <>
        <SettingsHeader title="注意事項"/>
        <MarkdownFileCard fileName="notices.md"/>
      </>
    );
  }

  // プライバシーポリシー本文。public/privacy-policy.md を実行時に取得して表示する。
  if (category === "terms" && leaf === "privacy") {
    return (
      <>
        <SettingsHeader title="プライバシーポリシー"/>
        <MarkdownFileCard fileName="privacy-policy.md"/>
      </>
    );
  }

  // ライセンス(利用規約等・注意事項カテゴリの項目)の中身
  if (category === "terms" && leaf === "license" && !sub) {
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
  if (category === "terms" && leaf === "license" && sub === "mit") {
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
   TERMS CONSENT GATE
   利用規約・プライバシーポリシー・注意事項への同意を、既存のフローティングUI
   (BottomDock等)とは別の全画面オーバーレイで確認する。未同意の間はこれが
   画面全体を覆い、他の操作を一切受け付けない。

   「同意済みか」はTERMS_AGREEMENT_STORAGE_KEY(localStorage)に保存した
   各文書のハッシュで判定するため、開発者はMarkdownファイルの中身を
   書き換えるだけでよく、バージョン番号の手動管理は不要。

   フェイルオープンの方針: 本アプリは災害時にも使われることを想定しているため、
   「過去に同意した記録があるユーザー」を単なる通信不調で締め出すことは避ける。
   文書の取得に失敗した場合:
     - 過去に同意した記録がある → ブロックせずそのまま利用させる
     - 一度も同意したことがない(真の初回) → 同意対象を表示できないため、
       再読み込みを促す画面のみ出す(この場合だけブロックが続く)

   ファイル名は意図的に日本語ではなくASCIIにしている。日本語ファイル名
   (特に濁点・半濁点付きのカタカナ)はmacOS等でNFD(濁点が分解された形)で
   保存されることがあり、ブラウザが要求するNFC表記のURLとバイト単位で
   一致せず404になることがあるため。
   ───────────────────────────────────────────────────── */
const TERMS_GATE_FILES = {
  tou: "terms-of-use.md",
  privacy: "privacy-policy.md",
  notices: "notices.md",
};
const TERMS_GATE_TABS = [
  { id: "tou",     label: "利用規約" },
  { id: "privacy", label: "プライバシーポリシー" },
  { id: "notices", label: "注意事項" },
];

function TermsConsentGate() {
  const { tokens } = useContext(ThemeContext);
  const [status, setStatus] = useState("checking"); // checking | ok | needsConsent | unavailable
  const [docs, setDocs] = useState(null); // { tou, privacy, notices }
  const [pendingHashes, setPendingHashes] = useState(null);
  const [activeTab, setActiveTab] = useState("tou");
  const [agreeChecked, setAgreeChecked] = useState(false);
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setStatus("checking");

    function withTimeout(promise, ms) {
      return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
      ]);
    }

    const stored = loadStoredTermsAgreement();

    Promise.allSettled(
      Object.entries(TERMS_GATE_FILES).map(([key, fileName]) =>
        withTimeout(
          fetch(`${import.meta.env.BASE_URL}${fileName}`).then(res => {
            if (!res.ok) throw new Error(`status ${res.status}`);
            return res.text();
          }),
          8000
        ).then(text => ({ key, text }))
      )
    ).then(results => {
      if (cancelled) return;

      const texts = {};
      let allOk = true;
      results.forEach(r => {
        if (r.status === "fulfilled") texts[r.value.key] = r.value.text;
        else allOk = false;
      });

      if (!allOk) {
        setStatus(stored ? "ok" : "unavailable");
        return;
      }

      const hashes = {
        tou: simpleHash(texts.tou),
        privacy: simpleHash(texts.privacy),
        notices: simpleHash(texts.notices),
      };
      const upToDate = !!stored
        && stored.tou === hashes.tou
        && stored.privacy === hashes.privacy
        && stored.notices === hashes.notices;

      if (upToDate) {
        setStatus("ok");
      } else {
        setDocs(texts);
        setPendingHashes(hashes);
        setAgreeChecked(false);
        setActiveTab("tou");
        setStatus("needsConsent");
      }
    });

    return () => { cancelled = true; };
  }, [retryToken]);

  if (status === "ok") return null;

  // 「取得中」は通常一瞬で終わるが、その間に下のUIが一瞬でも見えてしまうのを
  // 避けるため、判定が終わるまでは最小限の全画面プレースホルダーだけを出す。
  if (status === "checking") {
    return (
      <div style={{
        position: "fixed", inset: 0, zIndex: 9999,
        background: tokens.pageBg,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        <div style={{
          width: 22, height: 22, borderRadius: "50%",
          border: `2.5px solid rgba(${tokens.ink},0.2)`,
          borderTopColor: `rgba(${tokens.ink},0.7)`,
          animation: "spin 0.8s linear infinite",
        }}/>
      </div>
    );
  }

  if (status === "unavailable") {
    return (
      <div style={{
        position: "fixed", inset: 0, zIndex: 9999,
        background: tokens.pageBg,
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 24,
      }}>
        <div style={{ maxWidth: 360, textAlign: "center" }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: tokens.text, marginBottom: 10 }}>
            利用規約等を読み込めませんでした
          </div>
          <div style={{ fontSize: 13, color: `rgba(${tokens.ink},0.6)`, lineHeight: 1.8, marginBottom: 20 }}>
            ご利用の開始には、利用規約・プライバシーポリシー・注意事項への同意が必要です。通信環境をご確認のうえ、もう一度お試しください。
          </div>
          <PressableButton
            onClick={() => setRetryToken(n => n + 1)}
            style={{
              padding: "10px 24px", borderRadius: 999,
              border: "1px solid rgba(10,132,255,0.9)",
              background: "#0A84FF", color: "#ffffff",
              fontSize: 14, fontWeight: 700,
            }}
          >
            再読み込み
          </PressableButton>
        </div>
      </div>
    );
  }

  // status === "needsConsent"
  const activeText = docs?.[activeTab] || "";
  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 9999,
      background: tokens.pageBg,
      display: "flex", flexDirection: "column",
    }}>
      <div style={{ padding: "calc(20px + env(safe-area-inset-top, 0px)) 20px 12px", textAlign: "center", flexShrink: 0 }}>
        <div style={{ fontSize: 17, fontWeight: 800, color: tokens.text, marginBottom: 4 }}>
          利用規約等のご確認
        </div>
        <div style={{ fontSize: 12.5, color: `rgba(${tokens.ink},0.55)`, lineHeight: 1.7 }}>
          ご利用の前に、以下の内容をご確認のうえ同意してください。
        </div>
      </div>

      <div style={{ display: "flex", gap: 6, padding: "0 16px 10px", justifyContent: "center", flexShrink: 0 }}>
        {TERMS_GATE_TABS.map(tab => (
          <PressableButton
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding: "7px 12px", borderRadius: 999,
              background: activeTab === tab.id ? "#0A84FF" : `rgba(${tokens.ink},0.06)`,
              color: activeTab === tab.id ? "#ffffff" : tokens.text,
              fontSize: 12.5, fontWeight: 700,
            }}
          >
            {tab.label}
          </PressableButton>
        ))}
      </div>

      <div key={activeTab} style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "4px 16px 16px" }}>
        <div style={{
          borderRadius: 16,
          background: `rgba(${tokens.ink},0.04)`,
          padding: "16px 16px",
        }}>
          {renderMarkdownLite(activeText, tokens)}
        </div>
      </div>

      <div style={{
        padding: "12px 16px calc(16px + env(safe-area-inset-bottom, 0px))",
        borderTop: `1px solid rgba(${tokens.ink},0.08)`,
        flexShrink: 0,
      }}>
        <PressableButton
          onClick={() => setAgreeChecked(v => !v)}
          style={{
            width: "100%", display: "flex", alignItems: "center", gap: 10,
            padding: "10px 4px", background: "transparent", textAlign: "left",
          }}
        >
          <span style={{
            flexShrink: 0, width: 20, height: 20, borderRadius: 6,
            border: `1.5px solid rgba(${tokens.ink},${agreeChecked ? 0 : 0.3})`,
            background: agreeChecked ? "#0A84FF" : "transparent",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            {agreeChecked && (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                <path d="M4 12.5L9.5 18L20 6" stroke="#fff" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )}
          </span>
          <span style={{ fontSize: 13, color: tokens.text }}>
            利用規約・プライバシーポリシー・注意事項の内容を確認し、同意します
          </span>
        </PressableButton>

        <PressableButton
          disabled={!agreeChecked}
          onClick={() => {
            if (!pendingHashes) return;
            saveStoredTermsAgreement({ ...pendingHashes, agreedAt: new Date().toISOString() });
            setStatus("ok");
          }}
          style={{
            width: "100%", marginTop: 10, padding: "13px 0", borderRadius: 999,
            background: agreeChecked ? "#0A84FF" : `rgba(${tokens.ink},0.12)`,
            color: agreeChecked ? "#ffffff" : `rgba(${tokens.ink},0.4)`,
            fontSize: 15, fontWeight: 800, textAlign: "center",
          }}
        >
          同意して利用を開始する
        </PressableButton>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────
   APP ROOT
   ───────────────────────────────────────────────────── */
export default function App() {
  const [activeNav, setActiveNav] = useState("quake");

  // タブバーで、既にアクティブなタブをもう一度タップした時に、フローティングを
  // 開閉トグルさせるための信号。値そのものに意味は無く、変化すること自体を
  // BottomDock側のuseEffectで検知してsnapIndexを切り替える。
  const [navCollapseSignal, setNavCollapseSignal] = useState(0);
  // SideNavRail・狭幅ナビはどちらも、1回のタップに対してhandlePointerUp(ドラッグ解放時)と
  // handleClick(単純クリック時)の両方からonNavを呼ぶ作りになっている
  // (ドラッグでタブを選べるようにするための設計)。onNavが単なるsetActiveNavだった頃は
  // 同じidで2回呼ばれても実害が無かったが、同じタブの再タップに開閉トグルの副作用を
  // 持たせた今は、1タップにつき2回トグルが走って「開いて即閉じる」=見た目上何も
  // 変わらない、という不具合になっていた。同じid・短時間内の連続呼び出しは
  // 2回目以降を無視することで、1タップ=1トグルに固定する。
  const lastNavTapRef = useRef({ id: null, time: 0 });
  function handleNavTap(id) {
    if (id === activeNav) {
      const now = Date.now();
      if (lastNavTapRef.current.id === id && now - lastNavTapRef.current.time < 400) {
        return;
      }
      lastNavTapRef.current = { id, time: now };
      setNavCollapseSignal(s => s + 1);
    } else {
      setActiveNav(id);
    }
  }
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
  // 初期設定は"system"(デバイスの設定に合わせる)。ユーザーの選択は
  // localStorageに保存し、次回起動時も復元する。
  // "system"のときはuseSystemThemeMode()でデバイスのprefers-color-schemeを
  // ライブ監視し、それをそのまま実際の表示モードとして使う。
  const [themeModePref, setThemeModePrefState] = useState(loadStoredThemeModePref); // "system" | "light" | "dark"
  const systemThemeMode = useSystemThemeMode(); // "dark" | "light"(デバイス設定、リアルタイム反映)
  const themeMode = themeModePref === "system" ? systemThemeMode : themeModePref; // 実際に適用中のモード

  function handleChangeThemeModePref(next) {
    setThemeModePrefState(next);
    saveThemeModePref(next);
  }

  const themeContextValue = useMemo(() => ({
    mode: themeMode,
    tokens: THEME_TOKENS[themeMode],
    modePref: themeModePref,
    setModePref: handleChangeThemeModePref,
  }), [themeMode, themeModePref]);

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

  // 実験的・テスト機能のON/OFF。設定「詳細設定」内のトグルで操作し、localStorageに永続化する。
  const [experimentalFeaturesEnabled, setExperimentalFeaturesEnabledState] = useState(loadStoredExperimentalFeaturesEnabled);

  function handleChangeExperimentalFeaturesEnabled(next) {
    setExperimentalFeaturesEnabledState(next);
    saveExperimentalFeaturesEnabled(next);
    // OFFに戻したら、テスト配信中のダミー津波情報も片付けておく
    // (OFFなのにテストデータだけ残り続ける事故を防ぐ)。
    if (!next) clearTestTsunami();
  }

  // 断層(faults.geojson)の表示ON/OFF。設定タブ「地震」内のトグルで操作し、
  // localStorageに永続化する。ファイルサイズが大きいためデフォルトはOFF。
  const [faultsEnabled, setFaultsEnabledState] = useState(loadStoredFaultsEnabled);

  function handleChangeFaultsEnabled(next) {
    setFaultsEnabledState(next);
    saveFaultsEnabled(next);
  }

  // プレート境界(plate-boundaries.json)の表示ON/OFF。断層と同様。
  const [plateBoundariesEnabled, setPlateBoundariesEnabledState] = useState(loadStoredPlateBoundariesEnabled);

  function handleChangePlateBoundariesEnabled(next) {
    setPlateBoundariesEnabledState(next);
    savePlateBoundariesEnabled(next);
  }

  // 震央分布(地図上の丸)の表示ON/OFF。設定タブ「地震」内のトグルで操作し、
  // localStorageに永続化する。デフォルトはOFF。
  const [epicenterCirclesEnabled, setEpicenterCirclesEnabledState] = useState(loadStoredEpicenterCirclesEnabled);

  function handleChangeEpicenterCirclesEnabled(next) {
    setEpicenterCirclesEnabledState(next);
    saveEpicenterCirclesEnabled(next);
  }

  // 断層・プレート境界の「枠内の色」。設定タブ「地震」内の色選択で操作し、localStorageに永続化する。
  const [boundaryLineColorId, setBoundaryLineColorIdState] = useState(loadStoredBoundaryLineColorId);

  function handleChangeBoundaryLineColorId(next) {
    setBoundaryLineColorIdState(next);
    saveBoundaryLineColorId(next);
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

  // 津波情報(P2P地震情報API)。地震情報と同じWebSocket接続を共有する(下のuseEffect参照)。
  const [tsunamis,          setTsunamis]          = useState([]);
  const [tsunamiStatus,     setTsunamiStatus]     = useState("loading"); // loading | ready | error
  const [selectedTsunamiId, setSelectedTsunamiId] = useState(null);

  /* ─────────────────────────────────────────────────────
     実験的機能: 津波警報テスト配信
     設定の「実験的・テスト機能」がONの時だけ使える、UI確認用のダミー津波情報。
     実際のtsunamis(WebSocketで更新され続ける)とは別のstateに持たせ、
     使う場面(effectiveTsunamis)でだけ合成することで、本物のデータ更新に
     巻き込まれて消えてしまわないようにしている。
     ───────────────────────────────────────────────────── */
  const [testTsunami, setTestTsunami] = useState(null); // { ...tsunamiカード, isTest: true } | null

  function broadcastTestTsunami({ grade, areaName }) {
    const now = new Date();
    const pad2 = n => String(n).padStart(2, "0");
    const timeStr = `${now.getFullYear()}/${pad2(now.getMonth() + 1)}/${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
    setTestTsunami({
      id: `test_${now.getTime()}`,
      time: timeStr,
      cancelled: false,
      areas: [{
        name: areaName || "テスト予報区", grade,
        immediate: false, firstHeightCondition: null, firstHeightTime: null, maxHeightDescription: null,
      }],
      maxGrade: grade,
      isTest: true,
    });
  }
  function cancelTestTsunami() {
    setTestTsunami(prev => (prev ? { ...prev, cancelled: true, maxGrade: null } : null));
  }
  function clearTestTsunami() {
    setTestTsunami(null);
  }

  // テスト配信中は、実際の一覧の先頭にテストデータを合成する。以降、津波タブに
  // 関するApp側の判定(現在有効な津波・選択中の津波・地図表示)は、すべてこちらを使う。
  const effectiveTsunamis = testTsunami ? [testTsunami, ...tsunamis] : tsunamis;

  // 津波タブ「過去」モード用。直近一覧(tsunamis)とは別に、/history APIを
  // offsetで遡りながら追加取得した過去の津波情報を保持する(地震タブの
  // searchQuakeと同じ理由でWebSocketの新着・件数上限の影響を受けないようにする)。
  const [tsunamiHistory, setTsunamiHistory] = useState({
    items: [], offset: 0, status: "idle", hasMore: true, debug: "",
  }); // status: idle | loading | ready | error

  async function loadMoreTsunamiHistory() {
    if (tsunamiHistory.status === "loading" || !tsunamiHistory.hasMore) return;
    setTsunamiHistory(prev => ({ ...prev, status: "loading" }));
    const debugParts = [];
    try {
      // 初回は、気象庁の公式一覧(list.json)と、P2P地震情報の津波予報専用API
      // (/v2/jma/tsunami)の先頭2ページ(offset 0, 100)をまとめて取得して統合する。
      if (tsunamiHistory.offset === 0 && tsunamiHistory.items.length === 0) {
        const [jmaItems, p2pPage1, p2pPage2] = await Promise.all([
          fetchJmaTsunamiHistory()
            .then(r => { debugParts.push(`気象庁:${r.length}件`); return r; })
            .catch(err => { console.error("気象庁 津波情報一覧の取得に失敗:", err); debugParts.push(`気象庁:失敗(${err.message})`); return []; }),
          fetchTsunamiHistoryPage(0, TSUNAMI_HISTORY_PAGE_SIZE)
            .then(r => { debugParts.push(`P2P#1:${r.length}件`); return r; })
            .catch(err => { console.error("P2P地震情報 過去の津波情報の取得に失敗:", err); debugParts.push(`P2P#1:失敗(${err.message})`); return []; }),
          fetchTsunamiHistoryPage(TSUNAMI_HISTORY_PAGE_SIZE, TSUNAMI_HISTORY_PAGE_SIZE)
            .then(r => { debugParts.push(`P2P#2:${r.length}件`); return r; })
            .catch(err => { console.error("P2P地震情報 過去の津波情報の取得に失敗:", err); debugParts.push(`P2P#2:失敗(${err.message})`); return []; }),
        ]);
        const p2pItems = [...p2pPage1, ...p2pPage2];
        setTsunamiHistory({
          items: mergeTsunamiSources(jmaItems, p2pItems),
          offset: TSUNAMI_HISTORY_PAGE_SIZE * 2,
          status: "ready",
          hasMore: p2pPage2.length >= TSUNAMI_HISTORY_PAGE_SIZE,
          debug: debugParts.join(" / "),
        });
        return;
      }

      // 2回目以降の「もっと見る」は、P2P地震情報側のoffsetをさらに進めて補う。
      const page = await fetchTsunamiHistoryPage(tsunamiHistory.offset, TSUNAMI_HISTORY_PAGE_SIZE);
      setTsunamiHistory(prev => ({
        items: mergeTsunamiSources(prev.items, page),
        offset: prev.offset + TSUNAMI_HISTORY_PAGE_SIZE,
        status: "ready",
        hasMore: page.length >= TSUNAMI_HISTORY_PAGE_SIZE,
        debug: `P2P追加:${page.length}件`,
      }));
    } catch (err) {
      console.error("過去の津波情報の取得に失敗:", err);
      setTsunamiHistory(prev => ({ ...prev, status: "error", debug: err.message || String(err) }));
    }
  }

  /* ─────────────────────────────────────────────────────
     潮位計(津波タブ「潮位計」モード)
     ・tsunamiViewModeはBottomDock内のローカルstateなので、地図にピンを出すか
       どうかの判断のためだけに、ここへも同じ値を通知してもらう
       (causingQuakeCardと同じ「report up」パターン)。
     ・観測点一覧(tideStations)は初めて潮位計モードを開いた時に1回だけ取得し、
       以降はキャッシュを使い回す。
     ・観測値(tideObsByStation)は地点コードごとにキャッシュし、選び直しても
       同じ日ならAPIを叩き直さない。
     ───────────────────────────────────────────────────── */
  const [tsunamiViewModeTop, setTsunamiViewModeTop] = useState("recent");
  const showTideGaugeLayer = activeNav === "tsunami" && tsunamiViewModeTop === "tidegauge";

  const [tideStations, setTideStations] = useState(EMPTY_EQDB_LIST);
  const [tideStationsStatus, setTideStationsStatus] = useState("idle"); // idle | loading | ready | error
  useEffect(() => {
    if (!showTideGaugeLayer || tideStationsStatus !== "idle") return;
    setTideStationsStatus("loading");
    fetchTideStations()
      .then(list => { setTideStations(list); setTideStationsStatus("ready"); })
      .catch(err => { console.error("潮位観測点一覧の取得に失敗:", err); setTideStationsStatus("error"); });
  }, [showTideGaugeLayer, tideStationsStatus]);

  const [selectedTideStationCode, setSelectedTideStationCode] = useState(null);
  // 潮位タブを離れたら選択を解除する(戻ってきた時に地図のピンと表示がズレないように)。
  useEffect(() => {
    if (!showTideGaugeLayer) setSelectedTideStationCode(null);
  }, [showTideGaugeLayer]);

  // 形: { [stationCode]: { date: "YYYYMMDD", status: "loading"|"ready"|"error", data } }
  const [tideObsByStation, setTideObsByStation] = useState({});
  async function loadTideObs(stationCode) {
    const dateStr = toTideDateStr(new Date());
    const cur = tideObsByStation[stationCode];
    if (cur && cur.date === dateStr && (cur.status === "loading" || cur.status === "ready")) return;
    setTideObsByStation(prev => ({ ...prev, [stationCode]: { date: dateStr, status: "loading", data: null } }));
    try {
      const data = await fetchTideObs(dateStr, stationCode);
      setTideObsByStation(prev => ({ ...prev, [stationCode]: { date: dateStr, status: "ready", data } }));
    } catch (err) {
      console.error("潮位観測値の取得に失敗:", err);
      setTideObsByStation(prev => ({ ...prev, [stationCode]: { date: dateStr, status: "error", data: null } }));
    }
  }

  // 観測点マスタ(緯度経度付き)。points[]との突き合わせに使う。
  const [stations, setStations] = useState(null);

  // 気象庁 震度データベース(eqdb)検索で開いた地震。直近一覧(quakes)には混ぜず、
  // ここだけで別管理する(P2P地震情報のWebSocket更新・件数上限に巻き込まれないようにするため)。
  const [searchQuake, setSearchQuake] = useState(null);

  // 震央分布(地図上の丸)。今どの一覧(P2P一覧/近傍地震検索/データベース検索)を
  // 表示中かに応じて、BottomDock側で計算した点の配列をそのまま受け取る。
  const [epicenterPoints, setEpicenterPoints] = useState([]);
  // 震央分布の丸が、まだ全件分バックグラウンド解決しきっていない間true。
  // 地図側でローディング表示を出すために使う。
  const [epicenterLoading, setEpicenterLoading] = useState(false);

  // 震央分布の丸をタップして選択するたびに1増える信号。BottomDock側では
  // この値が変わるたびに、フローティングの高さを「中」に揃える
  // (一覧内から選んだ時のhandleSelectQuakeForScrollと同じ挙動にするため)。
  const [mapSelectSignal, setMapSelectSignal] = useState(0);

  // 震央分布の丸がタップされた時の選択処理。
  // ・P2P地震一覧由来の点(id=通常の地震ID)は、そのままselectedQuakeIdにする。
  // ・近傍地震検索・データベース検索由来の点(id="eqdb_"始まり)は、
  //   プリフェッチ済みのeqdb詳細(_eqdbDetail)を使って即座に検索結果と同じ形の
  //   quakeカードを組み立て、searchQuakeにセットしてから選択する
  //   (座標を取得済みということは詳細も取得済みなので、再取得は不要)。
  function handleSelectEpicenterPoint(id) {
    if (typeof id === "string" && id.startsWith("eqdb_")) {
      const point = epicenterPoints.find(p => p.id === id);
      if (!point || !point._eqdbDetail) return;
      loadGeoData().then(geo => {
        const card = buildEqdbQuakeCard(point._eqdbDetail, point._eqdbListItem, stations, geo?.areas);
        setSearchQuake(card);
        setSelectedQuakeId(card.id);
        setMapSelectSignal(n => n + 1);
      });
      return;
    }
    setSelectedQuakeId(id);
    setMapSelectSignal(n => n + 1);
  }

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

  // 観測点データが多い地震(震度データベース検索由来ではない、通常の地震一覧からの選択)は、
  // 観測点マスタとの突き合わせ(resolveStationPoints)が重くなり、選択直後に一瞬固まって
  // 見えることがある。selectedQuakeが変わった直後にまずローディング表示を出し、
  // 次のタスクにずらして計算することで、その間に「観測点データを処理中…」を描画させる。
  const [selectedQuakePoints, setSelectedQuakePoints] = useState([]);
  const [stationPointsProcessing, setStationPointsProcessing] = useState(false);
  useEffect(() => {
    if (!selectedQuake) {
      setSelectedQuakePoints([]);
      setStationPointsProcessing(false);
      return;
    }
    // eqdb由来の地震は、観測点の緯度経度を自前で解決済み(resolvedPoints)なのでそのまま使う。
    if (selectedQuake.resolvedPoints) {
      setSelectedQuakePoints(selectedQuake.resolvedPoints);
      setStationPointsProcessing(false);
      return;
    }
    if (!stations) {
      setSelectedQuakePoints([]);
      return;
    }
    setStationPointsProcessing(true);
    const points = selectedQuake.points;
    const timer = setTimeout(() => {
      setSelectedQuakePoints(resolveStationPoints(points, stations));
      setStationPointsProcessing(false);
    }, 0);
    return () => clearTimeout(timer);
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

  // 津波タブの「↪︎津波を引き起こした地震」で見つかった地震(BottomDock内の
  // ローカルなcausingQuakeStateから、表示中の1件だけをここに通知してもらう)。
  // 地震タブのselectedQuakeとは別に持ち、津波タブを見ている間だけ地図に
  // 震源のバツ印・観測点の震度を表示するために使う。
  const [causingQuakeCard, setCausingQuakeCard] = useState(null);
  // 津波タブを離れたら、地図に出している「引き起こした地震」の表示は必ずクリアする。
  // これをやらないと、地震タブに移った時にそちらで選択中の地震ではなく、
  // 津波タブで最後に見ていた地震の震源・観測点が残って表示されてしまう。
  useEffect(() => {
    if (activeNav !== "tsunami") setCausingQuakeCard(null);
  }, [activeNav]);
  const causingQuakeHypocenters = useMemo(() => {
    if (!causingQuakeCard) return [];
    if (Array.isArray(causingQuakeCard.hypocenters) && causingQuakeCard.hypocenters.length > 0) {
      return causingQuakeCard.hypocenters;
    }
    if (causingQuakeCard.latitude == null || causingQuakeCard.longitude == null) return [];
    return [{ latitude: causingQuakeCard.latitude, longitude: causingQuakeCard.longitude }];
  }, [causingQuakeCard]);

  // 地図上の観測点マーカーの表示/非表示。地震タブ・津波タブ(引き起こした地震表示中)の
  // 両方で共有する(パネルの外に浮かぶ丸ボタンから切り替える)。
  const [stationMarkersVisible, setStationMarkersVisible] = useState(true);
  // 地震タブで地震を開くたびに、必ず「表示」状態からスタートする。
  useEffect(() => {
    if (selectedQuakeId != null) setStationMarkersVisible(true);
  }, [selectedQuakeId]);
  // 津波タブで「引き起こした地震」が見つかった時は、逆に「非表示」状態からスタートする
  // (津波タブでは観測点よりも津波の予報区の塗り分けを見たいことが多いため)。
  useEffect(() => {
    if (causingQuakeCard != null) setStationMarkersVisible(false);
  }, [causingQuakeCard]);

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

    fetchRecentTsunamis(TSUNAMI_FETCH_LIMIT)
      .then(list => {
        if (cancelled) return;
        setTsunamis(prev => {
          // 地震情報と同じ理由(WebSocketの新着が/historyより先に届くことがある)で、
          // idで統合してどちらか一方にしか無い分も残す。
          const byId = new Map();
          for (const t of list) byId.set(t.id, t);
          for (const t of prev) if (!byId.has(t.id)) byId.set(t.id, t);
          return dedupeTsunamiList(Array.from(byId.values())).slice(0, TSUNAMI_FETCH_LIMIT);
        });
        setTsunamiStatus("ready");
      })
      .catch(err => {
        console.error("津波情報の取得に失敗:", err);
        if (cancelled) return;
        setTsunamiStatus("error");
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
      (newTsunami) => {
        if (cancelled) return;
        setTsunamis(prev => {
          const deduped = prev.filter(t => t.id !== newTsunami.id);
          return dedupeTsunamiList([newTsunami, ...deduped]).slice(0, TSUNAMI_FETCH_LIMIT);
        });
        setTsunamiStatus("ready");
      },
      (status) => { if (!cancelled) setWsStatus(status); }
    );

    return () => { cancelled = true; socket.close(); };
  }, [quakeFetchLimit]);

  // 断層・プレート境界・観測点マーカー・推計震度分布・震央分布など、地震情報に
  // 関する地図表示は、地震タブ・設定タブを見ている間だけ出す。津波・気象・警報
  // タブを開いている間は表示をクリアする。ここで切り替えているのはMapCanvasに
  // 渡す「実効値」だけで、faultsEnabled等の設定値そのものは変えない
  // (地震タブに戻れば、元の設定のまま再び表示される)。
  // ただし津波タブで「↪︎津波を引き起こした地震」を表示している間だけは例外的に、
  // その地震の震源・観測点を地図に出す(causingQuakeCard参照)。
  const showQuakeMapLayers = activeNav === "quake" || activeNav === "settings" || (activeNav === "tsunami" && causingQuakeCard != null);

  // 津波予報区の色分けは、津波タブ・設定タブを見ている間に出す。
  // 「過去の津波(履歴)」を選んでいる時はその回の予報区を、それ以外(一覧を見て
  // いるだけの時・直近一覧から選んだ時・何も選んでいない時)は、常に「現在進行形で
  // 有効な津波情報」があればその予報区を表示する。
  const showTsunamiMapLayers = activeNav === "tsunami" || activeNav === "settings";
  const selectedFromRecent = effectiveTsunamis.find(t => t.id === selectedTsunamiId) || null;
  const selectedFromHistory = !selectedFromRecent
    ? (tsunamiHistory.items.find(t => t.id === selectedTsunamiId) || null)
    : null;
  const selectedTsunami = selectedFromRecent || selectedFromHistory;

  // 現在進行形で有効な(解除されていない)、一番新しい津波情報。
  const activeTsunami = effectiveTsunamis.find(t => !t.cancelled) || null;

  const tsunamiAreasForMap = !showTsunamiMapLayers
    ? EMPTY_EQDB_LIST
    : selectedFromHistory
    ? (selectedFromHistory.cancelled ? EMPTY_EQDB_LIST : selectedFromHistory.areas)
    : (activeTsunami ? activeTsunami.areas : EMPTY_EQDB_LIST);

  // 潮位観測点ごとに「一番近い津波予報区」を、都道府県名などのあいまいな情報ではなく、
  // 地図の海岸線描画に実際使っているtsunami-areas.json(座標データ)との距離計算で
  // 幾何学的に求める。観測点は動かないため、1回計算できればあとは使い回せる。
  const [tsunamiAreasGeoData, setTsunamiAreasGeoData] = useState(null);
  useEffect(() => {
    if (tideStations.length === 0 || tsunamiAreasGeoData) return;
    loadTsunamiAreasData()
      .then(setTsunamiAreasGeoData)
      .catch(err => console.error("津波予報区データ(座標)の取得に失敗:", err));
  }, [tideStations.length, tsunamiAreasGeoData]);

  const tideStationsWithArea = useMemo(() => {
    if (!tsunamiAreasGeoData || tideStations.length === 0) return tideStations;
    return tideStations.map(st => {
      const nearest = findNearestTsunamiArea(st.lat, st.lon, tsunamiAreasGeoData);
      return nearest ? { ...st, tsunamiAreaName: nearest.name, tsunamiAreaCode: nearest.code } : st;
    });
  }, [tideStations, tsunamiAreasGeoData]);

  // 潮位観測点に、現在有効な津波情報の警報グレードを対応付ける。上で求めた
  // 「一番近い予報区の正式名称」と、津波情報側のareas[].nameを完全一致で照合するため、
  // 都道府県名だけで大まかに合わせていた以前の方式より正確なはず。
  const tideStationsWithGrade = useMemo(() => {
    if (!activeTsunami || activeTsunami.cancelled || !Array.isArray(activeTsunami.areas) || activeTsunami.areas.length === 0) {
      return tideStationsWithArea;
    }
    return tideStationsWithArea.map(st => {
      if (!st.tsunamiAreaName) return st;
      const match = activeTsunami.areas.find(a => a.name === st.tsunamiAreaName);
      return match ? { ...st, activeGrade: match.grade } : st;
    });
  }, [tideStationsWithArea, activeTsunami]);

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
          stationPoints={showQuakeMapLayers ? (causingQuakeCard ? causingQuakeCard.resolvedPoints || EMPTY_EQDB_LIST : selectedQuakePoints) : EMPTY_EQDB_LIST}
          stationMarkersVisible={showQuakeMapLayers && stationMarkersVisible}
          tideStationPoints={showTideGaugeLayer ? tideStationsWithGrade : EMPTY_EQDB_LIST}
          onSelectTideStation={setSelectedTideStationCode}
          selectedTideStationCode={selectedTideStationCode}
          hypocenters={showQuakeMapLayers ? (causingQuakeCard ? causingQuakeHypocenters : selectedHypocenters) : EMPTY_EQDB_LIST}
          isWide={isWide}
          quakeTimeStr={causingQuakeCard ? causingQuakeCard.time : selectedQuake?.time}
          maxIntensityKey={causingQuakeCard ? causingQuakeCard.maxIntensity : selectedQuake?.maxIntensity}
          estIntensityEnabled={showQuakeMapLayers && estIntensityEnabled}
          areaFillEnabled={showQuakeMapLayers && areaFillEnabled}
          faultsEnabled={showQuakeMapLayers && faultsEnabled}
          plateBoundariesEnabled={showQuakeMapLayers && plateBoundariesEnabled}
          boundaryLineColorId={boundaryLineColorId}
          epicenterPoints={showQuakeMapLayers ? epicenterPoints : EMPTY_EQDB_LIST}
          onSelectEpicenterPoint={handleSelectEpicenterPoint}
          pointsLoading={showQuakeMapLayers && stationPointsProcessing}
          epicenterLoading={showQuakeMapLayers && epicenterLoading}
          tsunamiAreas={tsunamiAreasForMap}
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

        {/* 津波予報凡例 — 津波の予報区を地図に塗っている間だけ、画面右上に浮かぶ(震度凡例と対の構成) */}
        {activeNav === "tsunami" && tsunamiAreasForMap.length > 0 && (
          <div style={{
            position: "absolute",
            top: "calc(16px + env(safe-area-inset-top))",
            right: 16,
            zIndex: 30,
          }}>
            <TsunamiGradeLegend areas={tsunamiAreasForMap}/>
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
                      <SideNavRail active={activeNav} onNav={handleNavTap} uiScale={wideUIScale}/>
                    </div>
                    <div style={{ width: 1, alignSelf: "stretch", background: `rgba(${tokens.ink},0.14)` }}/>
                    <BottomDock
                      active={activeNav}
                      onNav={handleNavTap}
                      navCollapseSignal={navCollapseSignal}
                      layerOpen={layerOpen}
                      layers={layersForPanel}
                      onToggleLayer={toggleLayer}
                      onLayerOpenChange={setLayerOpen}
                      uiScale={wideUIScale}
                      quakes={quakes}
                  quakeStatus={quakeStatus}
                  selectedQuakeId={selectedQuakeId}
                  onSelectQuake={setSelectedQuakeId}
                  tsunamis={effectiveTsunamis}
                  tsunamiStatus={tsunamiStatus}
                  selectedTsunamiId={selectedTsunamiId}
                  onSelectTsunami={setSelectedTsunamiId}
                  tsunamiHistory={tsunamiHistory}
                  onLoadMoreTsunamiHistory={loadMoreTsunamiHistory}
                  onTsunamiViewModeChange={setTsunamiViewModeTop}
                  tideStations={tideStationsWithGrade}
                  tideStationsStatus={tideStationsStatus}
                  selectedTideStationCode={selectedTideStationCode}
                  onSelectTideStation={setSelectedTideStationCode}
                  tideObsByStation={tideObsByStation}
                  onLoadTideObs={loadTideObs}
                  onCausingQuakeChange={setCausingQuakeCard}
                  stationMarkersVisible={stationMarkersVisible}
                  onToggleStationMarkersVisible={() => setStationMarkersVisible(v => !v)}
                  stationPoints={selectedQuakePoints}
                  onChangeQuakeColorScheme={handleChangeQuakeColorScheme}
                  estIntensityEnabled={estIntensityEnabled}
                  onChangeEstIntensityEnabled={handleChangeEstIntensityEnabled}
                  areaFillEnabled={areaFillEnabled}
                  onChangeAreaFillEnabled={handleChangeAreaFillEnabled}
                  faultsEnabled={faultsEnabled}
                  onChangeFaultsEnabled={handleChangeFaultsEnabled}
                  plateBoundariesEnabled={plateBoundariesEnabled}
                  onChangePlateBoundariesEnabled={handleChangePlateBoundariesEnabled}
                  epicenterCirclesEnabled={epicenterCirclesEnabled}
                  onChangeEpicenterCirclesEnabled={handleChangeEpicenterCirclesEnabled}
                  boundaryLineColorId={boundaryLineColorId}
                  onChangeBoundaryLineColorId={handleChangeBoundaryLineColorId}
                  quakeFetchLimit={quakeFetchLimit}
                  onChangeQuakeFetchLimit={handleChangeQuakeFetchLimit}
                  stationListDisplayMode={stationListDisplayMode}
                  onChangeStationListDisplayMode={handleChangeStationListDisplayMode}
                  experimentalFeaturesEnabled={experimentalFeaturesEnabled}
                  onChangeExperimentalFeaturesEnabled={handleChangeExperimentalFeaturesEnabled}
                  testTsunami={testTsunami}
                  onBroadcastTestTsunami={broadcastTestTsunami}
                  onCancelTestTsunami={cancelTestTsunami}
                  onClearTestTsunami={clearTestTsunami}
                  stations={stations}
                  searchQuake={searchQuake}
                  onFoundSearchQuake={setSearchQuake}
                  onEpicenterPointsChange={setEpicenterPoints}
                  onEpicenterLoadingChange={setEpicenterLoading}
                  mapSelectSignal={mapSelectSignal}
                />
              </div>
            </Glass>
              </div>
          ) : (
            <BottomDock
              active={activeNav}
              onNav={handleNavTap}
              navCollapseSignal={navCollapseSignal}
              layerOpen={layerOpen}
              layers={layersForPanel}
              onToggleLayer={toggleLayer}
              onLayerOpenChange={setLayerOpen}
              quakes={quakes}
              quakeStatus={quakeStatus}
              selectedQuakeId={selectedQuakeId}
              onSelectQuake={setSelectedQuakeId}
              tsunamis={effectiveTsunamis}
              tsunamiStatus={tsunamiStatus}
              selectedTsunamiId={selectedTsunamiId}
              onSelectTsunami={setSelectedTsunamiId}
              tsunamiHistory={tsunamiHistory}
              onLoadMoreTsunamiHistory={loadMoreTsunamiHistory}
              onTsunamiViewModeChange={setTsunamiViewModeTop}
              tideStations={tideStationsWithGrade}
              tideStationsStatus={tideStationsStatus}
              selectedTideStationCode={selectedTideStationCode}
              onSelectTideStation={setSelectedTideStationCode}
              tideObsByStation={tideObsByStation}
              onLoadTideObs={loadTideObs}
              onCausingQuakeChange={setCausingQuakeCard}
              stationMarkersVisible={stationMarkersVisible}
              onToggleStationMarkersVisible={() => setStationMarkersVisible(v => !v)}
              stationPoints={selectedQuakePoints}
              onChangeQuakeColorScheme={handleChangeQuakeColorScheme}
              estIntensityEnabled={estIntensityEnabled}
              onChangeEstIntensityEnabled={handleChangeEstIntensityEnabled}
              areaFillEnabled={areaFillEnabled}
              onChangeAreaFillEnabled={handleChangeAreaFillEnabled}
              faultsEnabled={faultsEnabled}
              onChangeFaultsEnabled={handleChangeFaultsEnabled}
              plateBoundariesEnabled={plateBoundariesEnabled}
              onChangePlateBoundariesEnabled={handleChangePlateBoundariesEnabled}
              epicenterCirclesEnabled={epicenterCirclesEnabled}
              onChangeEpicenterCirclesEnabled={handleChangeEpicenterCirclesEnabled}
              boundaryLineColorId={boundaryLineColorId}
              onChangeBoundaryLineColorId={handleChangeBoundaryLineColorId}
              quakeFetchLimit={quakeFetchLimit}
              onChangeQuakeFetchLimit={handleChangeQuakeFetchLimit}
              stationListDisplayMode={stationListDisplayMode}
              onChangeStationListDisplayMode={handleChangeStationListDisplayMode}
              experimentalFeaturesEnabled={experimentalFeaturesEnabled}
              onChangeExperimentalFeaturesEnabled={handleChangeExperimentalFeaturesEnabled}
              testTsunami={testTsunami}
              onBroadcastTestTsunami={broadcastTestTsunami}
              onCancelTestTsunami={cancelTestTsunami}
              onClearTestTsunami={clearTestTsunami}
              stations={stations}
              searchQuake={searchQuake}
              onFoundSearchQuake={setSearchQuake}
              onEpicenterPointsChange={setEpicenterPoints}
              onEpicenterLoadingChange={setEpicenterLoading}
              mapSelectSignal={mapSelectSignal}
            />
          )}
        </div>

      </div>

      {/* 利用規約・プライバシーポリシー・注意事項への同意ゲート。既存のフローティング
          UI(BottomDock等)とは別の全画面オーバーレイで、未同意の間は他の操作を
          一切ブロックする。同意済み(かつ内容に更新が無い)場合は何も描画しない。 */}
      <TermsConsentGate/>
    </QuakeColorSchemeContext.Provider>
    </GlassOpaqueContext.Provider>
    </ThemeContext.Provider>
  );
}
