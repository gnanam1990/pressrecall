import { policyDenied } from "../domain/errors.js";

/**
 * Constrained destination fetcher.
 *
 * Resolves what a managed redirect URL actually serves by performing a real
 * HTTP request — but only inside a tightly scoped site policy: http/https
 * schemes only, and the URL's hostname must appear verbatim in
 * `allowedHosts`. There is no arbitrary URL crawling: one request, redirect
 * followed manually (the Location header is the observation), short timeout.
 */
export interface RedirectPolicy {
  allowedHosts: string[];
}

export interface Resolution {
  managedUrl: string;
  status: number;
  location: string | null;
  fetchedAt: string;
}

export type Resolver = (managedUrl: string) => Promise<Resolution>;

export function createResolver(policy: RedirectPolicy): Resolver {
  return async (managedUrl: string): Promise<Resolution> => {
    const u = new URL(managedUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      throw policyDenied(`redirect scheme '${u.protocol}' is not allowed`);
    }
    if (!policy.allowedHosts.includes(u.hostname)) {
      throw policyDenied(
        `redirect host '${u.hostname}' is not in the allowlist`
      );
    }
    const res = await fetch(managedUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(3000),
    });
    return {
      managedUrl,
      status: res.status,
      location: res.headers.get("location"),
      fetchedAt: new Date().toISOString(),
    };
  };
}
