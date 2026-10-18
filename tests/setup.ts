// Jest setup file for all tests
import '@testing-library/jest-dom';

// jsdom doesn't implement these, but Radix UI (Select) calls them
if (typeof Element !== 'undefined') {
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || function scrollIntoView() {};
  Element.prototype.hasPointerCapture = Element.prototype.hasPointerCapture || function hasPointerCapture() { return false; };
  Element.prototype.releasePointerCapture = Element.prototype.releasePointerCapture || function releasePointerCapture() {};
}

// Mock console methods to reduce noise in tests
global.console = {
  ...console,
  error: jest.fn(),
  warn: jest.fn(),
  log: jest.fn(),
  debug: jest.fn(),
};

// Reset mocks before each test
beforeEach(() => {
  jest.clearAllMocks();
});