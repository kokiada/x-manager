import { useEffect, useState } from 'react';
import { HashRouter, Route, Routes } from 'react-router-dom';
import { AppShell, SECTIONS } from './components/AppShell';
import { ToastProvider } from './components/ui';
import { seedIfEmpty } from './db/seed';
import { useReservationScheduler } from './hooks/useReservationScheduler';
import { AccountDetail } from './pages/AccountDetail';
import { Accounts } from './pages/Accounts';
import { BanCheck } from './pages/BanCheck';
import { BulkAction } from './pages/BulkAction';
import { BulkPost } from './pages/BulkPost';
import { Dashboard } from './pages/Dashboard';
import { DataManagement } from './pages/DataManagement';
import { Placeholder } from './pages/Placeholder';
import { Settings } from './pages/Settings';

export default function App() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    seedIfEmpty()
      .catch(() => {
        /* seeding is best-effort; the app still renders empty states */
      })
      .finally(() => setReady(true));
  }, []);

  // Fire due bulk-post reservations while the app is open (M2).
  useReservationScheduler();

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
              <Route path="/data" element={<DataManagement />} />
              <Route path="/settings" element={<Settings />} />
              {SECTIONS.filter((s) => !s.ready && s.no !== '03').map((s) => (
                <Route key={s.no} path={s.path} element={<Placeholder section={s} />} />
              ))}
            </Routes>
          )}
        </AppShell>
      </HashRouter>
    </ToastProvider>
  );
}
