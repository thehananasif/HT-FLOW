/** Playwright global teardown: merges the click-everything report parts (no-op without them). */
import { mergeReport } from './report';
import { REPORT_DIR } from './playwright';

export default function teardown(): void {
  const r = mergeReport(REPORT_DIR, 'Playwright · web build (Chromium)');
  if (r)
    console.log(
      `click report: ${r.totals.controls} controls, ${r.totals.fail} failures, ${r.totals.warn} warnings → ${REPORT_DIR}/index.html`,
    );
}
