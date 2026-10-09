/**
 * The dashboard reaches the CLI's local server one of two ways:
 *  - served by the CLI itself (npx llm-usage-analyzer): same origin, so no address is needed
 *  - opened somewhere else (dev server, hosted copy): the CLI's default address
 * The CLI marks the page it serves with a meta tag.
 *
 * A public website must not probe localhost on its own: Chrome asks the visitor for permission when a
 * public page contacts their computer. So a page on a public host never looks for a local server.
 */
export const servedByCli: boolean =
  typeof document !== 'undefined' && document.querySelector('meta[name="llm-usage-server"]') !== null;

export const LOCAL_SERVER_URL: string = servedByCli ? '' : 'http://localhost:3456';

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1'];

/** True when this page is itself served from this computer (the dev server, or the CLI). */
export const pageIsLocal: boolean =
  typeof location !== 'undefined' && LOOPBACK_HOSTS.includes(location.hostname);
