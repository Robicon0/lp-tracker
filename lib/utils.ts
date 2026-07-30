import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * shadcn/ui's canonical class merger. Lives at the repo ROOT (`/lib`), not
 * `app/lib`, because tsconfig maps `@/*` -> `./*` and every shadcn component
 * imports `@/lib/utils` verbatim. `app/lib/*` remains the home for DefiDesh's
 * own domain logic (pricing, RPC, protocol adapters) — these two never mix.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
