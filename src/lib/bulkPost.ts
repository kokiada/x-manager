import type { ComposePayload, MediaMeta } from '../db/types';
import { MEDIA_SELECT_MAX, RESERVATION_MIN_LEAD_MS } from '../db/types';
import type { PostContent } from '../executor/Executor';
import { pickMediaForPost } from './media';

/**
 * Pure helpers around ComposePayload: turning a payload into the
 * Executor's PostContent, validating a compose form, and the
 * X-style weighted character count.
 */

/** X counts every URL as 23 characters regardless of its length. */
export const URL_WEIGHT = 23;
export const POST_CHAR_LIMIT = 280;

const URL_RE = /https?:\/\/[^\s]+/g;

/**
 * Weighted length, X-style: URLs count as 23; characters in the
 * CJK / fullwidth ranges count as 2; everything else counts as 1.
 */
export function weightedLength(text: string): number {
  let total = 0;
  const withoutUrls = text.replace(URL_RE, () => {
    total += URL_WEIGHT;
    return '';
  });
  for (const ch of withoutUrls) {
    const cp = ch.codePointAt(0) ?? 0;
    const wide =
      (cp >= 0x1100 && cp <= 0x11ff) || // Hangul jamo
      (cp >= 0x2e80 && cp <= 0x9fff) || // CJK radicals … ideographs
      (cp >= 0xa000 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
      (cp >= 0x20000 && cp <= 0x2fffd) ||
      (cp >= 0x30000 && cp <= 0x3fffd);
    total += wide ? 2 : 1;
  }
  return total;
}

/**
 * Build the Executor call for one account from the payload and the
 * already random-expanded segments. Media attachment is decided here
 * (per post), so 'random' mode gives each account a different set.
 * Media attached to segment 1 only — tree continuations carry their
 * own text (research §6-2 allows media-only continuations; M2 keeps
 * media on the first post and notes it here).
 */
export function buildPostContent(
  payload: ComposePayload,
  expandedSegments: readonly string[],
  rng: () => number = Math.random,
): { content: PostContent; attached: MediaMeta[] } {
  const attached =
    payload.poll && payload.poll.choices.length > 0
      ? []
      : pickMediaForPost(payload.media, payload.mediaMode, payload.mediaRandomCount, rng);
  const [first, ...rest] = expandedSegments;
  const content: PostContent = {
    text: first ?? '',
    targetType: payload.targetType,
    replyToUrl: payload.targetType === 'reply' ? payload.replyToUrl : undefined,
    communityId: payload.targetType === 'community' ? payload.communityId : undefined,
    mediaCount: attached.length,
    threadTexts: rest.length > 0 ? [...rest] : undefined,
    // Reply permission applies to normal posts only (§6-4).
    replyPermission: payload.targetType === 'normal' ? payload.replyPermission : undefined,
    paidPartnership: payload.paidPartnership || undefined,
  };
  return { content, attached };
}

export interface ComposeValidation {
  errors: string[];
  warnings: string[];
}

/**
 * Validate a compose payload before running or reserving it.
 * `forReservation` applies the extra §6-5 rules (no poll, no
 * community target, at least 5 minutes in the future).
 */
export function validateCompose(
  payload: ComposePayload,
  opts: { accountCount: number; forReservation?: boolean; scheduledAt?: number; now?: number },
): ComposeValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const now = opts.now ?? Date.now();

  if (opts.accountCount === 0) errors.push('対象アカウントが選択されていません');

  const first = (payload.segments[0] ?? '').trim();
  const hasMedia = payload.media.length > 0;
  const hasPoll = !!payload.poll && payload.poll.choices.some((c) => c.trim() !== '');
  if (!first && !hasMedia && !hasPoll) {
    errors.push('本文が空です（メディアかアンケートを付ける場合は省略できます）');
  }
  payload.segments.forEach((seg, i) => {
    if (weightedLength(seg) > POST_CHAR_LIMIT) {
      errors.push(
        `${i === 0 ? '本文' : `ツリーの続き ${i}`}が${POST_CHAR_LIMIT}文字を超えています（${weightedLength(seg)}文字）`,
      );
    }
  });

  if (payload.targetType === 'reply' && !payload.replyToUrl?.trim()) {
    errors.push('リプライ投稿には対象ポストのURL（またはID）が必要です');
  }
  if (payload.targetType === 'community' && !payload.communityId?.trim()) {
    errors.push('コミュニティ投稿にはコミュニティIDが必要です');
  }

  if (payload.media.length > MEDIA_SELECT_MAX) {
    errors.push(`メディアは最大${MEDIA_SELECT_MAX}件まで選択できます`);
  }
  if (hasMedia && hasPoll) {
    errors.push('アンケートは画像・動画と同時に付けられません（Xの仕様）');
  }
  if (payload.poll) {
    const choices = payload.poll.choices.map((c) => c.trim()).filter(Boolean);
    if (choices.length < 2) errors.push('アンケートの選択肢は2つ以上必要です');
    if (choices.length > 4) errors.push('アンケートの選択肢は4つまでです');
  }

  if (payload.replyPermission !== 'everyone' && payload.targetType !== 'normal') {
    warnings.push('返信できるアカウントの設定は通常投稿でのみ使われます');
  }

  if (opts.forReservation) {
    if (hasPoll) errors.push('予約投稿ではアンケートは使えません（Xの仕様）');
    if (payload.targetType === 'community') {
      errors.push('予約投稿ではコミュニティ投稿は使えません（Xの仕様）');
    }
    if (opts.scheduledAt !== undefined && opts.scheduledAt - now < RESERVATION_MIN_LEAD_MS) {
      errors.push('予約日時は現在から5分以上先を指定してください');
    }
  }

  return { errors, warnings };
}

/** An empty compose payload for form initial state. */
export function emptyPayload(): ComposePayload {
  return {
    segments: [''],
    targetType: 'normal',
    media: [],
    mediaMode: 'all',
    poll: null,
    replyPermission: 'everyone',
    paidPartnership: false,
  };
}
