// "Report a problem" screen: reachable from the gear menu, Settings, the
// wizard's error state and Home's "Could not read" cards (see app.js for the
// onOpenReport wiring). All assembly (the anonymisation, the report JSON,
// the mailto shape) lives in core/report.js and core/anonymize.js, both pure
// and unit-tested; this file is only the DOM around them.

import { all as allDebugLogEvents, asText as debugLogText } from '../core/debuglog.js';
import { buildReport, buildMailto, reportToJson, SUPPORT_EMAIL } from '../core/report.js';

const $ = (sel) => document.querySelector(sel);

export function createReportScreen({ getFiles }) {
  let prefillFileName = '';

  function extensionVersion() {
    try { return chrome.runtime.getManifest().version; } catch { return 'unknown'; }
  }

  function renderFileOptions() {
    const select = $('#report-file');
    const files = getFiles?.() || [];
    select.innerHTML = '<option value="">(not one file in particular)</option>'
      + files.map((f) => `<option value="${f.name}">${f.name}</option>`).join('');
    select.value = files.some((f) => f.name === prefillFileName) ? prefillFileName : '';
  }

  function includeLog() { return $('#report-include-log').checked; }

  function currentReport() {
    return buildReport({
      extensionVersion: extensionVersion(),
      userAgent: (typeof navigator !== 'undefined' && navigator.userAgent) || 'unknown',
      whatHappened: $('#report-what').value,
      fileName: $('#report-file').value,
      includeLog: includeLog(),
      events: includeLog() ? allDebugLogEvents() : [],
    });
  }

  function currentMailto() {
    return buildMailto({
      email: SUPPORT_EMAIL,
      extensionVersion: extensionVersion(),
      whatHappened: $('#report-what').value,
      fileName: $('#report-file').value,
    });
  }

  // Item 15: a plain-language summary is what shows by default - the exact
  // JSON "Copy report" will put on the clipboard is still right there,
  // verifiable, just behind a "Show the exact report" disclosure instead of
  // being the first thing every user sees.
  function renderSummaryList(r) {
    const list = $('#report-summary-list');
    if (!list) return;
    const items = [
      r.whatHappened.trim() ? 'Your message' : 'No message written yet',
      r.fileName ? `File: ${r.fileName}` : 'No file selected',
      r.logIncluded ? `Debug log included, ${(r.log || []).length} entries` : 'No debug log included',
      `Extension version ${r.extensionVersion}`,
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
    $('#report-log-summary').textContent = includeLog() ? r.logNote : 'No debug log will be included.';
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
    $('#report-include-log').addEventListener('change', renderPreview);
    $('#report-send-btn').addEventListener('click', send);
    $('#report-copy-again-btn').addEventListener('click', async () => {
      try { await copyReport(); setStatus('Report copied again.'); }
      catch { setStatus("Couldn't copy - select the preview above to copy it by hand."); }
    });
    // Item 15 (coordinator, 2026-09-18): the full, un-anonymised debug log,
    // for the owner's own troubleshooting - a separate action from the
    // anonymised "Copy report" above it, never the same button.
    $('#report-copy-debuglog-btn')?.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(debugLogText()); setStatus('Debug log copied.'); }
      catch { setStatus('Clipboard access was denied.'); }
    });
  }

  /** Opens the screen (app.js shows it right after) prefilled from a given file's name, e.g. from a "Could not read" card. */
  function open(fileName) {
    prefillFileName = fileName || '';
    $('#report-what').value = '';
    $('#report-include-log').checked = true;
    $('#report-done').hidden = true;
    setStatus('');
    renderFileOptions();
    renderPreview();
  }

  return { open, wire };
}
