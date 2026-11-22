/**
 * Gmail API（readonly）経由の受信チェック — タスク3-2。
 *
 * 方針A（Gmail API / Microsoft Graph 経由の OAuth2）の Gmail 側。
 * ブラウザから HTTPS で呼べる Gmail API を使う。
 *
 * このモジュールは読み取り専用。スコープは gmail.readonly のみで、
 * 送信・既読化・フォルダ移動はしない（MVP の外）。
 * 実際の OAuth2 認可・トークン保存は 3-4 で決める。ここでは
 * アクセストークンを受け取って呼ぶだけの純粋な呼び出し層と、
 * 応答のパース（純粋関数）だけを実装する。トークンはエラーメッセージ
 * に含めない。
 */

export const GMAIL_READONLY_SCOPE =
  'https://www.googleapis.com/auth/gmail.readonly';

export const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1';

const MAX_RESULTS_MIN = 1;
const MAX_RESULTS_MAX = 100;
const DEFAULT_MAX_RESULTS = 10;

export interface GmailMessageHeader {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  date: string;
  /** Date ヘッダを時刻に直したもの。読めない・無いときは null。 */
  dateMs: number | null;
}

export interface GmailMessageList {
  ids: string[];
  nextPageToken: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 受信トレイ一覧の URL を作る。maxResults は 1〜100。 */
export function buildGmailListUrl(options: {
  query?: string;
  maxResults?: number;
}): string {
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
  if (
    !Number.isInteger(maxResults) ||
    maxResults < MAX_RESULTS_MIN ||
    maxResults > MAX_RESULTS_MAX
  ) {
    throw new Error(
      `件数は${MAX_RESULTS_MIN}〜${MAX_RESULTS_MAX}の範囲で指定してください。`,
    );
  }
  const params = new URLSearchParams();
  if (options.query?.trim()) params.set('q', options.query.trim());
  params.set('maxResults', String(maxResults));
  return `${GMAIL_API_BASE}/users/me/messages?${params.toString()}`;
}

/** messages.list の応答から ID 一覧と次ページのトークンを取り出す。 */
export function parseGmailMessageList(data: unknown): GmailMessageList {
  if (!isRecord(data)) {
    throw new Error('Gmailの一覧の応答が想定と違います。');
  }
  if (data.messages !== undefined && !Array.isArray(data.messages)) {
    throw new Error('Gmailの一覧の応答が想定と違います。');
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of (data.messages ?? []) as unknown[]) {
    if (!isRecord(item) || typeof item.id !== 'string') continue;
    const id = item.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  const nextPageToken =
    typeof data.nextPageToken === 'string' && data.nextPageToken
      ? data.nextPageToken
      : undefined;
  return { ids, nextPageToken };
}

function headerValue(
  headers: unknown,
  name: string,
): string {
  if (!Array.isArray(headers)) return '';
  const lower = name.toLowerCase();
  for (const h of headers as unknown[]) {
    if (
      isRecord(h) &&
      typeof h.name === 'string' &&
      h.name.toLowerCase() === lower &&
      typeof h.value === 'string'
    ) {
      return h.value;
    }
  }
  return '';
}

/** messages.get（metadata）の応答からヘッダを取り出す。 */
export function extractMessageHeaders(data: unknown): GmailMessageHeader {
  if (!isRecord(data) || typeof data.id !== 'string' || !data.id.trim()) {
    throw new Error('GmailのメッセージにIDがありません。');
  }
  const payload = isRecord(data.payload) ? data.payload : {};
  const headers = Array.isArray(payload.headers) ? payload.headers : [];
  const from = headerValue(headers, 'From');
  const subject = headerValue(headers, 'Subject');
  const date = headerValue(headers, 'Date');
  const parsed = date ? Date.parse(date) : Number.NaN;
  return {
    id: data.id,
    threadId: typeof data.threadId === 'string' ? data.threadId : '',
    from,
    subject,
    date,
    dateMs: Number.isFinite(parsed) ? parsed : null,
  };
}

/** labels.get の応答から INBOX の未読数を取る。 */
export function extractLabelUnreadCount(data: unknown): number {
  if (
    !isRecord(data) ||
    typeof data.messagesUnread !== 'number' ||
    !Number.isInteger(data.messagesUnread) ||
    data.messagesUnread < 0
  ) {
    throw new Error('Gmailの未読数が取得できませんでした。');
  }
  return data.messagesUnread;
}

/** From のドメインが x.com / twitter.com（サブドメイン含む）かどうか。 */
export function isXNotificationMail(header: GmailMessageHeader): boolean {
  const match = /<([^<>@\s]+@[^<>@\s]+)>|([^\s<>]+@[^\s<>]+)/.exec(
    header.from,
  );
  const address = (match?.[1] ?? match?.[2] ?? '').trim().toLowerCase();
  const domain = address.split('@')[1] ?? '';
  return domain === 'x.com' || domain === 'twitter.com' ||
    domain.endsWith('.x.com') || domain.endsWith('.twitter.com');
}

export interface GmailFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type GmailFetchFn = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<GmailFetchResponse>;

export interface GmailClient {
  listHeaders(options: {
    query?: string;
    maxResults?: number;
  }): Promise<GmailMessageHeader[]>;
  getUnreadCount(): Promise<number>;
}

function gmailError(status: number): Error {
  if (status === 401) {
    return new Error(
      'Gmailの認証が切れています。もう一度連携してください。',
    );
  }
  if (status === 403) {
    return new Error(
      'Gmail APIの利用が許可されていません。Gmail APIが有効か、スコープを確認してください。',
    );
  }
  return new Error(
    `Gmailからの応答が想定と違います（${status}）。`,
  );
}

async function callGmail(
  fetchFn: GmailFetchFn,
  accessToken: string,
  url: string,
): Promise<unknown> {
  let res: GmailFetchResponse;
  try {
    res = await fetchFn(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    throw new Error(
      'Gmailに接続できませんでした。ネットワークを確認してください。',
    );
  }
  if (!res.ok) throw gmailError(res.status);
  return res.json();
}

/**
 * Gmail API クライアントを作る。fetch は注入できるので、
 * テストではモック fetch を渡す。実運用の fetch はブラウザ標準のもの。
 */
export function createGmailClient(options: {
  accessToken: string;
  fetchFn?: GmailFetchFn;
}): GmailClient {
  const { accessToken } = options;
  if (!accessToken || !accessToken.trim()) {
    throw new Error('Gmailのアクセストークンがありません。');
  }
  const fetchFn: GmailFetchFn =
    options.fetchFn ??
    ((url, init) => fetch(url, init) as Promise<GmailFetchResponse>);

  return {
    async listHeaders({ query, maxResults }) {
      const listUrl = buildGmailListUrl({ query, maxResults });
      const list = parseGmailMessageList(
        await callGmail(fetchFn, accessToken, listUrl),
      );
      const headers: GmailMessageHeader[] = [];
      for (const id of list.ids) {
        const url =
          `${GMAIL_API_BASE}/users/me/messages/${encodeURIComponent(id)}` +
          '?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date';
        headers.push(
          extractMessageHeaders(await callGmail(fetchFn, accessToken, url)),
        );
      }
      return headers;
    },

    async getUnreadCount() {
      const data = await callGmail(
        fetchFn,
        accessToken,
        `${GMAIL_API_BASE}/users/me/labels/INBOX`,
      );
      return extractLabelUnreadCount(data);
    },
  };
}

/** 画面の試作やテスト用の、手元のデータだけを返すクライアント。 */
export function createMockGmailClient(options: {
  headers: readonly GmailMessageHeader[];
  unreadCount: number;
}): GmailClient {
  return {
    async listHeaders() {
      return [...options.headers];
    },
    async getUnreadCount() {
      return options.unreadCount;
    },
  };
}
