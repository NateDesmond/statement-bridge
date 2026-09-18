import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMemorySessionStore, cleanupOldSessions, sessionsNearingDeletion,
  saveSession, touchSession, clearAllSessions, autosaveMappingProgress, storageUsageEstimate,
} from '../src/core/sessions.js';

function daysAgoISO(days, now = new Date()) {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

test('saveSession stamps lastOpened', async () => {
  const store = createMemorySessionStore();
  const saved = await saveSession(store, { id: 's1', rows: [] });
  assert.ok(saved.lastOpened);
  assert.deepEqual(await store.get('s1'), saved);
});

test('cleanupOldSessions deletes sessions older than 30 days', async () => {
  const store = createMemorySessionStore();
  const now = new Date('2026-09-16T00:00:00Z');
  await store.put({ id: 'old', lastOpened: daysAgoISO(31, now) });
  await store.put({ id: 'fresh', lastOpened: daysAgoISO(5, now) });
  const deleted = await cleanupOldSessions(store, now);
  assert.deepEqual(deleted, ['old']);
  assert.equal(await store.get('old'), undefined);
  assert.ok(await store.get('fresh'));
});

test('sessionsNearingDeletion flags the 25-30 day window', async () => {
  const store = createMemorySessionStore();
  const now = new Date('2026-09-16T00:00:00Z');
  await store.put({ id: 'warn', lastOpened: daysAgoISO(26, now) });
  await store.put({ id: 'safe', lastOpened: daysAgoISO(10, now) });
  const warnings = await sessionsNearingDeletion(store, now);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].id, 'warn');
  assert.equal(warnings[0].daysRemaining, 4);
});

test('touchSession updates lastOpened for an existing session', async () => {
  const store = createMemorySessionStore();
  await store.put({ id: 's1', lastOpened: daysAgoISO(10) });
  const touched = await touchSession(store, 's1', new Date());
  assert.ok(touched.lastOpened);
  assert.equal(touched.id, 's1');
});

test('touchSession returns null for missing session', async () => {
  const store = createMemorySessionStore();
  assert.equal(await touchSession(store, 'missing'), null);
});

test('clearAllSessions empties the store', async () => {
  const store = createMemorySessionStore();
  await store.put({ id: 'a', lastOpened: new Date().toISOString() });
  await store.put({ id: 'b', lastOpened: new Date().toISOString() });
  const count = await clearAllSessions(store);
  assert.equal(count, 2);
  assert.deepEqual(await store.getAll(), []);
});

test('autosaveMappingProgress creates or updates the session with progress', async () => {
  const store = createMemorySessionStore();
  const updated = await autosaveMappingProgress(store, 'new-session', { step: 3 });
  assert.deepEqual(updated.mappingProgress, { step: 3 });
  assert.equal((await store.get('new-session')).mappingProgress.step, 3);
});

test('storageUsageEstimate returns null when navigator.storage is unavailable', async () => {
  assert.equal(await storageUsageEstimate({}), null);
});

test('storageUsageEstimate reads usage/quota when available', async () => {
  const nav = { storage: { estimate: async () => ({ usage: 100, quota: 1000 }) } };
  assert.deepEqual(await storageUsageEstimate(nav), { usage: 100, quota: 1000 });
});

test('cleanupOldSessions keeps a session at exactly 30 days old (boundary is exclusive)', async () => {
  const store = createMemorySessionStore();
  const now = new Date('2026-09-16T00:00:00Z');
  await store.put({ id: 'exactly-30', lastOpened: daysAgoISO(30, now) });
  const deleted = await cleanupOldSessions(store, now);
  assert.deepEqual(deleted, []);
  assert.ok(await store.get('exactly-30'));
});

test('cleanupOldSessions deletes a session just past 30 days', async () => {
  const store = createMemorySessionStore();
  const now = new Date('2026-09-16T00:00:00Z');
  await store.put({ id: 'past-30', lastOpened: daysAgoISO(30.001, now) });
  const deleted = await cleanupOldSessions(store, now);
  assert.deepEqual(deleted, ['past-30']);
});

test('sessionsNearingDeletion excludes a session just under 25 days old', async () => {
  const store = createMemorySessionStore();
  const now = new Date('2026-09-16T00:00:00Z');
  await store.put({ id: 'under-25', lastOpened: daysAgoISO(24.9, now) });
  const warnings = await sessionsNearingDeletion(store, now);
  assert.deepEqual(warnings, []);
});

test('sessionsNearingDeletion includes a session at exactly 25 days with 5 days remaining', async () => {
  const store = createMemorySessionStore();
  const now = new Date('2026-09-16T00:00:00Z');
  await store.put({ id: 'exactly-25', lastOpened: daysAgoISO(25, now) });
  const warnings = await sessionsNearingDeletion(store, now);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].daysRemaining, 5);
});

test('sessionsNearingDeletion still reports a session at exactly 30 days (0 days remaining) right up until cleanup deletes it', async () => {
  const store = createMemorySessionStore();
  const now = new Date('2026-09-16T00:00:00Z');
  await store.put({ id: 'exactly-30b', lastOpened: daysAgoISO(30, now) });
  const warnings = await sessionsNearingDeletion(store, now);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].daysRemaining, 0);
});
