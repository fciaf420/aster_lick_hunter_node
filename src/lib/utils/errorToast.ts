import { toast } from 'sonner';
import { Copy, Check, AlertTriangle, WifiOff, ServerCrash, XCircle } from 'lucide-react';
import { createElement, useState } from 'react';

export type ErrorType = 'websocket' | 'api' | 'trading' | 'config' | 'general';

export interface ErrorDetails {
  errorCode?: string;
  component?: string;
  symbol?: string;
  timestamp?: string;
  stackTrace?: string;
  rawError?: any;
}

export interface ErrorToastOptions {
  type: ErrorType;
  title: string;
  message: string;
  details?: ErrorDetails;
  duration?: number;
}

// Helper to format error details for clipboard
const formatErrorForClipboard = (options: ErrorToastOptions): string => {
  const lines = [
    `Error: ${options.title}`,
    `Message: ${options.message}`,
    `Type: ${options.type}`,
    `Timestamp: ${options.details?.timestamp || new Date().toISOString()}`,
  ];

  if (options.details) {
    if (options.details.component) lines.push(`Component: ${options.details.component}`);
    if (options.details.symbol) lines.push(`Symbol: ${options.details.symbol}`);
    if (options.details.errorCode) lines.push(`Error Code: ${options.details.errorCode}`);
    if (options.details.stackTrace) lines.push(`\nStack Trace:\n${options.details.stackTrace}`);
    if (options.details.rawError) {
      lines.push(`\nRaw Error:\n${JSON.stringify(options.details.rawError, null, 2)}`);
    }
  }

  return lines.join('\n');
};

// Get icon for error type
const getErrorIcon = (type: ErrorType) => {
  switch (type) {
    case 'websocket':
      return WifiOff;
    case 'api':
      return ServerCrash;
    case 'trading':
      return XCircle;
    case 'config':
      return AlertTriangle;
    default:
      return AlertTriangle;
  }
};

// Get style for error type
const getErrorStyle = (type: ErrorType) => {
  switch (type) {
    case 'websocket':
      return {
        background: 'rgb(251 113 133)', // red-400
        color: 'white',
        border: '1px solid rgb(254 202 202)', // red-200
      };
    case 'api':
      return {
        background: 'rgb(248 113 113)', // red-400
        color: 'white',
        border: '1px solid rgb(252 165 165)', // red-300
      };
    case 'trading':
      return {
        background: 'rgb(239 68 68)', // red-500
        color: 'white',
        border: '1px solid rgb(248 113 113)', // red-400
      };
    case 'config':
      return {
        background: 'rgb(251 146 60)', // orange-400
        color: 'white',
        border: '1px solid rgb(254 215 170)', // orange-200
      };
    default:
      return {
        background: 'rgb(239 68 68)', // red-500
        color: 'white',
        border: '1px solid rgb(248 113 113)', // red-400
      };
  }
};

// Component for clipboard button
function ClipboardButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy to clipboard:', err);
    }
  };

  return createElement(
    'button',
    {
      onClick: handleCopy,
      className: 'ml-2 p-1 hover:bg-white/20 rounded transition-colors',
      title: copied ? 'Copied!' : 'Copy error details',
    },
    createElement(copied ? Check : Copy, {
      className: 'h-4 w-4',
    })
  );
}

// Determine auto-dismiss duration based on error type
const getErrorDuration = (type: ErrorType, title: string): number => {
  const lowerTitle = title.toLowerCase();

  // Shorter duration for validation and balance errors
  if (
    lowerTitle.includes('insufficient balance') ||
    lowerTitle.includes('precision') ||
    lowerTitle.includes('notional') ||
    lowerTitle.includes('validation')
  ) {
    return 5000; // 5 seconds
  }

  // Medium duration for API and config errors
  if (type === 'api' || type === 'config') {
    return 8000; // 8 seconds
  }

  // Default duration for other errors
  return 12000; // 12 seconds
};

// Main error toast function
export const showErrorToast = (options: ErrorToastOptions) => {
  const {
    type = 'general',
    title,
    message,
    details,
    duration,
  } = options;

  // Use provided duration or calculate based on error type
  const finalDuration = duration ?? getErrorDuration(type, title);

  const errorText = formatErrorForClipboard(options);
  const Icon = getErrorIcon(type);
  const style = getErrorStyle(type);

  toast.error(
    createElement(
      'div',
      { className: 'flex items-start w-full' },
      [
        createElement(Icon, {
          key: 'icon',
          className: 'h-5 w-5 mr-3 mt-0.5 flex-shrink-0',
        }),
        createElement(
          'div',
          { key: 'content', className: 'flex-1 min-w-0' },
          [
            createElement(
              'div',
              { key: 'title', className: 'font-semibold' },
              title
            ),
            createElement(
              'div',
              { key: 'message', className: 'text-sm mt-1 opacity-90' },
              message
            ),
            details?.errorCode && createElement(
              'div',
              { key: 'code', className: 'text-xs mt-1 opacity-75 font-mono' },
              `Code: ${details.errorCode}`
            ),
          ]
        ),
        createElement(ClipboardButton, {
          key: 'clipboard',
          text: errorText,
        }),
      ]
    ),
    {
      duration: finalDuration,
      style,
      className: 'error-toast',
    }
  );
};

// Convenience functions for specific error types
export const showWebSocketError = (title: string, message: string, details?: ErrorDetails) => {
  showErrorToast({
    type: 'websocket',
    title,
    message,
    details,
  });
};

export const showApiError = (title: string, message: string, details?: ErrorDetails) => {
  showErrorToast({
    type: 'api',
    title,
    message,
    details,
  });
};

export const showTradingError = (title: string, message: string, details?: ErrorDetails) => {
  showErrorToast({
    type: 'trading',
    title,
    message,
    details,
  });
};

export const showConfigError = (title: string, message: string, details?: ErrorDetails) => {
  showErrorToast({
    type: 'config',
    title,
    message,
    details,
  });
};