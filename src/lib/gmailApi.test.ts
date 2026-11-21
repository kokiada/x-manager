import { describe, expect, it } from 'vitest';
import {
  GMAIL_API_BASE,
  GMAIL_READONLY_SCOPE,
  buildGmailListUrl,
  createGmailClient,
  createMockGmailClient,
  extractLabelUnreadCount,
  extractMessageHeaders,
  isXNotificationMail,
  parseGmailMessageList,
} from './gmailApi';
import type { GmailMessageHeader } from './gmailApi';

describe('Gmail API の前提（3-2）', () => {
  it('readonly スコープだけを使う（書き込みスコープは含まない）', () => {
    expect(GMAIL_READONLY_SCOPE).toBe(
      'https://www.googleapis.com/auth/gmail.readonly',
    );
    expect(GMAIL_READONLY_SCOPE).not.toContain('modify');
    expect(GMAIL_READONLY_SCOPE).not.toContain('send');
  });

  it('API の基点は gmail.googleapis.com', () => {
    expect(GMAIL_API_BASE).toBe('https://gmail.googleapis.com/gmail/v1');
  });
});

describe('buildGmailListUrl', () => {
  it('受信トレイの新着一覧の URL を作る', () => {
    const url = buildGmailListUrl({ query: 'is:unread', maxResults: 10 });
    expect(url).toBe(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is%3Aunread&maxResults=10',
    );
  });

  it('クエリが無ければ q を付けない', () => {
    expect(buildGmailListUrl({})).toBe(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10',
    );
  });

  it('maxResults は 1〜100 の範囲だけ受け付ける', () => {
    expect(() => buildGmailListUrl({ maxResults: 0 })).toThrow('件数');
    expect(() => buildGmailListUrl({ maxResults: 101 })).toThrow('件数');
    expect(buildGmailListUrl({ maxResults: 1 })).toContain('maxResults=1');
    expect(buildGmailListUrl({ maxResults: 100 })).toContain('maxResults=100');
  });
});

describe('parseGmailMessageList', () => {
  it('一覧から ID と次ページのトークンを取り出す', () => {
    expect(
      parseGmailMessageList({
        messages: [
          { id: 'a1', threadId: 't1' },
          { id: 'a2', threadId: 't2' },
        ],
        nextPageToken: 'next-1',
        resultSizeEstimate: 2,
      }),
    ).toEqual({ ids: ['a1', 'a2'], nextPageToken: 'next-1' });
  });

  it('messages が無ければ空の一覧になる', () => {
    expect(parseGmailMessageList({})).toEqual({
      ids: [],
      nextPageToken: undefined,
    });
    expect(parseGmailMessageList({ resultSizeEstimate: 0 })).toEqual({
      ids: [],
      nextPageToken: undefined,
    });
  });

  it('ID の無い項目は落とし、重複は1件にする', () => {
    expect(
      parseGmailMessageList({
        messages: [
          { id: 'a1' },
          { threadId: 't2' },
          { id: '' },
          { id: 'a1' },
          { id: 'a2' },
        ],
      }),
    ).toEqual({ ids: ['a1', 'a2'], nextPageToken: undefined });
  });

  it('一覧でない応答はエラーにする', () => {
    expect(() => parseGmailMessageList(null)).toThrow('一覧');
    expect(() => parseGmailMessageList('x')).toThrow('一覧');
    expect(() => parseGmailMessageList({ messages: 'x' })).toThrow('一覧');
  });
});

describe('extractMessageHeaders', () => {
  const base = (headers: { name: string; value: string }[]) => ({
    id: 'm1',
    threadId: 't1',
    payload: { headers },
  });

  it('From / Subject / Date を取り出す（ヘッダ名の大文字小文字は問わない）', () => {
    const h = extractMessageHeaders(
      base([
        { name: 'from', value: 'X <info@x.com>' },
        { name: 'SUBJECT', value: 'ログインのお知らせ' },
        { name: 'Date', value: 'Fri, 21 Nov 2026 08:00:00 +0900' },
      ]),
    );
    expect(h).toEqual({
      id: 'm1',
      threadId: 't1',
      from: 'X <info@x.com>',
      subject: 'ログインのお知らせ',
      date: 'Fri, 21 Nov 2026 08:00:00 +0900',
      dateMs: Date.parse('Fri, 21 Nov 2026 08:00:00 +0900'),
    });
  });

  it('無いヘッダは空文字、日時は null になる', () => {
    expect(extractMessageHeaders(base([]))).toEqual({
      id: 'm1',
      threadId: 't1',
      from: '',
      subject: '',
      date: '',
      dateMs: null,
    });
  });

  it('読めない日時は null にして、他のヘッダはそのまま返す', () => {
    const h = extractMessageHeaders(
      base([
        { name: 'From', value: 'a@x.com' },
        { name: 'Date', value: 'not-a-date' },
      ]),
    );
    expect(h.dateMs).toBeNull();
    expect(h.from).toBe('a@x.com');
  });

  it('ID の無いメッセージはエラーにする', () => {
    expect(() => extractMessageHeaders({ payload: { headers: [] } })).toThrow(
      'ID',
    );
    expect(() => extractMessageHeaders(null)).toThrow('ID');
  });
});

describe('extractLabelUnreadCount', () => {
  it('INBOX ラベルの未読数を返す', () => {
    expect(extractLabelUnreadCount({ messagesUnread: 7 })).toBe(7);
    expect(extractLabelUnreadCount({ messagesUnread: 0 })).toBe(0);
  });

  it('未読数が無い・負の値・数でない場合はエラーにする', () => {
    expect(() => extractLabelUnreadCount({})).toThrow('未読数');
    expect(() => extractLabelUnreadCount({ messagesUnread: -1 })).toThrow(
      '未読数',
    );
    expect(() => extractLabelUnreadCount({ messagesUnread: '3' })).toThrow(
      '未読数',
    );
  });
});

describe('isXNotificationMail', () => {
  const header = (from: string): GmailMessageHeader => ({
    id: 'm1',
    threadId: 't1',
    from,
    subject: 'お知らせ',
    date: '',
    dateMs: null,
  });

  it('x.com / twitter.com からのメールを X の通知と判定する', () => {
    expect(isXNotificationMail(header('X <info@x.com>'))).toBe(true);
    expect(isXNotificationMail(header('Twitter <notify@twitter.com>'))).toBe(
      true,
    );
    expect(isXNotificationMail(header('X <info@notify.x.com>'))).toBe(true);
  });

  it('それ以外は X の通知ではない', () => {
    expect(isXNotificationMail(header('Google <no-reply@google.com>'))).toBe(
      false,
    );
    expect(isXNotificationMail(header(''))).toBe(false);
    expect(isXNotificationMail(header('x.com を騙る <a@evil-x.com>'))).toBe(
      false,
    );
  });
});

describe('createGmailClient（モック fetch）', () => {
  const listBody = {
    messages: [
      { id: 'm1', threadId: 't1' },
      { id: 'm2', threadId: 't2' },
    ],
  };
  const messageBody = (id: string) => ({
    id,
    threadId: 't1',
    payload: {
      headers: [
        { name: 'From', value: 'X <info@x.com>' },
        { name: 'Subject', value: '件名' },
        { name: 'Date', value: 'Fri, 21 Nov 2026 08:00:00 +0900' },
      ],
    },
  });

  function fakeFetch(responses: Record<string, unknown>) {
    return async (url: string) => {
      const body = responses[url];
      if (body === undefined) {
        return { ok: false, status: 404, json: async () => ({}) } as never;
      }
      return { ok: true, status: 200, json: async () => body } as never;
    };
  }

  it('一覧→ヘッダ取得で新着ヘッダ一覧を返す', async () => {
    const fetchFn = fakeFetch({
      'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is%3Aunread&maxResults=10':
        listBody,
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/m1?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date':
        messageBody('m1'),
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/m2?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date':
        messageBody('m2'),
    });
    const client = createGmailClient({ accessToken: 'tok', fetchFn });
    const headers = await client.listHeaders({ query: 'is:unread' });
    expect(headers.map((h) => h.id)).toEqual(['m1', 'm2']);
    expect(headers[0].from).toBe('X <info@x.com>');
  });

  it('未読数はラベルから取る', async () => {
    const fetchFn = fakeFetch({
      'https://gmail.googleapis.com/gmail/v1/users/me/labels/INBOX': {
        messagesUnread: 3,
      },
    });
    const client = createGmailClient({ accessToken: 'tok', fetchFn });
    expect(await client.getUnreadCount()).toBe(3);
  });

  it('401 は認証切れの日本語エラーにする（トークンは含めない）', async () => {
    const fetchFn = async () => {
      return { ok: false, status: 401, json: async () => ({}) } as never;
    };
    const client = createGmailClient({ accessToken: 'tok-secret', fetchFn });
    await expect(client.getUnreadCount()).rejects.toThrow('認証が切れ');
    await expect(client.getUnreadCount()).rejects.not.toThrow('tok-secret');
  });

  it('403 は利用が許可されていない日本語エラーにする', async () => {
    const fetchFn = async () => {
      return { ok: false, status: 403, json: async () => ({}) } as never;
    };
    const client = createGmailClient({ accessToken: 'tok', fetchFn });
    await expect(client.getUnreadCount()).rejects.toThrow('許可されていません');
  });

  it('通信できないときは接続エラーの日本語にする', async () => {
    const fetchFn = async () => {
      throw new Error('network down');
    };
    const client = createGmailClient({ accessToken: 'tok', fetchFn });
    await expect(client.getUnreadCount()).rejects.toThrow('接続できません');
  });

  it('アクセストークンが空なら作れない', () => {
    expect(() => createGmailClient({ accessToken: '', fetchFn: fakeFetch({}) })).toThrow(
      'アクセストークン',
    );
  });
});

describe('createMockGmailClient', () => {
  it('手元のデータだけで一覧と未読数を返す', async () => {
    const headers: GmailMessageHeader[] = [
      {
        id: 'm1',
        threadId: 't1',
        from: 'X <info@x.com>',
        subject: 'ロック警告',
        date: '',
        dateMs: null,
      },
    ];
    const client = createMockGmailClient({ headers, unreadCount: 2 });
    expect(await client.listHeaders({})).toEqual(headers);
    expect(await client.getUnreadCount()).toBe(2);
  });
});
