import { expect, test } from '@playwright/test';
import { desktopFixture, nativeCalls } from './desktop-fixture';

// Uploads in a network backoff are shown as waiting_for_network; credential
// waits can last indefinitely. Both must stay cancellable from the panel.
for (const direction of ['upload', 'download'] as const) {
  test(`waiting ${direction}s can be cancelled individually and with Cancel all`, async ({ page }) => {
    await desktopFixture(page, { populatedTransfers: true });
    await page.goto('/');
    const center = page.getByRole('complementary', { name: 'Transfer activity', exact: true });
    await expect(center.getByText(`Fixture ${direction}.bin`, { exact: true })).toBeVisible();

    // Leave only waiting work in this direction so Cancel all depends on it.
    await page.evaluate(({ direction }) => {
      const state = (window as any).__desktopTest;
      for (const job of state.jobs.filter((job: any) => job.direction === direction)) {
        job.status = 'completed';
        job.revision++;
        state.emit('transfer-upserted', { ...job });
      }
      for (const [index, status] of ['waiting_for_network', 'waiting_for_unlock', 'cooldown'].entries()) {
        const filename = `wait-${direction}-${status}.bin`;
        const job = { id: `wait-${direction}-${status}`, direction,
          kind: direction === 'upload' ? 'local_upload' : 'download', status, filename,
          path: `/fixture/${filename}`, messageId: 300 + index, ownerId: '101', folderId: 9,
          progress: 40, transferredBytes: 400, totalBytes: 1000, queuePosition: 20 + index,
          revision: 1, createdAt: Date.now(), updatedAt: Date.now() };
        state.jobs.push(job);
        state.emit('transfer-upserted', job);
      }
    }, { direction });

    const cancelName = (status: string) => direction === 'upload'
      ? `Cancel upload /fixture/wait-${direction}-${status}.bin`
      : `Cancel download wait-${direction}-${status}.bin`;
    for (const status of ['waiting_for_network', 'waiting_for_unlock', 'cooldown']) {
      await expect(center.getByRole('button', { name: cancelName(status), exact: true })).toBeVisible();
    }

    await center.getByRole('button', { name: cancelName('waiting_for_network'), exact: true }).click();
    await expect.poll(async () => (await nativeCalls(page, 'cmd_transfer_cancel')).map(call => call.args))
      .toEqual([{ id: `wait-${direction}-waiting_for_network`, ownerId: '101' }]);
    const row = center.locator('div.border-t').filter({ has: page.getByText(`wait-${direction}-waiting_for_network.bin`, { exact: true }) });
    await expect(row).toContainText('cancelled');

    const section = center.locator('section').filter({ has: page.getByText(direction === 'upload' ? 'Uploads' : 'Downloads', { exact: true }) });
    await section.getByRole('button', { name: 'Cancel all', exact: true }).click();
    await expect.poll(async () => (await nativeCalls(page, 'cmd_transfer_cancel_all')).map(call => call.args))
      .toEqual([{ direction, ownerId: '101' }]);
    for (const status of ['waiting_for_unlock', 'cooldown']) {
      const waitingRow = center.locator('div.border-t').filter({ has: page.getByText(`wait-${direction}-${status}.bin`, { exact: true }) });
      await expect(waitingRow).toContainText('cancelled');
    }
  });
}
