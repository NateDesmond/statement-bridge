#!/usr/bin/env node
// Stamps site/partials/{head,header,footer}.html into each page between
// sentinel comment markers, so the header/footer/head chrome can never drift
// between pages again (owner fix, 2026-09-18). Run by deploy.sh before every
// deploy. Idempotent: markers stay in each page, only what's between them
// gets replaced.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const partialsDir = path.join(dir, 'partials');

const header = fs.readFileSync(path.join(partialsDir, 'header.html'), 'utf8').trim();
const footer = fs.readFileSync(path.join(partialsDir, 'footer.html'), 'utf8').trim();
const headTemplate = fs.readFileSync(path.join(partialsDir, 'head.html'), 'utf8');

const SITE_ORIGIN = 'https://statementbridge.urbanalgorithm.com';

const pages = {
  'index.html': {
    title: 'Statement Bridge: bank statements to your spreadsheet',
    description: 'Drop a bank statement, get clean rows in your spreadsheet in 30 seconds. Runs on your device, no account, no server, works with banks everywhere.',
    path: '',
  },
  'privacy.html': {
    title: 'Privacy: Statement Bridge',
    description: 'Statement Bridge reads your bank statements on your device. No account, no server, nothing uploaded.',
    path: 'privacy.html',
  },
  'support.html': {
    title: 'Support: Statement Bridge',
    description: 'Get help with Statement Bridge, the bank statement to spreadsheet Chrome extension.',
    path: 'support.html',
  },
  'accessibility.html': {
    title: 'Accessibility: Statement Bridge',
    description: 'Statement Bridge is built to work with a keyboard, a screen reader, and a browser zoomed in.',
    path: 'accessibility.html',
  },
};

function stampBetween(html, marker, content) {
  const re = new RegExp(`<!-- ${marker}:START -->[\\s\\S]*?<!-- ${marker}:END -->`);
  const replacement = `<!-- ${marker}:START -->\n${content}\n<!-- ${marker}:END -->`;
  if (!re.test(html)) throw new Error(`missing ${marker} markers`);
  return html.replace(re, replacement);
}

let count = 0;
for (const [file, vars] of Object.entries(pages)) {
  const filePath = path.join(dir, file);
  let html = fs.readFileSync(filePath, 'utf8');
  const head = headTemplate
    .replaceAll('{{TITLE}}', vars.title)
    .replaceAll('{{DESCRIPTION}}', vars.description)
    .replaceAll('{{OG_URL}}', `${SITE_ORIGIN}/${vars.path}`)
    .trim();
  html = stampBetween(html, 'HEAD', head);
  html = stampBetween(html, 'HEADER', header);
  html = stampBetween(html, 'FOOTER', footer);
  fs.writeFileSync(filePath, html);
  count += 1;
}
console.log(`build.mjs: stamped head/header/footer into ${count} pages`);
