export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  readonly level: LogLevel;
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

function formatLine(level: LogLevel, message: string, fields?: Record<string, unknown>): string {
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg: message,
  };
  if (fields !== undefined && Object.keys(fields).length > 0) {
    entry["fields"] = fields;
  }
  return JSON.stringify(entry) + "\n";
}

class StderrLogger implements Logger {
  readonly level: LogLevel;

  constructor(level: LogLevel = "info") {
    this.level = level;
  }

  private enabled(at: LogLevel): boolean {
    return LEVEL_ORDER[at] >= LEVEL_ORDER[this.level];
  }

  private write(at: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (!this.enabled(at)) {
      return;
    }
    // stderr ONLY: stdout is reserved for future MCP protocol traffic.
    process.stderr.write(formatLine(at, message, fields));
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.write("debug", message, fields);
  }

  info(message: string, fields?: Record<string, unknown>): void {
    this.write("info", message, fields);
  }

  warn(message: string, fields?: Record<string, unknown>): void {
    this.write("warn", message, fields);
  }

  error(message: string, fields?: Record<string, unknown>): void {
    this.write("error", message, fields);
  }
}

export function createLogger(level: LogLevel = "info"): Logger {
  return new StderrLogger(level);
}

/** Parse a log level string; returns undefined for unknown values. */
export function parseLogLevel(value: string | undefined): LogLevel | undefined {
  if (value === "debug" || value === "info" || value === "warn" || value === "error") {
    return value;
  }
  return undefined;
}
