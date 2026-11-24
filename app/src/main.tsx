import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from './lib/auth';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { installErrorReporting } from './lib/errors';
import './styles/app.css';

installErrorReporting();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <ErrorBoundary><App /></ErrorBoundary>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);

// Installable web app: register the service worker in production builds only.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => { void navigator.serviceWorker.register('/sw.js'); });
}
