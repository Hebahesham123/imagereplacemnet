// Shopify Landing Image Swapper
// Select several pages -> pick an image they use -> replace it everywhere at once.
// Works on JSON page templates (templates/page.*.json) via the Shopify Admin GraphQL API.

import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listImageSlots, replaceImageRef } from './lib/templates.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const {
  SHOP,                       // e.g. naguibselim.myshopify.com
  ADMIN_TOKEN,                // shpat_...
  THEME_ID,                   // optional: numeric id; defaults to the live (MAIN) theme
  STOREFRONT_DOMAIN,          // optional: e.g. naguibselim.com (for image previews)
  APP_PASSWORD,               // optional: protects the dashboard with basic auth
  API_VERSION = '2025-10',
  PORT = 3000,
} = process.env;

if (!SHOP || !ADMIN_TOKEN) {
  console.error('Missing SHOP or ADMIN_TOKEN in .env (see .env.example)');
  process.exit(1);
}

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
app.use(express.json());

if (APP_PASSWORD) {
  app.use((req, res, next) => {
    const [, b64 = ''] = (req.headers.authorization || '').split(' ');
    const [, pass] = Buffer.from(b64, 'base64').toString().split(':');
    if (pass === APP_PASSWORD) return next();
    res.set('WWW-Authenticate', 'Basic realm="Image Swapper"').status(401).send('Auth required');
  });
}
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Shopify GraphQL ----------
async function gql(query, variables = {}) {
  const r = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': ADMIN_TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  const json = await r.json();
  if (!r.ok || json.errors) throw new Error(JSON.stringify(json.errors || json));
  return json.data;
}

let cachedThemeId = null;
async function themeGid() {
  if (THEME_ID) return `gid://shopify/OnlineStoreTheme/${THEME_ID}`;
  if (cachedThemeId) return cachedThemeId;
  const d = await gql(`{ themes(first: 1, roles: [MAIN]) { nodes { id name } } }`);
  cachedThemeId = d.themes.nodes[0].id;
  return cachedThemeId;
}

async function allPages() {
  const pages = [];
  let after = null;
  do {
    const d = await gql(
      `query($after: String) { pages(first: 250, after: $after) {
         nodes { id title handle templateSuffix }
         pageInfo { hasNextPage endCursor } } }`,
      { after }
    );
    pages.push(...d.pages.nodes);
    after = d.pages.pageInfo.hasNextPage ? d.pages.pageInfo.endCursor : null;
  } while (after);
  return pages;
}

const templateFor = (p) => (p.templateSuffix ? `templates/page.${p.templateSuffix}.json` : 'templates/page.json');

async function readThemeFiles(filenames) {
  const out = {};
  const id = await themeGid();
  for (let i = 0; i < filenames.length; i += 50) {
    const chunk = filenames.slice(i, i + 50);
    const d = await gql(
      `query($id: ID!, $f: [String!]) { theme(id: $id) { files(filenames: $f, first: 50) {
         nodes { filename body { ... on OnlineStoreThemeFileBodyText { content } } } } } }`,
      { id, f: chunk }
    );
    for (const n of d.theme.files.nodes) out[n.filename] = n.body?.content ?? null;
  }
  return out;
}

async function writeThemeFiles(files) {
  const id = await themeGid();
  const d = await gql(
    `mutation($id: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) {
       themeFilesUpsert(themeId: $id, files: $files) {
         upsertedThemeFiles { filename } userErrors { field message } } }`,
    { id, files: files.map((f) => ({ filename: f.filename, body: { type: 'TEXT', value: f.content } })) }
  );
  const errs = d.themeFilesUpsert.userErrors;
  if (errs.length) throw new Error(errs.map((e) => e.message).join('; '));
  return d.themeFilesUpsert.upsertedThemeFiles;
}

// ---------- Shopify Files (new image) ----------
async function stagedUpload(file) {
  const d = await gql(
    `mutation($input: [StagedUploadInput!]!) { stagedUploadsCreate(input: $input) {
       stagedTargets { url resourceUrl parameters { name value } } userErrors { message } } }`,
    { input: [{ filename: file.originalname, mimeType: file.mimetype, resource: 'IMAGE', httpMethod: 'POST', fileSize: String(file.size) }] }
  );
  const t = d.stagedUploadsCreate.stagedTargets[0];
  const form = new FormData();
  t.parameters.forEach((p) => form.append(p.name, p.value));
  form.append('file', new Blob([file.buffer], { type: file.mimetype }), file.originalname);
  const r = await fetch(t.url, { method: 'POST', body: form });
  if (!r.ok) throw new Error(`Upload failed: ${r.status} ${await r.text()}`);
  return t.resourceUrl;
}

async function createShopifyImage(originalSource) {
  const d = await gql(
    `mutation($files: [FileCreateInput!]!) { fileCreate(files: $files) {
       files { id } userErrors { message } } }`,
    { files: [{ originalSource, contentType: 'IMAGE' }] }
  );
  if (d.fileCreate.userErrors.length) throw new Error(d.fileCreate.userErrors.map((e) => e.message).join('; '));
  const id = d.fileCreate.files[0].id;
  // Wait until Shopify finishes processing so we know the final filename.
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const n = (await gql(
      `query($id: ID!) { node(id: $id) { ... on MediaImage { fileStatus image { url } } } }`, { id }
    )).node;
    if (n?.fileStatus === 'READY' && n.image?.url) {
      const filename = decodeURIComponent(new URL(n.image.url).pathname.split('/').pop());
      return { filename, url: n.image.url };
    }
    if (n?.fileStatus === 'FAILED') throw new Error('Shopify could not process this image');
  }
  throw new Error('Timed out waiting for Shopify to process the image');
}

// ---------- API ----------
app.get('/api/config', (_req, res) => res.json({ previewBase: `https://${STOREFRONT_DOMAIN || SHOP}/cdn/shop/files/` }));

// All pages + the images found in each page's template
app.get('/api/pages', async (_req, res) => {
  try {
    const pages = await allPages();
    const files = await readThemeFiles([...new Set(pages.map(templateFor))]);
    const usage = {};
    pages.forEach((p) => { (usage[templateFor(p)] ||= []).push(p.handle); });
    res.json(pages.map((p) => {
      const t = templateFor(p);
      const content = files[t];
      return {
        title: p.title,
        handle: p.handle,
        template: t,
        sharedWith: usage[t].filter((h) => h !== p.handle),
        missing: content == null,
        images: content ? listImageSlots(content) : [],
      };
    }).sort((a, b) => a.title.localeCompare(b.title)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Preview (dryRun) or apply a replacement
app.post('/api/apply', upload.single('file'), async (req, res) => {
  try {
    const handles = JSON.parse(req.body.handles || '[]');
    const oldImage = req.body.oldImage;
    const dryRun = req.body.dryRun === 'true';
    if (!handles.length || !oldImage) throw new Error('Select pages and the image to replace');

    const pages = (await allPages()).filter((p) => handles.includes(p.handle));
    const templates = [...new Set(pages.map(templateFor))];
    const files = await readThemeFiles(templates);

    const plan = templates.map((t) => {
      const { content, count } = files[t] ? replaceImageRef(files[t], oldImage, '__NEW__') : { count: 0 };
      return { template: t, count, pages: pages.filter((p) => templateFor(p) === t).map((p) => p.handle) };
    }).filter((x) => x.count > 0);

    if (dryRun) return res.json({ dryRun: true, plan });
    if (!plan.length) throw new Error('None of the selected pages use that image');

    // Get the new image into Shopify Files
    let newImage;
    if (req.file) newImage = await createShopifyImage(await stagedUpload(req.file));
    else if (req.body.newUrl?.startsWith('shopify://shop_images/')) newImage = { filename: req.body.newUrl.split('/').pop() };
    else if (req.body.newUrl) newImage = await createShopifyImage(req.body.newUrl.trim());
    else throw new Error('Give a new image URL or upload a file');

    // Backup, then write
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(__dirname, 'backups', stamp);
    await fs.mkdir(dir, { recursive: true });
    const updates = [];
    for (const step of plan) {
      await fs.writeFile(path.join(dir, step.template.replace(/\//g, '__')), files[step.template]);
      updates.push({ filename: step.template, content: replaceImageRef(files[step.template], oldImage, newImage.filename).content });
    }
    await writeThemeFiles(updates);
    await fs.writeFile(path.join(dir, '_log.json'), JSON.stringify({ oldImage, newImage, plan }, null, 2));
    res.json({ ok: true, newImage, plan, backup: stamp });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Undo: restore templates from a backup folder
app.get('/api/backups', async (_req, res) => {
  try {
    const dirs = (await fs.readdir(path.join(__dirname, 'backups')).catch(() => [])).sort().reverse();
    const list = [];
    for (const d of dirs.slice(0, 30)) {
      const log = JSON.parse(await fs.readFile(path.join(__dirname, 'backups', d, '_log.json'), 'utf8').catch(() => '{}'));
      list.push({ id: d, ...log });
    }
    res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/restore/:id', async (req, res) => {
  try {
    const dir = path.join(__dirname, 'backups', path.basename(req.params.id));
    const names = (await fs.readdir(dir)).filter((n) => !n.startsWith('_'));
    const files = await Promise.all(names.map(async (n) => ({ filename: n.replace(/__/g, '/'), content: await fs.readFile(path.join(dir, n), 'utf8') })));
    await writeThemeFiles(files);
    res.json({ ok: true, restored: files.map((f) => f.filename) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`Image Swapper running → http://localhost:${PORT}`));
