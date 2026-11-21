import {
  HELLO_TIMEOUT_MS,
  JOB_TIMEOUT_MS,
  MEDIA_CHUNK_SIZE,
  PAGE_SOURCE,
  PROTOCOL_VERSION,
  helloAckDiagnostics,
  isHelloAck,
  isJobResult,
  isMediaChunkAck,
  isSessionsMessage,
  normalizeSessionsMessage,
  type ExtensionDiagnostics,
  type ExtensionJob,
  type ExtensionJobResult,
  type ExtensionSession,
  type MediaChunkAckMessage,
  type PageMessage,
} from './protocol';

/** 拡張が見つからない（未インストール／未読込／このページに未接続）。 */
export class ExtensionNotConnectedError extends Error {
  constructor() {
    super(
      'Chrome拡張「x-manager 実行役」が見つかりません。拡張を読み込んでから、もう一度お試しください。',
    );
    this.name = 'ExtensionNotConnectedError';
  }
}

/** 拡張は見つかったが、制限時間内に返事がなかった。 */
export class ExtensionTimeoutError extends Error {
  constructor(what: string) {
    super(`拡張からの返事が時間切れになりました（${what}）。`);
    this.name = 'ExtensionTimeoutError';
  }
}

/** ハンドシェイクの応答。 */
export interface ExtensionHandshake {
  version: number;
  extensionVersion: string;
  /** 拡張の自己診断（古い拡張では undefined＝不明）。 */
  diagnostics?: ExtensionDiagnostics;
}

/**
 * アプリと拡張をつなぐ輸送層。ExtensionExecutor はこの抽象だけを
 * 見るので、テストでは偽物に差し替えられるし、将来は
 * WebSocket（ローカルエージェント）版に置き換えられる。
 */
export interface ExtensionTransport {
  /** 拡張が応答するかどうか。未接続なら ExtensionNotConnectedError。 */
  ping(timeoutMs?: number): Promise<ExtensionHandshake>;
  /** ジョブを1件送り、結果を待つ。 */
  sendJob(job: ExtensionJob): Promise<ExtensionJobResult>;
  /** 拡張に連携済みのアカウント（ID＋ハンドル）一覧を聞く。 */
  listSessions(): Promise<ExtensionSession[]>;
  /**
   * メディア本体を拡張へ送る。base64 を MEDIA_CHUNK_SIZE ずつに
   * 切って `media-chunk` で順に送り、拡張が組み立てる。
   * `uploadId` はジョブの media 参照と一致させる。
   */
  sendMedia(item: MediaTransferItem): Promise<void>;
}

/** チャンク転送する1件のメディア（bytes は base64）。 */
export interface MediaTransferItem {
  uploadId: string;
  name: string;
  mime: string;
  kind: 'image' | 'video';
  size: number;
  dataBase64: string;
}

/** window.postMessage 経由で content script と話す輸送層。 */
export interface PostMessageWindow {
  postMessage(message: unknown, targetOrigin: string): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

export class WindowPostMessageTransport implements ExtensionTransport {
  private readonly target: PostMessageWindow | undefined;

  constructor(target?: PostMessageWindow) {
    this.target =
      target ?? (typeof window !== 'undefined' ? (window as unknown as PostMessageWindow) : undefined);
  }

  private requireTarget(): PostMessageWindow {
    if (!this.target) throw new ExtensionNotConnectedError();
    return this.target;
  }

  private request<T>(
    message: PageMessage,
    isExpected: (value: unknown) => value is T,
    timeoutMs: number,
    what: string,
  ): Promise<T> {
    const target = this.requireTarget();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new ExtensionTimeoutError(what));
      }, timeoutMs);
      const onMessage = (event: MessageEvent) => {
        if (event.source !== (target as unknown as Window)) return;
        const data: unknown = event.data;
        if (!isExpected(data)) return;
        // ジョブ結果は id で相関を取る。
        if (isJobResult(data) && 'id' in message && data.id !== (message as ExtensionJob).id) {
          return;
        }
        clearTimeout(timer);
        cleanup();
        resolve(data);
      };
      const cleanup = () => target.removeEventListener('message', onMessage);
      target.addEventListener('message', onMessage);
      try {
        target.postMessage(message, '*');
      } catch (err) {
        clearTimeout(timer);
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async ping(timeoutMs = HELLO_TIMEOUT_MS): Promise<ExtensionHandshake> {
    const ack = await this.request(
      { source: PAGE_SOURCE, kind: 'hello', version: PROTOCOL_VERSION },
      isHelloAck,
      timeoutMs,
      '拡張の確認',
    ).catch((err: unknown) => {
      if (err instanceof ExtensionTimeoutError) throw new ExtensionNotConnectedError();
      throw err;
    });
    if (ack.version !== PROTOCOL_VERSION) {
      throw new ExtensionNotConnectedError();
    }
    return {
      version: ack.version,
      extensionVersion: ack.extensionVersion,
      diagnostics: helloAckDiagnostics(ack) ?? undefined,
    };
  }

  async sendJob(job: ExtensionJob): Promise<ExtensionJobResult> {
    const result = await this.request(
      { source: PAGE_SOURCE, kind: 'job', ...job },
      isJobResult,
      job.timeoutMs ?? JOB_TIMEOUT_MS,
      `ジョブ ${job.method}`,
    );
    return result;
  }

  /**
   * メディア本体をチャンクに切って送る。1チャンクごとに拡張の
   * 受領応答（media-chunk-ack）を待つ。応答が無ければ
   * ExtensionTimeoutError／未接続なら ExtensionNotConnectedError。
   */
  async sendMedia(item: MediaTransferItem): Promise<void> {
    const totalChunks = Math.max(1, Math.ceil(item.dataBase64.length / MEDIA_CHUNK_SIZE));
    for (let index = 0; index < totalChunks; index++) {
      const ack = await this.request(
        {
          source: PAGE_SOURCE,
          kind: 'media-chunk',
          uploadId: item.uploadId,
          index,
          totalChunks,
          data: item.dataBase64.slice(index * MEDIA_CHUNK_SIZE, (index + 1) * MEDIA_CHUNK_SIZE),
        },
        // 自分のチャンクの応答だけを受け取る（他の転送と混ざらない）。
        (value: unknown): value is MediaChunkAckMessage =>
          isMediaChunkAck(value) && value.uploadId === item.uploadId && value.index === index,
        HELLO_TIMEOUT_MS,
        `メディア転送 ${item.name} (${index + 1}/${totalChunks})`,
      );
      if (ack.error) {
        throw new Error(ack.error);
      }
    }
  }

  async listSessions(): Promise<ExtensionSession[]> {
    const reply = await this.request(
      { source: PAGE_SOURCE, kind: 'list-sessions' },
      isSessionsMessage,
      HELLO_TIMEOUT_MS,
      '連携アカウントの確認',
    ).catch((err: unknown) => {
      if (err instanceof ExtensionTimeoutError) throw new ExtensionNotConnectedError();
      throw err;
    });
    // 新形式（sessions）と旧形式（accountIds）のどちらが来ても同じ形に揃える。
    return normalizeSessionsMessage(reply);
  }
}
