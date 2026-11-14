import { decodeToken } from '@kamen/core';
import { expect, test } from '@playwright/test';
import { createEvent, getTicket, openScanner, participant, readQr, scan, TITLE } from './helpers';

test('paid ticket: invoice → payment (mock wallet) → ticket → return frees the seat', async ({
  browser,
}) => {
  const { host, eventId } = await createEvent(browser, {
    policy: 'paid',
    priceSats: 21,
    capacity: 1,
  });

  const page = await participant(browser);
  await page.goto(`/e/${eventId}`);
  await expect(page.getByText('21 sats').first()).toBeVisible();
  await page.getByRole('button', { name: '21 sats で参加する' }).click();
  const panel = page.getByTestId('payment-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByText('支払いを待っています…')).toBeVisible();
  // The mock wallet settles 1.5 s after the invoice was created.
  await expect(page).toHaveURL(/\/t\/[A-Za-z0-9_-]+\?new=1$/, { timeout: 20_000 });
  await readQr(page);

  // Sold out for everyone else now.
  const other = await participant(browser);
  await other.goto(`/e/${eventId}`);
  await expect(other.getByRole('button', { name: '満席です' })).toBeDisabled();

  // Return the ticket: seat is released, counter on the dashboard shows it.
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'チケットを返却' }).click();
  await expect(page).toHaveURL(/\/tickets\?returned=1$/);
  await expect(page.getByText('チケットを返却しました')).toBeVisible();
  await expect(page.getByText('まだチケットはありません')).toBeVisible();
  await other.reload();
  await expect(other.getByRole('button', { name: '21 sats で参加する' })).toBeEnabled();
  await expect(host.getByTestId('count-returned')).toHaveText('1', { timeout: 10_000 });
});

test('paid ticket survives closing the tab mid-payment', async ({ browser }) => {
  const { eventId } = await createEvent(browser, { policy: 'paid', priceSats: 5 });
  const page = await participant(browser);
  await page.goto(`/e/${eventId}`);
  await page.getByRole('button', { name: '5 sats で参加する' }).click();
  await expect(page.getByTestId('payment-panel')).toBeVisible();
  // Leave before the payment is confirmed, come back later: the quote is resumed from IndexedDB.
  await page.goto('/tickets');
  await page.waitForTimeout(2000);
  await page.goto(`/e/${eventId}`);
  await expect(page).toHaveURL(/\/t\/[A-Za-z0-9_-]+\?new=1$/, { timeout: 20_000 });
});

test('invite-only event: the invite link fills in the code', async ({ browser }) => {
  const { host, eventId } = await createEvent(browser, { policy: 'invite' });
  await host.getByPlaceholder('メモ（例：Telegramグループ）').fill('E2E');
  await host.getByRole('button', { name: 'コードを作成' }).click();
  const link = (await host.getByTestId('invite-link').textContent())!;
  expect(link).toMatch(new RegExp(`/e/${eventId}#invite=[A-Z2-9]{5}-[A-Z2-9]{5}$`));

  // Without a code the button stays disabled.
  const stranger = await participant(browser);
  await stranger.goto(`/e/${eventId}`);
  await expect(stranger.getByRole('button', { name: '招待コードで参加する' })).toBeDisabled();
  await stranger.getByLabel('招待コード').fill('WRONG-CODE0');
  await stranger.getByRole('button', { name: '招待コードで参加する' }).click();
  await expect(stranger.getByText('招待コードが正しくないか')).toBeVisible({ timeout: 20_000 });

  const invited = await participant(browser);
  await invited.goto(new URL(link).pathname + new URL(link).hash);
  await expect(invited.getByLabel('招待コード')).not.toHaveValue('');
  await invited.getByRole('button', { name: '招待コードで参加する' }).click();
  await expect(invited).toHaveURL(/\/t\/[A-Za-z0-9_-]+\?new=1$/, { timeout: 30_000 });
});

test('offline check-in: two offline devices, then sync reports the double entry', async ({
  browser,
}) => {
  const { eventId, scannerUrl } = await createEvent(browser, { offline: true });
  const { page, qrText } = await getTicket(browser, eventId);
  await expect(page.getByTestId('ticket-offline-note')).toBeVisible();
  // Offline check-in events carry the DLEQ in the door QR.
  expect(decodeToken(qrText).dleq).toBeDefined();

  const doorA = await openScanner(browser, scannerUrl);
  const doorB = await openScanner(browser, scannerUrl);
  await doorA.context().setOffline(true);
  await doorB.context().setOffline(true);
  await expect(doorA.getByTestId('offline-banner')).toBeVisible();

  const a1 = await scan(doorA, qrText);
  expect(a1.text).toContain('入場OK（オフライン判定）');
  expect((await scan(doorA, qrText)).text).toContain('この端末で使用済みです');
  await expect(doorA.getByTestId('pending-count')).toHaveText('未同期 1 件');

  // Another offline device cannot know: it lets the same ticket in (documented limitation).
  expect((await scan(doorB, qrText)).text).toContain('入場OK（オフライン判定）');

  await doorA.context().setOffline(false);
  await expect(doorA.getByTestId('pending-count')).toBeHidden({ timeout: 15_000 });
  await expect(doorA.getByTestId('scanner-counter')).toHaveText('来場 1 / 発行 1');

  await doorB.context().setOffline(false);
  await expect(doorB.getByTestId('conflicts')).toBeVisible({ timeout: 15_000 });
  await expect(doorB.getByTestId('conflicts')).toContainText('競合');
});

test('language switch', async ({ browser }) => {
  const page = await participant(browser);
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'マイチケット', exact: true })).toBeVisible();
  await page.getByTestId('lang-switch').click();
  await expect(page.getByRole('link', { name: 'My tickets', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('link', { name: 'My tickets', exact: true })).toBeVisible();
  await page.getByTestId('lang-switch').click();
  await expect(page.getByRole('link', { name: 'マイチケット', exact: true })).toBeVisible();
  expect(TITLE).toBeTruthy();
});
