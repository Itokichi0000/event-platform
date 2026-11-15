import { expect, test, type Page } from '@playwright/test';
import { createEvent, getTicket, openScanner, scan } from './helpers';

async function enterRoom(page: Page) {
  await page.getByRole('link', { name: 'ルームに入る' }).click();
  await expect(page.getByTestId('room-privacy')).toContainText('会話を読むことができます');
  await page.getByRole('button', { name: 'ルームに入る' }).click();
  await expect(page.getByTestId('my-mask')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel('メッセージ')).toBeEnabled({ timeout: 30_000 });
  return (await page.getByTestId('my-mask').textContent())!.replace(/^.*: /, '');
}

async function say(page: Page, text: string) {
  await page.getByLabel('メッセージ').fill(text);
  await page.getByRole('button', { name: '送信' }).click();
  await expect(page.getByTestId('room-messages').getByText(text)).toBeVisible({ timeout: 15_000 });
}

test('room: three browsers enter, chat, see a host announcement, then the room is disbanded', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const { host, eventId, scannerUrl } = await createEvent(browser);

  const people = [];
  for (let i = 0; i < 3; i++) people.push(await getTicket(browser, eventId));
  const masks: string[] = [];
  for (const p of people) masks.push(await enterRoom(p.page));
  expect(new Set(masks).size).toBe(3); // each browser has its own per-event key and mask

  const [a, b, c] = people.map((p) => p.page) as [Page, Page, Page];
  await say(a, 'こんにちは、Aです');
  for (const other of [b, c]) {
    const msg = other.getByTestId('room-message').filter({ hasText: 'こんにちは、Aです' });
    await expect(msg).toBeVisible({ timeout: 20_000 });
    await expect(msg).toContainText(masks[0]!);
  }
  await say(c, 'Cも来ました');
  await expect(a.getByText('Cも来ました')).toBeVisible({ timeout: 20_000 });

  // A host announcement appears on the event page and, highlighted, in the room.
  await host.getByPlaceholder('変更や中止のお知らせ').fill('入口は裏側です');
  await host.getByRole('button', { name: '投稿' }).click();
  for (const p of [a, b, c]) {
    await expect(
      p.getByTestId('room-announcement').filter({ hasText: '入口は裏側です' }),
    ).toBeVisible({
      timeout: 20_000,
    });
  }

  // The room never affects check-in: tickets still work.
  const scanner = await openScanner(browser, scannerUrl);
  expect((await scan(scanner, people[0]!.qrText)).text).toContain('入場OK');

  // The host disbands the room: every participant sees it end and the local data is deleted.
  host.once('dialog', (d) => d.accept());
  await host.getByRole('button', { name: 'ルームを今すぐ解散' }).click();
  for (const p of [a, b, c]) {
    await expect(p.getByText('このルームは解散しました')).toBeVisible({ timeout: 30_000 });
  }
  const leftover = await a.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const req = indexedDB.open('kamen-rooms');
        req.onsuccess = () => {
          const tx = req.result.transaction(['rooms', 'messages'], 'readonly');
          const r = tx.objectStore('rooms').count();
          const m = tx.objectStore('messages').count();
          tx.oncomplete = () => resolve(r.result + m.result);
        };
      }),
  );
  expect(leftover).toBe(0);
});
