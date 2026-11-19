import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db/db';
import type { PostJob, PostJobEntryStatus, Reservation } from '../../db/types';
import { POST_JOB_ENTRY_LABELS } from '../../db/types';
import { updateReservation } from '../../db/repository';
import { cancelJob, deleteEntryPosts } from '../../lib/bulkPostService';
import { checkedAtLabel } from '../../lib/format';
import { Button, PlainBadge, useToast } from '../ui';

const ENTRY_BADGE_CLASS: Record<PostJobEntryStatus, string> = {
  pending: 'jb-pending',
  running: 'jb-running',
  done: 'jb-done',
  failed: 'jb-failed',
  skipped: 'jb-skipped',
};

export function JobCard({ job }: { job: PostJob }) {
  const toast = useToast();
  const doneCount = job.entries.filter((e) => e.status === 'done').length;
  const total = job.entries.length;

  const removePosts = async (accountId: string, handle: string) => {
    if (!window.confirm(`@${handle} の投稿（ツリー含む）を削除しますか？`)) return;
    try {
      const n = await deleteEntryPosts(job.id, accountId);
      toast.push(`@${handle} のポスト${n}件を削除しました`, 'ok');
    } catch (err) {
      toast.push(err instanceof Error ? err.message : '削除に失敗しました', 'err');
    }
  };

  return (
    <div className="job-card">
      <div className="job-head">
        <span className="mono faded" style={{ fontSize: 12 }}>
          {checkedAtLabel(job.startedAt)}
        </span>
        <PlainBadge>{job.kind === 'reservation' ? '予約投稿' : '一括投稿'}</PlainBadge>
        <PlainBadge>
          {job.status === 'running'
            ? `実行中 ${doneCount}/${total}`
            : job.status === 'done'
              ? '完了'
              : job.status === 'partial'
                ? '一部失敗'
                : 'キャンセル'}
        </PlainBadge>
        <span className="faded" style={{ fontSize: 12 }}>
          間隔 {job.intervalSec}秒 / {total}アカウント
        </span>
        <span className="spacer" />
        {job.status === 'running' && (
          <Button small variant="danger" onClick={() => cancelJob(job.id)}>
            キャンセル
          </Button>
        )}
      </div>
      <div className="job-entries">
        {job.entries.map((e) => (
          <div key={e.accountId} className="entry-row">
            <span className={`badge ${ENTRY_BADGE_CLASS[e.status]}`}>
              {POST_JOB_ENTRY_LABELS[e.status]}
            </span>
            <span className="pick-main">
              <span className="mono" style={{ fontSize: 12.5 }}>
                @{e.handle}
              </span>
              {e.error && (
                <span className="faded" style={{ fontSize: 12 }}>
                  {' '}
                  — {e.error}
                </span>
              )}
              {e.deletedAt && (
                <span className="dim" style={{ fontSize: 12 }}>
                  {' '}
                  （削除済み）
                </span>
              )}
            </span>
            {e.postUrl && !e.deletedAt && (
              <a className="mono" style={{ fontSize: 12, color: 'var(--c-info)' }} href={e.postUrl} target="_blank" rel="noreferrer">
                ポストを開く
              </a>
            )}
            {e.status === 'done' && !e.deletedAt && (
              <Button small variant="ghost" onClick={() => void removePosts(e.accountId, e.handle)}>
                投稿を削除{(e.threadPostIds?.length ?? 0) > 0 && '（ツリー一括）'}
              </Button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Results log of past bulk-post jobs + the reservation list. */
export function JobHistory() {
  const toast = useToast();
  const jobs = useLiveQuery(
    async () => (await db.postJobs.orderBy('createdAt').reverse().limit(30).toArray()),
    [],
    undefined,
  );
  const reservations = useLiveQuery(
    async () => (await db.reservations.orderBy('createdAt').reverse().limit(30).toArray()),
    [],
    undefined,
  );

  const cancelReservation = async (r: Reservation) => {
    if (!window.confirm('この予約を取り消しますか？')) return;
    await updateReservation(r.id, { status: 'cancelled' });
    toast.push('予約を取り消しました', 'ok');
  };

  return (
    <div>
      <h3 className="section-title" style={{ marginTop: 0 }}>
        予約一覧
      </h3>
      {reservations === undefined && <p className="faded">読み込み中…</p>}
      {reservations !== undefined && reservations.length === 0 && (
        <p className="faded">予約はありません。「投稿を作成」タブから予約できます。</p>
      )}
      {(reservations ?? []).map((r) => (
        <div key={r.id} className="simple-row" style={{ border: '1px solid var(--c-line)', background: 'var(--c-panel)', padding: '10px 12px', marginBottom: 8 }}>
          <span className="mono" style={{ fontSize: 12.5 }}>
            {checkedAtLabel(r.scheduledAt)}
          </span>
          <span className="pick-main">
            <strong style={{ fontSize: 13 }}>
              {r.payload.segments[0].slice(0, 40) || '（メディア/アンケート）'}
              {r.payload.segments.length > 1 && ` ＋ツリー${r.payload.segments.length - 1}`}
            </strong>
            <span className="faded" style={{ display: 'block', fontSize: 12 }}>
              {r.accountIds.length}アカウント / 間隔{r.intervalSec}秒
            </span>
          </span>
          <PlainBadge>
            {r.status === 'pending' ? '予約中' : r.status === 'fired' ? '実行済み' : '取消済み'}
          </PlainBadge>
          {r.status === 'pending' && (
            <Button small variant="danger" onClick={() => void cancelReservation(r)}>
              取り消す
            </Button>
          )}
        </div>
      ))}

      <h3 className="section-title">実行履歴</h3>
      {jobs === undefined && <p className="faded">読み込み中…</p>}
      {jobs !== undefined && jobs.length === 0 && (
        <p className="faded">まだ実行履歴がありません。</p>
      )}
      {(jobs ?? []).map((job) => (
        <JobCard key={job.id} job={job} />
      ))}
    </div>
  );
}
