import { expect, test } from '@playwright/test';
import { desktopFixture, nativeCalls } from './desktop-fixture';

// The folder picker and ZIP staging are controlled boundaries; the journey
// checks the name shown to the user and the queued request for Windows paths.
test('a Windows folder upload names only the chosen folder', async ({ page }) => {
  await desktopFixture(page, {
    pickedUploadPaths: ['C:\\Users\\Ada\\Pictures\\Holiday 2026\\'],
    zippedFolderPath: 'C:\\Users\\Ada\\AppData\\Local\\transfer-zips\\7f1c\\Holiday 2026.zip',
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Upload Folder...', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: /^Store Upload normally/ }).click();
  await expect(page.getByText('Zipping "Holiday 2026"...', { exact: true })).toBeVisible();
  await expect(page.getByText('Queued "Holiday 2026.zip" for upload', { exact: true })).toBeVisible();
  await expect.poll(async () => (await nativeCalls(page, 'cmd_transfer_enqueue_many')).length).toBe(1);
  const request = (await nativeCalls(page, 'cmd_transfer_enqueue_many'))[0].args.requests[0];
  expect(request).toMatchObject({ filename: 'Holiday 2026.zip', protectionMode: 'standard', ownerId: '101' });
  expect((await nativeCalls(page, 'cmd_zip_folder')).map(call => call.args))
    .toEqual([{ folderPath: 'C:\\Users\\Ada\\Pictures\\Holiday 2026\\' }]);
});
