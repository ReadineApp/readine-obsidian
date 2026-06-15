// Alias shim: the NSwag-generated Logs client imports './base_logs' but the file is 'base-logs.ts'.
// Re-export all exports from base-logs so the generated client resolves correctly.
export {
  ApiClientLogsBaseConfiguration,
  ApiClientLogsBase,
} from "./base-logs";
