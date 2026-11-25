import { useRef, useState } from 'react';
import type { MediaMeta } from '../../db/types';
import { MEDIA_PER_POST_MAX, MEDIA_SELECT_MAX } from '../../db/types';
import { checkMedia, formatBytes } from '../../lib/media';
import { Button } from '../ui';

/**
 * One selected media item. `url` is a session-only object URL for
 * preview; `file` is the picked File object itself (session-only,
 * never persisted — templates, jobs and reservations store the
 * metadata only). Template-applied media has no `file`, so its bytes
 * cannot be posted; the runner reports that clearly instead of
 * pretending the post went through.
 */
export interface SelectedMedia {
  meta: MediaMeta;
  url?: string;
  file?: File;
}

async function probeVideoDuration(file: File): Promise<number | undefined> {
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<number | undefined>((resolve) => {
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.onloadedmetadata = () => resolve(Number.isFinite(v.duration) ? v.duration : undefined);
      v.onerror = () => resolve(undefined);
      v.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function MediaPicker({
  value,
  onChange,
  mode,
  onModeChange,
  randomCount,
  onRandomCountChange,
  disabled,
  disabledReason,
}: {
  value: SelectedMedia[];
  onChange: (next: SelectedMedia[]) => void;
  mode: 'all' | 'random';
  onModeChange: (mode: 'all' | 'random') => void;
  randomCount: number;
  onRandomCountChange: (n: number) => void;
  disabled?: boolean;
  /** Shown instead of the picker when disabled (e.g. poll is on). */
  disabledReason?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [messages, setMessages] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const handleFiles = async (files: FileList | null) => {
    if (!files) return;
    setBusy(true);
    const notes: string[] = [];
    const added: SelectedMedia[] = [];
    for (const file of [...files]) {
      if (value.length + added.length >= MEDIA_SELECT_MAX) {
        notes.push(`メディアは最大${MEDIA_SELECT_MAX}件までです`);
        break;
      }
      const durationSec = file.type.startsWith('video') ? await probeVideoDuration(file) : undefined;
      const check = checkMedia({ name: file.name, size: file.size, durationSec });
      notes.push(...check.errors, ...check.warnings);
      if (!check.ok || !check.kind) continue;
      added.push({
        meta: { name: file.name, kind: check.kind, mime: file.type, size: file.size, durationSec },
        url: URL.createObjectURL(file),
        file,
      });
    }
    setMessages(notes);
    if (added.length > 0) onChange([...value, ...added]);
    setBusy(false);
    if (inputRef.current) inputRef.current.value = '';
  };

  const remove = (index: number) => {
    const item = value[index];
    if (item.url) URL.revokeObjectURL(item.url);
    onChange(value.filter((_, i) => i !== index));
  };

  if (disabled) {
    return (
      <p className="faded" style={{ fontSize: 13 }}>
        {disabledReason ?? 'メディアは現在使用できません。'}
      </p>
    );
  }

  return (
    <div>
      <div className="toolbar" style={{ marginBottom: 8 }}>
        <Button small onClick={() => inputRef.current?.click()} disabled={busy}>
          {busy ? '読み込み中…' : '画像・動画を選ぶ'}
        </Button>
        <span className="faded" style={{ fontSize: 12.5 }}>
          {value.length} / {MEDIA_SELECT_MAX}件（1ポスト最大{MEDIA_PER_POST_MAX}件）
        </span>
        <input
          ref={inputRef}
          type="file"
          accept=".png,.jpg,.jpeg,.gif,.webp,.mp4,.mov"
          multiple
          hidden
          onChange={(e) => void handleFiles(e.target.files)}
        />
      </div>

      {messages.length > 0 && (
        <ul className="note-list">
          {messages.map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ul>
      )}

      {value.length > 0 && (
        <>
          <div className="media-chips">
            {value.map((item, i) => (
              <span key={`${item.meta.name}-${i}`} className="media-chip">
                {item.url && item.meta.kind === 'image' ? (
                  <img src={item.url} alt="" className="media-thumb" />
                ) : (
                  <span className="media-thumb media-thumb-icon">{item.meta.kind === 'video' ? '▶' : '▦'}</span>
                )}
                <span className="media-chip-name">
                  {item.meta.name}
                  <span className="dim mono" style={{ fontSize: 10.5 }}>
                    {' '}
                    {formatBytes(item.meta.size)}
                    {item.meta.durationSec !== undefined && ` / ${Math.round(item.meta.durationSec)}秒`}
                    {!item.url && '（名前のみ）'}
                  </span>
                </span>
                <button type="button" className="chip-x" onClick={() => remove(i)} aria-label={`${item.meta.name}を外す`}>
                  ✕
                </button>
              </span>
            ))}
          </div>
          <div className="toolbar" style={{ marginTop: 8 }}>
            <label className="radio-label">
              <input type="radio" checked={mode === 'all'} onChange={() => onModeChange('all')} />
              並び順に付ける（最大{MEDIA_PER_POST_MAX}件）
            </label>
            <label className="radio-label">
              <input type="radio" checked={mode === 'random'} onChange={() => onModeChange('random')} />
              ランダムに
              <input
                type="number"
                className="inline-num"
                min={1}
                max={MEDIA_PER_POST_MAX}
                value={randomCount}
                disabled={mode !== 'random'}
                onChange={(e) => onRandomCountChange(Number(e.target.value))}
                aria-label="ランダムに付ける件数"
              />
              件（投稿ごとに選択）
            </label>
          </div>
        </>
      )}
    </div>
  );
}
