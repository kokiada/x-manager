/**
 * 拡張の連携セッションをアプリの台帳へ取り込むための純粋関数。
 *
 * 背景：拡張のポップアップで連携しただけでは、アプリの IndexedDB
 * にはアカウントが増えない（拡張の保管庫とアプリの台帳は別物）。
 * 利用者は「連携したのに一覧に出ない」と感じるので、アカウント画面の
 * 「拡張の連携を取り込む」ボタンが、この関数で作った計画どおりに
 * 台帳へ追加する。DB への書き込み自体は呼び出し側が行う。
 */
import type { ExtensionSession } from '../executor/protocol';

/** 取り込みで作るアカウント1件分の情報。 */
export interface SessionAccountToCreate {
  /** 拡張のセッションキーと同じIDにする（連携バッジが付くため）。 */
  accountId: string;
  /** Xハンドル（@なし）。 */
  handle: string;
}

export interface SessionImportPlan {
  /** 新規に作るアカウント（ハンドル付きのセッションのみ）。 */
  toCreate: SessionAccountToCreate[];
  /**
   * ハンドルが無いセッションのID。呼び出し側が拡張の
   * resolveAccountIdentity で本物のハンドルを解決してから作る。
   * 仮ハンドルは作らない（2026-11-22 の 1-2 で `linked-…` の仮ハンドルが
   * 台帳に入り、そのハンドルはX上に存在しないためチェックが必ず失敗した）。
   * 解決できなければ作らない。
   */
  needsHandle: string[];
  /** すでに台帳にある（＝連携済みの）セッションの件数。 */
  alreadyLinked: number;
}

/** 過去の取り込みで付けられた仮ハンドルかどうか。 */
export function isPlaceholderHandle(handle: string): boolean {
  return handle.startsWith('linked-');
}

/**
 * 連携セッションと台帳の既存IDから取り込み計画を作る。
 * - 台帳に無いIDのセッションだけ作る（重複IDは最初の1件だけ）
 * - IDが空のセッションは取り込めないので落とす
 * - ハンドルが無いセッションは仮ハンドルで作らず needsHandle に回す。
 *   呼び出し側が拡張に本人確認して本物のハンドルで作る
 */
export function planSessionImport(
  sessions: readonly ExtensionSession[],
  existingIds: Iterable<string>,
): SessionImportPlan {
  const existing = new Set(existingIds);
  const seen = new Set<string>();
  const toCreate: SessionAccountToCreate[] = [];
  const needsHandle: string[] = [];
  let alreadyLinked = 0;

  for (const session of sessions) {
    const accountId = session.accountId;
    if (typeof accountId !== 'string' || accountId.length === 0) continue;
    if (seen.has(accountId)) continue;
    seen.add(accountId);
    if (existing.has(accountId)) {
      alreadyLinked += 1;
      continue;
    }
    const handle =
      typeof session.handle === 'string' && session.handle.trim().length > 0
        ? session.handle.replace(/^@/, '').trim()
        : null;
    if (handle) {
      toCreate.push({ accountId, handle });
    } else {
      needsHandle.push(accountId);
    }
  }

  return { toCreate, needsHandle, alreadyLinked };
}
