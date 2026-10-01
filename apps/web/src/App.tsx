import { useQuery } from '@tanstack/react-query';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';

import { api, ApiError } from './api/client.js';
import { ComposePage } from './pages/ComposePage.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { EmailDetailPage } from './pages/EmailDetailPage.js';
import { LoginPage } from './pages/LoginPage.js';

export function useCurrentUser() {
  return useQuery({
    queryKey: ['auth', 'me'],
    queryFn: api.me,
    retry: false,
    staleTime: 60_000,
  });
}

function Protected({ children }: { children: React.ReactNode }) {
  const user = useCurrentUser();
  const location = useLocation();
  if (user.isPending) return <FullPageState message="Loading your workspace…" />;
  if (user.error instanceof ApiError && user.error.status === 401) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  if (user.isError) {
    return <FullPageState message="We could not load your session." action={user.refetch} />;
  }
  return children;
}

function FullPageState({ message, action }: { message: string; action?: () => unknown }) {
  return (
    <main className="grid min-h-screen place-items-center bg-[#fafbfa] p-6">
      <div className="text-center">
        <p className="text-sm text-slate-600">{message}</p>
        {action ? (
          <button className="button-primary mt-4" onClick={() => action()} type="button">
            Try again
          </button>
        ) : null}
      </div>
    </main>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/"
        element={
          <Protected>
            <DashboardPage />
          </Protected>
        }
      />
      <Route
        path="/compose"
        element={
          <Protected>
            <ComposePage />
          </Protected>
        }
      />
      <Route
        path="/emails/:id"
        element={
          <Protected>
            <EmailDetailPage />
          </Protected>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
