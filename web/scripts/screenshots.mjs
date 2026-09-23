// Captures the built screens against the local dev server and local Supabase
// (run `npm run dev` and `node scripts/seed-local.mjs` first). Uses the Chrome
// already installed on this machine.
//
//   node scripts/screenshots.mjs [outDir]

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { createClient } from '@supabase/supabase-js';

const BASE = 'http://localhost:5173';
const OUT = path.resolve(process.argv[2] ?? '../.local/screenshots');
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
fs.mkdirSync(OUT, { recursive: true });

const status = execFileSync('supabase', ['status', '-o', 'env'], { cwd: new URL('../..', import.meta.url), encoding: 'utf8' });
const env = Object.fromEntries(status.split('\n').map((l) => l.match(/^([A-Z_]+)="?([^"]*)"?$/)).filter(Boolean).map((m) => [m[1], m[2]]));
const admin = createClient(env.API_URL, env.SECRET_KEY, { auth: { persistSession: false } });

const DESKTOP = { width: 1440, height: 900 };
const LAPTOP = { width: 1280, height: 800 };
const MOBILE = { width: 390, height: 844 };

const browser = await chromium.launch({ executablePath: CHROME, headless: true });

async function page(viewport, { theme = 'light', mobile = false } = {}) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: mobile ? 2 : 1,
    isMobile: mobile,
    hasTouch: mobile,
    reducedMotion: 'reduce',
    colorScheme: theme,
  });
  await context.addInitScript((t) => localStorage.setItem('appearance', t), theme);
  return context.newPage();
}

async function signIn(p, email) {
  await p.goto(`${BASE}/sign-in`);
  await p.getByLabel('Email').fill(email);
  await p.getByLabel('Password', { exact: true }).fill('example-password');
  await p.getByRole('button', { name: 'Sign in' }).click();
  await p.waitForURL((u) => !u.pathname.startsWith('/sign-in'));
}

async function shot(p, name, { fullPage = true } = {}) {
  // Park the pointer on the page's top edge so no row shows a hover state.
  await p.mouse.move(1, 1);
  await p.waitForLoadState('networkidle');
  await p.waitForTimeout(400);
  const file = path.join(OUT, `${name}.png`);
  await p.screenshot({ path: file, fullPage });
  console.log('saved', path.relative(process.cwd(), file));
}

async function setWizardStep(stepId, extra = {}) {
  const { data } = await admin.auth.admin.listUsers({ perPage: 200 });
  const user = data.users.find((u) => u.email === 'new@example.com');
  await admin.from('profiles').update({ onboarding: { step_id: stepId }, ...extra }).eq('id', user.id);
}

// Sign-in
for (const [name, vp, mobile] of [['signin-desktop', DESKTOP, false], ['signin-mobile', MOBILE, true]]) {
  const p = await page(vp, { mobile });
  await p.goto(`${BASE}/sign-in`);
  await shot(p, name);
  await p.context().close();
}

// Sign-in errors: submitting the empty form names what's missing.
{
  const p = await page(DESKTOP);
  await p.goto(`${BASE}/sign-in`);
  await p.getByRole('button', { name: 'Sign in' }).click();
  await p.getByText('Enter your password.').waitFor();
  await shot(p, 'signin-error-desktop');
  await p.getByLabel('Email').fill('demo@example.com');
  await p.getByLabel('Password', { exact: true }).fill('wrong-password');
  await p.getByRole('button', { name: 'Sign in' }).click();
  await p.getByText("That email and password don't match", { exact: false }).waitFor();
  await shot(p, 'signin-error-password-desktop');
  await p.context().close();
}

// Wizard (new student)
await setWizardStep('welcome', { default_notes_provider: null, default_notes_model: null, display_name: null });
{
  const p = await page(DESKTOP);
  await signIn(p, 'new@example.com');
  await p.waitForURL('**/welcome/**');
  await shot(p, 'wizard-welcome-desktop');
  await p.getByRole('button', { name: 'Get started' }).click();
  await p.waitForURL('**/welcome/model');
  await p.getByText('Nebius Token Factory').click();
  await shot(p, 'wizard-model-desktop');
  await p.context().close();
}
await setWizardStep('extension', { default_notes_provider: 'groq', default_notes_model: 'openai/gpt-oss-120b' });
for (const [name, vp, mobile] of [['wizard-extension-desktop', DESKTOP, false], ['wizard-extension-mobile', MOBILE, true]]) {
  const p = await page(vp, { mobile });
  await signIn(p, 'new@example.com');
  await p.goto(`${BASE}/welcome/extension`);
  await shot(p, name);
  await p.context().close();
}
await setWizardStep('welcome', { default_notes_provider: null, default_notes_model: null });

// Home (seeded library)
for (const [name, vp, opts] of [
  ['desktop', DESKTOP, {}],
  ['home-laptop', LAPTOP, {}],
  ['mobile', MOBILE, { mobile: true }],
  ['home-dark-desktop', DESKTOP, { theme: 'dark' }],
]) {
  const p = await page(vp, opts);
  await signIn(p, 'demo@example.com');
  await p.waitForURL(`${BASE}/`);
  await p.getByRole('heading', { name: 'Lectures', exact: true }).waitFor();
  await shot(p, name);
  if (name === 'desktop') {
    // Full-page capture resizes the page mid-shot; keep the true first viewport too.
    await p.evaluate(() => window.scrollTo(0, 0));
    await p.screenshot({ path: path.join(OUT, 'desktop-viewport.png') });
    console.log('saved desktop-viewport.png');
  }
  if (name === 'desktop' || name === 'home-dark-desktop') {
    // The signature interaction: scrub the chapter dots of a finished lecture.
    const row = p.locator('.ep', { hasText: 'Partial derivatives' });
    await row.scrollIntoViewIfNeeded();
    await p.evaluate(() => window.scrollBy(0, 120));
    const dots = row.locator('.dots[tabindex]');
    const box = await dots.boundingBox();
    await p.mouse.move(box.x + box.width * 0.45, box.y + box.height / 2);
    await p.locator('.dots-tip').waitFor();
    const rowBox = await row.boundingBox();
    const file = name === 'desktop' ? 'home-dots-hover.png' : 'home-dots-hover-dark.png';
    await p.screenshot({
      path: path.join(OUT, file),
      clip: { x: rowBox.x, y: rowBox.y - 56, width: rowBox.width, height: rowBox.height + 64 },
    });
    console.log('saved', file);
  }
  await p.context().close();
}

// Reader and course page (seeded library)
for (const [name, vp, opts] of [
  ['reader-desktop', DESKTOP, {}],
  ['reader-mobile', MOBILE, { mobile: true }],
  ['course-desktop', DESKTOP, {}],
]) {
  const p = await page(vp, opts);
  await signIn(p, 'demo@example.com');
  await p.waitForURL(`${BASE}/`);
  if (name.startsWith('reader')) {
    await p.getByRole('link', { name: /Partial derivatives/ }).first().click();
    await p.waitForURL(/\/lectures\//);
    await p.locator('.reader h1').waitFor();
    await p.locator('.chapterbar').waitFor();
  } else {
    await p.getByRole('link', { name: /Multivariable/ }).first().click();
    await p.waitForURL(/\/courses\//);
  }
  await shot(p, name);
  await p.context().close();
}

await browser.close();
