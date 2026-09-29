/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // UROS_Color_System.md — Layer 1: System / Product UI
        background: "#FAF9F5",
        surface: "#FFFFFF",
        "text-primary": "#1F1E1D",
        "text-secondary": "#6B6560",
        agent: "#0F766E", // Deep teal — machine/agent work
        human: "#E2725B", // Light terracotta — human decision/action
        attention: "#D97706", // Amber — needs review / attention
        success: "#15803D",
        danger: "#B91C1C",
        "border-soft": "#E7E5E4",
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
