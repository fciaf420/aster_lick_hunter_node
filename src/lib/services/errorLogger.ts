import { errorLogsDb, type ErrorLog } from '../db/errorLogsDb';
import { v4 as uuidv4 } from 'uuid';
import os from 'os';

export type ErrorType = 'websocket' | 'api' | 'trading' | 'config' | 'general' | 'system';
export type ErrorSeverity = 'low' | 'medium' | 'high' | 'critical';

interface ErrorContext {
  component?: string;
  symbol?: string;
  userAction?: string;
  metadata?: Record<string, any>;
  marketSnapshot?: MarketConditions;
  recentActions?: string[];
  correlationId?: string;
}

interface MarketConditions {
  timestamp: string;
  symbol?: string;
  price?: number;
  volume24h?: number;
  openInterest?: number;
  recentLiquidations?: number;
  volatility?: number;
}

interface SystemInfo {
  platform: string;
  version: string;
  memory: {
    total: number;
    free: number;
    used: number;
  };
  uptime: number;
}

class ErrorLogger {
  private static instance: ErrorLogger;
  private sessionId: string;
  private recentErrors: Map<string, { count: number; lastSeen: Date }> = new Map();
  private errorBuffer: ErrorLog[] = [];
  private flushInterval: NodeJS.Timeout | null = null;
  private maxBufferSize = 50;
  private flushIntervalMs = 5000;
  private recentActionBuffer: string[] = [];
  private maxActionBufferSize = 20;
  private errorPatterns: Map<string, { pattern: string; suggestedFix: string }> = new Map();

  private constructor() {
    this.sessionId = uuidv4();
    this.startFlushInterval();
    this.initializeErrorPatterns();

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      this.logError(error, {
        type: 'system',
        severity: 'critical',
        context: { component: 'process' }
      }).finally(() => {
        console.error('Uncaught Exception:', error);
      });
    });

    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason, _promise) => {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      this.logError(error, {
        type: 'system',
        severity: 'high',
        context: { component: 'promise' }
      }).finally(() => {
        console.error('Unhandled Rejection:', reason);
      });
    });

    console.log(`Error Logger initialized with session ID: ${this.sessionId}`);
  }

  public static getInstance(): ErrorLogger {
    if (!ErrorLogger.instance) {
      ErrorLogger.instance = new ErrorLogger();
    }
    return ErrorLogger.instance;
  }

  private initializeErrorPatterns(): void {
    // Common error patterns and their suggested fixes
    this.errorPatterns.set('-4164', {
      pattern: 'MIN_NOTIONAL',
      suggestedFix: 'Increase order size or leverage to meet minimum notional requirement'
    });
    this.errorPatterns.set('-1003', {
      pattern: 'RATE_LIMIT',
      suggestedFix: 'Implement exponential backoff and request queuing'
    });
    this.errorPatterns.set('-2019', {
      pattern: 'INSUFFICIENT_BALANCE',
      suggestedFix: 'Check available balance before placing orders'
    });
    this.errorPatterns.set('-1111', {
      pattern: 'PRICE_PRECISION',
      suggestedFix: 'Round price to exchange-required tick size'
    });
    this.errorPatterns.set('-1013', {
      pattern: 'QUANTITY_PRECISION',
      suggestedFix: 'Round quantity to exchange-required step size'
    });
    this.errorPatterns.set('ECONNREFUSED', {
      pattern: 'CONNECTION_REFUSED',
      suggestedFix: 'Check network connectivity and API endpoint availability'
    });
    this.errorPatterns.set('ETIMEDOUT', {
      pattern: 'TIMEOUT',
      suggestedFix: 'Increase timeout duration or improve network stability'
    });
  }

  public trackAction(action: string): void {
    const timestampedAction = `[${new Date().toISOString()}] ${action}`;
    this.recentActionBuffer.push(timestampedAction);

    if (this.recentActionBuffer.length > this.maxActionBufferSize) {
      this.recentActionBuffer.shift();
    }
  }

  public getRecentActions(): string[] {
    return [...this.recentActionBuffer];
  }

  private startFlushInterval(): void {
    this.flushInterval = setInterval(() => {
      this.flushBuffer();
    }, this.flushIntervalMs);
  }

  private async flushBuffer(): Promise<void> {
    if (this.errorBuffer.length === 0) return;

    const errors = [...this.errorBuffer];
    this.errorBuffer = [];

    for (const error of errors) {
      try {
        await errorLogsDb.logError(error);
      } catch (err) {
        console.error('Failed to flush error to database:', err);
        // Re-add to buffer if failed
        this.errorBuffer.push(error);
      }
    }
  }

  private determineSeverity(error: Error, explicitSeverity?: ErrorSeverity): ErrorSeverity {
    if (explicitSeverity) return explicitSeverity;

    // Auto-determine severity based on error characteristics
    const errorMessage = error.message.toLowerCase();

    if (
      errorMessage.includes('critical') ||
      errorMessage.includes('fatal') ||
      errorMessage.includes('crash')
    ) {
      return 'critical';
    }

    if (
      errorMessage.includes('failed') ||
      errorMessage.includes('error') ||
      errorMessage.includes('rejected') ||
      error.name === 'TypeError' ||
      error.name === 'ReferenceError'
    ) {
      return 'high';
    }

    if (
      errorMessage.includes('warning') ||
      errorMessage.includes('retry') ||
      errorMessage.includes('timeout')
    ) {
      return 'medium';
    }

    return 'low';
  }

  private determineErrorType(error: Error, explicitType?: ErrorType): ErrorType {
    if (explicitType) return explicitType;

    const errorMessage = error.message.toLowerCase();
    const errorName = error.name.toLowerCase();

    if (errorMessage.includes('websocket') || errorMessage.includes('connection')) {
      return 'websocket';
    }

    if (
      errorMessage.includes('api') ||
      errorMessage.includes('request') ||
      errorMessage.includes('response') ||
      errorMessage.includes('401') ||
      errorMessage.includes('403') ||
      errorMessage.includes('429')
    ) {
      return 'api';
    }

    if (
      errorMessage.includes('trade') ||
      errorMessage.includes('order') ||
      errorMessage.includes('position') ||
      errorMessage.includes('balance') ||
      errorName.includes('trading')
    ) {
      return 'trading';
    }

    if (errorMessage.includes('config') || errorMessage.includes('setting')) {
      return 'config';
    }

    if (errorName.includes('system') || errorName.includes('critical')) {
      return 'system';
    }

    return 'general';
  }

  private isDuplicateError(error: Error): boolean {
    const errorKey = `${error.name}:${error.message}`;
    const existing = this.recentErrors.get(errorKey);

    if (existing) {
      const timeDiff = Date.now() - existing.lastSeen.getTime();
      // Consider it duplicate if same error within 1 minute
      if (timeDiff < 60000) {
        existing.count++;
        existing.lastSeen = new Date();
        return true;
      }
    }

    this.recentErrors.set(errorKey, { count: 1, lastSeen: new Date() });

    // Clean up old entries
    if (this.recentErrors.size > 100) {
      const oldestKey = this.recentErrors.keys().next().value;
      if (oldestKey) this.recentErrors.delete(oldestKey);
    }

    return false;
  }

  public async logError(
    error: Error | string,
    options: {
      type?: ErrorType;
      severity?: ErrorSeverity;
      context?: ErrorContext;
      code?: string;
    } = {}
  ): Promise<number | null> {
    try {
      const errorObj = error instanceof Error ? error : new Error(String(error));

      // Skip duplicate errors within time window
      if (this.isDuplicateError(errorObj)) {
        return null;
      }

      const errorType = this.determineErrorType(errorObj, options.type);
      const severity = this.determineSeverity(errorObj, options.severity);

      const errorLog: Omit<ErrorLog, 'id' | 'created_at'> = {
        timestamp: new Date().toISOString(),
        error_type: errorType,
        error_code: options.code,
        message: errorObj.message,
        stack_trace: errorObj.stack,
        component: options.context?.component,
        symbol: options.context?.symbol,
        user_action: options.context?.userAction,
        severity,
        session_id: this.sessionId,
        resolved: false,
        details: options.context?.metadata ? JSON.stringify(options.context.metadata) : undefined
      };

      // Add to buffer for batch processing
      this.errorBuffer.push(errorLog);

      // Flush immediately if buffer is full or error is critical
      if (this.errorBuffer.length >= this.maxBufferSize || severity === 'critical') {
        await this.flushBuffer();
      }

      // Log to console for immediate visibility
      this.logToConsole(errorObj, errorType, severity, options.context);

      return 1; // Return a placeholder ID
    } catch (err) {
      console.error('Failed to log error:', err);
      return null;
    }
  }

  private logToConsole(
    error: Error,
    type: ErrorType,
    severity: ErrorSeverity,
    context?: ErrorContext
  ): void {
    const severityEmoji = {
      low: '📝',
      medium: '⚠️',
      high: '🔥',
      critical: '💀'
    };

    const typeEmoji = {
      websocket: '🔌',
      api: '🌐',
      trading: '💰',
      config: '⚙️',
      general: '📋',
      system: '💻'
    };

    const emoji = `${severityEmoji[severity]} ${typeEmoji[type]}`;
    const contextStr = context
      ? ` [${[context.component, context.symbol, context.userAction]
          .filter(Boolean)
          .join(' | ')}]`
      : '';

    console.error(`${emoji} ${type.toUpperCase()} ERROR${contextStr}: ${error.message}`);

    if (severity === 'high' || severity === 'critical') {
      console.error('Stack trace:', error.stack);
    }
  }

  public async logApiError(
    endpoint: string,
    method: string,
    statusCode: number,
    response: any,
    context?: ErrorContext
  ): Promise<void> {
    const message = `API Error: ${method} ${endpoint} returned ${statusCode}`;
    const error = new Error(message);

    await this.logError(error, {
      type: 'api',
      severity: statusCode >= 500 ? 'high' : 'medium',
      code: `HTTP_${statusCode}`,
      context: {
        ...context,
        metadata: {
          endpoint,
          method,
          statusCode,
          response: typeof response === 'object' ? response : { body: response }
        }
      }
    });
  }

  public async logTradingError(
    operation: string,
    symbol: string,
    error: Error,
    details?: Record<string, any>
  ): Promise<void> {
    await this.logError(error, {
      type: 'trading',
      severity: 'high',
      context: {
        component: 'trading',
        symbol,
        userAction: operation,
        metadata: details
      }
    });
  }

  public async logWebSocketError(
    url: string,
    error: Error,
    reconnectAttempt?: number
  ): Promise<void> {
    await this.logError(error, {
      type: 'websocket',
      severity: reconnectAttempt && reconnectAttempt > 3 ? 'high' : 'medium',
      context: {
        component: 'websocket',
        metadata: {
          url,
          reconnectAttempt
        }
      }
    });
  }

  public getSessionId(): string {
    return this.sessionId;
  }

  public async getSessionErrors(): Promise<ErrorLog[]> {
    try {
      const errors = await errorLogsDb.getErrors(1000, 0, {
        sessionId: this.sessionId
      });
      return errors;
    } catch (error) {
      console.error('Failed to get session errors:', error);
      return [];
    }
  }

  public getSystemInfo(): SystemInfo {
    return {
      platform: process.platform,
      version: process.version,
      memory: {
        total: os.totalmem(),
        free: os.freemem(),
        used: os.totalmem() - os.freemem()
      },
      uptime: process.uptime()
    };
  }

  public generateAIOptimizedDebugInfo(error: ErrorLog, context?: ErrorContext): string {
    let debugInfo = `## AI-Optimized Debug Report\n\n`;

    // Error classification
    debugInfo += `### Error Classification\n`;
    debugInfo += `- **Type**: ${error.error_type}\n`;
    debugInfo += `- **Severity**: ${error.severity}\n`;
    debugInfo += `- **Component**: ${error.component || 'Unknown'}\n`;
    if (error.error_code) {
      debugInfo += `- **Error Code**: ${error.error_code}\n`;
      const pattern = this.errorPatterns.get(error.error_code);
      if (pattern) {
        debugInfo += `- **Pattern**: ${pattern.pattern}\n`;
      }
    }
    debugInfo += `\n`;

    // Environment and context
    debugInfo += `### Environment\n`;
    const systemInfo = this.getSystemInfo();
    debugInfo += `- **Platform**: ${systemInfo.platform}\n`;
    debugInfo += `- **Node Version**: ${systemInfo.version}\n`;
    debugInfo += `- **Memory Usage**: ${Math.round(systemInfo.memory.used / 1024 / 1024)}MB / ${Math.round(systemInfo.memory.total / 1024 / 1024)}MB\n`;
    debugInfo += `- **Session ID**: ${error.session_id}\n`;
    debugInfo += `- **Timestamp**: ${error.timestamp}\n`;
    debugInfo += `\n`;

    // Market conditions if available
    if (context?.marketSnapshot) {
      debugInfo += `### Market Conditions at Error Time\n`;
      const snapshot = context.marketSnapshot;
      if (snapshot.symbol) debugInfo += `- **Symbol**: ${snapshot.symbol}\n`;
      if (snapshot.price) debugInfo += `- **Price**: $${snapshot.price}\n`;
      if (snapshot.volume24h) debugInfo += `- **24h Volume**: $${snapshot.volume24h.toLocaleString()}\n`;
      if (snapshot.volatility) debugInfo += `- **Volatility**: ${snapshot.volatility.toFixed(2)}%\n`;
      if (snapshot.recentLiquidations) debugInfo += `- **Recent Liquidations**: ${snapshot.recentLiquidations}\n`;
      debugInfo += `\n`;
    }

    // Recent actions leading to error
    const recentActions = context?.recentActions || this.getRecentActions();
    if (recentActions.length > 0) {
      debugInfo += `### Recent Actions (Reproduction Steps)\n`;
      recentActions.forEach((action, idx) => {
        debugInfo += `${idx + 1}. ${action}\n`;
      });
      debugInfo += `\n`;
    }

    // Error details
    debugInfo += `### Error Details\n`;
    debugInfo += `\`\`\`\n${error.message}\n\`\`\`\n\n`;

    if (error.details) {
      debugInfo += `### Additional Context\n`;
      debugInfo += `\`\`\`json\n${typeof error.details === 'string' ? error.details : JSON.stringify(error.details, null, 2)}\n\`\`\`\n\n`;
    }

    if (error.stack_trace) {
      debugInfo += `### Stack Trace\n`;
      debugInfo += `<details>\n<summary>Click to expand</summary>\n\n`;
      debugInfo += `\`\`\`\n${error.stack_trace}\n\`\`\`\n`;
      debugInfo += `</details>\n\n`;
    }

    // AI-friendly investigation steps and fixes
    debugInfo += `### Suggested Investigation\n`;
    const errorCode = error.error_code;
    const pattern = errorCode ? this.errorPatterns.get(errorCode) : null;

    if (pattern) {
      debugInfo += `**Known Pattern Detected**: ${pattern.pattern}\n\n`;
      debugInfo += `**Suggested Fix**: ${pattern.suggestedFix}\n\n`;
    }

    // Generic investigation steps based on error type
    switch (error.error_type) {
      case 'api':
        debugInfo += `1. Check API endpoint status and connectivity\n`;
        debugInfo += `2. Verify API credentials and permissions\n`;
        debugInfo += `3. Review rate limiting and request throttling\n`;
        break;
      case 'trading':
        debugInfo += `1. Verify order parameters meet exchange requirements\n`;
        debugInfo += `2. Check account balance and margin requirements\n`;
        debugInfo += `3. Review symbol trading rules and filters\n`;
        break;
      case 'websocket':
        debugInfo += `1. Check WebSocket connection stability\n`;
        debugInfo += `2. Review reconnection logic and backoff strategy\n`;
        debugInfo += `3. Verify message parsing and error handling\n`;
        break;
      case 'system':
        debugInfo += `1. Check system resources (CPU, memory, disk)\n`;
        debugInfo += `2. Review process health and crash logs\n`;
        debugInfo += `3. Verify environment configuration\n`;
        break;
    }

    debugInfo += `\n### Correlation\n`;
    if (context?.correlationId) {
      debugInfo += `**Correlation ID**: ${context.correlationId}\n`;
      debugInfo += `Use this ID to find related errors and trace the full error chain.\n`;
    }

    // Check for similar recent errors
    const errorKey = `${error.error_type}:${error.error_code || 'NO_CODE'}`;
    const similarError = this.recentErrors.get(errorKey);
    if (similarError && similarError.count > 1) {
      debugInfo += `\n### Pattern Recognition\n`;
      debugInfo += `This error has occurred **${similarError.count} times** in the current session.\n`;
      debugInfo += `Last seen: ${similarError.lastSeen.toISOString()}\n`;
    }

    debugInfo += `\n---\n`;
    debugInfo += `*Generated for AI-assisted debugging. Copy this report to Claude, ChatGPT, or GitHub Copilot for analysis.*\n`;

    return debugInfo;
  }

  public async generateBugReport(hours: number = 24): Promise<string> {
    try {
      const { errors, stats } = await errorLogsDb.exportErrors(this.sessionId, hours);
      const systemInfo = this.getSystemInfo();

      let report = `# Bug Report\n\n`;
      report += `**Generated:** ${new Date().toISOString()}\n`;
      report += `**Session ID:** ${this.sessionId}\n\n`;

      report += `## System Information\n`;
      report += `- Platform: ${systemInfo.platform}\n`;
      report += `- Node Version: ${systemInfo.version}\n`;
      report += `- Memory: ${Math.round(systemInfo.memory.used / 1024 / 1024)}MB / ${Math.round(systemInfo.memory.total / 1024 / 1024)}MB\n`;
      report += `- Uptime: ${Math.round(systemInfo.uptime / 60)} minutes\n\n`;

      report += `## Error Summary (Last ${hours} hours)\n`;
      report += `- Total Errors: ${stats.total}\n`;
      report += `- Recent Errors: ${stats.recentCount}\n\n`;

      report += `### By Type\n`;
      Object.entries(stats.byType).forEach(([type, count]) => {
        report += `- ${type}: ${count}\n`;
      });
      report += `\n`;

      report += `### By Severity\n`;
      Object.entries(stats.bySeverity).forEach(([severity, count]) => {
        report += `- ${severity}: ${count}\n`;
      });
      report += `\n`;

      if (stats.topErrors.length > 0) {
        report += `### Top Errors\n`;
        stats.topErrors.forEach((error, index) => {
          report += `${index + 1}. "${error.message}" (${error.count} occurrences)\n`;
        });
        report += `\n`;
      }

      report += `## Recent Error Details\n\n`;
      const recentErrors = errors.slice(0, 10);
      recentErrors.forEach((error, index) => {
        report += `### Error ${index + 1}\n`;
        report += `- **Time:** ${error.timestamp}\n`;
        report += `- **Type:** ${error.error_type}\n`;
        report += `- **Severity:** ${error.severity}\n`;
        report += `- **Message:** ${error.message}\n`;
        if (error.component) report += `- **Component:** ${error.component}\n`;
        if (error.symbol) report += `- **Symbol:** ${error.symbol}\n`;
        if (error.error_code) report += `- **Error Code:** ${error.error_code}\n`;
        if (error.user_action) report += `- **User Action:** ${error.user_action}\n`;
        if (error.stack_trace) {
          report += `\n<details>\n<summary>Stack Trace</summary>\n\n\`\`\`\n${error.stack_trace}\n\`\`\`\n</details>\n`;
        }
        report += `\n`;
      });

      return report;
    } catch (error) {
      console.error('Failed to generate bug report:', error);
      return 'Failed to generate bug report';
    }
  }

  public async cleanup(): Promise<void> {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    await this.flushBuffer();
    errorLogsDb.close();
  }
}

export const errorLogger = ErrorLogger.getInstance();