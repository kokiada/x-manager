import { useEffect, useState } from 'react';
import { HashRouter, Route, Routes } from 'react-router-dom';
import { AppShell, SECTIONS } from './components/AppShell';
import { ToastProvider } from './components/ui';
import { seedIfEmpty } from './db/seed';
import { AccountDetail } from './pages/AccountDetail';
import { Accounts } from './pages/Accounts';
import { Dashboard } from './pages/Dashboard';
import { Placeholder } from './pages/Placeholder';

export default function App() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    seedIfEmpty()
      .catch(() => {
        /* seeding is best-effort; the app still renders empty states */
      })
      .finally(() => setReady(true));
  }, []);

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
