import {chromium} from '@playwright/test';
import {readFile} from 'node:fs/promises';

const browser = await chromium.launch();
try {
  const page = await browser.newPage({deviceScaleFactor: 1});
  const svg = await readFile('store/icon.svg', 'utf8');
  for (const size of [16, 32, 48, 128]) {
    await page.setViewportSize({width: size, height: size});
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{width:100vw;height:100vh;display:block}</style>${svg}`,
    );
    await page.screenshot({path: `extension/icon-${size}.png`, omitBackground: true});
  }
} finally {
  await browser.close();
}
