import { expect, test } from "@playwright/test";

/**
 * E2E flows against the built SPA with a mock translation service and the
 * REAL dictionary (pinyin interpreter is fully local). One SQLite file per
 * run; tests are ordered by design (workers: 1).
 */

test.describe.configure({ mode: "serial" });

test("dad: onboarding with bpmf, pinyin ask, save", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("one quick thing")).toBeVisible();

  await page.getByRole("tab", { name: "ㄅㄆㄇ" }).click();
  await page.getByRole("button", { name: "Start asking" }).click();
  await expect(page.getByText("one quick thing")).toBeHidden();

  await page.getByPlaceholder(/English or rough pinyin/).fill("wo bu zhi dao");
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

  await expect(page.getByText("one quick thing")).toBeVisible();
  await page.getByRole("tab", { name: "Both" }).click();
  await page.getByRole("button", { name: "Start asking" }).click();

  await page.getByPlaceholder(/English or rough pinyin/).fill("time for sleep");
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
  await page.getByRole("tab", { name: "ㄅㄆㄇ" }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Close" }).click();

  await expect(page.getByText("shuì", { exact: false })).toHaveCount(0);
  await expect(page.getByText("ㄕㄨㄟˋ", { exact: false }).first()).toBeVisible();
});

test("photo mode: upload with mocked OCR, tap word, save", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("tab", { name: "Photo" }).click();
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
  await page.locator('[data-ocr-word="小貓"]').click();
  // definition popover anchored on the image, dismissible via X
  await expect(page.getByLabel("Close")).toBeVisible();
  await expect(page.getByText("kitten")).toBeVisible();
  await page.getByLabel("Close").click();
  await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
  await page.locator('[data-ocr-word="小貓"]').click();
  await page.getByRole("button", { name: "Save" }).first().click();
  await expect(page.getByText("Saved").first()).toBeVisible();
});
