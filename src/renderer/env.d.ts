import type { YamzoApi } from "../preload/preload";

declare global {
  interface Window {
    yamzo?: YamzoApi;
  }
}
