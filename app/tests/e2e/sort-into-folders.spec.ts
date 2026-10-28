import { expect, test } from '@playwright/test';
import { desktopFixture, nativeCalls } from './desktop-fixture';

// Telegram, folder creation and moves are controlled native fixtures. The
// journey drives the real menu, plan, per-folder confirmation and move calls.
const savedFiles = [
  { id: 201, name: 'Casablanca – parte 2', file_ext: '002', mime_type: 'application/octet-stream', type: 'file' },
  { id: 202, name: 'Casablanca – parte 1', file_ext: '001', mime_type: 'application/octet-stream', type: 'file' },
  { id: 203, name: 'Photo.jpg', file_ext: 'jpg', mime_type: 'image/jpeg', type: 'image' },
  { id: 204, name: 'holiday.mp4', file_ext: 'mp4', mime_type: 'video/mp4', type: 'file' },
  { id: 205, name: 'Encrypted file', file_ext: null, mime_type: 'application/octet-stream', type: 'file', encryption_state: 'encrypted_locked' },
  { id: 206, name: 'notes.pdf', file_ext: 'pdf', mime_type: 'application/pdf', type: 'document' },
];
const fileOrigins = {
  201: { originalName: 'Casablanca.1942.mkv.002', caption: 'Casablanca – parte 2', originalDate: '2017-07-14T12:00:00+00:00', source: 'Film Classici' },
  202: { originalName: 'Casablanca.1942.mkv.001', caption: 'Casablanca – parte 1', originalDate: '2017-07-14T12:00:00+00:00', source: 'Film Classici' },
  203: { caption: 'Spiaggia', originalDate: '2020-09-13T12:00:00+00:00', source: 'Account nascosto' },
};

async function openSorter(page: import('@playwright/test').Page, visibleFile = 'notes.pdf') {
  await page.goto('/');
  await page.getByRole('button', { name: 'Saved Messages', exact: true }).click();
  await expect(page.getByText(visibleFile, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Preferences', exact: true }).click();
  await page.getByRole('menu').getByRole('button', { name: 'Sort by type', exact: true }).click();
  return page.getByRole('dialog', { name: 'Sort by type', exact: true });
}

test('sorting by type explains each file and moves only confirmed folders', async ({ page }) => {
  await desktopFixture(page, { savedFiles, fileOrigins, extraFolders: [{ id: 10, name: 'Videos' }] });
  const dialog = await openSorter(page);

  // Protected files are never described. (Development mounts effects twice.)
  await expect.poll(async () => (await nativeCalls(page, 'cmd_get_file_origins')).length).toBeGreaterThan(0);
  for (const call of await nativeCalls(page, 'cmd_get_file_origins')) {
    expect(call.args).toEqual({ ownerId: '101', folderId: null, messageIds: [201, 202, 203, 204, 206] });
  }

  await expect(dialog.getByText('Folder 1 of 4', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Destination: Videos', { exact: true })).toBeVisible();
  const videoRows = dialog.getByRole('listitem');
  await expect(videoRows).toHaveCount(3);
  // Split parts stay together, in part order, and show where they came from.
  await expect(videoRows.nth(0)).toContainText('Casablanca – parte 1');
  await expect(videoRows.nth(0)).toContainText('Part 1');
  await expect(videoRows.nth(0)).toContainText('Original name: Casablanca.1942.mkv.001');
  await expect(videoRows.nth(0)).toContainText('Posted on Jul 14, 2017 by Film Classici');
  await expect(videoRows.nth(1)).toContainText('Part 2');
  await expect(videoRows.nth(2)).toContainText('holiday.mp4');
  await expect(videoRows.nth(2)).toContainText('Uploaded on Sep 7, 2026');

  await dialog.getByRole('checkbox', { name: 'Include holiday.mp4', exact: true }).uncheck();
  await expect(dialog.getByText('Selected: 2 of 3', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Move selected', exact: true }).click();
  await expect(dialog.getByText('Folder 2 of 4', { exact: true })).toBeVisible();
  expect((await nativeCalls(page, 'cmd_move_files')).map(call => call.args)).toEqual([
    { ownerId: '101', messageIds: [202, 201], sourceFolderId: null, targetFolderId: 10 },
  ]);

  // A skipped folder is neither created nor filled.
  await expect(dialog.getByText('Destination: Images (it will be created)', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('listitem')).toContainText('Spiaggia');
  await expect(dialog.getByRole('listitem')).toContainText('Posted on Sep 13, 2020 by Account nascosto');
  await dialog.getByRole('button', { name: 'Skip this folder', exact: true }).click();

  await expect(dialog.getByText('Destination: Documents (it will be created)', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Move selected', exact: true }).click();
  await expect(dialog.getByText('Folder 4 of 4', { exact: true })).toBeVisible();
  expect((await nativeCalls(page, 'cmd_create_folder')).map(call => call.args)).toEqual([{ name: 'Documents' }]);
  expect((await nativeCalls(page, 'cmd_move_files')).map(call => call.args)[1])
    .toEqual({ ownerId: '101', messageIds: [206], sourceFolderId: null, targetFolderId: 501 });

  await expect(dialog.getByText('Destination: Other files (it will be created)', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('listitem')).toContainText('Encrypted file');
  await dialog.getByRole('button', { name: 'Skip this folder', exact: true }).click();
  await expect(dialog.getByText('Done. Files moved: 3.', { exact: true })).toBeVisible();
  expect(await nativeCalls(page, 'cmd_create_folder')).toHaveLength(1);
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('holiday.mp4', { exact: true })).toBeVisible();
  await expect(page.getByText('notes.pdf', { exact: true })).toHaveCount(0);
});

test('an interrupted move keeps only the unmoved files for a retry and unread details fall back to upload dates', async ({ page }) => {
  // More files than one Telegram request carries; the second batch fails.
  const parts = Array.from({ length: 150 }, (_, index) => ({
    id: 1000 + index, name: `clip ${String(index + 1).padStart(3, '0')}.mp4`, file_ext: 'mp4', mime_type: 'video/mp4', type: 'file',
  }));
  await desktopFixture(page, { savedFiles: parts, originsFail: true, moveFailAt: [1] });
  const dialog = await openSorter(page, 'clip 001.mp4');
  await expect(dialog.getByText('File details could not be read; names and upload dates are shown instead.', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Destination: Videos (it will be created)', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('listitem').first()).toContainText('Uploaded on Sep 7, 2026');
  const filesListed = (await nativeCalls(page, 'cmd_get_files')).length;

  await dialog.getByRole('button', { name: 'Move selected', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('The move stopped. Files already moved stay moved; try again to move the rest.');
  await expect(dialog.getByText('Selected: 50 of 50', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Folder 1 of 1', { exact: true })).toBeVisible();
  // The failed move refreshes the listing.
  await expect.poll(async () => (await nativeCalls(page, 'cmd_get_files')).length).toBeGreaterThan(filesListed);

  await dialog.getByRole('button', { name: 'Move selected', exact: true }).click();
  await expect(dialog.getByText('Done. Files moved: 150.', { exact: true })).toBeVisible();
  const moves = (await nativeCalls(page, 'cmd_move_files')).map(call => call.args);
  expect(moves.map(move => move.messageIds.length)).toEqual([100, 50, 50]);
  expect(moves[2].messageIds).toEqual(moves[1].messageIds);
  expect(moves[2].messageIds[0]).toBe(1100);
  // The folder created for the first attempt is reused on retry.
  expect((await nativeCalls(page, 'cmd_create_folder')).map(call => call.args)).toEqual([{ name: 'Videos' }]);
  expect(new Set(moves.map(move => move.targetFolderId))).toEqual(new Set([501]));
});
