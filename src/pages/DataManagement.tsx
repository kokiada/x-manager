import { useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import {
  applyAccountCsvPlan,
  exportAllTables,
  mergeGroupTables,
  replaceAllTables,
} from '../db/repository';
import {
  accountsToCsv,
  decodeCsvBytes,
  parseAccountCsv,
  planAccountCsvImport,
  type AccountCsvPlan,
} from '../lib/accountCsv';
import {
  backupCounts,
  buildGroupSubset,
  decryptBackup,
  encryptBackup,
  validateBackupPassword,
  type BackupPayload,
} from '../lib/backup';
import { downloadTextFile } from '../lib/csv';
import { checkedAtLabel } from '../lib/format';
import { Button, PlainBadge, Tooltip, useToast } from '../components/ui';

function fileStamp(): string {
  const d = new Date();
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

const COUNT_LABELS: Record<string, string> = {
  groups: 'グループ',
  proxyGroups: 'プロキシグループ',
  accounts: 'アカウント',
  templateGroups: 'テンプレートグループ',
  templates: 'テンプレート',
  randomWordSets: 'ランダム文言',
  postJobs: '投稿ジョブ履歴',
  reservations: '予約投稿',
};

export function DataManagement() {
  const toast = useToast();

  const accounts = useLiveQuery(() => db.accounts.toArray(), [], undefined);
  const groups = useLiveQuery(() => db.groups.orderBy('order').toArray(), [], undefined);
  const proxyGroups = useLiveQuery(() => db.proxyGroups.toArray(), [], undefined);

  /* --------------------------- account CSV --------------------------- */
  const csvFileRef = useRef<HTMLInputElement>(null);
  const [csvPlan, setCsvPlan] = useState<AccountCsvPlan | null>(null);
  const [csvError, setCsvError] = useState<string | null>(null);
  const [applyingCsv, setApplyingCsv] = useState(false);

  const exportAccountCsv = () => {
    if (!accounts || !groups || !proxyGroups) return;
    downloadTextFile(`accounts-${fileStamp()}.csv`, accountsToCsv(accounts, groups, proxyGroups));
    toast.push('アカウントCSVを書き出しました', 'ok');
  };

  const onCsvFile = async (file: File) => {
    setCsvError(null);
    setCsvPlan(null);
    if (!accounts || !groups || !proxyGroups) return;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const rows = parseAccountCsv(decodeCsvBytes(bytes));
      if (rows.length === 0) {
        setCsvError('CSVにデータ行がありません');
        return;
      }
      setCsvPlan(planAccountCsvImport(rows, { accounts, groups, proxyGroups }));
    } catch (e) {
      setCsvError(e instanceof Error ? e.message : 'CSVの読み取りに失敗しました');
    }
  };

  const applyCsv = async () => {
    if (!csvPlan) return;
    setApplyingCsv(true);
    try {
      await applyAccountCsvPlan(csvPlan);
      const created = csvPlan.results.filter((r) => r.status === 'created').length;
      const updated = csvPlan.results.filter((r) => r.status === 'updated').length;
      toast.push(`CSVを取り込みました（新規 ${created}件 / 更新 ${updated}件）`, 'ok');
      setCsvPlan(null);
      if (csvFileRef.current) csvFileRef.current.value = '';
    } catch {
      toast.push('CSVの適用に失敗しました', 'err');
    } finally {
      setApplyingCsv(false);
    }
  };

  /* ----------------------------- backup ------------------------------ */
  const [exportPassword, setExportPassword] = useState('');
  const [exportGroupId, setExportGroupId] = useState('');
  const [importPassword, setImportPassword] = useState('');
  const [pendingRestore, setPendingRestore] = useState<BackupPayload | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const backupFileRef = useRef<HTMLInputElement>(null);

  const runExport = async (kind: 'full' | 'group') => {
    const invalid = validateBackupPassword(exportPassword);
    if (invalid) {
      toast.push(invalid, 'err');
      return;
    }
    setBusy(true);
    try {
      const tables = await exportAllTables();
      let payload: BackupPayload;
      let filename: string;
      if (kind === 'full') {
        payload = { format: 'x-manager-data', version: 1, kind, exportedAt: Date.now(), tables };
        filename = `x-manager-backup-${fileStamp()}.json`;
      } else {
        const group = (groups ?? []).find((g) => g.id === exportGroupId);
        if (!group) {
          toast.push('グループを選択してください', 'err');
          return;
        }
        payload = {
          format: 'x-manager-data',
          version: 1,
          kind,
          groupId: group.id,
          groupName: group.name,
          exportedAt: Date.now(),
          tables: buildGroupSubset(tables, group.id),
        };
        filename = `x-manager-group-${fileStamp()}.json`;
      }
      const text = await encryptBackup(payload, exportPassword);
      downloadTextFile(filename, text, 'application/json');
      toast.push('暗号化バックアップを書き出しました', 'ok');
    } catch (e) {
      toast.push(e instanceof Error ? e.message : 'バックアップの作成に失敗しました', 'err');
    } finally {
      setBusy(false);
    }
  };

  const onBackupFile = async (file: File) => {
    setRestoreError(null);
    setPendingRestore(null);
    if (!importPassword) {
      setRestoreError('先に復元用パスワードを入力してください');
      return;
    }
    try {
      const text = await file.text();
      setPendingRestore(await decryptBackup(text, importPassword));
    } catch (e) {
      setRestoreError(e instanceof Error ? e.message : 'バックアップを読み取れませんでした');
    }
  };

  const applyRestore = async () => {
    if (!pendingRestore) return;
    setBusy(true);
    try {
      if (pendingRestore.kind === 'full') {
        await replaceAllTables(pendingRestore.tables);
        toast.push('バックアップを復元しました。再読み込みします', 'ok');
        setPendingRestore(null);
        setTimeout(() => window.location.reload(), 900);
      } else {
        const result = await mergeGroupTables(pendingRestore.tables);
        toast.push(
          `グループを取り込みました（アカウント追加 ${result.addedAccounts}件 / 既存スキップ ${result.skippedAccounts}件）`,
          'ok',
        );
        setPendingRestore(null);
        if (backupFileRef.current) backupFileRef.current.value = '';
      }
    } catch {
      toast.push('復元に失敗しました', 'err');
    } finally {
      setBusy(false);
    }
  };

  const loading = accounts === undefined || groups === undefined || proxyGroups === undefined;
  const csvSummary = csvPlan
    ? {
        created: csvPlan.results.filter((r) => r.status === 'created').length,
        updated: csvPlan.results.filter((r) => r.status === 'updated').length,
        skipped: csvPlan.results.filter((r) => r.status === 'skipped').length,
      }
    : null;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">
            <span className="page-no">09</span>データ管理
            <Tooltip label="データは端末内にのみ保存され、サーバーへは送信されません。">
              <span aria-hidden="true">？</span>
            </Tooltip>
          </h1>
        </div>
      </div>

      {loading && <p className="faded">読み込み中…</p>}

      {!loading && (
        <>
          <h2 className="section-title">
            アカウントCSV（グループ・アカウント整理）{' '}
            <Tooltip label="書出はUTF-8（BOM付き）、取込はUTF-8とShift_JISに対応します。">
              <span aria-hidden="true">？</span>
            </Tooltip>
          </h2>
          <ul className="note-list">
            <li>見出し行を変更したCSVは取り込めません。</li>
            <li>
              ログイン情報・AuthToken・プロキシ・メモの列は<strong>新規アカウントの行だけ</strong>に適用されます。既存アカウントの行に入力するとその行はエラーになります。
            </li>
            <li>CSVではアカウントを削除できません。書き出されるCSVにはパスワードやAuthTokenが平文で含まれます。取り扱いに注意してください。</li>
          </ul>
          <div className="toolbar">
            <Button onClick={exportAccountCsv} disabled={!accounts || accounts.length === 0}>
              CSVを書き出す
            </Button>
            <label className="btn" style={{ cursor: 'pointer' }}>
              CSVを取り込む
              <input
                ref={csvFileRef}
                type="file"
                accept=".csv,text/csv"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onCsvFile(f);
                }}
              />
            </label>
          </div>

          {csvError && (
            <ul className="note-list error">
              <li>{csvError}</li>
            </ul>
          )}

          {csvPlan && csvSummary && (
            <div style={{ marginBottom: 'var(--sp-5)' }}>
              <div className="preview-box" style={{ marginBottom: 'var(--sp-3)' }}>
                取込プレビュー: 新規作成 {csvSummary.created}件 / 更新 {csvSummary.updated}件 / スキップ {csvSummary.skipped}件
                {csvPlan.newGroupNames.length > 0 && (
                  <>
                    <br />
                    新規グループ: {csvPlan.newGroupNames.join('、')}
                  </>
                )}
                {csvPlan.groupRenames.length > 0 && (
                  <>
                    <br />
                    グループ改名: {csvPlan.groupRenames.map((r) => r.name).join('、')}
                  </>
                )}
                <div style={{ marginTop: 'var(--sp-3)' }}>
                  <Button variant="primary" onClick={applyCsv} disabled={applyingCsv}>
                    {applyingCsv ? '適用中…' : 'この内容で適用する'}
                  </Button>{' '}
                  <Button variant="ghost" onClick={() => setCsvPlan(null)} disabled={applyingCsv}>
                    やめる
                  </Button>
                </div>
              </div>
              <div className="ledger-simple">
                {csvPlan.results.map((r) => (
                  <div key={r.line} className="simple-row">
                    <span className="mono faded" style={{ fontSize: 12 }}>{r.line}行目</span>
                    <span className={`badge rs-${r.status}`}>
                      {r.status === 'created' ? '新規' : r.status === 'updated' ? '更新' : 'スキップ'}
                    </span>
                    <span className="pick-main" style={{ fontSize: 13 }}>{r.message}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <h2 className="section-title">
            暗号化バックアップ（端末同期の代替）{' '}
            <Tooltip label="パスワードは端末にだけ保持され、どこにも保存されません。忘れると復旧できません。">
              <span aria-hidden="true">？</span>
            </Tooltip>
          </h2>

          <div className="form-row">
            <div className="field">
              <label htmlFor="export-password">バックアップ用パスワード</label>
              <input
                id="export-password"
                type="password"
                value={exportPassword}
                onChange={(e) => setExportPassword(e.target.value)}
                placeholder="半角英数字8文字以上"
                autoComplete="new-password"
              />
              <div className="hint">書出と復元で同じパスワードを使います。</div>
            </div>
            <div className="field">
              <label htmlFor="export-group">グループ指定バックアップ（外注先との共有用）</label>
              <select
                id="export-group"
                value={exportGroupId}
                onChange={(e) => setExportGroupId(e.target.value)}
              >
                <option value="">グループを選択…</option>
                {(groups ?? []).map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
              <div className="hint">選んだグループのアカウントと、そのアカウントが使うプロキシグループだけを含みます。</div>
            </div>
          </div>
          <div className="toolbar">
            <Button variant="primary" onClick={() => void runExport('full')} disabled={busy}>
              全データバックアップを書き出す
            </Button>
            <Button onClick={() => void runExport('group')} disabled={busy || !exportGroupId}>
              グループ指定で書き出す
            </Button>
          </div>

          <h2 className="section-title">バックアップから復元</h2>
          <div className="form-row">
            <div className="field">
              <label htmlFor="import-password">復元用パスワード</label>
              <input
                id="import-password"
                type="password"
                value={importPassword}
                onChange={(e) => setImportPassword(e.target.value)}
                placeholder="半角英数字8文字以上"
                autoComplete="current-password"
              />
            </div>
            <div className="field">
              <label htmlFor="import-file">バックアップファイル</label>
              <input
                id="import-file"
                ref={backupFileRef}
                type="file"
                accept=".json,application/json"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onBackupFile(f);
                }}
              />
              <div className="hint">パスワードを入力してからファイルを選ぶと、内容を確認できます。</div>
            </div>
          </div>

          {restoreError && (
            <ul className="note-list error">
              <li>{restoreError}</li>
            </ul>
          )}

          {pendingRestore && (
            <div className="preview-box">
              {pendingRestore.kind === 'full' ? (
                <>
                  全データバックアップ（{checkedAtLabel(pendingRestore.exportedAt)} に作成）。
                  復元は<strong>置き換え</strong>方式で、現在のデータはすべて消えてバックアップの内容になります。
                </>
              ) : (
                <>
                  グループ指定バックアップ（グループ「{pendingRestore.groupName ?? '—'}」、{checkedAtLabel(pendingRestore.exportedAt)} に作成）。
                  復元は<strong>統合</strong>方式で、既にあるアカウントはスキップされ、データが削除されることはありません。
                </>
              )}
              <div className="row-badges" style={{ marginTop: 'var(--sp-2)' }}>
                {Object.entries(backupCounts(pendingRestore)).map(([key, n]) => (
                  <PlainBadge key={key}>
                    {COUNT_LABELS[key] ?? key} {n}
                  </PlainBadge>
                ))}
              </div>
              <div style={{ marginTop: 'var(--sp-3)' }}>
                <Button variant={pendingRestore.kind === 'full' ? 'danger' : 'primary'} onClick={applyRestore} disabled={busy}>
                  {busy ? '復元中…' : pendingRestore.kind === 'full' ? '現在のデータを置き換えて復元する' : 'この内容で取り込む'}
                </Button>{' '}
                <Button variant="ghost" onClick={() => setPendingRestore(null)} disabled={busy}>
                  やめる
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
