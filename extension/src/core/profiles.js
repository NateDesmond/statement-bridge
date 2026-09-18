// Profile CRUD (chrome.storage.local via a storage adapter), matching, backup/restore.

import { builtinProfiles } from './builtin-profiles.js';
import { BANK_NAMES } from './suggest.js';

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

const STORAGE_KEY = 'profiles';
export const MATCH_THRESHOLD = 0.7;

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// A profile set already seeded on a prior load is never re-seeded, so a
// builtin profile/version added or refined in a later code update (e.g.
// builtin-dbs-savings-v2-real, added after v1 shipped) silently never
// reaches an install that seeded before it existed - the stored copy is
// frozen at seed time forever. Root cause of a real regression: a device
// that had already seeded profiles kept matching a real DBS export against
// its stale, pre-v2 builtin-dbs-savings only, long after the code gained
// the version that actually matches it. Missing builtin profiles/versions
// are appended by id on every load; an existing builtin version already in
// storage (learned alternatives, edits, all of it) is never touched or
// replaced, and user-created (non-builtin) profiles are untouched too.
function mergeBuiltinUpdates(stored, seeded) {
  let changed = false;
  const profiles = stored.map((p) => ({ ...p, versions: [...p.versions] }));
  const byId = new Map(profiles.map((p) => [p.id, p]));
  for (const seededProfile of seeded) {
    const existing = byId.get(seededProfile.id);
    if (!existing) {
      profiles.push(seededProfile);
      byId.set(seededProfile.id, seededProfile);
      changed = true;
      continue;
    }
    const versionIds = new Set(existing.versions.map((v) => v.id));
    for (const seededVersion of seededProfile.versions) {
      if (!versionIds.has(seededVersion.id)) {
        existing.versions.push(seededVersion);
        changed = true;
      }
    }
  }
  return { profiles, changed };
}

export async function loadProfiles(storage) {
  const stored = await storage.get(STORAGE_KEY);
  const seeded = builtinProfiles();
  if (!stored) {
    await storage.set(STORAGE_KEY, seeded);
    return seeded;
  }
  const { profiles, changed } = mergeBuiltinUpdates(stored, seeded);
  if (changed) await storage.set(STORAGE_KEY, profiles);
  return profiles;
}

async function saveProfiles(storage, profiles) {
  await storage.set(STORAGE_KEY, profiles);
  return profiles;
}

export async function createProfile(storage, profile) {
  const profiles = await loadProfiles(storage);
  const withId = { schemaVersion: 1, builtIn: false, versions: [], ...profile, id: profile.id || uuid() };
  profiles.push(withId);
  await saveProfiles(storage, profiles);
  return withId;
}

export async function updateProfile(storage, id, patch) {
  const profiles = await loadProfiles(storage);
  const idx = profiles.findIndex((p) => p.id === id);
  if (idx === -1) throw new Error(`Profile not found: ${id}`);
  profiles[idx] = { ...profiles[idx], ...patch, id };
  await saveProfiles(storage, profiles);
  return profiles[idx];
}

export async function deleteProfile(storage, id) {
  const profiles = await loadProfiles(storage);
  const next = profiles.filter((p) => p.id !== id);
  await saveProfiles(storage, next);
  return next;
}

export async function duplicateProfile(storage, id, nameSuffix = ' (copy)') {
  const profiles = await loadProfiles(storage);
  const original = profiles.find((p) => p.id === id);
  if (!original) throw new Error(`Profile not found: ${id}`);
  const copy = {
    ...JSON.parse(JSON.stringify(original)),
    id: uuid(),
    name: original.name + nameSuffix,
    builtIn: false,
  };
  profiles.push(copy);
  await saveProfiles(storage, profiles);
  return copy;
}

/**
 * Item 3: stamp a version's `lastUsed` extraction summary (home-state.js's
 * summarizeExtraction shape) after a real apply - the Profiles screen's
 * per-version health line reads this back. Best-effort: swallows a "not
 * found" (a version deleted/superseded mid-flight should never crash the
 * apply it's just trying to record stats for).
 * @param {object} storage
 * @param {string} profileId
 * @param {string} versionId
 * @param {{rows:number, validRows:number, missingAmountRows:number, unparseableDateRows:number, at:string}} lastUsed
 */
export async function updateVersionLastUsed(storage, profileId, versionId, lastUsed) {
  const profiles = await loadProfiles(storage);
  const profile = profiles.find((p) => p.id === profileId);
  const version = profile?.versions.find((v) => v.id === versionId);
  if (!version) return;
  version.lastUsed = lastUsed;
  await saveProfiles(storage, profiles);
}

// --- Password hint per statement type (Track 2) -------------------------
// A bank's own PDF password is usually a fixed formula for that statement
// type ("your NRIC plus date of birth"), not something that changes month to
// month - once a person has typed it once, home.js's password-prompt block
// offers to remember a plain-text HINT (never the password itself) on the
// matched profile, so next month's prompt can show it back to them.

/** Save (or clear, with hint='') a profile's remembered password hint. Best-effort caller contract, same shape as updateVersionLastUsed. */
export async function setProfilePasswordHint(storage, profileId, hint) {
  return updateProfile(storage, profileId, { passwordHint: hint || '' });
}

/**
 * Best-effort guess of which saved profile an ENCRYPTED file belongs to, from
 * its filename alone - there is no header/preamble/pdf text to score against
 * before it's unlocked (matchProfile needs page text that doesn't exist yet).
 * Used only to decide which profile's passwordHint (if any) to show at the
 * password prompt; never to auto-apply a mapping - a real match still runs
 * the normal way once the file is decrypted.
 * @param {string} filename
 * @param {object[]} profiles
 * @returns {object|null}
 */
export function guessProfileByFilename(filename, profiles) {
  // Only a PDF can ever be password-protected in the first place, so a CSV/
  // xlsx profile's own hint (if it somehow had one) is never a candidate.
  const withHint = profiles.filter((p) => p.passwordHint && p.fileType === 'pdf');
  for (const profile of withHint) {
    for (const version of profile.versions) {
      if (filenameScore(version.signatures?.filenamePattern, filename)) return profile;
    }
  }
  // No filename match - and a PDF profile often has no filenamePattern at
  // all (pdfAnchors/preamble carry the real signal for a PDF, not its
  // filename), so that's the common case here, not the exception. If
  // exactly one PDF profile has ever taught this app a password hint, a
  // newly locked file is a reasonable guess to be the same statement type;
  // two or more is ambiguous, so show nothing rather than guess wrong.
  return withHint.length === 1 ? withHint[0] : null;
}

export async function addVersion(storage, profileId, version) {
  const profiles = await loadProfiles(storage);
  const profile = profiles.find((p) => p.id === profileId);
  if (!profile) throw new Error(`Profile not found: ${profileId}`);
  const withId = { createdAt: new Date().toISOString(), ...version, id: version.id || uuid() };
  profile.versions.push(withId);
  await saveProfiles(storage, profiles);
  return withId;
}

// --- Signature generation (wizard Save step) ---------------------------
// A saved profile is only useful if it matches the same statement again, so
// its signatures must survive a re-drop: pdfAnchors/preambleKeywords need
// stable, distinctive phrases (bank name, statement title) rather than
// anything that changes month to month (dates, amounts, account numbers).

// ponytail: a digit-run and a short address/name keyword list, not a real
// PII detector - covers the common cases (dates, amounts, account/phone
// numbers, "Blk 123 X Street", "Mr/Mrs/Ms Name"); extend the list if a
// real bank statement's preamble slips something else through.
const DIGIT_HEAVY_RE = /\d{2,}/;
const PERSONAL_DATA_RE = /\b(address|blk|street|avenue|road|jalan|unit|postal|singapore \d|mr|mrs|ms|dear|attn)\b/i;
// A bare account-holder name (printed ALL CAPS, no digits, no bank/statement
// vocabulary - "JANE SAMPLE TAN") has no other tell a digit/keyword scan
// would catch. Never exclude a real ALL-CAPS bank title this way (some banks
// print theirs in caps too) - only when none of the words are ordinary
// statement vocabulary.
const ALL_CAPS_WORDS_RE = /^[A-Z][A-Z.'-]*(?:\s+[A-Z][A-Z.'-]*){1,3}$/;
const STATEMENT_VOCAB_RE = /\b(bank|ltd|pte|account|statement|transaction|history|savings|current|credit|card|multiplier|deposit|ibanking|digibank|branch|swift|iban)\b/i;

// Item 7: a candidate anchor phrase is only usable if it's either a known
// statement/bank phrase, or one whose own tokens actually repeat somewhere
// in the file (garbage OCR text like "Ross Ion Telesty" is single-shot
// noise that never repeats and names no known bank/statement vocabulary).
const KNOWN_ANCHOR_PHRASE_RE = /\b(transaction history|statement|account|savings|credit card)\b/i;

function bankNameInText(text) {
  return BANK_NAMES.some((b) => new RegExp(`\\b${escapeRe(b)}\\b`, 'i').test(text));
}

function tokenize(text) {
  return String(text || '').match(/[a-z0-9]+/gi) || [];
}

/**
 * Plausibility check for a candidate pdfAnchor/preambleKeyword phrase: pass
 * if the phrase itself carries a known bank name or statement-type phrase,
 * otherwise only if every one of its word tokens appears at least twice
 * across the given corpus (the whole file's pages, or the candidate pool
 * itself when no wider corpus is given).
 * @param {string} phrase
 * @param {string} [corpusText]
 */
export function isPlausibleAnchorPhrase(phrase, corpusText) {
  const text = String(phrase || '');
  if (!text.trim()) return false;
  if (KNOWN_ANCHOR_PHRASE_RE.test(text) || bankNameInText(text)) return true;
  const tokens = tokenize(text);
  if (!tokens.length) return false;
  const corpus = String(corpusText || text).toLowerCase();
  return tokens.every((t) => {
    const re = new RegExp(`\\b${escapeRe(t.toLowerCase())}\\b`, 'g');
    return (corpus.match(re) || []).length >= 2;
  });
}

/** Distinctiveness score for choosing among plausible anchor candidates: a phrase naming the bank or a statement-type phrase sorts first (item 7). */
function anchorDistinctiveness(text) {
  return (STATEMENT_VOCAB_RE.test(text) ? 1 : 0) + (bankNameInText(text) ? 1 : 0);
}

/**
 * Candidate signature phrases from the lines above a PDF's first transaction
 * (page 1's preamble): the bank name, statement title, account type line -
 * never a date, amount, name, address or account number (Fix 6a). At most
 * `limit` (3, item 7) are kept, the most distinctive first.
 * @param {string[]} lineTexts - page 1's lines, in order
 * @param {number} firstDataLineIdx - index of the first transaction/date-group line, or -1 if none found
 * @param {number} [limit]
 * @param {string} [allPagesText] - the whole file's text, for the plausibility repeat-count check; defaults to the candidate pool itself
 */
export function pdfAnchorCandidates(lineTexts, firstDataLineIdx, limit = 3, allPagesText = '') {
  const before = firstDataLineIdx >= 0 ? lineTexts.slice(0, firstDataLineIdx) : lineTexts;
  const corpus = allPagesText || before.join('\n');
  const seen = new Set();
  const candidates = [];
  for (const raw of before) {
    const text = String(raw || '').trim();
    if (!text || text.length > 60) continue;
    if (DIGIT_HEAVY_RE.test(text)) continue;
    if (PERSONAL_DATA_RE.test(text)) continue;
    if (ALL_CAPS_WORDS_RE.test(text) && !STATEMENT_VOCAB_RE.test(text)) continue;
    if (!isPlausibleAnchorPhrase(text, corpus)) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    candidates.push(text);
  }
  return candidates
    .map((text, idx) => ({ text, idx, score: anchorDistinctiveness(text) }))
    .sort((a, b) => b.score - a.score || a.idx - b.idx)
    .slice(0, limit)
    .map((c) => c.text);
}

const MONTH_TOKEN_RE = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*$/i;

/**
 * A filename-matching regex from one example file name, wildcarding out
 * whatever will change every month (digits, month names) and keeping only
 * the bank's own name token(s) - "statement_2026_meridian.pdf" -> "^.*meridian.*\.pdf$"
 * (item 7: generalises to a "*dbs*.pdf" style bank-token pattern, so a
 * differently-worded filename from the same bank still matches). Falls back
 * to keeping every non-digit/non-month token when no known bank name is
 * found in the filename at all.
 * @param {string} filename
 * @param {string} [bank] - a specific bank name to look for; defaults to trying every known bank
 */
export function filenameSignature(filename, bank) {
  const m = String(filename || '').match(/^(.*)\.([a-z0-9]+)$/i);
  const base = m ? m[1] : filename;
  const ext = m ? m[2] : '';
  if (!ext) return '';
  const hay = String(base || '').replace(/[_.-]/g, ' ');
  const candidates = bank ? [bank] : BANK_NAMES;
  const matchedBank = candidates.find((b) => new RegExp(`\\b${escapeRe(b)}\\b`, 'i').test(hay));
  if (matchedBank) {
    const tokens = matchedBank.toLowerCase().split(/\s+/).map((t) => escapeRe(t));
    return `^.*${tokens.join('.*')}.*\\.${ext.toLowerCase()}$`;
  }
  const tokens = String(base || '').match(/[a-z]+|\d+/gi) || [];
  const keep = tokens.filter((t) => !/^\d+$/.test(t) && !MONTH_TOKEN_RE.test(t));
  if (!keep.length) return '';
  const escaped = keep.map((t) => escapeRe(t.toLowerCase()));
  return `^.*${escaped.join('.*')}.*\\.${ext.toLowerCase()}$`;
}

// --- Matching ---------------------------------------------------------

// Header overlap is measured on normalised header TOKENS, not whole-header
// exact-string hits: "Amt SGD" and "Amount (SGD)" share no exact string but
// do share a real token ("sgd"), so a near-miss header can still get partial
// credit instead of a flat 0 (Finding 3). Scored as recall against the
// PROFILE's own signature tokens (not a symmetric Jaccard): a file with
// extra columns the profile doesn't care about (e.g. a bonus "Check or
// Slip #" column) must not be penalised for tokens it was never signed
// against.
function headerTokens(headers) {
  const tokens = new Set();
  for (const h of headers || []) {
    for (const t of String(h).toLowerCase().match(/[a-z0-9]+/g) || []) tokens.add(t);
  }
  return tokens;
}

function overlapScore(candidateHeaders, fileHeaders) {
  const candidate = headerTokens(candidateHeaders);
  const file = headerTokens(fileHeaders);
  if (!candidate.size || !file.size) return 0;
  let intersection = 0;
  for (const t of candidate) if (file.has(t)) intersection += 1;
  return intersection / candidate.size;
}

function keywordScore(keywords, haystackText) {
  if (!keywords?.length) return 0;
  const text = (haystackText || '').toLowerCase();
  const hits = keywords.filter((k) => text.includes(k.toLowerCase())).length;
  return hits / keywords.length;
}

function filenameScore(pattern, filename) {
  if (!pattern || !filename) return 0;
  try { return new RegExp(pattern, 'i').test(filename) ? 1 : 0; } catch { return 0; }
}

// --- Fuzzy pdfAnchor matching (item 7) -----------------------------------
// A saved anchor phrase must still match a slightly different OCR/re-export
// of the same statement ("Transaction Histor" for "Transaction History"): a
// plain substring check is too brittle for that, so pdfAnchors specifically
// (not preambleKeywords/CSV headers) match fuzzily - normalised Levenshtein
// distance <= 2, or >= 85% token overlap.

function normalizePhrase(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const al = a.length, bl = b.length;
  if (!al) return bl;
  if (!bl) return al;
  const dp = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) dp[j] = j;
  for (let i = 1; i <= al; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= bl; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[bl];
}

function tokenOverlapRatio(a, b) {
  const ta = new Set(normalizePhrase(a).split(' ').filter(Boolean));
  const tb = new Set(normalizePhrase(b).split(' ').filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common += 1;
  return common / Math.max(ta.size, tb.size);
}

/**
 * Whether a saved pdfAnchor phrase fuzzy-matches somewhere in a file's PDF
 * text: an exact substring, a >=85% token overlap against the whole
 * haystack, or some equal-length window of the haystack within Levenshtein
 * distance 2 of the phrase.
 * @param {string} phrase
 * @param {string} haystackText
 */
export function fuzzyPhraseInText(phrase, haystackText) {
  const needle = normalizePhrase(phrase);
  if (!needle) return false;
  const hay = normalizePhrase(haystackText);
  if (!hay) return false;
  if (hay.includes(needle)) return true;
  if (tokenOverlapRatio(phrase, haystackText) >= 0.85) return true;
  const words = hay.split(' ');
  const needleWordCount = needle.split(' ').length;
  for (let i = 0; i + needleWordCount <= words.length; i++) {
    const window = words.slice(i, i + needleWordCount).join(' ');
    if (Math.abs(window.length - needle.length) > 4) continue;
    if (levenshtein(window, needle) <= 2) return true;
  }
  return false;
}

function pdfAnchorScore(anchors, haystackText) {
  if (!anchors?.length) return 0;
  const hits = anchors.filter((a) => fuzzyPhraseInText(a, haystackText)).length;
  return hits / anchors.length;
}

// A profile's required-field column names (date/description/amount) actually
// present in the FILE's own header - not a token-overlap score, an exact
// presence check. A source can be a single column name or a list of
// alternatives (e.g. description_raw.source: ['Reference', 'Transaction
// Ref']), any one of which is enough (Finding 1: a real fixture's "Transaction
// Ref" variant must still count as present).
function sourcePresent(source, headerSet) {
  if (!source) return true;
  const names = Array.isArray(source) ? source : [source];
  return names.some((n) => headerSet.has(String(n).trim().toLowerCase()));
}

// Whether a version's date/description/amount fields all have a real column
// to read from in this file's header. When the file has no header at all
// (a PDF, matched on preamble/anchor text instead), there is nothing to
// check against, so this is trivially satisfied.
function requiredSourcesPresent(version, header) {
  if (!header?.length) return true;
  const headerSet = new Set(header.map((h) => String(h).trim().toLowerCase()));
  const fields = version.fields || {};
  const checks = [];
  if (fields.date) checks.push(sourcePresent(fields.date.source, headerSet));
  if (fields.description_raw) checks.push(sourcePresent(fields.description_raw.source, headerSet));
  if (fields.amount) {
    if (fields.amount.source) checks.push(sourcePresent(fields.amount.source, headerSet));
    else if (fields.amount.debit || fields.amount.credit) {
      checks.push(sourcePresent(fields.amount.debit, headerSet) && sourcePresent(fields.amount.credit, headerSet));
    }
  }
  return checks.length === 0 || checks.every(Boolean);
}

// A "layout changed" suggestion must be backed by the bank's own name
// actually appearing in the file (text or filename), not just any
// coincidental keyword hit: a preambleKeywords list mixing one
// distinctive phrase ("DBS Bank Ltd") with one generic banking term
// ("Cardmember") let an unrelated bank's statement clear the old
// keyword-score-only bar just by containing the generic word (Finding 3).
// Value-shape signals (amount format, CR/DR) are never part of this scoring
// at all - matchProfile only ever sees header/preamble/pdf/filename text.
function bankNamePresent(bank, fileSignals) {
  if (!bank) return false;
  const name = String(bank).toLowerCase();
  const text = `${fileSignals.preambleText || ''} ${fileSignals.pdfText || ''}`.toLowerCase();
  if (text.includes(name)) return true;
  return String(fileSignals.filename || '').toLowerCase().includes(name);
}

/**
 * Score one signature set (a version's main `signatures`, or one of its
 * learned `signatures.alternatives` - item 8) against a file's signals.
 * Pulled out of matchProfile's version loop so a version with learned
 * alternatives can be scored against each set and take the best, without
 * duplicating the weighting formula per set.
 * @param {object} sig
 * @param {object} fileSignals
 */
function scoreSignatureSet(sig, fileSignals) {
  const headerSc = overlapScore(sig.headerText, fileSignals.header);
  const preambleSc = keywordScore(sig.preambleKeywords, fileSignals.preambleText);
  const pdfSc = pdfAnchorScore(sig.pdfAnchors, fileSignals.pdfText);
  const filenameSc = filenameScore(sig.filenamePattern, fileSignals.filename);
  // Header match matters most, when there is a header row to score at
  // all: a PDF profile has no header row by definition (signatures.headerText
  // is always []), so weighting it at 60% would cap every PDF match at
  // 0.4 confidence, below MATCH_THRESHOLD, and flag it as "layout changed"
  // just for lacking a header. For those, the anchor/preamble/filename
  // signals ARE the whole match, not a corroborating 30%.
  const hasHeaderSignature = !!sig.headerText?.length;
  // A profile that defines no preamble/pdf anchor text at all (real Chase
  // exports have no preamble line above the header row - the CSV starts
  // right at the header) has nothing for that 30% slice to score: leaving
  // it at 0 permanently caps an exact header+filename match at 0.7,
  // exactly MATCH_THRESHOLD, for no reason but a signal that was never
  // applicable to this bank's export shape. When the profile has neither
  // preambleKeywords nor pdfAnchors defined, that weight folds into
  // header instead of penalising a match that has nothing else to prove
  // itself with (Finding: chase_checking.csv sat at exactly 0.70).
  const hasPreambleOrPdfSignature = !!(sig.preambleKeywords?.length || sig.pdfAnchors?.length);
  const rawConfidence = hasHeaderSignature
    ? (hasPreambleOrPdfSignature
      ? headerSc * 0.6 + Math.max(preambleSc, pdfSc) * 0.3 + filenameSc * 0.1
      : headerSc * 0.9 + filenameSc * 0.1)
    : Math.max(preambleSc, pdfSc, filenameSc);
  // A perfect header+preamble match (1*0.6 + 1*0.3) is meant to land exactly
  // at HIGH_CONFIDENCE's 0.9 threshold, but floating-point addition of 0.6
  // and 0.3 actually gives 0.8999999999999999 - a real regression seen
  // matching a real Standard Chartered export at "0.9" that then failed
  // the >= 0.9 auto-apply check by one epsilon. Rounding to 6 decimal places
  // keeps the score meaningful (no weighting here is ever finer than that)
  // while making an intended round number an exact one.
  const confidence = Math.round(rawConfidence * 1e6) / 1e6;
  const bankSignalMax = Math.max(preambleSc, pdfSc, filenameSc);
  return { confidence, hasHeaderSignature, bankSignalMax };
}

/**
 * Rank profile versions against a parsed file's signals.
 * @param {{header?: string[], preambleText?: string, pdfText?: string, filename?: string, fileType?: 'csv'|'pdf'|'xlsx'}} fileSignals
 * @param {object[]} profiles
 * @returns {{profile:object, version:object, confidence:number, formatChanged:boolean}[]}
 */
export function matchProfile(fileSignals, profiles) {
  const results = [];
  for (const profile of profiles) {
    // A dropped file's actual container format is never ambiguous the way
    // header/keyword text can be: a PDF cannot become "UOB savings, CSV" no
    // matter how strong its keyword overlap looks (and vice-versa), so this
    // check comes before any scoring, not folded into the confidence mix -
    // otherwise a strong preamble/filename match could still slip through
    // via the low-confidence `formatChanged` path below.
    if (fileSignals.fileType && profile.fileType && profile.fileType !== fileSignals.fileType) continue;
    for (const version of profile.versions) {
      const sig = version.signatures || {};
      // Item 8: score the main signature set and every learned alternative
      // (learnSignatures appends these), take whichever scores highest - a
      // version recognised by any one of its known "looks" is a match.
      const sigSets = [sig, ...(sig.alternatives || [])];
      let best = scoreSignatureSet(sigSets[0], fileSignals);
      for (let i = 1; i < sigSets.length; i++) {
        const scored = scoreSignatureSet(sigSets[i], fileSignals);
        if (scored.confidence > best.confidence) best = scored;
      }
      const { confidence, hasHeaderSignature, bankSignalMax } = best;
      // Layout-changed needs the bank's own name actually present, not just
      // any coincidental keyword hit (a preambleKeywords list mixing one
      // distinctive phrase with one generic banking term let an unrelated
      // bank clear the old keyword-score-only bar - Finding 3), and an
      // overall confidence that still falls short of a real match.
      const bankSignalStrong = bankSignalMax >= 0.5 && bankNamePresent(profile.bank, fileSignals);
      // A profile whose own required column(s) (date/description/amount)
      // aren't actually present in this file's header can never be a clean,
      // silently-applied match, no matter how high header-token overlap
      // alone scores it: those are the columns it would parse from (Finding
      // 1 - a single renamed header, "Transaction Date" -> "Txn Date", was
      // still auto-matching DBS savings and blanking every date). Confidence
      // is capped below threshold, and the candidate reads as layout-changed
      // whenever it would otherwise have looked like a real match.
      const requiredPresent = requiredSourcesPresent(version, fileSignals.header);
      let effectiveConfidence = confidence;
      let formatChanged = hasHeaderSignature && bankSignalStrong && confidence < MATCH_THRESHOLD;
      if (hasHeaderSignature && !requiredPresent) {
        effectiveConfidence = Math.min(confidence, MATCH_THRESHOLD - 0.01);
        formatChanged = confidence >= MATCH_THRESHOLD || bankSignalStrong;
      }
      results.push({ profile, version, confidence: effectiveConfidence, formatChanged });
    }
  }
  return results
    .filter((r) => r.confidence >= MATCH_THRESHOLD || r.formatChanged)
    .sort((a, b) => b.confidence - a.confidence);
}

/**
 * Item 8: fold a freshly-seen file's own signals into an existing profile
 * version as an additional alternative signature set, so a later drop of a
 * differently-worded export of the same statement (fresh preamble text, a
 * renamed file) can still match without redoing the wizard. Called from
 * Home's "Use an existing profile" flow. Applies the same plausibility
 * filter and 3-anchor cap generation uses, and derives a bank-token-only
 * filename pattern the same way. Existing signature sets (main + any prior
 * alternatives) are kept; matchProfile scores the best of all of them.
 * @param {object} storage
 * @param {string} profileId
 * @param {string} versionId
 * @param {{headerText?: string[], preambleKeywords?: string[], pdfAnchors?: string[], filename?: string}} signals
 * @returns {Promise<object>} the updated version
 */
export async function learnSignatures(storage, profileId, versionId, signals) {
  const profiles = await loadProfiles(storage);
  const profile = profiles.find((p) => p.id === profileId);
  if (!profile) throw new Error(`Profile not found: ${profileId}`);
  const version = profile.versions.find((v) => v.id === versionId);
  if (!version) throw new Error(`Version not found: ${versionId}`);
  const corpus = [...(signals.preambleKeywords || []), ...(signals.pdfAnchors || [])].join('\n');
  const learnedAnchors = (signals.pdfAnchors || [])
    .filter((a) => isPlausibleAnchorPhrase(a, corpus))
    .slice(0, 3);
  const learnedPreamble = (signals.preambleKeywords || [])
    .filter((a) => isPlausibleAnchorPhrase(a, corpus))
    .slice(0, 3);
  const alternative = {
    headerText: signals.headerText || [],
    preambleKeywords: learnedPreamble,
    pdfAnchors: learnedAnchors,
    filenamePattern: signals.filename ? filenameSignature(signals.filename, profile.bank) : '',
  };
  const sig = version.signatures || (version.signatures = {});
  sig.alternatives = [...(sig.alternatives || []), alternative];
  await saveProfiles(storage, profiles);
  return version;
}

// --- Backup / restore ---------------------------------------------------

function isValidProfile(p) {
  return p && typeof p === 'object' && typeof p.id === 'string' && typeof p.name === 'string' && Array.isArray(p.versions);
}

export function serializeBackup(profiles) {
  return JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), profiles }, null, 2);
}

/** Parse and validate a backup JSON string. Throws on anything not matching the schema; never executes code from it. */
export function parseBackup(jsonText) {
  let data;
  try { data = JSON.parse(jsonText); } catch { throw new Error('Invalid JSON'); }
  if (!data || typeof data !== 'object' || !Array.isArray(data.profiles)) throw new Error('Invalid backup: missing profiles array');
  for (const p of data.profiles) {
    if (!isValidProfile(p)) throw new Error(`Invalid backup: malformed profile ${JSON.stringify(p?.id)}`);
  }
  return data.profiles;
}

export async function restoreBackup(storage, jsonText, { merge = true } = {}) {
  const incoming = parseBackup(jsonText);
  if (!merge) { await saveProfiles(storage, incoming); return incoming; }
  const existing = await loadProfiles(storage);
  const byId = new Map(existing.map((p) => [p.id, p]));
  for (const p of incoming) byId.set(p.id, p);
  const merged = [...byId.values()];
  await saveProfiles(storage, merged);
  return merged;
}
