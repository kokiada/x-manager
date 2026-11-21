import { describe, expect, it } from 'vitest';
import {
  GRAPH_API_BASE,
  OUTLOOK_READ_SCOPE,
  buildOutlookListUrl,
  createMockOutlookClient,
  createOutlookClient,
  extractInboxUnreadCount,
  extractMessageHeaders,
  isXNotificationMail,
  parseOutlookMessageList,
} from './outlookApi';
import type { OutlookMessageHeader } from './outlookApi';

describe('Microsoft Graph の前提（3-3）', () => {
  it('読み取り専用の最小スコープだけを使う（書き込みスコープは含まない）', () => {
    expect(OUTLOOK_READ_SCOPE).toBe(
      'https://graph.microsoft.com/Mail.ReadBasic',
    );
    expect(OUTLOOK_READ_SCOPE).not.toContain('ReadWrite');
    expect(OUTLOOK_READ_SCOPE).not.toContain('Send');
  });

  it('API の基点は graph.microsoft.com/v1.0', () => {
    expect(GRAPH_API_BASE).toBe('https://graph.microsoft.com/v1.0');
  });
});

describe('buildOutlookListUrl', () => {
  it('受信トレイの新着一覧の URL を作る', () => {
    const url = buildOutlookListUrl({ maxResults: 10 });
    expect(url).toBe(
      'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?' +
        '%24select=id%2Cfrom%2Csubject%2CreceivedDateTime' +
        '&%24orderby=receivedDateTime+desc&%24top=10',
    );
  });

  it('未読だけのときは $filter=isRead eq false を付ける', () => {
    expect(buildOutlookListUrl({ unreadOnly: true })).toContain(
      '%24filter=isRead+eq+false',
    );
    expect(buildOutlookListUrl({})).not.toContain('%24filter');
  });

  it('maxResults は 1〜100 の範囲だけ受け付ける', () => {
    expect(() => buildOutlookListUrl({ maxResults: 0 })).toThrow('件数');
    expect(() => buildOutlookListUrl({ maxResults: 101 })).toThrow('件数');
    expect(buildOutlookListUrl({ maxResults: 1 })).toContain('%24top=1');
    expect(buildOutlookListUrl({ maxResults: 100 })).toContain('%24top=100');
  });
});

describe('parseOutlookMessageList', () => {
  it('一覧から ID と次ページのリンクを取り出す', () => {
    expect(
      parseOutlookMessageList({
        value: [{ id: 'a1' }, { id: 'a2' }],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next',
      }),
    ).toEqual({
      ids: ['a1', 'a2'],
      nextLink: 'https://graph.microsoft.com/v1.0/next',
    });
  });

  it('value が無ければ空の一覧になる', () => {
    expect(parseOutlookMessageList({})).toEqual({
      ids: [],
      nextLink: undefined,
    });
  });

  it('ID の無い項目は落とし、重複は1件にする', () => {
    expect(
      parseOutlookMessageList({
        value: [{ id: 'a1' }, {}, { id: '' }, { id: 'a1' }, { id: 'a2' }],
      }),
    ).toEqual({ ids: ['a1', 'a2'], nextLink: undefined });
  });

  it('一覧でない応答はエラーにする', () => {
    expect(() => parseOutlookMessageList(null)).toThrow('一覧');
    expect(() => parseOutlookMessageList('x')).toThrow('一覧');
    expect(() => parseOutlookMessageList({ value: 'x' })).toThrow('一覧');
  });
});

describe('extractMessageHeaders', () => {
  const base = (overrides: Record<string, unknown> = {}) => ({
    id: 'm1',
    from: {
      emailAddress: { name: 'X', address: 'info@x.com' },
    },
    subject: 'ログインのお知らせ',
    receivedDateTime: '2026-11-21T08:00:00+09:00',
    ...overrides,
  });

  it('From / Subject / receivedDateTime を取り出す', () => {
    const h = extractMessageHeaders(base());
    expect(h).toEqual({
      id: 'm1',
      from: 'X <info@x.com>',
      subject: 'ログインのお知らせ',
      date: '2026-11-21T08:00:00+09:00',
      dateMs: Date.parse('2026-11-21T08:00:00+09:00'),
    });
  });

  it('表示名が無ければアドレスだけ、無ければ空文字になる', () => {
    expect(
      extractMessageHeaders(
        base({ from: { emailAddress: { address: 'a@x.com' } } }),
      ).from,
    ).toBe('a@x.com');
    expect(extractMessageHeaders(base({ from: {} })).from).toBe('');
  });

  it('無い項目は空文字、日時は null になる', () => {
    expect(extractMessageHeaders({ id: 'm1' })).toEqual({
      id: 'm1',
      from: '',
      subject: '',
      date: '',
      dateMs: null,
    });
  });

  it('読めない日時は null にして、他のヘッダはそのまま返す', () => {
    const h = extractMessageHeaders(
      base({ receivedDateTime: 'not-a-date' }),
    );
    expect(h.dateMs).toBeNull();
    expect(h.from).toBe('X <info@x.com>');
  });

  it('ID の無いメッセージはエラーにする', () => {
    expect(() => extractMessageHeaders({})).toThrow('ID');
    expect(() => extractMessageHeaders(null)).toThrow('ID');
  });
});

describe('extractInboxUnreadCount', () => {
  it('受信トレイの未読数を返す', () => {
    expect(extractInboxUnreadCount({ unreadItemCount: 7 })).toBe(7);
    expect(extractInboxUnreadCount({ unreadItemCount: 0 })).toBe(0);
  });

  it('未読数が無い・負の値・数でない場合はエラーにする', () => {
    expect(() => extractInboxUnreadCount({})).toThrow('未読数');
    expect(() => extractInboxUnreadCount({ unreadItemCount: -1 })).toThrow(
      '未読数',
    );
    expect(() => extractInboxUnreadCount({ unreadItemCount: '3' })).toThrow(
      '未読数',
    );
  });
});

describe('isXNotificationMail', () => {
  const header = (from: string): OutlookMessageHeader => ({
    id: 'm1',
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
    expect(isXNotificationMail(header('Microsoft <no-reply@microsoft.com>')))
      .toBe(false);
    expect(isXNotificationMail(header(''))).toBe(false);
    expect(isXNotificationMail(header('x.com を騙る <a@evil-x.com>'))).toBe(
      false,
    );
  });
});

describe('createOutlookClient（モック fetch）', () => {
  const listBody = {
    value: [
      {
        id: 'm1',
        from: { emailAddress: { name: 'X', address: 'info@x.com' } },
        subject: '件名1',
        receivedDateTime: '2026-11-21T08:00:00+09:00',
      },
      {
        id: 'm2',
        from: { emailAddress: { name: 'X', address: 'info@x.com' } },
        subject: '件名2',
        receivedDateTime: '2026-11-21T07:00:00+09:00',
      },
    ],
  };

  function fakeFetch(responses: Record<string, unknown>) {
    return async (url: string) => {
      const body = responses[url];
      if (body === undefined) {
        return { ok: false, status: 404, json: async () => ({}) } as never;
      }
      return { ok: true, status: 200, json: async () => body } as never;
    };
  }

  it('一覧1回で新着ヘッダ一覧を返す（Gmail と違い個別取得は不要）', async () => {
    const fetchFn = fakeFetch({
      'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?%24select=id%2Cfrom%2Csubject%2CreceivedDateTime&%24orderby=receivedDateTime+desc&%24top=10':
        listBody,
    });
    const client = createOutlookClient({ accessToken: 'tok', fetchFn });
    const headers = await client.listHeaders({});
    expect(headers.map((h) => h.id)).toEqual(['m1', 'm2']);
    expect(headers[0].from).toBe('X <info@x.com>');
    expect(headers[0].subject).toBe('件名1');
  });

  it('未読数は受信トレイのフォルダから取る', async () => {
    const fetchFn = fakeFetch({
      'https://graph.microsoft.com/v1.0/me/mailFolders/inbox?%24select=unreadItemCount':
        { unreadItemCount: 5 },
    });
    const client = createOutlookClient({ accessToken: 'tok', fetchFn });
    expect(await client.getUnreadCount()).toBe(5);
  });

  it('401 は認証切れの日本語エラーにする（トークンは含めない）', async () => {
    const fetchFn = async () => {
      return { ok: false, status: 401, json: async () => ({}) } as never;
    };
    const client = createOutlookClient({ accessToken: 'tok-secret', fetchFn });
    await expect(client.getUnreadCount()).rejects.toThrow('認証が切れ');
    await expect(client.getUnreadCount()).rejects.not.toThrow('tok-secret');
  });

  it('403 は利用が許可されていない日本語エラーにする', async () => {
    const fetchFn = async () => {
      return { ok: false, status: 403, json: async () => ({}) } as never;
    };
    const client = createOutlookClient({ accessToken: 'tok', fetchFn });
    await expect(client.getUnreadCount()).rejects.toThrow('許可されていません');
  });

  it('通信できないときは接続エラーの日本語にする', async () => {
    const fetchFn = async () => {
      throw new Error('network down');
    };
    const client = createOutlookClient({ accessToken: 'tok', fetchFn });
    await expect(client.getUnreadCount()).rejects.toThrow('接続できません');
  });

  it('アクセストークンが空なら作れない', () => {
    expect(() => createOutlookClient({ accessToken: '', fetchFn: fakeFetch({}) })).toThrow(
      'アクセストークン',
    );
  });
});

describe('createMockOutlookClient', () => {
  it('手元のデータだけで一覧と未読数を返す', async () => {
    const headers: OutlookMessageHeader[] = [
      {
        id: 'm1',
        from: 'X <info@x.com>',
        subject: 'ロック警告',
        date: '',
        dateMs: null,
      },
    ];
    const client = createMockOutlookClient({ headers, unreadCount: 2 });
    expect(await client.listHeaders({})).toEqual(headers);
    expect(await client.getUnreadCount()).toBe(2);
  });
});
