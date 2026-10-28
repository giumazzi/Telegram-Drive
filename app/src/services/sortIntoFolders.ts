import type { TelegramFile } from '../types';
import { classifyFileExtension, type SearchTypeFacet } from './searchPolicy';

export type SortCategory = Exclude<SearchTypeFacet, 'all'>;

/** Folder order shown to the user, one confirmation step each. */
export const SORT_CATEGORIES: readonly SortCategory[] = ['video', 'image', 'audio', 'document', 'archive', 'other'];

/** What Telegram reports about where a file came from (cmd_get_file_origins). */
export interface FileOrigin {
  id: number;
  originalName: string | null;
  caption: string | null;
  originalDate: string | null;
  source: string | null;
}

export interface SplitPart {
  /** The name of the whole file, such as `film.mkv` for `film.mkv.001`. */
  base: string;
  part: number;
}

// Common ways tools split a large file: film.mkv.001, archive.part2.rar,
// archive.z01 (ZIP) and archive.r00 (old RAR volumes).
const SPLIT_PATTERNS: ReadonlyArray<[RegExp, (match: RegExpMatchArray) => SplitPart]> = [
  [/^(.+)\.part0*(\d+)\.rar$/i, match => ({ base: `${match[1]}.rar`, part: Number(match[2]) })],
  [/^(.+\.[a-z0-9]{1,5})\.(\d{3})$/i, match => ({ base: match[1], part: Number(match[2]) })],
  [/^(.+)\.z(\d{2})$/i, match => ({ base: `${match[1]}.zip`, part: Number(match[2]) })],
  [/^(.+)\.r(\d{2})$/i, match => ({ base: `${match[1]}.rar`, part: Number(match[2]) + 1 })],
];

export function splitPart(name: string): SplitPart | null {
  const trimmed = name.trim();
  for (const [pattern, part] of SPLIT_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) return part(match);
  }
  return null;
}

const MIME_CATEGORIES: ReadonlyArray<[string, SortCategory]> = [
  ['video/', 'video'],
  ['image/', 'image'],
  ['audio/', 'audio'],
];

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1) : '';
}

/** The name that identifies a file best: its own filename over a caption. */
export function identifyingName(file: TelegramFile, origin?: FileOrigin): string {
  return origin?.originalName || file.name;
}

/**
 * The type of a file. A part of a split file takes the type of the whole
 * file, so `film.mkv.003` is a video and `photos.zip.002` an archive.
 */
export function sortCategory(file: TelegramFile, origin?: FileOrigin): SortCategory {
  const name = identifyingName(file, origin);
  const part = splitPart(name);
  if (part) return classifyFileExtension(extensionOf(part.base));
  const byName = classifyFileExtension(extensionOf(name));
  if (byName !== 'other') return byName;
  const byExtension = classifyFileExtension(file.file_ext ?? '');
  if (byExtension !== 'other') return byExtension;
  const mime = file.mime_type?.toLowerCase() ?? '';
  return MIME_CATEGORIES.find(([prefix]) => mime.startsWith(prefix))?.[1] ?? 'other';
}

export interface SortStep {
  category: SortCategory;
  files: TelegramFile[];
}

/**
 * One step per category that has files. Parts of the same split file sit
 * next to each other, in part order, so they are reviewed and moved together.
 */
export function planSortSteps(files: readonly TelegramFile[], origins: ReadonlyMap<number, FileOrigin>): SortStep[] {
  const byCategory = new Map<SortCategory, TelegramFile[]>();
  for (const file of files) {
    if (file.type === 'folder') continue;
    const category = sortCategory(file, origins.get(file.id));
    byCategory.set(category, [...(byCategory.get(category) ?? []), file]);
  }
  const order = (file: TelegramFile) => {
    const name = identifyingName(file, origins.get(file.id));
    const part = splitPart(name);
    return { key: (part?.base ?? name).toLocaleLowerCase(), part: part?.part ?? 0 };
  };
  return SORT_CATEGORIES.flatMap(category => {
    const members = byCategory.get(category);
    if (!members?.length) return [];
    const sorted = [...members].sort((left, right) => {
      const a = order(left);
      const b = order(right);
      return a.key.localeCompare(b.key) || a.part - b.part;
    });
    return [{ category, files: sorted }];
  });
}
