import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reportError } from '../lib/errors';

/** Shows a recovery screen instead of a blank page when a screen crashes, and logs the crash. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    reportError(Object.assign(new Error(error.message), { stack: `${error.stack ?? ''}\n${info.componentStack ?? ''}` }));
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="center" role="alert">
        <section className="card" style={{ maxWidth: 420 }}>
          <h2 style={{ marginBottom: 6 }}>Something went wrong on this screen</h2>
          <p className="muted" style={{ marginBottom: 14 }}>The problem has been recorded. Reloading usually fixes it; your saved data is safe.</p>
          <button className="btn primary" onClick={() => location.reload()}>Reload</button>{' '}
          <a className="btn" href="/app">Go to dashboard</a>
        </section>
      </div>
    );
  }
}
