// Shared storage-split calculation for the sidebar meter and the Settings
// screen: sessions (files/rows, IndexedDB) vs settings (profiles/rates/prefs,
// chrome.storage.local). Byte counts are JSON.stringify lengths, an estimate
// but a real one computed from the actual stored data, not a hardcoded number.

import { storageUsageEstimate } from '../core/sessions.js';

export async function computeStorageSplit({ storage, sessionStore }) {
  const sessions = await sessionStore.getAll().catch(() => []);
  const sessionsBytes = new TextEncoder().encode(JSON.stringify(sessions)).length;

  const [profiles, rates, prefs] = await Promise.all([
    storage.get('profiles'), storage.get('rates'), storage.get('settings'),
  ]);
  const settingsBytes = new TextEncoder().encode(JSON.stringify({ profiles, rates, prefs })).length;

  // appBytes: what OUR data actually adds up to (JSON.stringify of exactly
  // what we wrote) - the real, small number item 9's fix targets. totalBytes
  // (item 10) is the browser's own on-disk usage figure for the whole
  // origin, which can run well above appBytes (IndexedDB block allocation,
  // other site data under the same storage bucket) - the meter shows this
  // one against quota (it's what actually counts against the user's disk),
  // but a big gap from appBytes is worth a quiet context note rather than
  // implying the app itself hoarded that much statement data.
  const appBytes = sessionsBytes + settingsBytes;
  const estimate = await storageUsageEstimate().catch(() => null);
  const totalBytes = estimate?.usage ?? appBytes;
  const quotaBytes = estimate?.quota ?? null;

  return { sessionsBytes, settingsBytes, appBytes, totalBytes, quotaBytes };
}

export function formatBytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Smart-scaled size: MB under 1GB, GB at or above it - "14.9 MB" / "1.2 GB". */
export function formatBytesAuto(bytes) {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return formatBytes(bytes);
}

/** Quota rounded to a whole GB ("310 GB", never "310.5 GB") - short enough for the sidebar. */
function formatQuota(bytes) {
  const gb = bytes / (1024 * 1024 * 1024);
  return gb >= 1 ? `${Math.floor(gb)} GB` : formatBytesAuto(bytes);
}

/**
 * "0.0 MB of 310 GB used" - the sidebar meter's headline text, short enough
 * to never wrap at the fixed 216px sidebar width. Falls back to a plain
 * app-data figure when the browser can't report a quota (storageUsageEstimate
 * unavailable in this environment).
 */
export function storageMeterText(totalBytes, quotaBytes) {
  if (!quotaBytes) return `${formatBytesAuto(totalBytes)} used`;
  return `${formatBytesAuto(totalBytes)} of ${formatQuota(quotaBytes)} used`;
}

/**
 * A quiet note only when the browser's own usage figure (totalBytes) runs
 * well past what our own session+settings JSON actually accounts for
 * (appBytes) - e.g. IndexedDB's on-disk overhead - so "14.9 MB used" doesn't
 * read as 14.9 MB of statement data when the app's own data is a fraction of
 * that. Silent when the two are close (nothing to explain).
 */
export function storageContextNote(totalBytes, appBytes) {
  if (totalBytes <= appBytes * 2 || totalBytes - appBytes < 1024 * 1024) return '';
  return `Your statements and settings account for ${formatBytesAuto(appBytes)} of this; the rest is the browser's own storage overhead.`;
}
