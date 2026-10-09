/** @type {import('tailwindcss').Config} */
export default {
  // Every file that contains class names. Classes are generated at build time, not in the browser.
  content: ['./index.html', './*.{ts,tsx}', './components/**/*.{ts,tsx}', './services/**/*.{ts,tsx}'],
  theme: { extend: {} },
  plugins: [],
};
