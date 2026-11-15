import { expect, test, type Page } from '@playwright/test';
import { createEvent, getTicket, openScanner, participant, readQr, scan, TITLE } from './helpers';

test('check-in gives a stamp and a credential: poll, question and draw as an attendee', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { host, eventId, scannerUrl } = await createEvent(browser);
  const { page, qrText } = await getTicket(browser, eventId);

  const scanner = await openScanner(browser, scannerUrl);
  expect((await scan(scanner, qrText)).text).toContain('入場OK');

  // The ticket page picks up the stamp signed at check-in.
  await expect(page.getByTestId('stamp-received')).toBeVisible({ timeout: 15_000 });
  await page.goto('/stamps');
  await expect(page.getByTestId('stamp-count')).toHaveText('1 枚');
  await expect(page.getByTestId('stamp-host')).toContainText(TITLE);
  await page.goBack();

  // Host: a poll and a draw.
  await host.getByLabel('質問', { exact: true }).fill('次のテーマは？');
  await host.getByLabel('選択肢 1').fill('Lightning');
  await host.getByLabel('選択肢 2').fill('マイニング');
  await host.getByRole('button', { name: '投票を作成' }).click();
  await host.getByLabel('抽選の名前（例：LTの順番）').fill('LTの順番');
  await host.getByRole('button', { name: '抽選を作成' }).click();

  const panel = page.getByTestId('attendee-panel');
  await expect(panel.getByTestId('poll')).toBeVisible({ timeout: 15_000 });
  await panel.getByRole('button', { name: 'Lightning' }).click();
  await expect(host.getByTestId('host-poll')).toContainText('1 票', { timeout: 10_000 });

  await panel.getByLabel('質問する').fill('初心者でも大丈夫ですか？');
  await panel.getByRole('button', { name: '質問する' }).click();
  await expect(host.getByTestId('host-question')).toContainText('初心者でも', { timeout: 10_000 });

  await expect(panel.getByTestId('draw')).toBeVisible({ timeout: 10_000 });
  await panel.getByRole('button', { name: '応募する' }).click();
  await expect(panel.getByText(/応募済み/)).toBeVisible();
  await expect(host.getByTestId('host-draw')).toContainText('応募 1', { timeout: 10_000 });
  await host.getByRole('button', { name: '抽選する' }).click();
  await expect(panel.getByTestId('draw-won')).toBeVisible({ timeout: 15_000 });
  const code = (await host.getByTestId('winning-codes').textContent())!.trim();
  await expect(panel.getByTestId('draw-won')).toContainText(code);
});

test('deposit: hold invoice is paid, the ticket is issued, check-in works', async ({ browser }) => {
  const { eventId, scannerUrl } = await createEvent(browser, {
    depositSats: 21,
    startsInHours: 24,
  });
  const page = await participant(browser);
  await page.goto(`/e/${eventId}`);
  await expect(page.getByTestId('deposit-notice')).toBeVisible();
  await page.getByRole('button', { name: '無料で参加する' }).click();
  await expect(page.getByTestId('deposit-panel')).toBeVisible();
  // The mock wallet marks the hold invoice as paid 1.5 s after creation; the page continues.
  await expect(page).toHaveURL(/\/t\/[A-Za-z0-9_-]+\?new=1$/, { timeout: 30_000 });
  await expect(page.getByText('デポジットは受付で入場すると返金されます。')).toBeVisible();
  const scanner = await openScanner(browser, scannerUrl);
  expect((await scan(scanner, await readQr(page))).text).toContain('入場OK');
});

test('approval: apply with a Nostr signature, the host approves, the ticket is claimed', async ({
  browser,
}) => {
  const { host, eventId } = await createEvent(browser, { policy: 'approval' });
  const page = await participant(browser, { nostr: true });
  await page.goto(`/e/${eventId}`);
  await expect(page.getByTestId('approval-notice')).toContainText('npub');
  await page.getByRole('button', { name: '参加を申請する' }).click();
  await expect(page.getByRole('button', { name: '承認を待っています…' })).toBeDisabled();

  await expect(host.getByTestId('application')).toContainText('承認待ち', { timeout: 10_000 });
  await host.getByRole('button', { name: '承認' }).click();
  await expect(host.getByTestId('application')).toContainText('承認済み');

  await expect(page.getByRole('button', { name: 'チケットを受け取る' })).toBeEnabled({
    timeout: 15_000,
  });
  await page.getByRole('button', { name: 'チケットを受け取る' }).click();
  await expect(page).toHaveURL(/\/t\/[A-Za-z0-9_-]+\?new=1$/, { timeout: 20_000 });
  await expect(host.getByTestId('application')).toContainText('発行済み', { timeout: 10_000 });
});

async function enterRoom(page: Page) {
  await page.getByRole('link', { name: 'ルームに入る' }).click();
  await page.getByRole('button', { name: 'ルームに入る' }).click();
  await expect(page.getByLabel('メッセージ')).toBeEnabled({ timeout: 30_000 });
}

async function say(page: Page, text: string) {
  await page.getByLabel('メッセージ').fill(text);
  await page.getByRole('button', { name: '送信' }).click();
  await expect(page.getByTestId('room-messages').getByText(text)).toBeVisible({ timeout: 15_000 });
}

test('mutual reveal: npubs are shown only after both chose each other', async ({ browser }) => {
  test.setTimeout(120_000);
  const { eventId } = await createEvent(browser);
  const a = (await getTicket(browser, eventId)).page;
  const b = (await getTicket(browser, eventId)).page;
  await enterRoom(a);
  await enterRoom(b);
  await say(a, 'Aです');
  await say(b, 'Bです');
  await expect(a.getByText('Bです')).toBeVisible({ timeout: 20_000 });
  await expect(b.getByText('Aです')).toBeVisible({ timeout: 20_000 });

  const npubA = 'npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m';
  const npubB = 'npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6';
  await a
    .getByTestId('room-message')
    .filter({ hasText: 'Bです' })
    .getByTestId('reveal-open')
    .click();
  await a.getByLabel('開示する npub').fill(npubA);
  await a.getByRole('button', { name: '開示してもよい' }).click();
  await expect(a.getByText('伝えました')).toBeVisible();
  // One-sided so far: B sees nothing.
  await b.waitForTimeout(3000);
  await expect(b.getByTestId('reveal-matches')).toBeHidden();

  await b
    .getByTestId('room-message')
    .filter({ hasText: 'Aです' })
    .getByTestId('reveal-open')
    .click();
  await b.getByLabel('開示する npub').fill(npubB);
  await b.getByRole('button', { name: '開示してもよい' }).click();
  await expect(b.getByTestId('reveal-match')).toContainText(npubA, { timeout: 20_000 });
  await expect(a.getByTestId('reveal-match')).toContainText(npubB, { timeout: 20_000 });
});
