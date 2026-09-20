// "Report a problem" screen: reachable from the gear menu, Settings, the
// wizard's error state and Home's "Could not read" cards (see app.js for the
// onOpenReport wiring). All assembly (the session summary, the report JSON,
// the mailto shape) lives in core/report.js and core/session-report.js, both
// pure and unit-tested; this file is only the DOM around them.
//
// Item 10: the report never carries a per-transaction entry or a file name.
// "Which statement" lists anonymous, auto-generated labels (built from the
// current session's own debug log, same as what ends up in the report) - not
// the real file list. The full, un-anonymised debug log is still available,
// as a clearly separate action that is never sent anywhere.

import { all as allDebugLogEvents, asText as debugLogText } from '../core/debuglog.js';
import { buildReport, buildMailto, reportToJson, SUPPORT_EMAIL } from '../core/report.js';
import { buildSessionSummary } from '../core/session-report.js';

const $ = (sel) => document.querySelector(sel);

export function createReportScreen() {
  let prefillLabel = '';

  function extensionVersion() {
    try { return chrome.runtime.getManifest().version; } catch { return 'unknown'; }
  }

  function statements() {
    return buildSessionSummary(allDebugLogEvents()).statements;
  }

  function renderFileOptions() {
    const select = $('#report-file');
    const list = statements();
    select.innerHTML = '<option value="">(not one in particular)</option>'
      + list.map((s) => `<option value="${s.label}">${s.summary}</option>`).join('');
    select.value = list.some((s) => s.label === prefillLabel) ? prefillLabel : '';
  }

  function currentReport() {
    return buildReport({
      extensionVersion: extensionVersion(),
      userAgent: (typeof navigator !== 'undefined' && navigator.userAgent) || 'unknown',
      whatHappened: $('#report-what').value,
      statementLabel: $('#report-file').value,
      events: allDebugLogEvents(),
    });
  }

  function currentMailto() {
    return buildMailto({
      email: SUPPORT_EMAIL,
      extensionVersion: extensionVersion(),
      whatHappened: $('#report-what').value,
      statementLabel: $('#report-file').value,
    });
  }

  // A plain-language summary is what shows by default - the exact JSON
  // "Copy report" will put on the clipboard is still right there,
  // verifiable, just behind a "Show the exact report" disclosure instead of
  // being the first thing every user sees.
  function renderSummaryList(r) {
    const list = $('#report-summary-list');
    if (!list) return;
    const items = [
      r.whatHappened.trim() ? 'Your message' : 'No message written yet',
      r.statement ? `About: ${r.statement}` : 'Not about one statement in particular',
      `${r.statements.length} statement${r.statements.length === 1 ? '' : 's'} in this session, structural details only (no file names, no transactions)`,
      `Extension version ${r.extensionVersion}, ${r.browser} on ${r.os}`,
    ];
    list.innerHTML = '';
    for (const text of items) {
      const li = document.createElement('li');
      li.textContent = text;
      list.appendChild(li);
    }
  }

  // The exact JSON that "Copy report" will put on the clipboard, shown
  // before the user ever clicks - the anonymisation is verifiable, not
  // just asserted.
  function renderPreview() {
    const r = currentReport();
    $('#report-preview').textContent = reportToJson(r);
    renderSummaryList(r);
  }

  async function copyReport() {
    await navigator.clipboard.writeText(reportToJson(currentReport()));
  }

  function setStatus(text) {
    $('#report-status').textContent = text || '';
  }

  async function send() {
    try {
      await copyReport();
      const mailto = currentMailto();
      $('#report-mailto-link').href = mailto;
      $('#report-email').textContent = SUPPORT_EMAIL;
      $('#report-done').hidden = false;
      setStatus('Report copied.');
      $('#report-mailto-link').click();
    } catch {
      // Clipboard denied: the JSON is right there in the preview to select
      // and copy by hand, and the mail draft still opens with the summary.
      setStatus("Couldn't copy automatically - select the preview above to copy it by hand.");
      const mailto = currentMailto();
      $('#report-mailto-link').href = mailto;
      $('#report-email').textContent = SUPPORT_EMAIL;
      $('#report-done').hidden = false;
      $('#report-mailto-link').click();
    }
  }

  function wire() {
    $('#report-what').addEventListener('input', renderPreview);
    $('#report-file').addEventListener('change', renderPreview);
    $('#report-send-btn').addEventListener('click', send);
    $('#report-copy-again-btn').addEventListener('click', async () => {
      try { await copyReport(); setStatus('Report copied again.'); }
      catch { setStatus("Couldn't copy - select the preview above to copy it by hand."); }
    });
    // The full, un-anonymised debug log, for the owner's own
    // troubleshooting - a separate action from the anonymised "Copy report"
    // above it, never the same button, never sent anywhere by this screen.
    $('#report-copy-debuglog-btn')?.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(debugLogText()); setStatus('Full log copied (not sent).'); }
      catch { setStatus('Clipboard access was denied.'); }
    });
  }

  /** Opens the screen (app.js shows it right after), optionally prefilled from a real file name (e.g. from a "Could not read" card) - translated here to its anonymous label, never carried further as the real name. */
  function open(fileName) {
    const { nameToLabel } = buildSessionSummary(allDebugLogEvents());
    const found = (nameToLabel || []).find(([name]) => name === fileName);
    prefillLabel = found ? found[1] : '';
    $('#report-what').value = '';
    $('#report-done').hidden = true;
    setStatus('');
    renderFileOptions();
    renderPreview();
  }

  return { open, wire };
}
