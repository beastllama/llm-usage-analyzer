import React, { Component } from 'react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** What the main button does. Leave out to offer a page reload. */
  onReset?: () => void;
  resetLabel?: string;
  /** A second, smaller action, for example deleting saved data that may be the cause. */
  extraLabel?: string;
  onExtra?: () => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/** Catches render errors so one bad file or saved report cannot leave a blank page. */
class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    const { onReset, resetLabel, extraLabel, onExtra } = this.props;
    return (
      <div role="alert" className="max-w-md mx-auto text-center py-20 px-4 space-y-4">
        <h2 className="text-xl font-bold text-white">Something went wrong.</h2>
        <p className="text-slate-200 text-sm">
          A file or a saved report may be damaged. Your usage data was not sent anywhere.
        </p>
        <div className="flex flex-col items-center gap-2">
          <button
            onClick={() => {
              if (onReset) { this.setState({ error: null }); onReset(); } else { window.location.reload(); }
            }}
            className="px-5 min-h-11 rounded-lg bg-indigo-500 hover:bg-indigo-400 text-white font-medium"
          >
            {resetLabel ?? (onReset ? 'Back to start' : 'Reload the page')}
          </button>
          {extraLabel && onExtra && (
            <button
              onClick={() => { onExtra(); this.setState({ error: null }); onReset?.(); }}
              className="px-5 min-h-11 text-sm text-slate-200 underline hover:text-white"
            >
              {extraLabel}
            </button>
          )}
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
