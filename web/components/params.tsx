"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, type ComponentType } from "react";
import { Loading } from "@/components/ui";

/**
 * The app is a static export, so detail pages read their id from the query string
 * (/series?id=12). useSearchParams needs a Suspense boundary in that mode.
 */
export function withParams<P extends object>(Inner: ComponentType<P>) {
  return function WithParams(props: P) {
    return <Suspense fallback={<Loading />}><Inner {...props} /></Suspense>;
  };
}

export function useNumberParam(name: string): number | null {
  const v = useSearchParams().get(name);
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

export function useStringParam(name: string): string | null {
  return useSearchParams().get(name);
}

/** Updates query params without a full navigation (filters, tabs). */
export function useSetParams() {
  const router = useRouter();
  const params = useSearchParams();
  return useCallback((updates: Record<string, string | number | null | undefined>) => {
    const sp = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(updates)) {
      if (v === null || v === undefined || v === "") sp.delete(k);
      else sp.set(k, String(v));
    }
    router.replace(`?${sp.toString()}`, { scroll: false });
  }, [params, router]);
}
