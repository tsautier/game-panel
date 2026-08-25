export interface CLIMessage {
  id: string;
  timestamp: string;
  // Pre-formatted local date/time, computed once at creation (see useCliMessages).
  displayTime?: string;
  server?: string;
  action?: string;
  message: string;
  type: 'success' | 'error' | 'info' | 'warning';
}
