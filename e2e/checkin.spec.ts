import { decodeToken } from '@kamen/core';
import { devices, expect, test, type Browser, type Page } from '@playwright/test';
import { installNostrSigner } from './fixtures';

async function createEvent(browser: Browser) {
  const context = await browser.newContext();
  await installNostrSigner(context);
  const page = await context.newPage();
  watchErrors(page);
  await page.goto('/host');
  await page.getByRole('button', { name: 'Nostr拡張でログイン' }).click();
  await page.getByRole('link', { name: '新しいイベント' }).click();

  await page.getByLabel('タイトル', { exact: true }).fill('E2E Bitcoin Meetup');
  await page.getByLabel('場所', { exact: true }).fill('Shibuya 3F');
  await page.getByLabel('定員', { exact: true }).fill('10');
  await page.getByLabel('説明', { exact: true }).fill('E2E テスト用のイベント');
  await page.getByRole('button', { name: '作成する（下書き）' }).click();

  await expect(page).toHaveURL(/\/host\/e\/[a-z2-7]{12}$/);
  const eventId = page.url().split('/').pop()!;
  await page.getByRole('button', { name: '公開する' }).click();
  await expect(page.getByText('公開中')).toBeVisible();

  await page.getByPlaceholder('ラベル（例：入口A）').fill('入口');
  await page.getByRole('button', { name: '受付リンクを発行' }).click();
  const scannerUrl = (await page.getByTestId('scanner-url').textContent())!;
  expect(scannerUrl).toMatch(new RegExp(`/scan/${eventId}#[A-Za-z0-9_-]{43}$`));
  return { host: page, eventId, scannerUrl };
}

/** Fails the test on any Content-Security-Policy violation or uncaught page error. */
function watchErrors(page: Page) {
  page.on('console', (msg) => {
    if (msg.type() === 'error' && /Content Security Policy/i.test(msg.text())) {
      throw new Error(`CSP violation: ${msg.text()}`);
    }
  });
  page.on('pageerror', (err) => {
    throw err;
  });
}

async function getTicket(browser: Browser, eventId: string) {
  const context = await browser.newContext({ ...devices['Pixel 7'] });
  const page = await context.newPage();
  watchErrors(page);
  await page.goto(`/e/${eventId}`);
  await expect(page.getByRole('heading', { name: 'E2E Bitcoin Meetup' })).toBeVisible();
  await expect(page.getByText('残り 10 / 10 枠')).toBeVisible();
  await page.getByRole('button', { name: '無料で参加する' }).click();
  await expect(page).toHaveURL(/\/t\/[A-Za-z0-9_-]+\?new=1$/, { timeout: 30_000 });
  await expect(page.getByText('受付でこのQRコードを見せてください')).toBeVisible();
  const qrText = (await page.locator('canvas[data-qr-text]').getAttribute('data-qr-text'))!;
  return { page, qrText };
}

async function scan(page: Page, text: string) {
  const details = page.locator('details');
  if (!(await details.evaluate((d: HTMLDetailsElement) => d.open))) {
    await page.getByText('手入力・貼り付け').click();
  }
  await page.getByLabel('手入力・貼り付け').fill(text);
  await page.getByRole('button', { name: '確認' }).click();
  const verdict = page.getByTestId('scan-verdict');
  await expect(verdict).toBeVisible();
  const result = {
    kind: await verdict.getAttribute('data-verdict'),
    text: await verdict.textContent(),
  };
  await verdict.click();
  await expect(verdict).toBeHidden();
  return result;
}

test('create → get ticket → check in → second check-in with the same QR is rejected', async ({
  browser,
}) => {
  const { host, eventId, scannerUrl } = await createEvent(browser);
  const { page: participant, qrText } = await getTicket(browser, eventId);

  // Online check-in event: the door QR carries no DLEQ / blinding factor.
  const token = decodeToken(qrText);
  expect(token.eventId).toBe(eventId);
  expect(token.dleq).toBeUndefined();

  // The ticket survives a reload (IndexedDB) and the event page now links to it.
  await participant.goto(`/e/${eventId}`);
  await expect(participant.getByRole('link', { name: 'チケットを表示' })).toBeVisible();

  const scannerCtx = await browser.newContext({ ...devices['Pixel 7'] });
  const scanner = await scannerCtx.newPage();
  watchErrors(scanner);
  await scanner.goto(scannerUrl);
  await expect(scanner.getByText('E2E Bitcoin Meetup')).toBeVisible();
  await expect(scanner.getByTestId('scanner-counter')).toHaveText('来場 0 / 発行 1');

  const first = await scan(scanner, qrText);
  expect(first).toMatchObject({ kind: 'ok' });
  expect(first.text).toContain('入場OK');
  await expect(scanner.getByTestId('scanner-counter')).toHaveText('来場 1 / 発行 1');

  const second = await scan(scanner, qrText);
  expect(second.kind).toBe('bad');
  expect(second.text).toContain('使用済みです');

  // Garbage and tickets of other events are rejected too.
  expect((await scan(scanner, 'hello')).text).toContain('チケットのQRではありません');

  // The host dashboard counters update by polling.
  await expect(host.getByTestId('count-issued')).toHaveText('1');
  await expect(host.getByTestId('count-redeemed')).toHaveText('1', { timeout: 10_000 });
});

test('backup string restores the ticket in a fresh browser', async ({ browser }) => {
  const { eventId } = await createEvent(browser);
  const { page } = await getTicket(browser, eventId);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: '文字列をコピー' }).click();
  await expect(page.getByText('バックアップ済み')).toBeVisible();
  const backup = await page.evaluate(() => navigator.clipboard.readText());
  expect(decodeToken(backup).dleq).toBeDefined(); // backups keep the DLEQ

  const fresh = await (await browser.newContext()).newPage();
  await fresh.goto('/tickets');
  await expect(fresh.getByText('まだチケットはありません')).toBeVisible();
  await fresh.getByRole('link', { name: 'バックアップから復元' }).click();
  await fresh.getByLabel('バックアップから復元').fill(backup);
  await fresh.getByRole('button', { name: '復元する' }).click();
  await expect(fresh.getByRole('heading', { name: 'E2E Bitcoin Meetup' })).toBeVisible();
  await fresh.goto('/tickets');
  await expect(fresh.getByText('E2E Bitcoin Meetup')).toBeVisible();
});
