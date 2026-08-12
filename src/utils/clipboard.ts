import { copyToClipboard } from '../markdown';

export async function copyTextToClipboard(text: string): Promise<boolean> {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return copyToClipboard(trimmed);
}
