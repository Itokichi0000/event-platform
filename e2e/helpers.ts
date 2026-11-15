import { devices, expect, type Browser, type Page } from '@playwright/test';
import { installNostrSigner } from './fixtures';

export const TITLE = 'E2E Bitcoin Meetup';
export const MOCK_NWC = `nostr+walletconnect://${'b'.repeat(64)}?relay=wss%3A%2F%2Frelay.example&secret=${'c'.repeat(64)}`;

/** Fails the test on any Content-Security-Policy violation or uncaught page error. */
export function watchErrors(page: Page) {
  page.on('console', (msg) => {
    if (msg.type() === 'error' && /Content Security Policy/i.test(msg.text())) {
      throw new Error(`CSP violation: ${msg.text()}`);
    }
  });
  page.on('pageerror', (err) => {
    throw err;
  });
}

export interface EventOptions {
  policy?: 'pow' | 'invite' | 'paid' | 'approval';
  priceSats?: number;
  offline?: boolean;
  capacity?: number;
  depositSats?: number;
  /** Start this many hours from now (deposits open only shortly before the start). */
  startsInHours?: number;
}

/** <input type="datetime-local"> value in the browser's (= this machine's) local time. */
function localInput(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Host: log in with a fake NIP-07 signer, create and publish an event, issue a check-in link. */
export async function createEvent(browser: Browser, opts: EventOptions = {}) {
  const context = await browser.newContext();
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const signer = await installNostrSigner(context);
  const page = await context.newPage();
  watchErrors(page);
  await page.goto('/host');
  await page.getByRole('button', { name: 'Nostr拡張でログイン' }).click();
  await page.getByRole('link', { name: '新しいイベント' }).click();

  await page.getByLabel('タイトル', { exact: true }).fill(TITLE);
  await page.getByLabel('場所', { exact: true }).fill('Shibuya 3F');
  await page.getByLabel('定員', { exact: true }).fill(String(opts.capacity ?? 10));
  await page.getByLabel('説明', { exact: true }).fill('E2E テスト用のイベント');
  if (opts.policy === 'invite') await page.getByLabel('招待コードを持っている人').check();
  if (opts.policy === 'paid') {
    await page.getByLabel('有料（Lightning）').check();
    await page.getByLabel('価格（sats）').fill(String(opts.priceSats ?? 21));
  }
  if (opts.policy === 'approval')
    await page.getByLabel('承認制（申請者の npub を確認して承認）').check();
  if (opts.depositSats)
    await page.getByLabel('デポジット（sats、0 でなし）').fill(String(opts.depositSats));
  if (opts.startsInHours !== undefined) {
    const start = Date.now() + opts.startsInHours * 3600_000;
    await page.getByLabel('開始', { exact: true }).fill(localInput(start));
    await page.getByLabel('終了', { exact: true }).fill(localInput(start + 3 * 3600_000));
  }
  if (opts.offline) await page.getByLabel('オフライン受付を使う').check();
  await page.getByRole('button', { name: '作成する（下書き）' }).click();

  await expect(page).toHaveURL(/\/host\/e\/[a-z2-7]{12}$/);
  const eventId = page.url().split('/').pop()!;

  if (opts.policy === 'paid' || opts.depositSats) {
    await page.getByLabel('ウォレット（NWC）').fill(MOCK_NWC);
    await page.getByRole('button', { name: '接続', exact: true }).click();
    await expect(page.getByTestId('wallet-connected')).toBeVisible();
  }

  await page.getByRole('button', { name: '公開する' }).click();
  await expect(page.getByText('公開中')).toBeVisible();

  await page.getByPlaceholder('ラベル（例：入口A）').fill('入口');
  await page.getByRole('button', { name: '受付リンクを発行' }).click();
  const scannerUrl = (await page.getByTestId('scanner-url').textContent())!;
  expect(scannerUrl).toMatch(new RegExp(`/scan/${eventId}#[A-Za-z0-9_-]{43}$`));
  return { host: page, eventId, scannerUrl, signer };
}

export async function participant(browser: Browser, opts: { nostr?: boolean } = {}) {
  const context = await browser.newContext({ ...devices['Pixel 7'] });
  if (opts.nostr) await installNostrSigner(context);
  const page = await context.newPage();
  watchErrors(page);
  return page;
}

export async function readQr(page: Page) {
  await expect(page.getByText('受付でこのQRコードを見せてください')).toBeVisible();
  return (await page.locator('canvas[data-qr-text]').getAttribute('data-qr-text'))!;
}

/** Participant: free event → ticket. */
export async function getTicket(browser: Browser, eventId: string) {
  const page = await participant(browser);
  await page.goto(`/e/${eventId}`);
  await expect(page.getByRole('heading', { name: TITLE })).toBeVisible();
  await page.getByRole('button', { name: '無料で参加する' }).click();
  await expect(page).toHaveURL(/\/t\/[A-Za-z0-9_-]+\?new=1$/, { timeout: 30_000 });
  return { page, qrText: await readQr(page) };
}

export async function openScanner(browser: Browser, url: string) {
  const ctx = await browser.newContext({ ...devices['Pixel 7'] });
  const page = await ctx.newPage();
  watchErrors(page);
  await page.goto(url);
  await expect(page.getByText(TITLE)).toBeVisible();
  return page;
}

export async function scan(page: Page, text: string) {
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
