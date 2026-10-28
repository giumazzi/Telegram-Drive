import type { TelegramFile } from '../types';
import { formatBytes } from '../utils';

/**
 * A byte-for-byte slice of a larger file: `film.mkv.001`, `archive.7z.002`.
 * Only this form rejoins by concatenation. RAR (`.part2.rar`) and ZIP
 * (`.z01`) volumes are separate formats and stay listed part by part.
 */
const RAW_PART = /^(.+\.[a-z0-9]{1,5})\.(\d{3})$/i;

export function rawSplitPart(name: string): { base: string; part: number } | null {
  const match = name.trim().match(RAW_PART);
  return match ? { base: match[1], part: Number(match[2]) } : null;
}

function extensionOf(name: string): string | undefined {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : undefined;
}

/** The parts behind a listed file: the file itself unless it stands for a split set. */
export function expandSplitParts(files: readonly TelegramFile[]): TelegramFile[] {
  return files.flatMap(file => file.splitParts ?? [file]);
}

/**
 * Shows each complete set of raw parts (`.001` to `.N` with no gaps) as one
 * file named after the whole file, at the position of its first listed part.
 * Incomplete sets and protected files are listed as they are, so a missing
 * part stays visible.
 */
export function groupSplitFiles(files: readonly TelegramFile[]): TelegramFile[] {
  const sets = new Map<string, Array<{ file: TelegramFile; part: number; base: string }>>();
  const keyOf = (file: TelegramFile) => {
    if (file.type === 'folder' || file.splitParts || (file.encryption_state ?? 'plain') !== 'plain') return null;
    const part = rawSplitPart(file.name);
    return part ? { key: `${file.folder_id ?? 'home'}\u0000${part.base.toLocaleLowerCase()}`, ...part } : null;
  };
  for (const file of files) {
    const found = keyOf(file);
    if (!found) continue;
    sets.set(found.key, [...(sets.get(found.key) ?? []), { file, part: found.part, base: found.base }]);
  }
  const grouped = new Map<string, TelegramFile>();
  for (const [key, members] of sets) {
    const ordered = [...members].sort((left, right) => left.part - right.part);
    const complete = ordered.length >= 2 && ordered.every((member, index) => member.part === index + 1);
    if (!complete) continue;
    const parts = ordered.map(member => member.file);
    const size = parts.reduce((sum, part) => sum + part.size, 0);
    const name = ordered[0].base;
    grouped.set(key, {
      ...parts[0],
      name,
      size,
      sizeStr: formatBytes(size),
      file_ext: extensionOf(name),
      mime_type: 'application/octet-stream',
      splitParts: parts,
    });
  }
  const emitted = new Set<string>();
  return files.flatMap(file => {
    const found = keyOf(file);
    const virtual = found && grouped.get(found.key);
    if (!found || !virtual) return [file];
    if (emitted.has(found.key)) return [];
    emitted.add(found.key);
    return [virtual];
  });
}
