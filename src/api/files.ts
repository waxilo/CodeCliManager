import { invoke } from '@tauri-apps/api/core';
import type { ImportResult } from '../types';

export function listProjectFiles(projectDir: string): Promise<string[]> {
  return invoke<string[]>('list_project_files', { projectDir });
}

export function readFileContent(filePath: string): Promise<string> {
  return invoke<string>('read_file_content', { filePath });
}

export function readFileBase64(filePath: string): Promise<string> {
  return invoke<string>('read_file_base64', { filePath });
}

export function exportMarkdown(suggestedFileName: string, content: string): Promise<boolean> {
  return invoke<boolean>('export_markdown', { suggestedFileName, content });
}

export function writeClipboardImage(
  projectDir: string,
  fileName: string,
  data: number[],
): Promise<string> {
  return invoke<string>('write_clipboard_image', { projectDir, fileName, data });
}

export function writeClipboardText(
  projectDir: string,
  fileName: string,
  content: string,
): Promise<string> {
  return invoke<string>('write_clipboard_text', { projectDir, fileName, content });
}

export function importExternalPath(args: {
  source: string;
  projectDir: string;
}): Promise<ImportResult> {
  return invoke<ImportResult>('import_external_path', args);
}
