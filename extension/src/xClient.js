/**
 * X Web版内部APIのクライアント（拡張の background から使う）。
 *
 * x.com の Web アプリと同じ呼び方をする：GraphQL は
 * `https://x.com/i/api/graphql/<queryId>/<操作名>`、フォローだけ
 * REST 1.1 の `https://api.x.com/1.1/friendships/create.json`。
 * 認証はブラウザの Cookie（auth_token・ct0）と、Web 版共通の
 * 公開 bearer トークン（全利用者で同じ値）を使う。トークンは
 * x.com 以外には送らないし、ログにも出さない。
 *
 * 既知の不確かさ（docs/REAL_X_DESIGN.md にも記載）：
 *  - query ID は X の更新で変わる。queryIds.js がバンドル走査で
 *    生きた ID を探し、見つからなければ not_implemented を返す。
 *  - 2026年から X は書き込みに `x-client-transaction-id` ヘッダを
 *    求めることがある。生成器は transactionId.js（@lami/
 *    x-client-transaction-id 0.3.3 の Service Worker 向け移植）にあり、
 *    background が getTransactionId として差し込んでいる。生成に
 *    失敗したらヘッダ無しで送り、403 ならその旨が分かるエラーにする。
 *  - 通知・DM・バッジ数の応答形式は Web 版の実装詳細で、変わる
 *    ことがある。読めない形式なら not_implemented を返す。
 *
 * deps: { fetchImpl, resolveQueryId: (op) => Promise<string|null>,
 *         getTransactionId?: (method, path) => Promise<string|null>,
 *         clientIdentity?: { clientUuid, deviceId } | null }
 * 返るクライアントの各メソッドは第1引数に auth {ct0} を取る。
 */
'use strict';

/* global self */

const XManagerXClient = {
  /** Web 版共通の公開 bearer トークン（秘密ではない）。 */
  BEARER_TOKEN:
    'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
  GRAPHQL_BASE: 'https://x.com/i/api/graphql',
  REST_BASE: 'https://api.x.com/1.1',
  /** メディアアップロード（upload.x.com）の入口。 */
  UPLOAD_BASE: 'https://upload.x.com/i/media/upload.json',
  /** APPEND 1回あたりの上限（Xの仕様：5MB）。 */
  MEDIA_APPEND_CHUNK_BYTES: 5 * 1024 * 1024,
  /** Xのメディア上限：画像5MB（GIFは15MB）、動画512MB。 */
  IMAGE_MAX_BYTES: 5 * 1024 * 1024,
  GIF_MAX_BYTES: 15 * 1024 * 1024,
  VIDEO_MAX_BYTES: 512 * 1024 * 1024,
  /** 1ポストに付けられる画像の上限（Xの仕様）。動画は1件まで。 */
  MAX_IMAGES_PER_POST: 4,

  /**
   * GraphQL の feature flags。Web 版が送るものの一部で、公開クライアント
   * （twscrape など）の値に合わせた。サーバー側は未知・不足のフラグを
   * 許容するため、この一覧が完全でなくても動く想定。
   */
  FEATURES: {
    creator_subscriptions_tweet_preview_api_enabled: true,
    communities_web_enable_tweet_community_results_fetch: true,
    c9s_tweet_anatomy_moderator_badge_enabled: true,
    articles_preview_enabled: true,
    rweb_tipjar_consumption_enabled: true,
    responsive_web_graphql_exclude_directive_enabled: true,
    verified_phone_label_enabled: false,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    responsive_web_graphql_timeline_navigation_enabled: true,
    responsive_web_edit_tweet_api_enabled: true,
    graphql_is_translatable_rweb_tweet: true,
    view_counts_everywhere_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    responsive_web_twitter_article_tweet_consumption_enabled: true,
    tweet_awards_web_tipping_enabled: false,
    freedom_of_speech_not_reach_fetch_enabled: true,
    standardized_nudges_misinfo: true,
    tweetypie_unmention_optimization_enabled: true,
    responsive_web_jetfuel_frame_enabled: true,
    responsive_web_grok_analyze_button_fetch_trends_enabled: false,
    responsive_web_grok_analyze_post_followups_enabled: false,
    responsive_web_grok_share_attachment_enabled: false,
    premium_content_api_read_enabled: false,
    profile_label_improvements_pcf_label_in_post_enabled: true,
    rweb_video_timestamps_enabled: true,
    responsive_web_grok_image_annotation_enabled: false,
  },

  createClient(deps) {
    const errors = self.XManagerErrors;
    const fetchImpl = deps.fetchImpl;
    const resolveQueryId = deps.resolveQueryId;
    const getTransactionId = deps.getTransactionId || null;
    // 拡張ごとに固定のクライアント ID（clientIdentity.js）。本物の
    // Web クライアントが端末ごとに安定して送る x-client-uuid /
    // x-twitter-client-deviceid を模す。無ければ付けない。
    const clientIdentity =
      deps.clientIdentity &&
      typeof deps.clientIdentity.clientUuid === 'string' &&
      typeof deps.clientIdentity.deviceId === 'string'
        ? deps.clientIdentity
        : null;
    // 動画の処理待ち（STATUS 確認）の締切・間隔。既定は60秒・3秒。
    // テストでは短くできるように deps で差し替えられる。
    const mediaStatusDeadlineMs =
      typeof deps.mediaStatusDeadlineMs === 'number' ? deps.mediaStatusDeadlineMs : 60_000;
    const mediaStatusPollMs =
      typeof deps.mediaStatusPollMs === 'number' ? deps.mediaStatusPollMs : 3_000;
    // APPEND 1回あたりのバイト数。既定は X の上限 5MB。
    const mediaAppendChunkBytes =
      typeof deps.mediaAppendChunkBytes === 'number'
        ? deps.mediaAppendChunkBytes
        : XManagerXClient.MEDIA_APPEND_CHUNK_BYTES;

    function headers(auth, extra, json) {
      const h = {
        authorization: `Bearer ${XManagerXClient.BEARER_TOKEN}`,
        'x-csrf-token': auth.ct0,
        'x-twitter-auth-type': 'OAuth2Session',
        'x-twitter-active-user': 'yes',
        origin: 'https://x.com',
        referer: 'https://x.com/',
      };
      if (clientIdentity) {
        h['x-client-uuid'] = clientIdentity.clientUuid;
        h['x-twitter-client-deviceid'] = clientIdentity.deviceId;
      }
      // 既定は JSON。FormData（multipart）のときは fetch に境界を
      // 付けさせるため、content-type を付けない（json=false）。
      if (json !== false) h['content-type'] = 'application/json';
      if (extra) Object.assign(h, extra);
      return h;
    }

    async function requestJson(url, options, auth, { isWrite, expectJson }) {
      let res;
      let txAttached = false;
      try {
        const init = { ...options };
        if (getTransactionId) {
          try {
            const txId = await getTransactionId(options.method || 'GET', url);
            if (txId) {
              txAttached = true;
              init.headers = { ...(init.headers || {}), 'x-client-transaction-id': txId };
            }
          } catch {
            // 生成に失敗したらヘッダ無しで送る
          }
        }
        res = await fetchImpl(url, init);
      } catch (err) {
        throw errors.makeError(
          'unknown',
          `Xへの通信に失敗しました（${err instanceof Error ? err.message : String(err)}）。ネットワークを確認してください。`,
        );
      }
      if (res.status === 429) {
        throw errors.makeError(
          'rate_limited',
          'Xの制限（レートリミット）にかかりました。しばらく待ってから再試行してください。',
        );
      }
      if (res.status === 401 || res.status === 403) {
        const err = errors.makeError(
          'x_error',
          res.status === 401
            ? 'Xのセッションが切れています。ポップアップで auth_token を登録し直してください。'
            : isWrite
              ? txAttached
                ? 'Xがこの操作を拒否しました（403）。トランザクションIDを付けて送っても拒否されたため、アカウントの制限か、X側の仕様変更の可能性があります。しばらく待ってから再試行してください。'
                : 'Xがこの操作を拒否しました（403）。トランザクションIDの生成に失敗したためヘッダ無しで送り、Xに拒否されました。拡張を再読み込みしてから再試行してください。'
              : 'Xがこの取得を拒否しました（403）。セッションが無効か、アカウントに制限がかかっている可能性があります。',
        );
        err.status = res.status;
        throw err;
      }
      if (res.status === 400 || res.status === 404) {
        // 操作の query ID が古い（Xの更新で変わった）場合によく出る。
        // ただの「応答が異常」では原因が分からないので、明示する。
        throw errors.makeError(
          'x_error',
          `Xがこの操作を受け付けませんでした（HTTP ${res.status}）。Xの更新で操作の query ID が変わった可能性があり、拡張の更新が必要です。`,
        );
      }
      if (!res.ok) {
        // その他の 4xx/5xx: X の応答本文（errors[0].message 等）を含めて返す。
        // 422 は variables の検証失敗で返ることが多く、本文なしでは原因が
        // 特定できない（2026-11-22 の 3-1 はここで詳細を落としていた）。
        let detail = '';
        try {
          const text = await res.text();
          if (text) {
            try {
              const parsed = JSON.parse(text);
              const first = parsed?.errors?.[0]?.message;
              detail = first ? `: ${String(first)}` : `: ${text.slice(0, 300)}`;
            } catch {
              detail = `: ${text.slice(0, 300)}`;
            }
          }
        } catch {
          // 本文が読めなくてもステータスだけは返す。
        }
        throw errors.makeError('x_error', `Xからの応答が異常です（HTTP ${res.status}）${detail}。`);
      }
      // APPEND など応答が空の操作は JSON を読まない。
      if (expectJson === false) return null;
      let json;
      try {
        json = await res.json();
      } catch {
        throw errors.makeError(
          'x_error',
          'Xからの応答を読み取れませんでした。ログイン状態を確認してください。',
        );
      }
      if (json && Array.isArray(json.errors) && json.errors.length > 0) {
        const first = json.errors[0];
        const message =
          typeof first === 'string' ? first : first.message || JSON.stringify(first);
        // 226（自動化の疑い）などの切り分けには、トランザクションIDを
        // 付けて送ったかどうかが決定的な手がかりになる。本文のエラー
        // だけでは分からないので、書き込み時は付記する。
        const tidNote = isWrite
          ? txAttached
            ? '（トランザクションIDは付けて送りました）'
            : '（トランザクションIDの生成に失敗し、付けずに送りました）'
          : '';
        throw errors.makeError('x_error', `Xがエラーを返しました：${message}${tidNote}`);
      }
      return json;
    }

    async function graphql(auth, operation, variables, method) {
      const queryId = await resolveQueryId(operation);
      if (!queryId) {
        throw errors.makeError(
          'not_implemented',
          `操作 ${operation} の query ID が見つかりませんでした。Xの更新で変わった可能性があるため、拡張の更新が必要です。`,
        );
      }
      const path = `${XManagerXClient.GRAPHQL_BASE}/${queryId}/${operation}`;
      if (method === 'GET') {
        const url =
          `${path}?variables=${encodeURIComponent(JSON.stringify(variables))}` +
          `&features=${encodeURIComponent(JSON.stringify(XManagerXClient.FEATURES))}`;
        const json = await requestJson(
          url,
          { method: 'GET', headers: headers(auth) },
          auth,
          { isWrite: false },
        );
        return json.data;
      }
      const json = await requestJson(
        path,
        {
          method: 'POST',
          headers: headers(auth),
          body: JSON.stringify({ variables, features: XManagerXClient.FEATURES }),
        },
        auth,
        { isWrite: true },
      );
      return json.data;
    }

    async function restForm(auth, path, params) {
      const body = new URLSearchParams(params).toString();
      const json = await requestJson(
        `${XManagerXClient.REST_BASE}${path}`,
        {
          method: 'POST',
          headers: headers(auth, { 'content-type': 'application/x-www-form-urlencoded' }),
          body,
        },
        auth,
        { isWrite: true },
      );
      return json;
    }

    // ---- 書き込み ----

    async function postTweet(auth, { text, replyToId, replyPermission, mediaIds, communityId }) {
      const variables = {
        tweet_text: text,
        reply: replyToId
          ? { in_reply_to_status_id: replyToId, exclude_reply_user_ids: [] }
          : undefined,
        media: {
          media_entities: (mediaIds || []).map((id) => ({ media_id: id, tagged_users: [] })),
          possibly_sensitive: false,
        },
        dark: false,
        semantic_annotation_ids: [],
      };
      // コミュニティ投稿：CreateTweet の変数に community_id を付ける
      // （X API v2 の POST /2/tweets と同じ名前。公開クライアント
      // twikit も CreateTweet に community_id を渡す）。無い場合は
      // 付けない（通常投稿と変わらない）。
      if (communityId) variables.community_id = communityId;
      if (replyPermission && replyPermission !== 'everyone') {
        // 会話制御。Web 版が送る項目（未検証のため、無視されても動く）。
        variables.reply_settings = replyPermission;
      }
      let data;
      try {
        data = await graphql(auth, 'CreateTweet', variables, 'POST');
      } catch (err) {
        // X がコミュニティ絡みのエラーを返した場合は、原因が分かる
        // 日本語にする（ID違い・メンバーでない等）。それ以外はそのまま。
        if (err && /community/i.test(err.message || '')) {
          throw errors.makeError(
            'x_error',
            'コミュニティが見つからないか、このコミュニティへの投稿権限がありません。コミュニティIDが正しいか、メンバーかどうかを確認してください。',
          );
        }
        throw err;
      }
      const result = data?.create_tweet?.tweet_results?.result;
      const tweet = result?.__typename === 'TweetWithVisibilityResults' ? result.tweet : result;
      const postId = tweet?.rest_id;
      if (!postId) {
        throw errors.makeError('x_error', '投稿の応答から投稿IDを読み取れませんでした。');
      }
      return { postId, postUrl: `https://x.com/i/status/${postId}` };
    }

    // ---- メディアアップロード ----

    /**
     * Xのメディア上限を検査する。Xの仕様：画像は1ポスト4件まで、
     * 動画は1件まで、画像と動画の同時添付は不可。画像5MB
     * （GIFは15MB）、動画512MBまで。守れなければ x_error を投げる。
     */
    function validateMediaItems(items) {
      if (!Array.isArray(items) || items.length === 0) {
        throw errors.makeError('x_error', '添付するメディアがありません。');
      }
      const images = items.filter((i) => i.kind === 'image');
      const videos = items.filter((i) => i.kind === 'video');
      if (images.length > 0 && videos.length > 0) {
        throw errors.makeError('x_error', '画像と動画を同時に付けることはできません。');
      }
      if (images.length > XManagerXClient.MAX_IMAGES_PER_POST) {
        throw errors.makeError(
          'x_error',
          `画像は1ポストに${XManagerXClient.MAX_IMAGES_PER_POST}件までです。`,
        );
      }
      if (videos.length > 1) {
        throw errors.makeError('x_error', '動画は1ポストに1件までです。');
      }
      for (const item of items) {
        if (!item.data || !(item.data instanceof Uint8Array) || item.data.length === 0) {
          throw errors.makeError(
            'x_error',
            `メディア「${item.name || ''}」のデータがありません。もう一度選び直してください。`,
          );
        }
        if (item.kind === 'image') {
          const max =
            item.mime === 'image/gif'
              ? XManagerXClient.GIF_MAX_BYTES
              : XManagerXClient.IMAGE_MAX_BYTES;
          if (item.data.length > max) {
            throw errors.makeError(
              'x_error',
              `画像「${item.name}」が大きすぎます（上限${item.mime === 'image/gif' ? '15MB' : '5MB'}）。`,
            );
          }
        } else if (item.kind === 'video') {
          if (item.data.length > XManagerXClient.VIDEO_MAX_BYTES) {
            throw errors.makeError(
              'x_error',
              `動画「${item.name}」が大きすぎます（上限512MB）。`,
            );
          }
          if (item.mime !== 'video/mp4' && item.mime !== 'video/quicktime') {
            throw errors.makeError(
              'x_error',
              `対応していない動画形式です（${item.mime || '不明'}）。mp4 か mov を使ってください。`,
            );
          }
        } else {
          throw errors.makeError(
            'x_error',
            `対応していないメディアです：${item.name || ''}。`,
          );
        }
      }
    }

    /** upload.x.com へ URL エンコード形式で送り、JSON応答を返す。 */
    async function uploadForm(auth, params) {
      return requestJson(
        XManagerXClient.UPLOAD_BASE,
        {
          method: 'POST',
          headers: headers(auth, { 'content-type': 'application/x-www-form-urlencoded' }),
          body: new URLSearchParams(params).toString(),
        },
        auth,
        { isWrite: true },
      );
    }

    /** upload.x.com へ1チャンク（multipart）を送る。応答は空でよい。 */
    async function uploadAppend(auth, mediaId, segmentIndex, bytes, mime) {
      const form = new FormData();
      form.append('command', 'APPEND');
      form.append('media_id', mediaId);
      form.append('segment_index', String(segmentIndex));
      form.append('media', new Blob([bytes], { type: mime }));
      await requestJson(
        XManagerXClient.UPLOAD_BASE,
        {
          method: 'POST',
          // multipart の境界は fetch に付けさせる（content-type 無し）。
          headers: headers(auth, undefined, false),
          body: form,
        },
        auth,
        { isWrite: true, expectJson: false },
      );
    }

    /** 動画の処理（processing_info）が終わるまで STATUS を確認する。 */
    async function waitForVideoReady(auth, mediaId, processingInfo) {
      let info = processingInfo;
      const deadline = Date.now() + mediaStatusDeadlineMs;
      while (info && (info.state === 'pending' || info.state === 'in_progress')) {
        if (Date.now() > deadline) {
          throw errors.makeError(
            'x_error',
            '動画の処理が時間切れになりました。しばらく待ってから再試行してください。',
          );
        }
        await new Promise((resolve) => setTimeout(resolve, mediaStatusPollMs));
        const res = await uploadForm(auth, { command: 'STATUS', media_id: mediaId });
        info = res ? res.processing_info : null;
      }
      if (info && info.state === 'failed') {
        throw errors.makeError(
          'x_error',
          `動画の処理に失敗しました（${info.error?.message || info.error?.name || '原因不明'}）。別のファイルで試してください。`,
        );
      }
    }

    /**
     * メディアを upload.x.com へ上げ、media_id の一覧を返す。
     * INIT → APPEND（5MBずつ）→ FINALIZE、動画は STATUS 確認まで。
     * @param {Array<{name: string, mime: string, kind: 'image'|'video', data: Uint8Array}>} items
     */
    async function uploadMedia(auth, items) {
      validateMediaItems(items);
      const mediaIds = [];
      for (const item of items) {
        const category = item.kind === 'video' ? 'tweet_video' : 'tweet_image';
        const init = await uploadForm(auth, {
          command: 'INIT',
          media_type: item.mime,
          total_bytes: String(item.data.length),
          media_category: category,
        });
        const mediaId = init ? init.media_id_string : null;
        if (!mediaId) {
          throw errors.makeError(
            'x_error',
            `メディア「${item.name}」のアップロード開始に失敗しました。`,
          );
        }
        const chunkSize = mediaAppendChunkBytes;
        const chunks = Math.max(1, Math.ceil(item.data.length / chunkSize));
        for (let i = 0; i < chunks; i++) {
          const slice = item.data.subarray(i * chunkSize, (i + 1) * chunkSize);
          await uploadAppend(auth, mediaId, i, slice, item.mime);
        }
        const fin = await uploadForm(auth, { command: 'FINALIZE', media_id: mediaId });
        if (item.kind === 'video') {
          await waitForVideoReady(auth, mediaId, fin ? fin.processing_info : null);
        }
        mediaIds.push(mediaId);
      }
      return mediaIds;
    }

    async function deleteTweet(auth, tweetId) {
      await graphql(auth, 'DeleteTweet', { tweet_id: tweetId, dark: false }, 'POST');
      return { deleted: true };
    }

    async function favoriteTweet(auth, tweetId) {
      await graphql(auth, 'FavoriteTweet', { tweet_id: tweetId }, 'POST');
      return { done: true };
    }

    async function retweet(auth, tweetId) {
      await graphql(auth, 'CreateRetweet', { tweet_id: tweetId, dark: false }, 'POST');
      return { done: true };
    }

    async function bookmarkTweet(auth, tweetId) {
      await graphql(auth, 'CreateBookmark', { tweet_id: tweetId }, 'POST');
      return { done: true };
    }

    async function followUser(auth, handleOrId) {
      let userId = handleOrId;
      if (!/^\d+$/.test(handleOrId)) {
        const user = await getUserByScreenName(auth, handleOrId);
        userId = user.id;
      }
      const json = await restForm(auth, '/friendships/create.json', { user_id: userId });
      if (json && Array.isArray(json.errors) && json.errors.length > 0) {
        throw errors.makeError(
          'x_error',
          `Xがエラーを返しました：${json.errors[0].message || 'フォローに失敗しました'}`,
        );
      }
      if (!json || typeof json.id_str === 'undefined') {
        throw errors.makeError('x_error', 'フォローの応答を読み取れませんでした。');
      }
      return { done: true, userId: String(json.id_str) };
    }

    // ---- 読み取り ----

    async function getUserByScreenName(auth, screenName) {
      const data = await graphql(
        auth,
        'UserByScreenName',
        {
          screen_name: screenName,
          withSafetyModeUserFields: true,
          withSuperFollowsUserFields: true,
        },
        'GET',
      );
      const result = data?.user?.result;
      if (!result || result.__typename === 'UserUnavailable') {
        throw errors.makeError('x_error', `@${screenName} のアカウントが見つかりません。`);
      }
      const legacy = result.legacy || {};
      return {
        id: result.rest_id,
        handle: legacy.screen_name || screenName,
        name: legacy.name || '',
        followers: typeof legacy.followers_count === 'number' ? legacy.followers_count : -1,
        following: typeof legacy.friends_count === 'number' ? legacy.friends_count : -1,
      };
    }

    /**
     * ログイン中のアカウント本人を確認する。
     * REST 1.1 の `account/verify_credentials.json`（Web 版のセッション
     * でも使える、認証済みユーザー本人の情報だけを返す軽い呼び出し）
     * で、数値のユーザーIDとハンドルを取る。ポップアップの
     * 「今ログイン中のアカウントを取り込む」で使う。
     * 401/403 は「セッション切れ」ではなく「この確認方法が
     * 受け付けられなかった」可能性もあるため、手入力への誘導を
     * 含む文言にして返す。
     */
    async function getCurrentUser(auth) {
      let json;
      try {
        json = await requestJson(
          `${XManagerXClient.REST_BASE}/account/verify_credentials.json?include_email=false&skip_status=true`,
          { method: 'GET', headers: headers(auth), credentials: 'include' },
          auth,
          { isWrite: false },
        );
      } catch (err) {
        if (err && (err.status === 401 || err.status === 403)) {
          throw errors.makeError(
            'x_error',
            'ログイン中のアカウントを確認できませんでした。x.com にログインし直すか、手入力で登録してください。',
          );
        }
        throw err;
      }
      const id =
        json && typeof json.id_str === 'string'
          ? json.id_str
          : json && typeof json.id === 'number'
            ? String(json.id)
            : '';
      const handle = json && typeof json.screen_name === 'string' ? json.screen_name : '';
      if (!id || !handle) {
        throw errors.makeError(
          'x_error',
          'ログイン中のアカウントを確認できませんでした。x.com にログインし直すか、手入力で登録してください。',
        );
      }
      return { id, handle };
    }

    async function getUserTweets(auth, userId, count) {
      const data = await graphql(
        auth,
        'UserTweets',
        {
          userId,
          count,
          includePromotedContent: false,
          withQuickPromoteEligibilityTweetFields: false,
          withVoice: false,
          withV2Timeline: true,
        },
        'GET',
      );
      const instructions = data?.user?.result?.timeline_v2?.timeline?.instructions;
      return timelineEntries(instructions).map(entryTweet).filter(Boolean).map(tweetMetrics);
    }

    async function searchTimeline(auth, rawQuery, product) {
      const data = await graphql(
        auth,
        'SearchTimeline',
        {
          rawQuery,
          count: 20,
          querySource: 'typed_query',
          product,
        },
        'GET',
      );
      const instructions = data?.search_by_raw_query?.search_timeline?.timeline?.instructions;
      return timelineEntries(instructions).map(entryTweet).filter(Boolean).map(tweetMetrics);
    }

    /**
     * 通知・DMのバッジ数。Web 版が使う `badge_count.json` を試す。
     * 取れなければ null（呼び出し側が -1＝不明として扱う）。
     */
    async function getBadgeCounts(auth) {
      try {
        const json = await requestJson(
          'https://x.com/i/api/2/badge_count.json',
          { method: 'GET', headers: headers(auth) },
          auth,
          { isWrite: false },
        );
        if (typeof json !== 'object' || json === null) return null;
        const notifications =
          typeof json.notification_count === 'number' ? json.notification_count : null;
        const dmCount = typeof json.dm_count === 'number' ? json.dm_count : null;
        if (notifications === null && dmCount === null) return null;
        return {
          notifications: notifications ?? -1,
          dmCount: dmCount ?? -1,
        };
      } catch {
        return null;
      }
    }

    async function getNotifications(auth, count = 20) {
      const json = await requestJson(
        `https://x.com/i/api/2/notifications/all.json?count=${count}`,
        { method: 'GET', headers: headers(auth) },
        auth,
        { isWrite: false },
      );
      const items = parseNotificationTimeline(json);
      if (items === null) {
        throw errors.makeError(
          'not_implemented',
          '通知一覧の応答形式が変わっています。拡張の更新が必要です。',
        );
      }
      let dmItems = [];
      try {
        dmItems = await getDmItems(auth);
      } catch {
        // DM が取れなくても通知だけ返す（部分対応）
      }
      return [...dmItems, ...items];
    }

    async function getDmItems(auth) {
      const json = await requestJson(
        'https://x.com/i/api/1.1/dm/inbox_timeline/trusted.json',
        { method: 'GET', headers: headers(auth) },
        auth,
        { isWrite: false },
      );
      const entries = json?.inbox_timeline?.entries;
      if (!Array.isArray(entries)) return [];
      const users = json?.users || {};
      const items = [];
      for (const entry of entries) {
        const data = entry?.message?.message_data;
        if (!data || typeof data.text !== 'string') continue;
        const senderId = String(data.sender_id || '');
        const sender = users[senderId];
        items.push({
          kind: 'dm',
          title: 'DM',
          body: data.text,
          fromHandle: sender?.screen_name,
          at: toEpochMs(data.time) ?? Date.now(),
        });
      }
      return items;
    }

    return {
      postTweet,
      uploadMedia,
      deleteTweet,
      favoriteTweet,
      retweet,
      bookmarkTweet,
      followUser,
      getCurrentUser,
      getUserByScreenName,
      getUserTweets,
      searchTimeline,
      getBadgeCounts,
      getNotifications,
    };
  },
};

/** タイムラインの instructions からエントリ一覧を取り出す。 */
function timelineEntries(instructions) {
  const entries = [];
  for (const inst of instructions || []) {
    if (inst.type === 'TimelineAddEntries' && Array.isArray(inst.entries)) {
      entries.push(...inst.entries);
    }
  }
  return entries;
}

/** エントリからツイート本体を取り出す（可視性ラッパー・墓碑は弾く）。 */
function entryTweet(entry) {
  if (!entry || entry.content?.entryType !== 'TimelineTimelineItem') return null;
  const result = entry.content?.itemContent?.tweet_results?.result;
  if (!result) return null;
  const tweet =
    result.__typename === 'TweetWithVisibilityResults' ? result.tweet : result;
  if (!tweet || tweet.__typename === 'TweetTombstone' || !tweet.legacy) return null;
  return tweet;
}

/** ツイート本体をアプリ側で使う計測値に写す。 */
function tweetMetrics(tweet) {
  const legacy = tweet.legacy || {};
  const views =
    legacy.views && typeof legacy.views.count === 'string'
      ? Number(legacy.views.count)
      : 0;
  return {
    id: tweet.rest_id,
    text: legacy.full_text || '',
    createdAt: legacy.created_at ? Date.parse(legacy.created_at) : 0,
    likes: legacy.favorite_count ?? 0,
    reposts: legacy.retweet_count ?? 0,
    bookmarks: legacy.bookmark_count ?? 0,
    views: Number.isFinite(views) ? views : 0,
    authorHandle: tweet.core?.user_results?.result?.legacy?.screen_name || '',
  };
}

/**
 * 応答の時刻らしき値をエポックmsに直す。秒・ミリ秒どちらにも対応し、
 * あり得ない値（マイクロ秒やゴミ）は null にする。通知・DM の at は
 * 再取得でも同じ値でないと台帳の重複排除が効かないため、応答の時刻
 * を優先し、取れないときだけ取得時刻を使う。
 */
function toEpochMs(value) {
  const num =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : NaN;
  if (!Number.isFinite(num)) return null;
  const now = Date.now();
  if (num >= 1_000_000_000_000 && num <= now + 86_400_000) return num;
  if (num >= 1_000_000_000 && num < 1_000_000_000_000) {
    const ms = num * 1000;
    if (ms <= now + 86_400_000) return ms;
  }
  return null;
}

/**
 * 通知一覧の応答を NotificationItem っぽい形に写す。
 * 形式が想定と違えば null を返し、呼び出し側が not_implemented にする。
 */
function parseNotificationTimeline(json) {
  const instructions = json?.timeline?.instructions;
  if (!Array.isArray(instructions)) return null;
  const items = [];
  for (const entry of timelineEntries(instructions)) {
    const notification = entry?.content?.itemContent?.notification;
    if (!notification) continue;
    const text =
      notification.message?.text ||
      (typeof notification.message === 'string' ? notification.message : '');
    if (!text) continue;
    items.push({
      kind: 'notification',
      title: '通知',
      body: text,
      fromHandle: notification.fromUser?.screen_name,
      at: toEpochMs(notification.timestamp) ?? toEpochMs(entry?.sortIndex) ?? Date.now(),
    });
  }
  return items;
}

if (typeof self !== 'undefined') {
  self.XManagerXClient = XManagerXClient;
}
