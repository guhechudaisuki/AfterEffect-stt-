"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), url = require("node:url");
const chromium = require("playwright-core").chromium;
const root = path.resolve(__dirname, "../..");
const browserPath = process.env.LWS_BROWSER_PATH || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
test("correction and completion controls work independently across source/single/bilingual and stay compact", { skip: !fs.existsSync(browserPath) }, async () => {
  const browser = await chromium.launch({ executablePath: browserPath, headless: true });
  try {
    for (const host of ["AEFT", "PPRO"]) {
      const page = await browser.newPage({ viewport: { width: 380, height: 900 } });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(url.pathToFileURL(path.join(root, "extension/index.html")).href + "?mock=" + host);
      assert.equal(await page.locator("#enableCorrectionInput").isChecked(), false);
      assert.equal(await page.locator("#correctionColorInput").inputValue(), "#0000ff");
      assert.equal(await page.locator("#providerDetails").isVisible(), false);
      await page.locator("#enableCorrectionInput").check();
      await page.locator("#allowCompletionInput").check();
      for (const mode of ["single", "bilingual", "source"]) {
        await page.locator('[data-translation-mode="' + mode + '"]').click();
        assert.equal(await page.locator("#correctionOptions").isVisible(), true);
        assert.equal(await page.locator("#providerDetails").isVisible(), true);
        assert.equal(await page.locator("#allowCompletionInput").isChecked(), true);
      }
      await page.locator("#correctionColorInput").fill("#0088ee");
      await page.locator("#providerDetails").evaluate((element) => { element.open = true; });
      const metrics = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
      assert.equal(metrics.scroll, metrics.width);
      if (host === "PPRO") assert.match(await page.locator("#correctionHostNote").textContent(), /不支持逐字颜色/);
      await page.screenshot({ path: path.join(root, "artifacts/ui/correction-" + host + ".png"), fullPage: true });
      await page.locator("#enableCorrectionInput").uncheck();
      assert.equal(await page.locator("#correctionOptions").isVisible(), false);
      assert.equal(await page.locator("#providerDetails").isVisible(), false);
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); }
});
