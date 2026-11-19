import { Component, type ErrorInfo, type ReactNode } from 'react';
import { TooltipProvider, Toaster } from '@htflow/ui-kit';
import { formatError, saveCrash, useReportDialog } from './crash';
import { ReportProblemDialog } from './ReportProblem';
import './styles.css';

import { translateLiteral as tl } from '@htflow/i18n';
interface State {
  error: Error | null;
  saved: string | null;
}

/**
 * Last line of defence: a render error anywhere in the UI shows this panel instead of a blank
 * window, and writes a redacted crash file to `<data>/crashes/` (desktop build). Local only.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null, saved: null };

  static getDerivedStateFromError(error: Error): State {
    return { error, saved: null };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    void saveCrash('ui-render', formatError(error, info.componentStack ?? undefined)).then((n) =>
      this.setState({ saved: n }),
    );
  }

  override render() {
    const { error, saved } = this.state;
    if (!error) return this.props.children;
    return (
      <TooltipProvider>
        <div role="alert" className="crash-fallback" data-testid="crash-fallback">
          <h1>{tl('Something went wrong')}</h1>
          <p>{tl('HT Flow hit an unexpected error. Your data is safe on this PC.')}</p>
          <pre className="crash-msg">{error.message}</pre>
          <p className="crash-note">
            {saved
              ? `A report was saved locally (${saved}). Nothing was sent anywhere.`
              : 'Nothing was sent anywhere.'}
          </p>
          <div className="crash-actions">
            <button type="button" onClick={() => location.reload()}>
              {tl('Reload')}
            </button>
            <button type="button" onClick={() => useReportDialog.getState().show()}>
              {tl('Report a problem…')}
            </button>
          </div>
        </div>
        <ReportProblemDialog />
        <Toaster />
      </TooltipProvider>
    );
  }
}
