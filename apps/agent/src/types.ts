export interface AppPort {
  port: number;
  name: string;
  registeredAt: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
