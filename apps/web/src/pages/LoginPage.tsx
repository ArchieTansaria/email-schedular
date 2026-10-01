import { Navigate } from 'react-router-dom';
import { ApiError } from '../api/client.js';
import { useCurrentUser } from '../App.js';
import googleLogoUrl from '../assets/google.svg';

export function LoginPage() {
  const user = useCurrentUser();
  if (user.data) return <Navigate to="/" replace />;
  const unavailable = user.error instanceof ApiError && user.error.status !== 401;
  return (
    <main className="login-page">
      <section className="login-card">
        <p className="login-wordmark">ReachInbox</p>
        <h1>Login</h1>
        <p className="login-intro">Schedule reliable email campaigns and follow every delivery.</p>
        {unavailable ? (
          <span className="google-button is-disabled">
            <img alt="" aria-hidden className="google-mark is-muted" src={googleLogoUrl} />
            Login with Google
          </span>
        ) : (
          <a className="google-button" href="/api/v1/auth/google">
            <img alt="" aria-hidden className="google-mark" src={googleLogoUrl} />
            Login with Google
          </a>
        )}
        {unavailable ? (
          <p className="login-error">Authentication is temporarily unavailable.</p>
        ) : null}
        <p className="login-footnote">Secure access with your Google account</p>
      </section>
    </main>
  );
}
