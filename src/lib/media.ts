import type { MediaMeta } from '../db/types';
import { MEDIA_PER_POST_MAX } from '../db/types';

/**
 * Media selection rules for bulk posting (research §6-1):
 * - up to 200 files may be selected; at most 20 attach to one post
 * - images: png / jpg / gif / webp; videos: mp4 / mov
 * - an image over 5MB may fail to post (warning)
 * - a video is at most 140 seconds and 512MB (duration checked when
 *   the browser could read it from the picked file)
 * - "ランダムにN件" picks N of the selected files at random per post
 */

export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp'] as const;
export const VIDEO_EXTS = ['mp4', 'mov'] as const;
export const IMAGE_WARN_BYTES = 5 * 1024 * 1024;
export const VIDEO_MAX_BYTES = 512 * 1024 * 1024;
export const VIDEO_MAX_SECONDS = 140;

export interface MediaCheck {
  ok: boolean;
  kind: 'image' | 'video' | null;
  /** Problems that should block using the file. */
  errors: string[];
  /** Problems worth showing but not blocking. */
  warnings: string[];
}

const extOf = (name: string) => {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1].toLowerCase() : '';
};

/** Classify and validate one picked file's metadata. */
export function checkMedia(meta: Pick<MediaMeta, 'name' | 'size' | 'durationSec'>): MediaCheck {
  const ext = extOf(meta.name);
  const errors: string[] = [];
  const warnings: string[] = [];
  let kind: 'image' | 'video' | null = null;

  if ((IMAGE_EXTS as readonly string[]).includes(ext)) kind = 'image';
  else if ((VIDEO_EXTS as readonly string[]).includes(ext)) kind = 'video';
  else errors.push(`対応形式ではありません（${ext || '拡張子なし'}）: ${meta.name}`);

  if (kind === 'image' && meta.size > IMAGE_WARN_BYTES) {
    warnings.push(`画像が5MBを超えています（投稿に失敗することがあります）: ${meta.name}`);
  }
  if (kind === 'video') {
    if (meta.size > VIDEO_MAX_BYTES) {
      errors.push(`動画が512MBを超えています: ${meta.name}`);
    }
    if (meta.durationSec !== undefined && meta.durationSec > VIDEO_MAX_SECONDS) {
      errors.push(`動画が140秒を超えています（${Math.round(meta.durationSec)}秒）: ${meta.name}`);
    }
  }
  return { ok: errors.length === 0, kind, errors, warnings };
}

/**
 * Choose which of the selected media attach to one post.
 * - mode 'all': the first items in selection order, capped at 20.
 * - mode 'random': `count` items picked at random (each post differs),
 *   also capped at 20. Order of the result follows the pick order.
 * `rng` is injectable for deterministic tests; must return [0, 1).
 */
export function pickMediaForPost<T>(
  items: readonly T[],
  mode: 'all' | 'random',
  randomCount: number | undefined,
  rng: () => number = Math.random,
): T[] {
  if (mode === 'all') return items.slice(0, MEDIA_PER_POST_MAX);
  const want = Math.max(0, Math.min(randomCount ?? 0, MEDIA_PER_POST_MAX, items.length));
  const pool = [...items];
  const picked: T[] = [];
  for (let n = 0; n < want && pool.length > 0; n++) {
    const idx = Math.min(pool.length - 1, Math.floor(rng() * pool.length));
    picked.push(pool.splice(idx, 1)[0]);
  }
  return picked;
}

/** Human-readable byte size for media lists. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${bytes}B`;
}

/**
 * File/Blob を base64 文字列にする（data: URL の接頭辞なし）。
 * btoa は一度に大きな文字列を渡すと落ちることがあるため、
 * 32KB ずつに切って変換する。
 */
export async function fileToBase64(file: Blob): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) {
    binary += String.fromCharCode(...bytes.subarray(i, i + STEP));
  }
  return btoa(binary);
}
