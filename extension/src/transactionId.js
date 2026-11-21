/**
 * x-client-transaction-id の生成器（Service Worker 用の移植版）。
 *
 * X は書き込み系の GraphQL 呼び出しに `x-client-transaction-id`
 * ヘッダを求めることがある。生成方法は @lami/x-client-transaction-id
 * 0.3.3（MIT、https://github.com/Lqm1/x-client-transaction-id）の
 * 公開実装を、そのままの計算で移植したもの。Service Worker には
 * DOM が無いので、Document を使う部分だけ、ホームページの HTML
 * 文字列に対する解析に置き換えてある（中身の計算は同じ）。
 *
 * 仕組み（上流ライブラリと同じ）：
 *  - x.com のアプリシェル（https://x.com/i/jf/）から
 *    `twitter-site-verification` メタタグの値を鍵として読む
 *  - シェル内の ondemand.s チャンクの URL を求めて取得し、
 *    鍵バイトの index を抜き出す
 *  - シェルの読み込みアニメーション（loading-x-anim）の SVG パスから
 *    アニメーション鍵を導く
 *  - method・パス・時刻・アニメーション鍵を SHA-256 して XOR し、
 *    Base64 にしてヘッダ値にする
 *
 * 失敗したら null を返す（呼び出し側はヘッダ無しで送る＝従来の動作）。
 * 生成に失敗したからといって投稿自体を止めない。
 * 初期化した鍵はメモリに最長1時間キャッシュし、一括投稿の2件目以降は
 * 取り直さない。初期化の締切は10秒（アプリ側のジョブタイムアウト
 * 30秒に収まるよう）。
 *
 * deps: { fetchImpl, now?: () => number, random?: () => number }
 *  - fetchImpl: fetch（実物 or テスト用スタブ）
 *  - now / random: テスト用の差し替え（既定は Date.now / Math.random）
 */
'use strict';

/* global self */

const XManagerTransactionId = {
  /** アプリシェル。twitter-site-verification と ondemand.s の在り処。 */
  HOME_URL: 'https://x.com/i/jf/',
  /** 初期化した鍵の有効期間。 */
  KEYS_TTL_MS: 60 * 60 * 1000,
  /** 初期化全体の締切。 */
  INIT_TIMEOUT_MS: 10_000,

  createGenerator(deps) {
    const fetchImpl = deps.fetchImpl;
    const now = deps.now || Date.now;
    const random = deps.random || Math.random;
    const internals = XManagerTransactionId._internals;
    let cached = null; // { keys, at }
    let inflight = null;

    async function fetchWithTimeout(url, options, timeoutMs) {
      const controller =
        typeof AbortController !== 'undefined' ? new AbortController() : null;
      let timer = null;
      try {
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('fetch timed out')),
            timeoutMs,
          );
        });
        const res = await Promise.race([
          fetchImpl(url, { ...(options || {}), signal: controller ? controller.signal : undefined }),
          timeout,
        ]);
        return res;
      } finally {
        if (timer !== null) clearTimeout(timer);
        if (controller) {
          try {
            controller.abort();
          } catch {
            // 既に完了している場合など。無視する。
          }
        }
      }
    }

    async function initialize() {
      const homeRes = await fetchWithTimeout(
        XManagerTransactionId.HOME_URL,
        { headers: internals.NAVIGATION_HEADERS },
        XManagerTransactionId.INIT_TIMEOUT_MS,
      );
      if (!homeRes.ok) {
        throw new Error(
          `Xのシェルを取得できませんでした（HTTP ${homeRes.status}）。`,
        );
      }
      const html = await homeRes.text();
      const keyBytes = Array.from(
        internals.decodeBase64(internals.getVerificationKey(html)),
      );
      const indices = await internals.fetchKeyByteIndices(
        html,
        (url) => fetchWithTimeout(url, {}, XManagerTransactionId.INIT_TIMEOUT_MS),
      );
      const frameRows = internals.getAnimationFrameRows(html, keyBytes);
      return {
        keyBytes,
        animationKey: internals.getAnimationKey(keyBytes, indices, frameRows),
      };
    }

    async function ensureKeys() {
      if (cached && now() - cached.at < XManagerTransactionId.KEYS_TTL_MS) {
        return cached.keys;
      }
      if (!inflight) {
        inflight = initialize()
          .then((keys) => {
            cached = { keys, at: now() };
            return keys;
          })
          .catch((err) => {
            cached = null;
            throw err;
          })
          .finally(() => {
            inflight = null;
          });
      }
      return inflight;
    }

    /**
     * xClient.createClient の getTransactionId として渡す関数。
     * method は 'GET' / 'POST'、url はリクエスト先の絶対 URL。
     * 生成できなければ null（ヘッダ無しで送る）。
     */
    async function getTransactionId(method, url) {
      try {
        const keys = await ensureKeys();
        let path;
        try {
          path = new URL(url).pathname;
        } catch {
          return null;
        }
        return await internals.buildTransactionId(keys, method, path, {
          now,
          random,
        });
      } catch {
        return null;
      }
    }

    return getTransactionId;
  },

  _internals: {
    NAVIGATION_HEADERS: {
      accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'accept-language': 'ja',
      'cache-control': 'no-cache',
      pragma: 'no-cache',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'none',
      'sec-fetch-user': '?1',
      'upgrade-insecure-requests': '1',
    },

    KEYWORD: 'obfiowerehiring',
    ADDITIONAL_RANDOM_NUMBER: 3,
    EPOCH_SECONDS: 1682924400,
    ON_DEMAND_CHUNK_NAME: 'ondemand.s',
    ON_DEMAND_FILE_HASH_REGEX:
      /(\d+):\s*["']ondemand\.s["'][\s\S]*?\}\)\[e\]\s*\|\|\s*e\)\s*\+\s*["']\.["']\s*\+\s*\(\{[\s\S]*?\b\1:\s*["']([a-zA-Z0-9_-]+)["']/,
    KEY_BYTE_INDEX_REGEX: /\(\w\[(\d{1,2})\],\s*16\)/g,

    decodeBase64(b64) {
      return Uint8Array.from(atob(b64), (char) => char.charCodeAt(0));
    },

    encodeBase64(data) {
      const bytes =
        typeof data === 'string'
          ? new TextEncoder().encode(data)
          : new Uint8Array(data);
      return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
    },

    /**
     * <meta name="twitter-site-verification" content="..."> の値を抜く。
     * 属性の順序（name 先・content 先のどちらでも）に対応する。
     */
    getVerificationKey(html) {
      const metaTags = html.match(/<meta\b[^>]*>/gi) || [];
      for (const tag of metaTags) {
        if (!/name\s*=\s*["']twitter-site-verification["']/i.test(tag)) continue;
        const m = /content\s*=\s*["']([^"']+)["']/i.exec(tag);
        if (m) return m[1];
      }
      throw new Error(
        'twitter-site-verification のメタタグが見つかりませんでした。',
      );
    },

    getOnDemandFileUrl(html) {
      const m = XManagerTransactionId._internals.ON_DEMAND_FILE_HASH_REGEX.exec(html);
      if (m && m[2]) {
        return `https://abs.twimg.com/responsive-web/client-web/${XManagerTransactionId._internals.ON_DEMAND_CHUNK_NAME}.${m[2]}a.js`;
      }
      throw new Error('ondemand.s の URL を求められませんでした。');
    },

    async fetchKeyByteIndices(html, fetchFn) {
      const url = XManagerTransactionId._internals.getOnDemandFileUrl(html);
      const res = await fetchFn(url);
      if (!res.ok) {
        throw new Error(
          `ondemand.s を取得できませんでした（HTTP ${res.status}）。`,
        );
      }
      const source = await res.text();
      const indices = Array.from(
        source.matchAll(XManagerTransactionId._internals.KEY_BYTE_INDEX_REGEX),
        (match) => Number(match[1]),
      );
      if (indices.length === 0) {
        throw new Error('ondemand.s から鍵バイトの index を抜き出せませんでした。');
      }
      const [rowIndex, ...keyBytesIndices] = indices;
      return { rowIndex, keyBytesIndices };
    },

    /**
     * loading-x-anim-* 要素のうち keyBytes[5] % 4 番目のものの
     * 「最初の子の2番目の子」の path の d 属性を、数値の行列に写す。
     * 上流では DOM の children[0].children[1].getAttribute('d')。
     * ここではその部分木だけを小さなタグ走査で組み立てる。
     */
    getAnimationFrameRows(html, keyBytes) {
      const internals = XManagerTransactionId._internals;
      const frames = internals.findLoadingAnimFrames(html);
      const frame = frames[keyBytes[5] % 4];
      if (!frame) return [];
      const pathD =
        frame.children[0] && frame.children[0].children[1]
          ? frame.children[0].children[1].attrs.d
          : null;
      if (!pathD) return [];
      return pathD
        .substring(9)
        .split('C')
        .map((segment) => (segment.match(/\d+/g) || []).map(Number));
    },

    /**
     * id="loading-x-anim..." の要素を文書順に集め、各要素を
     * { tag, attrs, children } の小さな木にする。SVG の部分木だけを
     * 対象にするので、script/style の中身は走査しない。
     */
    findLoadingAnimFrames(html) {
      const startRe = /<([a-zA-Z][\w:.-]*)\b[^>]*\bid\s*=\s*["']loading-x-anim[^"']*["'][^>]*>/g;
      const frames = [];
      let m;
      while ((m = startRe.exec(html)) !== null) {
        const tree = XManagerTransactionId._internals.parseElementTree(
          html,
          m.index,
          m[1],
        );
        if (tree) frames.push(tree);
      }
      return frames;
    },

    /**
     * html の start（開始タグの位置）から、その要素が閉じるまでを
     * 小さな木に組み立てる。自己終了タグ（/>）と void 要素を扱い、
     * 途中の script/style は中身ごと飛ばす。
     */
    parseElementTree(html, start, rootTag) {
      const internals = XManagerTransactionId._internals;
      const VOID_TAGS = new Set([
        'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
        'link', 'meta', 'param', 'source', 'track', 'wbr',
      ]);
      const tagRe =
        /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\/?([a-zA-Z][\w:.-]*)((?:\s+[\w:.-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
      tagRe.lastIndex = start;
      let root = null;
      const stack = [];
      let match;
      while ((match = tagRe.exec(html)) !== null) {
        const full = match[0];
        if (full.startsWith('<!--') || full.startsWith('<![CDATA[')) continue;
        const isClose = full.startsWith('</');
        const tagName = (match[1] || '').toLowerCase();
        const selfClosing = match[3] === '/' || VOID_TAGS.has(tagName);
        if (isClose) {
          if (stack.length > 0 && stack[stack.length - 1].tag === tagName) {
            stack.pop();
            if (stack.length === 0) break; // ルートが閉じた
          } else if (stack.length > 0) {
            // 閉じタグの対応が取れない場合は、一致するものまで巻き戻す。
            let idx = stack.length - 1;
            while (idx >= 0 && stack[idx].tag !== tagName) idx--;
            if (idx >= 0) stack.length = idx;
            if (stack.length === 0) break;
          }
          continue;
        }
        const node = {
          tag: tagName,
          attrs: internals.parseAttrs(match[2] || ''),
          children: [],
        };
        if (!root) {
          root = node;
          if (selfClosing) break;
          stack.push(node);
          continue;
        }
        if (stack.length === 0) break;
        stack[stack.length - 1].children.push(node);
        if (selfClosing) continue;
        // script/style の中身はタグとして読まない（JS 内の '<' を誤読しない）。
        // このノードは子として追加済みで、スタックには積んでいない。
        if (tagName === 'script' || tagName === 'style') {
          const closeRe = new RegExp(`</${tagName}\\s*>`, 'i');
          const rest = html.slice(tagRe.lastIndex);
          const close = closeRe.exec(rest);
          if (close) tagRe.lastIndex += close.index + close[0].length;
          continue;
        }
        stack.push(node);
      }
      return root && root.tag === rootTag.toLowerCase() ? root : null;
    },

    parseAttrs(attrText) {
      const attrs = {};
      const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
      let m;
      while ((m = re.exec(attrText)) !== null) {
        attrs[m[1]] = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4];
      }
      return attrs;
    },

    getAnimationKey(keyBytes, indices, frameRows) {
      const internals = XManagerTransactionId._internals;
      const rowIndex = keyBytes[indices.rowIndex] % 16;
      const frameRow = frameRows[rowIndex];
      if (!frameRow) {
        throw new Error(
          `アニメーションの行 ${rowIndex} を作れませんでした。シェルの形式が変わった可能性があります。`,
        );
      }
      const frameTime = indices.keyBytesIndices.reduce(
        (time, index) => time * (keyBytes[index] % 16),
        1,
      );
      return internals.animate(
        frameRow,
        (Math.round(frameTime / 10) * 10) / internals.TOTAL_TIME,
      );
    },

    TOTAL_TIME: 4096,

    animate(frameRow, targetTime) {
      const internals = XManagerTransactionId._internals;
      const fromColor = frameRow.slice(0, 3);
      const toColor = frameRow.slice(3, 6);
      const toRotation = internals.solve(frameRow[6], 60, 360, true);
      const curves = frameRow
        .slice(7)
        .map((value, index) => internals.solve(value, internals.isOdd(index), 1, false));
      const progress = new internals.Cubic(curves).getValue(targetTime);
      const color = internals
        .interpolate(fromColor, toColor, progress)
        .map((channel) => Math.round(Math.max(0, Math.min(255, channel))).toString(16));
      const rotation = internals.interpolateNum(0, toRotation, progress);
      const matrix = internals
        .convertRotationToMatrix(rotation)
        .flatMap((value) => internals.matrixNumbers(value))
        .map((number) => {
          const hex = internals.floatToHex(Math.abs(Number(number.toFixed(2)))).toLowerCase();
          return hex.startsWith('.') ? `0${hex}` : hex || '0';
        });
      return [...color, ...matrix, '0', '0'].join('').replace(/[.-]/g, '');
    },

    solve(value, minVal, maxVal, rounding) {
      const result = (value * (maxVal - minVal)) / 255 + minVal;
      return rounding ? Math.floor(result) : Math.round(result * 100) / 100;
    },

    interpolate(fromList, toList, f) {
      const internals = XManagerTransactionId._internals;
      if (fromList.length !== toList.length) {
        throw new Error('補間の配列の長さが違います。');
      }
      return fromList.map((from, i) => internals.interpolateNum(from, toList[i], f));
    },

    interpolateNum(fromVal, toVal, f) {
      if (typeof fromVal === 'number' && typeof toVal === 'number') {
        return fromVal * (1 - f) + toVal * f;
      }
      if (typeof fromVal === 'boolean' && typeof toVal === 'boolean') {
        return Number(f < 0.5 ? fromVal : toVal);
      }
      return 0;
    },

    convertRotationToMatrix(rotation) {
      const rad = (rotation * Math.PI) / 180;
      return [Math.cos(rad), -Math.sin(rad), Math.sin(rad), Math.cos(rad)];
    },

    floatToHex(x) {
      const integer = Math.floor(x);
      let fraction = x - integer;
      let result = integer > 0 ? integer.toString(16).toUpperCase() : '';
      if (fraction === 0) return result;
      result += '.';
      while (fraction > 0) {
        fraction *= 16;
        const digit = Math.floor(fraction);
        fraction -= digit;
        result += digit.toString(16).toUpperCase();
      }
      return result;
    },

    isOdd(num) {
      return num % 2 ? -1 : 0;
    },

    formatMatrixValue(value) {
      if (value === 0) return '0';
      const sign = value < 0 ? '-' : '';
      const [mantissa, exponentText] = Math.abs(value).toExponential(5).split('e');
      const exponent = parseInt(exponentText, 10);
      const digits = mantissa.replace('.', '').replace(/0+$/, '') || '0';
      if (exponent < -4 || exponent >= 6) {
        const head = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
        const expSign = exponent < 0 ? '-' : '+';
        const expDigits = String(Math.abs(exponent)).padStart(2, '0');
        return `${sign}${head}e${expSign}${expDigits}`;
      }
      if (exponent >= 0) {
        const intPart = digits.slice(0, exponent + 1).padEnd(exponent + 1, '0');
        const fracPart = digits.slice(exponent + 1);
        return fracPart ? `${sign}${intPart}.${fracPart}` : `${sign}${intPart}`;
      }
      return `${sign}0.${'0'.repeat(-exponent - 1)}${digits}`;
    },

    matrixNumbers(value) {
      return (XManagerTransactionId._internals.formatMatrixValue(value).match(/[\d.-]+/g) || []).map(Number);
    },

    Cubic: class Cubic {
      static EPSILON = 0.0000001;
      static NEWTON_ITERATIONS = 4;
      static SPLINE_SAMPLES = 11;
      static SPLINE_STEP = 1 / (this.SPLINE_SAMPLES - 1);
      constructor(curves) {
        const [x1, y1, x2, y2] = curves;
        this.cx = 3 * x1;
        this.bx = 3 * (x2 - x1) - this.cx;
        this.ax = 1 - this.cx - this.bx;
        this.cy = 3 * y1;
        this.by = 3 * (y2 - y1) - this.cy;
        this.ay = 1 - this.cy - this.by;
        if (x1 > 0) {
          this.startGradient = y1 / x1;
        } else if (y1 === 0 && x2 > 0) {
          this.startGradient = y2 / x2;
        } else if (y1 === 0 && y2 === 0) {
          this.startGradient = 1;
        } else {
          this.startGradient = 0;
        }
        if (x2 < 1) {
          this.endGradient = (y2 - 1) / (x2 - 1);
        } else if (y2 === 1 && x1 < 1) {
          this.endGradient = (y1 - 1) / (x1 - 1);
        } else if (y2 === 1 && y1 === 1) {
          this.endGradient = 1;
        } else {
          this.endGradient = 0;
        }
        this.splineSamples = Array.from(
          { length: this.constructor.SPLINE_SAMPLES },
          (_, i) => this.sampleX(i * this.constructor.SPLINE_STEP),
        );
      }
      getValue(time) {
        if (time < 0) return this.startGradient * time;
        if (time > 1) return 1 + this.endGradient * (time - 1);
        return this.sampleY(this.solveCurveX(time));
      }
      sampleX(t) {
        return ((this.ax * t + this.bx) * t + this.cx) * t;
      }
      sampleY(t) {
        return ((this.ay * t + this.by) * t + this.cy) * t;
      }
      sampleDerivativeX(t) {
        return (3 * this.ax * t + 2 * this.bx) * t + this.cx;
      }
      solveCurveX(x) {
        const C = this.constructor;
        let t0 = 0;
        let t1 = 1;
        let t2 = x;
        for (let i = 1; i < C.SPLINE_SAMPLES; i++) {
          if (x <= this.splineSamples[i]) {
            t1 = C.SPLINE_STEP * i;
            t0 = t1 - C.SPLINE_STEP;
            t2 =
              t0 +
              ((t1 - t0) * (x - this.splineSamples[i - 1])) /
                (this.splineSamples[i] - this.splineSamples[i - 1]);
            break;
          }
        }
        let x2 = 0;
        for (let i = 0; i < C.NEWTON_ITERATIONS; i++) {
          x2 = this.sampleX(t2) - x;
          if (Math.abs(x2) < C.EPSILON) return t2;
          const d2 = this.sampleDerivativeX(t2);
          if (Math.abs(d2) < C.EPSILON) break;
          t2 -= x2 / d2;
        }
        if (Math.abs(x2) < C.EPSILON) return t2;
        while (t0 < t1) {
          x2 = this.sampleX(t2);
          if (Math.abs(x2 - x) < C.EPSILON) return t2;
          if (x > x2) t0 = t2;
          else t1 = t2;
          t2 = (t1 + t0) * 0.5;
        }
        return t2;
      }
    },

    /**
     * 上流の generateTransactionId と同じ組み立て。keys は initialize
     * で作った { keyBytes, animationKey }。timeNow は秒単位の
     * (Date.now() - EPOCH*1000)/1000、randomByteOverride はテスト用。
     */
    async buildTransactionId(keys, method, path, opts) {
      const internals = XManagerTransactionId._internals;
      const now = (opts && opts.now) || Date.now;
      const random = (opts && opts.random) || Math.random;
      const time =
        opts && typeof opts.timeNow === 'number'
          ? opts.timeNow
          : Math.floor((now() - internals.EPOCH_SECONDS * 1000) / 1000);
      const data = `${method}!${path}!${time}${internals.KEYWORD}${keys.animationKey}`;
      const hash = new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data)),
      );
      const randomByte =
        opts && typeof opts.randomByteOverride === 'number'
          ? opts.randomByteOverride
          : Math.floor(random() * 256);
      const bytes = [
        ...keys.keyBytes,
        ...[0, 8, 16, 24].map((shift) => (time >> shift) & 255),
        ...hash.slice(0, 16),
        internals.ADDITIONAL_RANDOM_NUMBER,
      ];
      const out = Uint8Array.from([
        randomByte,
        ...bytes.map((byte) => byte ^ randomByte),
      ]);
      return internals.encodeBase64(out).replace(/=/g, '');
    },
  },
};

if (typeof self !== 'undefined') {
  self.XManagerTransactionId = XManagerTransactionId;
}
