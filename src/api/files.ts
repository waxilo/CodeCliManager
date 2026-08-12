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

export function writeFileBytes(filePath: string, data: number[]): Promise<void> {
  return invoke('write_file_bytes', { filePath, data });
}

export function importExternalPath(args: {
  source: string;
  projectDir: string;
}): Promise<ImportResult> {
  return invoke<ImportResult>('import_external_path', args);
}
