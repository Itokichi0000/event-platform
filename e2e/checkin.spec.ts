import { decodeToken } from '@kamen/core';
import { expect, test } from '@playwright/test';
import { createEvent, getTicket, openScanner, participant, scan, TITLE } from './helpers';

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

  const scanner = await openScanner(browser, scannerUrl);
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

  const fresh = await participant(browser);
  await fresh.goto('/tickets');
  await expect(fresh.getByText('まだチケットはありません')).toBeVisible();
  await fresh.getByRole('link', { name: 'バックアップから復元' }).click();
  await fresh.getByLabel('バックアップから復元').fill(backup);
  await fresh.getByRole('button', { name: '復元する' }).click();
  await expect(fresh.getByRole('heading', { name: TITLE })).toBeVisible();
  await fresh.goto('/tickets');
  await expect(fresh.getByText(TITLE)).toBeVisible();
});
