import { SERVICE_NAME } from '@reachinbox/shared/contracts';

export function App() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6 text-slate-100">
      <section className="w-full max-w-2xl rounded-3xl border border-slate-800 bg-slate-900 p-10 shadow-2xl shadow-indigo-950/30">
        <p className="text-sm font-semibold uppercase tracking-[0.22em] text-indigo-400">Phase 0</p>
        <h1 className="mt-4 text-4xl font-bold tracking-tight">ReachInbox Scheduler</h1>
        <p className="mt-4 max-w-xl text-base leading-7 text-slate-300">
          The API, worker, shared contracts, tests, and local infrastructure foundation are ready.
          Product workflows arrive in the next phase.
        </p>
        <code className="mt-8 inline-flex rounded-full bg-slate-800 px-4 py-2 text-sm text-slate-300">
          {SERVICE_NAME}
        </code>
      </section>
    </main>
  );
}
