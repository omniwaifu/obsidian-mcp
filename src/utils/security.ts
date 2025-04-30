import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

// Basic rate limiting for API protection
export class RateLimiter {
  private requests: Map<string, number[]> = new Map();
  private maxRequests: number;
  private timeWindow: number;

  constructor(maxRequests: number = 1000, timeWindow: number = 60000) {
    // 1000 requests per minute for local usage
    this.maxRequests = maxRequests;
    this.timeWindow = timeWindow;
  }

  checkLimit(clientId: string): boolean {
    const now = Date.now();
    const timestamps = this.requests.get(clientId) || [];

    // Remove old timestamps
    const validTimestamps = timestamps.filter(
      (time) => now - time < this.timeWindow,
    );

    if (validTimestamps.length >= this.maxRequests) {
      return false;
    }

    validTimestamps.push(now);
    this.requests.set(clientId, validTimestamps);
    return true;
  }
}

// Message size validation to prevent memory issues
const MAX_MESSAGE_SIZE = 5 * 1024 * 1024; // 5MB for local usage

export function validateMessageSize(message: any): void {
  const size = new TextEncoder().encode(JSON.stringify(message)).length;
  if (size > MAX_MESSAGE_SIZE) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Message size exceeds limit of ${MAX_MESSAGE_SIZE} bytes`,
    );
  }
}

// Connection health monitoring
export class ConnectionMonitor {
  private lastActivity: number = Date.now();
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private readonly timeout: number;
  private readonly gracePeriod: number;
  private initialized: boolean = false;

  constructor(timeout: number = 60000, gracePeriod: number = 30000) {
    // 60s timeout, 30s grace period
    this.timeout = timeout;
    this.gracePeriod = gracePeriod;
  }

  updateActivity() {
    this.lastActivity = Date.now();
  }

  start(onTimeout: () => void) {
    // Start monitoring after grace period
    setTimeout(() => {
      this.initialized = true;
      this.healthCheckInterval = setInterval(() => {
        if (Date.now() - this.lastActivity > this.timeout) {
          onTimeout();
        }
      }, 10000); // Check every 10 seconds
    }, this.gracePeriod);
  }

  stop() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }
}
