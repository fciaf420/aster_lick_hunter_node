import { useEffect, useRef } from 'react';
import {
  showWebSocketError,
  showApiError,
  showTradingError,
  showConfigError,
  showErrorToast,
  ErrorDetails
} from '@/lib/utils/errorToast';
import websocketService from '@/lib/services/websocketService';

interface ErrorEvent {
  type: string;
  data: {
    title: string;
    message: string;
    details?: ErrorDetails;
  };
}

// Define systemic errors that should have longer deduplication windows
const SYSTEMIC_ERROR_PATTERNS = [
  'insufficient balance',
  'rate limit',
  'websocket',
  'connection',
];

// Per-error-type rate limiting configuration
const ERROR_RATE_LIMITS = {
  'insufficient-balance': 60000, // 1 minute for balance errors
  'rate-limit': 30000, // 30 seconds for rate limit errors
  'websocket': 30000, // 30 seconds for websocket errors
  'default': 2000, // 2 seconds for other errors
};

function getErrorCategory(title: string): string {
  const lowerTitle = title.toLowerCase();

  if (lowerTitle.includes('insufficient balance')) return 'insufficient-balance';
  if (lowerTitle.includes('rate limit')) return 'rate-limit';
  if (lowerTitle.includes('websocket') || lowerTitle.includes('connection')) return 'websocket';

  return 'default';
}

function isSystemicError(title: string): boolean {
  const lowerTitle = title.toLowerCase();
  return SYSTEMIC_ERROR_PATTERNS.some(pattern => lowerTitle.includes(pattern));
}

export function useErrorToasts() {
  // Use a ref to track processed messages and prevent duplicates
  const processedErrors = useRef<Map<string, number>>(new Map());
  const cleanupTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    // Store ref value to avoid stale closure in cleanup
    const errorsMap = processedErrors.current;

    // Clean up old processed errors periodically
    const startCleanupTimer = () => {
      cleanupTimerRef.current = setInterval(() => {
        const now = Date.now();
        const expiredKeys: string[] = [];
        errorsMap.forEach((timestamp, key) => {
          // Remove errors older than 60 seconds
          if (now - timestamp > 60000) {
            expiredKeys.push(key);
          }
        });
        expiredKeys.forEach(key => errorsMap.delete(key));
      }, 15000); // Clean up every 15 seconds
    };

    startCleanupTimer();

    // Add WebSocket message handler
    const cleanup = websocketService.addMessageHandler((message: ErrorEvent) => {
      try {
        // Only process error messages
        if (!message.type || !message.type.endsWith('_error')) {
          return;
        }

        const { title, message: errorMessage, details } = message.data || {};

        // Determine error category and rate limit
        const errorCategory = getErrorCategory(title);
        const rateLimit = ERROR_RATE_LIMITS[errorCategory as keyof typeof ERROR_RATE_LIMITS] || ERROR_RATE_LIMITS.default;

        // Create a unique key for deduplication based on category
        const errorKey = `${errorCategory}-${message.type}`;

        // Check if we've recently processed this error category
        if (processedErrors.current.has(errorKey)) {
          const lastProcessed = processedErrors.current.get(errorKey) || 0;
          if (Date.now() - lastProcessed < rateLimit) {
            // Skip toast but still allow persistent banner to update
            return;
          }
        }

        // Mark as processed
        processedErrors.current.set(errorKey, Date.now());

        // Skip showing toast for systemic errors (they'll be shown in the banner)
        if (isSystemicError(title)) {
          // Systemic errors are handled by PersistentErrorBanner
          return;
        }

        // Handle error events based on type (only non-systemic errors)
        switch (message.type) {
          case 'websocket_error':
            showWebSocketError(title, errorMessage, details);
            break;
          case 'api_error':
            showApiError(title, errorMessage, details);
            break;
          case 'trading_error':
            showTradingError(title, errorMessage, details);
            break;
          case 'config_error':
            showConfigError(title, errorMessage, details);
            break;
          case 'general_error':
            showErrorToast({
              type: 'general',
              title,
              message: errorMessage,
              details,
            });
            break;
        }
      } catch (error) {
        console.error('Failed to process error notification:', error);
      }
    });

    return () => {
      // Clean up message handler
      cleanup();

      // Clear cleanup timer
      if (cleanupTimerRef.current) {
        clearInterval(cleanupTimerRef.current);
        cleanupTimerRef.current = null;
      }

      // Clear processed errors using the stored reference
      errorsMap.clear();
    };
  }, []); // No dependencies needed since websocketService is a singleton
}