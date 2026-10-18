import React from 'react';
import { render, type RenderOptions } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';

/**
 * Renders a component inside the providers the real app supplies from
 * `src/app/layout.tsx`. shadcn's `Tooltip` no longer creates its own
 * `TooltipProvider`, so any component using it must be rendered through this
 * helper in tests.
 */
export function renderWithProviders(
  ui: React.ReactElement,
  options?: Omit<RenderOptions, 'wrapper'>
) {
  return render(ui, {
    wrapper: ({ children }) => <TooltipProvider>{children}</TooltipProvider>,
    ...options,
  });
}
