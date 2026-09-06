import { test, expect } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs/promises';

// Real native multipart navigation, with the response withheld until teardown.
async function fixture(page, kind, file) {
  const posts = [];
  const responses = [];
  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      posts.push({ url: req.url, type: req.headers['content-type'], body });
      responses.push(res);
      return;
    }
    if (req.url.startsWith('/client/')) {
      const name = req.url.slice('/client/'.length);
      if (!/^[a-z-]+\.js$/.test(name)) { res.writeHead(404).end(); return; }
      res.setHeader('Content-Type', 'text/javascript');
      res.end(await fs.readFile(new URL(`../../src/static/client/${name}`, import.meta.url)));
      return;
    }
    const form = (id) => `<iframe name="target${id}"></iframe><form id="${id}" target="target${id}" action="/save/${id}" method="post" enctype="multipart/form-data">
      <input name="title" required value="Book"><input type="file" name="cover">
      <input name="expectedCoverKind" value="${kind}" type="hidden">
      <input name="expectedCoverId" value="42" type="hidden">
      <input name="coverReplacementConfirmed" value="false" type="hidden">
      <button name="intent" value="save" formaction="/explicit/${id}">Save</button></form>`;
    res.setHeader('Content-Type', 'text/html');
    res.end(`${form('first')}${form('second')}<script type="module">
      import { enhanceBookCoverUploads } from '/client/book-cover-upload.js';
      enhanceBookCoverUploads(); window.ready = true;
    </script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => window.ready);
    if (file) await page.locator('#first input[type=file]').setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: Buffer.from('cover bytes') });
  } catch (error) {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); throw error;
  }
  return { posts, close: async () => {
    for (const res of responses) res.writeHead(204).end();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  } };
}

for (const [label, kind, file] of [
  ['New first cover', 'none', true], ['Edit no cover upload', 'none', true],
  ['Edit text only existing cover', 'project_asset', false],
  ['Edit text only no cover', 'none', false], ['New no cover', 'none', false],
]) {
  test(`${label}: two physical clicks send one multipart POST`, async ({ page }) => {
    const f = await fixture(page, kind, file);
    try {
      await page.locator('#first button').click();
      await expect.poll(() => f.posts.length).toBe(1);
      await page.locator('#first button').click();
      await page.waitForTimeout(150);
      expect(f.posts).toHaveLength(1);
      expect(f.posts[0].type).toContain('multipart/form-data; boundary=');
      expect(f.posts[0].url).toBe('/explicit/first');
      expect(f.posts[0].body).toContain('name="intent"\r\n\r\nsave');
      if (file) expect(f.posts[0].body).toContain('cover bytes');
      await page.locator('#first input[type=file]').setInputFiles([]);
      await page.locator('#first button').click();
      await page.locator('#second button').click();
      await expect.poll(() => f.posts.length).toBe(2);
      expect(f.posts[1].url).toBe('/explicit/second');
      await page.waitForTimeout(150);
      expect(f.posts).toHaveLength(2);
    } finally { await f.close(); }
  });
}

test('invalid native attempt remains retryable after correction', async ({ page }) => {
  const f = await fixture(page, 'none', true);
  try {
    await page.locator('#first input[name=title]').fill('');
    await page.locator('#first button').click();
    expect(f.posts).toHaveLength(0);
    await page.locator('#first input[name=title]').fill('Corrected');
    await page.locator('#first button').click();
    await expect.poll(() => f.posts.length).toBe(1);
    await page.locator('#first button').click();
    await page.waitForTimeout(150);
    expect(f.posts).toHaveLength(1);
  } finally { await f.close(); }
});

for (const mode of ['Enter', 'without submitter']) {
  test(`${mode} keeps native semantics and guards repeated attempts`, async ({ page }) => {
    const f = await fixture(page, 'none', false);
    const submit = () => mode === 'Enter'
      ? page.locator('#first input[name=title]').press('Enter')
      : page.evaluate(() => document.querySelector('#first').requestSubmit());
    try {
      await submit();
      await expect.poll(() => f.posts.length).toBe(1);
      await submit();
      await page.waitForTimeout(150);
      expect(f.posts).toHaveLength(1);
      expect(f.posts[0].url).toBe(mode === 'Enter' ? '/explicit/first' : '/save/first');
      expect(f.posts[0].body.includes('name="intent"')).toBe(mode === 'Enter');
    } finally { await f.close(); }
  });
}
