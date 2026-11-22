import { useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { versionLabel } from '../lib/version';

export interface Section {
  no: string;
  path: string;
  label: string;
  glyph: string;
  /** Milestone where this section becomes functional. */
  milestone: string;
  ready: boolean;
  description: string;
}

/** The sections of DESIGN.md §5, in order, plus the mail ledger. */
export const SECTIONS: Section[] = [
  { no: '01', path: '/', label: 'ダッシュボード', glyph: '▦', milestone: 'M1', ready: true, description: 'アカウント状態サマリと要対応アラート' },
  { no: '02', path: '/accounts', label: 'アカウント', glyph: '𝕏', milestone: 'M1', ready: true, description: 'アカウント台帳・グループ・プロキシ割当' },
  { no: '03', path: '/accounts', label: 'アカウント詳細', glyph: '▤', milestone: 'M1', ready: true, description: 'アカウント行から開く詳細ビュー' },
  { no: '04', path: '/bulk-post', label: '一括投稿', glyph: '✎', milestone: 'M2', ready: true, description: 'テンプレート・ランダム文言・ツリー・予約投稿' },
  { no: '05', path: '/bulk-action', label: '一括操作', glyph: '♥', milestone: 'M4', ready: true, description: 'いいね・リポスト・ブックマークの一括実行と自動操作' },
  { no: '06', path: '/ban-check', label: 'バンチェック', glyph: '◎', milestone: 'M3', ready: true, description: 'サーチバン／リプライバンのチェックと定期実行' },
  { no: '07', path: '/analytics', label: '分析', glyph: '↗', milestone: 'M4', ready: true, description: 'ポスト分析・ポスト追跡・フォロワー推移' },
  { no: '08', path: '/inbox', label: '通知 / DM', glyph: '✉', milestone: 'M4', ready: true, description: '全アカウントの通知とDMの集約' },
  { no: '09', path: '/data', label: 'データ管理', glyph: '⇅', milestone: 'M5', ready: true, description: 'CSV入出力・バックアップ・端末同期' },
  { no: '10', path: '/settings', label: '設定', glyph: '⚙', milestone: 'M5', ready: true, description: 'プラン・同時保持数・定期チェック設定' },
  { no: '11', path: '/emails', label: 'メールアドレス', glyph: '＠', milestone: 'M6', ready: true, description: 'メールアドレス台帳・アカウントとの紐づけ' },
];

const PRIMARY_TABS = [SECTIONS[0], SECTIONS[1], SECTIONS[3], SECTIONS[5]];

function NavItems({ onNavigate }: { onNavigate?: () => void }) {
  const location = useLocation();
  return (
    <>
      {SECTIONS.map((s) => {
        const p = location.pathname;
        const active =
          s.no === '01'
            ? p === '/'
            : s.no === '02'
              ? p === '/accounts'
              : s.no === '03'
                ? /^\/accounts\/.+/.test(p)
                : p.startsWith(s.path);
        return (
          <NavLink
            key={s.no}
            to={s.path}
            className={`nav-item ${active ? 'active' : ''}`}
            onClick={onNavigate}
          >
            <span className="nav-no">{s.no}</span>
            {s.label}
            {!s.ready && <span className="nav-soon">{s.milestone}</span>}
          </NavLink>
        );
      })}
    </>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  const settingsRow = useLiveQuery(() => db.settings.get('app'), [], undefined);
  const executorLabel = settingsRow?.settings.executorMode === 'extension' ? 'EXTENSION' : 'SIMULATOR';

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <span className="brand-x">𝕏</span>
            x-manager
          </div>
          <div className="brand-sub">Multi-account console</div>
        </div>
        <nav className="nav" aria-label="メインナビゲーション">
          <NavItems />
        </nav>
        <div className="sidebar-foot">
          DATA: ON-DEVICE / INDEXEDDB
          <br />
          EXECUTOR: {executorLabel}
          <br />
          VERSION: {versionLabel()}
        </div>
      </aside>

      <main className="main">{children}</main>

      <nav className="tabbar" aria-label="モバイルナビゲーション">
        {PRIMARY_TABS.map((s) => {
          const active =
            s.path === '/' ? location.pathname === '/' : location.pathname.startsWith(s.path);
          return (
            <NavLink key={s.no} to={s.path} className={active ? 'active' : ''}>
              <span className="tab-glyph">{s.glyph}</span>
              {s.label}
            </NavLink>
          );
        })}
        <button type="button" className="tab-btn" onClick={() => setMenuOpen(true)}>
          <span className="tab-glyph">≡</span>
          すべて
        </button>
      </nav>

      {menuOpen && (
        <div className="menu-sheet">
          <div className="modal-head">
            <h2 className="modal-title">セクション</h2>
            <button type="button" className="btn small ghost" onClick={() => setMenuOpen(false)}>
              ✕ 閉じる
            </button>
          </div>
          <nav aria-label="全セクション">
            <NavItems onNavigate={() => setMenuOpen(false)} />
          </nav>
        </div>
      )}
    </div>
  );
}
