/**
 * ブラウザ（この拡張）としての「名乗り」をそろえるための部品。
 *
 * birdy など実績のあるクッキーセッション系クライアントが送っている
 * 2種類の情報を、x-manager の拡張でも送るようにする。
 *
 * 1. x-client-uuid / x-twitter-client-deviceid ヘッダ
 *    拡張（＝このブラウザ）ごとに固定の値を生成して
 *    chrome.storage.local に保存し、全リクエストで同じ値を送る。
 *    本物の Web クライアントも端末ごとに安定した値を送っており、
 *    リクエストごとに変わる／そもそも無い状態は「セッションらしく
 *    ない」見え方になる。値はランダムな hex で、個人やアカウントを
 *    特定する情報ではない（auth_token とは無関係）。
 *
 * 2. CreateTweet の Referer
 *    本物のコンポーザーから投稿するとき Referer は
 *    https://x.com/compose/post になる。拡張の fetch では Referer
 *    ヘッダを直接書き換えられない（fetch の禁止ヘッダ）ため、
 *    declarativeNetRequest の動的ルールで CreateTweet の POST
 *    だけに設定する。ルール登録に失敗しても実行自体は止めない
 *    （Referer が無い状態は従来どおりの動作）。
 */
'use strict';

/* global self, crypto */

const XManagerClientIdentity = {
  STORAGE_KEY: 'xmanager.clientIdentity.v1',
  REFERER_RULE_ID: 1,
  COMPOSE_REFERER: 'https://x.com/compose/post',
  CREATE_TWEET_REGEX: '^https://x\\.com/i/api/graphql/[^/]+/CreateTweet$',

  /** 16バイトのランダム値を 32 桁の hex で返す。 */
  randomHexId() {
    const bytes = new Uint8Array(16);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = Math.floor(Math.random() * 256);
      }
    }
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  },

  isValidIdentity(value) {
    return (
      !!value &&
      typeof value === 'object' &&
      typeof value.clientUuid === 'string' &&
      /^[0-9a-f]{32}$/.test(value.clientUuid) &&
      typeof value.deviceId === 'string' &&
      /^[0-9a-f]{32}$/.test(value.deviceId)
    );
  },

  /**
   * 保存済みの ID を返す。無ければ（または壊れていれば）生成して
   * 保存する。storage は chrome.storage.local 互換の { get, set }。
   */
  async getIdentity(storage) {
    const stored = await storage.get(XManagerClientIdentity.STORAGE_KEY);
    const existing = stored ? stored[XManagerClientIdentity.STORAGE_KEY] : null;
    if (XManagerClientIdentity.isValidIdentity(existing)) {
      return { clientUuid: existing.clientUuid, deviceId: existing.deviceId };
    }
    const identity = {
      clientUuid: XManagerClientIdentity.randomHexId(),
      deviceId: XManagerClientIdentity.randomHexId(),
    };
    await storage.set({ [XManagerClientIdentity.STORAGE_KEY]: identity });
    return identity;
  },

  /** CreateTweet の POST だけ Referer をコンポーザーに寄せる DNR ルール。 */
  buildRefererRules() {
    return [
      {
        id: XManagerClientIdentity.REFERER_RULE_ID,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            {
              header: 'referer',
              operation: 'set',
              value: XManagerClientIdentity.COMPOSE_REFERER,
            },
          ],
        },
        condition: {
          regexFilter: XManagerClientIdentity.CREATE_TWEET_REGEX,
          requestMethods: ['post'],
          resourceTypes: ['xmlhttprequest'],
        },
      },
    ];
  },

  /**
   * DNR の動的ルールを登録する。API が無い／失敗したら false を
   * 返し、呼び出し側の動作は止めない。
   */
  async registerRefererRules(chromeLike) {
    const dnr = chromeLike && chromeLike.declarativeNetRequest;
    if (!dnr || typeof dnr.updateDynamicRules !== 'function') return false;
    try {
      await dnr.updateDynamicRules({
        removeRuleIds: [XManagerClientIdentity.REFERER_RULE_ID],
        addRules: XManagerClientIdentity.buildRefererRules(),
      });
      return true;
    } catch {
      return false;
    }
  },
};

self.XManagerClientIdentity = XManagerClientIdentity;
