import { expect, test, type Page } from '@playwright/test';
import { desktopFixture, nativeCalls } from './desktop-fixture';

// Telegram, the transfer queue and the join are controlled native fixtures.
// The journey drives the real list grouping, download flow, persisted join
// record across a reload, and the move and delete routing to every part.
const MB = 1024 * 1024;
const savedFiles = [
  { id: 302, name: 'Che pipandula.7z.002', file_ext: '002', size: 1000 * MB, mime_type: 'application/octet-stream', type: 'file' },
  { id: 301, name: 'Che pipandula.7z.001', file_ext: '001', size: 1000 * MB, mime_type: 'application/octet-stream', type: 'file' },
  { id: 303, name: 'Che pipandula.7z.003', file_ext: '003', size: 135 * MB, mime_type: 'application/octet-stream', type: 'file' },
  // A missing part keeps its set visible part by part.
  { id: 311, name: 'gap.7z.001', file_ext: '001', size: 10, mime_type: 'application/octet-stream', type: 'file' },
  { id: 313, name: 'gap.7z.003', file_ext: '003', size: 10, mime_type: 'application/octet-stream', type: 'file' },
  // RAR volumes are not byte slices and are never joined.
  { id: 321, name: 'old.part1.rar', file_ext: 'rar', size: 10, mime_type: 'application/x-rar', type: 'file' },
  { id: 322, name: 'old.part2.rar', file_ext: 'rar', size: 10, mime_type: 'application/x-rar', type: 'file' },
];

async function openSavedMessages(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Saved Messages', exact: true }).click();
  await expect(page.getByText('Che pipandula.7z', { exact: true })).toBeVisible();
}

test('a complete set of parts is listed as one file and downloads into one joined file after a restart', async ({ page }) => {
  await desktopFixture(page, { savedFiles, savePickerPath: '/synthetic/Downloads/Che pipandula.7z', persistTransfersAcrossReload: true });
  await openSavedMessages(page);
  const row = page.getByRole('group', { name: 'Che pipandula.7z', exact: true });
  await expect(row).toContainText('Parts: 3');
  await expect(row).toContainText('2.08 GB');
  await expect(page.getByText('Che pipandula.7z.001', { exact: true })).toHaveCount(0);
  for (const name of ['gap.7z.001', 'gap.7z.003', 'old.part1.rar', 'old.part2.rar']) {
    await expect(page.getByText(name, { exact: true })).toBeVisible();
  }

  await row.click({ button: 'right' });
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Download', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Continue download', exact: true }).click();
  await expect.poll(async () => (await nativeCalls(page, 'cmd_transfer_enqueue_many')).length).toBe(1);
  const requests = (await nativeCalls(page, 'cmd_transfer_enqueue_many'))[0].args.requests;
  expect(requests.map((request: any) => [request.messageId, request.savePath, request.collisionPolicy])).toEqual([
    [301, '/synthetic/Downloads/Che pipandula.7z.001', 'keep_both'],
    [302, '/synthetic/Downloads/Che pipandula.7z.002', 'keep_both'],
    [303, '/synthetic/Downloads/Che pipandula.7z.003', 'keep_both'],
  ]);

  // The join record survives a restart before the parts finish.
  await page.reload();
  await page.getByRole('button', { name: 'Saved Messages', exact: true }).click();
  await expect(page.getByText('Che pipandula.7z', { exact: true })).toBeVisible();
  await page.evaluate(requests => {
    const state = (window as any).__desktopTest;
    for (const request of requests) {
      state.emit('transfer-upserted', {
        ...request, ownerId: '101', status: 'completed', downloadOutcome: 'saved', progress: 100,
        transferredBytes: request.totalBytes, speedBytesPerSec: 0, queuePosition: 0, revision: 2,
        createdAt: Date.now(), updatedAt: Date.now(),
      });
    }
  }, requests);
  await expect.poll(async () => (await nativeCalls(page, 'cmd_join_split_download')).map(call => call.args)).toEqual([{
    ownerId: '101',
    partPaths: requests.map((request: any) => request.savePath),
    destination: '/synthetic/Downloads/Che pipandula.7z',
    collisionPolicy: 'keep_both',
    expectedBytes: 2135 * MB,
  }]);
  await expect(page.getByText('Downloaded: Che pipandula.7z', { exact: true })).toBeVisible();
  // Each part does not announce itself, and a joined file is never joined twice.
  await expect(page.getByText('Downloaded: Che pipandula.7z.001', { exact: true })).toHaveCount(0);
  await page.evaluate(() => (window as any).__desktopTest.emit('transfer-upserted', {
    id: 'unrelated', ownerId: '101', direction: 'download', kind: 'download', status: 'downloading', filename: 'x', folderId: null,
    progress: 1, transferredBytes: 1, totalBytes: 2, speedBytesPerSec: 0, queuePosition: 0, revision: 1, createdAt: 0, updatedAt: 0,
  }));
  expect(await nativeCalls(page, 'cmd_join_split_download')).toHaveLength(1);
});

test('a failed join reports that the parts were kept', async ({ page }) => {
  await desktopFixture(page, { savedFiles, savePickerPath: '/synthetic/Downloads/Che pipandula.7z', joinFails: true });
  await openSavedMessages(page);
  await page.getByRole('group', { name: 'Che pipandula.7z', exact: true }).click({ button: 'right' });
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Download', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Continue download', exact: true }).click();
  await expect.poll(async () => (await nativeCalls(page, 'cmd_transfer_enqueue_many')).length).toBe(1);
  const requests = (await nativeCalls(page, 'cmd_transfer_enqueue_many'))[0].args.requests;
  await page.evaluate(requests => {
    for (const request of requests) {
      (window as any).__desktopTest.emit('transfer-upserted', {
        ...request, ownerId: '101', status: 'completed', downloadOutcome: 'saved', progress: 100,
        transferredBytes: request.totalBytes, speedBytesPerSec: 0, queuePosition: 0, revision: 2, createdAt: 0, updatedAt: 0,
      });
    }
  }, requests);
  await expect(page.getByText('Che pipandula.7z downloaded, but its parts could not be joined. They were kept in the download folder.', { exact: true })).toBeVisible();
});

test('moving, deleting, renaming and previewing a split file act on the whole set', async ({ page }) => {
  await desktopFixture(page, { savedFiles, extraFolders: [{ id: 10, name: 'Archives' }] });
  await openSavedMessages(page);
  const row = page.getByRole('group', { name: 'Che pipandula.7z', exact: true });

  // Renaming or sharing one part would break the set, so neither is offered.
  await row.click({ button: 'right' });
  await expect(page.getByRole('button', { name: 'Rename', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Share', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByText('Download the whole file to open it.', { exact: true })).toBeVisible();

  await row.click({ button: 'right' });
  await page.getByRole('button', { name: 'Move to Folder', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Archives', exact: true }).click();
  await expect.poll(async () => (await nativeCalls(page, 'cmd_move_files')).map(call => call.args)).toEqual([
    { ownerId: '101', messageIds: [301, 302, 303], sourceFolderId: null, targetFolderId: 10 },
  ]);
});

test('deleting a split file deletes every part', async ({ page }) => {
  await desktopFixture(page, { savedFiles });
  await openSavedMessages(page);
  await page.getByRole('group', { name: 'Che pipandula.7z', exact: true }).click({ button: 'right' });
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect.poll(async () => (await nativeCalls(page, 'cmd_delete_file')).map(call => call.args.messageId)).toEqual([301, 302, 303]);
});
