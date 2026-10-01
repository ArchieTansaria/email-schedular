import { Navigate } from 'react-router-dom';
import { ApiError } from '../api/client.js';
import { useCurrentUser } from '../App.js';

export function LoginPage() {
  const user = useCurrentUser();
  if (user.data) return <Navigate to="/" replace />;
  const unavailable = user.error instanceof ApiError && user.error.status !== 401;
  return (
    <main className="grid min-h-screen place-items-center bg-[#fbfcfb] px-5">
      <section className="w-full max-w-md rounded-xl border border-slate-200 bg-white px-12 py-14 text-center shadow-sm">
        <p className="mb-8 text-xs font-semibold uppercase tracking-[0.28em] text-emerald-600">
          ReachInbox
        </p>
        <h1 className="text-4xl font-semibold tracking-tight text-slate-900">Login</h1>
        <p className="mx-auto mt-3 max-w-xs text-sm leading-6 text-slate-500">
          Schedule reliable email campaigns and follow every delivery.
        </p>
        {unavailable ? (
          <span className="mt-9 flex w-full items-center justify-center gap-3 rounded-xl bg-emerald-50 px-5 py-4 text-sm font-medium text-slate-400">
            <span aria-hidden className="text-lg font-bold text-blue-300">
              G
            </span>
            Continue with Google
          </span>
        ) : (
          <a
            className="mt-9 flex w-full items-center justify-center gap-3 rounded-xl bg-emerald-50 px-5 py-4 text-sm font-medium text-slate-800 no-underline transition hover:bg-emerald-100"
            href="/api/v1/auth/google"
          >
            <span aria-hidden className="text-lg font-bold text-blue-500">
              G
            </span>
            Continue with Google
          </a>
        )}
        {unavailable ? (
          <p className="mt-4 text-sm text-red-600">Authentication is temporarily unavailable.</p>
        ) : null}
      </section>
    </main>
  );
}
