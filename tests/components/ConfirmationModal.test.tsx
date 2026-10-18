import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ConfirmationModal } from '@/components/ui/ConfirmationModal';

describe('ConfirmationModal', () => {
  const defaultProps = {
    isOpen: true,
    onClose: jest.fn(),
    onConfirm: jest.fn(),
    title: 'Test Modal',
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Rendering', () => {
    it('should render when isOpen is true', () => {
      render(<ConfirmationModal {...defaultProps} />);

      expect(screen.getByText('Test Modal')).toBeInTheDocument();
      expect(screen.getByText('Cancel')).toBeInTheDocument();
      expect(screen.getByText('Confirm')).toBeInTheDocument();
    });

    it('should not render when isOpen is false', () => {
      render(<ConfirmationModal {...defaultProps} isOpen={false} />);

      expect(screen.queryByText('Test Modal')).not.toBeInTheDocument();
    });

    it('should render with custom description', () => {
      render(
        <ConfirmationModal
          {...defaultProps}
          description="This is a test description"
        />
      );

      expect(screen.getByText('This is a test description')).toBeInTheDocument();
    });

    it('should render with custom button text', () => {
      render(
        <ConfirmationModal
          {...defaultProps}
          confirmText="Delete"
          cancelText="Keep"
        />
      );

      expect(screen.getByText('Delete')).toBeInTheDocument();
      expect(screen.getByText('Keep')).toBeInTheDocument();
    });

    it('should render children content', () => {
      render(
        <ConfirmationModal {...defaultProps}>
          <div>Custom content here</div>
        </ConfirmationModal>
      );

      expect(screen.getByText('Custom content here')).toBeInTheDocument();
    });
  });

  describe('Variants', () => {
    // The dialog renders in a portal on document.body, so query baseElement rather than container.
    // lucide-react renders AlertTriangle with its current name, TriangleAlert.
    it('should render default variant with info icon', () => {
      const { baseElement } = render(
        <ConfirmationModal {...defaultProps} variant="default" />
      );

      const icon = baseElement.querySelector('.lucide-info');
      expect(icon).toBeInTheDocument();
    });

    it('should render destructive variant with warning icon', () => {
      const { baseElement } = render(
        <ConfirmationModal {...defaultProps} variant="destructive" />
      );

      const icon = baseElement.querySelector('.lucide-triangle-alert');
      expect(icon).toBeInTheDocument();
    });

    it('should render warning variant with warning icon', () => {
      const { baseElement } = render(
        <ConfirmationModal {...defaultProps} variant="warning" />
      );

      const icon = baseElement.querySelector('.lucide-triangle-alert');
      expect(icon).toBeInTheDocument();
    });

    it('should not show icon when showIcon is false', () => {
      const { baseElement } = render(
        <ConfirmationModal {...defaultProps} showIcon={false} />
      );

      const infoIcon = baseElement.querySelector('.lucide-info');
      const warningIcon = baseElement.querySelector('.lucide-triangle-alert');
      expect(infoIcon).not.toBeInTheDocument();
      expect(warningIcon).not.toBeInTheDocument();
    });
  });

  describe('User Interactions', () => {
    it('should call onConfirm when confirm button is clicked', async () => {
      render(<ConfirmationModal {...defaultProps} />);

      const confirmButton = screen.getByText('Confirm');
      fireEvent.click(confirmButton);

      await waitFor(() => {
        expect(defaultProps.onConfirm).toHaveBeenCalledTimes(1);
      });
    });

    it('should call onClose when cancel button is clicked', () => {
      render(<ConfirmationModal {...defaultProps} />);

      const cancelButton = screen.getByText('Cancel');
      fireEvent.click(cancelButton);

      expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
    });

    it('should handle async onConfirm function', async () => {
      const asyncConfirm = jest.fn().mockResolvedValue(undefined);

      render(
        <ConfirmationModal {...defaultProps} onConfirm={asyncConfirm} />
      );

      const confirmButton = screen.getByText('Confirm');
      fireEvent.click(confirmButton);

      await waitFor(() => {
        expect(asyncConfirm).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('Loading State', () => {
    it('should show loading text when isLoading is true', () => {
      render(
        <ConfirmationModal
          {...defaultProps}
          isLoading={true}
          loadingText="Processing..."
        />
      );

      expect(screen.getByText('Processing...')).toBeInTheDocument();
      expect(screen.queryByText('Confirm')).not.toBeInTheDocument();
    });

    it('should disable buttons when isLoading is true', () => {
      render(
        <ConfirmationModal {...defaultProps} isLoading={true} />
      );

      const cancelButton = screen.getByText('Cancel');
      const confirmButton = screen.getByText('Processing...');

      expect(cancelButton).toBeDisabled();
      expect(confirmButton).toBeDisabled();
    });

    it('should use default loading text if not provided', () => {
      render(
        <ConfirmationModal {...defaultProps} isLoading={true} />
      );

      expect(screen.getByText('Processing...')).toBeInTheDocument();
    });
  });

  describe('Button Variants', () => {
    it('should use destructive button for destructive variant', () => {
      render(
        <ConfirmationModal {...defaultProps} variant="destructive" />
      );

      // Button variants are applied as Tailwind classes from buttonVariants
      const confirmButton = screen.getByText('Confirm');
      expect(confirmButton).toHaveClass('bg-destructive');
    });

    it('should use default button for warning variant', () => {
      render(
        <ConfirmationModal {...defaultProps} variant="warning" />
      );

      const confirmButton = screen.getByText('Confirm');
      expect(confirmButton).toHaveClass('bg-primary');
    });

    it('should use default button for default variant', () => {
      render(
        <ConfirmationModal {...defaultProps} variant="default" />
      );

      const confirmButton = screen.getByText('Confirm');
      expect(confirmButton).toHaveClass('bg-primary');
    });
  });

  describe('Complex Scenarios', () => {
    it('should handle all props together', () => {
      render(
        <ConfirmationModal
          isOpen={true}
          onClose={defaultProps.onClose}
          onConfirm={defaultProps.onConfirm}
          title="Delete Item"
          description="Are you sure you want to delete this item?"
          confirmText="Delete"
          cancelText="Keep"
          variant="destructive"
          isLoading={false}
          showIcon={true}
        >
          <div>
            <p>Item: Test Item</p>
            <p>Created: 2024-01-01</p>
          </div>
        </ConfirmationModal>
      );

      expect(screen.getByText('Delete Item')).toBeInTheDocument();
      expect(screen.getByText('Are you sure you want to delete this item?')).toBeInTheDocument();
      expect(screen.getByText('Delete')).toBeInTheDocument();
      expect(screen.getByText('Keep')).toBeInTheDocument();
      expect(screen.getByText('Item: Test Item')).toBeInTheDocument();
      expect(screen.getByText('Created: 2024-01-01')).toBeInTheDocument();
    });

    it('should prevent action when modal is closed during loading', async () => {
      const onConfirm = jest.fn(() => new Promise(resolve => setTimeout(resolve, 100)));
      const onClose = jest.fn();

      const { rerender } = render(
        <ConfirmationModal
          {...defaultProps}
          onConfirm={onConfirm}
          onClose={onClose}
          isLoading={false}
        />
      );

      const confirmButton = screen.getByText('Confirm');
      fireEvent.click(confirmButton);

      // Simulate closing the modal while loading
      rerender(
        <ConfirmationModal
          {...defaultProps}
          onConfirm={onConfirm}
          onClose={onClose}
          isLoading={true}
        />
      );

      const cancelButton = screen.getByText('Cancel');
      expect(cancelButton).toBeDisabled();
    });
  });
});