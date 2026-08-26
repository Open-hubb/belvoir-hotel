// Static SEO gate for every public URL in sitemap.xml.
//
// Run before deploy: npm run seo:check

import { readFileSync, existsSync } from 'fs';

const SITE = 'https://www.belvoir-estates.com';
const root = new URL('../', import.meta.url);
const issues = [];

function read(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

function fail(message) {
  issues.push(message);
}

function one(html, expression) {
  return (html.match(expression)?.[1]?.trim() || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function metaContent(html, attribute, value) {
  const tag = [...html.matchAll(/<meta\s+[^>]*>/gi)]
    .map(([match]) => match)
    .find((match) => new RegExp(`\\b${attribute}=["']${value}["']`, 'i').test(match));
  return tag ? one(tag, /\bcontent=["']([^"']+)["']/i) : '';
}

function pageFile(pathname) {
  if (pathname === '/') return 'index.html';
  if (pathname === '/terms') return 'terms.html';
  if (pathname === '/privacy') return 'privacy.html';
  if (pathname.startsWith('/rooms/')) return `${pathname.slice(1)}.html`;
  return '';
}

const sitemap = read('sitemap.xml');
const robots = read('robots.txt');
const llms = read('llms.txt');
const urls = [...sitemap.matchAll(/<url>\s*<loc>([^<]+)<\/loc>\s*<lastmod>([^<]+)<\/lastmod>/g)]
  .map(([, loc, lastmod]) => ({ loc, lastmod }));

if (!urls.length) fail('sitemap.xml does not contain any URLs');
if (new Set(urls.map(({ loc }) => loc)).size !== urls.length) fail('sitemap.xml contains duplicate URLs');
if (!robots.includes(`Sitemap: ${SITE}/sitemap.xml`)) fail('robots.txt does not declare the canonical sitemap URL');
if (!robots.includes('Disallow: /admin') || !robots.includes('Disallow: /api/')) {
  fail('robots.txt must keep admin and API URLs out of search');
}

const today = new Date().toISOString().slice(0, 10);
for (const { loc, lastmod } of urls) {
  if (!loc.startsWith(`${SITE}/`)) fail(`sitemap URL is not canonical: ${loc}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(lastmod) || lastmod > today) {
    fail(`sitemap lastmod is invalid or in the future for ${loc}: ${lastmod}`);
  }

  const pathname = new URL(loc).pathname;
  const file = pageFile(pathname);
  if (!file || !existsSync(new URL(`../${file}`, import.meta.url))) {
    fail(`sitemap URL has no matching published file: ${loc}`);
    continue;
  }

  const html = read(file);
  const title = one(html, /<title>([\s\S]*?)<\/title>/i);
  const description = metaContent(html, 'name', 'description');
  const canonical = one(html, /<link\s+rel=["']canonical["']\s+href=["']([^"']+)["'][^>]*>/i);
  const ogUrl = metaContent(html, 'property', 'og:url');
  const h1Count = (html.match(/<h1(?:\s|>)/gi) || []).length;
  const jsonLd = [...html.matchAll(/<script\s+type=["']application\/ld\+json["']>([\s\S]*?)<\/script>/gi)];

  if (!title || title.length > 60) fail(`${file}: title must be present and no longer than 60 characters`);
  if (!description || description.length > 160) fail(`${file}: description must be present and no longer than 160 characters`);
  if (canonical !== loc) fail(`${file}: canonical must equal ${loc}`);
  if (ogUrl !== loc) fail(`${file}: og:url must equal the canonical URL`);
  if (h1Count !== 1) fail(`${file}: expected exactly one H1, found ${h1Count}`);
  if (/name=["']robots["'][^>]*noindex/i.test(html)) fail(`${file}: sitemap page must not be noindex`);
  for (const [, block] of jsonLd) {
    try {
      JSON.parse(block);
    } catch {
      fail(`${file}: invalid JSON-LD`);
    }
  }

  if (pathname.startsWith('/rooms/')) {
    const roomSchema = jsonLd.some(([, block]) => {
      try {
        return JSON.parse(block)['@graph']?.some((entry) => entry['@type'] === 'HotelRoom');
      } catch {
        return false;
      }
    });
    if (!roomSchema) fail(`${file}: room page is missing HotelRoom structured data`);
    if (!llms.includes(`](${loc})`)) fail(`llms.txt does not link to ${loc}`);
  }
}

const home = read('index.html');
if (!/"@type":\s*"Hotel"/.test(home)) fail('homepage is missing Hotel structured data');
if (!/"@type":\s*"WebSite"/.test(home)) fail('homepage is missing WebSite structured data');
if (!/Freetown/i.test(one(home, /<title>([\s\S]*?)<\/title>/i))) fail('homepage title must mention Freetown');
if (!/serviced apartments/i.test(metaContent(home, 'name', 'description'))) {
  fail('homepage description must mention serviced apartments');
}

if (issues.length) {
  console.error('SEO checks failed:\n');
  for (const issue of issues) console.error(`- ${issue}`);
  process.exit(1);
}

console.log(`SEO checks passed for ${urls.length} sitemap URLs.`);
