#!/usr/bin/env tsx

/**
 * Channel Account Retry Handler
 * 
 * Handles channel account exhaustion with intelligent retry logic,
 * rate limiting, and graceful degradation.
 */

interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  exponentialBase: number;
  jitterMs: number;
}

interface ChannelAccountStatus {
  available: number;
  total: number;
  utilizationRate: number;
}

export class ChannelAccountRetryHandler {
  private defaultConfig: RetryConfig = {
    maxRetries: 5,
    baseDelayMs: 1000,      // Start with 1 second
    maxDelayMs: 30000,      // Max 30 seconds
    exponentialBase: 2,     // Double each time
    jitterMs: 500          // Add randomness
  };

  private operationQueue: Array<{
    operation: () => Promise<any>;
    resolve: (value: any) => void;
    reject: (error: any) => void;
    retryCount: number;
    walletId: string;
    operationType: string;
  }> = [];

  private isProcessing = false;
  private rateLimitMs = 0; // Dynamic rate limiting
  private recentChannelErrors: number[] = []; // timestamps of recent channel exhaustion errors

  /**
   * Execute operation with channel account retry logic
   */
  async executeWithRetry<T>(
    operation: () => Promise<T>,
    walletId: string,
    operationType: string,
    config: Partial<RetryConfig> = {}
  ): Promise<T> {
    const finalConfig = { ...this.defaultConfig, ...config };
    
    return new Promise<T>((resolve, reject) => {
      this.operationQueue.push({
        operation,
        resolve,
        reject,
        retryCount: 0,
        walletId,
        operationType
      });

      if (!this.isProcessing) {
        this.processQueue();
      }
    });
  }

  /**
   * Process the operation queue with intelligent rate limiting
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.operationQueue.length === 0) {
      return;
    }

    this.isProcessing = true;
    console.log(`🔄 Processing ${this.operationQueue.length} queued operations...`);

    while (this.operationQueue.length > 0) {
      const item = this.operationQueue.shift()!;
      
      try {
        // Apply rate limiting if set
        if (this.rateLimitMs > 0) {
          console.log(`⏳ Rate limiting: waiting ${this.rateLimitMs}ms before ${item.operationType} for ${item.walletId}`);
          await this.sleep(this.rateLimitMs);
        }

        const result = await item.operation();
        item.resolve(result);
        console.log(`✅ ${item.walletId}: ${item.operationType} succeeded after ${item.retryCount} retries`);
        
        // Success - reduce rate limiting
        this.rateLimitMs = Math.max(0, this.rateLimitMs - 100);
        
      } catch (error: any) {
        const isChannelExhaustion = this.isChannelAccountExhaustion(error);
        
        if (isChannelExhaustion && item.retryCount < this.defaultConfig.maxRetries) {
          // Channel exhaustion - retry with backoff
          await this.handleChannelExhaustion(item);
        } else if (item.retryCount < this.defaultConfig.maxRetries && this.isRetryableError(error)) {
          // Other retryable error
          await this.handleRetryableError(item, error);
        } else {
          // Max retries exceeded or non-retryable error
          console.log(`❌ ${item.walletId}: ${item.operationType} failed permanently: ${this.getErrorMessage(error)}`);
          item.reject(error);
        }
      }
    }

    this.isProcessing = false;
  }

  /**
   * Handle channel account exhaustion with adaptive backoff
   */
  private async handleChannelExhaustion(item: any): Promise<void> {
    item.retryCount++;
    
    // Get current channel account status
    const status = await this.getChannelAccountStatus();
    
    // Calculate adaptive delay based on utilization
    const baseDelay = this.calculateAdaptiveDelay(status, item.retryCount);
    const jitter = Math.random() * this.defaultConfig.jitterMs;
    const delay = Math.min(baseDelay + jitter, this.defaultConfig.maxDelayMs);

    console.log(`🚫 ${item.walletId}: Channel exhaustion (${status.available}/${status.total} available, ${status.utilizationRate.toFixed(1)}% used)`);
    console.log(`⏳ ${item.walletId}: Retrying ${item.operationType} in ${(delay/1000).toFixed(1)}s (attempt ${item.retryCount}/${this.defaultConfig.maxRetries})`);

    // Increase global rate limiting to reduce pressure
    this.rateLimitMs = Math.min(5000, this.rateLimitMs + 200);

    await this.sleep(delay);
    
    // Re-queue the operation
    this.operationQueue.unshift(item);

    // Channel exhaustion event
    this.recordChannelExhaustion();
  }

  /**
   * Handle other retryable errors
   */
  private async handleRetryableError(item: any, error: any): Promise<void> {
    item.retryCount++;
    
    const delay = Math.min(
      this.defaultConfig.baseDelayMs * Math.pow(this.defaultConfig.exponentialBase, item.retryCount - 1),
      this.defaultConfig.maxDelayMs
    );

    console.log(`⚠️ ${item.walletId}: ${item.operationType} failed (${this.getErrorMessage(error)})`);
    console.log(`🔄 ${item.walletId}: Retrying in ${(delay/1000).toFixed(1)}s (attempt ${item.retryCount}/${this.defaultConfig.maxRetries})`);

    await this.sleep(delay);
    this.operationQueue.unshift(item);
  }

  /**
   * Calculate adaptive delay based on channel account status
   */
  private calculateAdaptiveDelay(status: ChannelAccountStatus, retryCount: number): number {
    const baseDelay = this.defaultConfig.baseDelayMs;
    const exponentialDelay = baseDelay * Math.pow(this.defaultConfig.exponentialBase, retryCount - 1);
    
    // Add utilization-based delay
    const utilizationMultiplier = 1 + (status.utilizationRate / 100) * 2; // Up to 3x delay at 100% utilization
    
    // Add scarcity-based delay
    const scarcityMultiplier = status.available === 0 ? 3 : (1 + (1 - status.available / status.total));
    
    return exponentialDelay * utilizationMultiplier * scarcityMultiplier;
  }

  // ====================================================================================
  // Channel account status
  // ====================================================================================
  /**
   * Get current channel account status.
   *
   * Priority:
   * 1. Environment variable ENABLE_CHANNEL_STATUS_DB=true  → query PostgreSQL (like before)
   * 2. Wallet-backend /health endpoint (if provided)       → TODO (future)
   * 3. Fallback heuristic based on queue length + recent channel exhaustion errors
   */
  private async getChannelAccountStatus(): Promise<ChannelAccountStatus> {
    // Decide strategy based on env variable
    const useDb = process.env.ENABLE_CHANNEL_STATUS_DB === 'true';
    if (useDb) {
      console.log('🔍 Channel status: using PostgreSQL database (ENABLE_CHANNEL_STATUS_DB=true)');
    } else {
      console.log('🔍 Channel status: using heuristic (ENABLE_CHANNEL_STATUS_DB not set)');
    }

    // If the user explicitly enables DB status, keep original behaviour
    if (useDb) {
      try {
        const { Client } = await import('pg');
        const client = new Client({
          host: process.env.DB_HOST || 'localhost',
          port: parseInt(process.env.DB_PORT || '5432', 10),
          database: process.env.DB_NAME || 'wallet-backend',
          user: process.env.DB_USER || 'postgres',
          password: process.env.DB_PASSWORD || 'password'
        });
        await client.connect();
        const result = await client.query(`
          SELECT 
            COUNT(*)                         AS total_accounts,
            COUNT(*) FILTER (WHERE locked_until > NOW())                       AS locked_accounts,
            COUNT(*) FILTER (WHERE locked_until IS NULL OR locked_until <= NOW()) AS available_accounts
          FROM channel_accounts`);
        await client.end();
        const { total_accounts, locked_accounts, available_accounts } = result.rows[0];
        const utilizationRate = total_accounts > 0 ? (locked_accounts / total_accounts) * 100 : 0;
        return {
          available: parseInt(available_accounts),
          total: parseInt(total_accounts),
          utilizationRate
        };
      } catch (error) {
        console.warn('⚠️  Failed to query DB for channel status – falling back to heuristic.');
      }
    }

    // ----- Heuristic fallback -----
    const queueLen = this.operationQueue.length;
    const pendingRate = Math.min(100, queueLen * 5); // each queued op ≈ 5% utilisation

    // Recent channel exhaustion events
    const now = Date.now();
    this.recentChannelErrors = this.recentChannelErrors.filter(ts => now - ts < 120000);
    const errorRate = Math.min(100, this.recentChannelErrors.length * 10); // each error adds 10%

    const utilizationRate = Math.min(100, pendingRate + errorRate);
    const total = 100; // assume pool of 100 for estimation
    const available = Math.max(0, Math.round(total * (1 - utilizationRate / 100)));

    return {
      available,
      total,
      utilizationRate
    };
  }

  // ====================================================================================
  // Helper methods
  // ====================================================================================

  /**
   * Check if error is due to channel account exhaustion
   */
  private isChannelAccountExhaustion(error: any): boolean {
    const message = this.getErrorMessage(error).toLowerCase();
    return message.includes('no idle channel account available') ||
           message.includes('channel account') ||
           message.includes('no available channel account');
  }

  /**
   * Check if error is retryable
   */
  private isRetryableError(error: any): boolean {
    const message = this.getErrorMessage(error).toLowerCase();
    
    // Non-retryable errors
    const nonRetryablePatterns = [
      'invalid signature',
      'account not found',
      'insufficient funds',
      'bad auth',
      'malformed transaction'
    ];

    if (nonRetryablePatterns.some(pattern => message.includes(pattern))) {
      return false;
    }

    // Retryable errors
    const retryablePatterns = [
      'timeout',
      'network error',
      'connection',
      'temporary',
      'try again',
      'server error',
      'http 5'
    ];

    return retryablePatterns.some(pattern => message.includes(pattern)) ||
           this.isChannelAccountExhaustion(error);
  }

  /**
   * Extract error message from various error types
   */
  private getErrorMessage(error: any): string {
    if (typeof error === 'string') {
      return error;
    }
    
    if (error?.message) {
      return error.message;
    }
    
    if (error?.error) {
      return typeof error.error === 'string' ? error.error : JSON.stringify(error.error);
    }
    
    return JSON.stringify(error);
  }

  /**
   * Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Record channel exhaustion event
   */
  private recordChannelExhaustion(): void {
    const now = Date.now();
    this.recentChannelErrors.push(now);
    // Keep only events from last 2 minutes
    this.recentChannelErrors = this.recentChannelErrors.filter(ts => now - ts < 120000);
  }

  /**
   * Get retry handler statistics
   */
  getStats(): { queueLength: number; rateLimitMs: number; isProcessing: boolean } {
    return {
      queueLength: this.operationQueue.length,
      rateLimitMs: this.rateLimitMs,
      isProcessing: this.isProcessing
    };
  }

  /**
   * Clear the operation queue (emergency stop)
   */
  clearQueue(): void {
    const remainingOps = this.operationQueue.length;
    this.operationQueue.forEach(item => {
      item.reject(new Error('Operation cancelled - queue cleared'));
    });
    this.operationQueue = [];
    console.log(`🛑 Cleared ${remainingOps} pending operations from queue`);
  }
}

// Export singleton instance
export const retryHandler = new ChannelAccountRetryHandler(); 