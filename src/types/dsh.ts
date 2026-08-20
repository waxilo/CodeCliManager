/** DSH 状态（dsh_status 返回值） */
export interface DshStatusData {
  installedVersion: string | null;
  latestVersion: string | null;
  running: boolean;
  port: number;
  error: string | null;
}
