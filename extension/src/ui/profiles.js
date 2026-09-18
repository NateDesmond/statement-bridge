// Profiles screen: bank groups, per-version actions, backup/restore JSON,
// and the entry point into the mapping wizard ("Map a new statement").

import {
  loadProfiles, deleteProfile, duplicateProfile, updateProfile, serializeBackup, restoreBackup,
} from '../core/profiles.js';
import { profileHealthLabel } from '../core/home-state.js';
import { fitTwoColumnGrid } from './nav.js';

const $ = (sel) => document.querySelector(sel);

export function createProfilesScreen({ storage, onMapNewStatement }) {
  /** @param {string} [focusProfileId] - item 2's "Fix or delete" deep link: scrolled to and highlighted once rendered. */
  async function render(focusProfileId) {
    const profiles = await loadProfiles(storage);
    const container = $('#profiles-list');
    container.innerHTML = '';
    const byBank = new Map();
    for (const p of profiles) {
      const key = p.bank || 'Other';
      byBank.set(key, [...(byBank.get(key) || []), p]);
    }
    for (const [bank, group] of byBank) {
      const totalVersions = group.reduce((n, p) => n + p.versions.length, 0);
      const wrap = document.createElement('div');
      wrap.className = 'bank-group';
      wrap.innerHTML = `<h3>${escapeHtml(bank)} <span class="badge badge-ok">${totalVersions} version${totalVersions === 1 ? '' : 's'}</span></h3>`;
      for (const profile of group) {
        profile.versions.forEach((version, vIdx) => {
          const row = document.createElement('div');
          row.className = 'version-row';
          if (profile.id === focusProfileId) row.classList.add('version-row-focused');
          const isCurrent = vIdx === profile.versions.length - 1;
          const created = version.createdAt ? new Date(version.createdAt).toLocaleDateString() : 'unknown date';
          // Item 3: a per-version health line from the last time it was
          // actually applied to a file ("Last used: 310 of 310 rows read" /
          // "Last used: amounts missing on 309 of 314 rows") - null (no line)
          // for a version that has never been used.
          const health = profileHealthLabel(version.lastUsed);
          row.innerHTML = `
            <div>
              <strong>${escapeHtml(profile.name)}${profile.versions.length > 1 ? ` (v${vIdx + 1})` : ''}</strong>
              <div class="vr-meta">${isCurrent ? 'Current version' : 'Superseded'}, created ${created}</div>
              ${health ? `<div class="vr-meta vr-health">${escapeHtml(health)}</div>` : ''}
            </div>
            <div class="vr-actions"></div>
          `;
          const actions = row.querySelector('.vr-actions');
          if (!profile.builtIn) {
            actions.appendChild(makeBtn('Rename', async () => {
              const name = prompt('New name', profile.name);
              if (name) { await updateProfile(storage, profile.id, { name }); await render(); }
            }));
            actions.appendChild(makeBtn('Duplicate', async () => { await duplicateProfile(storage, profile.id); await render(); }));
            actions.appendChild(makeBtn('Delete', async () => {
              if (!confirm(`Delete statement type "${profile.name}"?`)) return;
              await deleteProfile(storage, profile.id); await render();
            }, true));
          } else {
            actions.appendChild(makeBtn('Duplicate', async () => { await duplicateProfile(storage, profile.id); await render(); }));
          }
          wrap.appendChild(row);
        });
      }
      container.appendChild(wrap);
    }
    if (!profiles.length) container.innerHTML = '<p class="pdf-anchor-hint">No statement types yet. Map a statement to create one.</p>';
    fitTwoColumnGrid(document.querySelector('#screen-profiles .settings-grid'));
    if (focusProfileId) container.querySelector('.version-row-focused')?.scrollIntoView({ block: 'center' });
  }

  function makeBtn(label, onclick, danger) {
    const btn = document.createElement('button');
    btn.className = danger ? 'icon-btn danger' : 'icon-btn';
    btn.type = 'button'; btn.textContent = label; btn.onclick = onclick;
    return btn;
  }

  function escapeHtml(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

  function wire() {
    $('#map-new-statement-btn').addEventListener('click', () => onMapNewStatement());
    $('#profiles-backup-btn').addEventListener('click', async () => {
      const profiles = await loadProfiles(storage);
      const json = serializeBackup(profiles);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'statement-bridge-statement-types-backup.json'; a.click();
      URL.revokeObjectURL(url);
    });
    $('#profiles-restore-btn').addEventListener('click', () => $('#profiles-restore-input').click());
    $('#profiles-restore-input').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const text = await file.text();
      await restoreBackup(storage, text);
      await render();
    });
  }

  return { render, wire };
}
