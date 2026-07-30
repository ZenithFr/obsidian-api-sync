window.tailwind = window.tailwind || {};
window.tailwind.config = {
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Roboto', 'Inter', 'Helvetica Neue', 'Arial', 'Noto Sans', 'sans-serif', 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji'],
      },
      colors: {
        primary:    '#a78bfa',
        'on-primary': '#ffffff',
        background: '#1f1f1f',
        surface:    '#262626',
        border:     '#404040',
        text:       '#eeeeee',
        muted:      '#dadada',
        accent:     '#7c3aed',
        success:    '#22c55e',
        error:      '#ef4444',
        warning:    '#f59e0b',
      },
      borderRadius: {
        sm: '2px',
        md: '6px',
        lg: '12px',
        xl: '20px',
        pill: '9999px'
      },
      boxShadow: {
        card: 'rgb(255, 255, 255) 0px 0px 0px 0px inset, rgba(255, 255, 255, 0.05) 0px 0px 0px 1px inset, rgba(0, 0, 0, 0) 0px 0px 0px 0px',
        elevated: 'rgb(255, 255, 255) 0px 0px 0px 0px inset, rgba(255, 255, 255, 0.1) 0px 0px 0px 1px inset, rgba(0, 0, 0, 0.1) 0px 1px 3px 0px, rgba(0, 0, 0, 0.1) 0px 1px 2px -1px',
      }
    }
  }
};
