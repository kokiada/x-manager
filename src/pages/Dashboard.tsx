import { useLiveQuery } from 'dexie-react-hooks';
import { Link } from 'react-router-dom';
import { db } from '../db/db';
import { ACCOUNT_STATUSES, STATUS_LABELS, type AccountStatus } from '../db/types';
import { fullCount } from '../lib/format';
import { StatusBadge } from '../components/ui';

const STATUS_COLOR: Record<AccountStatus, string> = {
  logged_in: 'var(--st-logged-in)',
  logged_out: 'var(--st-logged-out)',
  locked: 'var(--st-locked)',
  frozen: 'var(--st-frozen)',
  connection_error: 'var(--st-connection-error)',
};

export function Dashboard() {
  const accounts = useLiveQuery(() => db.accounts.toArray(), [], undefined);

  if (!accounts) {
    return <p className="faded">読み込み中…</p>;
  }

  if (accounts.length === 0) {
    return (
      <div>
        <div className="page-head">
          <div>
            <h1 className="page-title">
              <span className="page-no">01</span>ダッシュボード
            </h1>
          </div>
        </div>
        <div className="placeholder-box">
          <div className="ph-tag">EMPTY</div>
          <p>アカウントがまだ登録されていません。</p>
          <p style={{ marginBottom: 0 }}>
            <Link className="btn small" to="/accounts">アカウントを追加する</Link>{' '}
            <Link className="btn small" to="/data">CSV・バックアップから取り込む</Link>
          </p>
        </div>
      </div>
    );
  }

  const countBy = (s: AccountStatus) => accounts.filter((a) => a.status === s).length;
  const alerts = accounts.filter((a) => a.status === 'locked' || a.status === 'frozen');
  const totalNotifications = accounts.reduce((sum, a) => sum + a.notifications, 0);
  const totalDm = accounts.reduce((sum, a) => sum + a.dmCount, 0);
  const totalFollowers = accounts.reduce((sum, a) => sum + a.followers, 0);
  const banWatch = accounts.filter(
    (a) => a.searchBan === 'topic_hidden' || a.searchBan === 'both_hidden',
  );

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">
            <span className="page-no">01</span>ダッシュボード
          </h1>
        </div>
      </div>

      <div className="fleet" role="group" aria-label="アカウント状態サマリ">
        <div className="fleet-cell fleet-total">
          <div className="fleet-num">{accounts.length}</div>
          <div className="fleet-label">TOTAL / 登録総数</div>
        </div>
        {ACCOUNT_STATUSES.slice(0, 4).map((s) => (
          <div className="fleet-cell" key={s}>
            <div className="fleet-num" style={{ color: STATUS_COLOR[s] }}>
              {countBy(s)}
            </div>
            <div className="fleet-label">
              <span className="dot" style={{ background: STATUS_COLOR[s] }} />
              {STATUS_LABELS[s]}
            </div>
          </div>
        ))}
      </div>

      <h2 className="section-title">集計</h2>
      <div className="kv-strip">
        <div className="kv-cell">
          <div className="kv-num">{fullCount(totalFollowers)}</div>
          <div className="kv-label">総フォロワー数</div>
        </div>
        <div className="kv-cell">
          <div className="kv-num">{fullCount(totalNotifications)}</div>
          <div className="kv-label">通知</div>
        </div>
        <div className="kv-cell">
          <div className="kv-num">{fullCount(totalDm)}</div>
          <div className="kv-label">DM</div>
        </div>
      </div>

      <h2 className="section-title">要対応アラート</h2>
      {alerts.length === 0 && banWatch.length === 0 && (
        <p className="faded">ロック・凍結・サーチバンのアラートはありません。</p>
      )}
      {alerts.map((a) => (
        <div key={a.id} className={`alert-row ${a.status === 'locked' ? 'warn' : ''}`}>
          <StatusBadge status={a.status} />
          <div className="grow">
            <strong>{a.displayName}</strong>{' '}
            <span className="mono faded">@{a.handle}</span>
            {a.memo && <div className="faded" style={{ fontSize: 12.5 }}>{a.memo}</div>}
          </div>
          <Link className="btn small" to={`/accounts/${a.id}`}>
            詳細を開く
          </Link>
        </div>
      ))}
      {banWatch.map((a) => (
        <div key={`ban-${a.id}`} className="alert-row warn">
          <span className="badge st-locked">サーチバン</span>
          <div className="grow">
            <strong>{a.displayName}</strong>{' '}
            <span className="mono faded">@{a.handle}</span>
            <div className="faded" style={{ fontSize: 12.5 }}>
              {a.searchBan === 'both_hidden'
                ? '「話題」「最新」の両方で非表示です'
                : '「話題」タブで非表示です（「最新」には表示）'}
            </div>
          </div>
          <Link className="btn small" to={`/accounts/${a.id}`}>
            詳細を開く
          </Link>
        </div>
      ))}

      <h2 className="section-title">接続エラー</h2>
      {countBy('connection_error') === 0 ? (
        <p className="faded">接続エラーのアカウントはありません。</p>
      ) : (
        accounts
          .filter((a) => a.status === 'connection_error')
          .map((a) => (
            <div key={a.id} className="alert-row warn" style={{ borderLeftColor: 'var(--c-info)' }}>
              <StatusBadge status={a.status} />
              <div className="grow">
                <strong>{a.displayName}</strong>{' '}
                <span className="mono faded">@{a.handle}</span>
                {a.memo && <div className="faded" style={{ fontSize: 12.5 }}>{a.memo}</div>}
              </div>
              <Link className="btn small" to={`/accounts/${a.id}`}>
                詳細を開く
              </Link>
            </div>
          ))
      )}
    </div>
  );
}
