import type { PollData } from '../../db/types';
import { Button } from '../ui';

/**
 * Poll (アンケート) editor: 2–4 choices. A poll cannot be combined
 * with media (X spec, research §6-1) — callers disable one when the
 * other is in use.
 */
export function PollEditor({
  value,
  onChange,
  disabled,
}: {
  value: PollData | null;
  onChange: (poll: PollData | null) => void;
  disabled?: boolean;
}) {
  if (!value) {
    return (
      <Button small onClick={() => onChange({ choices: ['', ''] })} disabled={disabled}>
        ＋ アンケートを追加
      </Button>
    );
  }
  const setChoice = (i: number, text: string) => {
    const choices = [...value.choices];
    choices[i] = text;
    onChange({ choices });
  };
  return (
    <div>
      {value.choices.map((choice, i) => (
        <div key={i} className="poll-row">
          <span className="mono dim" style={{ fontSize: 12 }}>
            {i + 1}
          </span>
          <input
            type="text"
            value={choice}
            maxLength={25}
            placeholder={`選択肢 ${i + 1}`}
            onChange={(e) => setChoice(i, e.target.value)}
            aria-label={`選択肢 ${i + 1}`}
          />
          <Button
            small
            variant="ghost"
            disabled={value.choices.length <= 2}
            onClick={() => onChange({ choices: value.choices.filter((_, j) => j !== i) })}
            aria-label={`選択肢 ${i + 1}を削除`}
          >
            ✕
          </Button>
        </div>
      ))}
      <div className="toolbar" style={{ marginTop: 6 }}>
        <Button
          small
          disabled={value.choices.length >= 4}
          onClick={() => onChange({ choices: [...value.choices, ''] })}
        >
          選択肢を追加（最大4）
        </Button>
        <Button small variant="ghost" onClick={() => onChange(null)}>
          アンケートを外す
        </Button>
      </div>
    </div>
  );
}
