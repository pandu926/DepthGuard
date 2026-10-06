import React from "react";
/** A failed lazy asset or rendering error must leave a recovery path, not a blank page. */
export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <section className="empty-state" role="alert">
        <h2>This page could not load.</h2>
        <p>
          Your saved drafts and submitted transactions remain available. Reload
          to recover the application.
        </p>
        <button className="primary" onClick={() => window.location.reload()}>
          Reload application
        </button>
      </section>
    );
  }
}
