/**
 * メディア転送データの一時保管庫（background service worker 用）。
 *
 * アプリはメディア本体を base64 のチャンク（`media-chunk`）に切って
 * 送り、ここで組み立て直す。ジョブが来たら `take` で取り出し、
 * upload.x.com へ上げる。取り出した項目は保管庫から消える
 * （二重送信を防ぐ）。保管できる合計バイト数に上限を付け、
 * 超えたら古いものから捨てる（メモリを食い潰さないため）。
 *
 * 1チャンクの上限はプロトコル（MEDIA_CHUNK_SIZE＝256KB base64）。
 * チャンク番号の重複・範囲外・base64 以外の文字は弾く。
 */
'use strict';

/* global self */

const XManagerMediaStore = {
  /** 1件の転送あたりのチャンク数の上限（256KB×1024 ≒ 256MB相当）。 */
  MAX_CHUNKS: 1024,

  /**
   * @param {{ maxBytes?: number }} opts - 保管する合計バイト数の上限（既定100MB）
   */
  createMediaStore(opts) {
    const maxBytes =
      opts && typeof opts.maxBytes === 'number' ? opts.maxBytes : 100 * 1024 * 1024;
    /** uploadId → { totalChunks, parts: Map<index, string>, estimatedBytes, createdAt } */
    const items = new Map();
    let totalBytes = 0;

    function dropOldest() {
      let oldestId = null;
      let oldestAt = Infinity;
      for (const [id, item] of items) {
        if (item.createdAt < oldestAt) {
          oldestAt = item.createdAt;
          oldestId = id;
        }
      }
      if (oldestId !== null) {
        totalBytes -= items.get(oldestId).estimatedBytes;
        items.delete(oldestId);
      }
    }

    return {
      /** 保管中の合計バイト数（概算・テスト用）。 */
      bytes() {
        return totalBytes;
      },

      /** 保管中の転送セッション数（テスト用）。 */
      count() {
        return items.size;
      },

      /**
       * `media-chunk` メッセージを1件受け取る。検証に通らなければ
       * Error を投げる（呼び出し側が応答に写す）。
       * @param {{ uploadId: string, index: number, totalChunks: number, data: string }} msg
       */
      storeChunk(msg) {
        if (!msg || typeof msg.uploadId !== 'string' || msg.uploadId.length === 0) {
          throw new Error('メディア転送のIDがありません。');
        }
        if (
          !Number.isInteger(msg.index) ||
          !Number.isInteger(msg.totalChunks) ||
          msg.totalChunks < 1 ||
          msg.totalChunks > XManagerMediaStore.MAX_CHUNKS ||
          msg.index < 0 ||
          msg.index >= msg.totalChunks
        ) {
          throw new Error('メディア転送のチャンク番号が不正です。');
        }
        if (typeof msg.data !== 'string' || msg.data.length === 0) {
          throw new Error('メディア転送のデータが空です。');
        }
        if (!/^[A-Za-z0-9+/=]+$/.test(msg.data)) {
          throw new Error('メディア転送のデータが base64 ではありません。');
        }
        let item = items.get(msg.uploadId);
        if (!item) {
          item = {
            totalChunks: msg.totalChunks,
            parts: new Map(),
            estimatedBytes: 0,
            createdAt: Date.now(),
          };
          items.set(msg.uploadId, item);
        }
        if (item.totalChunks !== msg.totalChunks) {
          throw new Error('メディア転送のチャンク総数が途中で変わりました。');
        }
        if (item.parts.has(msg.index)) {
          throw new Error('メディア転送の同じチャンクが二重に送られました。');
        }
        item.parts.set(msg.index, msg.data);
        // base64 長からバイト数を概算（4文字＝3バイト）。
        const bytes = Math.floor((msg.data.length * 3) / 4);
        item.estimatedBytes += bytes;
        totalBytes += bytes;
        while (totalBytes > maxBytes) dropOldest();
      },

      /**
       * 揃った転送を取り出して保管庫から消す。`meta` はジョブの
       * media 参照（名前・MIME・種別・サイズ）。チャンクが欠けて
       * いれば null を返す（呼び出し側がエラーにする）。
       * @param {string} uploadId
       * @param {{ name?: string, mime?: string, kind?: string, size?: number }} meta
       */
      take(uploadId, meta) {
        const item = items.get(uploadId);
        if (!item) return null;
        items.delete(uploadId);
        totalBytes -= item.estimatedBytes;
        if (item.parts.size !== item.totalChunks) return null;
        let base64 = '';
        for (let i = 0; i < item.totalChunks; i++) {
          const part = item.parts.get(i);
          if (typeof part !== 'string') return null;
          base64 += part;
        }
        return {
          name: typeof meta?.name === 'string' ? meta.name : '',
          mime: typeof meta?.mime === 'string' ? meta.mime : '',
          kind: meta?.kind === 'video' ? 'video' : 'image',
          size: typeof meta?.size === 'number' && meta.size >= 0 ? meta.size : 0,
          dataBase64: base64,
        };
      },
    };
  },
};

if (typeof self !== 'undefined') {
  self.XManagerMediaStore = XManagerMediaStore;
}
