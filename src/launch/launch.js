// 外観（最初の描画の前）と起動アニメーション「グリッチ」。
//
// index.html の data-inline="src/launch/launch.js" の script に、開発サーバーでもビルドでもこのファイルをそのまま埋め込む
// （vite.config.ts の inlineLaunchScript。ビルドでは縮める）。アプリの本体（src/main.tsx）の読み込みを待たずに、読み込みを1つも
// 増やさずに、最初の描画の前に動く。埋め込むので import は使えない。iPhone（Safari 16）でも動くよう var と function だけで書く。
//
// - 外観: 設定（localStorage の novel-studio:prefs）から ホワイト／ダーク／ディープダーク を決め、<html data-theme> と
//   ブラウザの枠の色にする。起動後は src/ui/Layout.tsx の PrefsEffect が同じ規則で反映する
// - 起動アニメーション: 画面いっぱいの重なり（<html> の直下。<body> はまだ無い）を置き、地の色だけをその場で出す。絵は HTML を
//   読み終えた後、ふだんは Worker（OffscreenCanvas。別のスレッド）が canvas に描く（アプリの起動と取り合わない）。Worker を使えない
//   時はページの中で描く（下ごしらえは最初の描画の時）。出すのは、Web 版はウインドウ・タブを
//   開いた最初の1回（再読み込みでは出さない）、iPhone / Android のアプリは起動のたび（裏から戻る時はページを読み込み直さないので出ない）。
//   設定の「起動アニメーション」をオフにすると出さない。テスト（navigator.webdriver）では、localStorage の novel-studio:launch を
//   'force' にするか URL に launch=1 を付けた時だけ出す（e2e/launch.spec.ts）
// - 消える時: アニメーションが終わり（約1.75秒）、アプリが最初の画面を出せた（src/main.tsx が NovelStudioLaunch.appReady() を呼ぶ）
//   の両方がそろったら、0.25秒で消える。押す・キーを押すとすぐ消える（押した時は、離すまで見えない重なりが残って押す操作の
//   続きを受け止めるので、下のアプリは押されない）。アプリが知らせてこなくても5秒で消える。
//   端末の「視差効果を減らす」では動かさず、最後の絵（ロゴ）を描いてから0.5秒ほど出して消える
// - アプリでは、重なり（起動の画面と同じ地の色）を置いたらすぐに起動の画面（スプラッシュ。ロゴの無い無地）を消す（docs/SPEC-2.md の 10.）
//
// 仕様は docs/SPEC.md の「起動アニメーション」。単体テストは src/launch/launch.test.ts
;(function (window, document) {
  'use strict'

  var PREFS_KEY = 'novel-studio:prefs'
  /** 'force' にすると、テスト（navigator.webdriver）でも起動アニメーションを出す */
  var FORCE_KEY = 'novel-studio:launch'
  /** このウインドウ・タブで一度出した印（sessionStorage。再読み込みでは出さない） */
  var SESSION_KEY = 'novel-studio:launched'

  // ================================================================ 外観

  /** ブラウザの枠（アドレスバー・ステータスバー）の色。src/store/uiStore.ts の THEME_COLORS と同じ（変える時は両方そろえる） */
  var THEME_COLORS = { white: '#ffffff', dark: '#17181b', 'deep-dark': '#0e0f11' }

  /** localStorage など（使えない環境では null。触っただけで例外になるブラウザがある） */
  function storageOf(name) {
    try {
      return window[name] || null
    } catch (e) {
      return null
    }
  }

  function getItem(storage, key) {
    try {
      return storage ? storage.getItem(key) : null
    } catch (e) {
      return null
    }
  }

  function setItem(storage, key, value) {
    try {
      if (storage) storage.setItem(key, value)
    } catch (e) {
      /* 覚えられなくても動作は続ける */
    }
  }

  /** 端末ごとの表示の設定（src/store/uiStore.ts の Prefs）。読めなければ空 */
  function readPrefs(storage) {
    try {
      var prefs = JSON.parse(getItem(storage, PREFS_KEY) || '{}')
      return prefs && typeof prefs === 'object' ? prefs : {}
    } catch (e) {
      return {}
    }
  }

  function mediaMatches(query) {
    try {
      return !!(window.matchMedia && window.matchMedia(query).matches)
    } catch (e) {
      return false
    }
  }

  /**
   * 設定の外観から実際の外観（'white' | 'dark' | 'deep-dark'）を決める。
   * 「端末の設定に合わせる」（system）と分からない値は、端末がダークならダーク、そうでなければホワイト（src/store/uiStore.ts の
   * resolveAppearance と同じ）。1.x の 'light' はホワイト（migratePrefs と同じ）
   */
  function resolveAppearance(prefs, systemDark) {
    var mode = prefs && typeof prefs.theme === 'string' ? (prefs.theme === 'light' ? 'white' : prefs.theme) : 'system'
    if (!Object.prototype.hasOwnProperty.call(THEME_COLORS, mode)) mode = systemDark ? 'dark' : 'white'
    return mode
  }

  /** 外観を <html data-theme> とブラウザの枠の色にする */
  function applyAppearance(appearance) {
    document.documentElement.setAttribute('data-theme', appearance)
    var meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', THEME_COLORS[appearance])
  }

  // ================================================================ 出すかどうか

  /** 外観 → アニメーションの色の組（ホワイトは白地に赤、ダークは黒地に緑、ディープダークは暗い緑） */
  var ANIMATION_THEMES = { white: 'light', dark: 'dark', 'deep-dark': 'deep' }

  function animationTheme(appearance) {
    return ANIMATION_THEMES[appearance] || 'dark'
  }

  /**
   * 起動アニメーションを出すか。戻り値は 'none'（出さない）・'play'（動かす）・'still'（動かさずに最後の絵だけ）。
   *   enabled: 設定の「起動アニメーション」（既定オン）
   *   native: iPhone / Android のアプリ（起動のたびに出す）
   *   webdriver: テスト（Playwright など）。forced でなければ出さない
   *   forced: localStorage の novel-studio:launch が 'force'、または URL に launch=1
   *   shownInSession: Web 版で、このウインドウ・タブではもう出した（再読み込み）
   *   hidden: Web 版で、見えていないタブ（裏で開いたタブ・ブラウザが先読みしているページ）。見えないまま終わるので出さない
   *     （そのタブが見えた時に出したことにして、後の再読み込みでも出さない。markWhenVisible）
   *   reducedMotion: 端末の「視差効果を減らす」（prefers-reduced-motion）
   */
  function decide(env) {
    if (!env.enabled) return 'none'
    if (env.webdriver && !env.forced) return 'none'
    if (!env.native && (env.shownInSession || env.hidden)) return 'none'
    return env.reducedMotion ? 'still' : 'play'
  }

  /** iPhone / Android のアプリ（Capacitor の仕組みは、ページのスクリプトより先に入っている） */
  function isNativeApp() {
    try {
      var cap = window.Capacitor
      return !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform())
    } catch (e) {
      return false
    }
  }

  function isForced(local) {
    if (getItem(local, FORCE_KEY) === 'force') return true
    try {
      return /[?&]launch=1(&|$)/.test(window.location.search)
    } catch (e) {
      return false
    }
  }

  // ================================================================ 消すまでの流れ

  var TIMING = {
    /** 動かさない時（視差効果を減らす）に、最後の絵を出しておく時間（最後の絵を描いてから stillMs） */
    stillMs: 500,
    /** アプリが知らせてこない時も、これより長くは出さない（出し始めてから） */
    capMs: 5000,
    /** 消える時のフェード */
    fadeMs: 250,
  }

  /**
   * いつ消すかを決める（画面には触らない。時計と、消す・取り除く処理を受け取る）。
   * アニメーションの終わり（animationEnded）とアプリの知らせ（appReady）の両方がそろったら消し始める（onFadeOut）。
   * 押した・キーを押した（skip）時と、出し始めてから capMs たった時は、そろっていなくても消し始める。
   * 消し始めてから fadeMs たったら取り除く（onRemove）。
   * 動かさない時（still）は、最後の絵を描いた（stillShown）時から stillMs たったら、アニメーションの終わりとする
   * （描く準備・Worker の立ち上がりに時間がかかっても、ロゴを stillMs は出す）。
   *   o: { still, setTimeout, clearTimeout, onFadeOut(reason), onRemove(), timing }
   *   reason: 'done'（両方そろった）・'skip'・'cap'
   */
  function createController(o) {
    var timing = o.timing || TIMING
    var state = 'idle'
    var ended = false
    var ready = false
    var shown = false
    var timers = []

    function later(fn, ms) {
      timers.push(o.setTimeout(fn, ms))
    }

    function fadeOut(reason) {
      if (state !== 'playing') return
      state = 'fading'
      for (var i = 0; i < timers.length; i++) o.clearTimeout(timers[i])
      timers = []
      o.onFadeOut(reason)
      o.setTimeout(function () {
        state = 'removed'
        o.onRemove()
      }, timing.fadeMs)
    }

    function check() {
      if (ended && ready) fadeOut('done')
    }

    var controller = {
      start: function () {
        if (state !== 'idle') return
        state = 'playing'
        later(function () {
          fadeOut('cap')
        }, timing.capMs)
        check()
      },
      /** アニメーションが終わった（動かさない時は、最後の絵を描いてから stillMs たった） */
      animationEnded: function () {
        ended = true
        if (state === 'playing') check()
      },
      /** 最後の絵を描いた（動かさない時は、ここから最後の絵を stillMs 出して、アニメーションの終わりとする） */
      stillShown: function () {
        if (!o.still || state !== 'playing' || shown) return
        shown = true
        later(controller.animationEnded, timing.stillMs)
      },
      /** アプリが最初の画面を出せた */
      appReady: function () {
        ready = true
        if (state === 'playing') check()
      },
      /** 押した・キーを押した */
      skip: function () {
        fadeOut('skip')
      },
      /** 'idle' → 'playing' → 'fading' → 'removed' */
      state: function () {
        return state
      },
    }
    return controller
  }

  // ================================================================ アニメーション「グリッチ」

  /**
   * 描く部品。CRT が温まるように数本のレーザーが明滅し、色ずれと共に一瞬で原稿用紙のマス目へ揃って「物語を、書く。」が灯り、
   * マス目が一本の線に潰れて上下に開くと点の「Novel Studio」が現れ、最後に走査線が一度だけ通り抜ける。
   * ページの中でも Worker（別のスレッド。OffscreenCanvas）でも動かすので、この関数の外にあるものは使わない
   * （Worker にはこの関数を文字列にして渡す）。
   *   env.canvas(w, h): 下ごしらえ用の canvas を作る
   *   env.requestFrame(cb)・env.cancelFrame(id): 次の描画（requestAnimationFrame）
   */
  function glitchRenderer(env) {
    var DURATION = 1.75

    // 色の組。blend: 光の重ね方（暗い地は足し合わせて光らせる）、glow: 光の強さ、flicker: ちらつきの強さ
    var PALETTES = {
      light: {
        bg: '#fbfcfe',
        laser: '#ff2638',
        core: '#e8112c',
        logo: '#c8102e',
        hot: '#ff2638',
        splitA: '#00b8f0',
        splitB: '#6a4dff',
        blend: 'source-over',
        glow: 0.85,
        flicker: 1,
        vignette: 'rgba(40,0,10,0.03)',
        scanline: 'rgba(0,0,0,0.016)',
      },
      dark: {
        bg: '#050607',
        laser: '#2bff73',
        core: '#a8ffc6',
        logo: '#2bff73',
        hot: '#eafff1',
        splitA: '#ff2b6e',
        splitB: '#2b7bff',
        blend: 'lighter',
        glow: 1,
        flicker: 1,
        vignette: 'rgba(0,0,0,0.6)',
        scanline: 'rgba(0,0,0,0.24)',
      },
      deep: {
        bg: '#000000',
        laser: '#1a9c4c',
        core: '#46c47a',
        logo: '#1a9c4c',
        hot: '#7fe0a6',
        splitA: '#6a1430',
        splitB: '#14366a',
        blend: 'lighter',
        glow: 0.45,
        flicker: 0.35,
        vignette: 'rgba(0,0,0,0.5)',
        scanline: 'rgba(0,0,0,0.24)',
      },
    }

    // 点の字（液晶の 5×7。1 が点く）。アイコンの「NS」も同じ字（scripts/icon-art.mjs）
    var GLYPHS = {
      N: ['10001', '10001', '11001', '10101', '10011', '10001', '10001'],
      o: ['00000', '00000', '01110', '10001', '10001', '10001', '01110'],
      v: ['00000', '00000', '10001', '10001', '10001', '01010', '00100'],
      e: ['00000', '00000', '01110', '10001', '11111', '10000', '01110'],
      l: ['01100', '00100', '00100', '00100', '00100', '00100', '01110'],
      S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
      t: ['01000', '01000', '11100', '01000', '01000', '01001', '00110'],
      u: ['00000', '00000', '10001', '10001', '10001', '10011', '01101'],
      d: ['00001', '00001', '01101', '10011', '10001', '10001', '01111'],
      i: ['00100', '00000', '01100', '00100', '00100', '00100', '01110'],
    }

    // 温まる間のレーザー。6つずつ: 始まり（秒）・長さ（秒）・向き（0 横・1 縦）・位置（画面の割合）・流れ（終わりまでに動く割合）・
    // 出方（0 点滅、1 前へ伸びる、-1 後ろから伸びる、2 中央から両側へ）
    // prettier-ignore
    var WARMUP = [
      0, 0.13, 0, 0.48, 0, 2,
      0.07, 0.08, 1, 0.71, -0.04, 0,
      0.1, 0.11, 0, 0.29, 0.05, 1,
      0.16, 0.07, 1, 0.21, 0.05, 0,
      0.2, 0.13, 1, 0.57, 0, -1,
      0.26, 0.08, 0, 0.67, -0.04, 0,
      0.3, 0.08, 0, 0.4, 0.03, -1,
      0.33, 0.07, 1, 0.37, -0.03, 0,
    ]

    // 流れ（秒）
    var T_SNAP = 0.4 // マス目に揃う
    var T_TEXT = 0.47 // 「物語を、書く。」が1字ずつ灯り始める
    var T_COLLAPSE = 0.9 // マス目が一本の線に潰れ始める
    var T_LINE = 1.03 // 一本の線
    var T_OPEN = 1.09 // 線が上下に開き始める
    var T_OPENED = 1.24 // 開き終わり、ロゴだけになる
    var T_SCAN0 = 1.3 // 走査線が通り始める
    var T_SCAN1 = 1.62 // 通り終わる

    /** 決まった並びの乱数（同じ n には同じ値。0〜1） */
    function hash(n) {
      var s = Math.sin(n * 127.1 + 311.7) * 43758.5453
      return s - Math.floor(s)
    }

    /** '#rrggbb' → 'rgba(r,g,b,a)' */
    function rgba(hex, a) {
      var n = parseInt(hex.slice(1), 16)
      return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')'
    }

    function clamp01(v) {
      return v < 0 ? 0 : v > 1 ? 1 : v
    }

    /**
     * cv（canvas か OffscreenCanvas。大きさはここで決める）に描く。最初の絵は呼んだその場で描く。
     *   size: { width, height, dpr, safe }。width・height は画面全体の大きさ（CSS ピクセル）、dpr は画素の細かさ。
     *     safe: { top, right, bottom, left }（ノッチ・ホームバーの分）。絵はそれを除いた所の中央に置く（線と背景は画面いっぱい）
     *   theme: 'light' | 'dark' | 'deep'
     *   opts.still: 動かさずに最後の絵だけ描く。opts.at: その秒の絵だけ描く（確かめ用）
     *   opts.onEnd(): 動かした時に、最後まで描いたら呼ぶ
     * 戻り値: { stop()（止める）, dispose()（止めて、作った canvas の中身を手放す）, drawAt(t) }
     */
    function start(cv, size, theme, opts) {
      opts = opts || {}
      var pal = PALETTES[theme] || PALETTES.dark
      var light = pal.blend !== 'lighter'
      var G = pal.glow
      var FK = pal.flicker
      var made = []
      var i

      function canvas(w, h) {
        var c = env.canvas(w, h)
        made.push(c)
        return c
      }

      // ---- 大きさ（CSS ピクセル）。W・H は画面全体。絵は安全な領域（safe）の中央に置く
      var W = size.width
      var H = size.height
      var dpr = size.dpr
      var safe = size.safe || {}
      var safeL = safe.left || 0
      var safeT = safe.top || 0
      var safeW = Math.max(1, W - safeL - (safe.right || 0))
      var safeH = Math.max(1, H - safeT - (safe.bottom || 0))

      cv.width = Math.round(W * dpr)
      cv.height = Math.round(H * dpr)
      made.push(cv)
      var ctx = cv.getContext('2d', { alpha: false })
      if (!ctx) throw new Error('canvas を使えません')
      var CW = cv.width
      var CH = cv.height
      // 線の太さなどの倍率と、絵の中心
      var k = Math.max(0.8, Math.min(1.7, Math.min(safeW, safeH * 0.46) / 250))
      var cx = safeL + safeW / 2
      var cy = safeT + safeH * 0.48

      /** 光の粒（中心が明るく外へ消える丸。64px の絵を伸ばして使う） */
      function glowSprite(color) {
        var s = canvas(64, 64)
        var g = s.getContext('2d')
        var r = g.createRadialGradient(32, 32, 0, 32, 32, 32)
        r.addColorStop(0, rgba(color, 1))
        r.addColorStop(0.22, rgba(color, 0.45))
        r.addColorStop(1, rgba(color, 0))
        g.fillStyle = r
        g.fillRect(0, 0, 64, 64)
        return s
      }
      var spark = glowSprite(pal.laser)

      // ---- 原稿用紙のマス目: 8行（縦の列）×12マス。真ん中に柱（綴じ目の帯）
      var COLS = 8
      var ROWS = 12
      var cell = Math.min((safeW * 0.8) / 10.4, (safeH * 0.6) / 12.6)
      var gridW = 10.4 * cell
      var gridH = ROWS * cell
      var gridX = cx - gridW / 2
      var gridY = cy - gridH / 2
      var colX = []
      var xx = gridX
      for (i = 0; i < COLS; i++) {
        colX[i] = xx
        xx += cell + (i === 3 ? 0.9 * cell : i < 7 ? 0.25 * cell : 0)
      }

      // マス目の縮み（横・縦）と、色ずれの横のずれ
      var SX = 1
      var SY = 1
      var OX = 0
      function gx(v) {
        return cx + (v - cx) * SX + OX
      }
      function gy(v) {
        return cy + (v - cy) * SY
      }
      function gridPath() {
        ctx.beginPath()
        var top = gy(gridY)
        var bottom = gy(gridY + gridH)
        var a, b, r, y
        for (var j = 0; j < COLS; j++) {
          a = gx(colX[j])
          b = gx(colX[j] + cell)
          ctx.moveTo(a, top)
          ctx.lineTo(a, bottom)
          ctx.moveTo(b, top)
          ctx.lineTo(b, bottom)
          for (r = 0; r <= ROWS; r++) {
            y = gy(gridY + r * cell)
            ctx.moveTo(a, y)
            ctx.lineTo(b, y)
          }
        }
        var m = cell * 0.32
        ctx.rect(gx(gridX - m), gy(gridY - m), (gridW + 2 * m) * SX, (gridH + 2 * m) * SY)
        // 柱の飾り（魚尾）
        a = gx(colX[3] + cell)
        b = gx(colX[4])
        y = gridY + 1.5 * cell
        ctx.moveTo(a, gy(y))
        ctx.lineTo(b, gy(y))
        ctx.moveTo(a, gy(y + 0.3 * cell))
        ctx.lineTo((a + b) / 2, gy(y + 0.65 * cell))
        ctx.lineTo(b, gy(y + 0.3 * cell))
      }

      /** 今のパスをレーザーとして描く（太く淡い光 → 細めの光 → 芯） */
      function laser(alpha, width, color, coreColor) {
        if (alpha <= 0) return
        ctx.strokeStyle = color
        ctx.globalAlpha = Math.min(1, alpha * 0.1 * G)
        ctx.lineWidth = 8 * k * width
        ctx.stroke()
        ctx.globalAlpha = Math.min(1, alpha * 0.3 * G)
        ctx.lineWidth = 3 * k * width
        ctx.stroke()
        if (coreColor) {
          ctx.strokeStyle = coreColor
          ctx.globalAlpha = Math.min(1, alpha)
          ctx.lineWidth = 1.1 * Math.min(k, 1.25) * width
          ctx.stroke()
        }
      }

      /** 今のパスを色ずれの細い線として描く */
      function thinLine(alpha, color) {
        ctx.strokeStyle = color
        ctx.globalAlpha = Math.min(1, alpha)
        ctx.lineWidth = 1.3 * k
        ctx.stroke()
        if (!light) {
          ctx.globalAlpha = Math.min(1, alpha * 0.25 * G)
          ctx.lineWidth = 4 * k
          ctx.stroke()
        }
      }

      // ---- 点の「Novel Studio」: 37列×18行の点の並び（Novel が上、Studio が下）
      var LOGO_COLS = 37
      var LOGO_ROWS = 18
      var lit = new Uint8Array(LOGO_COLS * LOGO_ROWS)
      var dots = []
      function putText(text, col0, row0) {
        for (var q = 0; q < text.length; q++) {
          var glyph = GLYPHS[text.charAt(q)]
          for (var r = 0; r < 7; r++) {
            for (var b = 0; b < 5; b++) if (glyph[r].charAt(b) === '1') lit[(row0 + r) * LOGO_COLS + col0 + q * 6 + b] = 1
          }
        }
      }
      putText('Novel', 4, 1)
      putText('Studio', 1, 10)
      for (i = 0; i < lit.length; i++) if (lit[i]) dots.push(i % LOGO_COLS, (i / LOGO_COLS) | 0)

      // 点の間隔（実ピクセルの整数にして、点がにじまないようにする）、点の大きさ、ロゴの大きさと位置
      var pd = Math.max(2, Math.round(Math.min((safeW * 0.76) / LOGO_COLS, (safeH * 0.26) / LOGO_ROWS) * dpr))
      var p = pd / dpr
      var qd = Math.max(1, Math.round(pd * 0.78))
      var lw = LOGO_COLS * p
      var lh = LOGO_ROWS * p
      var pad = Math.ceil(3 * p)
      var LW = Math.round(lw * dpr) + 2 * pad * dpr
      var LH = Math.round(lh * dpr) + 2 * pad * dpr
      var lx = Math.round((cx - lw / 2 - pad) * dpr) / dpr
      var ly = Math.round((cy - lh / 2 - pad) * dpr) / dpr

      /** ロゴを1枚の絵にしておく（color の点。glowAlpha: 点の周りの光、offAlpha: 消えている点の濃さ、coreColor: 点の芯） */
      function logoImage(color, glowAlpha, offAlpha, coreColor) {
        var cn = canvas(LW, LH)
        var g = cn.getContext('2d')
        var o = pad * dpr + ((pd - qd) >> 1)
        var j
        if (glowAlpha) {
          var S = glowSprite(color)
          var rr = pd * 2.3
          g.globalCompositeOperation = light ? 'source-over' : 'lighter'
          g.globalAlpha = glowAlpha
          for (j = 0; j < dots.length; j += 2) {
            var X = o + dots[j] * pd + qd / 2
            var Y = o + dots[j + 1] * pd + qd / 2
            g.drawImage(S, X - rr, Y - rr, 2 * rr, 2 * rr)
          }
        }
        g.globalCompositeOperation = 'source-over'
        g.fillStyle = color
        if (offAlpha) {
          g.globalAlpha = offAlpha
          for (j = 0; j < lit.length; j++)
            if (!lit[j]) g.fillRect(o + (j % LOGO_COLS) * pd, o + ((j / LOGO_COLS) | 0) * pd, qd, qd)
        }
        g.globalAlpha = 1
        for (j = 0; j < dots.length; j += 2) g.fillRect(o + dots[j] * pd, o + dots[j + 1] * pd, qd, qd)
        if (coreColor) {
          g.fillStyle = coreColor
          var e = Math.max(1, Math.round(qd * 0.3))
          for (j = 0; j < dots.length; j += 2) g.fillRect(o + dots[j] * pd + e, o + dots[j + 1] * pd + e, qd - 2 * e, qd - 2 * e)
        }
        return cn
      }
      var logoRest = logoImage(pal.logo, light ? 0.07 : 0.16 * G, light ? 0.035 : 0.065, 0)
      var logoHot = logoImage(pal.hot, light ? 0.1 : 0.3 * G, 0, light ? 0 : pal.hot)
      var logoA = logoImage(pal.splitA, 0, 0, 0)
      var logoB = logoImage(pal.splitB, 0, 0, 0)

      /** ロゴの y1〜y2 の帯だけを、横に dx ずらして描く */
      function drawLogo(img, alpha, dx, y1, y2) {
        if (alpha <= 0) return
        var s0 = Math.max(0, Math.round((y1 - ly) * dpr))
        var s1 = Math.min(LH, Math.round((y2 - ly) * dpr))
        if (s1 <= s0) return
        ctx.globalAlpha = Math.min(1, alpha)
        ctx.drawImage(img, 0, s0, LW, s1 - s0, lx + dx, ly + s0 / dpr, LW / dpr, (s1 - s0) / dpr)
      }

      // ---- 走査線と周辺減光（先に1枚の絵にしておく。走査線の間隔だけ縦に長く、ずらして流す）
      var per = Math.max(2, Math.round(3 * dpr))
      var overlay = canvas(CW, CH + per)
      var og = overlay.getContext('2d')
      og.fillStyle = pal.scanline
      for (i = 0; i < CH + per; i += per) og.fillRect(0, i, CW, Math.max(1, Math.round(dpr)))
      var vignette = og.createRadialGradient(cx * dpr, cy * dpr + per, H * 0.2 * dpr, cx * dpr, cy * dpr + per, H * 0.78 * dpr)
      vignette.addColorStop(0, 'rgba(0,0,0,0)')
      vignette.addColorStop(1, pal.vignette)
      og.fillStyle = vignette
      og.fillRect(0, 0, CW, CH + per)
      // 最後に通り抜ける走査線の帯
      var bar = canvas(2, 64)
      var bg = bar.getContext('2d')
      var barGradient = bg.createLinearGradient(0, 0, 0, 64)
      barGradient.addColorStop(0, rgba(pal.laser, 0))
      barGradient.addColorStop(0.85, rgba(pal.laser, 1))
      barGradient.addColorStop(1, rgba(pal.laser, 0))
      bg.fillStyle = barGradient
      bg.fillRect(0, 0, 2, 64)

      // ---- 「物語を、書く。」（いちばん右の列に縦に。毎回は字を組まず、先に絵にしておく）
      var FONT =
        '600 ' +
        Math.round(cell * 0.68) +
        'px "Hiragino Mincho ProN","Yu Mincho","YuMincho","Noto Serif JP","Noto Serif CJK JP","MS Mincho",serif'
      var TEXT = '物語を、書く。'
      var tm = Math.ceil(cell * 0.4)
      var TW = cell + 2 * tm
      function textImage(color) {
        var cn = canvas(Math.ceil(TW * dpr), Math.ceil((7 * cell + 2 * tm) * dpr))
        var g = cn.getContext('2d')
        g.scale(dpr, dpr)
        g.font = FONT
        g.textAlign = 'center'
        g.textBaseline = 'middle'
        g.fillStyle = color
        g.shadowColor = pal.laser
        g.shadowBlur = (light ? 4 : 10) * k * dpr * G
        for (var j = 0; j < 7; j++) {
          var px = tm + cell / 2
          var py = tm + (j + 0.5) * cell
          // 句読点はマスの右上
          if (j === 3 || j === 6) {
            px += cell * 0.3
            py -= cell * 0.3
          }
          g.fillText(TEXT.charAt(j), px, py)
        }
        return cn
      }
      var textCore = textImage(pal.core)
      var textHot = textImage(pal.hot)

      // ---- 1枚の絵
      var GDX = 0 // グリッチの帯の横ずれ
      function baseTransform() {
        ctx.setTransform(dpr, 0, 0, dpr, dpr * GDX, 0)
      }

      function scene(t) {
        ctx.globalCompositeOperation = pal.blend
        var u = 0
        var e, a, j

        // 1. 温まる: レーザーが数本明滅する
        for (j = 0; j < WARMUP.length; j += 6) {
          var start = WARMUP[j]
          var length = WARMUP[j + 1]
          if (t < start || t > start + length) continue
          u = (t - start) / length
          var vertical = WARMUP[j + 2]
          var pos = WARMUP[j + 3] + WARMUP[j + 4] * u
          var mode = WARMUP[j + 5]
          var L = vertical ? H : W
          var a0 = 0
          var a1 = L
          var f = clamp01(u / 0.6)
          f = 1 - (1 - f) * (1 - f) * (1 - f)
          if (mode === 1) a1 = L * f
          else if (mode === -1) a0 = L * (1 - f)
          else if (mode === 2) {
            a0 = L * (0.5 - 0.5 * f)
            a1 = L * (0.5 + 0.5 * f)
          }
          a = (1 - u * u) * (hash(Math.floor(t * 90) + j) > 0.55 ? 1 - 0.65 * FK : 1)
          ctx.beginPath()
          if (vertical) {
            ctx.moveTo(pos * W, a0)
            ctx.lineTo(pos * W, a1)
          } else {
            ctx.moveTo(a0, pos * H)
            ctx.lineTo(a1, pos * H)
          }
          laser(a, 1.15, pal.laser, pal.core)
          if (mode === 2) {
            ctx.globalAlpha = a * 0.5 * G
            ctx.drawImage(spark, a0 - 12 * k, pos * H - 12 * k, a1 - a0 + 24 * k, 24 * k)
          }
          if (mode === 1 || mode === -1) {
            var head = mode === 1 ? a1 : a0
            var hr = 10 * k
            ctx.globalAlpha = a * G
            ctx.drawImage(spark, (vertical ? pos * W : head) - hr, (vertical ? head : pos * H) - hr, 2 * hr, 2 * hr)
          }
        }

        // 2. 原稿用紙のマス目に揃う → 「物語を、書く。」が灯る → 一本の線に潰れる
        if (t >= T_SNAP && t < T_LINE) {
          SX = SY = 1
          OX = 0
          var sa = 1
          var d = 0
          if (t < T_SNAP + 0.1) sa = hash(Math.floor(t * 60) * 3.1) > 0.3 ? 1.2 : 0.25
          else sa = 0.92 + 0.08 * hash(Math.floor(t * 30))
          u = clamp01((t - T_SNAP) / 0.24)
          d = 5 * k * (1 - u) * (1 - u) * (0.5 + hash(Math.floor(t * 45))) * (0.4 + 0.6 * FK)
          if (t >= T_COLLAPSE) {
            e = clamp01((t - T_COLLAPSE) / (T_LINE - T_COLLAPSE))
            e = e * e * e
            SY = 1 - 0.995 * e
            SX = 1 + e * (lw / gridW - 1)
            sa *= light ? 1 - 0.4 * e : 1 + 0.5 * e
            d = light ? 0 : 2 * k * e * FK
          }
          // 画面の端から飛んできて揃う
          if (t < T_SNAP + 0.18) {
            var X = 1 - clamp01((t - T_SNAP) / 0.18)
            X *= X
            ctx.beginPath()
            for (j = 0; j < COLS; j++) {
              ctx.moveTo(colX[j], gridY * (1 - X))
              ctx.lineTo(colX[j], gridY + gridH + (H - gridY - gridH) * X)
              ctx.moveTo(colX[j] + cell, gridY * (1 - X))
              ctx.lineTo(colX[j] + cell, gridY + gridH + (H - gridY - gridH) * X)
            }
            for (j = 0; j <= ROWS; j++) {
              ctx.moveTo(gridX * (1 - X), gridY + j * cell)
              ctx.lineTo(gridX + gridW + (W - gridX - gridW) * X, gridY + j * cell)
            }
            laser(0.7 * X * sa, 0.8, pal.laser, pal.core)
          }
          // 色ずれ
          if (d > 0.2) {
            OX = -d
            gridPath()
            thinLine(0.6 * sa, pal.splitA)
            OX = d
            gridPath()
            thinLine(0.6 * sa, pal.splitB)
            OX = 0
          }
          gridPath()
          laser(sa, 1, pal.laser, pal.core)
          if (t >= T_TEXT) {
            var n = Math.min(7, Math.floor((t - T_TEXT) / 0.042) + 1)
            var bx = colX[7] - tm
            var by = gridY - tm
            var hh = tm + n * cell
            var jh = n - 1
            ctx.setTransform(dpr * SX, 0, 0, dpr * SY, dpr * (cx * (1 - SX) + OX + GDX), dpr * cy * (1 - SY))
            ctx.globalAlpha = clamp01(sa) * (t >= T_COLLAPSE ? 1 - clamp01((t - T_COLLAPSE) / (T_LINE - T_COLLAPSE - 0.03)) : 1)
            ctx.drawImage(textCore, 0, 0, textCore.width, hh * dpr, bx, by, TW, hh)
            // 灯ったばかりの字は明るく
            if (t - T_TEXT - jh * 0.042 < 0.06) {
              ctx.drawImage(textHot, 0, (tm + jh * cell) * dpr, textCore.width, cell * dpr, bx, by + tm + jh * cell, TW, cell)
            }
            baseTransform()
          }
        }

        // 3. 一本の線が上下に開いて、ロゴが現れる
        if (t >= T_LINE - 0.01 && t < T_OPENED) {
          var hw = lw / 2 + 2 * k
          var hf
          if (t < T_OPEN) {
            hf = 0
            a = 1.3
          } else {
            u = clamp01((t - T_OPEN) / (T_OPENED - T_OPEN))
            hf = (lh / 2 + p) * (1 - (1 - u) * (1 - u) * (1 - u))
            a = 1.2 * (1 - clamp01((u - 0.55) / 0.45))
          }
          if (hf > 0) {
            if (u < 1) {
              e = (1 - u) * (1 - u)
              drawLogo(logoA, e * 0.8, -4 * k * e, cy - hf, cy + hf)
              drawLogo(logoB, e * 0.8, 4 * k * e, cy - hf, cy + hf)
            }
            drawLogo(logoRest, 1, 0, cy - hf, cy + hf)
          }
          ctx.beginPath()
          ctx.moveTo(cx - hw, cy - hf)
          ctx.lineTo(cx + hw, cy - hf)
          if (hf > 0) {
            ctx.moveTo(cx - hw, cy + hf)
            ctx.lineTo(cx + hw, cy + hf)
          }
          laser(a, t < T_OPEN ? 1.5 : 1, pal.laser, pal.core)
          if (t < T_OPEN + 0.04) {
            ctx.globalAlpha = (light ? 0.25 : 0.55) * G * (t < T_OPEN ? 1 : 1 - (t - T_OPEN) / 0.04)
            ctx.drawImage(spark, cx - hw * 1.25, cy - 14 * k, hw * 2.5, 28 * k)
          }
        }

        // 4. ロゴ。最後に走査線が一度だけ通り抜ける
        if (t >= T_OPENED) {
          drawLogo(logoRest, 1, 0, ly, ly + LH / dpr)
          if (t >= T_SCAN0 && t < T_SCAN1) {
            u = (t - T_SCAN0) / (T_SCAN1 - T_SCAN0)
            u = u < 0.5 ? 2 * u * u : 1 - 2 * (1 - u) * (1 - u)
            var bh = H * 0.11
            var yb = -bh + (H + 2 * bh) * u
            var am = FK < 1 ? 0.6 : 1
            ctx.globalAlpha = (light ? 0.07 : 0.09) * am
            ctx.drawImage(bar, 0, yb - bh, W, bh)
            ctx.globalAlpha = (light ? 0.25 : 0.3) * am
            ctx.fillStyle = pal.laser
            ctx.fillRect(0, yb - 1 * k, W, 1 * k)
            ctx.globalCompositeOperation = light ? 'source-over' : 'lighter'
            drawLogo(logoHot, 0.45 * am, 0, yb - bh, yb - bh * 0.4)
            drawLogo(logoHot, am, 0, yb - bh * 0.4, yb + 1)
          }
        }
      }

      function fillBackground(t, y, h) {
        ctx.globalCompositeOperation = 'source-over'
        ctx.globalAlpha = 1
        ctx.fillStyle = pal.bg
        ctx.fillRect(0, y, W, h)
        // 温まり始めのちらつき
        if (t < 0.16) {
          ctx.fillStyle = rgba(pal.laser, (light ? 0.03 : 0.05) * G * (1 - t / 0.16) * (hash(Math.floor(t * 60)) > 0.4 ? 1 : 0.4))
          ctx.fillRect(0, y, W, h)
        }
      }

      /** t 秒の絵を描く */
      function draw(t) {
        GDX = 0
        baseTransform()
        fillBackground(t, 0, H)
        scene(t)
        // グリッチ: 横の帯をいくつか、横にずらして描き直す（信号の乱れ）
        var ga =
          t >= T_SNAP && t < T_SNAP + 0.1 ? 10 : t >= 0.8 && t < 0.83 ? 6 : t >= T_OPENED - 0.04 && t < T_OPENED + 0.03 ? 7 : 0
        if (ga && (FK > 0.5 || hash(Math.floor(t * 40)) > 0.5)) {
          ga *= k * (0.4 + 0.6 * FK)
          var seed = Math.floor(t * 40)
          for (var j = 0; j < 3; j++) {
            var sliceY = hash(seed + j * 1.7) * H
            var sliceH = (0.012 + 0.05 * hash(seed + j * 2.3)) * H
            GDX = 0
            baseTransform()
            ctx.save()
            ctx.beginPath()
            ctx.rect(0, sliceY, W, sliceH)
            ctx.clip()
            fillBackground(t, sliceY, sliceH)
            GDX = (hash(seed + j * 3.1) - 0.5) * 2 * ga
            baseTransform()
            scene(t)
            ctx.restore()
          }
          GDX = 0
        }
        // 走査線と周辺減光（始めのうちは流れる。最後は薄くなる）
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.globalCompositeOperation = 'source-over'
        ctx.globalAlpha = 1 - (light ? 0.6 : 0.3) * clamp01((t - T_SCAN1) / (DURATION - T_SCAN1))
        ctx.drawImage(overlay, 0, (t < T_SNAP ? Math.floor(t * 140 * dpr) % per : 0) - per)
      }

      // ---- 動かす（時刻は最初のフレームから数える）
      var startTs = -1
      var raf = 0
      var stopped = false
      function frame(ts) {
        raf = 0
        if (stopped) return
        if (startTs < 0) startTs = ts
        var t = (ts - startTs) / 1000
        if (t >= DURATION) {
          draw(DURATION)
          stopped = true
          if (opts.onEnd) opts.onEnd()
          return
        }
        draw(t)
        raf = env.requestFrame(frame)
      }

      if (typeof opts.at === 'number') {
        draw(opts.at)
        stopped = true
      } else if (opts.still) {
        draw(DURATION)
        stopped = true
      } else {
        draw(0)
        raf = env.requestFrame(frame)
      }

      var player = {
        /** 動きを止める（今の絵のまま） */
        stop: function () {
          stopped = true
          if (raf) env.cancelFrame(raf)
          raf = 0
        },
        /** 止めて、作った canvas の中身を手放す（Safari は canvas の大きさの合計に上限がある） */
        dispose: function () {
          player.stop()
          for (var j = 0; j < made.length; j++) made[j].width = made[j].height = 0
          made = []
        },
        /** t 秒の絵を描く（テスト・確かめ用） */
        drawAt: function (t) {
          draw(t)
        },
      }
      return player
    }

    return { start: start, DURATION: DURATION, PALETTES: PALETTES }
  }

  /** ページの中で描く時の描く部品 */
  var renderer = glitchRenderer({
    canvas: function (w, h) {
      var c = document.createElement('canvas')
      c.width = w
      c.height = h
      return c
    },
    requestFrame: function (cb) {
      return window.requestAnimationFrame(cb)
    },
    cancelFrame: function (id) {
      window.cancelAnimationFrame(id)
    },
  })
  var DURATION = renderer.DURATION
  var PALETTES = renderer.PALETTES

  /** stage の大きさ（CSS ピクセル）と画素の細かさ */
  function stageSize(stage, safe) {
    return {
      width: stage.clientWidth || 240,
      height: stage.clientHeight || 520,
      dpr: Math.min(window.devicePixelRatio || 1, 3),
      safe: safe || {},
    }
  }

  /** stage いっぱいの canvas を作る */
  function stageCanvas(stage) {
    var cv = document.createElement('canvas')
    cv.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;display:block'
    stage.appendChild(cv)
    return cv
  }

  /**
   * ページの中で描く（stage の中に canvas を作る）。Worker を使えない時と、テスト・確かめ用。
   * opts は start と同じ（opts.safe も）。戻り値は start と同じ
   */
  function play(stage, theme, opts) {
    opts = opts || {}
    return renderer.start(stageCanvas(stage), stageSize(stage, opts.safe), theme, opts)
  }

  /** Worker の中で動かす部分（これも文字列にして渡す。外にあるものは使わない） */
  function workerMain(scope, makeRenderer) {
    var r = makeRenderer({
      canvas: function (w, h) {
        return new scope.OffscreenCanvas(w, h)
      },
      requestFrame: function (cb) {
        if (scope.requestAnimationFrame) return scope.requestAnimationFrame(cb)
        return scope.setTimeout(function () {
          cb(scope.performance.now())
        }, 16)
      },
      cancelFrame: function (id) {
        if (scope.cancelAnimationFrame) scope.cancelAnimationFrame(id)
        else scope.clearTimeout(id)
      },
    })
    var player = null
    scope.onmessage = function (e) {
      var d = e.data || {}
      if (d.type === 'start') {
        player = r.start(d.canvas, d.size, d.theme, {
          still: d.still,
          at: d.at,
          onEnd: function () {
            scope.postMessage({ type: 'end' })
          },
        })
        scope.postMessage({ type: 'started' })
      } else if (d.type === 'stop' && player) {
        player.stop()
      }
    }
  }

  /** Worker のスクリプト（ファイルを増やさないよう、上の2つの関数から作る） */
  function workerSource() {
    return '(' + workerMain + ')(self,' + glitchRenderer + ')'
  }

  /**
   * Worker（別のスレッド）で描く。アプリの起動（JavaScript の読み込み・最初の描画）と取り合わず、アプリが重い処理をしている間も
   * 止まらない。OffscreenCanvas に描けない・Worker を作れない時は null（ページの中で描く）。
   * opts.onStarted(): 最初の絵を描いた。opts.onEnd(): 最後まで描いた。opts.onError(): Worker で描けなかった（canvas は取り除いてある）
   */
  function playInWorker(stage, theme, opts) {
    if (typeof window.Worker !== 'function' || typeof window.OffscreenCanvas !== 'function' || typeof window.Blob !== 'function')
      return null
    if (!window.URL || typeof window.URL.createObjectURL !== 'function') return null
    var cv = stageCanvas(stage)
    if (typeof cv.transferControlToOffscreen !== 'function') {
      stage.removeChild(cv)
      return null
    }
    var url = null
    var worker = null
    try {
      url = window.URL.createObjectURL(new window.Blob([workerSource()], { type: 'text/javascript' }))
      worker = new window.Worker(url)
      var offscreen = cv.transferControlToOffscreen()
      worker.postMessage(
        { type: 'start', canvas: offscreen, size: stageSize(stage, opts.safe), theme: theme, still: !!opts.still, at: opts.at },
        [offscreen],
      )
    } catch (e) {
      if (worker) worker.terminate()
      if (url) window.URL.revokeObjectURL(url)
      if (cv.parentNode) cv.parentNode.removeChild(cv)
      return null
    }
    var done = false
    function release() {
      if (done) return
      done = true
      worker.terminate()
      window.URL.revokeObjectURL(url)
      if (cv.parentNode) cv.parentNode.removeChild(cv)
    }
    worker.onmessage = function (e) {
      if (!e.data) return
      if (e.data.type === 'started' && opts.onStarted) opts.onStarted()
      if (e.data.type === 'end' && opts.onEnd) opts.onEnd()
    }
    worker.onerror = function () {
      release()
      if (opts.onError) opts.onError()
    }
    return {
      worker: worker,
      stop: function () {
        if (!done) worker.postMessage({ type: 'stop' })
      },
      dispose: release,
    }
  }

  // ================================================================ 起動

  var current = null

  /** iPhone / Android の起動の画面（スプラッシュ）を消す。Capacitor の仕組みに直接頼む（プラグインの JS はまだ読み込んでいない） */
  function hideNativeSplash() {
    try {
      var cap = window.Capacitor
      if (cap && typeof cap.nativePromise === 'function') {
        var p = cap.nativePromise('SplashScreen', 'hide', { fadeOutDuration: 150 })
        if (p && typeof p.catch === 'function') p.catch(function () {})
      }
    } catch (e) {
      /* 消せなくても、アプリ（src/platform/nativeInit.ts）があとで消す */
    }
  }

  /** 重なりの要素の、ノッチ・ホームバーの分の余白（CSS ピクセル） */
  function safeInsets(el) {
    try {
      var cs = window.getComputedStyle(el)
      return {
        top: parseFloat(cs.paddingTop) || 0,
        right: parseFloat(cs.paddingRight) || 0,
        bottom: parseFloat(cs.paddingBottom) || 0,
        left: parseFloat(cs.paddingLeft) || 0,
      }
    } catch (e) {
      return {}
    }
  }

  var SKIP_EVENTS = ['pointerdown', 'click', 'keydown']
  /**
   * 重なりを押した後に続く出来事（離す・クリック・長押しのメニュー）。重なりの上で起きたものは、ここで止めてアプリに渡さない。
   * 指で押した時のクリックは、指を離した後に、その時に指の下にある所へ送られる。重なりが先に押せなくなっていると、
   * 消えかけた重なりの下のアプリのボタン（設定・作品・アイデアの「済み」など）が押されてしまう
   */
  var PRESS_EVENTS = ['pointerup', 'pointercancel', 'touchend', 'mousedown', 'mouseup', 'click', 'contextmenu']
  /** 押した指・マウスを離してから、重なりを押せなくする（下のアプリを押せるようにする）まで */
  var RELEASE_MS = 100
  /** 押したままでも、これより長くは重なりを残さない（消え始めてから） */
  var HOLD_CAP_MS = 3000

  /** canvas に描ける（描けなければ起動アニメーションを出さない） */
  function canvasAvailable() {
    try {
      var c = document.createElement('canvas')
      c.width = c.height = 1
      return !!c.getContext('2d')
    } catch (e) {
      return false
    }
  }

  /**
   * 見えていないタブ（裏で開いたタブ・ブラウザの先読み）で開いた時: そのタブが見えた時に、出したことにする
   * （出さずに開いたタブを、後で再読み込み・「新しい版にする」で読み込み直した時に出さない）
   */
  function markWhenVisible(session) {
    function onChange() {
      if (document.visibilityState === 'hidden') return
      document.removeEventListener('visibilitychange', onChange)
      document.removeEventListener('prerenderingchange', onChange)
      setItem(session, SESSION_KEY, '1')
    }
    document.addEventListener('visibilitychange', onChange)
    document.addEventListener('prerenderingchange', onChange)
  }

  /** 起動アニメーションを出す（外観は決めてある） */
  function launch(prefs, appearance, local, session) {
    var native = isNativeApp()
    var env = {
      enabled: prefs.launchAnimation !== false,
      native: native,
      webdriver: window.navigator.webdriver === true,
      forced: isForced(local),
      shownInSession: getItem(session, SESSION_KEY) === '1',
      hidden: document.visibilityState === 'hidden',
      reducedMotion: mediaMatches('(prefers-reduced-motion: reduce)'),
    }
    var mode = decide(env)
    if (mode === 'none') {
      // 見えていないから出さなかった時だけ、見えた時に印を付ける（設定でオフ・テストで出さなかった時は付けない）
      if (!native && env.hidden && !env.shownInSession) {
        env.hidden = false
        if (decide(env) !== 'none') markWhenVisible(session)
      }
      return
    }
    if (!canvasAvailable()) return
    if (!native) setItem(session, SESSION_KEY, '1')

    var theme = animationTheme(appearance)
    var el = document.createElement('div')
    el.id = 'ns-launch'
    el.setAttribute('data-testid', 'launch-overlay')
    el.setAttribute('data-launch-theme', theme)
    el.setAttribute('data-launch-mode', mode)
    // 読み上げには出さず、フォーカスできるものも置かない（アプリの操作の邪魔をしない）
    el.setAttribute('aria-hidden', 'true')
    el.style.cssText =
      'position:fixed;top:0;right:0;bottom:0;left:0;z-index:2147483647;overflow:hidden;box-sizing:border-box;margin:0;' +
      'padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px);' +
      'background:' +
      PALETTES[theme].bg +
      ';opacity:1;transition:opacity ' +
      TIMING.fadeMs +
      'ms ease-out;touch-action:none;-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent'
    // <body> はまだ無いので <html> の直下に置く（アプリの画面は <body> の中なので、重なりの下になる）
    document.documentElement.appendChild(el)

    var player = null
    // 重なりを押している間（押してから、離して RELEASE_MS たつまで）は、消え始めても重なりを押せるまま・取り除かずに残し、
    // その押す操作の続き（離す・クリック・長押し）を重なりが受けて止める
    var holding = false
    var removeLater = false
    var holdTimer = 0
    function inOverlay(target) {
      return target === el || (!!target && typeof target.nodeType === 'number' && el.contains(target))
    }
    function onInput(e) {
      if (e && e.type === 'pointerdown' && inOverlay(e.target)) holding = true
      if (current) current.controller.skip()
    }
    function onPress(e) {
      // 指を離した（touchend）のを止めると、そのタップのクリックは作られない
      if (inOverlay(e.target)) {
        if (e.cancelable) e.preventDefault()
        e.stopPropagation()
      }
      if (holding && (e.type === 'pointerup' || e.type === 'pointercancel' || e.type === 'touchend')) {
        window.clearTimeout(holdTimer)
        holdTimer = window.setTimeout(endHold, RELEASE_MS)
      }
    }
    function endHold() {
      window.clearTimeout(holdTimer)
      holding = false
      el.style.pointerEvents = 'none'
      if (removeLater) removeNow()
    }
    function removeNow() {
      for (var i = 0; i < PRESS_EVENTS.length; i++) window.removeEventListener(PRESS_EVENTS[i], onPress, true)
      if (el.parentNode) el.parentNode.removeChild(el)
      if (player) player.dispose()
      player = null
      current = null
    }
    function unlisten() {
      for (var i = 0; i < SKIP_EVENTS.length; i++) window.removeEventListener(SKIP_EVENTS[i], onInput, true)
    }

    var controller = createController({
      still: mode === 'still',
      setTimeout: function (fn, ms) {
        return window.setTimeout(fn, ms)
      },
      clearTimeout: function (id) {
        window.clearTimeout(id)
      },
      onFadeOut: function (reason) {
        unlisten()
        if (player) player.stop()
        el.setAttribute('data-launch-end', reason)
        // 押している間は押せるまま（離した後で押せなくする）。それ以外は、消え始めたらすぐ下のアプリを押せる
        if (holding) holdTimer = window.setTimeout(endHold, HOLD_CAP_MS)
        else el.style.pointerEvents = 'none'
        el.style.opacity = '0'
      },
      onRemove: function () {
        if (holding) removeLater = true
        else removeNow()
      },
    })
    current = { controller: controller, element: el }

    var opts = {
      still: mode === 'still',
      safe: safeInsets(el),
      // 最初の絵を描いた（動かさない時は、ここからロゴを0.5秒出す）
      onStarted: function () {
        controller.stillShown()
      },
      onEnd: function () {
        controller.animationEnded()
      },
      // Worker で描けなかった時は、ページの中で描き直す
      onError: function () {
        player = null
        playInPage()
      },
    }
    // ページの中で描く（Worker を使えない時）。下ごしらえ（数十ミリ秒）は最初の描画の時にして、HTML を読むのを止めない。
    // それまでは重なりの地の色だけ（アニメーションの最初の絵とほぼ同じ）
    function playInPage() {
      el.setAttribute('data-launch-renderer', 'page')
      window.requestAnimationFrame(function () {
        if (controller.state() !== 'playing') return
        try {
          player = play(el, theme, opts)
          controller.stillShown()
        } catch (e) {
          if (window.console) window.console.warn('起動アニメーションを描けませんでした', e)
          controller.skip()
        }
      })
    }
    // ふだんは Worker（別のスレッド）で描き、アプリの起動と取り合わない。Worker を作るのは HTML を読み終えた後
    // （アプリの JavaScript を読み込んでいる間の空き時間）。それまでは重なりの地の色だけ
    window.setTimeout(function () {
      if (controller.state() !== 'playing') return
      player = playInWorker(el, theme, opts)
      if (player) el.setAttribute('data-launch-renderer', 'worker')
      else playInPage()
    }, 0)
    for (var i = 0; i < SKIP_EVENTS.length; i++) window.addEventListener(SKIP_EVENTS[i], onInput, true)
    for (var j = 0; j < PRESS_EVENTS.length; j++)
      window.addEventListener(PRESS_EVENTS[j], onPress, { capture: true, passive: false })
    controller.start()
    // アプリ: 重なり（起動の画面と同じ地の色。アニメーションの最初の絵）を置いたので、起動の画面（無地）を消す。Android は
    // 起動の画面を消すまでページを描かない（requestAnimationFrame も来ないことがある）ので、待ちすぎない
    if (native) {
      var hidden = false
      var hide = function () {
        if (hidden) return
        hidden = true
        hideNativeSplash()
      }
      window.requestAnimationFrame(hide)
      window.setTimeout(hide, 32)
    }
  }

  /** 外観を決め、起動アニメーションを出す（index.html から一度だけ呼ぶ）。戻り値は外観 */
  function boot() {
    var appearance = 'white'
    var local = storageOf('localStorage')
    var prefs = readPrefs(local)
    try {
      appearance = resolveAppearance(prefs, mediaMatches('(prefers-color-scheme: dark)'))
      applyAppearance(appearance)
    } catch (e) {
      /* 外観はアプリ（PrefsEffect）があとで反映する */
    }
    try {
      if (!current) launch(prefs, appearance, local, storageOf('sessionStorage'))
    } catch (e) {
      if (window.console) window.console.warn('起動アニメーションを出せませんでした', e)
    }
    return appearance
  }

  window.NovelStudioLaunch = {
    boot: boot,
    /** アプリが最初の画面を出せた（src/main.tsx。起動アニメーションを出していなければ何もしない） */
    appReady: function () {
      if (current) current.controller.appReady()
    },
    /** 起動アニメーションを出している（消えている途中も含む） */
    active: function () {
      return !!current
    },
    // 以下は単体テスト（src/launch/launch.test.ts）と確かめ用
    resolveAppearance: resolveAppearance,
    animationTheme: animationTheme,
    decide: decide,
    createController: createController,
    play: play,
    playInWorker: playInWorker,
    workerSource: workerSource,
    TIMING: TIMING,
    DURATION: DURATION,
    PALETTES: PALETTES,
  }
})(window, document)
