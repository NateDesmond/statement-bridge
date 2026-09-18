// Settings screen: preferences, saved exchange rates, storage usage split,
// Clear sessions / Erase everything, and the export column-layout editor.

import { clearAllSessions } from '../core/sessions.js';
import { computeStorageSplit, formatBytes } from './storage-usage.js';
import { newPreset, validatePreset, dedupeColumns, renderPresetEditor as renderPresetEditorInto } from './preset-editor.js';
import { DEFAULT_PRESET } from '../core/export.js';
import { loadProfiles } from '../core/profiles.js';
import { asText as debugLogText, clear as clearDebugLog, log } from '../core/debuglog.js';
import { announce, fitTwoColumnGrid } from './nav.js';

const $ = (sel) => document.querySelector(sel);
const PRESETS_KEY = 'presets';
const SETTINGS_KEY = 'settings';
const RATES_KEY = 'rates';

export function createSettingsScreen({ storage, sessionStore, getSampleRows, onCleared, onOpenReport }) {
  let presets = [];
  let editingIdx = 0; // which saved preset the working draft is based on
  let working = null; // the live-edited preset (controlled by preset-editor.js)
  let dirty = false;
  let profilesCache = []; // for the preset editor's extra_* column discovery

  async function loadPresets() {
    const stored = await storage.get(PRESETS_KEY);
    presets = stored
      ? stored.map((p) => ({ ...p, columns: dedupeColumns(p.columns) }))
      : [{ ...DEFAULT_PRESET, columns: dedupeColumns(DEFAULT_PRESET.columns), name: 'Default Statement Bridge columns' }];
  }

  function renderPresetSelect() {
    const select = $('#preset-select');
    select.innerHTML = '';
    presets.forEach((p, idx) => {
      const opt = document.createElement('option');
      opt.value = String(idx); opt.textContent = p.name;
      if (idx === editingIdx && !dirty) opt.selected = true;
      select.appendChild(opt);
    });
    if (dirty) {
      const opt = document.createElement('option');
      opt.value = 'custom'; opt.textContent = 'Custom (unsaved)'; opt.selected = true;
      select.appendChild(opt);
    }
    // Item 6: "Start from" only matters the first time there's no working
    // set to resume yet (a fresh install, or after Delete everything) - Home
    // otherwise always reopens with the persisted "Last used" working set.
    const prefSelect = $('#pref-default-preset');
    prefSelect.innerHTML = '<option value="">Last used (default)</option>'
      + presets.map((p, idx) => `<option value="${idx}">${p.name}</option>`).join('');
  }

  function markDirty() {
    dirty = true;
    $('#preset-dirty-note').hidden = false;
    $('#preset-revert-link').textContent = `Revert to ${presets[editingIdx].name}`;
    renderPresetSelect();
  }

  function setWorking(next) {
    working = next;
    if (!dirty) markDirty();
    renderPresetEditor();
  }

  function renderPresetEditor() {
    $('#preset-name').value = working.name;
    renderPresetEditorInto({
      container: $('#preset-editor-container'),
      preset: working,
      sampleRows: getSampleRows?.() || [],
      profiles: profilesCache,
      onChange: setWorking,
    });
    fitTwoColumnGrid(document.querySelector('#screen-settings .settings-grid'));
  }

  async function savePresets() { await storage.set(PRESETS_KEY, presets); }

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
    await loadPresets();
    profilesCache = await loadProfiles(storage);
    editingIdx = 0; dirty = false;
    working = { ...presets[editingIdx] };
    $('#preset-dirty-note').hidden = true;
    renderPresetSelect();
    renderPresetEditor();
    await renderPreferences();
    await renderRates();
    await renderStorage();
    fitTwoColumnGrid(document.querySelector('#screen-settings .settings-grid'));
  }

  function wire() {
    $('#preset-select').addEventListener('change', (e) => {
      if (e.target.value === 'custom') return; // synthetic option, not a real choice
      editingIdx = Number(e.target.value);
      dirty = false;
      working = { ...presets[editingIdx] };
      $('#preset-dirty-note').hidden = true;
      renderPresetSelect();
      renderPresetEditor();
    });
    $('#preset-name').addEventListener('input', (e) => { setWorking({ ...working, name: e.target.value }); });
    $('#preset-revert-link').addEventListener('click', () => {
      dirty = false;
      working = { ...presets[editingIdx] };
      $('#preset-dirty-note').hidden = true;
      renderPresetSelect();
      renderPresetEditor();
    });
    $('#preset-new-btn').addEventListener('click', () => {
      setWorking(newPreset(`Column layout ${presets.length + 1}`));
    });
    $('#preset-save-btn').addEventListener('click', async () => {
      const result = validatePreset(working);
      if (!result.ok) { alert(result.reason); return; }
      const existingIdx = presets.findIndex((p) => p.name === working.name);
      if (existingIdx !== -1) presets[existingIdx] = working;
      else presets.push(working);
      await savePresets();
      editingIdx = existingIdx !== -1 ? existingIdx : presets.length - 1;
      dirty = false;
      $('#preset-dirty-note').hidden = true;
      renderPresetSelect();
      renderPresetEditor();
      announce(`Column layout "${working.name}" saved.`);
      alert('Column layout saved.');
    });

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
      await storage.remove(PRESETS_KEY);
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
