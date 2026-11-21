/**
 * Microsoft Graph（Outlook）経由の受信チェック — タスク3-3。
 *
 * 方針A（Gmail API / Microsoft Graph 経由の OAuth2）の Outlook 側。
 * 3-2 の Gmail と同じ型：ブラウザから HTTPS で呼べる Graph API で
 * 受信トレイのヘッダ一覧と未読数を取る。読み取り専用。
 *
 * スコープは Mail.ReadBasic のみ。List messages の最小権限で、
 * From / Subject / receivedDateTime / isRead が取れる。送信・既読化・
 * フォルダ移動はしない（MVP の外）。本文を読む必要が出たら
 * Mail.Read への切り替えを検討する。
 * 実際の OAuth2 認可・トークン保存は 3-4 で決める。ここでは
 * アクセストークンを受け取って呼ぶだけの純粋な呼び出し層と、
 * 応答のパース（純粋関数）だけを実装する。トークンはエラーメッセージ
 * に含めない。
 */

export const OUTLOOK_READ_SCOPE =
  'https://graph.microsoft.com/Mail.ReadBasic';

export const GRAPH_API_BASE = 'https://graph.microsoft.com/v1.0';

const MAX_RESULTS_MIN = 1;
const MAX_RESULTS_MAX = 100;
const DEFAULT_MAX_RESULTS = 10;

export interface OutlookMessageHeader {
  id: string;
  from: string;
  subject: string;
  /** receivedDateTime の文字列。そのまま。 */
  date: string;
  /** date を時刻に直したもの。読めない・無いときは null。 */
  dateMs: number | null;
}

export interface OutlookMessageList {
  ids: string[];
  nextLink: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 受信トレイ一覧の URL を作る。maxResults は 1〜100。
 * unreadOnly のときは $filter=isRead eq false を付ける。
 * ヘッダに必要な項目だけ $select で絞り、新着順に並べる。
 */
export function buildOutlookListUrl(options: {
  maxResults?: number;
  unreadOnly?: boolean;
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
  params.set('$select', 'id,from,subject,receivedDateTime');
  params.set('$orderby', 'receivedDateTime desc');
  params.set('$top', String(maxResults));
  if (options.unreadOnly) params.set('$filter', 'isRead eq false');
  return `${GRAPH_API_BASE}/me/mailFolders/inbox/messages?${params.toString()}`;
}

/** messages.list の応答から ID 一覧と次ページのリンクを取り出す。 */
export function parseOutlookMessageList(data: unknown): OutlookMessageList {
  if (!isRecord(data)) {
    throw new Error('Outlookの一覧の応答が想定と違います。');
  }
  if (data.value !== undefined && !Array.isArray(data.value)) {
    throw new Error('Outlookの一覧の応答が想定と違います。');
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of (data.value ?? []) as unknown[]) {
    if (!isRecord(item) || typeof item.id !== 'string') continue;
    const id = item.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  const nextLink =
    typeof data['@odata.nextLink'] === 'string' && data['@odata.nextLink']
      ? data['@odata.nextLink']
      : undefined;
  return { ids, nextLink };
}

/** Graph の message 1件からヘッダを取り出す。 */
export function extractMessageHeaders(data: unknown): OutlookMessageHeader {
  if (!isRecord(data) || typeof data.id !== 'string' || !data.id.trim()) {
    throw new Error('OutlookのメッセージにIDがありません。');
  }
  const fromObj = isRecord(data.from) ? data.from : {};
  const email = isRecord(fromObj.emailAddress) ? fromObj.emailAddress : {};
  const address = typeof email.address === 'string' ? email.address : '';
  const name = typeof email.name === 'string' ? email.name : '';
  const from = name && address ? `${name} <${address}>` : address;
  const subject = typeof data.subject === 'string' ? data.subject : '';
  const date =
    typeof data.receivedDateTime === 'string' ? data.receivedDateTime : '';
  const parsed = date ? Date.parse(date) : Number.NaN;
  return {
    id: data.id,
    from,
    subject,
    date,
    dateMs: Number.isFinite(parsed) ? parsed : null,
  };
}

/** mailFolder の応答から受信トレイの未読数を取る。 */
export function extractInboxUnreadCount(data: unknown): number {
  if (
    !isRecord(data) ||
    typeof data.unreadItemCount !== 'number' ||
    !Number.isInteger(data.unreadItemCount) ||
    data.unreadItemCount < 0
  ) {
    throw new Error('Outlookの未読数が取得できませんでした。');
  }
  return data.unreadItemCount;
}

/** From のドメインが x.com / twitter.com（サブドメイン含む）かどうか。 */
export function isXNotificationMail(header: OutlookMessageHeader): boolean {
  const match = /<([^<>@\s]+@[^<>@\s]+)>|([^\s<>]+@[^\s<>]+)/.exec(
    header.from,
  );
  const address = (match?.[1] ?? match?.[2] ?? '').trim().toLowerCase();
  const domain = address.split('@')[1] ?? '';
  return domain === 'x.com' || domain === 'twitter.com' ||
    domain.endsWith('.x.com') || domain.endsWith('.twitter.com');
}

export interface OutlookFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type OutlookFetchFn = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<OutlookFetchResponse>;

export interface OutlookClient {
  listHeaders(options: {
    maxResults?: number;
    unreadOnly?: boolean;
  }): Promise<OutlookMessageHeader[]>;
  getUnreadCount(): Promise<number>;
}

function outlookError(status: number): Error {
  if (status === 401) {
    return new Error(
      'Outlookの認証が切れています。もう一度連携してください。',
    );
  }
  if (status === 403) {
    return new Error(
      'Microsoft Graphの利用が許可されていません。Graph APIが有効か、スコープを確認してください。',
    );
  }
  return new Error(
    `Outlookからの応答が想定と違います（${status}）。`,
  );
}

async function callOutlook(
  fetchFn: OutlookFetchFn,
  accessToken: string,
  url: string,
): Promise<unknown> {
  let res: OutlookFetchResponse;
  try {
    res = await fetchFn(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    throw new Error(
      'Outlookに接続できませんでした。ネットワークを確認してください。',
    );
  }
  if (!res.ok) throw outlookError(res.status);
  return res.json();
}

/**
 * Microsoft Graph クライアントを作る。fetch は注入できるので、
 * テストではモック fetch を渡す。実運用の fetch はブラウザ標準のもの。
 * Gmail と違い、一覧の応答に From / Subject / receivedDateTime が
 * 既に入っているので、1回の呼び出しでヘッダ一覧が取れる。
 */
export function createOutlookClient(options: {
  accessToken: string;
  fetchFn?: OutlookFetchFn;
}): OutlookClient {
  const { accessToken } = options;
  if (!accessToken || !accessToken.trim()) {
    throw new Error('Outlookのアクセストークンがありません。');
  }
  const fetchFn: OutlookFetchFn =
    options.fetchFn ??
    ((url, init) => fetch(url, init) as Promise<OutlookFetchResponse>);

  return {
    async listHeaders({ maxResults, unreadOnly }) {
      const listUrl = buildOutlookListUrl({ maxResults, unreadOnly });
      const data = await callOutlook(fetchFn, accessToken, listUrl);
      if (!isRecord(data) || !Array.isArray(data.value)) {
        throw new Error('Outlookの一覧の応答が想定と違います。');
      }
      return (data.value as unknown[]).map((item) =>
        extractMessageHeaders(item)
      );
    },

    async getUnreadCount() {
      const params = new URLSearchParams();
      params.set('$select', 'unreadItemCount');
      const data = await callOutlook(
        fetchFn,
        accessToken,
        `${GRAPH_API_BASE}/me/mailFolders/inbox?${params.toString()}`,
      );
      return extractInboxUnreadCount(data);
    },
  };
}

/** 画面の試作やテスト用の、手元のデータだけを返すクライアント。 */
export function createMockOutlookClient(options: {
  headers: readonly OutlookMessageHeader[];
  unreadCount: number;
}): OutlookClient {
  return {
    async listHeaders() {
      return [...options.headers];
    },
    async getUnreadCount() {
      return options.unreadCount;
    },
  };
}
