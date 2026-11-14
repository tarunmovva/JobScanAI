/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{tsx,ts,html}', './index.html'],
  theme: {
    extend: {
      fontFamily: {
        // One family. IBM Plex was drawn for IBM's engineering documentation --
        // industrial provenance suits a console watching irreversible work.
        // Mono is for REAL DATA only: job ids, elapsed timers. Never for
        // decorative small labels, which is the tell it usually signals.
        sans: ['IBM Plex Sans', 'Segoe UI Variable', 'system-ui', 'sans-serif'],
        mono: ['IBM Plex Mono', 'Cascadia Code', 'Consolas', 'monospace'],
        // 11 call sites still say font-display. Aliased to the sans rather
        // than rewritten: the serif is what had to go, not the markup.
        display: ['IBM Plex Sans', 'Segoe UI Variable', 'system-ui', 'sans-serif'],
      },
      colors: {
        // ── Instrument console ────────────────────────────────────────────
        // The app is written against gray/orange/purple/green class names, so
        // the ramps are remapped at the token level rather than every call
        // site being rewritten.
        //
        // What changed and why: the previous palette was a Claude reskin --
        // warm charcoal with #d97757, Anthropic's own interaction accent. On a
        // product that is not Claude that hex reads as borrowed, and it is the
        // single most-cited tell of generated design. Cool graphite moves off
        // it deliberately.
        //
        //   gray   → cool graphite, the ground everything sits on
        //   orange → SIGNAL. The only saturated colour in the app, reserved
        //            for a card that needs a human. Named 'orange' because
        //            that is what the existing classes say.
        //   purple → slate-blue, the work-in-progress channel; quiet on purpose
        //   green  → muted sage for confirmations, NOT a success fill
        gray: {
          50:  '#f4f6f8',
          100: '#e6eaf0',
          200: '#c8d0da',
          300: '#a3aebd',
          400: '#8b95a3',
          500: '#697485',
          600: '#4d5765',
          700: '#333c48',
          800: '#232a33',
          900: '#161b22',
          950: '#0f1319',
        },
        orange: {
          50:  '#fff8ec',
          100: '#ffedcc',
          200: '#ffd88f',
          300: '#ffc551',
          400: '#ffb224',
          500: '#f59e0b',
          600: '#d18007',
          700: '#a3620a',
          800: '#7c4a0d',
          900: '#653c0f',
          950: '#3b2105',
        },
        purple: {
          50:  '#f2f6fb',
          100: '#e2ebf6',
          200: '#c3d5eb',
          300: '#9bb8db',
          400: '#7397c7',
          500: '#557bb0',
          600: '#436293',
          700: '#374e76',
          800: '#2d3f5e',
          900: '#26344c',
          950: '#18202f',
        },
        green: {
          50:  '#f1f7f3',
          100: '#dcebe1',
          200: '#bad7c5',
          300: '#8fbba1',
          400: '#699b7d',
          500: '#4e7f62',
          600: '#3d654e',
          700: '#325141',
          800: '#2a4136',
          900: '#24362d',
          950: '#111d18',
        },
      },
      keyframes: {
        // Sliding fill for indeterminate progress bars (FetchScreen rebuild).
        indeterminate: {
          '0%':   { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(300%)' },
        },
        fadeUp: {
          '0%':   { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        // Breathing spark — the Claude-style "thinking" indicator.
        sparkPulse: {
          '0%':   { opacity: '0.55', transform: 'scale(0.85) rotate(0deg)' },
          '50%':  { opacity: '1',    transform: 'scale(1.1) rotate(180deg)' },
          '100%': { opacity: '0.55', transform: 'scale(0.85) rotate(360deg)' },
        },
      },
      animation: {
        indeterminate: 'indeterminate 1.4s ease-in-out infinite',
        fadeUp: 'fadeUp 300ms ease-out both',
        spark: 'sparkPulse 1.6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}
