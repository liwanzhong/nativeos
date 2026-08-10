/**
 * NativeOS Theme Configuration
 * Based on high-fidelity design mockup
 */

export const colors = {
  // Base colors
  background: '#F9FAFB',      // gray-50
  surface: '#FFFFFF',         // white
  surfaceSecondary: '#F3F4F6', // gray-100
  
  // Text colors
  text: {
    primary: '#111827',       // gray-900
    secondary: '#6B7280',     // gray-500
    tertiary: '#9CA3AF',      // gray-400
    inverse: '#FFFFFF',       // white
  },
  
  // Border colors
  border: {
    light: '#F3F4F6',         // gray-100
    default: '#E5E7EB',       // gray-200
    dark: '#D1D5DB',          // gray-300
  },
  
  // Brand colors
  primary: '#2563EB',         // blue-600
  primaryLight: '#DBEAFE',    // blue-50
  primaryBorder: '#BFDBFE',   // blue-200
  
  // Status colors
  success: '#10B981',         // green-500
  successLight: '#D1FAE5',    // green-50
  successBorder: '#A7F3D0',   // green-200
  
  error: '#EF4444',           // red-500
  errorLight: '#FEE2E2',      // red-50
  errorBorder: '#FECACA',     // red-200
  
  warning: '#F59E0B',         // amber-500
  warningLight: '#FEF3C7',    // amber-50
  warningBorder: '#FDE68A',   // amber-200
  
  // Accent colors
  purple: '#8B5CF6',          // purple-500
  purpleLight: '#F3E8FF',     // purple-50
  purpleBorder: '#E9D5FF',    // purple-200
  
  rose: '#F43F5E',            // rose-500
  roseLight: '#FFE4E6',       // rose-50
  roseBorder: '#FECDD3',      // rose-200
  
  // Shadows
  shadow: {
    sm: 'rgba(0, 0, 0, 0.04)',
    md: 'rgba(0, 0, 0, 0.08)',
    lg: 'rgba(0, 0, 0, 0.15)',
  },
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
};

export const borderRadius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  full: 9999,
};

export const fontSize = {
  xs: 12,
  sm: 14,
  base: 16,
  lg: 18,
  xl: 20,
  xxl: 24,
  xxxl: 32,
};

export const fontWeight = {
  normal: '400' as const,
  medium: '500' as const,
  semibold: '600' as const,
  bold: '700' as const,
};
