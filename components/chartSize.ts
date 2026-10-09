/**
 * A chart is first drawn before its box has been measured. Without a starting size, Recharts logs
 * "The width(-1) and height(-1) of chart should be greater than 0" to the console on every screen with a chart.
 * This size is only used for that first moment. The measured size replaces it right away.
 */
export const CHART_START_SIZE = { width: 320, height: 200 };
