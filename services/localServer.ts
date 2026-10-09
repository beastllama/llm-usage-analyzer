/**
 * The dashboard reaches the CLI's local server one of two ways:
 *  - served by the CLI itself (npx llm-usage-analyzer): same origin, so no address is needed
 *  - opened somewhere else (dev server, hosted copy): the CLI's default address
 * The CLI marks the page it serves with a meta tag.
 */
export const servedByCli: boolean =
  typeof document !== 'undefined' && document.querySelector('meta[name="llm-usage-server"]') !== null;

export const LOCAL_SERVER_URL: string = servedByCli ? '' : 'http://localhost:3456';
