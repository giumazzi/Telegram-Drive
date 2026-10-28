import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { FolderInput, Plus } from 'lucide-react';
import type { TFunction } from 'i18next';
import type { TelegramFile, TelegramFolder } from '../../../types';
import { useModalFocus } from '../../../hooks/useModalFocus';
import { Button } from '../../ui';
import { formatBytes } from '../../../utils';
import {
  archiveCandidates,
  archiveContentCategory,
  identifyingName,
  planSortSteps,
  planSplitSteps,
  splitFolderName,
  splitPart,
  type ArchiveContents,
  type FileOrigin,
  type SortCategory,
} from '../../../services/sortIntoFolders';

/** `type`: one folder per kind of file. `split`: one folder per split file. */
export type SortMode = 'type' | 'split';

interface FolderStep {
  destination: string;
  files: TelegramFile[];
}

function planSteps(
  mode: SortMode,
  files: readonly TelegramFile[],
  origins: ReadonlyMap<number, FileOrigin>,
  overrides: ReadonlyMap<number, SortCategory>,
  t: TFunction,
): FolderStep[] {
  return mode === 'type'
    ? planSortSteps(files, origins, overrides).map(step => ({ destination: t(`workspace.types.${step.category}`), files: step.files }))
    : planSplitSteps(files, origins).map(step => ({ destination: splitFolderName(step.base), files: step.files }));
}

/** cmd_get_file_origins accepts at most this many ids per call. */
const ORIGIN_PAGE = 5_000;
/** cmd_inspect_archives accepts at most this many archives per call. */
const ARCHIVE_PAGE = 500;
/**
 * Moves are sent in Telegram-sized batches. A failed batch moves none of its
 * files, so the dialog always knows which files are still to be moved.
 */
const MOVE_PAGE = 100;

interface SortIntoFoldersDialogProps {
  mode: SortMode;
  ownerId: string;
  sourceFolderId: number | null;
  files: TelegramFile[];
  folders: TelegramFolder[];
  onCreateFolder: (name: string) => Promise<TelegramFolder | undefined>;
  onMove: (files: TelegramFile[], targetFolderId: number) => Promise<boolean>;
  onClose: () => void;
}

/** Telegram dates arrive as RFC 3339 or as "2026-09-07 12:00:00 UTC". */
function formatDate(value: string | null | undefined, language: string): string | null {
  if (!value) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/.test(value)
    ? `${value.slice(0, 10)}T${value.slice(11, 19)}Z`
    : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(language, { year: 'numeric', month: 'short', day: 'numeric' });
}

const sameName = (folder: TelegramFolder, name: string) =>
  folder.name.trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase();

export function SortIntoFoldersDialog({ mode, ownerId, sourceFolderId, files, folders, onCreateFolder, onMove, onClose }: SortIntoFoldersDialogProps) {
  const { t, i18n } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);
  useModalFocus(panelRef, onClose);
  const [origins, setOrigins] = useState<Map<number, FileOrigin> | null>(null);
  // What each inspected archive holds, by message id of each of its parts.
  const [archiveContents, setArchiveContents] = useState<Map<number, { contents: ArchiveContents; category: SortCategory }>>(new Map());
  const [detailsUnavailable, setDetailsUnavailable] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [moving, setMoving] = useState(false);
  const [moved, setMoved] = useState<Set<number>>(new Set());
  const [moveFailed, setMoveFailed] = useState(false);
  // Snapshot the folder's files: moves refresh the list while the dialog is open.
  const [snapshot] = useState(files);

  useEffect(() => {
    let cancelled = false;
    // Protected files are never described; their details stay encrypted.
    const ids = snapshot.filter(file => file.type !== 'folder' && (file.encryption_state ?? 'plain') === 'plain').map(file => file.id);
    void (async () => {
      const found = new Map<number, FileOrigin>();
      try {
        for (let start = 0; start < ids.length; start += ORIGIN_PAGE) {
          const page = await invoke<FileOrigin[]>('cmd_get_file_origins', {
            ownerId,
            folderId: sourceFolderId,
            messageIds: ids.slice(start, start + ORIGIN_PAGE),
          });
          for (const origin of page) found.set(origin.id, origin);
        }
      } catch {
        if (!cancelled) setDetailsUnavailable(true);
      }
      // Archives are sorted by what they hold, when their index can be read.
      const inspected = new Map<number, { contents: ArchiveContents; category: SortCategory }>();
      if (mode === 'type') {
        const candidates = archiveCandidates(snapshot, found);
        try {
          for (let start = 0; start < candidates.length && !cancelled; start += ARCHIVE_PAGE) {
            const page = candidates.slice(start, start + ARCHIVE_PAGE);
            const results = await invoke<ArchiveContents[]>('cmd_inspect_archives', {
              ownerId,
              folderId: sourceFolderId,
              archives: page.map(candidate => ({ key: candidate.key, name: candidate.name, messageIds: candidate.files.map(file => file.id) })),
            });
            for (const contents of results) {
              const candidate = page.find(item => item.key === contents.key);
              const category = archiveContentCategory(contents);
              if (!candidate || !category) continue;
              for (const file of candidate.files) inspected.set(file.id, { contents, category });
            }
          }
        } catch {
          // Unread archives simply stay with the other archives.
        }
      }
      if (!cancelled) {
        setArchiveContents(inspected);
        setOrigins(found);
      }
    })();
    return () => { cancelled = true; };
  }, [mode, ownerId, snapshot, sourceFolderId]);

  const steps = useMemo<FolderStep[]>(() => {
    if (!origins) return [];
    // Files already in their destination folder are sorted.
    const overrides = new Map([...archiveContents].map(([id, inspected]) => [id, inspected.category]));
    return planSteps(mode, snapshot, origins, overrides, t).filter(step => {
      const existing = folders.find(folder => sameName(folder, step.destination));
      return !existing || existing.id !== sourceFolderId;
    });
  }, [mode, origins, archiveContents, snapshot, folders, sourceFolderId, t]);

  const step = steps[stepIndex];
  const finished = origins !== null && stepIndex >= steps.length;
  const stepFiles = step ? step.files.filter(file => !moved.has(file.id)) : [];
  const selected = stepFiles.filter(file => !excluded.has(file.id));
  const destination = step?.destination ?? '';
  const existingTarget = step ? folders.find(folder => sameName(folder, destination)) : undefined;

  const toggle = (id: number) => setExcluded(previous => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const setAll = (include: boolean) => setExcluded(previous => {
    const next = new Set(previous);
    for (const file of stepFiles) {
      if (include) next.delete(file.id); else next.add(file.id);
    }
    return next;
  });

  const next = () => {
    setMoveFailed(false);
    setStepIndex(index => index + 1);
  };
  const moveSelected = async () => {
    if (!step || selected.length === 0 || moving) return;
    setMoving(true);
    setMoveFailed(false);
    try {
      const target = existingTarget ?? await onCreateFolder(destination).catch(() => undefined);
      if (!target) return;
      for (let start = 0; start < selected.length; start += MOVE_PAGE) {
        const batch = selected.slice(start, start + MOVE_PAGE);
        if (!await onMove(batch, target.id)) {
          // Earlier batches stay moved; the rest remain listed for a retry.
          setMoveFailed(true);
          return;
        }
        setMoved(previous => new Set([...previous, ...batch.map(file => file.id)]));
      }
      next();
    } finally {
      setMoving(false);
    }
  };

  const describe = (file: TelegramFile) => {
    const origin = origins?.get(file.id);
    const name = identifyingName(file, origin);
    const lines: string[] = [];
    const inspected = archiveContents.get(file.id);
    if (inspected) {
      const [first] = inspected.contents.entries;
      lines.push(t('sort_folders.archive_contains', { name: first.name.split('/').pop(), count: inspected.contents.totalEntries }));
    }
    if (origin?.originalName && origin.originalName !== file.name) lines.push(t('sort_folders.original_name', { name: origin.originalName }));
    if (origin?.caption && origin.caption !== file.name) lines.push(origin.caption);
    const posted = formatDate(origin?.originalDate, i18n.language);
    if (posted) {
      lines.push(origin?.source
        ? t('sort_folders.posted_by', { date: posted, source: origin.source })
        : t('sort_folders.posted', { date: posted }));
    } else {
      const uploaded = formatDate(file.created_at, i18n.language);
      if (uploaded) lines.push(t('sort_folders.uploaded', { date: uploaded }));
    }
    return { part: splitPart(name)?.part, archive: Boolean(inspected), lines };
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-app-overlay p-4 backdrop-blur-sm">
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="sort-folders-title" tabIndex={-1} className="quiet-raised flex max-h-[85vh] w-[min(640px,calc(100vw-2rem))] flex-col overflow-hidden">
        <div className="flex items-start justify-between gap-3 border-b border-app-border-subtle p-4">
          <div className="min-w-0">
            <h3 id="sort-folders-title" className="font-medium text-app-text">{t(mode === 'type' ? 'sort_folders.title' : 'sort_folders.split_title')}</h3>
            <p className="mt-1 text-metadata text-app-text-secondary">{t(mode === 'type' ? 'sort_folders.intro' : 'sort_folders.split_intro')}</p>
          </div>
          <button type="button" onClick={onClose} aria-label={t('common.close')} className="text-app-text-secondary hover:text-app-text"><Plus className="h-5 w-5 rotate-45" /></button>
        </div>

        {origins === null && <p className="p-6 text-center text-sm text-app-text-secondary" role="status">{t('sort_folders.loading')}</p>}

        {origins !== null && detailsUnavailable && (
          <p className="border-b border-app-border-subtle px-4 py-2 text-metadata text-app-warning" role="status">{t('sort_folders.details_unavailable')}</p>
        )}

        {step && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-app-border-subtle px-4 py-3">
              <div className="min-w-0">
                <p className="text-badge font-medium uppercase tracking-wider text-app-text-tertiary">{t('sort_folders.step', { current: stepIndex + 1, total: steps.length })}</p>
                <p className="flex items-center gap-2 text-sm font-medium text-app-text">
                  <FolderInput className="h-4 w-4 shrink-0 text-app-accent" aria-hidden="true" />
                  {existingTarget ? t('sort_folders.destination', { folder: destination }) : t('sort_folders.destination_new', { folder: destination })}
                </p>
              </div>
              <div className="flex items-center gap-3 text-metadata">
                <span className="text-app-text-secondary">{t('sort_folders.selected', { selected: selected.length, total: stepFiles.length })}</span>
                <button type="button" className="text-app-accent" onClick={() => setAll(true)}>{t('sort_folders.select_all')}</button>
                <button type="button" className="text-app-accent" onClick={() => setAll(false)}>{t('sort_folders.select_none')}</button>
              </div>
            </div>
            <ul className="flex-1 overflow-y-auto" aria-label={destination}>
              {stepFiles.map(file => {
                const { part, archive, lines } = describe(file);
                return (
                  <li key={file.id} className="border-b border-app-border-subtle px-4 py-2.5 last:border-b-0">
                    <label className="flex cursor-pointer items-start gap-3">
                      <input type="checkbox" className="mt-1" checked={!excluded.has(file.id)} onChange={() => toggle(file.id)} aria-label={t('sort_folders.include', { name: file.name })} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-sm text-app-text" title={file.name}>{file.name}</span>
                          {archive && <span className="shrink-0 rounded-full bg-app-warning/15 px-2 text-badge text-app-warning">{t('sort_folders.archive_badge')}</span>}
                          {part !== undefined && <span className="shrink-0 rounded-full bg-app-selected px-2 text-badge text-app-accent">{t('sort_folders.part', { part })}</span>}
                        </span>
                        {lines.map(line => <span key={line} className="block truncate text-metadata text-app-text-secondary" title={line}>{line}</span>)}
                      </span>
                      <span className="shrink-0 text-metadata tabular-nums text-app-text-tertiary">{formatBytes(file.size)}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
            {moveFailed && <p className="border-t border-app-border-subtle px-4 py-2 text-metadata text-app-danger" role="alert">{t('sort_folders.move_failed')}</p>}
            <div className="flex justify-end gap-2 border-t border-app-border-subtle p-3">
              <Button onClick={next} disabled={moving}>{t('sort_folders.skip')}</Button>
              <Button variant="primary" onClick={() => void moveSelected()} disabled={moving || selected.length === 0}>
                {moving ? t('sort_folders.moving') : t('sort_folders.move')}
              </Button>
            </div>
          </>
        )}

        {finished && (
          <div className="flex flex-col items-center gap-3 p-6 text-center" role="status">
            <p className="text-sm text-app-text">{steps.length === 0 ? t(mode === 'type' ? 'sort_folders.nothing' : 'sort_folders.split_nothing') : t('sort_folders.done', { count: moved.size })}</p>
            <Button onClick={onClose}>{t('common.close')}</Button>
          </div>
        )}
      </div>
    </div>
  );
}
