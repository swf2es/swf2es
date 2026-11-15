// What http-cache.ts uses of http-cache-semantics, which describes itself
// in JSDoc alone, which TypeScript does not read from a package.
declare module "http-cache-semantics" {
  interface HttpRequest {
    headers: Record<string, string>;
    method?: string;
    url?: string;
  }

  interface HttpResponse {
    headers: Record<string, string>;
    status?: number;
  }

  interface Revalidation {
    headers: Record<string, string>;
    synchronous: boolean;
  }

  class CachePolicy {
    constructor(
      request: HttpRequest,
      response: HttpResponse,
      options?: {
        shared?: boolean;
        cacheHeuristic?: number;
        immutableMinTimeToLive?: number;
        ignoreCargoCult?: boolean;
      },
    );
    static fromObject(object: unknown): CachePolicy;
    now(): number;
    storable(): boolean;
    evaluateRequest(request: HttpRequest): {
      response: HttpResponse | undefined;
      revalidation: Revalidation | undefined;
    };
    revalidationHeaders(request: HttpRequest): Record<string, string>;
    revalidatedPolicy(
      request: HttpRequest,
      response: HttpResponse,
    ): { policy: CachePolicy; modified: boolean; matches: boolean };
    timeToLive(): number;
    toObject(): object;
  }

  export default CachePolicy;
}
