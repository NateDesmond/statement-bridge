// Settings screen: preferences (including the "Start from" column-layout
// picker), saved exchange rates, storage usage split, Clear sessions / Erase
// everything. The column layout itself is edited on Home, against a live
// preview - see preset-editor.js.

import { clearAllSessions } from '../core/sessions.js';
import { computeStorageSplit, formatBytes } from './storage-usage.js';
import { LAYOUT_PRESETS } from '../core/export.js';
import { asText as debugLogText, clear as clearDebugLog, log } from '../core/debuglog.js';
import { announce, fitTwoColumnGrid } from './nav.js';

const $ = (sel) => document.querySelector(sel);
const SETTINGS_KEY = 'settings';
const RATES_KEY = 'rates';

export function createSettingsScreen({ storage, sessionStore, onCleared, onOpenReport }) {
  // Item 7 (REBUILD-HOME, 2026-09-18): Settings holds preferences only - the
  // "Start from" picker lists the same six layouts Home's drawer offers, plus
  // "Last used" (the default: Home always reopens with the persisted working
  // set once one exists). No column editor, no saved-preset dropdown here -
  // customising columns happens on Home, in the moment there's something to
  // preview against.
  function renderPresetSelect() {
    const prefSelect = $('#pref-default-preset');
    prefSelect.innerHTML = '<option value="">Last used (default)</option>'
      + LAYOUT_PRESETS.map((l, idx) => `<option value="${idx}">${l.name}</option>`).join('');
  }

  async function renderRates() {
    const rates = (await storage.get(RATES_KEY)) || {};
    const host = $('#rates-list');
    host.innerHTML = '';
    for (const [pair, rate] of Object.entries(rates)) {
      const row = document.createElement('div');
      row.className = 'kv-row';
      row.innerHTML = `<span>${pair.replace('_', ' to ')}</span><span></span>`;
      const valueCell = row.lastElementChild;
      const input = document.createElement('input');
      input.className = 'num'; input.value = rate;
      input.onchange = async () => {
        const next = { ...rates, [pair]: Number(input.value) };
        await storage.set(RATES_KEY, next);
      };
      valueCell.appendChild(input);
      const del = document.createElement('button');
      del.className = 'icon-btn danger'; del.type = 'button'; del.textContent = 'Delete';
      del.onclick = async () => {
        const { [pair]: _drop, ...rest } = rates;
        await storage.set(RATES_KEY, rest);
        await renderRates();
        announce(`Deleted the rate for ${pair}.`);
      };
      row.appendChild(del);
      host.appendChild(row);
    }
    if (!Object.keys(rates).length) host.innerHTML = '<p class="pdf-anchor-hint">No saved rates yet.</p>';
  }

  async function renderStorage() {
    const { sessionsBytes, settingsBytes, totalBytes } = await computeStorageSplit({ storage, sessionStore });
    $('#storage-sessions-kv').textContent = formatBytes(sessionsBytes);
    $('#storage-settings-kv').textContent = formatBytes(settingsBytes);
    $('#storage-total-kv').textContent = formatBytes(totalBytes);
  }

  async function renderPreferences() {
    const prefs = (await storage.get(SETTINGS_KEY)) || {};
    $('#pref-default-range').value = prefs.defaultRange || 'all';
    $('#pref-home-currency').value = prefs.homeCurrency || 'SGD';
    $('#pref-default-preset').value = prefs.defaultPreset != null ? String(prefs.defaultPreset) : '';
  }

  async function render() {
    renderPresetSelect();
    await renderPreferences();
    await renderRates();
    await renderStorage();
    fitTwoColumnGrid(document.querySelector('#screen-settings .settings-grid'));
  }

  function wire() {
    $('#rate-add-btn').addEventListener('click', async () => {
      const pair = $('#rate-pair').value.trim().toUpperCase();
      const value = Number($('#rate-value').value);
      if (!pair || !Number.isFinite(value)) return;
      const rates = (await storage.get(RATES_KEY)) || {};
      await storage.set(RATES_KEY, { ...rates, [pair]: value });
      $('#rate-pair').value = ''; $('#rate-value').value = '';
      await renderRates();
      announce(`Saved rate for ${pair}.`);
    });

    for (const id of ['pref-default-range', 'pref-home-currency', 'pref-default-preset']) {
      $(`#${id}`).addEventListener('change', async () => {
        const prefs = (await storage.get(SETTINGS_KEY)) || {};
        const startFrom = $('#pref-default-preset').value; // '' = "Last used (default)"
        await storage.set(SETTINGS_KEY, {
          ...prefs,
          defaultRange: $('#pref-default-range').value,
          homeCurrency: $('#pref-home-currency').value,
          defaultPreset: startFrom === '' ? null : Number(startFrom),
        });
      });
    }

    $('#settings-copy-debuglog-btn').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(debugLogText());
        log('settings.debuglog', 'debug log copied to clipboard');
        alert('Debug log copied to the clipboard.');
      } catch {
        alert('Clipboard access was denied.');
      }
    });
    $('#settings-download-debuglog-btn').addEventListener('click', () => {
      const blob = new Blob([debugLogText()], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `statement-bridge-debug-log-${new Date().toISOString().slice(0, 10)}.txt`;
      a.click();
      URL.revokeObjectURL(url);
      log('settings.debuglog', 'debug log downloaded');
    });
    $('#settings-clear-debuglog-btn').addEventListener('click', () => {
      if (!confirm('Clear the debug log?')) return;
      clearDebugLog();
      announce('Debug log cleared.');
    });
    $('#settings-report-problem-btn')?.addEventListener('click', () => onOpenReport?.());

    $('#clear-sessions-btn').addEventListener('click', async () => {
      if (!confirm('Remove all statements from this tab? Your statement types, column layouts and saved rates are kept.')) return;
      await clearAllSessions(sessionStore);
      await renderStorage();
      onCleared?.();
      announce('All statements removed. Statement types kept.');
    });

    $('#delete-everything-confirm').addEventListener('input', (e) => {
      $('#delete-everything-btn').disabled = e.target.value !== 'ERASE';
    });
    $('#delete-everything-btn').addEventListener('click', async () => {
      await storage.remove('profiles');
      await storage.remove('presets');
      await storage.remove(SETTINGS_KEY);
      await storage.remove(RATES_KEY);
      await clearAllSessions(sessionStore);
      $('#delete-everything-confirm').value = '';
      $('#delete-everything-btn').disabled = true;
      await render();
      onCleared?.();
      announce('Everything erased. Built-in statement types were restored.');
    });
  }

  return { render, wire };
}
