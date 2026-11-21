/**
 * Bridge injected by electron/preload.cjs when the web app runs
 * inside the Electron shell. Undefined in the plain browser build.
 */
export {};

declare global {
  interface Window {
    electronAPI?: {
      isElectron: boolean;
      /** Open the extension's link (auth_token registration) window. */
      openExtensionPopup: () => Promise<void>;
    };
  }
}
