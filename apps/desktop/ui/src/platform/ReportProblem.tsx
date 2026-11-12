import { useState } from 'react';
import { Button, Dialog, toast } from '@htflow/ui-kit';
import { crashSummary, openCrashFolder, useReportDialog } from './crash';
import { isTauri } from './native';

/** Copies text; falls back to a hidden textarea when the async clipboard API is blocked. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/**
 * "Report a problem": opens the local crash folder and copies a redacted summary (version, OS,
 * the newest crash file with user names, e-mails, passwords and tokens removed). Nothing is sent
 * anywhere — the user decides whether to paste it into a GitHub issue.
 */
export function ReportProblemDialog() {
  const open = useReportDialog((s) => s.open);
  const hide = useReportDialog((s) => s.hide);
  const [summary, setSummary] = useState('');
  const desktop = isTauri;

  const copy = async () => {
    try {
      const text = desktop
        ? await crashSummary()
        : `HT Flow problem report (web build)\nuser agent: ${navigator.userAgent.replace(/\d+\.\d+\.\d+(\.\d+)?/g, 'x')}\n`;
      setSummary(text);
      const ok = await copyText(text);
      toast(
        ok ? 'success' : 'warning',
        ok ? 'Summary copied' : 'Could not copy automatically',
        ok ? 'Paste it into a new GitHub issue.' : 'Select the text below and copy it manually.',
      );
    } catch (e) {
      toast('error', 'Could not build the summary', e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => (o ? undefined : hide())}
      title="Report a problem"
      description="Nothing is sent anywhere. Crash reports stay on this PC; you choose what to share."
      width={520}
    >
      <div className="col gap12" data-testid="report-problem">
        <p className="crash-note">
          1. Copy a redacted summary (app version, operating system and the latest crash report with
          user names, e-mail addresses, passwords and tokens removed).
          <br />
          2. Open the crash folder if you want to attach the full file to a GitHub issue.
        </p>
        <div className="row gap8">
          <Button variant="primary" onClick={() => void copy()} data-testid="report-copy">
            Copy summary
          </Button>
          <Button
            disabled={!desktop}
            title={desktop ? undefined : 'Crash files are only written by the desktop app'}
            onClick={() =>
              void openCrashFolder().catch((e) =>
                toast('error', 'Could not open the folder', e instanceof Error ? e.message : ''),
              )
            }
            data-testid="report-open-folder"
          >
            Open crash folder
          </Button>
          <Button onClick={hide}>Close</Button>
        </div>
        {summary && (
          <textarea
            className="crash-summary"
            readOnly
            aria-label="Redacted summary"
            value={summary}
            rows={10}
            onFocus={(e) => e.currentTarget.select()}
          />
        )}
      </div>
    </Dialog>
  );
}
