/// <reference types="vite/client" />
import type { LithiumApi } from "../shared/types";

declare global {
  interface Window {
    lithium: LithiumApi;
  }
}

export {};
