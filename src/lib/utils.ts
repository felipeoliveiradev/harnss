import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Synchronous platform checks — available immediately on first render,
// unlike the preload CSS class which is applied after an async IPC call.
export const isMac = /Mac/.test(navigator.platform);
export const isWindows = /Win/.test(navigator.platform);
