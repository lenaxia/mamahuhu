import { expect, test } from "@playwright/test";

/**
 * E2E flows against the built SPA with a mock translation service and the
 * REAL dictionary (pinyin interpreter is fully local). One SQLite file per
 * run; tests are ordered by design (workers: 1).
 */

test.describe.configure({ mode: "serial" });

test("dad: onboarding with bpmf, pinyin ask, save", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("two quick things")).toBeVisible();

  await page.getByRole("tab", { name: "ㄅㄆㄇㄈ" }).click();
  await page.getByRole("button", { name: "Start asking" }).click();
  await expect(page.getByText("two quick things")).toBeHidden();

  await page.getByPlaceholder(/rough pinyin/).fill("wo bu zhi dao");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByText("ㄅㄨˋ").first()).toBeVisible();
  await expect(page.locator('[data-traditional="我不知道"]').first()).toBeVisible();

  await page.getByRole("button", { name: "Save" }).first().click();
  await expect(page.getByText("Saved").first()).toBeVisible();

  await page.getByRole("button", { name: "Words" }).click();
  await expect(page.locator('[data-traditional="我不知道"]').first()).toBeVisible();
});

test("mom: english translate with register toggle, save", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("devUser", "mom"));
  await page.goto("/");

  await expect(page.getByText("two quick things")).toBeVisible();
  await page.getByRole("tab", { name: "Both" }).click();
  await page.getByRole("button", { name: "Start asking" }).click();

  await page.getByPlaceholder(/rough pinyin/).fill("time for sleep");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.locator('[data-traditional^="你要睡覺"]').first()).toBeVisible();
  await expect(page.getByText("Do you want to sleep?")).toBeVisible();

  // register swap: casual question → formal statement
  await page.getByRole("tab", { name: "formal" }).click();
  await expect(page.getByText("It's time to sleep.")).toBeVisible();

  // back to casual, then save
  await page.getByRole("tab", { name: "casual" }).click();
  await page.getByRole("button", { name: "Save" }).first().click();
  await expect(page.getByText("Saved").first()).toBeVisible();
});

test("everyone view shows both users with owners", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Words" }).click();
  await expect(page.getByText("Nothing saved yet")).toBeHidden();

  await page.getByRole("tab", { name: "Everyone" }).click();
  await expect(page.locator('[data-traditional="我不知道"]').first()).toBeVisible();
  await expect(page.locator('[data-traditional^="你要睡覺"]').first()).toBeVisible();
  await expect(page.getByText("dad", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("mom", { exact: true }).first()).toBeVisible();
});

test("annotation pref persists and changes rendering", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("devUser", "mom"));
  await page.goto("/");
  await page.getByRole("button", { name: "Words" }).click();
  await expect(page.locator('[data-traditional^="你要睡覺"]').first()).toBeVisible();

  // mom is "Both": pinyin should be visible in list card
  await expect(page.getByText("shuì", { exact: false }).first()).toBeVisible();

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "ㄅㄆㄇㄈ" }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Close" }).click();

  await expect(page.getByText("shuì", { exact: false })).toHaveCount(0);
  await expect(page.getByText("ㄕㄨㄟˋ", { exact: false }).first()).toBeVisible();
});

test("photo mode: upload with mocked OCR, tap word, save", async ({ page }) => {
  await page.goto("/");
  await page.setInputFiles('input[type=file]', {
    name: "page.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wD/9k7JAAAAAElFTkSuQmCC",
      "base64",
    ),
  });
  await expect(page.locator('[data-ocr-word="睡覺"]')).toBeVisible();
  // dad already saved 睡覺 in an earlier test → badge present
  await expect(page.locator('[data-ocr-word="小貓"]')).toBeVisible();
  // unified experience: the same words are listed below the photo
  await expect(page.getByText("words", { exact: true })).toBeVisible();
  await page.locator('[data-ocr-word="小貓"]').click();
  // definition popover anchored on the image, dismissible via X
  await expect(page.getByLabel("Close")).toBeVisible();
  await expect(page.getByText("kitten").first()).toBeVisible();
  await page.getByLabel("Close").click();
  await page.locator('[data-ocr-word="小貓"]').click();
  await page.getByRole("button", { name: "Save" }).first().click();
  await expect(page.getByText("Saved").first()).toBeVisible();
});

test("history records asks, unsaved included", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("devUser", "hist"));
  await page.goto("/");
  await page.getByRole("button", { name: "Start asking" }).click();

  // an unsaved pinyin lookup
  await page.getByPlaceholder(/rough pinyin/).fill("nihao");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("ㄋㄧˇ").first()).toBeVisible();

  await page.getByRole("button", { name: "History" }).click();
  await expect(page.getByText("nihao")).toBeVisible();
  await page.locator('[data-history-item="pinyin"]').first().click();
  await expect(page.getByText("dictionary match").first()).toBeVisible();
});

test("canto: enable both varieties, ask in 粵, jyutping required, save pair", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("devUser", "canto"));
  await page.goto("/");

  // onboarding now offers varieties — enable Cantonese before starting
  await expect(page.getByText("two quick things")).toBeVisible();
  await page.getByText("廣東話 Cantonese").click();

  // single-variety user: no toggle chip yet
  await expect(page.getByRole("group", { name: "Ask variety" })).toHaveCount(0);

  await page.getByRole("button", { name: "Start asking" }).click();

  // toggle appeared, defaulting to the primary (國); switch to 粵 for this ask
  const variety = page.getByRole("group", { name: "Ask variety" });
  await expect(variety).toBeVisible();
  await variety.getByRole("button", { name: "粵" }).click();
  await expect(variety.getByRole("button", { name: "粵" })).toHaveClass(/bg-sky-500/);

  await page.getByPlaceholder(/rough pinyin/).fill("time for a bath");
  await page.getByRole("button", { name: "Send" }).click();

  // canto card: hanzi + per-char dictionary jyutping (required, full-size)
  await expect(page.locator('[data-traditional="沖涼喇"]')).toBeVisible();
  for (const syl of ["cung1", "loeng4", "laa3"]) {
    await expect(page.getByText(syl, { exact: true }).first()).toBeVisible();
  }
  await page.getByRole("tab", { name: "formal" }).click();
  await expect(page.locator('[data-traditional^="該洗澡"]')).toBeVisible();

  // save captures the spoken form + pair
  await page.getByRole("tab", { name: "casual" }).click();
  await page.getByRole("button", { name: "Save" }).first().click();
  await expect(page.getByText("Saved").first()).toBeVisible();

  // words list shows the 粵 badge and the 書面 row
  await page.getByRole("button", { name: "Words" }).click();
  await expect(page.locator('[data-traditional="沖涼喇"]').first()).toBeVisible();
  await expect(page.getByText("粵").first()).toBeVisible();
  await expect(page.getByText(/書面/).first()).toBeVisible();
});

test("english with pinyin-shaped words routes to translation, not dictionary", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("devUser", "route"));
  await page.goto("/");
  await page.getByRole("button", { name: "Start asking" }).click();

  // "time to eat" syllabifies into pinyin-ish garbage (䶑嚜哦餓啊) — must translate
  await page.getByPlaceholder(/rough pinyin/).fill("time to eat");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator('[data-traditional="你好"]')).toBeVisible();
  await expect(page.getByText("Translate as English instead")).toHaveCount(0);

  // real pinyin input still gets the dictionary view
  await page.getByLabel("Clear result").click();
  await page.getByPlaceholder(/rough pinyin/).fill("wo bu zhi dao");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator('[data-traditional="我不知道"]').first()).toBeVisible();
  await expect(page.getByText("Translate as English instead").first()).toBeVisible();
});
