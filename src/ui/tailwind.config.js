/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  // Dark mode is controlled via [data-theme="dark"] on <html>
  // We don't use Tailwind's built-in dark mode — we manage it via CSS custom properties.
  theme: {
    extend: {
      colors: {
        // All colors reference CSS custom properties defined in styles/index.css.
        // This enables instant theme switching without class-name changes in every component.
        background: "var(--color-background)",
        "background-hover": "var(--color-background-hover)",
        surface: "var(--color-surface)",
        "surface-hover": "var(--color-surface-hover)",
        "text-primary": "var(--color-text-primary)",
        "text-secondary": "var(--color-text-secondary)",
        "text-tertiary": "var(--color-text-tertiary)",
        agent: "var(--color-agent)",
        "agent-light": "var(--color-agent-light)",
        human: "var(--color-human)",
        "human-light": "var(--color-human-light)",
        attention: "var(--color-attention)",
        "attention-light": "var(--color-attention-light)",
        success: "var(--color-success)",
        danger: "var(--color-danger)",
        "border-soft": "var(--color-border-soft)",
        overlay: "var(--color-overlay)",
      },
      fontFamily: {
        sans: ["Inter", "Manrope", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "monospace"],
      },
      animation: {
        "pulse-slow": "pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite",
      },
    },
  },
  plugins: [],
};
