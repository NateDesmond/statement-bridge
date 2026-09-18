// Generate app-icon candidates via Gemini image generation.
// Usage: GEMINI_API_KEY=... node gen.mjs <outfile> "<prompt>" [model]
// Reads GEMINI_API_KEY or GOOGLE_API_KEY from the environment (or an
// .env.local in this directory, if present) - never a hardcoded path.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const localEnvPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '.env.local');
if (fs.existsSync(localEnvPath)) {
  for (const line of fs.readFileSync(localEnvPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error('No API key found in .env.local');

const [outFile, prompt, model = 'gemini-3-pro-image'] = process.argv.slice(2);
if (!outFile || !prompt) throw new Error('Usage: node gen.mjs <outfile> "<prompt>" [model]');

const body = {
  contents: [{ role: 'user', parts: [{ text: prompt }] }],
  generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '1:1' } },
};

const res = await fetch(`${BASE}/${model}:generateContent?key=${apiKey}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const json = await res.json();
if (!res.ok) {
  console.error('ERROR', JSON.stringify(json).slice(0, 800));
  process.exit(1);
}
const parts = json?.candidates?.[0]?.content?.parts || [];
const img = parts.find((p) => p.inlineData?.data);
if (!img) {
  const txt = parts.map((p) => p.text).filter(Boolean).join(' ');
  console.error('NO_IMAGE', txt || JSON.stringify(json).slice(0, 400));
  process.exit(1);
}
fs.writeFileSync(outFile, Buffer.from(img.inlineData.data, 'base64'));
console.log('OK', outFile, model);
