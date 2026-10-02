/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  // WICHTIG: preflight deaktiviert. Tailwinds globaler CSS-Reset setzt sonst
  // font-family, margin, line-height etc. auf body/h1-h6/a/nav usw. zurück
  // und überschreibt dabei die Typografie deines bestehenden style.css in
  // Header/Footer/Navigation. Ohne preflight wirken Tailwind-Utility-Klassen
  // (bg-, flex, p-, text- etc.) weiterhin ganz normal INNERHALB der
  // Systembrett-Komponente – nur der globale Reset auf fremde Elemente entfällt.
  corePlugins: {
    preflight: false,
  },
  theme: {
    extend: {},
  },
  plugins: [],
};
