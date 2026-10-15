// Types for the pages' scripts that the JavaScript cannot declare itself (npm run typecheck).

interface Window {
  /** Set by boot.js, which runs before the page's modules. */
  voiceReconTheme: {
    /** 'system', 'light', 'dark' */
    modes: string[];
    get(): string;
    set(mode: string): void;
    next(): string;
  };
}
