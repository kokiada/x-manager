import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import type { AppSettings, CheckSchedule } from '../db/types';
import {
  DEFAULT_SETTINGS,
  INTERVAL_MAX_SEC,
  INTERVAL_MIN_SEC,
  PLAN_TIERS,
} from '../db/types';
import { getSettings, saveSettings } from '../db/repository';
import {
  checkExtensionConnection,
  setExecutorMode,
  type ExtensionConnection,
} from '../executor';
import { clearDemoData, isDemoAccount } from '../lib/demoData';
import { Button, useToast } from '../components/ui';

function ScheduleFields({
  legend,
  value,
  groups,
  onChange,
}: {
  legend: string;
  value: CheckSchedule;
  groups: { id: string; name: string }[];
  onChange: (next: CheckSchedule) => void;
}) {
  return (
    <div className="field">
      <label>{legend}</label>
      <div style={{ display: 'flex', gap: 'var(--sp-3)', flexWrap: 'wrap', alignItems: 'center' }}>
        <label className="radio-label">
          <input
            type="checkbox"
            checked={value.enabled}
            onChange={(e) => onChange({ ...value, enabled: e.target.checked })}
          />
          毎日実行する
        </label>
        <input
          type="time"
          value={value.time}
          disabled={!value.enabled}
          onChange={(e) => onChange({ ...value, time: e.target.value })}
          aria-label={`${legend}の開始時刻`}
          style={{ width: 130 }}
        />
        <select
          value={value.groupId ?? ''}
          disabled={!value.enabled}
          onChange={(e) => onChange({ ...value, groupId: e.target.value || null })}
          aria-label={`${legend}の対象グループ`}
          style={{ width: 'auto' }}
        >
          <option value="">全グループ</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
      </div>
      <div className="hint">アプリを開いている間だけ動作し、開始時刻を15分以上過ぎた回は見送ります。</div>
    </div>
  );
}

export function Settings() {
  const toast = useToast();
  const accountCount = useLiveQuery(() => db.accounts.count(), [], undefined);
  const groups = useLiveQuery(() => db.groups.orderBy('order').toArray(), [], []);
  const allAccounts = useLiveQuery(() => db.accounts.toArray(), [], undefined);
  const demoAccountCount = allAccounts?.filter(isDemoAccount).length ?? 0;

  const [form, setForm] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [extStatus, setExtStatus] = useState<ExtensionConnection | null>(null);
  const [checkingExt, setCheckingExt] = useState(false);
  const [confirmClearDemo, setConfirmClearDemo] = useState(false);
  const [clearingDemo, setClearingDemo] = useState(false);
  const initialized = useRef(false);

  const clearDemo = async () => {
    if (!confirmClearDemo) {
      setConfirmClearDemo(true);
      return;
    }
    setClearingDemo(true);
    try {
      const result = await clearDemoData();
      setConfirmClearDemo(false);
      toast.push(
        `デモデータを消去しました（アカウント ${result.accountsRemoved}件）`,
        'ok',
      );
    } catch {
      toast.push('デモデータの消去に失敗しました', 'err');
    } finally {
      setClearingDemo(false);
    }
  };

  const checkExtension = async () => {
    setCheckingExt(true);
    try {
      setExtStatus(await checkExtensionConnection());
    } finally {
      setCheckingExt(false);
    }
  };

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    getSettings()
      .then(setForm)
      .catch(() => setForm({ ...DEFAULT_SETTINGS }));
  }, []);

  if (!form || accountCount === undefined || groups === undefined) {
    return (
      <div>
        <div className="page-head">
          <div>
            <h1 className="page-title">
              <span className="page-no">10</span>設定
            </h1>
          </div>
        </div>
        <p className="faded">読み込み中…</p>
      </div>
    );
  }

  const overPlan = accountCount > form.planAccounts;
  const browsersClamped = Math.min(form.maxConcurrentBrowsers, form.planAccounts);

  const save = async () => {
    setSaving(true);
    try {
      await saveSettings({ ...form, maxConcurrentBrowsers: browsersClamped });
      setForm({ ...form, maxConcurrentBrowsers: browsersClamped });
      setExecutorMode(form.executorMode);
      toast.push('設定を保存しました', 'ok');
    } catch {
      toast.push('設定の保存に失敗しました', 'err');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">
            <span className="page-no">10</span>設定
          </h1>
          <p className="page-lede">契約プラン、ブラウザの同時保持数、投稿の既定値と定期チェックの設定。</p>
        </div>
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <Button variant="primary" onClick={save} disabled={saving}>
            {saving ? '保存中…' : '設定を保存'}
          </Button>
        </div>
      </div>

      <h2 className="section-title">契約プラン</h2>
      <p className="faded" style={{ fontSize: 13 }}>
        登録できるアカウント数の上限を決めるプランです。全プランで機能に差異はありません。
        現在 <strong>{accountCount}件</strong> のアカウントが登録されています。
      </p>
      {overPlan && (
        <ul className="note-list error">
          <li>
            登録数がプラン上限（{form.planAccounts}件）を超えています。アカウントを整理するか、上位プランを選択してください。
          </li>
        </ul>
      )}
      <div className="plan-list" role="radiogroup" aria-label="契約プラン">
        {PLAN_TIERS.map((tier) => (
          <label key={tier.accounts} className={`plan-row ${form.planAccounts === tier.accounts ? 'selected' : ''}`}>
            <input
              type="radio"
              name="plan"
              checked={form.planAccounts === tier.accounts}
              onChange={() => setForm({ ...form, planAccounts: tier.accounts })}
            />
            <span>
              <strong>{tier.accounts}</strong> アカウントまで
            </span>
            <span className="plan-price">¥{tier.monthlyPriceJpy.toLocaleString('ja-JP')} / 月</span>
          </label>
        ))}
      </div>

      <h2 className="section-title">実行方法（X連携）</h2>
      <p className="faded" style={{ fontSize: 13 }}>
        投稿やチェックをどこで実行するかを選びます。「シミュレータ」は本物のXには届かない見本の動きです。
        「拡張」は Chrome 拡張「x-manager 実行役」に実際の操作を任せます（拡張の読み込みとアカウントの
        auth_token 登録は、拡張のポップアップで行います。詳しくは <code>extension/README.md</code>）。
      </p>
      <div className="plan-list" role="radiogroup" aria-label="実行方法">
        <label className={`plan-row ${form.executorMode === 'simulator' ? 'selected' : ''}`}>
          <input
            type="radio"
            name="executor-mode"
            checked={form.executorMode === 'simulator'}
            onChange={() => setForm({ ...form, executorMode: 'simulator' })}
          />
          <span>
            <strong>シミュレータ</strong>（既定）
          </span>
          <span className="faded" style={{ fontSize: 12.5 }}>
            本物のXには届きません
          </span>
        </label>
        <label className={`plan-row ${form.executorMode === 'extension' ? 'selected' : ''}`}>
          <input
            type="radio"
            name="executor-mode"
            checked={form.executorMode === 'extension'}
            onChange={() => setForm({ ...form, executorMode: 'extension' })}
          />
          <span>
            <strong>Chrome 拡張</strong>（実X操作）
          </span>
          <span className="faded" style={{ fontSize: 12.5 }}>
            拡張が未接続のとき操作は失敗します
          </span>
        </label>
      </div>
      <div className="field">
        <label>拡張の接続状態</label>
        <p className="faded" style={{ fontSize: 13, margin: '4px 0 8px' }}>
          {extStatus === null
            ? 'まだ確認していません。'
            : extStatus.connected
              ? `接続済み（拡張 v${extStatus.extensionVersion}、連携アカウント ${extStatus.linkedAccountIds?.length ?? 0}件）`
              : `未接続 — ${extStatus.error ?? '拡張が見つかりません'}`}
        </p>
        <Button onClick={checkExtension} disabled={checkingExt}>
          {checkingExt ? '確認中…' : '接続を確認'}
        </Button>
        <div className="hint">
          拡張を読み込んだ Chrome でこのアプリを開いているときに確認できます。拡張が未接続のまま「拡張」を選んで保存すると、操作はエラーになります（シミュレータには戻りません）。
        </div>
      </div>

      <h2 className="section-title">デモデータ</h2>
      <p className="faded" style={{ fontSize: 13 }}>
        初回起動時に入る見本のアカウント・グループ・テンプレートなどを消去します。
        自分で追加したアカウントやデータは残ります。消去後は、空の状態でもデモデータは
        再表示されません。
        {demoAccountCount > 0
          ? ` 現在、デモアカウントが ${demoAccountCount}件 あります。`
          : ' 現在、デモデータはありません。'}
      </p>
      <Button
        variant={confirmClearDemo ? 'danger' : 'default'}
        onClick={clearDemo}
        disabled={clearingDemo || demoAccountCount === 0}
      >
        {clearingDemo
          ? '消去中…'
          : confirmClearDemo
            ? '本当に消去しますか？（もう一度押すと実行）'
            : 'デモデータを消去'}
      </Button>
      {confirmClearDemo && (
        <p className="faded" style={{ fontSize: 12.5, marginTop: 8 }}>
          デモアカウントと、それに紐づく履歴（チェック結果・フォロワー推移・通知など）も
          一緒に消えます。この操作は戻せません。
        </p>
      )}

      <h2 className="section-title">ブラウザ</h2>
      <div className="field">
        <label htmlFor="max-browsers">同時に開いておくブラウザ数</label>
        <input
          id="max-browsers"
          type="number"
          min={1}
          max={form.planAccounts}
          value={form.maxConcurrentBrowsers}
          onChange={(e) =>
            setForm({ ...form, maxConcurrentBrowsers: Math.max(1, Number(e.target.value) || 1) })
          }
          style={{ width: 130 }}
        />
        <div className="hint">
          契約プランのアカウント数（{form.planAccounts}）より大きい値は選べません。上限を超える分は最も長く使っていないアカウントのブラウザから閉じられます。
          {form.maxConcurrentBrowsers > form.planAccounts &&
            ` 現在の入力は上限に合わせて ${browsersClamped} として保存されます。`}
        </div>
      </div>

      <h2 className="section-title">投稿</h2>
      <div className="field">
        <label htmlFor="default-interval">一括投稿の既定の投稿間隔（秒）</label>
        <input
          id="default-interval"
          type="number"
          min={INTERVAL_MIN_SEC}
          max={INTERVAL_MAX_SEC}
          value={form.defaultIntervalSec}
          onChange={(e) =>
            setForm({
              ...form,
              defaultIntervalSec: Math.min(
                INTERVAL_MAX_SEC,
                Math.max(INTERVAL_MIN_SEC, Number(e.target.value) || INTERVAL_MIN_SEC),
              ),
            })
          }
          style={{ width: 130 }}
        />
        <div className="hint">一括投稿画面の投稿間隔の初期値として使われます（{INTERVAL_MIN_SEC}〜{INTERVAL_MAX_SEC}秒）。</div>
      </div>

      <h2 className="section-title">定期チェック</h2>
      <ScheduleFields
        legend="アカウントチェック（状態・通知/DM件数・フォロワー数）"
        value={form.accountCheck}
        groups={groups}
        onChange={(accountCheck) => setForm({ ...form, accountCheck })}
      />
      <ScheduleFields
        legend="サーチバンチェック"
        value={form.searchBanCheck}
        groups={groups}
        onChange={(searchBanCheck) => setForm({ ...form, searchBanCheck })}
      />
      <p className="dim" style={{ fontSize: 12 }}>
        定期チェックはアプリを開いている間に実行されます。開始時刻を15分以上過ぎた回は見送ります。
        実行状況はバンチェック画面の履歴でも確認できます。
      </p>

      <div className="toolbar">
        <span className="spacer" />
        <Button variant="primary" onClick={save} disabled={saving}>
          {saving ? '保存中…' : '設定を保存'}
        </Button>
      </div>
    </div>
  );
}
