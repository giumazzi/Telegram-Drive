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

// Extensions dropped from a split file's name to name its folder, so that
// `Che pipandula.7z` and `film.mkv` become `Che pipandula` and `film`.
const FOLDER_NAME_EXTENSIONS = /\.(7z|zip|rar|tar|gz|bz2|xz|iso|mkv|mp4|mov|avi|m4v|webm|wmv|ts|mpg|mpeg)$/i;
/** Telegram limits channel titles; the folder keeps room for its marker. */
const MAX_FOLDER_NAME = 100;

export function splitFolderName(base: string): string {
  let name = base.trim();
  while (FOLDER_NAME_EXTENSIONS.test(name)) name = name.replace(FOLDER_NAME_EXTENSIONS, '').trim();
  return (name || base.trim()).slice(0, MAX_FOLDER_NAME).trim();
}

export interface SplitSetStep {
  /** The name of the whole file the parts make up. */
  base: string;
  files: TelegramFile[];
}

/**
 * One step per split file with at least two parts, in name order. A file
 * named exactly like the whole file (`archive.zip` beside `archive.z01`)
 * belongs to its set as the final volume.
 */
export function planSplitSteps(files: readonly TelegramFile[], origins: ReadonlyMap<number, FileOrigin>): SplitSetStep[] {
  const sets = new Map<string, { base: string; parts: Array<{ file: TelegramFile; part: number }> }>();
  const wholeFiles: Array<{ key: string; file: TelegramFile }> = [];
  for (const file of files) {
    if (file.type === 'folder') continue;
    const name = identifyingName(file, origins.get(file.id));
    const part = splitPart(name);
    if (!part) {
      wholeFiles.push({ key: name.trim().toLocaleLowerCase(), file });
      continue;
    }
    const key = part.base.toLocaleLowerCase();
    const set = sets.get(key) ?? { base: part.base, parts: [] };
    set.parts.push({ file, part: part.part });
    sets.set(key, set);
  }
  for (const { key, file } of wholeFiles) {
    sets.get(key)?.parts.push({ file, part: Number.MAX_SAFE_INTEGER });
  }
  return [...sets.values()]
    .filter(set => set.parts.length >= 2)
    .sort((left, right) => left.base.localeCompare(right.base))
    .map(set => ({
      base: set.base,
      files: [...set.parts].sort((left, right) => left.part - right.part).map(entry => entry.file),
    }));
}
