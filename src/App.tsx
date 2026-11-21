import { useEffect, useState } from 'react';
import { HashRouter, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { ToastProvider } from './components/ui';
import { getSettings } from './db/repository';
import { seedIfEmpty } from './db/seed';
import { setExecutorMode } from './executor';
import { useReservationScheduler } from './hooks/useReservationScheduler';
import { useScheduledEngines } from './hooks/useScheduledEngines';
import { AccountDetail } from './pages/AccountDetail';
import { Accounts } from './pages/Accounts';
import { Analytics } from './pages/Analytics';
import { BanCheck } from './pages/BanCheck';
import { BulkAction } from './pages/BulkAction';
import { BulkPost } from './pages/BulkPost';
import { Dashboard } from './pages/Dashboard';
import { DataManagement } from './pages/DataManagement';
import { Emails } from './pages/Emails';
import { Inbox } from './pages/Inbox';
import { Settings } from './pages/Settings';

export default function App() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    seedIfEmpty()
      .catch(() => {
        /* seeding is best-effort; the app still renders empty states */
      })
      .finally(() => setReady(true));
    // 実行方法を保存済みの設定から復元する（失敗時はシミュレータのまま）。
    getSettings()
      .then((settings) => setExecutorMode(settings.executorMode))
      .catch(() => {
        /* keep the default simulator mode */
      });
  }, []);

  // Fire due bulk-post reservations while the app is open (M2).
  useReservationScheduler();
  // Scheduled checks, auto-post and auto-action engines (M3/M4).
  useScheduledEngines();

  return (
    <ToastProvider>
      <HashRouter>
        <AppShell>
          {!ready ? (
            <p className="faded">読み込み中…</p>
          ) : (
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/accounts" element={<Accounts />} />
              <Route path="/accounts/:id" element={<AccountDetail />} />
              <Route path="/bulk-post" element={<BulkPost />} />
              <Route path="/bulk-action" element={<BulkAction />} />
              <Route path="/ban-check" element={<BanCheck />} />
              <Route path="/analytics" element={<Analytics />} />
              <Route path="/inbox" element={<Inbox />} />
              <Route path="/data" element={<DataManagement />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/emails" element={<Emails />} />
            </Routes>
          )}
        </AppShell>
      </HashRouter>
    </ToastProvider>
  );
}
